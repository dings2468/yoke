import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdapterContext,
  type ApplyContext,
  planInstructionLink,
  planInstructionRemoval,
} from "../../src/adapters/base.js";
import {
  ConcurrentModificationError,
  createNodeFs,
  type Fs,
  toReadFs,
} from "../../src/core/fs-safe.js";
import { GENERATED_HEADER } from "../../src/core/instructions.js";
import {
  cleanupSandbox,
  makeAdapterContext,
  makeApplyContext,
  type Sandbox,
  setupAdapterSandbox,
} from "./helpers.js";

const SOURCE_TEXT = "# Shared instructions\n\nUse small commits.\n";
const LINK_TARGET = "../../repo/AGENTS.md";

/** A writable Fs whose write methods throw, over the real read methods. */
function writeForbiddenFs(): { readonly fs: Fs; readonly writes: string[] } {
  const writes: string[] = [];
  const base = createNodeFs();
  const forbid = (name: string) => async (): Promise<never> => {
    writes.push(name);
    throw new Error(`write attempted: ${name}`);
  };
  const fs: Fs = {
    ...base,
    writeFile: forbid("writeFile"),
    rename: forbid("rename"),
    mkdir: forbid("mkdir"),
    copyFile: forbid("copyFile"),
    symlink: forbid("symlink"),
    unlink: forbid("unlink"),
    chmod: forbid("chmod"),
  };
  return { fs, writes };
}

