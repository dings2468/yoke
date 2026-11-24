import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackupSession, createNodeFs, safeSymlink } from "../../src/core/fs-safe.js";

const FIXED_NOW = new Date("2026-11-24T10:00:00.123Z");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yoke-fs4-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("safeSymlink temp file ownership", () => {
  it("never deletes a foreign file at the temp path when symlink fails with EEXIST", async () => {
    const fs = createNodeFs();
    const target = join(dir, "AGENTS.md");
    await writeFile(target, "source");
    const link = join(dir, "X.md");
    await writeFile(join(dir, "X.md.fixed.yoke.tmp"), "foreign");
    const unlinkSpy = vi.spyOn(fs, "unlink");
    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });

    await expect(
      safeSymlink(fs, link, target, { backup: session, tmpSuffix: () => "fixed" }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(join(dir, "X.md.fixed.yoke.tmp"), "utf8")).toBe("foreign");
    expect(unlinkSpy).not.toHaveBeenCalled();
    await expect(readFile(link, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("links normally and leaves no temp file behind", async () => {
    const fs = createNodeFs();
    const target = join(dir, "AGENTS.md");
    await writeFile(target, "source");
    const link = join(dir, "X.md");
    const session = createBackupSession({ fs, root: join(dir, "backups"), now: () => FIXED_NOW });

    const result = await safeSymlink(fs, link, target, {
      backup: session,
      tmpSuffix: () => "fixed",
    });

    expect(result.kind).toBe("linked");
    expect(await readFile(link, "utf8")).toBe("source");
    expect((await readdir(dir)).filter((n) => n.endsWith(".yoke.tmp"))).toEqual([]);
  });
});
