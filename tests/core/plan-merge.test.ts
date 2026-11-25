import { describe, expect, it } from "vitest";
import type { FileChangePlan } from "../../src/adapters/base.js";
import { stateEntryFor } from "../../src/core/drift.js";
import {
  carryOverFallbacks,
  checkPathConflicts,
  collectWarnings,
  computeLockUpdate,
  type LockLoad,
  type LockUpdate,
  mergedLockView,
  PlanConflictError,
  type PlannedChange,
} from "../../src/core/plan.js";
import type { StateKey, YokeStateLock } from "../../src/core/schema.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const LOCK_PATH = "/repo/.yoke/yoke.lock";

function change(
  harness: string,
  path: string,
  opts: { readonly action?: FileChangePlan["action"]; readonly composable?: boolean } = {},
): PlannedChange {
  return {
    harness,
    plan: {
      scope: "project",
      path,
      action: opts.action ?? "patch-json",
      summary: "",
      warnings: [],
      expected: [],
      ...(opts.composable !== undefined ? { composable: opts.composable } : {}),
      apply: async () => ({ status: "written", backupPath: undefined }),
    },
  };
}

const LOCK: YokeStateLock = {
  version: 1,
  lastSyncedAt: "2026-11-24T10:00:00.000Z",
  harnesses: {
    "fake:project": { mcpHashes: { docs: HASH_A }, instructionsHash: HASH_B },
    "fake:user": { mcpHashes: {}, instructionsHash: null },
    "other:user": { mcpHashes: {}, instructionsHash: null },
  },
};

const OK: LockLoad = { status: "ok", path: LOCK_PATH, lock: LOCK };

describe("checkPathConflicts", () => {
  it("allows composable plans from one harness on one path", () => {
    expect(() =>
      checkPathConflicts([
        change("fake", "/r/a.json", { composable: true }),
        change("fake", "/r/a.json", { composable: true }),
      ]),
    ).not.toThrow();
  });

  it("rejects composable plans from two harnesses on one path", () => {
    expect(() =>
      checkPathConflicts([
        change("fake", "/r/a.json", { composable: true }),
        change("other", "/r/a.json", { composable: true }),
      ]),
    ).toThrow(PlanConflictError);
  });

  it("rejects a composable plan next to a non-composable one", () => {
    expect(() =>
      checkPathConflicts([
        change("fake", "/r/a.json", { composable: true }),
        change("fake", "/r/a.json", { composable: false }),
      ]),
    ).toThrow(PlanConflictError);
  });

  it("rejects two non-composable plans on one path", () => {
    expect(() =>
      checkPathConflicts([change("fake", "/r/a.md"), change("fake", "/r/a.md")]),
    ).toThrow(PlanConflictError);
  });

  it("ignores noop plans", () => {
    expect(() =>
      checkPathConflicts([
        change("fake", "/r/a.md", { action: "noop" }),
        change("other", "/r/a.md", { action: "noop" }),
        change("fake", "/r/a.md", { action: "create" }),
      ]),
    ).not.toThrow();
  });

  it("names the path in the error", () => {
    try {
      checkPathConflicts([change("fake", "/r/x.md"), change("other", "/r/x.md")]);
      expect.unreachable("expected a conflict");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(PlanConflictError);
      expect((err as PlanConflictError).path).toBe("/r/x.md");
    }
  });
});

describe("collectWarnings", () => {
  it("flattens in order and drops duplicates, keeping the first", () => {
    expect(collectWarnings([["a", "b"], ["b", "c"], ["a"]])).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list for no groups", () => {
    expect(collectWarnings([])).toEqual([]);
    expect(collectWarnings([[]])).toEqual([]);
  });
});

describe("mergedLockView", () => {
  it("is undefined when no load is ok", () => {
    expect(
      mergedLockView([
        { status: "missing", path: LOCK_PATH },
        { status: "corrupt", path: LOCK_PATH, reason: "bad" },
      ]),
    ).toBeUndefined();
    expect(mergedLockView([])).toBeUndefined();
  });

  it("merges ok loads and takes lastSyncedAt from the first ok load", () => {
    const later: YokeStateLock = {
      version: 1,
      lastSyncedAt: "2026-12-01T00:00:00.000Z",
      harnesses: { "fake:local": { mcpHashes: {}, instructionsHash: null } },
    };
    const view = mergedLockView([
      { status: "missing", path: LOCK_PATH },
      OK,
      { status: "ok", path: "/u/yoke.lock", lock: later },
    ]);
    expect(view?.lastSyncedAt).toBe(LOCK.lastSyncedAt);
    expect(Object.keys(view?.harnesses ?? {}).sort()).toEqual([
      "fake:local",
      "fake:project",
      "fake:user",
      "other:user",
    ]);
  });
});

