import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type NativeInstructions,
  NativeInstructionsSchema,
  type PartialYokeConfig,
  PartialYokeConfigSchema,
  type Scope,
} from "../../src/core/schema.js";

function readFixture(relative: string): unknown {
  const url = new URL(`../fixtures/schema/native/${relative}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("PartialYokeConfig native reverse-read schema", () => {
  it("parses the multi-scope fixture", () => {
    const parsed = PartialYokeConfigSchema.parse(readFixture("valid-multi-scope.json"));
    expect(Object.keys(parsed.user?.mcps ?? {})).toEqual(["filesystem", "docs"]);
    expect(parsed.project?.mcps.linear?.transport).toBe("http");
    expect(parsed.local?.mcps).toEqual({});
  });

  it("keeps the local tier as read-but-empty and absent tiers as absent", () => {
    const parsed = PartialYokeConfigSchema.parse(readFixture("valid-multi-scope.json"));
    expect("local" in parsed).toBe(true);
    expect(parsed.local).toEqual({ mcps: {} });

    const empty = PartialYokeConfigSchema.parse(readFixture("valid-empty.json"));
    expect(empty).toEqual({});
    expect("user" in empty).toBe(false);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test title documents literal ${VAR} syntax
  it("keeps ${VAR} header references byte-for-byte", () => {
    const parsed = PartialYokeConfigSchema.parse(readFixture("valid-multi-scope.json"));
    const linear = parsed.project?.mcps.linear;
    expect(linear && linear.transport === "http" ? linear.headers?.Authorization : undefined).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the expected value
      "Bearer ${LINEAR_API_KEY}",
    );
  });

  it("narrows instructions on kind: content for files, target for symlinks", () => {
    const parsed = PartialYokeConfigSchema.parse(readFixture("valid-multi-scope.json"));
    const userInstructions = parsed.user?.instructions;
    const projectInstructions = parsed.project?.instructions;

    expect(userInstructions?.kind).toBe("file");
    if (userInstructions?.kind === "file") {
      expectTypeOf(userInstructions.content).toEqualTypeOf<string>();
      expect(userInstructions.content).toContain("Prefer small commits.");
    }

    expect(projectInstructions?.kind).toBe("symlink");
    if (projectInstructions?.kind === "symlink") {
      expectTypeOf(projectInstructions.target).toEqualTypeOf<string>();
      expect(projectInstructions.target).toBe("AGENTS.md");
    }
  });

  it("types the instruction union with exactly two kinds", () => {
    expectTypeOf<NativeInstructions["kind"]>().toEqualTypeOf<"file" | "symlink">();
    expectTypeOf<NativeInstructions>().toEqualTypeOf<
      | { kind: "file"; path: string; content: string }
      | { kind: "symlink"; path: string; target: string }
    >();
  });

  it("types the top-level keys as exactly the three scopes", () => {
    expectTypeOf<keyof PartialYokeConfig>().toEqualTypeOf<Scope>();
  });

  it.each(["invalid-stub.json", "invalid-scope.json", "invalid-instructions-kind.json"])(
    "rejects %s",
    (file) => {
      expect(PartialYokeConfigSchema.safeParse(readFixture(file)).success).toBe(false);
    },
  );

  it("rejects a disabled stub inside native state with a path into mcps", () => {
    const result = PartialYokeConfigSchema.safeParse(readFixture("invalid-stub.json"));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        "project.mcps.github.transport",
      );
    }
  });

  it("rejects a symlink instruction with content and a file instruction with target", () => {
    expect(
      NativeInstructionsSchema.safeParse({ kind: "symlink", path: "CLAUDE.md", content: "x" })
        .success,
    ).toBe(false);
    expect(
      NativeInstructionsSchema.safeParse({ kind: "file", path: "CLAUDE.md", target: "AGENTS.md" })
        .success,
    ).toBe(false);
  });
});
