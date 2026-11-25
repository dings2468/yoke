/**
 * tests/adapters.test.ts: cross-adapter contract (KT).
 *
 * Runs the Claude and agy adapters through their public factories against fixture sandboxes. Every path is injected and
 * the real home directory is never touched. Checks: declared capabilities, read-only detect and planning, dry-run parity
 * with a real run, plan shape, and idempotence (a second sync over the result is all noop, with no drift).
 */
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAgyAdapter } from "../src/adapters/agy.js";
import type {
  AdapterContext,
  ApplyResult,
  FileChangePlan,
  HarnessAdapter,
  HarnessCapabilities,
} from "../src/adapters/base.js";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import { detectDrift, groupExpected, stateEntryFor } from "../src/core/drift.js";
import { createNodeFs, type Fs, isNotFound } from "../src/core/fs-safe.js";
import {
  HarnessNameSchema,
  type ResolvedYokeConfig,
  SCOPES,
  type Scope,
  type StateEntry,
  type StateKey,
  type SyncOptions,
  stateKey,
  type YokeStateLock,
} from "../src/core/schema.js";
import {
  cleanupSandbox,
  copyFixture,
  fakeExec,
  loadFixtureConfig,
  lockFrom,
  makeAdapterContext,
  makeApplyContext,
  type Sandbox,
  setupAdapterSandbox,
} from "./adapters/helpers.js";

type AdapterName = "claude" | "agy";

interface AdapterSpec {
  readonly name: AdapterName;
  readonly create: (ctx: AdapterContext) => HarnessAdapter;
  /** Stdout of `<name> --version`, as detect parses it. */
  readonly versionOutput: string;
  readonly version: string;
}

const ADAPTERS: readonly AdapterSpec[] = [
  {
    name: "claude",
    create: createClaudeAdapter,
    versionOutput: "2.1.331 (Claude Code)",
    version: "2.1.331",
  },
  { name: "agy", create: createAgyAdapter, versionOutput: "agy 1.5.16", version: "1.5.16" },
];

/** v0.1 capability values, identical for both adapters. */
const EXPECTED_CAPABILITIES: HarnessCapabilities = {
  staticMcp: true,
  staticInstructions: true,
  reverseRead: true,
  sessionExport: false,
  sessionImport: "handoff-file-only",
};

const ALL_SCOPES: readonly Scope[] = SCOPES;
const ACTIONS: readonly string[] = ["create", "update", "symlink", "patch-json", "noop"];

const sandboxes: Sandbox[] = [];

afterEach(async () => {
  for (const sb of sandboxes.splice(0)) {
    await cleanupSandbox(sb);
  }
});

interface FixtureRun {
  readonly sb: Sandbox;
  readonly config: ResolvedYokeConfig;
}

/** A fresh sandbox with the user, project, and local config fixtures and both instruction files. */
async function freshRun(): Promise<FixtureRun> {
  const sb = await setupAdapterSandbox();
  sandboxes.push(sb);
  await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.userConfigDir, "AGENTS.md"));
  await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.repo, "AGENTS.md"));
  const config = await loadFixtureConfig(sb, {
    user: "user.yaml",
    project: "project.yaml",
    local: "local.yaml",
  });
  return { sb, config };
}

/** Filesystem whose write methods record the call and reject. Reads go to the real sandbox. */
function guardedFs(): { readonly fs: Fs; readonly writes: string[] } {
  const writes: string[] = [];
  const denied = (method: string) => (): Promise<never> => {
    writes.push(method);
    return Promise.reject(new Error(`write attempted during read-only work: ${method}`));
  };
  const fs: Fs = {
    ...createNodeFs(),
    writeFile: denied("writeFile"),
    rename: denied("rename"),
    mkdir: denied("mkdir"),
    copyFile: denied("copyFile"),
    symlink: denied("symlink"),
    unlink: denied("unlink"),
    chmod: denied("chmod"),
  };
  return { fs, writes };
}

/** Lists every file, directory, and link under `dir` with its content, so any change shows in a comparison. */
async function snapshotTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        out.push(`d ${full}`);
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        out.push(`l ${full} -> ${await readlink(full)}`);
      } else {
        out.push(`f ${full} ${await readFile(full, "utf8")}`);
      }
    }
  };
  await walk(dir);
  return out.sort();
}

