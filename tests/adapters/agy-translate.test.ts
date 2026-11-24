/**
 * tests/adapters/agy-translate.test.ts: agy paths and MCP entry translation (AG1).
 * Fixtures are copied into a sandbox. The real ~/.gemini is never touched.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGY_MCP_KEY,
  agyPaths,
  fromAgyEntry,
  readAgyServers,
  toAgyEntry,
} from "../../src/adapters/agy.js";
import { NativeStateError } from "../../src/adapters/base.js";
import { getAtPath, type JsonValue, parseJsonText } from "../../src/core/json-text.js";
import type { McpServerDefinition } from "../../src/core/schema.js";
import { cleanupSandbox, copyFixture, type Sandbox, setupAdapterSandbox } from "./helpers.js";

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference copied verbatim from the fixture
const LITERAL_REF = "${K}";

describe("agy translation", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await setupAdapterSandbox();
  });

  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  /** Copies a fixture into the sandbox and returns its parsed root. */
  async function loadFixture(from: string, to: string): Promise<{ root: JsonValue; path: string }> {
    const path = join(sb.root, to);
    await copyFixture(sb, from, path);
    const text = await readFile(path, "utf8");
    return { root: parseJsonText(text), path };
  }

  it("resolves agy paths under the home and repo directories", () => {
    expect(agyPaths("/h", "/r")).toStrictEqual({
      mcpConfig: "/h/.gemini/config/mcp_config.json",
      userInstructions: "/h/.gemini/GEMINI.md",
      projectInstructions: "/r/GEMINI.md",
    });
  });

  it("reads every entry in the mcp_config fixture in native key order", async () => {
    const { root, path } = await loadFixture(
      "agy/home/.gemini/config/mcp_config.json",
      "home/.gemini/config/mcp_config.json",
    );
    const servers = readAgyServers(getAtPath(root, AGY_MCP_KEY), path);

    expect([...servers.keys()]).toStrictEqual(["remote", "legacy", "off", "local", "tool", "wsy"]);
    expect(servers.get("remote")).toStrictEqual({
      kind: "managed",
      def: { transport: "http", url: "https://a.test/mcp" },
      extras: {},
    });
    expect(servers.get("legacy")).toStrictEqual({
      kind: "managed",
      def: { transport: "http", url: "https://b.test/mcp" },
      extras: {},
    });
    expect(servers.get("off")).toStrictEqual({
      kind: "managed",
      def: { transport: "stdio", command: "x", enabled: false },
      extras: {},
    });
    expect(servers.get("local")).toStrictEqual({
      kind: "managed",
      def: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "s"],
        env: { K: LITERAL_REF },
      },
      extras: {},
    });
    expect(servers.get("tool")).toStrictEqual({
      kind: "managed",
      def: { transport: "stdio", command: "t" },
      extras: { trust: true, timeout: 5 },
    });
    expect(servers.get("wsy")).toStrictEqual({
      kind: "opaque",
      raw: { type: "ws", url: "ws://w.test" },
      reason: 'type "ws"',
    });
  });

  it.each([
    "both-urls.json",
    "disabled-string.json",
    "env-number.json",
    "http-url.json",
    "type-mismatch.json",
  ])("throws NativeStateError for the corrupt fixture invalid/%s", async (name) => {
    const { root, path } = await loadFixture(`agy/invalid/${name}`, `invalid/${name}`);
    expect(() => readAgyServers(getAtPath(root, AGY_MCP_KEY), path)).toThrow(NativeStateError);
  });

  it("returns an empty map when mcpServers is absent and throws when it is not an object", () => {
    expect(readAgyServers(undefined, "p").size).toBe(0);
    expect(() => readAgyServers([], "p")).toThrow(NativeStateError);
  });

  it("writes http servers with url and never serverUrl", () => {
    const def: McpServerDefinition = {
      transport: "http",
      url: "https://a.test/mcp",
      headers: { Authorization: "Bearer x" },
    };
    const entry = toAgyEntry(def, true);
    expect(entry).toStrictEqual({
      url: "https://a.test/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(entry).not.toHaveProperty("serverUrl");
  });

  it("round-trips a stdio server with args and env", () => {
    const def: McpServerDefinition = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "s"],
      env: { TOKEN: "abc" },
    };
    const entry = toAgyEntry(def, true);
    expect(entry).toStrictEqual({ command: "npx", args: ["-y", "s"], env: { TOKEN: "abc" } });
    expect(fromAgyEntry("s", entry, "p")).toStrictEqual({ kind: "managed", def, extras: {} });
  });

  it("writes disabled: true only for a disabled server and reads it back as enabled: false", () => {
    const def: McpServerDefinition = { transport: "http", url: "https://a.test/mcp" };
    const entry = toAgyEntry(def, false);
    expect(entry).toStrictEqual({ url: "https://a.test/mcp", disabled: true });
    expect(fromAgyEntry("r", entry, "p")).toStrictEqual({
      kind: "managed",
      def: { transport: "http", url: "https://a.test/mcp", enabled: false },
      extras: {},
    });
  });

  it("omits enabled when disabled is false", () => {
    expect(fromAgyEntry("x", { command: "c", disabled: false }, "p")).toStrictEqual({
      kind: "managed",
      def: { transport: "stdio", command: "c" },
      extras: {},
    });
  });

  it("reads serverUrl, and accepts url and serverUrl when they are equal", () => {
    expect(fromAgyEntry("l", { serverUrl: "https://b.test/mcp" }, "p")).toStrictEqual({
      kind: "managed",
      def: { transport: "http", url: "https://b.test/mcp" },
      extras: {},
    });
    expect(
      fromAgyEntry("l", { url: "https://b.test/mcp", serverUrl: "https://b.test/mcp" }, "p"),
    ).toStrictEqual({
      kind: "managed",
      def: { transport: "http", url: "https://b.test/mcp" },
      extras: {},
    });
  });

  it("keeps a matching type as an extra", () => {
    expect(fromAgyEntry("t", { type: "stdio", command: "c", trust: true }, "p")).toStrictEqual({
      kind: "managed",
      def: { transport: "stdio", command: "c" },
      extras: { type: "stdio", trust: true },
    });
  });

  it("returns opaque for an entry with neither a command nor a url", () => {
    expect(fromAgyEntry("n", { disabled: true }, "p")).toStrictEqual({
      kind: "opaque",
      raw: { disabled: true },
      reason: "no command or url",
    });
  });

  it("rejects an invalid server name, a non-object entry, and a non-string args array", () => {
    expect(() => fromAgyEntry("bad name", { command: "c" }, "p")).toThrow(NativeStateError);
    expect(() => fromAgyEntry("ok", "c", "p")).toThrow(NativeStateError);
    expect(() => fromAgyEntry("ok", { command: "c", args: [1] }, "p")).toThrow(NativeStateError);
  });
});
