import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupRelativePath,
  createBackupSession,
  createNodeFs,
  FsSafeError,
  formatBackupTimestamp,
  inspectSymlink,
  relativeLinkTarget,
  safeSymlink,
} from "../../src/core/fs-safe.js";

const FIXED_NOW = new Date("2026-11-24T10:00:00.123Z");
const FIXED_NAME = "2026-11-24T10-00-00-123Z";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yoke-f2-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("formatBackupTimestamp and backupRelativePath", () => {
  it("replaces colons and dots in the ISO timestamp", () => {
    expect(formatBackupTimestamp(FIXED_NOW)).toBe(FIXED_NAME);
  });

  it("mirrors POSIX and Windows absolute paths", () => {
    expect(backupRelativePath("/home/u/.claude.json")).toBe("home/u/.claude.json");
    expect(backupRelativePath("C:\\a\\b")).toBe("C/a/b");
  });

  it("rejects relative paths and parent segments", () => {
    expect(() => backupRelativePath("relative/file")).toThrow(FsSafeError);
    expect(() => backupRelativePath("/a/../b")).toThrow(FsSafeError);
  });
});

describe("createBackupSession", () => {
  it("copies content under a timestamped directory that mirrors the source path", async () => {
    const fs = createNodeFs();
    const source = join(dir, "home", "CLAUDE.md");
    await mkdir(join(dir, "home"));
    await writeFile(source, "old instructions\n");
    const root = join(dir, "backups");

    const session = createBackupSession({ fs, root, now: () => FIXED_NOW });
    expect(session.dir()).toBeUndefined();

    const backupPath = await session.backup(source);

    expect(backupPath).toBe(join(root, FIXED_NAME, dir.slice(1), "home", "CLAUDE.md"));
    expect(await readFile(backupPath as string, "utf8")).toBe("old instructions\n");
    expect(session.dir()).toBe(join(root, FIXED_NAME));
  });

  it.skipIf(process.platform === "win32")(
    "creates the session directory with mode 0700",
    async () => {
      const fs = createNodeFs();
      const source = join(dir, "config.json");
      await writeFile(source, "{}");
      const root = join(dir, "backups");

      const session = createBackupSession({ fs, root, now: () => FIXED_NOW });
      await session.backup(source);

      const st = await stat(join(root, FIXED_NAME));
      expect(st.mode & 0o777).toBe(0o700);
    },
  );

  it("gets a -1 suffix when a second session uses the same clock", async () => {
    const fs = createNodeFs();
    const source = join(dir, "config.json");
    await writeFile(source, "{}");
    const root = join(dir, "backups");

    const first = createBackupSession({ fs, root, now: () => FIXED_NOW });
    const second = createBackupSession({ fs, root, now: () => FIXED_NOW });
    await first.backup(source);
    await second.backup(source);

    expect((await readdir(root)).sort()).toEqual([FIXED_NAME, `${FIXED_NAME}-1`]);
    expect(second.dir()).toBe(join(root, `${FIXED_NAME}-1`));
  });

  it("returns undefined for a missing source and creates nothing", async () => {
    const fs = createNodeFs();
    const root = join(dir, "backups");

    const session = createBackupSession({ fs, root, now: () => FIXED_NOW });

    expect(await session.backup(join(dir, "absent.json"))).toBeUndefined();
    expect(session.dir()).toBeUndefined();
    await expect(stat(root)).rejects.toThrow();
  });

  it("returns the first backup path for a repeated source without copying again", async () => {
    const fs = createNodeFs();
    const source = join(dir, "config.json");
    await writeFile(source, "first");
    const root = join(dir, "backups");

    const session = createBackupSession({ fs, root, now: () => FIXED_NOW });
    const first = await session.backup(source);
    await writeFile(source, "second");
    const again = await session.backup(source);

    expect(again).toBe(first);
    expect(await readFile(first as string, "utf8")).toBe("first");
  });

  it("keeps two files with the same basename in different directories", async () => {
    const fs = createNodeFs();
    const a = join(dir, "a", "CLAUDE.md");
    const b = join(dir, "b", "CLAUDE.md");
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b"));
    await writeFile(a, "from a");
    await writeFile(b, "from b");

    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });
    const pathA = await session.backup(a);
    const pathB = await session.backup(b);

    expect(pathA).not.toBe(pathB);
    expect(await readFile(pathA as string, "utf8")).toBe("from a");
    expect(await readFile(pathB as string, "utf8")).toBe("from b");
  });

  it("backs up a link as a link when kind is link", async () => {
    const fs = createNodeFs();
    const target = join(dir, "real.md");
    const link = join(dir, "AGENTS.md");
    await writeFile(target, "content");
    await fs.symlink("real.md", link);

    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });
    const backupPath = await session.backup(link, { kind: "link" });

    expect(await readlink(backupPath as string)).toBe("real.md");
  });

  it("throws FsSafeError when the source is a directory", async () => {
    const fs = createNodeFs();
    const sub = join(dir, "subdir");
    await mkdir(sub);

    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });

    await expect(session.backup(sub)).rejects.toThrow(FsSafeError);
  });
});

