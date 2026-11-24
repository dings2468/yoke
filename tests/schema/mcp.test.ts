import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isMcpDisabledStub,
  McpHttpServerSchema,
  type McpServerEntry,
  McpServerEntrySchema,
  McpServersSchema,
  McpStdioServerSchema,
  RemoteUrlSchema,
} from "../../src/core/schema.js";

function readFixture(relative: string): unknown {
  const url = new URL(`../fixtures/schema/mcp/${relative}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("MCP server entry schemas", () => {
  it("parses the valid fixture", () => {
    const parsed = McpServersSchema.parse(readFixture("valid.json"));
    expect(Object.keys(parsed)).toEqual(["filesystem", "linear", "github", "docs", "scratch"]);
  });

  it("keeps ${VAR} header references byte-for-byte", () => {
    const parsed = McpServersSchema.parse(readFixture("valid.json"));
    const linear = parsed.linear;
    expect(linear && linear.transport === "http" ? linear.headers?.Authorization : undefined).toBe(
      `Bearer \${LINEAR_API_KEY}`,
    );
  });

  it("treats only the github entry as a disabled stub", () => {
    const parsed = McpServersSchema.parse(readFixture("valid.json"));
    const stubs = Object.entries(parsed)
      .filter(([, entry]) => isMcpDisabledStub(entry))
      .map(([name]) => name);
    expect(stubs).toEqual(["github"]);
  });

  it.each([
    "invalid-unknown-transport.json",
    "invalid-stub-with-fields.json",
    "invalid-stub-enabled-true.json",
    "invalid-env-number.json",
    "invalid-env-null.json",
    "invalid-extra-key.json",
  ])("rejects %s", (file) => {
    expect(McpServersSchema.safeParse(readFixture(file)).success).toBe(false);
  });

  it("accepts https URLs and ${VAR} prefixed URLs, and rejects others", () => {
    expect(RemoteUrlSchema.safeParse("https://mcp.linear.app/mcp").success).toBe(true);
    expect(RemoteUrlSchema.safeParse(`\${MCP_URL}/mcp`).success).toBe(true);
    expect(RemoteUrlSchema.safeParse("ftp://x").success).toBe(false);
    expect(RemoteUrlSchema.safeParse("mcp.linear.app").success).toBe(false);
  });

  it("rejects an http entry without url", () => {
    expect(McpHttpServerSchema.safeParse({ transport: "http" }).success).toBe(false);
  });

  it("rejects a stdio entry with an empty command", () => {
    expect(McpStdioServerSchema.safeParse({ transport: "stdio", command: "" }).success).toBe(false);
  });

  it("narrows on transport to reach stdio-only fields", () => {
    const entry: McpServerEntry = McpServerEntrySchema.parse({
      transport: "stdio",
      command: "npx",
    });
    expectTypeOf<McpServerEntry>().not.toBeAny();
    if (entry.transport === "stdio") {
      expectTypeOf(entry.command).toEqualTypeOf<string>();
      expect(entry.command).toBe("npx");
    }
  });
});
