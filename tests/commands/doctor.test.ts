/**
 * tests/commands/doctor.test.ts: read-only doctor checks against temp directories, fake adapters, and a scripted exec.
 * Nothing here touches the real home directory or harness config files.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdapterContext,
  advisoryPlan,
  type FileChangePlan,
  type HarnessAdapter,
} from "../../src/adapters/base.js";
import type { AdapterFactory } from "../../src/adapters/registry.js";
import {
  type DoctorDeps,
  type DoctorPlanner,
  type DoctorPlanResult,
  doctorScopes,
  runDoctor,
} from "../../src/commands/doctor.js";
import {
  type DoctorCheck,
  doctorExitCode,
  formatDoctorReport,
} from "../../src/commands/doctor-format.js";
import { EXIT_OK, EXIT_PROBLEMS } from "../../src/commands/exit.js";
import type { DriftReport } from "../../src/core/drift.js";
import type { Exec, ExecResult } from "../../src/core/git.js";
import type { PartialYokeConfig, StateEntry, YokeStateLock } from "../../src/core/schema.js";
import { guardedFs, snapshotTree } from "../core/plan-helpers.js";

const LOCK_TIME = "2026-01-01T00:00:00.000Z";

let root: string;
let repo: string;
let userConfigDir: string;
let homeDir: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "yoke-doctor-")));
  repo = join(root, "repo");
  homeDir = join(root, "home");
  userConfigDir = join(root, "xdg", "yoke");
  await mkdir(repo, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(userConfigDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface ExecScript {
  /** Repository root printed by `git rev-parse`, or "outside" for a non-repository. */
  readonly git: string | "outside";
  /** Never resolve harness calls (used for the timeout case). */
  readonly hang?: boolean;
}

function scriptedExec(script: ExecScript): Exec {
  return (file: string): Promise<ExecResult> => {
    if (file === "git") {
      if (script.git === "outside") {
        return Promise.resolve({
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
          exitCode: 128,
        });
      }
      return Promise.resolve({ stdout: `${script.git}\n`, stderr: "", exitCode: 0 });
    }
    if (script.hang === true) {
      return new Promise<ExecResult>(() => undefined);
    }
    return Promise.resolve({ stdout: `${file} 1.2.3\n`, stderr: "", exitCode: 0 });
  };
}

interface FakeOptions {
  readonly name: string;
  readonly installed?: boolean;
  readonly authenticated?: boolean;
  readonly reverseRead?: boolean;
  readonly native?: PartialYokeConfig;
}

/** Fake adapter whose detect() runs through the injected exec, so timeouts behave as they do for real adapters. */
function fakeFactory(opts: FakeOptions): AdapterFactory {
  return (ctx: AdapterContext): HarnessAdapter => ({
    name: opts.name,
    capabilities: {
      staticMcp: true,
      staticInstructions: true,
      reverseRead: opts.reverseRead ?? true,
      sessionExport: false,
      sessionImport: "handoff-file-only",
    },
    detect: async () => {
      await ctx.exec(opts.name, ["--version"], { cwd: ctx.homeDir });
      return {
        installed: opts.installed ?? true,
        authenticated: opts.authenticated ?? false,
        version: "1.2.3",
      };
    },
    readNativeState: async () => opts.native ?? {},
    syncStatic: async (): Promise<FileChangePlan[]> => [],
  });
}

const EMPTY_PLANNER: DoctorPlanner = async () => emptyPlanResult();

function makeDeps(over: Partial<DoctorDeps> & { readonly script?: ExecScript } = {}): DoctorDeps {
  const { script, ...rest } = over;
  return {
    cwd: repo,
    homeDir,
    userConfigDir,
    env: {},
    fs: guardedFs().fs,
    exec: scriptedExec(script ?? { git: repo }),
    factories: [fakeFactory({ name: "alpha" }), fakeFactory({ name: "beta" })],
    planner: EMPTY_PLANNER,
    ...rest,
  };
}

async function writeYoke(harnesses: readonly string[]): Promise<void> {
  const list = harnesses.map((name) => `  - ${name}`).join("\n");
  await writeFile(join(repo, "yoke.yaml"), `version: 1\nharnesses:\n${list}\n`, "utf8");
}

function find(
  checks: readonly DoctorCheck[],
  kind: string,
  subject: string,
): DoctorCheck | undefined {
  return checks.find((check) => check.kind === kind && check.subject === subject);
}

const EMPTY_ENTRY: StateEntry = { mcpHashes: {}, instructionsHash: null };

