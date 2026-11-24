import { describe, expect, expectTypeOf, it } from "vitest";
import {
  HarnessNameSchema,
  IsoDateTimeSchema,
  McpServerNameSchema,
  SCOPES,
  type Scope,
  ScopeSchema,
  Sha256HexSchema,
} from "../../src/core/schema.js";

describe("shared primitives", () => {
  it("SCOPES lists user, project, local in precedence order", () => {
    expect(SCOPES).toEqual(["user", "project", "local"]);
  });

  it("ScopeSchema rejects unknown scopes", () => {
    expect(ScopeSchema.safeParse("global").success).toBe(false);
    expect(ScopeSchema.safeParse("local").success).toBe(true);
  });

  it("Scope type is the union of scope names", () => {
    expectTypeOf<Scope>().toEqualTypeOf<"user" | "project" | "local">();
  });

  it("HarnessNameSchema accepts valid adapter ids", () => {
    for (const name of ["claude", "agy", "gemini-cli"]) {
      expect(HarnessNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("HarnessNameSchema rejects uppercase, colons, empty, and leading dash", () => {
    for (const name of ["Claude", "a:b", "", "-x"]) {
      expect(HarnessNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("McpServerNameSchema accepts valid names", () => {
    for (const name of ["filesystem", "my_server.v2", "linear-1"]) {
      expect(McpServerNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("McpServerNameSchema rejects empty, leading dot, and spaces", () => {
    for (const name of ["", ".hidden", "has space"]) {
      expect(McpServerNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("Sha256HexSchema accepts 64 lower-case hex chars", () => {
    expect(Sha256HexSchema.safeParse("a".repeat(64)).success).toBe(true);
  });

  it("Sha256HexSchema rejects uppercase hex and wrong length", () => {
    expect(Sha256HexSchema.safeParse("A".repeat(64)).success).toBe(false);
    expect(Sha256HexSchema.safeParse("a".repeat(63)).success).toBe(false);
  });

  it("IsoDateTimeSchema accepts Z and numeric offsets", () => {
    expect(IsoDateTimeSchema.safeParse("2026-11-24T10:00:00.123Z").success).toBe(true);
    expect(IsoDateTimeSchema.safeParse("2026-11-24T10:00:00+01:00").success).toBe(true);
  });

  it("IsoDateTimeSchema rejects a bare date", () => {
    expect(IsoDateTimeSchema.safeParse("2026-11-24").success).toBe(false);
  });
});
