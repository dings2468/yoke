import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFs } from "../../src/core/fs-safe.js";
import {
  computeLockUpdate,
  LOCK_DIR,
  LOCK_FILE,
  lockFileFor,
  lockPaths,
  readLock,
  SyncRequestError,
  serializeLock,
} from "../../src/core/plan.js";
import type { YokeStateLock } from "../../src/core/schema.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const LOCK: YokeStateLock = {
  version: 1,
  lastSyncedAt: "2026-11-24T10:00:00.000Z",
  harnesses: {
    "fake:project": { mcpHashes: { docs: HASH_A }, instructionsHash: HASH_B },
    "fake:user": { mcpHashes: {}, instructionsHash: null },
  },
};

describe("plan lock io", () => {
  let dir: string;
  const fs = createNodeFs();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yoke-plan-lock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a missing file", async () => {
    const path = join(dir, "absent.lock");
    expect(await readLock(fs, path)).toEqual({ status: "missing", path });
  });

  it("reads a valid lock", async () => {
    const path = join(dir, LOCK_FILE);
    await writeFile(path, serializeLock(LOCK), "utf8");
    const loaded = await readLock(fs, path);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.lock).toEqual(LOCK);
  });

  it("reports invalid JSON as corrupt", async () => {
    const path = join(dir, LOCK_FILE);
    await writeFile(path, "{", "utf8");
    const loaded = await readLock(fs, path);
    expect(loaded.status).toBe("corrupt");
    if (loaded.status === "corrupt") expect(loaded.reason.startsWith("invalid JSON")).toBe(true);
  });

  it("reports an unsupported version as corrupt", async () => {
    const path = join(dir, LOCK_FILE);
    await writeFile(path, JSON.stringify({ ...LOCK, version: 2 }), "utf8");
    const loaded = await readLock(fs, path);
    expect(loaded.status).toBe("corrupt");
    if (loaded.status === "corrupt") expect(loaded.reason).toContain("version");
  });

  it("rejects when a directory sits at the lock path", async () => {
    const path = join(dir, LOCK_FILE);
    await mkdir(path);
    await expect(readLock(fs, path)).rejects.toThrow();
  });

  it("serializes with sorted harness keys and a trailing newline", async () => {
    const projectEntry = { mcpHashes: { docs: HASH_A }, instructionsHash: HASH_B };
    const userEntry = { mcpHashes: {}, instructionsHash: null };
    const reversed: YokeStateLock = {
      version: 1,
      lastSyncedAt: LOCK.lastSyncedAt,
      harnesses: { "fake:user": userEntry, "fake:project": projectEntry },
    };
    const text = serializeLock(reversed);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"fake:project"')).toBeLessThan(text.indexOf('"fake:user"'));

    const path = join(dir, LOCK_FILE);
    await writeFile(path, text, "utf8");
    const loaded = await readLock(fs, path);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.lock).toEqual(LOCK);
  });

  it("throws when serializing an invalid lock", () => {
    const bad: YokeStateLock = {
      ...LOCK,
      harnesses: { "fake:project": { mcpHashes: { docs: "XYZ" }, instructionsHash: null } },
    };
    expect(() => serializeLock(bad)).toThrow();
  });

  it("requires absolute paths for lockPaths", () => {
    expect(() => lockPaths({ repoPath: "relative/repo", userConfigDir: "/abs/config" })).toThrow(
      SyncRequestError,
    );
    expect(() => lockPaths({ repoPath: "/abs/repo", userConfigDir: "relative/config" })).toThrow(
      SyncRequestError,
    );
  });

  it("derives repo and user lock paths", () => {
    const paths = lockPaths({ repoPath: "/abs/repo", userConfigDir: "/abs/config" });
    expect(paths.repo).toBe(join("/abs/repo", LOCK_DIR, "yoke.lock"));
    expect(paths.user).toBe(join("/abs/config", "yoke.lock"));
  });

  it("maps each scope to its lock file", () => {
    expect(lockFileFor("user")).toBe("user");
    expect(lockFileFor("project")).toBe("repo");
    expect(lockFileFor("local")).toBe("repo");
  });

  it("writes a null instructionsHash when the desired instructions are absent", () => {
    const update = computeLockUpdate({
      file: "repo",
      path: join(dir, LOCK_FILE),
      previous: { status: "ok", path: join(dir, LOCK_FILE), lock: LOCK },
      processed: ["fake:project"],
      desired: new Map([["fake:project", { mcps: {}, instructions: null }]]),
    });
    expect(update.entries["fake:project"]?.instructionsHash).toBeNull();
    expect(update.changed).toBe(true);
    const text = serializeLock({
      version: 1,
      lastSyncedAt: LOCK.lastSyncedAt,
      harnesses: update.entries,
    });
    expect(text).toContain('"instructionsHash": null');
  });
});
