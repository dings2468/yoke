/**
 * tests/core/plan-execute.test.ts: the drift gate and executePlan with the harness-neutral fake adapter.
 * Every test runs in a temp sandbox; the real home directory is never touched.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeFs } from "../../src/core/fs-safe.js";
import type { Exec } from "../../src/core/git.js";
import {
  type AdapterFactory,
  buildSyncPlan,
  decideGate,
  executePlan,
  lockPaths,
  type PlanRequest,
  readLock,
  type SyncPlan,
} from "../../src/core/plan.js";
import { cleanupSandbox, type Sandbox, setupAdapterSandbox } from "../adapters/helpers.js";
import {
  fakeAdapterFactory,
  fakePaths,
  guardedFs,
  snapshotTree,
  writeScopeFiles,
} from "./plan-helpers.js";

const exec: Exec = () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
const now = (): Date => new Date("2026-11-24T10:00:00.000Z");

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

async function seedFiles(sb: Sandbox): Promise<void> {
  await writeScopeFiles(sb, { user: USER_CONFIG, project: PROJECT_CONFIG, local: LOCAL_CONFIG });
}

/** Writes an unmanaged server into the project native file, which the planner reports as drift. */
async function plantDrift(sb: Sandbox): Promise<void> {
  const project = fakePaths(sb.home, sb.repo).project;
  await writeFile(
    project,
    `${JSON.stringify({ servers: { ghost: { transport: "stdio", command: "x" } } })}\n`,
  );
}

function lockPathsFor(sb: Sandbox): { readonly repo: string; readonly user: string } {
  return lockPaths({ repoPath: sb.repo, userConfigDir: sb.userConfigDir });
}

function input(plan: SyncPlan, over: { confirm?: (p: SyncPlan) => Promise<boolean> } = {}) {
  return { plan, fs: createNodeFs(), now, ...over };
}

