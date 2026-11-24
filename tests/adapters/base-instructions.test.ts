import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdapterContext,
  type ApplyContext,
  planInstructionTarget,
} from "../../src/adapters/base.js";
import { GENERATED_HEADER } from "../../src/core/compiler.js";
import {
  ConcurrentModificationError,
  createNodeFs,
  type Fs,
  toReadFs,
} from "../../src/core/fs-safe.js";
import {
  cleanupSandbox,
  makeAdapterContext,
  makeApplyContext,
  type Sandbox,
  setupAdapterSandbox,
} from "./helpers.js";

const SOURCE_TEXT = "# Shared instructions\n\nUse small commits.\n";
const CONDITIONAL_TEXT =
  "Shared line\n<!-- yoke:claude-only -->\nClaude line\n<!-- /yoke:claude-only -->\n";
const VALID_TARGETS = ["claude", "agy"];

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

describe("planInstructionTarget", () => {
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
    linkPath = join(sb.home, "native", "INSTRUCTIONS.md");
    await mkdir(join(sb.home, "native"), { recursive: true });
    await writeFile(sourcePath, SOURCE_TEXT, "utf8");
  });

  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  const input = (over: Partial<Parameters<typeof planInstructionTarget>[1]> = {}) => ({
    target: "claude",
    validTargets: VALID_TARGETS,
    scope: "project" as const,
    linkPath,
    sourcePath,
    localPath: undefined,
    preferSymlink: true,
    warnings: [] as readonly string[],
    ...over,
  });

  it("returns undefined when the source file does not exist", async () => {
    const plan = await planInstructionTarget(
      ctx,
      input({ sourcePath: join(sb.repo, "missing.md") }),
    );
    expect(plan).toBeUndefined();
  });

  it("creates a symlink when none exists, then re-plans as noop", async () => {
    const plan = await planInstructionTarget(ctx, input());
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("symlink");
    expect(plan.link?.after).toBe("../../repo/AGENTS.md");
    expect(plan.expected).toEqual([
      {
        kind: "instructions",
        scope: "project",
        instructions: { kind: "symlink", path: linkPath, target: "../../repo/AGENTS.md" },
      },
    ]);

    const result = await plan.apply(apply);
    expect(result.status).toBe("written");
    expect(result.backupPath).toBeUndefined();
    expect(await readlink(linkPath)).toBe("../../repo/AGENTS.md");

    const again = await planInstructionTarget(ctx, input());
    expect(again?.action).toBe("noop");
    expect((await again?.apply(apply))?.status).toBe("unchanged");
  });

  it("replaces an existing regular file with a symlink and backs it up", async () => {
    await writeFile(linkPath, "old native text\n", "utf8");
    const plan = await planInstructionTarget(ctx, input());
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("symlink");
    expect(plan.before).toBe("old native text\n");

    const result = await plan.apply(apply);
    expect(result.status).toBe("written");
    expect(result.backupPath).toBeDefined();
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("replaces a foreign symlink with the planned link", async () => {
    const foreign = join(sb.home, "elsewhere.md");
    await writeFile(foreign, "elsewhere\n", "utf8");
    await symlink(foreign, linkPath);
    const plan = await planInstructionTarget(ctx, input());
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("symlink");
    expect(plan.link?.before).toBe(foreign);

    await plan.apply(apply);
    expect(await readlink(linkPath)).toBe("../../repo/AGENTS.md");
    expect(await readFile(foreign, "utf8")).toBe("elsewhere\n");
  });

  it("compiles when preferSymlink is off, and the compiled file starts with the generated header", async () => {
    const plan = await planInstructionTarget(ctx, input({ preferSymlink: false }));
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("create");
    expect(plan.summary).toContain("prefer-symlink-off");
    expect(plan.before).toBeUndefined();
    expect(plan.after?.startsWith(GENERATED_HEADER)).toBe(true);
    expect(plan.expected[0]).toEqual({
      kind: "instructions",
      scope: "project",
      instructions: { kind: "file", path: linkPath, content: plan.after },
    });

    const result = await plan.apply(apply);
    expect(result.status).toBe("written");
    expect(await readFile(linkPath, "utf8")).toBe(plan.after);

    const again = await planInstructionTarget(ctx, input({ preferSymlink: false }));
    expect(again?.action).toBe("noop");
  });

  it("updates a regular file whose content differs from the compiled text", async () => {
    await writeFile(linkPath, "stale\n", "utf8");
    const plan = await planInstructionTarget(ctx, input({ preferSymlink: false }));
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("update");
    expect(plan.before).toBe("stale\n");
    const result = await plan.apply(apply);
    expect(result.status).toBe("written");
    expect(result.backupPath).toBeDefined();
  });

  it("compiles over a symlink: the source stays byte-identical and the link becomes a regular file", async () => {
    await symlink("../../repo/AGENTS.md", linkPath);
    const plan = await planInstructionTarget(ctx, input({ preferSymlink: false }));
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("update");
    expect(plan.path).toBe(linkPath);
    expect(plan.link?.before).toBe("../../repo/AGENTS.md");
    expect(plan.before).toBeUndefined();

    const result = await plan.apply(apply);
    expect(result.status).toBe("written");
    expect(result.backupPath).toBeDefined();
    expect(await readFile(sourcePath, "utf8")).toBe(SOURCE_TEXT);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(linkPath, "utf8")).toBe(plan.after);
  });

  it("uses the local override and records local-override as the compile reason", async () => {
    const localPath = join(sb.repo, "AGENTS.local.md");
    await writeFile(localPath, "Local note\n", "utf8");
    const plan = await planInstructionTarget(ctx, input({ localPath }));
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.action).toBe("create");
    expect(plan.summary).toContain("local-override");
    expect(plan.after).toContain("Local note");
  });

  it("compiles conditional blocks and records conditional-blocks as the reason", async () => {
    await writeFile(sourcePath, CONDITIONAL_TEXT, "utf8");
    const plan = await planInstructionTarget(ctx, input());
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.summary).toContain("conditional-blocks");
    expect(plan.after).toContain("Claude line");
  });

  it("falls back to compile when symlinks are unsupported", async () => {
    const plan = await planInstructionTarget(ctx, input({ preferSymlink: true }));
    const noLinks = await planInstructionTarget(
      { ...ctx, symlinksSupported: false },
      input({ preferSymlink: true }),
    );
    expect(plan?.action).toBe("symlink");
    if (noLinks === undefined) throw new Error("expected a plan");
    expect(noLinks.action).toBe("create");
    expect(noLinks.summary).toContain("symlink-unsupported");
  });

  it("warnings are passed through unchanged", async () => {
    const plan = await planInstructionTarget(ctx, input({ warnings: ["note one"] }));
    expect(plan?.warnings).toEqual(["note one"]);
  });

  it("planning performs no writes", async () => {
    await symlink("../../repo/AGENTS.md", linkPath);
    const spy = writeForbiddenFs();
    const spyCtx: AdapterContext = { ...ctx, fs: spy.fs };
    await planInstructionTarget(spyCtx, input({ preferSymlink: false }));
    await planInstructionTarget(spyCtx, input());
    expect(spy.writes).toEqual([]);
    expect(await readlink(linkPath)).toBe("../../repo/AGENTS.md");
  });

  it("throws ConcurrentModificationError when the link changed between plan and apply", async () => {
    await symlink("../../repo/AGENTS.md", linkPath);
    const plan = await planInstructionTarget(ctx, input({ preferSymlink: false }));
    if (plan === undefined) throw new Error("expected a plan");

    const other = join(sb.home, "other.md");
    await writeFile(other, "other\n", "utf8");
    await unlink(linkPath);
    await symlink(other, linkPath);

    await expect(plan.apply(apply)).rejects.toBeInstanceOf(ConcurrentModificationError);
    expect(await readFile(other, "utf8")).toBe("other\n");
    expect(await readFile(sourcePath, "utf8")).toBe(SOURCE_TEXT);
  });

  it("reads through a read-only ReadFs view as well", async () => {
    const readOnly = toReadFs(createNodeFs());
    const plan = await planInstructionTarget({ ...ctx, fs: readOnly }, input());
    expect(plan?.action).toBe("symlink");
  });
});
