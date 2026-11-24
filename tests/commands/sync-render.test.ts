import { describe, expect, it } from "vitest";
import type { FileChangePlan } from "../../src/adapters/base.js";
import {
  type DiffLine,
  displayPath,
  lineDiff,
  maskSecretLine,
  type RenderOptions,
  renderGate,
  renderPlan,
  renderRefusal,
  renderResult,
} from "../../src/commands/sync-render.js";
import type { DriftReport, ScopeDriftReport } from "../../src/core/drift.js";
import type { GateReason, PlannedChange, SyncResult } from "../../src/core/plan.js";

const ESC = String.fromCharCode(27);

const OPTS: RenderOptions = {
  color: false,
  repoPath: "/work/repo",
  homeDir: "/home/dev",
  dryRun: false,
  command: "yoke sync",
};

const NO_DRIFT: DriftReport = { scopes: [], hasDrift: false };

function change(
  overrides: Partial<FileChangePlan> & Pick<FileChangePlan, "action">,
): PlannedChange {
  const plan: FileChangePlan = {
    scope: "project",
    path: "/work/repo/.mcp.json",
    summary: "summary",
    warnings: [],
    expected: [],
    apply: async () => ({ status: "written", backupPath: undefined }),
    ...overrides,
  };
  return { harness: "alpha", plan };
}

/** A `${NAME}` environment reference, built here so the literal does not appear in a string. */
function envRef(name: string): string {
  return ["$", "{", name, "}"].join("");
}

function asText(line: DiffLine): string {
  return line.kind === "@" ? line.text : `${line.kind}${line.text}`;
}

describe("lineDiff", () => {
  it("emits every line as an addition when before is missing", () => {
    expect(lineDiff("", "one\ntwo", 3)).toEqual([
      { kind: "+", text: "one" },
      { kind: "+", text: "two" },
    ]);
  });

  it("keeps the requested context and separates hunks with @@", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "B", "c", "d", "e", "f", "g", "h", "I", "j"].join("\n");
    const lines = lineDiff(before, after, 1);
    expect(lines.map(asText)).toEqual([" a", "-b", "+B", " c", "@@", " h", "-i", "+I", " j"]);
  });

  it("uses zero context lines for patch-json style diffs", () => {
    const lines = lineDiff("x\nold\ny", "x\nnew\ny", 0);
    expect(lines.map(asText)).toEqual(["-old", "+new"]);
  });

  it("returns the too-large marker when the line product exceeds 4e6", () => {
    const before = Array.from({ length: 2001 }, (_, i) => `b${i}`).join("\n");
    const after = Array.from({ length: 2001 }, (_, i) => `a${i}`).join("\n");
    expect(lineDiff(before, after, 3)).toEqual([
      { kind: "@", text: "(diff too large: -2001 +2001 lines)" },
    ]);
  });
});

describe("maskSecretLine", () => {
  it("redacts a secret-keyed quoted value", () => {
    expect(maskSecretLine('  "API_TOKEN": "sk-abcdef1234",')).toBe('  "API_TOKEN": "<redacted>",');
  });

  it("keeps environment references", () => {
    expect(maskSecretLine(`  "API_TOKEN": "${envRef("API_TOKEN")}"`)).toBe(
      `  "API_TOKEN": "${envRef("API_TOKEN")}"`,
    );
  });

  it("redacts a secret-shaped value under a neutral key", () => {
    expect(maskSecretLine('  "label": "sk-abcdef1234"')).toBe('  "label": "<redacted>"');
  });

  it("leaves ordinary lines alone", () => {
    expect(maskSecretLine('  "name": "linear"')).toBe('  "name": "linear"');
    expect(maskSecretLine("plain text")).toBe("plain text");
  });
});

describe("displayPath", () => {
  it("is repo-relative inside the repo, ~ under home, and absolute otherwise", () => {
    expect(displayPath("/work/repo/.mcp.json", OPTS)).toBe(".mcp.json");
    expect(displayPath("/home/dev/.config/x.json", OPTS)).toBe("~/.config/x.json");
    expect(displayPath("/etc/x.json", OPTS)).toBe("/etc/x.json");
  });
});