/** Each adapter built through its public factory, with every path inside `sb`. */
function adaptersFor(
  sb: Sandbox,
  over?: Partial<AdapterContext>,
): readonly { readonly spec: AdapterSpec; readonly adapter: HarnessAdapter }[] {
  return ADAPTERS.map((spec) => ({ spec, adapter: spec.create(makeAdapterContext(sb, over)) }));
}

function syncOptions(sb: Sandbox): SyncOptions {
  return { repoPath: sb.repo, scopes: ALL_SCOPES, warn: () => {} };
}

/** Plans a full sync (all three scopes) for every adapter, in adapter order. Planning writes nothing. */
async function planAll(
  sb: Sandbox,
  config: ResolvedYokeConfig,
  over?: Partial<AdapterContext>,
): Promise<Map<AdapterName, FileChangePlan[]>> {
  const out = new Map<AdapterName, FileChangePlan[]>();
  for (const { spec, adapter } of adaptersFor(sb, over)) {
    out.set(spec.name, await adapter.syncStatic(config, syncOptions(sb)));
  }
  return out;
}

function flatten(plans: ReadonlyMap<AdapterName, readonly FileChangePlan[]>): FileChangePlan[] {
  return [...plans.values()].flat();
}

/** Comparable view of a plan list. Sandbox roots are replaced so two sandboxes can be compared. */
function comparable(
  sb: Sandbox,
  plans: ReadonlyMap<AdapterName, readonly FileChangePlan[]>,
): { adapter: string; path: string; action: string; summary: string }[] {
  const rel = (text: string): string => text.replaceAll(sb.root, "<root>");
  return [...plans].flatMap(([adapter, list]) =>
    list.map((plan) => ({
      adapter,
      path: rel(plan.path),
      action: plan.action,
      summary: rel(plan.summary),
    })),
  );
}

/** Lock built from what the plans expect, the same way a real sync records it. */
function buildLock(plans: ReadonlyMap<AdapterName, readonly FileChangePlan[]>): YokeStateLock {
  const entries: Record<string, StateEntry> = {};
  for (const [name, list] of plans) {
    const grouped = groupExpected(list.flatMap((plan) => plan.expected));
    for (const scope of ALL_SCOPES) {
      const state = grouped[scope];
      if (state !== undefined) {
        entries[stateKey(name, scope)] = stateEntryFor(state);
      }
    }
  }
  return lockFrom(entries);
}

async function pathKind(path: string): Promise<"file" | "symlink" | "missing"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      return "symlink";
    }
    return stat.isFile() ? "file" : "missing";
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return "missing";
    }
    throw err;
  }
}