function lockWith(keys: readonly string[]): YokeStateLock {
  return {
    version: 1,
    lastSyncedAt: LOCK_TIME,
    harnesses: Object.fromEntries(keys.map((key) => [key, EMPTY_ENTRY])),
  };
}

function emptyPlanResult(): DoctorPlanResult {
  return { plans: [], drift: { scopes: [], hasDrift: false } };
}

describe("doctorScopes", () => {
  it("omits user scope when the lock has no user entry for the harness", () => {
    expect(doctorScopes(undefined, "alpha")).toEqual(["project", "local"]);
    expect(doctorScopes(lockWith(["alpha:project"]), "alpha")).toEqual(["project", "local"]);
  });

  it("includes user scope only for a matching <harness>:user lock key", () => {
    expect(doctorScopes(lockWith(["alpha:user"]), "alpha")).toEqual(["user", "project", "local"]);
    expect(doctorScopes(lockWith(["beta:user"]), "alpha")).toEqual(["project", "local"]);
  });
});

describe("runDoctor", () => {
  it("reports binary and auth per adapter, with auth never reported as not authenticated", async () => {
    await writeYoke(["alpha", "beta"]);
    const deps = makeDeps({
      factories: [
        fakeFactory({ name: "alpha", authenticated: true }),
        fakeFactory({ name: "beta", authenticated: false }),
      ],
    });
    const report = await runDoctor(deps);
    expect(find(report.checks, "binary", "alpha")?.status).toBe("ok");
    expect(find(report.checks, "auth", "alpha")?.status).toBe("ok");
    expect(find(report.checks, "auth", "beta")?.status).toBe("unknown");
    expect(find(report.checks, "auth", "beta")?.message).toContain("not verified");
    expect(report.checks.some((check) => check.status === "problem")).toBe(false);
    expect(doctorExitCode(report)).toBe(EXIT_OK);
  });

  it("gives binary unknown, not a problem, when the probe times out, and finishes quickly", async () => {
    await writeYoke(["alpha"]);
    const started = Date.now();
    const report = await runDoctor(
      makeDeps({
        factories: [fakeFactory({ name: "alpha" })],
        exec: scriptedExec({ git: repo, hang: true }),
        timeoutMs: 20,
      }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(find(report.checks, "binary", "alpha")?.status).toBe("unknown");
    expect(doctorExitCode(report)).toBe(EXIT_OK);
  });

  it("reports a listed harness that is not installed as a problem, and an unlisted one as info", async () => {
    await writeYoke(["alpha"]);
    const report = await runDoctor(
      makeDeps({
        factories: [
          fakeFactory({ name: "alpha", installed: false }),
          fakeFactory({ name: "beta", installed: false }),
        ],
      }),
    );
    expect(find(report.checks, "binary", "alpha")?.status).toBe("problem");
    expect(find(report.checks, "binary", "beta")?.status).toBe("info");
    expect(doctorExitCode(report)).toBe(EXIT_PROBLEMS);
  });

  it("reports a broken symlink as a problem", async () => {
    await writeYoke(["alpha"]);
    const linkPath = join(repo, "ALPHA.md");
    const report = await runDoctor(
      makeDeps({
        factories: [
          fakeFactory({
            name: "alpha",
            native: {
              project: {
                mcps: {},
                instructions: { kind: "symlink", path: linkPath, target: "missing.md" },
              },
            },
          }),
        ],
      }),
    );
    const check = report.checks.find((c) => c.kind === "symlink" && c.status === "problem");
    expect(check?.message).toBe(`broken symlink ${linkPath} -> missing.md`);
    expect(doctorExitCode(report)).toBe(EXIT_PROBLEMS);
  });

  it("reports added and modified drift as problems that exit 1, and create as info", async () => {
    await writeYoke(["alpha"]);
    const drift: DriftReport = {
      scopes: [
        {
          key: "alpha:project",
          mcps: [
            {
              name: "added-server",
              status: "added",
              native: { transport: "stdio", command: "srv" },
              desired: undefined,
            },
            {
              name: "changed-server",
              status: "modified",
              native: { transport: "stdio", command: "old" },
              desired: { transport: "stdio", command: "new" },
            },
          ],
          instructions: undefined,
          hasDrift: true,
        },
        {
          key: "alpha:local",
          mcps: [
            {
              name: "fresh",
              status: "create",
              native: undefined,
              desired: { transport: "stdio", command: "fresh" },
            },
          ],
          instructions: undefined,
          hasDrift: false,
        },
      ],
      hasDrift: true,
    };
    const report = await runDoctor(
      makeDeps({
        factories: [fakeFactory({ name: "alpha" })],
        planner: async () => ({ plans: [], drift }),
      }),
    );
    const drifted = report.checks.filter((c) => c.kind === "drift" && c.status === "problem");
    expect(drifted.map((c) => c.message)).toEqual([
      'added MCP server "added-server"',
      'modified MCP server "changed-server"',
    ]);
    expect(drifted[0]?.hint).toContain("yoke sync");
    expect(report.checks.find((c) => c.kind === "drift" && c.status === "info")?.message).toBe(
      'not yet synced: MCP server "fresh"',
    );
    expect(doctorExitCode(report)).toBe(EXIT_PROBLEMS);
  });

  it("reports in-sync keys as ok and passes the default scopes to the planner", async () => {
    await writeYoke(["alpha"]);
    const seen: string[][] = [];
    const planner: DoctorPlanner = async (input) => {
      seen.push([...input.opts.scopes]);
      return {
        plans: [],
        drift: {
          scopes: [{ key: "alpha:project", mcps: [], instructions: undefined, hasDrift: false }],
          hasDrift: false,
        },
      };
    };
    const report = await runDoctor(
      makeDeps({ factories: [fakeFactory({ name: "alpha" })], planner }),
    );
    expect(find(report.checks, "drift", "alpha:project")?.status).toBe("ok");
    expect(seen).toEqual([["project", "local"]]);
  });

  it("skips drift with info when yoke.yaml is missing and never calls the planner", async () => {
    let calls = 0;
    const report = await runDoctor(
      makeDeps({
        factories: [fakeFactory({ name: "alpha" })],
        planner: async () => {
          calls += 1;
          return emptyPlanResult();
        },
      }),
    );
    expect(find(report.checks, "config", "yoke.yaml")?.status).toBe("info");
    expect(calls).toBe(0);
    expect(doctorExitCode(report)).toBe(EXIT_OK);
  });

  it("reports an invalid lock as a problem", async () => {
    await writeYoke(["alpha"]);
    await mkdir(join(repo, ".yoke"), { recursive: true });
    await writeFile(join(repo, ".yoke", "yoke.lock"), "{}", "utf8");
    const report = await runDoctor(makeDeps({ factories: [fakeFactory({ name: "alpha" })] }));
    expect(find(report.checks, "lock", "repo")?.status).toBe("problem");
    expect(doctorExitCode(report)).toBe(EXIT_PROBLEMS);
  });

  it("reports a listed harness with no registered adapter as a problem", async () => {
    await writeYoke(["ghost"]);
    const report = await runDoctor(makeDeps({ factories: [fakeFactory({ name: "alpha" })] }));
    expect(find(report.checks, "config", "ghost")?.status).toBe("problem");
    expect(doctorExitCode(report)).toBe(EXIT_PROBLEMS);
  });

  it("reports a plan warning once, as warn", async () => {
    await writeYoke(["alpha"]);
    const warning = "alpha: sample warning";
    const planner: DoctorPlanner = async () => ({
      plans: [advisoryPlan("project", "AGENTS.md", "sample", [warning, warning])],
      drift: { scopes: [], hasDrift: false },
    });
    const report = await runDoctor(
      makeDeps({ factories: [fakeFactory({ name: "alpha" })], planner }),
    );
    const warns = report.checks.filter((c) => c.kind === "plan");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.status).toBe("warn");
    expect(doctorExitCode(report)).toBe(EXIT_OK);
  });

  it("reports outside a git repository as info and skips project checks", async () => {
    let calls = 0;
    const report = await runDoctor(
      makeDeps({
        script: { git: "outside" },
        planner: async () => {
          calls += 1;
          return emptyPlanResult();
        },
      }),
    );
    expect(find(report.checks, "repo", "cwd")?.status).toBe("info");
    expect(calls).toBe(0);
    expect(doctorExitCode(report)).toBe(EXIT_OK);
  });

  it("writes nothing to the tree", async () => {
    await writeYoke(["alpha"]);
    await writeFile(join(repo, "AGENTS.md"), "# Rules\n", "utf8");
    const before = await snapshotTree(root);
    const guard = guardedFs();
    await runDoctor(makeDeps({ fs: guard.fs, factories: [fakeFactory({ name: "alpha" })] }));
    expect(guard.writes).toEqual([]);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("formats a report without colour in plain lines", async () => {
    await writeYoke(["alpha"]);
    const report = await runDoctor(makeDeps({ factories: [fakeFactory({ name: "alpha" })] }));
    const text = formatDoctorReport(report, { color: false });
    expect(text).toContain("ok      binary alpha: installed (version 1.2.3)");
    expect(text).toMatch(/doctor: /);
  });
});