describe("renderPlan", () => {
  it("renders create, update, patch-json, and symlink entries with a header", () => {
    const text = renderPlan(
      [
        change({ action: "create", before: undefined, after: "new\n", summary: "new file" }),
        change({
          action: "update",
          path: "/work/repo/CLAUDE.md",
          before: "keep\n",
          after: "keep\nadded\n",
          summary: "instructions",
        }),
        change({
          action: "patch-json",
          path: "/home/dev/.claude.json",
          scope: "user",
          before: '{"a":1,"b":2}',
          after: '{"a":1,"b":3}',
          summary: "mcpServers",
        }),
        change({
          action: "symlink",
          path: "/work/repo/AGENTS.md",
          summary: "link",
          link: { before: undefined, after: "CLAUDE.md" },
        }),
      ],
      [],
      OPTS,
    );
    expect(text.split("\n")[0]).toBe("yoke sync: 4 changes, 0 unchanged");
    expect(text).toContain("+ create .mcp.json (alpha, project): new file");
    expect(text).toContain("~ update CLAUDE.md (alpha, project): instructions");
    expect(text).toContain("+added");
    expect(text).toContain("* patch-json ~/.claude.json (alpha, user): mcpServers");
    expect(text).toContain("> symlink AGENTS.md (alpha, project): link");
    expect(text).toContain("link: (none) -> CLAUDE.md");
  });

  it("prints no context lines for patch-json changes", () => {
    const text = renderPlan(
      [
        change({
          action: "patch-json",
          path: "/home/dev/.claude.json",
          before: 'unrelated\n"mcpServers": 1\nalso unrelated',
          after: 'unrelated\n"mcpServers": 2\nalso unrelated',
        }),
      ],
      [],
      OPTS,
    );
    expect(text).not.toContain("    unrelated");
    expect(text).toContain('    -"mcpServers": 1');
    expect(text).toContain('    +"mcpServers": 2');
  });

  it("masks secret values in diff lines", () => {
    const text = renderPlan(
      [
        change({
          action: "create",
          after: `{\n  "API_TOKEN": "sk-abcdef1234",\n  "URL": "${envRef("URL")}"\n}`,
        }),
      ],
      [],
      OPTS,
    );
    expect(text).toContain('"API_TOKEN": "<redacted>"');
    expect(text).not.toContain("sk-abcdef1234");
    expect(text).toContain(`"URL": "${envRef("URL")}"`);
  });

  it("counts noop plans without printing them", () => {
    const text = renderPlan(
      [change({ action: "noop", summary: "same" }), change({ action: "create", after: "x" })],
      [],
      { ...OPTS, dryRun: true },
    );
    expect(text.split("\n")[0]).toBe("yoke sync --dry-run: 1 change, 1 unchanged");
    expect(text).not.toContain("same");
  });

  it("prints warnings once each, in order", () => {
    const text = renderPlan([], ["first", "second", "first"], OPTS);
    expect(text).toBe("yoke sync: 0 changes, 0 unchanged\nwarnings:\n  first\n  second");
  });

  it("emits no ANSI escape codes when color is off", () => {
    const text = renderPlan([change({ action: "create", after: "x" })], ["w"], OPTS);
    expect(text).not.toContain(ESC);
  });

  it("emits ANSI escape codes when color is on", () => {
    const text = renderPlan([change({ action: "create", after: "x" })], [], {
      ...OPTS,
      color: true,
    });
    expect(text).toContain(ESC);
  });
});

describe("renderGate and renderRefusal", () => {
  const drift: DriftReport = {
    hasDrift: true,
    scopes: [
      {
        key: "alpha:project",
        hasDrift: true,
        mcps: [
          { name: "postgres", status: "added", native: undefined, desired: undefined },
          { name: "linear", status: "modified", native: undefined, desired: undefined },
          { name: "old", status: "removed", native: undefined, desired: undefined },
          { name: "same", status: "in-sync", native: undefined, desired: undefined },
        ],
        instructions: {
          status: "modified",
          path: "/work/repo/CLAUDE.md",
          native: undefined,
          desired: { kind: "file", path: "/work/repo/CLAUDE.md", content: "x" },
        },
      } satisfies ScopeDriftReport,
    ],
  };
  const reasons: GateReason[] = [
    { kind: "lock-corrupt", path: "/work/repo/.yoke/state.json", reason: "bad json" },
  ];

  it("renders drift markers for added, modified, removed entries and instructions", () => {
    const text = renderGate([], drift, OPTS);
    expect(text).toContain('+ MCP server "postgres" (added)');
    expect(text).toContain('~ MCP server "linear" (modified)');
    expect(text).toContain('- MCP server "old" (removed)');
    expect(text).not.toContain('"same"');
    expect(text).toContain("~ instructions CLAUDE.md (modified)");
    expect(text).toContain("alpha:project");
  });

  it("renders lock-corrupt and drift-unchecked reasons", () => {
    const text = renderGate(
      [...reasons, { kind: "drift-unchecked", harness: "alpha" }],
      NO_DRIFT,
      OPTS,
    );
    expect(text).toContain(".yoke/state.json is not a valid lock (bad json); it would be replaced");
    expect(text).toContain("alpha: drift not checked");
  });

  it("renders the non-interactive refusal text", () => {
    const text = renderRefusal(reasons, drift, { ...OPTS, interactive: false });
    expect(text.split("\n")[0]).toBe(
      "yoke sync: refused: native changes since the last sync; nothing was written.",
    );
    expect(text).toContain("Rerun with --force");
  });

  it("renders the interactive abort text first", () => {
    const text = renderRefusal(reasons, drift, { ...OPTS, interactive: true });
    expect(text.split("\n")[0]).toBe("aborted; nothing was written");
    expect(text).not.toContain("Rerun with --force");
  });
});

describe("renderResult", () => {
  const base: SyncResult = {
    status: "applied",
    gate: { kind: "clear" },
    applied: [],
    locksWritten: [],
    backupDir: undefined,
    warnings: [],
  };

  it("prints written, fallback, lock, and backup lines and counts files", () => {
    const result: SyncResult = {
      ...base,
      applied: [
        {
          harness: "alpha",
          path: "/work/repo/.mcp.json",
          action: "create",
          result: { status: "written", backupPath: "/home/dev/.config/yoke/backups/t/x" },
        },
        {
          harness: "alpha",
          path: "/work/repo/AGENTS.md",
          action: "symlink",
          result: { status: "fallback", backupPath: undefined, detail: "no symlinks" },
        },
        {
          harness: "alpha",
          path: "/work/repo/other",
          action: "update",
          result: { status: "unchanged", backupPath: undefined },
        },
      ],
      locksWritten: ["/work/repo/.yoke/state.json"],
      backupDir: "/home/dev/.config/yoke/backups/t",
      warnings: ["planned", "late"],
    };
    const text = renderResult(result, ["planned"], OPTS);
    expect(text).toBe(
      [
        "written: .mcp.json (backup: ~/.config/yoke/backups/t/x)",
        "fallback: AGENTS.md: no symlinks",
        "note: late",
        "lock: .yoke/state.json",
        "backups: ~/.config/yoke/backups/t",
        "synced 2 files",
      ].join("\n"),
    );
  });

  it("prints nothing to do when nothing was written", () => {
    expect(renderResult(base, [], OPTS)).toBe("nothing to do");
  });
});
