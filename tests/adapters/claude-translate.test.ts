import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeStateError } from "../../src/adapters/base.js";
import {
  claudePaths,
  claudeRepoKey,
  disabledMcpjsonKey,
  disabledServersKey,
  fromClaudeEntry,
  localMcpKey,
  projectEntry,
  readClaudeServers,
  readNameList,
  toClaudeEntry,
} from "../../src/adapters/claude.js";
import { createNodeFs, toReadFs } from "../../src/core/fs-safe.js";
import type { JsonValue } from "../../src/core/json-text.js";
import { parseJsonText } from "../../src/core/json-text.js";
import type { McpServerDefinition } from "../../src/core/schema.js";
import { cleanupSandbox, copyFixture, type Sandbox, setupAdapterSandbox } from "./helpers.js";

const readFs = toReadFs(createNodeFs());

async function readJsonFixture(sb: Sandbox, from: string, to: string): Promise<JsonValue> {
  await copyFixture(sb, from, to);
  return parseJsonText(await readFile(to, "utf8"));
}

describe("claudePaths", () => {
  it("uses the home directory when CLAUDE_CONFIG_DIR is absent", () => {
    const paths = claudePaths("/h", {}, "/r");
    expect(paths.userConfig).toBe("/h/.claude.json");
    expect(paths.userInstructions).toBe("/h/.claude/CLAUDE.md");
    expect(paths.projectMcp).toBe("/r/.mcp.json");
    expect(paths.projectInstructions).toBe("/r/CLAUDE.md");
    expect(paths.localInstructions).toBe("/r/CLAUDE.local.md");
  });

  it("moves user files into an absolute CLAUDE_CONFIG_DIR", () => {
    const paths = claudePaths("/h", { CLAUDE_CONFIG_DIR: "/cfg" }, "/r");
    expect(paths.userConfig).toBe("/cfg/.claude.json");
    expect(paths.userInstructions).toBe("/cfg/CLAUDE.md");
    expect(paths.projectMcp).toBe("/r/.mcp.json");
  });

  it("ignores a relative CLAUDE_CONFIG_DIR", () => {
    const paths = claudePaths("/h", { CLAUDE_CONFIG_DIR: "cfg" }, "/r");
    expect(paths.userConfig).toBe("/h/.claude.json");
    expect(paths.userInstructions).toBe("/h/.claude/CLAUDE.md");
  });
});

describe("key paths", () => {
  it("builds the projects keys", () => {
    expect(localMcpKey("/r")).toEqual(["projects", "/r", "mcpServers"]);
    expect(disabledServersKey("/r")).toEqual(["projects", "/r", "disabledMcpServers"]);
    expect(disabledMcpjsonKey("/r")).toEqual(["projects", "/r", "disabledMcpjsonServers"]);
  });
});

describe("claudeRepoKey", () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await setupAdapterSandbox();
  });
  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  it("returns the realpath of a symlinked repository", async () => {
    const link = join(sb.root, "link");
    await symlink(sb.repo, link);
    expect(await claudeRepoKey(readFs, link)).toBe(sb.repo);
  });

  it("falls back to the given path when it does not exist", async () => {
    const missing = join(sb.root, "missing");
    expect(await claudeRepoKey(readFs, missing)).toBe(missing);
  });
});

describe("toClaudeEntry and fromClaudeEntry round trip", () => {
  const cases: [string, McpServerDefinition][] = [
    [
      "stdio",
      {
        transport: "stdio",
        command: "npx",
        args: ["-y", "pkg"],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
        env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      },
    ],
    [
      "http",
      {
        transport: "http",
        url: "https://mcp.test/mcp",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
        headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
      },
    ],
    ["sse", { transport: "sse", url: "https://sse.test/sse" }],
  ];

  for (const [name, def] of cases) {
    it(`round-trips ${name} with no extras`, () => {
      const entry = toClaudeEntry(def);
      expect(Object.keys(entry)[0]).toBe("type");
      expect(fromClaudeEntry("srv", entry, "p")).toEqual({ kind: "managed", def, extras: {} });
    });
  }

  it("refuses to translate a disabled server", () => {
    expect(() => toClaudeEntry({ transport: "stdio", command: "x", enabled: false })).toThrow();
  });
});

