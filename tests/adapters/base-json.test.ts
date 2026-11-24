import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advisoryPlan,
  type DesiredEntry,
  mergeServerEntries,
  type NativeEntry,
  NativeStateError,
  planJsonKeyPatch,
  updateOwnedList,
  usesEnvReference,
} from "../../src/adapters/base.js";
import { createNodeFs, type Fs, type ReadFs } from "../../src/core/fs-safe.js";
import type { JsonObject, JsonValue } from "../../src/core/json-text.js";
import type { McpServerDefinition } from "../../src/core/schema.js";
import { cleanupSandbox, makeApplyContext, type Sandbox, setupAdapterSandbox } from "./helpers.js";

/** A writable Fs whose write methods record and throw, over the real read methods. */
function writeSpy(): { readonly fs: ReadFs; readonly writes: string[] } {
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

const stdioDef = (command: string): McpServerDefinition => ({ transport: "stdio", command });

describe("planJsonKeyPatch", () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await setupAdapterSandbox();
  });
  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  const input = (path: string, value: JsonValue, keyPath: ["mcpServers", ...string[]]) => ({
    scope: "user" as const,
    path,
    keyPath,
    value,
    summary: "test key",
    warnings: ["w1"],
    expected: [],
  });

  it("creates a missing file with the key", async () => {
    const path = join(sb.repo, "new.json");
    const plan = await planJsonKeyPatch(
      createNodeFs(),
      input(path, { command: "x" }, ["mcpServers", "x"]),
    );
    expect(plan.action).toBe("create");
    expect(plan.before).toBeUndefined();
    expect(plan.warnings).toEqual(["w1"]);
    expect(plan.summary).toBe("test key");

    const result = await plan.apply(makeApplyContext(sb));
    expect(result.status).toBe("written");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: { x: { command: "x" } },
    });

    const again = await planJsonKeyPatch(
      createNodeFs(),
      input(path, { command: "x" }, ["mcpServers", "x"]),
    );
    expect(again.action).toBe("noop");
  });

  it("patches an existing file and keeps unrelated keys", async () => {
    const path = join(sb.repo, "existing.json");
    const original = '{\n  "keep": 1,\n  "mcpServers": {\n    "a": { "command": "a" }\n  }\n}\n';
    await writeFile(path, original, "utf8");

    const plan = await planJsonKeyPatch(
      createNodeFs(),
      input(path, { command: "b" }, ["mcpServers", "b"]),
    );
    expect(plan.action).toBe("patch-json");
    expect(plan.before).toBe(original);
    expect(plan.after).toBeDefined();

    const result = await plan.apply(makeApplyContext(sb));
    expect(result.status).toBe("written");
    expect(result.backupPath).toBeDefined();
    const patched: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(patched).toEqual({
      keep: 1,
      mcpServers: { a: { command: "a" }, b: { command: "b" } },
    });
  });

  it("is a noop when the key already has the value", async () => {
    const path = join(sb.repo, "same.json");
    const original = '{"mcpServers":{"a":{"command":"a"}}}\n';
    await writeFile(path, original, "utf8");

    const plan = await planJsonKeyPatch(
      createNodeFs(),
      input(path, { command: "a" }, ["mcpServers", "a"]),
    );
    expect(plan.action).toBe("noop");
    expect(plan.after).toBe(plan.before);

    const result = await plan.apply(makeApplyContext(sb));
    expect(result).toEqual({ status: "unchanged", backupPath: undefined });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("treats an empty value on an absent key as a noop that creates no file", async () => {
    const missing = join(sb.repo, "absent.json");
    const plan = await planJsonKeyPatch(createNodeFs(), input(missing, {}, ["mcpServers"]));
    expect(plan.action).toBe("noop");
    expect(plan.before).toBeUndefined();
    expect(plan.after).toBeUndefined();
    expect(await plan.apply(makeApplyContext(sb))).toEqual({
      status: "unchanged",
      backupPath: undefined,
    });
    await expect(createNodeFs().lstat(missing)).rejects.toThrow();

    const existing = join(sb.repo, "no-key.json");
    const text = '{"other":true}\n';
    await writeFile(existing, text, "utf8");
    const plan2 = await planJsonKeyPatch(createNodeFs(), input(existing, [], ["mcpServers"]));
    expect(plan2.action).toBe("noop");
    expect(plan2.before).toBe(text);
    expect(plan2.after).toBe(text);
  });

  it("makes zero write calls while planning", async () => {
    const spy = writeSpy();
    const missing = join(sb.repo, "spy-new.json");
    const existing = join(sb.repo, "spy-existing.json");
    await writeFile(existing, '{"mcpServers":{}}\n', "utf8");

    await planJsonKeyPatch(spy.fs, input(missing, { command: "x" }, ["mcpServers", "x"]));
    await planJsonKeyPatch(spy.fs, input(existing, { command: "y" }, ["mcpServers", "y"]));
    await planJsonKeyPatch(spy.fs, input(missing, {}, ["mcpServers"]));
    expect(spy.writes).toEqual([]);
  });
});

