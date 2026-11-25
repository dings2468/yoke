/**
 * tests/commands/cli-sync.test.ts: `runCli` with `yoke sync`, fake adapters, a scripted exec, and captured output.
 * Sandboxes come from setupAdapterSandbox. Stdin is never a TTY, so the real drift prompt is never shown. Nothing here
 * runs a real binary or touches the real home directory.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorPlanner } from "../../src/commands/doctor.js";
import { EXIT_DRIFT, EXIT_OK, EXIT_USAGE } from "../../src/commands/exit.js";
import { createNodeFs } from "../../src/core/fs-safe.js";
import type { Exec, ExecResult } from "../../src/core/git.js";
import { type CliDeps, type CliIo, runCli } from "../../src/main.js";
import { cleanupSandbox, type Sandbox, setupAdapterSandbox } from "../adapters/helpers.js";
import {
  fakeAdapterFactory,
  fakePaths,
  snapshotTree,
  writeScopeFiles,
} from "../core/plan-helpers.js";

const USER_CONFIG = [
  "version: 1",
  "harnesses: [alpha]",
  "mcps:",
  "  u1:",
  "    transport: stdio",
  "    command: user-tool",
  "",
].join("\n");

const PROJECT_CONFIG = [
  "version: 1",
  "mcps:",
  "  p1:",
  "    transport: http",
  "    url: https://example.com/p1",
  "",
].join("\n");

const LOCAL_CONFIG = [
  "version: 1",
  "mcps:",
  "  l1:",
  "    transport: sse",
  "    url: https://example.com/l1",
  "",
].join("\n");

const sandboxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sb) => cleanupSandbox(sb)));
});

async function seededSandbox(): Promise<Sandbox> {
  const sb = await setupAdapterSandbox();
  sandboxes.push(sb);
  await writeScopeFiles(sb, { user: USER_CONFIG, project: PROJECT_CONFIG, local: LOCAL_CONFIG });
  return sb;
}

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function capture(stdinIsTTY = false): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      stdoutIsTTY: false,
      stdinIsTTY,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** `rev-parse --show-toplevel` answers with the repo root; every other command succeeds silently. */
function repoExec(repo: string): Exec {
  return (_file, args): Promise<ExecResult> =>
    Promise.resolve(
      args.includes("--show-toplevel")
        ? { stdout: `${repo}\n`, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 },
    );
}

const EMPTY_PLANNER: DoctorPlanner = async () => ({ plans: [], drift: undefined });

function makeDeps(sb: Sandbox, captured: Captured): CliDeps {
  return {
    io: captured.io,
    cwd: sb.repo,
    homeDir: sb.home,
    env: { XDG_CONFIG_HOME: join(sb.root, "xdg") },
    fs: createNodeFs(),
    exec: repoExec(sb.repo),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    factories: [fakeAdapterFactory()],
    planner: EMPTY_PLANNER,
  };
}

/** Syncs once, then hand-edits the native project file so the next run sees drift. */
async function driftedSandbox(): Promise<Sandbox> {
  const sb = await seededSandbox();
  const first = capture();
  expect(await runCli(["node", "yoke", "sync"], makeDeps(sb, first))).toBe(EXIT_OK);
  await writeFile(
    fakePaths(sb.home, sb.repo).project,
    `${JSON.stringify({ servers: { p1: { transport: "http", url: "https://example.com/hand-edited" } } }, null, 2)}\n`,
    "utf8",
  );
  return sb;
}

describe("yoke sync exit codes", () => {
  it("returns 2 for --global together with --all", async () => {
    const sb = await seededSandbox();
    const captured = capture();
    const code = await runCli(
      ["node", "yoke", "sync", "--global", "--all"],
      makeDeps(sb, captured),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(captured.out()).toBe("");
  });

  it("returns 2 for an unknown option", async () => {
    const sb = await seededSandbox();
    const captured = capture();
    const code = await runCli(["node", "yoke", "sync", "--bogus"], makeDeps(sb, captured));
    expect(code).toBe(EXIT_USAGE);
    expect(captured.err()).toContain("unknown option '--bogus'");
    expect(captured.out()).toBe("");
  });

  it("returns 0 for a dry run and writes nothing", async () => {
    const sb = await seededSandbox();
    const before = await snapshotTree(sb.root);
    const captured = capture();
    const code = await runCli(["node", "yoke", "sync", "--dry-run"], makeDeps(sb, captured));
    expect(code).toBe(EXIT_OK);
    expect(captured.out()).toContain("--dry-run");
    expect(await snapshotTree(sb.root)).toEqual(before);
  });

  it("returns 3 for drift without a TTY and writes nothing", async () => {
    const sb = await driftedSandbox();
    const before = await snapshotTree(sb.root);
    const captured = capture(false);
    const code = await runCli(["node", "yoke", "sync"], makeDeps(sb, captured));
    expect(code).toBe(EXIT_DRIFT);
    expect(captured.err()).toContain("refused: native changes since the last sync");
    expect(await snapshotTree(sb.root)).toEqual(before);
  });

  it("returns 0 for --force past drift", async () => {
    const sb = await driftedSandbox();
    const captured = capture();
    const code = await runCli(["node", "yoke", "sync", "--force"], makeDeps(sb, captured));
    expect(code).toBe(EXIT_OK);
    expect(captured.out()).toContain("warning: --force: proceeding past:");
  });
});

describe("yoke sync help", () => {
  it("returns 0 and lists all four flags", async () => {
    const sb = await seededSandbox();
    const captured = capture();
    const code = await runCli(["node", "yoke", "sync", "--help"], makeDeps(sb, captured));
    expect(code).toBe(EXIT_OK);
    const help = captured.out();
    expect(help).toContain("--dry-run");
    expect(help).toContain("--global");
    expect(help).toContain("--all");
    expect(help).toContain("--force");
  });
});
