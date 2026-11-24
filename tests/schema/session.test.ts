import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SESSION_ACTION_KINDS,
  SessionActionSchema,
  type YokeSessionIR,
  YokeSessionIRSchema,
} from "../../src/core/schema.js";

function loadFixture(name: string): unknown {
  const url = new URL(`../fixtures/schema/session/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

describe("YokeSessionIRSchema fixtures", () => {
  it.each(["valid.json", "valid-empty-turns.json"])("accepts %s", (name) => {
    expect(YokeSessionIRSchema.safeParse(loadFixture(name)).success).toBe(true);
  });

  it.each([
    "invalid-thinking.json",
    "invalid-signature.json",
    "invalid-action-kind.json",
    "invalid-multiline-summary.json",
    "invalid-id-traversal.json",
    "invalid-role.json",
  ])("rejects %s", (name) => {
    expect(YokeSessionIRSchema.safeParse(loadFixture(name)).success).toBe(false);
  });

  it("valid fixture keeps its three turns and the optional timestamp shape", () => {
    const parsed = YokeSessionIRSchema.parse(loadFixture("valid.json"));
    expect(parsed.turns).toHaveLength(3);
    expect(parsed.turns[1]?.actions).toHaveLength(2);
    expect(parsed.turns[2]?.timestamp).toBeUndefined();
  });
});

describe("SessionActionSchema", () => {
  it("lists the six action kinds", () => {
    expect(SESSION_ACTION_KINDS).toEqual(["read", "edit", "command", "search", "mcp", "other"]);
  });

  it("accepts a 300-character single-line summary", () => {
    const summary = "a".repeat(300);
    expect(SessionActionSchema.safeParse({ kind: "read", summary }).success).toBe(true);
  });

  it("rejects a 301-character summary", () => {
    const summary = "a".repeat(301);
    expect(SessionActionSchema.safeParse({ kind: "read", summary }).success).toBe(false);
  });

  it("rejects an empty summary", () => {
    expect(SessionActionSchema.safeParse({ kind: "read", summary: "" }).success).toBe(false);
  });

  it("rejects unknown keys on an action", () => {
    expect(
      SessionActionSchema.safeParse({ kind: "read", summary: "Read a.ts", output: "raw dump" })
        .success,
    ).toBe(false);
  });
});

describe("YokeSessionIR types", () => {
  it("turn role is the union of user and assistant", () => {
    expectTypeOf<YokeSessionIR["turns"][number]["role"]>().toEqualTypeOf<"user" | "assistant">();
  });
});