describe("mergeServerEntries", () => {
  const managed = (def: McpServerDefinition, extras: JsonObject = {}): NativeEntry => ({
    kind: "managed",
    def,
    extras,
  });

  const desiredOf = (def: McpServerDefinition, entry: JsonObject): DesiredEntry => ({ def, entry });

  it("keeps extras after entry keys when the transport is unchanged", () => {
    const native = new Map<string, NativeEntry>([["gh", managed(stdioDef("old"), { timeout: 5 })]]);
    const desired = new Map<string, DesiredEntry>([
      ["gh", desiredOf(stdioDef("new"), { type: "stdio", command: "new" })],
    ]);
    const out = mergeServerEntries({ harness: "h", path: "/p", native, desired, force: false });
    expect(out.warnings).toEqual([]);
    expect(out.value).toEqual({ gh: { type: "stdio", command: "new", timeout: 5 } });
    expect(Object.keys(out.value.gh as JsonObject)).toEqual(["type", "command", "timeout"]);
  });

  it("drops extras with a warning when the transport changed", () => {
    const native = new Map<string, NativeEntry>([
      ["gh", managed({ transport: "http", url: "https://a.test/mcp" }, { timeout: 5, oauth: {} })],
    ]);
    const desired = new Map<string, DesiredEntry>([
      ["gh", desiredOf(stdioDef("npx"), { type: "stdio", command: "npx" })],
    ]);
    const out = mergeServerEntries({ harness: "h", path: "/p", native, desired, force: false });
    expect(out.value).toEqual({ gh: { type: "stdio", command: "npx" } });
    expect(out.warnings).toEqual([
      'h: MCP server "gh" in /p: dropped native keys timeout,oauth because the transport changed',
    ]);
  });

  it("drops a managed server that is not desired, without a warning", () => {
    const native = new Map<string, NativeEntry>([["old", managed(stdioDef("o"))]]);
    const out = mergeServerEntries({
      harness: "h",
      path: "/p",
      native,
      desired: new Map(),
      force: false,
    });
    expect(out.value).toEqual({});
    expect(out.warnings).toEqual([]);
  });

  it("keeps an opaque server that is not desired, with a warning", () => {
    const raw: JsonValue = { type: "ws", url: "ws://w.test" };
    const native = new Map<string, NativeEntry>([
      ["wsy", { kind: "opaque", raw, reason: 'type "ws"' }],
    ]);
    const out = mergeServerEntries({
      harness: "h",
      path: "/p",
      native,
      desired: new Map(),
      force: false,
    });
    expect(out.value).toEqual({ wsy: raw });
    expect(out.warnings).toEqual([
      'h: MCP server "wsy" in /p has an unsupported transport (type "ws"); left unchanged and not managed by yoke',
    ]);
  });

  it("throws NativeStateError for an opaque server that yoke defines, unless forced", () => {
    const native = new Map<string, NativeEntry>([
      ["wsy", { kind: "opaque", raw: { type: "ws" }, reason: 'type "ws"' }],
    ]);
    const desired = new Map<string, DesiredEntry>([
      ["wsy", desiredOf(stdioDef("w"), { type: "stdio", command: "w" })],
    ]);
    let caught: unknown;
    try {
      mergeServerEntries({ harness: "h", path: "/p", native, desired, force: false });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NativeStateError);
    expect((caught as NativeStateError).server).toBe("wsy");
    expect((caught as NativeStateError).path).toBe("/p");
    expect((caught as NativeStateError).message).toContain("rerun with --force");

    const forced = mergeServerEntries({ harness: "h", path: "/p", native, desired, force: true });
    expect(forced.value).toEqual({ wsy: { type: "stdio", command: "w" } });
    expect(forced.warnings).toEqual([
      'h: MCP server "wsy" in /p has an unsupported transport (type "ws"); replaced because --force was given',
    ]);
  });

  it("keeps native order for survivors and appends new desired names sorted", () => {
    const native = new Map<string, NativeEntry>([
      ["zeta", { kind: "opaque", raw: { type: "ws" }, reason: 'type "ws"' }],
      ["gone", managed(stdioDef("g"))],
      ["mid", managed(stdioDef("m"))],
    ]);
    const desired = new Map<string, DesiredEntry>([
      ["b", desiredOf(stdioDef("b"), { type: "stdio", command: "b" })],
      ["mid", desiredOf(stdioDef("m2"), { type: "stdio", command: "m2" })],
      ["a", desiredOf(stdioDef("a"), { type: "stdio", command: "a" })],
    ]);
    const out = mergeServerEntries({ harness: "h", path: "/p", native, desired, force: false });
    expect(Object.keys(out.value)).toEqual(["zeta", "mid", "a", "b"]);
  });

  it("writes a __proto__ server name as an own key", () => {
    const desired = new Map<string, DesiredEntry>([
      ["__proto__", desiredOf(stdioDef("p"), { type: "stdio", command: "p" })],
    ]);
    const out = mergeServerEntries({
      harness: "h",
      path: "/p",
      native: new Map(),
      desired,
      force: false,
    });
    expect(Object.getPrototypeOf(out.value)).toBe(Object.prototype);
    expect(Object.hasOwn(out.value, "__proto__")).toBe(true);
  });
});