describe("fromClaudeEntry", () => {
  it("treats a missing type with a command as stdio", () => {
    const entry = fromClaudeEntry("fs", { command: "npx", args: ["-y", "x"] }, "p");
    expect(entry).toEqual({
      kind: "managed",
      def: { transport: "stdio", command: "npx", args: ["-y", "x"] },
      extras: {},
    });
  });

  it("reports an entry with no type and no command as opaque", () => {
    expect(fromClaudeEntry("n", { url: "https://x.test" }, "p")).toEqual({
      kind: "opaque",
      raw: { url: "https://x.test" },
      reason: "no type",
    });
  });

  it("reports an unknown transport as opaque and keeps it verbatim", () => {
    const raw = { type: "ws", url: "ws://w.test" };
    expect(fromClaudeEntry("wsy", raw, "p")).toEqual({
      kind: "opaque",
      raw,
      reason: 'type "ws"',
    });
  });

  it("keeps unknown in-entry keys as extras", () => {
    const entry = fromClaudeEntry(
      "oauthy",
      { type: "http", url: "https://o.test/mcp", oauth: { clientId: "abc" }, timeout: 5 },
      "p",
    );
    expect(entry).toEqual({
      kind: "managed",
      def: { transport: "http", url: "https://o.test/mcp" },
      extras: { oauth: { clientId: "abc" }, timeout: 5 },
    });
  });

  it("rejects a non-string type", () => {
    expect(() => fromClaudeEntry("bad", { type: 3, command: "bad" }, "p")).toThrow(
      NativeStateError,
    );
  });

  it("rejects an invalid server name", () => {
    expect(() => fromClaudeEntry("-bad", { type: "stdio", command: "x" }, "p")).toThrow(
      NativeStateError,
    );
  });

  it("rejects an owned key that does not fit the transport", () => {
    expect(() =>
      fromClaudeEntry("s", { type: "stdio", command: "x", url: "https://x.test" }, "p"),
    ).toThrow(NativeStateError);
    expect(() =>
      fromClaudeEntry("h", { type: "http", url: "https://x.test", command: "x" }, "p"),
    ).toThrow(NativeStateError);
  });
});

describe("readClaudeServers and readNameList (fixtures)", () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await setupAdapterSandbox();
  });
  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  it("reads the user config with corrupt, opaque, and extra-key entries", async () => {
    const path = join(sb.home, ".claude.json");
    const root = await readJsonFixture(sb, "claude/home/.claude.json", path);
    const user = (root as { mcpServers: JsonValue }).mcpServers;
    const map = readClaudeServers(user, path);
    expect([...map.keys()]).toEqual(["old", "oauthy", "wsy"]);
    expect(map.get("old")).toEqual({
      kind: "managed",
      def: {
        transport: "stdio",
        command: "old",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
        env: { TOKEN: "${OLD_TOKEN}" },
      },
      extras: {},
    });
    expect(map.get("wsy")).toEqual({
      kind: "opaque",
      raw: { type: "ws", url: "ws://w.test" },
      reason: 'type "ws"',
    });
    expect(map.get("oauthy")?.kind).toBe("managed");
  });

  it("reads the project .mcp.json with a server that has no type", async () => {
    const path = join(sb.repo, ".mcp.json");
    const root = await readJsonFixture(sb, "claude/repo/.mcp.json", path);
    const map = readClaudeServers((root as { mcpServers: JsonValue }).mcpServers, path);
    expect(map.get("fs")).toEqual({
      kind: "managed",
      def: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      },
      extras: {},
    });
  });

  it("returns an empty map for an absent mcpServers key", () => {
    expect(readClaudeServers(undefined, "p").size).toBe(0);
  });

  it("throws for each invalid fixture", async () => {
    const names = [
      "args-not-array.json",
      "bad-name.json",
      "env-number.json",
      "servers-not-object.json",
      "type-number.json",
    ];
    for (const name of names) {
      const path = join(sb.repo, name);
      const root = await readJsonFixture(sb, `claude/invalid/${name}`, path);
      expect(() => readClaudeServers((root as { mcpServers: JsonValue }).mcpServers, path)).toThrow(
        NativeStateError,
      );
    }
  });

  it("rejects a non-array disabled list", async () => {
    const path = join(sb.home, ".claude.json");
    const root = await readJsonFixture(sb, "claude/invalid/disabled-list.claude.json", path);
    const entry = projectEntry(root, sb.repo, path);
    expect(() => readNameList(entry?.disabledMcpServers, path, "disabledMcpServers")).toThrow(
      NativeStateError,
    );
  });

  it("reads project entries and name lists from the user config", async () => {
    const path = join(sb.home, ".claude.json");
    const root = await readJsonFixture(sb, "claude/home/.claude.json", path);
    const entry = projectEntry(root, sb.repo, path);
    expect(entry).toBeDefined();
    expect(readNameList(entry?.disabledMcpServers, path, "disabledMcpServers")).toEqual(["other"]);
    expect(readNameList(entry?.disabledMcpjsonServers, path, "disabledMcpjsonServers")).toEqual([]);
    expect(readNameList(undefined, path, "x")).toEqual([]);
    expect(projectEntry(root, join(sb.root, "absent"), path)).toBeUndefined();
    expect(projectEntry(undefined, sb.repo, path)).toBeUndefined();
  });

  it("throws when projects is not an object", () => {
    expect(() => projectEntry(parseJsonText('{"projects": []}'), "/r", "p")).toThrow(
      NativeStateError,
    );
  });
});