describe("adapter contract", () => {
  it.each(ADAPTERS)("$name: name, capabilities, and optional methods match v0.1", async (spec) => {
    const run = await freshRun();
    const adapter = spec.create(makeAdapterContext(run.sb));

    expect(HarnessNameSchema.safeParse(adapter.name).success).toBe(true);
    expect(adapter.name).toBe(spec.name);
    expect(adapter.capabilities).toEqual(EXPECTED_CAPABILITIES);
    expect(typeof adapter.detect).toBe("function");
    expect(typeof adapter.readNativeState).toBe("function");
    expect(typeof adapter.syncStatic).toBe("function");
    // sessionExport is false and sessionImport is handoff-file-only, so both optional methods are absent.
    expect(adapter.exportLatestSession).toBeUndefined();
    expect(adapter.importAndLaunch).toBeUndefined();
    // reverseRead is declared, so readNativeState answers for a repo with no native files.
    await expect(adapter.readNativeState(run.sb.repo)).resolves.toBeTypeOf("object");
  });

  it.each(ADAPTERS)(
    "$name: detect runs only its version probe and writes nothing",
    async (spec) => {
      const run = await freshRun();
      const guard = guardedFs();
      const exec = fakeExec(
        new Map([
          [`${spec.name} --version`, { stdout: spec.versionOutput, stderr: "", exitCode: 0 }],
        ]),
      );
      const adapter = spec.create(makeAdapterContext(run.sb, { fs: guard.fs, exec }));
      const before = await snapshotTree(run.sb.root);

      const status = await adapter.detect();

      expect(status.installed).toBe(true);
      expect(status.version).toBe(spec.version);
      expect(exec.calls).toEqual([`${spec.name} --version`]);
      expect(guard.writes).toEqual([]);
      expect(await snapshotTree(run.sb.root)).toEqual(before);
    },
  );

  it("planning over a read-only filesystem writes nothing, and every plan is well formed", async () => {
    const run = await freshRun();
    const guard = guardedFs();
    const before = await snapshotTree(run.sb.root);

    const plans = await planAll(run.sb, run.config, { fs: guard.fs });

    expect(guard.writes).toEqual([]);
    expect(await snapshotTree(run.sb.root)).toEqual(before);

    for (const { spec } of adaptersFor(run.sb)) {
      for (const plan of plans.get(spec.name) ?? []) {
        expect(plan.path.startsWith(run.sb.root), plan.path).toBe(true);
        expect(ACTIONS, plan.path).toContain(plan.action);
        expect(plan.summary.trim(), plan.path).not.toBe("");
        expect(
          plan.warnings.every((warning) => warning.startsWith(spec.name)),
          `${spec.name} warnings: ${plan.warnings.join(" | ")}`,
        ).toBe(true);

        // A file that exists before the change carries its before text; a symlink carries its target text.
        const kind = await pathKind(plan.path);
        if (kind === "file") {
          expect(plan.before, plan.path).toBeTypeOf("string");
        }
        if (kind === "symlink") {
          expect(plan.link?.before, plan.path).toBeTypeOf("string");
        }
        if (plan.action === "symlink") {
          expect(plan.link?.after, plan.path).toBeTypeOf("string");
        } else if (plan.action !== "noop") {
          expect(plan.after, plan.path).toBeTypeOf("string");
        }
      }
    }
  });

  it("a dry-run plan equals the plan a real run produces (path, action, summary)", async () => {
    const dry = await freshRun();
    const real = await freshRun();

    // The dry run stops after planning. The real run plans the same way, then applies every plan in order.
    const dryPlans = await planAll(dry.sb, dry.config);
    const realPlans = await planAll(real.sb, real.config);
    expect(comparable(real.sb, realPlans)).toEqual(comparable(dry.sb, dryPlans));

    const applyCtx = makeApplyContext(real.sb);
    for (const plan of flatten(realPlans)) {
      const result: ApplyResult = await plan.apply(applyCtx);
      if (result.backupPath !== undefined) {
        expect(result.backupPath.startsWith(real.sb.root), result.backupPath).toBe(true);
      }
    }
  });

  it("a second sync over the applied result is a no-op with no drift", async () => {
    const run = await freshRun();
    const first = await planAll(run.sb, run.config);
    const applyCtx = makeApplyContext(run.sb);
    for (const plan of flatten(first)) {
      await plan.apply(applyCtx);
    }

    const lock = buildLock(first);
    const second = await planAll(run.sb, run.config, { lock });
    for (const plan of flatten(second)) {
      expect(plan.action, `${plan.path}: ${plan.summary}`).toBe("noop");
    }

    // readNativeState reads owned disable names from the lock, so the adapters get it through their context.
    for (const { spec, adapter } of adaptersFor(run.sb, { lock })) {
      const native = await adapter.readNativeState(run.sb.repo);
      const grouped = groupExpected(first.get(spec.name)?.flatMap((plan) => plan.expected) ?? []);
      for (const scope of ALL_SCOPES) {
        const desired = grouped[scope];
        if (desired === undefined) {
          continue;
        }
        const key: StateKey = stateKey(spec.name, scope);
        const report = detectDrift([
          { key, native: native[scope], lock: lock.harnesses[key], desired },
        ]);
        expect(report.hasDrift, key).toBe(false);
      }
    }
  });
});

describe("adapter contract: source isolation", () => {
  it("no src/core or src/commands file mentions a harness name", async () => {
    const roots = [
      fileURLToPath(new URL("../src/core/", import.meta.url)),
      fileURLToPath(new URL("../src/commands/", import.meta.url)),
    ];
    const pattern = /(claude|agy|gemini|antigravity)/i;
    const offenders: string[] = [];
    for (const root of roots) {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) {
          continue;
        }
        const path = join(root, entry.name);
        const lines = (await readFile(path, "utf8")).split("\n");
        lines.forEach((line, index) => {
          if (pattern.test(line)) {
            offenders.push(`${path}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
