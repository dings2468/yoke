import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
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
const VALID = ["claude", "agy"] as const;

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
    const out = compileForTarget(text, "claude", VALID);
    expect(out).toContain("Use the native Edit tool for surgical refactors.");
    expect(out).not.toContain("Summarize large directory scans");
    expect(out).not.toContain("yoke:");
    expect(out).toContain("Shared rule for every harness.");
  });

  it("keeps the agy text and drops the claude text for the SPEC §4.2 example", async () => {
    const text = await fixture("spec-4-2.md");
    const out = compileForTarget(text, "agy", VALID);
    expect(out).toContain("Summarize large directory scans before proposing edits.");
    expect(out).not.toContain("Use the native Edit tool");
    expect(out).not.toContain("yoke:");
    expect(out).toContain("Shared rule for every harness.");
  });

  it("drops every conditional block for a target outside the blocks", async () => {
    const text = await fixture("spec-4-2.md");
    const out = compileForTarget(text, "x", VALID);
    expect(out).not.toContain("Use the native Edit tool");
    expect(out).not.toContain("Summarize large directory scans");
    expect(out).not.toContain("yoke:");
    expect(out).toContain("Shared rule for every harness.");
  });

  it("ignores tags inside fenced code blocks", async () => {
    const text = await fixture("fenced-docs.md");
    const parsed = parseConditionalBlocks(text);
    expect(parsed.blocks).toEqual([]);
    expect(compileForTarget(text, "claude", VALID)).toBe(text);
  });

  it("keeps CRLF line endings verbatim", () => {
    const text =
      "one\r\n<!-- yoke:claude-only -->\r\nclaude\r\n<!-- /yoke:claude-only -->\r\ntwo\r\n";
    expect(compileForTarget(text, "claude", VALID)).toBe("one\r\nclaude\r\ntwo\r\n");
    expect(compileForTarget(text, "agy", VALID)).toBe("one\r\ntwo\r\n");
  });

  it("does not collapse blank lines", () => {
    const text = "a\n\n<!-- yoke:agy-only -->\nx\n<!-- /yoke:agy-only -->\n\nb\n";
    expect(compileForTarget(text, "claude", VALID)).toBe("a\n\n\nb\n");
  });

  it("requires validTargets as a non-optional string list", () => {
    expectTypeOf(compileForTarget).parameters.toEqualTypeOf<
      [text: string, target: string, validTargets: readonly string[]]
    >();
  });

  it("throws unknown-target for a misspelled block target", () => {
    const text = "<!-- yoke:cluade-only -->\nx\n<!-- /yoke:cluade-only -->\n";
    const error = errorOf(() => compileForTarget(text, "claude", VALID));
    expect(error.code).toBe("unknown-target");
    expect(error.line).toBe(1);
  });
});

describe("indented code", () => {
  it("keeps a 4-space indented claude-only block verbatim for every target", async () => {
    const text = await fixture("indented-code.md");
    expect(parseConditionalBlocks(text, { validTargets: VALID }).blocks).toEqual([]);
    for (const target of ["claude", "agy", "x"]) {
      expect(compileForTarget(text, target, VALID)).toBe(text);
    }
  });

  it("keeps an indented misspelled tag as ordinary text", () => {
    const text = "    <!-- yoke:cluade-only -->\n    x\n    <!-- /yoke:cluade-only -->\n";
    expect(compileForTarget(text, "claude", VALID)).toBe(text);
  });

  it("treats a 4-space fence as indented code, so later tags still count", () => {
    const text = "    ```md\n<!-- yoke:claude-only -->\nx\n<!-- /yoke:claude-only -->\n";
    const parsed = parseConditionalBlocks(text, { validTargets: VALID });
    expect(parsed.blocks).toEqual([{ target: "claude", openLine: 2, closeLine: 4 }]);
  });

  it("skips a fence nested in a list item when the fence is 0 to 3 spaces past the item", () => {
    const text = "- item\n\n  ```md\n<!-- yoke:claude-only -->\n```\n";
    expect(parseConditionalBlocks(text, { validTargets: VALID }).blocks).toEqual([]);
  });

  it("skips a fence nested in a list item indented 4 absolute spaces", () => {
    const text = "- item\n\n    ```md\n<!-- yoke:claude-only -->\n    ```\n";
    expect(parseConditionalBlocks(text, { validTargets: VALID }).blocks).toEqual([]);
  });

  it("does not treat a fence 4 or more spaces past a list item as a fence", () => {
    const text =
      "- item\n\n        ```md\n<!-- yoke:claude-only -->\nx\n<!-- /yoke:claude-only -->\n";
    expect(parseConditionalBlocks(text, { validTargets: VALID }).blocks).toEqual([
      { target: "claude", openLine: 4, closeLine: 6 },
    ]);
  });
});

