/**
 * tests/plan-adapters.test.ts: sync planning and execution with the real claude and agy adapters.
 *
 * Every path lives in a temp sandbox (fake home, repo, and XDG config). The real ~/.claude.json and ~/.gemini are never
 * read or written, and exec is a scripted fake that returns nothing.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgyPaths, agyPaths, createAgyAdapter } from "../src/adapters/agy.js";
import { claudePaths, createClaudeAdapter } from "../src/adapters/claude.js";
import { hashInstructions } from "../src/core/drift.js";
import { createNodeFs } from "../src/core/fs-safe.js";
import { GENERATED_HEADER } from "../src/core/instructions.js";
import {
  type AdapterFactory,
  buildSyncPlan,
  checkPathConflicts,
  executePlan,
  lockPaths,
  type PlanRequest,
  readLock,
  type SyncPlan,
  scopesForFlags,
  serializeLock,
} from "../src/core/plan.js";
import { stateKey } from "../src/core/schema.js";
import {
  cleanupSandbox,
  copyFixture,
  fakeExec,
  lockFrom,
  type Sandbox,
  setupAdapterSandbox,
} from "./adapters/helpers.js";
import { guardedFs, snapshotTree } from "./core/plan-helpers.js";

const now = (): Date => new Date("2026-11-24T10:00:00.000Z");
const adapters: ReadonlyMap<string, AdapterFactory> = new Map<string, AdapterFactory>([
  ["claude", createClaudeAdapter],
  ["agy", createAgyAdapter],
]);

const sandboxes: Sandbox[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sb) => cleanupSandbox(sb)));
});

async function newSandbox(): Promise<Sandbox> {
  const sb = await setupAdapterSandbox();
  sandboxes.push(sb);
  return sb;
}

/** Scope files: user (with both harnesses), project and local from the fixtures, plus the plain AGENTS.md. */
async function seed(sb: Sandbox): Promise<void> {
  const userYaml = join(sb.userConfigDir, "yoke.yaml");
  await copyFixture(sb, "config/user.yaml", userYaml);
  const userText = await readFile(userYaml, "utf8");
  await writeFile(userYaml, `${userText}harnesses: [claude, agy]\n`, "utf8");
  await copyFixture(sb, "config/project.yaml", join(sb.repo, "yoke.yaml"));
  await copyFixture(sb, "config/local.yaml", join(sb.repo, "yoke.local.yaml"));
  await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.repo, "AGENTS.md"));
}

function requestFor(sb: Sandbox, over: Partial<PlanRequest> = {}): PlanRequest {
  return {
    repoPath: sb.repo,
    scopes: scopesForFlags({ global: false, all: true }),
    force: false,
    global: false,
    homeDir: sb.home,
    env: { XDG_CONFIG_HOME: join(sb.root, "xdg") },
    readFs: createNodeFs(),
    exec: fakeExec(new Map()),
    adapters,
    ...over,
  };
}

