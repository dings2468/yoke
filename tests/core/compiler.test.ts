import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type CompileErrorCode,
  compileForTarget,
  compileInstructions,
  detectEol,
  GENERATED_HEADER,
  hasGeneratedHeader,
  InstructionCompileError,
  parseConditionalBlocks,
} from "../../src/core/compiler.js";

const FIXTURES = new URL("../fixtures/core/compiler/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), "utf8");
}

function errorOf(fn: () => unknown): InstructionCompileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof InstructionCompileError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected InstructionCompileError");
}

describe("compileForTarget", () => {
  it("keeps the claude text and drops the agy text for the SPEC §4.2 example", async () => {
    const text = await fixture("spec-4-2.md");
    const out = compileForTarget(text, "claude");
    expect(out).toContain("Use the native Edit tool for surgical refactors.");
    expect(out).not.toContain("Summarize large directory scans");
    expect(out).not.toContain("yoke:");
    expect(out).toContain("Shared rule for every harness.");
  });

  it("keeps the agy text and drops the claude text for the SPEC §4.2 example", async () => {
    const text = await fixture("spec-4-2.md");
    const out = compileForTarget(text, "agy");
    expect(out).toContain("Summarize large directory scans before proposing edits.");
    expect(out).not.toContain("Use the native Edit tool");
    expect(out).not.toContain("yoke:");
    expect(out).toContain("Shared rule for every harness.");
  });

  it("drops every conditional block for an unknown target", async () => {
    const text = await fixture("spec-4-2.md");
    const out = compileForTarget(text, "x");
    expect(out).not.toContain("Use the native Edit tool");
    expect(out).not.toContain("Summarize large directory scans");
    expect(out).not.toContain("yoke:");
    expect(out).toContain("Shared rule for every harness.");
  });

  it("ignores tags inside fenced code blocks", async () => {
    const text = await fixture("fenced-docs.md");
    const parsed = parseConditionalBlocks(text);
    expect(parsed.blocks).toEqual([]);
    expect(compileForTarget(text, "claude")).toBe(text);
  });

  it("keeps CRLF line endings verbatim", () => {
    const text =
      "one\r\n<!-- yoke:claude-only -->\r\nclaude\r\n<!-- /yoke:claude-only -->\r\ntwo\r\n";
    expect(compileForTarget(text, "claude")).toBe("one\r\nclaude\r\ntwo\r\n");
    expect(compileForTarget(text, "agy")).toBe("one\r\ntwo\r\n");
  });

  it("does not collapse blank lines", () => {
    const text = "a\n\n<!-- yoke:agy-only -->\nx\n<!-- /yoke:agy-only -->\n\nb\n";
    expect(compileForTarget(text, "claude")).toBe("a\n\n\nb\n");
  });
});

describe("parseConditionalBlocks", () => {
  it("reports blocks with line numbers and unique targets in first-seen order", () => {
    const text = [
      "<!-- yoke:agy-only -->",
      "a",
      "<!-- /yoke:agy-only -->",
      "<!-- yoke:claude-only -->",
      "b",
      "<!-- /yoke:claude-only -->",
      "<!-- yoke:agy-only -->",
      "c",
      "<!-- /yoke:agy-only -->",
    ].join("\n");
    const parsed = parseConditionalBlocks(text);
    expect(parsed.targets).toEqual(["agy", "claude"]);
    expect(parsed.blocks).toEqual([
      { target: "agy", openLine: 1, closeLine: 3 },
      { target: "claude", openLine: 4, closeLine: 6 },
      { target: "agy", openLine: 7, closeLine: 9 },
    ]);
  });

  it("accepts any target when validTargets is not given", () => {
    expect(
      parseConditionalBlocks("<!-- yoke:opencode-only -->\nx\n<!-- /yoke:opencode-only -->")
        .targets,
    ).toEqual(["opencode"]);
  });
});

