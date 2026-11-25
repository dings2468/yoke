/**
 * tests/commands/cli-doctor.test.ts: `runCli` with `yoke doctor`, fake adapters, a scripted exec, and captured output.
 * Nothing here runs a real binary or touches the real home directory.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterContext, FileChangePlan, HarnessAdapter } from "../../src/adapters/base.js";
import type { AdapterFactory } from "../../src/adapters/registry.js";
import type { DoctorPlanner } from "../../src/commands/doctor.js";
import { EXIT_OK, EXIT_PROBLEMS, EXIT_USAGE } from "../../src/commands/exit.js";
import { createNodeFs } from "../../src/core/fs-safe.js";
import type { Exec, ExecResult } from "../../src/core/git.js";
import { type CliDeps, type CliIo, runCli } from "../../src/main.js";

let root: string;
let repo: string;
let homeDir: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "yoke-cli-doctor-")));
  repo = join(root, "repo");
  homeDir = join(root, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(homeDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function capture(stdoutIsTTY: boolean | undefined = false): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      stdoutIsTTY,
      stdinIsTTY: false,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** Git reports `gitRoot` (or "outside"); every other binary reports a version and succeeds. */
function scriptedExec(gitRoot: string | "outside"): Exec {
  return (file: string): Promise<ExecResult> => {
    if (file === "git") {
      if (gitRoot === "outside") {
        return Promise.resolve({
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
          exitCode: 128,
        });
      }
      return Promise.resolve({ stdout: `${gitRoot}\n`, stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: `${file} 1.2.3\n`, stderr: "", exitCode: 0 });
  };
}

/** Fake adapter with no native state and no planned changes. Its detect() runs through the injected exec. */
function fakeFactory(name: string): AdapterFactory {
  return (ctx: AdapterContext): HarnessAdapter => ({
    name,
    capabilities: {
      staticMcp: true,
      staticInstructions: true,
      reverseRead: false,
      sessionExport: false,
      sessionImport: "handoff-file-only",
    },
    detect: async () => {
      await ctx.exec(name, ["--version"], { cwd: ctx.homeDir });
      return { installed: true, authenticated: false, version: "1.2.3" };
    },
    readNativeState: async () => ({}),
    syncStatic: async (): Promise<FileChangePlan[]> => [],
  });
}

const EMPTY_PLANNER: DoctorPlanner = async () => ({ plans: [], drift: undefined });

function makeDeps(over: Partial<CliDeps> & { readonly captured: Captured }): CliDeps {
  const { captured, ...rest } = over;
  return {
    io: captured.io,
    cwd: repo,
    homeDir,
    env: {},
    fs: createNodeFs(),
    exec: scriptedExec(repo),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    factories: [fakeFactory("alpha")],
    planner: EMPTY_PLANNER,
    ...rest,
  };
}

async function writeYoke(harnesses: readonly string[]): Promise<void> {
  const list = harnesses.map((name) => `  - ${name}`).join("\n");
  await writeFile(join(repo, "yoke.yaml"), `version: 1\nharnesses:\n${list}\n`, "utf8");
}

describe("yoke doctor exit codes", () => {
  it("returns 0 for a clean check outside a repository", async () => {
    const captured = capture();
    const code = await runCli(
      ["node", "yoke", "doctor"],
      makeDeps({ captured, exec: scriptedExec("outside"), factories: [] }),
    );
    expect(code).toBe(EXIT_OK);
    expect(captured.out()).toContain("doctor: no problems found");
    expect(captured.out()).not.toContain("\x1b");
  });

  it("returns 1 when a listed harness has no registered adapter", async () => {
    await writeYoke(["alpha"]);
    const captured = capture();
    const code = await runCli(["node", "yoke", "doctor"], makeDeps({ captured, factories: [] }));
    expect(code).toBe(EXIT_PROBLEMS);
    expect(captured.out()).toContain("PROBLEM");
    expect(captured.out()).toContain("listed in harnesses but no adapter is registered");
    expect(captured.out()).toMatch(/doctor: 1 problem\b/);
  });

  it("returns 0 when the listed harness is installed and the config loads", async () => {
    await writeYoke(["alpha"]);
    const captured = capture();
    const code = await runCli(["node", "yoke", "doctor"], makeDeps({ captured }));
    expect(code).toBe(EXIT_OK);
    expect(captured.out()).toContain("installed (version 1.2.3)");
  });
});

describe("yoke doctor output", () => {
  it("prints colour only on a TTY when NO_COLOR is unset", async () => {
    const colored = capture(true);
    await runCli(
      ["node", "yoke", "doctor"],
      makeDeps({ captured: colored, exec: scriptedExec("outside"), factories: [], env: {} }),
    );
    expect(colored.out()).toContain("\x1b");

    const plain = capture(true);
    await runCli(
      ["node", "yoke", "doctor"],
      makeDeps({
        captured: plain,
        exec: scriptedExec("outside"),
        factories: [],
        env: { NO_COLOR: "1" },
      }),
    );
    expect(plain.out()).not.toContain("\x1b");
  });

  it("exits 0 when the injected planner reports no drift", async () => {
    await writeYoke(["alpha"]);
    const captured = capture();
    const code = await runCli(["node", "yoke", "doctor"], makeDeps({ captured }));
    expect(code).toBe(EXIT_OK);
    expect(captured.out()).not.toContain("PROBLEM   drift");
  });
});

describe("yoke command-line usage", () => {
  it("returns 2 for an unknown option", async () => {
    const captured = capture();
    const code = await runCli(["node", "yoke", "doctor", "--bogus"], makeDeps({ captured }));
    expect(code).toBe(EXIT_USAGE);
    expect(captured.err()).toContain("unknown option '--bogus'");
    expect(captured.out()).toBe("");
  });

  it("returns 2 for an extra argument", async () => {
    const captured = capture();
    const code = await runCli(["node", "yoke", "doctor", "extra"], makeDeps({ captured }));
    expect(code).toBe(EXIT_USAGE);
    expect(captured.err()).toContain("too many arguments");
  });

  it("returns 0 and prints the version for --version", async () => {
    const captured = capture();
    const code = await runCli(["node", "yoke", "--version"], makeDeps({ captured }));
    expect(code).toBe(EXIT_OK);
    expect(captured.out()).toBe("0.1.0\n");
  });
});
