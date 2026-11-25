/**
 * tests/commands/sync.test.ts: runSync with the harness-neutral fake adapter in temp sandboxes. Every path comes from a
 * sandbox, the drift prompt is a fake, and exec is scripted, so the real home directory and git state are never used.
 */
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXIT_DRIFT,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_PROBLEMS,
  EXIT_USAGE,
} from "../../src/commands/exit.js";
import {
  adapterMap,
  runSync,
  type SyncCommandOptions,
  type SyncDeps,
} from "../../src/commands/sync.js";
import { DRIFT_PROMPT_MESSAGE, type DriftPromptApi } from "../../src/commands/sync-prompt.js";
import type { Fs } from "../../src/core/fs-safe.js";
import { createNodeFs } from "../../src/core/fs-safe.js";
import type { Exec } from "../../src/core/git.js";
import type { AdapterFactory } from "../../src/core/plan.js";
import { cleanupSandbox, type Sandbox, setupAdapterSandbox } from "../adapters/helpers.js";
import {
  fakeAdapterFactory,
  fakePaths,
  guardedFs,
  snapshotTree,
  writeScopeFiles,
} from "../core/plan-helpers.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");

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

const CANCEL = Symbol("cancel");

const sandboxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sb) => cleanupSandbox(sb)));
});

async function newSandbox(): Promise<Sandbox> {
  const sb = await setupAdapterSandbox();
  sandboxes.push(sb);
  return sb;
}

async function seededSandbox(): Promise<Sandbox> {
  const sb = await newSandbox();
  await writeScopeFiles(sb, { user: USER_CONFIG, project: PROJECT_CONFIG, local: LOCAL_CONFIG });
  return sb;
}

/** Git root answers for `rev-parse --show-toplevel`; every other command succeeds silently. */
function repoExec(repo: string): Exec {
  return (_file, args) =>
    Promise.resolve(
      args.includes("--show-toplevel")
        ? { stdout: `${repo}\n`, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 },
    );
}

/** Outside a repository, git exits 128 with the "not a git repository" message. */
const notRepoExec: Exec = () =>
  Promise.resolve({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 });

interface Harness {
  readonly deps: SyncDeps;
  readonly stdout: string[];
  readonly stderr: string[];
}

function harnessFor(
  sb: Sandbox,
  over: {
    readonly interactive?: boolean;
    readonly prompts?: DriftPromptApi;
    readonly factories?: readonly AdapterFactory[];
    readonly fs?: Fs;
    readonly exec?: Exec;
    readonly cwd?: string;
  } = {},
): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: SyncDeps = {
    io: {
      stdout: (s) => {
        stdout.push(s);
      },
      stderr: (s) => {
        stderr.push(s);
      },
      stdoutIsTTY: false,
      stdinIsTTY: over.interactive ?? false,
    },
    cwd: over.cwd ?? sb.repo,
    homeDir: sb.home,
    env: { XDG_CONFIG_HOME: join(sb.root, "xdg") },
    fs: over.fs ?? createNodeFs(),
    exec: over.exec ?? repoExec(sb.repo),
    now: () => NOW,
    factories: over.factories ?? [fakeAdapterFactory()],
    prompts: over.prompts ?? neverPrompt(),
  };
  return { deps, stdout, stderr };
}

function neverPrompt(): DriftPromptApi {
  return {
    select: () => Promise.reject(new Error("prompt should not be shown")),
    isCancel: (value: unknown): value is symbol => typeof value === "symbol",
  };
}

function answerPrompt(answer: string | symbol): {
  readonly api: DriftPromptApi;
  readonly calls: { message: string; values: string[] }[];
} {
  const calls: { message: string; values: string[] }[] = [];
  const api: DriftPromptApi = {
    select: (o) => {
      calls.push({ message: o.message, values: o.options.map((option) => option.value) });
      return Promise.resolve(answer);
    },
    isCancel: (value: unknown): value is symbol => typeof value === "symbol",
  };
  return { api, calls };
}

const PLAIN: SyncCommandOptions = { dryRun: false, global: false, all: false, force: false };