describe("updateOwnedList", () => {
  it("adds desired names sorted", () => {
    expect(updateOwnedList({ native: [], lockOwned: [], desired: ["b", "a"] })).toEqual({
      after: ["a", "b"],
      owned: ["a", "b"],
    });
  });

  it("removes only owned names that are no longer desired, and keeps foreign names", () => {
    const out = updateOwnedList({
      native: ["mine", "gh", "x"],
      lockOwned: ["gh"],
      desired: [],
    });
    expect(out.after).toEqual(["mine", "x"]);
    expect(out.owned).toEqual([]);
  });

  it("does not claim a name the user already listed", () => {
    const out = updateOwnedList({
      native: ["user-off"],
      lockOwned: [],
      desired: ["user-off"],
    });
    expect(out.after).toEqual(["user-off"]);
    expect(out.owned).toEqual([]);
  });

  it("keeps and claims a desired name yoke already owns", () => {
    const out = updateOwnedList({ native: ["gh"], lockOwned: ["gh"], desired: ["gh"] });
    expect(out).toEqual({ after: ["gh"], owned: ["gh"] });
  });
});

describe("usesEnvReference", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
  it("finds ${VAR} in env values and header values only", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
    expect(usesEnvReference({ transport: "stdio", command: "x", env: { K: "${K}" } })).toBe(true);
    expect(usesEnvReference({ transport: "stdio", command: "x", env: { K: "lit" } })).toBe(false);
    expect(
      usesEnvReference({
        transport: "http",
        url: "https://a.test/mcp",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
        headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
      }),
    ).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
    expect(usesEnvReference({ transport: "http", url: "https://a.test/${X}" })).toBe(false);
  });
});

describe("composable plans", () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await setupAdapterSandbox();
  });
  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  it("marks planJsonKeyPatch plans composable, both noop and patch", async () => {
    const existing = join(sb.repo, "marks.json");
    await writeFile(existing, '{"mcpServers":{"a":{"command":"a"}}}\n', "utf8");

    const noop = await planJsonKeyPatch(createNodeFs(), {
      scope: "user",
      path: existing,
      keyPath: ["mcpServers", "a"],
      value: { command: "a" },
      summary: "noop",
      warnings: [],
      expected: [],
    });
    const patch = await planJsonKeyPatch(createNodeFs(), {
      scope: "user",
      path: existing,
      keyPath: ["mcpServers", "b"],
      value: { command: "b" },
      summary: "patch",
      warnings: [],
      expected: [],
    });
    expect(noop.action).toBe("noop");
    expect(noop.composable).toBe(true);
    expect(patch.action).toBe("patch-json");
    expect(patch.composable).toBe(true);
  });

  it("leaves composable undefined on advisory plans", () => {
    const plan = advisoryPlan("local", join(sb.repo, "AGENTS.local.md"), "skip", ["w"]);
    expect(plan.composable).toBeUndefined();
  });

  it("lets two key-scoped plans share one missing file when applied in order", async () => {
    const path = join(sb.repo, "shared.json");
    const first = await planJsonKeyPatch(createNodeFs(), {
      scope: "user",
      path,
      keyPath: ["a"],
      value: 1,
      summary: "first",
      warnings: [],
      expected: [],
    });
    const second = await planJsonKeyPatch(createNodeFs(), {
      scope: "user",
      path,
      keyPath: ["b", "c"],
      value: 2,
      summary: "second",
      warnings: [],
      expected: [],
    });
    // Both plans were made before either applies, so both saw the file as missing.
    expect(first.before).toBeUndefined();
    expect(second.before).toBeUndefined();

    const ctx = makeApplyContext(sb);
    await first.apply(ctx);
    await second.apply(ctx);

    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(parsed).toEqual({ a: 1, b: { c: 2 } });
  });
});