describe("parse errors", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly text: string;
    readonly code: CompileErrorCode;
    readonly line: number;
    readonly validTargets?: readonly string[];
  }> = [
    {
      name: "unclosed",
      text: "ok\n<!-- yoke:claude-only -->\nbody\n",
      code: "unclosed",
      line: 2,
    },
    {
      name: "nested",
      text: "<!-- yoke:claude-only -->\n<!-- yoke:agy-only -->\nx\n<!-- /yoke:agy-only -->\n<!-- /yoke:claude-only -->",
      code: "nested",
      line: 2,
    },
    {
      name: "unmatched-close",
      text: "body\n<!-- /yoke:claude-only -->\n",
      code: "unmatched-close",
      line: 2,
    },
    {
      name: "mismatched-close",
      text: "<!-- yoke:claude-only -->\nx\n<!-- /yoke:agy-only -->\n",
      code: "mismatched-close",
      line: 3,
    },
    {
      name: "malformed-tag",
      text: "ok\n<!-- yoke:claude-onyl -->\n",
      code: "malformed-tag",
      line: 2,
    },
    {
      name: "unknown-target",
      text: "<!-- yoke:x-only -->\nx\n<!-- /yoke:x-only -->\n",
      code: "unknown-target",
      line: 1,
      validTargets: ["claude", "agy"],
    },
  ];

  for (const testCase of cases) {
    it(`reports ${testCase.code} at line ${testCase.line}`, () => {
      const error = errorOf(() =>
        parseConditionalBlocks(
          testCase.text,
          testCase.validTargets === undefined ? undefined : { validTargets: testCase.validTargets },
        ),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(testCase.code);
      expect(error.line).toBe(testCase.line);
      expect(error.name).toBe("InstructionCompileError");
    });
  }

  it("rejects a malformed tag inside compileForTarget too", () => {
    expect(() => compileForTarget("<!-- /yoke:claude -->\n", "claude")).toThrow(
      InstructionCompileError,
    );
  });
});

describe("detectEol and hasGeneratedHeader", () => {
  it("detects CRLF and LF", () => {
    expect(detectEol("a\r\nb")).toBe("\r\n");
    expect(detectEol("a\nb")).toBe("\n");
    expect(detectEol("no newline")).toBe("\n");
  });

  it("recognizes the header in compiled output and not in plain text", () => {
    const compiled = compileInstructions({ source: "hello\n", target: "claude" });
    expect(hasGeneratedHeader(compiled)).toBe(true);
    expect(hasGeneratedHeader("hello\n")).toBe(false);
  });

  it("accepts a BOM and CRLF after the header", () => {
    expect(hasGeneratedHeader(`﻿${GENERATED_HEADER}\r\nbody`)).toBe(true);
  });
});

describe("compileInstructions", () => {
  it("prefixes the header and uses the source EOL", () => {
    expect(compileInstructions({ source: "a\r\nb\r\n", target: "claude" })).toBe(
      `${GENERATED_HEADER}\r\na\r\nb\r\n`,
    );
  });

  it("adds a final newline when the source has none", () => {
    expect(compileInstructions({ source: "a", target: "claude" })).toBe(`${GENERATED_HEADER}\na\n`);
  });

  it("appends local overrides after a blank line", () => {
    const out = compileInstructions({
      source: "shared\n",
      local: "mine\n",
      target: "claude",
    });
    expect(out).toBe(`${GENERATED_HEADER}\nshared\n\nmine\n`);
  });

  it("adds only the header to a file with no tags", () => {
    const text = "# Plain\n\nNo blocks here.\n";
    expect(compileInstructions({ source: text, target: "claude" })).toBe(
      `${GENERATED_HEADER}\n${text}`,
    );
  });

  it("forwards validTargets to the parser", () => {
    expect(() =>
      compileInstructions({
        source: "<!-- yoke:x-only -->\nx\n<!-- /yoke:x-only -->\n",
        target: "claude",
        validTargets: ["claude", "agy"],
      }),
    ).toThrow(InstructionCompileError);
  });
});
