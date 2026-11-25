/**
 * tests/core/plan-build.test.ts: buildSyncPlan with the harness-neutral fake adapter in temp sandboxes.
 * Every test injects paths under the sandbox, so the real home directory is never read.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFs } from "../../src/core/fs-safe.js";
import type { Exec } from "../../src/core/git.js";
import {
  type AdapterFactory,
  buildSyncPlan,
  PlanConflictError,
  type PlanRequest,
} from "../../src/core/plan.js";
import { cleanupSandbox, type Sandbox, setupAdapterSandbox } from "../adapters/helpers.js";
import { fakeAdapterFactory, guardedFs, snapshotTree, writeScopeFiles } from "./plan-helpers.js";

const exec: Exec = () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });

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

async function newSandbox(): Promise<Sandbox> {
  const sb = await setupAdapterSandbox();
  sandboxes.push(sb);
  return sb;
}

function requestFor(
  sb: Sandbox,
  over: Partial<PlanRequest> = {},
  adapters: ReadonlyMap<string, AdapterFactory> = new Map([["alpha", fakeAdapterFactory()]]),
): PlanRequest {
  return {
    repoPath: sb.repo,
    scopes: ["user", "project", "local"],
    force: false,
    global: false,
    homeDir: sb.home,
    env: { XDG_CONFIG_HOME: join(sb.root, "xdg") },
    readFs: createNodeFs(),
    exec,
    adapters,
    ...over,
  };
}

async function seedFiles(sb: Sandbox, user: string = USER_CONFIG): Promise<void> {
  await writeScopeFiles(sb, { user, project: PROJECT_CONFIG, local: LOCAL_CONFIG });
}

describe("buildSyncPlan", () => {
  it("plans a fresh sandbox with no drift, a repo lock update, and no block", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const plan = await buildSyncPlan(requestFor(sb));
    expect(plan.plans.length).toBeGreaterThan(0);
    expect(plan.drift.hasDrift).toBe(false);
    expect(plan.blocked).toBe(false);
    expect(plan.gate).toEqual([]);
    expect(plan.force).toBe(false);
    expect(plan.backupRoot).toBe(join(sb.userConfigDir, "backups"));
    const repoLock = plan.locks.find((lock) => lock.file === "repo");
    expect(repoLock?.path).toBe(join(sb.repo, ".yoke", "yoke.lock"));
    expect(repoLock?.changed).toBe(true);
    expect(Object.keys(repoLock?.entries ?? {})).toEqual(["alpha:local", "alpha:project"]);
  });

  it("writes nothing and leaves the tree unchanged", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const before = await snapshotTree(sb.root);
    const guarded = guardedFs();
    await buildSyncPlan(requestFor(sb, { readFs: guarded.fs }));
    expect(guarded.writes).toEqual([]);
    expect(await snapshotTree(sb.root)).toEqual(before);
  });

  it("gives the same (path, action, summary) list when built twice", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const key = (p: Awaited<ReturnType<typeof buildSyncPlan>>) =>
      p.plans.map((plan) => [plan.path, plan.action, plan.summary]);
    const first = await buildSyncPlan(requestFor(sb));
    const second = await buildSyncPlan(requestFor(sb));
    expect(key(second)).toEqual(key(first));
  });

  it("reports an unmanaged native server as drift, blocks it, and force clears the block", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    await writeFile(
      join(sb.repo, ".alpha.json"),
      JSON.stringify({
        servers: { ghost: { transport: "stdio", command: "ghost-tool", args: [], env: {} } },
      }),
      "utf8",
    );
    const blocked = await buildSyncPlan(requestFor(sb));
    expect(blocked.drift.hasDrift).toBe(true);
    expect(blocked.gate.some((reason) => reason.kind === "drift")).toBe(true);
    expect(blocked.blocked).toBe(true);

    const forced = await buildSyncPlan(requestFor(sb, { force: true }));
    expect(forced.drift.hasDrift).toBe(true);
    expect(forced.blocked).toBe(false);
  });

  it("gates a corrupt repo lock as lock-corrupt and plans the repo lock as changed", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    await mkdir(join(sb.repo, ".yoke"), { recursive: true });
    await writeFile(join(sb.repo, ".yoke", "yoke.lock"), "{", "utf8");
    const plan = await buildSyncPlan(requestFor(sb));
    const corrupt = plan.gate.find((reason) => reason.kind === "lock-corrupt");
    expect(corrupt?.kind === "lock-corrupt" ? corrupt.reason : "").toMatch(/^invalid JSON/);
    expect(plan.blocked).toBe(true);
    expect(plan.locks.find((lock) => lock.file === "repo")?.changed).toBe(true);
  });

  it("gates a harness that cannot read native state as drift-unchecked", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const unchecked = new Map<string, AdapterFactory>([
      ["alpha", fakeAdapterFactory({ capabilities: { reverseRead: false } })],
    ]);
    const plan = await buildSyncPlan(requestFor(sb, {}, unchecked));
    expect(plan.gate).toContainEqual({ kind: "drift-unchecked", harness: "alpha" });
    expect(plan.blocked).toBe(true);
    expect(plan.drift.scopes).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("drift is not checked"))).toBe(true);
  });

  it("throws PlanConflictError when two harnesses write the same file", async () => {
    const sb = await newSandbox();
    await seedFiles(sb, USER_CONFIG.replace("harnesses: [alpha]", "harnesses: [alpha, beta]"));
    const adapters = new Map<string, AdapterFactory>([
      ["alpha", fakeAdapterFactory()],
      ["beta", fakeAdapterFactory({ name: "alpha" })],
    ]);
    await expect(buildSyncPlan(requestFor(sb, {}, adapters))).rejects.toThrow(PlanConflictError);
  });

  it("global plans only the user lock and only user keys", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const plan = await buildSyncPlan(requestFor(sb, { global: true, scopes: ["user"] }));
    expect(plan.locks.map((lock) => lock.file)).toEqual(["user"]);
    expect(plan.locks[0]?.path).toBe(join(sb.userConfigDir, "yoke.lock"));
    expect(Object.keys(plan.locks[0]?.entries ?? {})).toEqual(["alpha:user"]);
    expect(plan.plans.every((p) => p.scope === "user")).toBe(true);
  });

  it("returns an empty plan with the config warning when global has no user config", async () => {
    const sb = await newSandbox();
    const plan = await buildSyncPlan(requestFor(sb, { global: true, scopes: ["user"] }));
    expect(plan.plans).toEqual([]);
    expect(plan.locks).toEqual([]);
    expect(plan.blocked).toBe(false);
    expect(plan.drift).toEqual({ scopes: [], hasDrift: false });
    expect(plan.warnings.some((w) => w.includes("no user config"))).toBe(true);
  });

  it("lists each warning once, in order", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const duplicating: AdapterFactory = (ctx) => {
      const base = fakeAdapterFactory()(ctx);
      return {
        ...base,
        syncStatic: (config, sync) => {
          sync.warn("same message");
          sync.warn("same message");
          return base.syncStatic(config, sync);
        },
      };
    };
    const adapters = new Map<string, AdapterFactory>([["alpha", duplicating]]);
    const plan = await buildSyncPlan(requestFor(sb, { harnesses: ["alpha", "zeta"] }, adapters));
    const same = plan.warnings.filter((w) => w === "same message");
    expect(same).toHaveLength(1);
    const zeta = plan.warnings.filter((w) => w.includes('"zeta"'));
    expect(zeta).toHaveLength(1);
    expect(new Set(plan.warnings).size).toBe(plan.warnings.length);
  });
});