describe("planInstructionLink", () => {
  let sb: Sandbox;
  let ctx: AdapterContext;
  let apply: ApplyContext;
  let sourcePath: string;
  let linkPath: string;

  beforeEach(async () => {
    sb = await setupAdapterSandbox();
    ctx = makeAdapterContext(sb);
    apply = makeApplyContext(sb);
    sourcePath = join(sb.repo, "AGENTS.md");
    linkPath = join(sb.home, "native", "CLAUDE.md");
    await mkdir(join(sb.home, "native"), { recursive: true });
    await writeFile(sourcePath, SOURCE_TEXT, "utf8");
  });

  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  const input = (over: Partial<Parameters<typeof planInstructionLink>[1]> = {}) => ({
    scope: "user" as const,
    linkPath,
    sourcePath,
    ...over,
  });

  it("returns undefined when the source file does not exist", async () => {
    const plan = await planInstructionLink(ctx, input({ sourcePath: join(sb.repo, "missing.md") }));
    expect(plan).toBeUndefined();
  });

  it("creates a relative symlink when none exists, then re-plans as noop", async () => {
    const plan = await planInstructionLink(ctx, input());
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("symlink");
    expect(plan.link?.after).toBe(LINK_TARGET);
    expect(plan.expected).toEqual([
      {
        kind: "instructions",
        scope: "user",
        instructions: { kind: "symlink", path: linkPath, target: LINK_TARGET },
      },
    ]);

    const result = await plan.apply(apply);
    expect(result.status).toBe("written");
    expect(result.backupPath).toBeUndefined();
    expect(await readlink(linkPath)).toBe(LINK_TARGET);

    const again = await planInstructionLink(ctx, input());
    expect(again?.action).toBe("noop");
    expect((await again?.apply(apply))?.status).toBe("unchanged");
  });

  it("replaces an existing regular file with the link and backs it up", async () => {
    await writeFile(linkPath, "old native text\n", "utf8");
    const plan = await planInstructionLink(ctx, input());
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("symlink");
    expect(plan.before).toBe("old native text\n");

    const result = await plan.apply(apply);
    expect(result.status).toBe("written");
    expect(result.backupPath).toBeDefined();
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("replaces a foreign symlink and leaves its target untouched", async () => {
    const foreign = join(sb.home, "elsewhere.md");
    await writeFile(foreign, "elsewhere\n", "utf8");
    await symlink(foreign, linkPath);
    const plan = await planInstructionLink(ctx, input());
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("symlink");
    expect(plan.link?.before).toBe(foreign);

    await plan.apply(apply);
    expect(await readlink(linkPath)).toBe(LINK_TARGET);
    expect(await readFile(foreign, "utf8")).toBe("elsewhere\n");
  });

  it("warns and skips without writing when symlinks are unsupported", async () => {
    const plan = await planInstructionLink({ ...ctx, symlinksSupported: false }, input());
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("noop");
    expect(plan.expected).toEqual([]);
    expect(plan.warnings).toEqual([
      `symlinks are unsupported on this platform; skipped ${linkPath}`,
    ]);
    await plan.apply(apply);
    await expect(lstat(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes caller warnings through unchanged", async () => {
    const plan = await planInstructionLink(ctx, input({ warnings: ["note one"] }));
    expect(plan?.warnings).toEqual(["note one"]);
  });

  it("planning performs no writes", async () => {
    const spy = writeForbiddenFs();
    await planInstructionLink({ ...ctx, fs: spy.fs }, input());
    expect(spy.writes).toEqual([]);
    await expect(lstat(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads through a read-only ReadFs view as well", async () => {
    const plan = await planInstructionLink({ ...ctx, fs: toReadFs(createNodeFs()) }, input());
    expect(plan?.action).toBe("symlink");
  });
});

describe("planInstructionRemoval", () => {
  let sb: Sandbox;
  let ctx: AdapterContext;
  let apply: ApplyContext;
  let sourcePath: string;
  let path: string;

  beforeEach(async () => {
    sb = await setupAdapterSandbox();
    ctx = makeAdapterContext(sb);
    apply = makeApplyContext(sb);
    sourcePath = join(sb.repo, "AGENTS.md");
    path = join(sb.repo, "CLAUDE.md");
    await writeFile(sourcePath, SOURCE_TEXT, "utf8");
  });

  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  const input = (over: Partial<Parameters<typeof planInstructionRemoval>[1]> = {}) => ({
    scope: "project" as const,
    path,
    sourcePath,
    ...over,
  });

  it("removes a file that starts with the generated header, after a backup", async () => {
    const generated = `${GENERATED_HEADER}\n\nold compiled text\n`;
    await writeFile(path, generated, "utf8");
    const plan = await planInstructionRemoval(ctx, input());
    expect(plan.action).toBe("remove");
    expect(plan.summary).toContain("generated header");
    expect(plan.before).toBe(generated);
    expect(plan.after).toBeUndefined();
    expect(plan.expected).toEqual([{ kind: "instructions", scope: "project", instructions: null }]);

    const result = await plan.apply(apply);
    expect(result.status).toBe("written");
    expect(result.backupPath).toBeDefined();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(result.backupPath as string, "utf8")).toBe(generated);
  });

  it("removes a symlink that points at the canonical source, backing up the link", async () => {
    await symlink("AGENTS.md", path);
    const plan = await planInstructionRemoval(ctx, input());
    expect(plan.action).toBe("remove");
    expect(plan.summary).toContain("link to AGENTS.md");
    expect(plan.link).toEqual({ before: "AGENTS.md", after: undefined });

    const result = await plan.apply(apply);
    expect(result.status).toBe("written");
    expect(result.backupPath).toBeDefined();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readlink(result.backupPath as string)).toBe("AGENTS.md");
    expect(await readFile(sourcePath, "utf8")).toBe(SOURCE_TEXT);
  });

  it("removes a file that the lock records even without the generated header", async () => {
    await writeFile(path, "hand-edited after yoke wrote it\n", "utf8");
    const plan = await planInstructionRemoval(ctx, input({ recordedInLock: true }));
    expect(plan.action).toBe("remove");
    expect(plan.summary).toContain("recorded in lock");
    await plan.apply(apply);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a user-written file alone and warns", async () => {
    await writeFile(path, "# My own notes\n@AGENTS.md\n", "utf8");
    const plan = await planInstructionRemoval(ctx, input());
    expect(plan.action).toBe("noop");
    expect(plan.expected).toEqual([]);
    expect(plan.warnings).toEqual([`${path} is not yoke-generated; left in place`]);

    const result = await plan.apply(apply);
    expect(result.status).toBe("unchanged");
    expect(await readFile(path, "utf8")).toBe("# My own notes\n@AGENTS.md\n");
  });

  it("leaves a symlink to another file alone and warns", async () => {
    const other = join(sb.home, "other.md");
    await writeFile(other, "other\n", "utf8");
    await symlink(other, path);
    const plan = await planInstructionRemoval(ctx, input());
    expect(plan.action).toBe("noop");
    expect(plan.warnings).toHaveLength(1);
    await plan.apply(apply);
    expect(await readlink(path)).toBe(other);
  });

  it("is a noop when the path is missing, and records absence only when the lock tracked it", async () => {
    const untracked = await planInstructionRemoval(ctx, input());
    expect(untracked.action).toBe("noop");
    expect(untracked.expected).toEqual([]);

    const tracked = await planInstructionRemoval(ctx, input({ recordedInLock: true }));
    expect(tracked.action).toBe("noop");
    expect(tracked.expected).toEqual([
      { kind: "instructions", scope: "project", instructions: null },
    ]);
    expect((await tracked.apply(apply)).status).toBe("unchanged");
  });

  it("planning performs no writes", async () => {
    await writeFile(path, `${GENERATED_HEADER}\n`, "utf8");
    const spy = writeForbiddenFs();
    await planInstructionRemoval({ ...ctx, fs: spy.fs }, input());
    expect(spy.writes).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(`${GENERATED_HEADER}\n`);
  });

  it("throws ConcurrentModificationError when the file changed between plan and apply", async () => {
    await writeFile(path, `${GENERATED_HEADER}\n`, "utf8");
    const plan = await planInstructionRemoval(ctx, input());
    await writeFile(path, "replaced by the user\n", "utf8");

    await expect(plan.apply(apply)).rejects.toBeInstanceOf(ConcurrentModificationError);
    expect(await readFile(path, "utf8")).toBe("replaced by the user\n");
    expect(await readdir(sb.backupsRoot)).toEqual([]);
  });

  it("reads through a read-only ReadFs view as well", async () => {
    await writeFile(path, `${GENERATED_HEADER}\n`, "utf8");
    const plan = await planInstructionRemoval({ ...ctx, fs: toReadFs(createNodeFs()) }, input());
    expect(plan.action).toBe("remove");
  });
});
