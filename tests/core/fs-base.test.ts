import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atomicWrite,
  backupRelativePath,
  createBackupSession,
  createNodeFs,
  FsSafeError,
  isNotFound,
  READ_METHODS,
  readTextIfExists,
  toReadFs,
} from "../../src/core/fs-safe.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yoke-fsbase-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("creates a new file and leaves no temp file behind", async () => {
    const fs = createNodeFs();
    const target = join(dir, "config.json");

    const result = await atomicWrite(fs, target, '{"a":1}\n');

    expect(result.writtenPath).toBe(target);
    expect(await readFile(target, "utf8")).toBe('{"a":1}\n');
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".yoke.tmp"));
    expect(leftovers).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("overwrite keeps the existing 0600 mode", async () => {
    const fs = createNodeFs();
    const target = join(dir, "secret.json");
    await fs.writeFile(target, "old", { flag: "w", mode: 0o600 });
    await fs.chmod(target, 0o600);

    await atomicWrite(fs, target, "new");

    expect(await readFile(target, "utf8")).toBe("new");
    expect((await fs.stat(target)).mode).toBe(0o600);
  });

  it("writes through a symlink, keeps the link, and updates the target", async () => {
    const fs = createNodeFs();
    const real = join(dir, "real.md");
    const link = join(dir, "link.md");
    await writeFile(real, "old");
    await symlink(real, link);

    const result = await atomicWrite(fs, link, "new");

    expect(result.writtenPath).toBe(real);
    expect((await fs.lstat(link)).isSymbolicLink).toBe(true);
    expect(await readFile(real, "utf8")).toBe("new");
  });

  it("throws FsSafeError for a dangling symlink and writes nothing", async () => {
    const fs = createNodeFs();
    const link = join(dir, "dangling.md");
    await symlink(join(dir, "missing.md"), link);

    await expect(atomicWrite(fs, link, "new")).rejects.toBeInstanceOf(FsSafeError);
    expect((await readdir(dir)).sort()).toEqual(["dangling.md"]);
  });

  it("keeps the original intact and removes the temp file when rename fails", async () => {
    const fs = createNodeFs();
    const target = join(dir, "keep.json");
    await writeFile(target, "original");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename boom"));

    await expect(atomicWrite(fs, target, "replacement")).rejects.toThrow("rename boom");

    expect(await readFile(target, "utf8")).toBe("original");
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".yoke.tmp"));
    expect(leftovers).toEqual([]);
  });

  it("calls writeFile, then chmod, then rename, in that order", async () => {
    const fs = createNodeFs();
    const target = join(dir, "ordered.json");
    const writeSpy = vi.spyOn(fs, "writeFile");
    const chmodSpy = vi.spyOn(fs, "chmod");
    const renameSpy = vi.spyOn(fs, "rename");

    await atomicWrite(fs, target, "x", { mode: 0o644 });

    const writeOrder = writeSpy.mock.invocationCallOrder[0] ?? Number.NaN;
    const chmodOrder = chmodSpy.mock.invocationCallOrder[0] ?? Number.NaN;
    const renameOrder = renameSpy.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(writeOrder).toBeLessThan(chmodOrder);
    expect(chmodOrder).toBeLessThan(renameOrder);
  });

  it("replaces a symlink with a regular file when followSymlinks is false", async () => {
    const fs = createNodeFs();
    const real = join(dir, "store.md");
    const link = join(dir, "AGENTS.md");
    await writeFile(real, "store content");
    await symlink("store.md", link);
    const backup = createBackupSession({
      fs,
      root: join(dir, "backups"),
      now: () => new Date("2026-11-24T10:00:00.123Z"),
    });

    const result = await atomicWrite(fs, link, "new content", { followSymlinks: false, backup });

    expect(result.writtenPath).toBe(link);
    const st = await fs.lstat(link);
    expect(st.isSymbolicLink).toBe(false);
    expect(st.isFile).toBe(true);
    expect(await readFile(link, "utf8")).toBe("new content");
    expect(await readFile(real, "utf8")).toBe("store content");
    expect((await readdir(dir)).filter((name) => name.endsWith(".yoke.tmp"))).toEqual([]);
    const backedUp = join(backup.dir() as string, backupRelativePath(link));
    expect(await readFile(backedUp, "utf8")).toBe("store.md\n");
  });

  it("does not delete a foreign file that already sits at the temp path", async () => {
    const fs = createNodeFs();
    const target = join(dir, "keep.json");
    await writeFile(target, "original");
    const foreignTmp = join(dir, "keep.json.fixed.yoke.tmp");
    await writeFile(foreignTmp, "foreign");

    await expect(
      atomicWrite(fs, target, "new", { tmpSuffix: () => "fixed" }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(foreignTmp, "utf8")).toBe("foreign");
    expect(await readFile(target, "utf8")).toBe("original");
  });
});

describe("toReadFs", () => {
  it("exposes exactly the read methods", () => {
    const readOnly = toReadFs(createNodeFs());

    expect(Object.keys(readOnly).sort()).toEqual([...READ_METHODS].sort());
    expect(readOnly).not.toHaveProperty("writeFile");
    expect(readOnly).not.toHaveProperty("rename");
  });
});

describe("readTextIfExists", () => {
  it("returns undefined when the file is missing", async () => {
    const fs = createNodeFs();
    expect(await readTextIfExists(fs, join(dir, "absent.txt"))).toBeUndefined();
  });

  it("returns the content when the file exists", async () => {
    const fs = createNodeFs();
    const target = join(dir, "present.txt");
    await writeFile(target, "hello");
    expect(await readTextIfExists(fs, target)).toBe("hello");
  });
});

describe("isNotFound", () => {
  it("is true for ENOENT and ENOTDIR", () => {
    expect(isNotFound({ code: "ENOENT" })).toBe(true);
    expect(isNotFound({ code: "ENOTDIR" })).toBe(true);
  });

  it("is false for EACCES and non-error values", () => {
    expect(isNotFound({ code: "EACCES" })).toBe(false);
    expect(isNotFound(new Error("plain"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