describe("decideGate", () => {
  it("is clear without reasons and never calls confirm", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const plan = await buildSyncPlan(requestFor(sb));
    const confirm = vi.fn(() => Promise.resolve(true));
    expect((await decideGate(plan, confirm)).kind).toBe("clear");
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("executePlan", () => {
  it("applies a clean plan and writes both lock files atomically", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const plan = await buildSyncPlan(requestFor(sb));
    const result = await executePlan(input(plan));

    expect(result.status).toBe("applied");
    expect(result.gate.kind).toBe("clear");
    expect(result.applied.length).toBe(plan.plans.length);
    expect(await readFile(fakePaths(sb.home, sb.repo).user, "utf8")).toContain("u1");

    const paths = lockPathsFor(sb);
    expect([...result.locksWritten].sort()).toEqual([paths.repo, paths.user].sort());
    const repoLoad = await readLock(createNodeFs(), paths.repo);
    const repoUpdate = plan.locks.find((lock) => lock.file === "repo");
    expect(repoLoad.status).toBe("ok");
    if (repoLoad.status === "ok") expect(repoLoad.lock.harnesses).toEqual(repoUpdate?.entries);
    expect((await readLock(createNodeFs(), paths.user)).status).toBe("ok");
    expect(await readdir(join(sb.repo, ".yoke"))).toEqual(["yoke.lock"]);
  });

  it("is all unchanged on a second build and writes no lock or backup", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    await executePlan(input(await buildSyncPlan(requestFor(sb))));

    const second = await buildSyncPlan(requestFor(sb));
    expect(second.plans.every((plan) => plan.action === "noop")).toBe(true);
    expect(second.blocked).toBe(false);
    const result = await executePlan(input(second));
    expect(result.status).toBe("applied");
    expect(result.applied.every((change) => change.result.status === "unchanged")).toBe(true);
    expect(result.locksWritten).toEqual([]);
    expect(result.backupDir).toBeUndefined();
  });

  it("refuses drift without force or confirm, and writes nothing", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    await plantDrift(sb);
    const plan = await buildSyncPlan(requestFor(sb));
    expect(plan.blocked).toBe(true);

    const before = await snapshotTree(sb.root);
    const guarded = guardedFs();
    const result = await executePlan({ plan, fs: guarded.fs, now });
    expect(result.status).toBe("refused");
    expect(result.gate.kind).toBe("refused");
    if (result.gate.kind === "refused") expect(result.gate.interactive).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.backupDir).toBeUndefined();
    expect(guarded.writes).toEqual([]);
    expect(await snapshotTree(sb.root)).toEqual(before);
  });

  it("refuses interactively when confirm resolves false", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    await plantDrift(sb);
    const plan = await buildSyncPlan(requestFor(sb));
    const confirm = vi.fn(() => Promise.resolve(false));
    const result = await executePlan(input(plan, { confirm }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("refused");
    expect(result.gate.kind === "refused" && result.gate.interactive).toBe(true);
  });

  it("applies after confirm resolves true and backs up the original native file", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    await plantDrift(sb);
    const original = await readFile(fakePaths(sb.home, sb.repo).project, "utf8");
    const plan = await buildSyncPlan(requestFor(sb));
    const confirm = vi.fn(() => Promise.resolve(true));
    const result = await executePlan(input(plan, { confirm }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.gate.kind).toBe("confirmed");
    expect(result.status).toBe("applied");
    expect(result.backupDir).toBeDefined();
    const backedUp = await snapshotTree(result.backupDir ?? sb.backupsRoot);
    expect(backedUp.some((line) => line.includes(original.trim()))).toBe(true);
  });

  it("applies a forced plan without calling confirm", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    await plantDrift(sb);
    const plan = await buildSyncPlan(requestFor(sb, { force: true }));
    const confirm = vi.fn(() => Promise.resolve(false));
    const result = await executePlan(input(plan, { confirm }));
    expect(confirm).not.toHaveBeenCalled();
    expect(result.gate.kind).toBe("forced");
    expect(result.status).toBe("applied");
  });

  it("stops at a failing apply, applies no later plan, and writes no lock", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const userPath = fakePaths(sb.home, sb.repo).user;
    const adapters = new Map([["alpha", fakeAdapterFactory({ failApplyOn: userPath })]]);
    const plan = await buildSyncPlan(requestFor(sb, {}, adapters));
    const result = await executePlan(input(plan));

    expect(result.status).toBe("failed");
    expect(result.failure?.path).toBe(userPath);
    expect(result.failure?.harness).toBe("alpha");
    expect(result.locksWritten).toEqual([]);
    expect(await readdir(sb.repo)).not.toContain("AGENTS.md");
    expect((await readLock(createNodeFs(), lockPathsFor(sb).repo)).status).toBe("missing");
  });

  it("keeps the previous instructionsHash when an instructions apply falls back", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    await executePlan(input(await buildSyncPlan(requestFor(sb))));
    const before = await readLock(createNodeFs(), lockPathsFor(sb).repo);
    if (before.status !== "ok") throw new Error("expected a valid repo lock");
    const previous = before.lock.harnesses["alpha:project"];

    await writeFile(join(sb.repo, "AGENTS.md"), "# changed instructions\n");
    const instructionsPath = fakePaths(sb.home, sb.repo).instructions;
    const adapters = new Map([["alpha", fakeAdapterFactory({ fallbackOn: instructionsPath })]]);
    const plan = await buildSyncPlan(requestFor(sb, {}, adapters));
    const result = await executePlan(input(plan));

    expect(result.status).toBe("applied");
    expect(result.warnings.some((w) => w.includes("previous lock value kept"))).toBe(true);
    const after = await readLock(createNodeFs(), lockPathsFor(sb).repo);
    expect(after.status).toBe("ok");
    if (after.status === "ok") {
      expect(after.lock.harnesses["alpha:project"]?.instructionsHash).toBe(
        previous?.instructionsHash ?? null,
      );
    }
  });

  it("backs up a corrupt lock and replaces it when forced", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const paths = lockPathsFor(sb);
    await mkdir(join(sb.repo, ".yoke"), { recursive: true });
    await writeFile(paths.repo, "{");

    const plan = await buildSyncPlan(requestFor(sb, { force: true }));
    expect(plan.gate.some((reason) => reason.kind === "lock-corrupt")).toBe(true);
    const result = await executePlan(input(plan));

    expect(result.status).toBe("applied");
    expect(result.backupDir).toBeDefined();
    const backedUp = await snapshotTree(result.backupDir ?? sb.backupsRoot);
    expect(backedUp.some((line) => line.endsWith(" {"))).toBe(true);
    expect((await readLock(createNodeFs(), paths.repo)).status).toBe("ok");
    expect((await snapshotTree(sb.root)).some((line) => line.includes("yoke.tmp"))).toBe(false);
  });
});

describe("dry-run pipeline", () => {
  it("buildSyncPlan alone leaves the sandbox byte-for-byte unchanged", async () => {
    const sb = await newSandbox();
    await seedFiles(sb);
    const before = await snapshotTree(sb.root);
    const plan = await buildSyncPlan(requestFor(sb));
    expect(plan.plans.length).toBeGreaterThan(0);
    expect(await snapshotTree(sb.root)).toEqual(before);
  });
});
