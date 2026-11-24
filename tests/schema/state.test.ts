import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  StateEntrySchema,
  type StateKey,
  StateKeySchema,
  stateKey,
  YokeStateLockSchema,
} from "../../src/core/schema.js";

function loadFixture(name: string): unknown {
  const url = new URL(`../fixtures/schema/state/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("YokeStateLockSchema", () => {
  it.each(["valid.json", "valid-empty.json"])("accepts %s", (name) => {
    expect(YokeStateLockSchema.safeParse(loadFixture(name)).success).toBe(true);
  });

  it.each([
    "invalid-legacy-key.json",
    "invalid-hash-prefix.json",
    "invalid-hash-upper.json",
    "invalid-version.json",
    "invalid-missing-instructions-hash.json",
  ])("rejects %s", (name) => {
    expect(YokeStateLockSchema.safeParse(loadFixture(name)).success).toBe(false);
  });

  it("round-trips through JSON to a deep-equal value", () => {
    const parsed = YokeStateLockSchema.parse(loadFixture("valid.json"));
    const reparsed = YokeStateLockSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });
});

describe("StateKeySchema and stateKey", () => {
  it("stateKey builds <harness>:<scope>", () => {
    const key = stateKey("claude", "project");
    expect(key).toBe("claude:project");
    expect(StateKeySchema.safeParse(key).success).toBe(true);
    expectTypeOf(stateKey("agy", "user")).toEqualTypeOf<StateKey>();
  });

  it("rejects bare harness names, bad case, extra colons, and unknown scopes", () => {
    for (const bad of ["claude", "Claude:user", "a:b:user", "claude:global"]) {
      expect(StateKeySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("ownedNames", () => {
  const hash = "a".repeat(64);
  const baseEntry = { mcpHashes: { github: hash }, instructionsHash: null };

  it("parses a StateEntry without ownedNames", () => {
    expect(StateEntrySchema.safeParse(baseEntry).success).toBe(true);
  });

  it("parses ownedNames with a disabled-servers list", () => {
    const result = StateEntrySchema.safeParse({
      ...baseEntry,
      ownedNames: { "disabled-servers": ["github"] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed list id, server name, or non-array value", () => {
    const bad = [
      { Bad_Id: ["github"] },
      { "disabled-servers": ["-x"] },
      { "disabled-servers": "github" },
    ];
    for (const ownedNames of bad) {
      expect(StateEntrySchema.safeParse({ ...baseEntry, ownedNames }).success).toBe(false);
    }
  });
});
