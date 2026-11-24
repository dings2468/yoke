import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createYokeDefaults,
  type ResolvedMcpServer,
  ResolvedYokeConfigSchema,
} from "../../src/core/schema.js";

function readFixture(relative: string): unknown {
  const url = new URL(`../fixtures/schema/resolved/${relative}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("ResolvedYokeConfig schema", () => {
  it("parses the valid fixture", () => {
    const parsed = ResolvedYokeConfigSchema.parse(readFixture("valid.json"));
    expect(Object.keys(parsed.mcps)).toEqual(["filesystem", "docs"]);
    expect(parsed.mcps.filesystem?.scopes).toEqual(["user", "local"]);
    expect(parsed.mcps.docs?.enabled).toBe(false);
    expect(parsed.layers.project?.version).toBe(1);
  });

  it("rejects a disabled stub in mcps", () => {
    expect(() =>
      ResolvedYokeConfigSchema.parse(readFixture("invalid-stub-in-mcps.json")),
    ).toThrow();
  });

  it("rejects a server without an explicit enabled", () => {
    expect(() =>
      ResolvedYokeConfigSchema.parse(readFixture("invalid-missing-enabled.json")),
    ).toThrow();
  });

  it("rejects a server with empty scopes", () => {
    expect(() =>
      ResolvedYokeConfigSchema.parse(readFixture("invalid-empty-scopes.json")),
    ).toThrow();
  });

  it("rejects a config without session", () => {
    expect(() =>
      ResolvedYokeConfigSchema.parse(readFixture("invalid-missing-session.json")),
    ).toThrow();
  });

  it("rejects unknown top-level keys", () => {
    const withExtra = { ...(readFixture("valid.json") as object), mcpServers: {} };
    expect(() => ResolvedYokeConfigSchema.parse(withExtra)).toThrow();
  });
});

describe("createYokeDefaults", () => {
  it("returns a new object on each call", () => {
    const first = createYokeDefaults();
    const second = createYokeDefaults();
    expect(first).not.toBe(second);
    expect(first.instructions).not.toBe(second.instructions);
    expect(first.harnesses).not.toBe(second.harnesses);
  });

  it("returns the documented default values", () => {
    expect(createYokeDefaults()).toEqual({
      mode: "compiled",
      harnesses: [],
      instructions: { source: "AGENTS.md", preferSymlink: true },
      session: { maxTurns: 40, includeGitDiffStat: true },
    });
  });

  it("combines with empty mcps and layers into a parseable resolved config", () => {
    const resolved = { version: 1, ...createYokeDefaults(), mcps: {}, layers: {} };
    expect(() => ResolvedYokeConfigSchema.parse(resolved)).not.toThrow();
  });
});

describe("resolved types", () => {
  it("types enabled as a required boolean", () => {
    expectTypeOf<ResolvedMcpServer["enabled"]>().toEqualTypeOf<boolean>();
  });
});