describe("relativeLinkTarget and inspectSymlink", () => {
  it("computes a relative target from the link directory", () => {
    expect(relativeLinkTarget("/a/b/link", "/a/c/target")).toBe(join("..", "c", "target"));
  });

  it("throws on relative input", () => {
    expect(() => relativeLinkTarget("link", "/a/target")).toThrow(FsSafeError);
    expect(() => relativeLinkTarget("/a/link", "target")).toThrow(FsSafeError);
  });

  it("reports each inspection state", async () => {
    const fs = createNodeFs();
    const target = join(dir, "target.md");
    await writeFile(target, "t");
    const subdir = join(dir, "subdir");
    await mkdir(subdir);

    expect(await inspectSymlink(fs, join(dir, "none.md"), target)).toEqual({ state: "missing" });
    expect(await inspectSymlink(fs, target, target)).toEqual({ state: "file" });
    expect(await inspectSymlink(fs, subdir, target)).toEqual({ state: "other" });

    const same = join(dir, "same.md");
    await fs.symlink(relativeLinkTarget(same, target), same);
    expect(await inspectSymlink(fs, same, target)).toEqual({ state: "same-link" });

    const other = join(dir, "other.md");
    await fs.symlink("elsewhere.md", other);
    expect(await inspectSymlink(fs, other, target)).toEqual({
      state: "other-link",
      target: "elsewhere.md",
    });
  });
});

describe("safeSymlink", () => {
  it("creates a relative link when nothing exists", async () => {
    const fs = createNodeFs();
    const target = join(dir, "store", "AGENTS.md");
    await mkdir(join(dir, "store"));
    await writeFile(target, "source");
    const link = join(dir, "project", "AGENTS.md");
    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });

    const result = await safeSymlink(fs, link, target, { backup: session });

    expect(result).toEqual({
      kind: "linked",
      target: join("..", "store", "AGENTS.md"),
      backupPath: undefined,
    });
    expect(await readlink(link)).toBe(join("..", "store", "AGENTS.md"));
    expect(await readFile(link, "utf8")).toBe("source");
  });

  it("returns unchanged for an existing correct link without a backup", async () => {
    const fs = createNodeFs();
    const target = join(dir, "store.md");
    await writeFile(target, "source");
    const link = join(dir, "link.md");
    await fs.symlink(relativeLinkTarget(link, target), link);
    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });

    const result = await safeSymlink(fs, link, target, { backup: session });

    expect(result).toEqual({ kind: "unchanged", target: "store.md", backupPath: undefined });
    expect(session.dir()).toBeUndefined();
  });

  it("replaces a regular file and backs up its old content", async () => {
    const fs = createNodeFs();
    const target = join(dir, "store.md");
    await writeFile(target, "new source");
    const link = join(dir, "link.md");
    await writeFile(link, "old content");
    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });

    const result = await safeSymlink(fs, link, target, { backup: session });

    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("expected linked");
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath as string, "utf8")).toBe("old content");
    expect(await readlink(link)).toBe("store.md");
    expect(await readFile(link, "utf8")).toBe("new source");
    expect((await readdir(dir)).filter((n) => n.endsWith(".yoke.tmp"))).toEqual([]);
  });

  it("returns blocked for a directory at the link path", async () => {
    const fs = createNodeFs();
    const target = join(dir, "store.md");
    await writeFile(target, "source");
    const link = join(dir, "not-a-file");
    await mkdir(link);
    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });

    const result = await safeSymlink(fs, link, target, { backup: session });

    expect(result.kind).toBe("fallback");
    if (result.kind !== "fallback") throw new Error("expected fallback");
    expect(result.reason).toBe("blocked");
  });

  it("falls back as unsupported and keeps the original file when symlink is refused", async () => {
    const fs = createNodeFs();
    const target = join(dir, "store.md");
    await writeFile(target, "source");
    const link = join(dir, "link.md");
    await writeFile(link, "original");
    vi.spyOn(fs, "symlink").mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EPERM" }),
    );
    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });

    const result = await safeSymlink(fs, link, target, { backup: session });

    expect(result.kind).toBe("fallback");
    if (result.kind !== "fallback") throw new Error("expected fallback");
    expect(result.reason).toBe("unsupported");
    expect(await readFile(link, "utf8")).toBe("original");
    expect((await readdir(dir)).filter((n) => n.endsWith(".yoke.tmp"))).toEqual([]);
  });
});
