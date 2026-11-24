import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BackupSession,
  ConcurrentModificationError,
  commitJsonPatch,
  commitTextWrite,
  createBackupSession,
  createNodeFs,
  type Fs,
  FsSafeError,
  JsonPatchError,
  planJsonPatch,
  planTextWrite,
  readJsonIfExists,
  toReadFs,
} from "../../src/core/fs-safe.js";

const FIXTURES = new URL("../fixtures/core/json/", import.meta.url);
const FIXED_NOW = new Date("2026-11-24T10:00:00.123Z");

const WRITE_METHODS = [
  "writeFile",
  "rename",
  "mkdir",
  "copyFile",
  "symlink",
  "unlink",
  "chmod",
] as const;

const NEW_SERVERS = {
  alpha: { type: "stdio", command: "alpha-cmd", args: [] },
  beta: { type: "http", url: "https://example.test/mcp" },
};

let dir: string;
let fs: Fs;
let backup: BackupSession;
let backupRoot: string;

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), "utf8");
}

function spyOnAllWrites(target: Fs): ReturnType<typeof vi.spyOn>[] {
  return WRITE_METHODS.map((method) => vi.spyOn(target, method));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yoke-f3-"));
  fs = createNodeFs();
  backupRoot = join(dir, "backups");
  backup = createBackupSession({ fs, root: backupRoot, now: () => FIXED_NOW });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("readJsonIfExists", () => {
  it("returns undefined for a missing file", async () => {
    expect(await readJsonIfExists(fs, join(dir, "missing.json"))).toBeUndefined();
  });

  it("returns the text and parsed value", async () => {
    const path = join(dir, "a.json");
    await writeFile(path, '{"a":1}\n');
    const result = await readJsonIfExists(fs, path);
    expect(result).toEqual({ text: '{"a":1}\n', value: { a: 1 } });
  });

  it("wraps invalid JSON in FsSafeError with the cause and path kept", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{ nope");
    const err = await readJsonIfExists(fs, path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsSafeError);
    expect((err as FsSafeError).path).toBe(path);
    expect((err as FsSafeError).cause).toBeInstanceOf(JsonPatchError);
  });

  it("wraps unsafe integers in FsSafeError", async () => {
    const path = join(dir, "big.json");
    await writeFile(path, await fixture("unsafe-number.json"));
    await expect(readJsonIfExists(fs, path)).rejects.toBeInstanceOf(FsSafeError);
  });
});

describe("dry-run parity", () => {
  it("planning records zero write calls and matches the plan of a real run", async () => {
    const path = join(dir, ".claude.json");
    await writeFile(path, await fixture("claude-like.json"));
    const textPath = join(dir, "CLAUDE.md");
    await writeFile(textPath, "old\n");

    const planAll = async (reader: ReturnType<typeof toReadFs>) => ({
      json: await planJsonPatch(reader, path, ["mcpServers"], NEW_SERVERS),
      text: await planTextWrite(reader, textPath, "new\n"),
    });

    const spies = spyOnAllWrites(fs);
    const dryPlans = await planAll(toReadFs(fs));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(await readFile(path, "utf8")).toBe(await fixture("claude-like.json"));
    expect(await readFile(textPath, "utf8")).toBe("old\n");

    vi.restoreAllMocks();
    const realPlans = await planAll(toReadFs(fs));
    expect(realPlans).toEqual(dryPlans);

    await commitJsonPatch(fs, realPlans.json, { backup });
    await commitTextWrite(fs, realPlans.text, { backup });
    expect(await readFile(path, "utf8")).toBe(realPlans.json.after);
    expect(await readFile(textPath, "utf8")).toBe(realPlans.text.after);
  });
});

describe("commitJsonPatch zero-clobber", () => {
  it("changes only mcpServers and keeps the original bytes in the backup", async () => {
    const path = join(dir, ".claude.json");
    const original = await fixture("claude-like.json");
    await writeFile(path, original);

    const plan = await planJsonPatch(fs, path, ["mcpServers"], NEW_SERVERS);
    expect(plan.strategy).toBe("span");
    const result = await commitJsonPatch(fs, plan, { backup });

    expect(result.written).toBe(true);
    expect(result.rebased).toBe(false);
    expect(await readFile(path, "utf8")).toBe(await fixture("claude-like.patched.json"));
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath as string, "utf8")).toBe(original);
  });
});