function agyFiles(sb: Sandbox): AgyPaths {
  return agyPaths(sb.home, sb.repo);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The (scope, path, action, summary) rows of a plan, with the sandbox root replaced so two sandboxes compare equal. */
function rowsOf(plan: SyncPlan, root: string): string[] {
  return plan.plans.map((p) =>
    JSON.stringify([p.scope, p.path, p.action, p.summary].map((v) => v.replaceAll(root, "<root>"))),
  );
}

describe("sync planning with the real adapters", () => {
  it("a dry run over a guarded fs writes nothing and leaves the tree unchanged", async () => {
    const sb = await newSandbox();
    await seed(sb);
    const before = await snapshotTree(sb.root);
    const guard = guardedFs();

    const plan = await buildSyncPlan(requestFor(sb, { readFs: guard.fs }));

    expect(guard.writes).toEqual([]);
    expect(await snapshotTree(sb.root)).toEqual(before);
    expect(plan.plans.length).toBeGreaterThan(0);
    expect(plan.blocked).toBe(false);
  });

  it("gives equal rows for two identical sandboxes once the root is replaced", async () => {
    const first = await newSandbox();
    const second = await newSandbox();
    await seed(first);
    await seed(second);

    const a = await buildSyncPlan(requestFor(first));
    const b = await buildSyncPlan(requestFor(second));

    expect(rowsOf(a, first.root)).toEqual(rowsOf(b, second.root));
  });

  it("applies a fresh sync, writes the expected files, and records each lock with its own keys", async () => {
    const sb = await newSandbox();
    await seed(sb);
    const plan = await buildSyncPlan(requestFor(sb));
    expect(plan.blocked).toBe(false);
    expect(plan.gate).toEqual([]);

    const userConfig = claudePaths(sb.home, { XDG_CONFIG_HOME: join(sb.root, "xdg") }, sb.repo);
    const claudeUserPlans = plan.plans.filter((p) => p.path === userConfig.userConfig);
    expect(claudeUserPlans.length).toBeGreaterThanOrEqual(2);
    expect(claudeUserPlans.every((p) => p.composable === true)).toBe(true);
    expect(() => checkPathConflicts(plan.changes)).not.toThrow();

    const result = await executePlan({ plan, fs: createNodeFs(), now });
    expect(result.status).toBe("applied");

    const files = agyFiles(sb);
    const expectedFiles = [userConfig.userConfig, userConfig.projectMcp, files.mcpConfig];
    for (const path of expectedFiles) {
      expect(await readFile(path, "utf8")).not.toBe("");
    }
    // Project instructions are native: AGENTS.md is the only shared file, so no CLAUDE.md or GEMINI.md is created.
    expect(await pathExists(userConfig.projectInstructions)).toBe(false);
    expect(await pathExists(join(sb.repo, "GEMINI.md"))).toBe(false);
    // A composable path shared by several plans is merged on disk, so only unshared paths match their planned text.
    for (const change of plan.plans) {
      if (change.action === "noop" || change.after === undefined) continue;
      if (plan.plans.filter((p) => p.path === change.path).length > 1) continue;
      expect(await readFile(change.path, "utf8")).toBe(change.after);
    }

    const paths = lockPaths({ repoPath: sb.repo, userConfigDir: sb.userConfigDir });
    expect([...result.locksWritten].sort()).toEqual([paths.repo, paths.user].sort());
    const repoLock = await readLock(createNodeFs(), paths.repo);
    const userLock = await readLock(createNodeFs(), paths.user);
    expect(repoLock.status).toBe("ok");
    expect(userLock.status).toBe("ok");
    if (repoLock.status !== "ok" || userLock.status !== "ok") return;

    const repoKeys = Object.keys(repoLock.lock.harnesses);
    const userKeys = Object.keys(userLock.lock.harnesses);
    expect(repoKeys.length).toBeGreaterThan(0);
    expect(repoKeys.every((key) => /:(project|local)$/.test(key))).toBe(true);
    expect(userKeys.length).toBeGreaterThan(0);
    expect(userKeys.every((key) => key.endsWith(":user"))).toBe(true);
    expect(userKeys).toContain(stateKey("claude", "user"));
  });

  it("plans only noop on a second run, reports no drift, and writes nothing when executed", async () => {
    const sb = await newSandbox();
    await seed(sb);
    const first = await buildSyncPlan(requestFor(sb));
    await executePlan({ plan: first, fs: createNodeFs(), now });

    const second = await buildSyncPlan(requestFor(sb));
    expect(second.plans.every((p) => p.action === "noop")).toBe(true);
    expect(second.drift.hasDrift).toBe(false);
    expect(second.blocked).toBe(false);
    expect(second.locks.every((lock) => !lock.changed)).toBe(true);

    const before = await snapshotTree(sb.root);
    const result = await executePlan({ plan: second, fs: createNodeFs(), now });
    expect(result.status).toBe("applied");
    expect(result.locksWritten).toEqual([]);
    expect(await snapshotTree(sb.root)).toEqual(before);
  });

  it("accepts a user-written repo CLAUDE.md that starts with @AGENTS.md: no drift block and no write", async () => {
    const sb = await newSandbox();
    await seed(sb);
    const handWritten = join(sb.repo, "CLAUDE.md");
    const original = "@AGENTS.md\n\n# Claude notes\n";
    await writeFile(handWritten, original, "utf8");
    const plainScopes = scopesForFlags({ global: false, all: false });

    const plan = await buildSyncPlan(requestFor(sb, { scopes: plainScopes }));
    expect(plan.blocked).toBe(false);
    expect(plan.gate).toEqual([]);
    expect(plan.plans.filter((p) => p.path === handWritten).every((p) => p.action === "noop")).toBe(
      true,
    );

    await executePlan({ plan, fs: createNodeFs(), now });
    expect(await readFile(handWritten, "utf8")).toBe(original);
  });

  it("warns on a user-written repo CLAUDE.md without the @AGENTS.md first line, and writes nothing", async () => {
    const sb = await newSandbox();
    await seed(sb);
    const handWritten = join(sb.repo, "CLAUDE.md");
    await copyFixture(sb, "claude/repo/CLAUDE.md", handWritten);
    const original = await readFile(handWritten, "utf8");
    const plainScopes = scopesForFlags({ global: false, all: false });

    const plan = await buildSyncPlan(requestFor(sb, { scopes: plainScopes }));
    expect(plan.blocked).toBe(false);
    expect(plan.gate.some((g) => g.kind === "drift")).toBe(false);
    const rows = plan.plans.filter((p) => p.path === handWritten);
    expect(rows.every((p) => p.action === "noop")).toBe(true);
    expect(rows.some((p) => p.warnings.some((w) => w.includes("@AGENTS.md")))).toBe(true);

    await executePlan({ plan, fs: createNodeFs(), now });
    expect(await readFile(handWritten, "utf8")).toBe(original);
  });

  it("with --global plans only user-scope paths and never touches the repo", async () => {
    const sb = await newSandbox();
    const userYaml = join(sb.userConfigDir, "yoke.yaml");
    await copyFixture(sb, "config/user.yaml", userYaml);
    await writeFile(
      userYaml,
      `${await readFile(userYaml, "utf8")}harnesses: [claude, agy]\n`,
      "utf8",
    );
    const globalScopes = scopesForFlags({ global: true, all: false });

    const plan = await buildSyncPlan(requestFor(sb, { global: true, scopes: globalScopes }));
    expect(plan.plans.length).toBeGreaterThan(0);
    expect(plan.plans.every((p) => p.scope === "user")).toBe(true);
    expect(plan.plans.every((p) => !p.path.startsWith(sb.repo))).toBe(true);

    const result = await executePlan({ plan, fs: createNodeFs(), now });
    expect(result.status).toBe("applied");
    expect(await readdir(sb.repo)).toEqual([]);
    expect(await readFile(claudePaths(sb.home, {}, sb.repo).userConfig, "utf8")).not.toBe("");
  });
});

describe("gated removal of an edited generated CLAUDE.md", () => {
  /** Every file under `dir`, as [relative path, content] pairs. */
  async function filesUnder(dir: string): Promise<[string, string][]> {
    const names = await readdir(dir, { recursive: true });
    const out: [string, string][] = [];
    for (const name of names) {
      const full = join(dir, name);
      const info = await stat(full);
      if (info.isFile()) out.push([name, await readFile(full, "utf8")]);
    }
    return out;
  }

  it("blocks the sync with a drift gate, and with force removes the file and writes a backup", async () => {
    const sb = await newSandbox();
    await seed(sb);
    const claudeMd = join(sb.repo, "CLAUDE.md");
    const original = `${GENERATED_HEADER}\n\n# Generated\n`;
    const edited = `${original}Hand edit\n`;
    const scopes = scopesForFlags({ global: false, all: false });

    // The repo lock records the hash of the file as yoke wrote it; the user then edits the file.
    await writeFile(claudeMd, original, "utf8");
    const paths = lockPaths({ repoPath: sb.repo, userConfigDir: sb.userConfigDir });
    await mkdir(dirname(paths.repo), { recursive: true });
    const lock = lockFrom({
      [stateKey("claude", "project")]: {
        mcpHashes: {},
        instructionsHash: hashInstructions({ kind: "file", path: claudeMd, content: original }),
      },
    });
    await writeFile(paths.repo, serializeLock(lock), "utf8");
    await writeFile(claudeMd, edited, "utf8");

    const gated = await buildSyncPlan(requestFor(sb, { scopes }));
    expect(gated.blocked).toBe(true);
    expect(gated.gate.some((g) => g.kind === "drift")).toBe(true);
    expect(gated.drift.hasDrift).toBe(true);

    const refused = await executePlan({ plan: gated, fs: createNodeFs(), now });
    expect(refused.status).toBe("refused");
    expect(await readFile(claudeMd, "utf8")).toBe(edited);

    const forced = await buildSyncPlan(requestFor(sb, { scopes, force: true }));
    expect(forced.blocked).toBe(false);
    expect(forced.gate.some((g) => g.kind === "drift")).toBe(true);

    const result = await executePlan({ plan: forced, fs: createNodeFs(), now });
    expect(result.status).toBe("applied");
    expect(await pathExists(claudeMd)).toBe(false);
    if (result.backupDir === undefined) throw new Error("forced removal wrote no backup directory");
    const backedUp = await filesUnder(result.backupDir);
    expect(backedUp.some(([, content]) => content === edited)).toBe(true);
  });
});