describe("computeLockUpdate", () => {
  const desiredMcps = new Map<StateKey, { mcps: Record<string, never> }>([
    ["fake:project", { mcps: {} }],
  ]);

  it("replaces processed keys, keeps unprocessed keys, and deletes processed keys with no desired state", () => {
    const update = computeLockUpdate({
      file: "repo",
      path: LOCK_PATH,
      previous: OK,
      processed: ["fake:project", "fake:local"],
      desired: desiredMcps,
    });
    expect(update.entries["fake:project"]).toEqual(stateEntryFor({ mcps: {} }));
    expect(update.entries["fake:local"]).toBeUndefined();
    expect(update.entries["fake:user"]).toEqual(LOCK.harnesses["fake:user"]);
    expect(update.entries["other:user"]).toEqual(LOCK.harnesses["other:user"]);
    expect(update.changed).toBe(true);
  });

  it("keeps a foreign user key in a repo lock and sorts the keys", () => {
    const update = computeLockUpdate({
      file: "repo",
      path: LOCK_PATH,
      previous: OK,
      processed: ["fake:project"],
      desired: desiredMcps,
    });
    expect(Object.keys(update.entries)).toEqual(["fake:project", "fake:user", "other:user"]);
  });

  it("reports changed false when the new entries equal the previous ones", () => {
    const update = computeLockUpdate({
      file: "repo",
      path: LOCK_PATH,
      previous: OK,
      processed: [],
      desired: new Map(),
    });
    expect(update.changed).toBe(false);
  });

  it("reports changed for corrupt previous files", () => {
    const update = computeLockUpdate({
      file: "repo",
      path: LOCK_PATH,
      previous: { status: "corrupt", path: LOCK_PATH, reason: "bad" },
      processed: [],
      desired: new Map(),
    });
    expect(update.changed).toBe(true);
  });

  it("reports changed for a missing file only when entries exist", () => {
    const empty = computeLockUpdate({
      file: "user",
      path: "/u/yoke.lock",
      previous: { status: "missing", path: "/u/yoke.lock" },
      processed: [],
      desired: new Map(),
    });
    expect(empty.changed).toBe(false);
    const filled = computeLockUpdate({
      file: "user",
      path: "/u/yoke.lock",
      previous: { status: "missing", path: "/u/yoke.lock" },
      processed: ["fake:user"],
      desired: new Map<StateKey, { mcps: Record<string, never> }>([["fake:user", { mcps: {} }]]),
    });
    expect(filled.changed).toBe(true);
  });
});

describe("carryOverFallbacks", () => {
  const update: LockUpdate = {
    file: "repo",
    path: LOCK_PATH,
    previous: OK,
    entries: {
      "fake:project": { mcpHashes: {}, instructionsHash: HASH_A },
      "fake:user": { mcpHashes: {}, instructionsHash: null },
    },
    changed: true,
  };

  it("restores the previous instructionsHash for a fallen instructions target", () => {
    const next = carryOverFallbacks(update, [
      {
        key: "fake:project",
        target: {
          kind: "instructions",
          scope: "project",
          instructions: { kind: "file", path: "/r/AGENTS.md", content: "x" },
        },
      },
    ]);
    expect(next.entries["fake:project"]?.instructionsHash).toBe(HASH_B);
    expect(next.entries["fake:user"]).toEqual(update.entries["fake:user"]);
  });

  it("uses null when there is no previous entry", () => {
    const fresh: LockUpdate = { ...update, previous: { status: "missing", path: LOCK_PATH } };
    const next = carryOverFallbacks(fresh, [
      {
        key: "fake:project",
        target: {
          kind: "instructions",
          scope: "project",
          instructions: { kind: "file", path: "/r/AGENTS.md", content: "x" },
        },
      },
    ]);
    expect(next.entries["fake:project"]?.instructionsHash).toBeNull();
  });

  it("leaves other target kinds unchanged", () => {
    const next = carryOverFallbacks(update, [
      { key: "fake:project", target: { kind: "mcps", scope: "project", mcps: {} } },
    ]);
    expect(next.entries).toEqual(update.entries);
  });

  it("recomputes changed after the carry-over", () => {
    const next = carryOverFallbacks(update, [
      {
        key: "fake:project",
        target: {
          kind: "instructions",
          scope: "project",
          instructions: { kind: "file", path: "/r/AGENTS.md", content: "x" },
        },
      },
    ]);
    expect(next.changed).toBe(true);
    expect(next.entries["fake:project"]).toEqual({
      mcpHashes: {},
      instructionsHash: HASH_B,
    });
    const unchangedBase: LockUpdate = {
      ...update,
      entries: {
        ...LOCK.harnesses,
        "fake:project": { mcpHashes: { docs: HASH_A }, instructionsHash: HASH_A },
      },
      changed: true,
    };
    const restored = carryOverFallbacks(unchangedBase, [
      {
        key: "fake:project",
        target: {
          kind: "instructions",
          scope: "project",
          instructions: { kind: "file", path: "/r/AGENTS.md", content: "x" },
        },
      },
    ]);
    expect(restored.changed).toBe(false);
  });
});