describe("byte order mark", () => {
  it("strips a BOM from the source so the header is the first line", () => {
    expect(
      compileInstructions({ source: "﻿# Rules\n", target: "claude", validTargets: VALID }),
    ).toBe(`${GENERATED_HEADER}\n# Rules\n`);
  });

  it("strips a BOM from the local text before appending it", () => {
    expect(
      compileInstructions({
        source: "shared\n",
        local: "﻿mine\n",
        target: "claude",
        validTargets: VALID,
      }),
    ).toBe(`${GENERATED_HEADER}\nshared\n\nmine\n`);
  });

  it("finds a tag on the first line after a BOM", () => {
    const text = "﻿<!-- yoke:claude-only -->\nx\n<!-- /yoke:claude-only -->\n";
    expect(parseConditionalBlocks(text, { validTargets: VALID }).blocks).toEqual([
      { target: "claude", openLine: 1, closeLine: 3 },
    ]);
    expect(compileForTarget(text, "claude", VALID)).toBe("x\n");
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
    expect(() => compileForTarget("<!-- /yoke:claude -->\n", "claude", VALID)).toThrow(
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
    const compiled = compileInstructions({
      source: "hello\n",
      target: "claude",
      validTargets: VALID,
    });
    expect(hasGeneratedHeader(compiled)).toBe(true);
    expect(hasGeneratedHeader("hello\n")).toBe(false);
  });

  it("accepts a BOM and CRLF after the header", () => {
    expect(hasGeneratedHeader(`﻿${GENERATED_HEADER}\r\nbody`)).toBe(true);
  });
});

describe("compileInstructions", () => {
  it("prefixes the header and uses the source EOL", () => {
    expect(
      compileInstructions({ source: "a\r\nb\r\n", target: "claude", validTargets: VALID }),
    ).toBe(`${GENERATED_HEADER}\r\na\r\nb\r\n`);
  });

  it("adds a final newline when the source has none", () => {
    expect(compileInstructions({ source: "a", target: "claude", validTargets: VALID })).toBe(
      `${GENERATED_HEADER}\na\n`,
    );
  });

  it("appends local overrides after a blank line", () => {
    const out = compileInstructions({
      source: "shared\n",
      local: "mine\n",
      target: "claude",
      validTargets: VALID,
    });
    expect(out).toBe(`${GENERATED_HEADER}\nshared\n\nmine\n`);
  });

  it("adds only the header to a file with no tags", () => {
    const text = "# Plain\n\nNo blocks here.\n";
    expect(compileInstructions({ source: text, target: "claude", validTargets: VALID })).toBe(
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

  it("throws unknown-target when the local override names a misspelled target", () => {
    const error = errorOf(() =>
      compileInstructions({
        source: "shared\n",
        local: "<!-- yoke:cluade-only -->\nx\n<!-- /yoke:cluade-only -->\n",
        target: "claude",
        validTargets: VALID,
      }),
    );
    expect(error.code).toBe("unknown-target");
  });

  it("requires validTargets", () => {
    expectTypeOf(compileInstructions).parameter(0).toHaveProperty("validTargets");
    expectTypeOf<Parameters<typeof compileInstructions>[0]["validTargets"]>().toEqualTypeOf<
      readonly string[]
    >();
  });
});
