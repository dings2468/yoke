import { describe, expect, it } from "vitest";
import {
  type CompileReason,
  decideInstructionStrategy,
  InstructionCompileError,
  localOverridePath,
} from "../../src/core/compiler.js";

const PLAIN = "# Rules\n\nBe concise.\n";
const WITH_BLOCK = "# Rules\n\n<!-- yoke:alpha-only -->\nAlpha only.\n<!-- /yoke:alpha-only -->\n";
const LOCAL = "# Local\n\nPersonal note.\n";

interface Row {
  readonly preferSymlink: boolean;
  readonly blocks: boolean;
  readonly local: boolean;
  readonly supported: boolean;
  readonly reasons: readonly CompileReason[] | "symlink";
}

const TABLE: readonly Row[] = [
  { preferSymlink: true, blocks: false, local: false, supported: true, reasons: "symlink" },
  {
    preferSymlink: true,
    blocks: false,
    local: false,
    supported: false,
    reasons: ["symlink-unsupported"],
  },
  { preferSymlink: true, blocks: false, local: true, supported: true, reasons: ["local-override"] },
  {
    preferSymlink: true,
    blocks: false,
    local: true,
    supported: false,
    reasons: ["local-override", "symlink-unsupported"],
  },
  {
    preferSymlink: true,
    blocks: true,
    local: false,
    supported: true,
    reasons: ["conditional-blocks"],
  },
  {
    preferSymlink: true,
    blocks: true,
    local: false,
    supported: false,
    reasons: ["conditional-blocks", "symlink-unsupported"],
  },
  {
    preferSymlink: true,
    blocks: true,
    local: true,
    supported: true,
    reasons: ["conditional-blocks", "local-override"],
  },
  {
    preferSymlink: true,
    blocks: true,
    local: true,
    supported: false,
    reasons: ["conditional-blocks", "local-override", "symlink-unsupported"],
  },
  {
    preferSymlink: false,
    blocks: false,
    local: false,
    supported: true,
    reasons: ["prefer-symlink-off"],
  },
  {
    preferSymlink: false,
    blocks: false,
    local: false,
    supported: false,
    reasons: ["prefer-symlink-off", "symlink-unsupported"],
  },
  {
    preferSymlink: false,
    blocks: false,
    local: true,
    supported: true,
    reasons: ["prefer-symlink-off", "local-override"],
  },
  {
    preferSymlink: false,
    blocks: false,
    local: true,
    supported: false,
    reasons: ["prefer-symlink-off", "local-override", "symlink-unsupported"],
  },
  {
    preferSymlink: false,
    blocks: true,
    local: false,
    supported: true,
    reasons: ["prefer-symlink-off", "conditional-blocks"],
  },
  {
    preferSymlink: false,
    blocks: true,
    local: false,
    supported: false,
    reasons: ["prefer-symlink-off", "conditional-blocks", "symlink-unsupported"],
  },
  {
    preferSymlink: false,
    blocks: true,
    local: true,
    supported: true,
    reasons: ["prefer-symlink-off", "conditional-blocks", "local-override"],
  },
  {
    preferSymlink: false,
    blocks: true,
    local: true,
    supported: false,
    reasons: ["prefer-symlink-off", "conditional-blocks", "local-override", "symlink-unsupported"],
  },
];

describe("decideInstructionStrategy", () => {
  it.each(TABLE)(
    "preferSymlink=$preferSymlink blocks=$blocks local=$local supported=$supported",
    (row) => {
      const result = decideInstructionStrategy({
        preferSymlink: row.preferSymlink,
        source: row.blocks ? WITH_BLOCK : PLAIN,
        local: row.local ? LOCAL : undefined,
        symlinksSupported: row.supported,
      });
      if (row.reasons === "symlink") {
        expect(result).toEqual({ kind: "symlink" });
      } else {
        expect(result).toEqual({ kind: "compile", reasons: row.reasons });
      }
    },
  );

  it("defaults symlinksSupported to true when omitted", () => {
    expect(
      decideInstructionStrategy({ preferSymlink: true, source: PLAIN, local: undefined }),
    ).toEqual({ kind: "symlink" });
  });

  it("treats an empty-string local as local-override", () => {
    expect(decideInstructionStrategy({ preferSymlink: true, source: PLAIN, local: "" })).toEqual({
      kind: "compile",
      reasons: ["local-override"],
    });
  });

  it("throws on malformed tags in source even when preferSymlink is false", () => {
    expect(() =>
      decideInstructionStrategy({
        preferSymlink: false,
        source: "<!-- yoke:alpha-only -->\nno close\n",
        local: undefined,
      }),
    ).toThrow(InstructionCompileError);
    expect(() =>
      decideInstructionStrategy({
        preferSymlink: false,
        source: PLAIN,
        local: "<!-- yoke:Alpha-only -->\n",
      }),
    ).toThrow(InstructionCompileError);
  });

  it("throws on unknown targets when validTargets is given", () => {
    expect(() =>
      decideInstructionStrategy({
        preferSymlink: true,
        source: WITH_BLOCK,
        local: undefined,
        validTargets: ["beta"],
      }),
    ).toThrow(InstructionCompileError);
  });

  it("keeps symlink when tags appear only inside a fenced code block", () => {
    const source =
      "Syntax:\n\n```md\n<!-- yoke:alpha-only -->\nx\n<!-- /yoke:alpha-only -->\n```\n";
    expect(decideInstructionStrategy({ preferSymlink: true, source, local: undefined })).toEqual({
      kind: "symlink",
    });
  });
});

describe("localOverridePath", () => {
  it.each([
    ["AGENTS.md", "AGENTS.local.md"],
    ["/r/docs/rules.md", "/r/docs/rules.local.md"],
    ["RULES", "RULES.local"],
    [".hidden.md", ".hidden.local.md"],
    [".hidden", ".hidden.local"],
    ["/r/docs/archive.tar.gz", "/r/docs/archive.tar.local.gz"],
  ])("%s -> %s", (input, expected) => {
    expect(localOverridePath(input)).toBe(expected);
  });
});
