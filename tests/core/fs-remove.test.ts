import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConcurrentModificationError,
  commitRemove,
  createBackupSession,
  createNodeFs,
  FsSafeError,
  planRemove,
} from "../../src/core/fs-safe.js";

const FIXED_NOW = new Date("2026-11-24T10:00:00.123Z");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yoke-remove-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function session(root: string) {
  return createBackupSession({ fs: createNodeFs(), root, now: () => FIXED_NOW });
}

describe("planRemove", () => {
  it("reports a missing path without creating anything", async () => {
    const plan = await planRemove(createNodeFs(), join(dir, "CLAUDE.md"));
    expect(plan.before).toEqual({ kind: "missing" });
  });

  it("reads file content and leaves the file in place (dry-run safe)", async () => {
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "@AGENTS.md\n");
    const plan = await planRemove(createNodeFs(), path);
    expect(plan.before).toEqual({ kind: "file", content: "@AGENTS.md\n" });
    expect(await readFile(path, "utf8")).toBe("@AGENTS.md\n");
  });

  it("reports a symbolic link by its target text without following it", async () => {
    const path = join(dir, "GEMINI.md");
    await symlink("AGENTS.md", path);
    const plan = await planRemove(createNodeFs(), path);
    expect(plan.before).toEqual({ kind: "link", target: "AGENTS.md" });
  });

  it("refuses directories", async () => {
    const path = join(dir, "CLAUDE.md");
    await mkdir(path);
    await expect(planRemove(createNodeFs(), path)).rejects.toThrow(FsSafeError);
  });
});

describe("commitRemove", () => {
  it("backs up file content and then unlinks the file", async () => {
    const fs = createNodeFs();
    const path = join(dir, "home", "CLAUDE.md");
    await mkdir(join(dir, "home"));
    await writeFile(path, "generated\n");
    const root = join(dir, "backups");

    const plan = await planRemove(fs, path);
    const result = await commitRemove(fs, plan, { backup: session(root) });

    expect(result.removed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath as string, "utf8")).toBe("generated\n");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("backs up a symbolic link as a link and removes only the link", async () => {
    const fs = createNodeFs();
    const target = join(dir, "AGENTS.md");
    const path = join(dir, "GEMINI.md");
    await writeFile(target, "shared\n");
    await symlink("AGENTS.md", path);
    const root = join(dir, "backups");

    const plan = await planRemove(fs, path);
    const result = await commitRemove(fs, plan, { backup: session(root) });

    expect(result.removed).toBe(true);
    expect(await readlink(result.backupPath as string)).toBe("AGENTS.md");
    await expect(readlink(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(target, "utf8")).toBe("shared\n");
  });

  it("is a no-op for a missing path and creates no backup directory", async () => {
    const fs = createNodeFs();
    const root = join(dir, "backups");
    const backups = session(root);

    const plan = await planRemove(fs, join(dir, "CLAUDE.md"));
    const result = await commitRemove(fs, plan, { backup: backups });

    expect(result).toEqual({ removed: false, backupPath: undefined });
    expect(backups.dir()).toBeUndefined();
  });

  it("throws ConcurrentModificationError and keeps the file when its content changed after planning", async () => {
    const fs = createNodeFs();
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "first\n");
    const root = join(dir, "backups");

    const plan = await planRemove(fs, path);
    await writeFile(path, "edited by someone else\n");

    await expect(commitRemove(fs, plan, { backup: session(root) })).rejects.toThrow(
      ConcurrentModificationError,
    );
    expect(await readFile(path, "utf8")).toBe("edited by someone else\n");
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws ConcurrentModificationError when a planned file was replaced by a link", async () => {
    const fs = createNodeFs();
    const path = join(dir, "GEMINI.md");
    const target = join(dir, "AGENTS.md");
    await writeFile(path, "text\n");
    await writeFile(target, "shared\n");

    const plan = await planRemove(fs, path);
    await rm(path);
    await symlink("AGENTS.md", path);

    await expect(commitRemove(fs, plan, { backup: session(join(dir, "backups")) })).rejects.toThrow(
      ConcurrentModificationError,
    );
    expect(await readlink(path)).toBe("AGENTS.md");
  });

  it("throws ConcurrentModificationError when a planned file was deleted after planning", async () => {
    const fs = createNodeFs();
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "text\n");

    const plan = await planRemove(fs, path);
    await rm(path);

    await expect(commitRemove(fs, plan, { backup: session(join(dir, "backups")) })).rejects.toThrow(
      ConcurrentModificationError,
    );
  });
});
