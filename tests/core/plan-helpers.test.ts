/**
 * tests/core/plan-helpers.test.ts: checks the harness-neutral fake adapter against temp sandboxes and the drift code.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileChangePlan } from "../../src/adapters/base.js";
import {
  type DesiredScopeState,
  detectDrift,
  groupExpected,
  type ScopeDriftInput,
  stateEntryFor,
} from "../../src/core/drift.js";
import { type Scope, type StateEntry, type SyncOptions, stateKey } from "../../src/core/schema.js";
import {
  cleanupSandbox,
  lockFrom,
  makeAdapterContext,
  makeApplyContext,
  type Sandbox,
  setupAdapterSandbox,
} from "../adapters/helpers.js";
import {
  fakeAdapterFactory,
  fakePaths,
  guardedFs,
  loadSandboxConfig,
  snapshotTree,
  writeScopeFiles,
} from "./plan-helpers.js";

const ALL_SCOPES: readonly Scope[] = ["user", "project", "local"];

const CONFIG_FILES = {
  user: [
    "version: 1",
    "harnesses: [alpha]",
    "mcps:",
    "  u1:",
    "    transport: stdio",
    "    command: user-tool",
    '    args: ["--user"]',
    "",
  ].join("\n"),
  project: [
    "version: 1",
    "mcps:",
    "  p1:",
    "    transport: http",
    "    url: https://example.com/p1",
    "",
  ].join("\n"),
  local: [
    "version: 1",
    "mcps:",
    "  l1:",
    "    transport: sse",
    "    url: https://example.com/l1",
    "",
  ].join("\n"),
};

const sandboxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sb) => cleanupSandbox(sb)));
});

async function newSandbox(): Promise<Sandbox> {
  const sb = await setupAdapterSandbox();
  sandboxes.push(sb);
  return sb;
}

function desiredOf(
  grouped: Partial<Record<Scope, DesiredScopeState>>,
  scope: Scope,
): DesiredScopeState {
  const desired = grouped[scope];
  if (desired === undefined) {
    throw new Error(`no expected state for ${scope} scope`);
  }
  return desired;
}

function planAt(plans: readonly FileChangePlan[], path: string): FileChangePlan {
  const plan = plans.find((p) => p.path === path);
  if (plan === undefined) {
    throw new Error(`no plan for ${path}`);
  }
  return plan;
}

describe("fake adapter", () => {
  it("plans all scopes, applies them, reads back with no drift, and a second plan is all noop", async () => {
    const sb = await newSandbox();
    await writeScopeFiles(sb, CONFIG_FILES);
    await writeFile(join(sb.repo, "AGENTS.md"), "# Agents\n\nUse the project tools.\n", "utf8");

    const config = await loadSandboxConfig(sb);
    const adapter = fakeAdapterFactory()(makeAdapterContext(sb));
    const sync: SyncOptions = { repoPath: sb.repo, scopes: ALL_SCOPES, warn: () => {} };

    const plans = await adapter.syncStatic(config, sync);
    const applyCtx = makeApplyContext(sb);
    for (const plan of plans) {
      await plan.apply(applyCtx);
    }

    const native = await adapter.readNativeState(sb.repo);
    const grouped = groupExpected(plans.flatMap((plan) => plan.expected));
    const lock = lockFrom(
      Object.fromEntries(
        ALL_SCOPES.map((scope): [string, StateEntry] => [
          stateKey("alpha", scope),
          stateEntryFor(desiredOf(grouped, scope)),
        ]),
      ),
    );
    const inputs: ScopeDriftInput[] = ALL_SCOPES.map((scope) => {
      const key = stateKey("alpha", scope);
      return {
        key,
        native: native[scope],
        lock: lock.harnesses[key],
        desired: desiredOf(grouped, scope),
      };
    });

    expect(native.user?.mcps).toHaveProperty("u1");
    expect(native.project?.mcps).toHaveProperty("p1");
    expect(native.local?.mcps).toHaveProperty("l1");
    expect(native.project?.instructions).toBeDefined();
    expect(detectDrift(inputs).hasDrift).toBe(false);

    const second = await adapter.syncStatic(config, sync);
    expect(second.length).toBe(plans.length);
    expect(new Set(second.map((plan) => plan.action))).toEqual(new Set(["noop"]));
  });

  it("injects apply faults, and planning writes nothing", async () => {
    const sb = await newSandbox();
    await writeScopeFiles(sb, CONFIG_FILES);
    const config = await loadSandboxConfig(sb);
    const paths = fakePaths(sb.home, sb.repo);
    const { fs, writes } = guardedFs();
    const sync: SyncOptions = { repoPath: sb.repo, scopes: ALL_SCOPES, warn: () => {} };
    const adapter = fakeAdapterFactory({ failApplyOn: paths.user, fallbackOn: paths.project })(
      makeAdapterContext(sb, { fs }),
    );

    const before = await snapshotTree(sb.root);
    const plans = await adapter.syncStatic(config, sync);
    expect(writes).toEqual([]);
    expect(await snapshotTree(sb.root)).toEqual(before);

    const applyCtx = makeApplyContext(sb);
    await expect(planAt(plans, paths.user).apply(applyCtx)).rejects.toThrow("boom");
    await expect(planAt(plans, paths.project).apply(applyCtx)).resolves.toEqual({
      status: "fallback",
      backupPath: undefined,
      detail: "refused",
    });
    expect(await snapshotTree(sb.root)).toEqual(before);
  });
});