describe("commitJsonPatch rebase (D7)", () => {
  it("re-patches the key on the current text when the file changed after planning", async () => {
    const path = join(dir, ".claude.json");
    await writeFile(path, await fixture("claude-like.json"));

    const plan = await planJsonPatch(fs, path, ["mcpServers"], NEW_SERVERS);
    await writeFile(
      path,
      (await fixture("claude-like.json")).replace('"numStartups": 3', '"numStartups": 9'),
    );

    const result = await commitJsonPatch(fs, plan, { backup });
    expect(result.rebased).toBe(true);
    expect(result.written).toBe(true);

    const committed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(committed.numStartups).toBe(9);
    expect(committed.mcpServers).toEqual(NEW_SERVERS);
  });

  it("writes nothing when the rebased key already holds the value", async () => {
    const path = join(dir, ".claude.json");
    await writeFile(path, await fixture("claude-like.json"));

    const plan = await planJsonPatch(fs, path, ["mcpServers"], NEW_SERVERS);
    await commitJsonPatch(fs, plan, { backup });
    const afterFirst = await readFile(path, "utf8");

    // The plan is stale (before still holds the original text), but the key already matches.
    const stale = { ...plan, before: "{}" };
    const result = await commitJsonPatch(fs, stale, { backup });
    expect(result).toEqual({ written: false, rebased: true, backupPath: undefined });
    expect(await readFile(path, "utf8")).toBe(afterFirst);
  });
});

describe("commitJsonPatch noop and create", () => {
  it("a noop plan writes nothing and creates no backup", async () => {
    const path = join(dir, ".claude.json");
    await writeFile(path, await fixture("claude-like.json"));

    const plan = await planJsonPatch(fs, path, ["numStartups"], 3);
    expect(plan.changed).toBe(false);
    expect(plan.strategy).toBe("noop");

    const spies = spyOnAllWrites(fs);
    const result = await commitJsonPatch(fs, plan, { backup });
    expect(result).toEqual({ written: false, rebased: false, backupPath: undefined });
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
    await expect(readdir(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a missing file with no backup", async () => {
    const path = join(dir, "new", ".claude.json");
    const plan = await planJsonPatch(fs, path, ["mcpServers"], NEW_SERVERS);
    expect(plan.before).toBeUndefined();
    expect(plan.strategy).toBe("create");

    const result = await commitJsonPatch(fs, plan, { backup });
    expect(result).toEqual({ written: true, rebased: false, backupPath: undefined });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: NEW_SERVERS });
  });

  it("planning invalid JSON throws FsSafeError and writes nothing", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "[1,2]");
    await expect(planJsonPatch(fs, path, ["mcpServers"], NEW_SERVERS)).rejects.toBeInstanceOf(
      FsSafeError,
    );
    expect(await readFile(path, "utf8")).toBe("[1,2]");
  });
});

describe("text write", () => {
  it("throws ConcurrentModificationError when the file changed after planning", async () => {
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "old\n");
    const plan = await planTextWrite(fs, path, "new\n");

    await writeFile(path, "someone else\n");
    const err = await commitTextWrite(fs, plan, { backup }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurrentModificationError);
    expect(err).toBeInstanceOf(FsSafeError);
    expect(await readFile(path, "utf8")).toBe("someone else\n");
  });

  it("backs up the existing file before writing", async () => {
    const path = join(dir, "CLAUDE.md");
    await writeFile(path, "old\n");
    const plan = await planTextWrite(fs, path, "new\n");
    expect(plan.changed).toBe(true);

    const result = await commitTextWrite(fs, plan, { backup });
    expect(result.written).toBe(true);
    expect(await readFile(path, "utf8")).toBe("new\n");
    expect(await readFile(result.backupPath as string, "utf8")).toBe("old\n");
  });

  it("creates a missing file with no backup", async () => {
    const path = join(dir, "AGENTS.md");
    const plan = await planTextWrite(fs, path, "hello\n");
    expect(plan.before).toBeUndefined();

    const result = await commitTextWrite(fs, plan, { backup });
    expect(result).toEqual({ written: true, rebased: false, backupPath: undefined });
    expect(await readFile(path, "utf8")).toBe("hello\n");
  });
});