/** Runs the first sync and then hand-edits the native project file so the next run sees drift. */
async function driftedSandbox(): Promise<Sandbox> {
  const sb = await seededSandbox();
  const first = harnessFor(sb);
  expect(await runSync(PLAIN, first.deps)).toBe(EXIT_OK);
  await writeFile(
    fakePaths(sb.home, sb.repo).project,
    `${JSON.stringify({ servers: { p1: { transport: "http", url: "https://example.com/hand-edited" } } }, null, 2)}\n`,
    "utf8",
  );
  return sb;
}

/** Stdout without its first (header) line, so a dry run and a real run can be compared. */
function bodyOf(text: string): string {
  return text.slice(text.indexOf("\n") + 1);
}

describe("runSync", () => {
  it("syncs a clean sandbox, then reports nothing to do on the second run", async () => {
    const sb = await seededSandbox();
    const first = harnessFor(sb);
    expect(await runSync(PLAIN, first.deps)).toBe(EXIT_OK);
    expect(existsSync(fakePaths(sb.home, sb.repo).project)).toBe(true);
    expect(existsSync(join(sb.repo, ".yoke", "yoke.lock"))).toBe(true);
    expect(first.stdout.join("")).toContain("written:");

    const second = harnessFor(sb);
    expect(await runSync(PLAIN, second.deps)).toBe(EXIT_OK);
    expect(second.stdout.join("")).toContain("nothing to do");
    expect(second.stderr).toEqual([]);
  });

  it("refuses drift without a TTY: exit 3, nothing written, no backup directory", async () => {
    const sb = await driftedSandbox();
    const before = await snapshotTree(sb.root);
    const run = harnessFor(sb);
    expect(await runSync(PLAIN, run.deps)).toBe(EXIT_DRIFT);
    expect(run.stderr.join("")).toContain("refused: native changes since the last sync");
    expect(run.stderr.join("")).toContain("--force");
    expect(await snapshotTree(sb.root)).toEqual(before);
    expect(await readdir(sb.backupsRoot)).toEqual([]);
  });

  it("dry run with drift: exit 3, same plan text as the real run, and nothing written", async () => {
    const sb = await driftedSandbox();
    const before = await snapshotTree(sb.root);

    const dry = harnessFor(sb);
    expect(await runSync({ ...PLAIN, dryRun: true }, dry.deps)).toBe(EXIT_DRIFT);
    expect(dry.stdout.join("").startsWith("yoke sync --dry-run:")).toBe(true);
    expect(await snapshotTree(sb.root)).toEqual(before);

    const real = harnessFor(sb);
    expect(await runSync(PLAIN, real.deps)).toBe(EXIT_DRIFT);
    expect(bodyOf(dry.stdout.join(""))).toContain(bodyOf(real.stdout.join("")));
    expect(await snapshotTree(sb.root)).toEqual(before);
  });

  it("dry run on a clean sandbox writes nothing and exits 0 through a guarded fs", async () => {
    const sb = await seededSandbox();
    const before = await snapshotTree(sb.root);
    const guarded = guardedFs();
    const dry = harnessFor(sb, { fs: guarded.fs });
    expect(await runSync({ ...PLAIN, dryRun: true }, dry.deps)).toBe(EXIT_OK);
    expect(dry.stdout.join("")).toContain("--dry-run");
    expect(guarded.writes).toEqual([]);
    expect(await snapshotTree(sb.root)).toEqual(before);
  });

  it("force proceeds past drift, warns, and backs up the original", async () => {
    const sb = await driftedSandbox();
    const run = harnessFor(sb);
    expect(await runSync({ ...PLAIN, force: true }, run.deps)).toBe(EXIT_OK);
    expect(run.stdout.join("")).toContain("warning: --force: proceeding past:");
    expect((await readdir(sb.backupsRoot)).length).toBeGreaterThan(0);
  });

  it("interactive abort: exit 3, prompt shown once with the Overwrite and Abort options, nothing written", async () => {
    const sb = await driftedSandbox();
    const before = await snapshotTree(sb.root);
    const prompt = answerPrompt("abort");
    const run = harnessFor(sb, { interactive: true, prompts: prompt.api });
    expect(await runSync(PLAIN, run.deps)).toBe(EXIT_DRIFT);
    expect(run.stderr.join("")).toContain("aborted; nothing was written");
    expect(prompt.calls).toEqual([
      { message: DRIFT_PROMPT_MESSAGE, values: ["overwrite", "abort"] },
    ]);
    expect(await snapshotTree(sb.root)).toEqual(before);
    expect(await readdir(sb.backupsRoot)).toEqual([]);
  });

  it("interactive overwrite: exit 0 and the original is backed up", async () => {
    const sb = await driftedSandbox();
    const prompt = answerPrompt("overwrite");
    const run = harnessFor(sb, { interactive: true, prompts: prompt.api });
    expect(await runSync(PLAIN, run.deps)).toBe(EXIT_OK);
    expect(prompt.calls).toHaveLength(1);
    expect(run.stdout.join("")).toContain("written:");
    expect((await readdir(sb.backupsRoot)).length).toBeGreaterThan(0);
  });

  it("interactive cancel: exit 130 and the tree is unchanged", async () => {
    const sb = await driftedSandbox();
    const before = await snapshotTree(sb.root);
    const prompt: DriftPromptApi = {
      select: () => Promise.resolve(CANCEL),
      isCancel: (value: unknown): value is symbol => value === CANCEL,
    };
    const run = harnessFor(sb, { interactive: true, prompts: prompt });
    expect(await runSync(PLAIN, run.deps)).toBe(EXIT_INTERRUPTED);
    expect(run.stderr.join("")).toContain("cancelled; nothing was written");
    expect(await snapshotTree(sb.root)).toEqual(before);
    expect(await readdir(sb.backupsRoot)).toEqual([]);
  });

  it("--global without a user file: exit 0 with a warning, and needs no repo", async () => {
    const sb = await newSandbox();
    const run = harnessFor(sb, { exec: notRepoExec });
    expect(await runSync({ ...PLAIN, global: true }, run.deps)).toBe(EXIT_OK);
    expect(run.stdout.join("")).toContain("no user config at");
  });

  it("without --global and without a repo file: exit 1 and asks for yoke init", async () => {
    const sb = await newSandbox();
    const run = harnessFor(sb);
    expect(await runSync(PLAIN, run.deps)).toBe(EXIT_PROBLEMS);
    expect(run.stderr.join("")).toContain("yoke init");
  });

  it("outside a git repository without --global: exit 1", async () => {
    const sb = await seededSandbox();
    const run = harnessFor(sb, { exec: notRepoExec });
    expect(await runSync(PLAIN, run.deps)).toBe(EXIT_PROBLEMS);
    expect(run.stderr.join("")).toContain("not inside a git repository");
  });

  it("a failed apply exits 1, names the path, and writes no lock", async () => {
    const sb = await seededSandbox();
    const failing = fakeAdapterFactory({ failApplyOn: fakePaths(sb.home, sb.repo).project });
    const run = harnessFor(sb, { factories: [failing] });
    expect(await runSync(PLAIN, run.deps)).toBe(EXIT_PROBLEMS);
    const stderr = run.stderr.join("");
    expect(stderr).toContain("boom");
    expect(stderr).toContain("no lock was updated");
    expect(existsSync(join(sb.repo, ".yoke", "yoke.lock"))).toBe(false);
  });

  it("--global with --all is a usage error: exit 2 and nothing written", async () => {
    const sb = await seededSandbox();
    const before = await snapshotTree(sb.root);
    const run = harnessFor(sb);
    expect(await runSync({ ...PLAIN, global: true, all: true }, run.deps)).toBe(EXIT_USAGE);
    expect(run.stderr.join("")).toContain("cannot be used together");
    expect(await snapshotTree(sb.root)).toEqual(before);
  });
});

describe("adapterMap", () => {
  it("maps each adapter name to its factory", async () => {
    const sb = await newSandbox();
    const factory = fakeAdapterFactory({ name: "beta" });
    const map = adapterMap([factory], {
      homeDir: sb.home,
      userConfigDir: sb.userConfigDir,
      fs: createNodeFs(),
      exec: repoExec(sb.repo),
      env: {},
    });
    expect([...map.keys()]).toEqual(["beta"]);
    expect(map.get("beta")).toBe(factory);
  });

  it("throws on a duplicate adapter name", async () => {
    const sb = await newSandbox();
    const ctx = {
      homeDir: sb.home,
      userConfigDir: sb.userConfigDir,
      fs: createNodeFs(),
      exec: repoExec(sb.repo),
      env: {},
    };
    expect(() => adapterMap([fakeAdapterFactory(), fakeAdapterFactory()], ctx)).toThrow(
      'duplicate adapter name "alpha"',
    );
  });
});
