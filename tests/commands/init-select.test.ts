import { describe, expect, it } from "vitest";
import {
  applyPicks,
  decideInstructions,
  harnessPickerOptions,
  instructionPickerOptions,
  type PickerOption,
  type PromptApi,
  promptImportSelection,
  selectFromTokens,
} from "../../src/commands/init-select.js";
import type {
  HarnessAvailability,
  HarnessImport,
  ImportSources,
  InstructionCandidate,
  SourceToken,
} from "../../src/commands/init-types.js";
import { InitError, UsageError } from "../../src/commands/init-types.js";

function candidate(path: string, content: string, origin: string): InstructionCandidate {
  return { path, content, origin };
}

function importOf(harness: string, instructions: InstructionCandidate | undefined): HarnessImport {
  return { harness, project: {}, local: {}, userCount: 0, instructions };
}

function sourcesOf(
  harnesses: readonly { name: string; availability: HarnessAvailability }[],
  files: readonly InstructionCandidate[] = [],
): ImportSources {
  return { harnesses, files };
}

const ALPHA_FILE = candidate("/repo/ALPHA.md", "rules\r\nline\r\n", "alpha");
const BETA_FILE = candidate("/repo/BETA.md", "rules\nline\n\n  ", "beta");
const OTHER_FILE = candidate("/repo/OTHER.md", "different\n", "beta");
const EXISTING = candidate("/repo/AGENTS.md", "rules\nline", "existing");

const SOURCES = sourcesOf(
  [
    { name: "alpha", availability: { kind: "available", data: importOf("alpha", ALPHA_FILE) } },
    { name: "beta", availability: { kind: "available", data: importOf("beta", BETA_FILE) } },
    { name: "gamma", availability: { kind: "empty", userCount: 2 } },
    { name: "delta", availability: { kind: "unreadable", reason: "bad json" } },
    { name: "epsilon", availability: { kind: "unsupported" } },
  ],
  [ALPHA_FILE, BETA_FILE, EXISTING],
);

const NO_FILES: ReadonlyMap<string, InstructionCandidate> = new Map();

describe("decideInstructions", () => {
  it("collapses identical content that differs only in CRLF and trailing whitespace", () => {
    const decision = decideInstructions([ALPHA_FILE, BETA_FILE]);
    expect(decision).toEqual({ kind: "one", candidate: ALPHA_FILE });
  });

  it("reports a conflict listing each distinct candidate once", () => {
    const decision = decideInstructions([ALPHA_FILE, OTHER_FILE, BETA_FILE]);
    expect(decision).toEqual({ kind: "conflict", candidates: [ALPHA_FILE, OTHER_FILE] });
  });

  it("returns none for an empty list", () => {
    expect(decideInstructions([])).toEqual({ kind: "none" });
  });
});

describe("selectFromTokens", () => {
  it("imports a harness with its instructions", () => {
    const selection = selectFromTokens(
      SOURCES,
      [{ kind: "harness", name: "alpha", mcpsOnly: false }],
      NO_FILES,
    );
    expect(selection.harnesses).toEqual([importOf("alpha", ALPHA_FILE)]);
    expect(selection.instructions).toEqual(ALPHA_FILE);
  });

  it("drops instructions for a :mcps token so the conflict disappears", () => {
    const tokens: SourceToken[] = [
      { kind: "harness", name: "alpha", mcpsOnly: false },
      { kind: "harness", name: "beta", mcpsOnly: true },
    ];
    const selection = selectFromTokens(SOURCES, tokens, NO_FILES);
    expect(selection.harnesses).toEqual([
      importOf("alpha", ALPHA_FILE),
      importOf("beta", undefined),
    ]);
    expect(selection.instructions).toEqual(ALPHA_FILE);
  });

  it("fails on conflicting instruction files and names the way out", () => {
    const tokens: SourceToken[] = [
      { kind: "harness", name: "alpha", mcpsOnly: false },
      { kind: "file", path: OTHER_FILE.path },
    ];
    const files = new Map([[OTHER_FILE.path, OTHER_FILE]]);
    const act = (): unknown => selectFromTokens(SOURCES, tokens, files);
    expect(act).toThrow(InitError);
    expect(act).toThrow(ALPHA_FILE.path);
    expect(act).toThrow(OTHER_FILE.path);
    expect(act).toThrow(":mcps");
  });

  it("treats repeated tokens as one and keeps instructions when a full token is mixed with :mcps", () => {
    const tokens: SourceToken[] = [
      { kind: "harness", name: "alpha", mcpsOnly: true },
      { kind: "harness", name: "alpha", mcpsOnly: false },
      { kind: "harness", name: "alpha", mcpsOnly: false },
    ];
    const selection = selectFromTokens(SOURCES, tokens, NO_FILES);
    expect(selection.harnesses).toEqual([importOf("alpha", ALPHA_FILE)]);
    expect(selection.instructions).toEqual(ALPHA_FILE);
  });

  it("adds an explicit file token and deduplicates it", () => {
    const tokens: SourceToken[] = [
      { kind: "file", path: EXISTING.path },
      { kind: "file", path: EXISTING.path },
    ];
    const files = new Map([[EXISTING.path, EXISTING]]);
    const selection = selectFromTokens(SOURCES, tokens, files);
    expect(selection).toEqual({ harnesses: [], instructions: EXISTING });
  });

  it("rejects a file token that was not read into the file map", () => {
    const tokens: SourceToken[] = [{ kind: "file", path: "/repo/MISSING.md" }];
    expect(() => selectFromTokens(SOURCES, tokens, NO_FILES)).toThrow(InitError);
  });

  it("rejects an unknown harness as a usage error", () => {
    const tokens: SourceToken[] = [{ kind: "harness", name: "zeta", mcpsOnly: false }];
    expect(() => selectFromTokens(SOURCES, tokens, NO_FILES)).toThrow(UsageError);
  });

  it.each([
    ["gamma", "nothing to import"],
    ["delta", "bad json"],
    ["epsilon", "does not support import"],
  ])("rejects the %s harness with its reason", (name, reason) => {
    const tokens: SourceToken[] = [{ kind: "harness", name, mcpsOnly: false }];
    expect(() => selectFromTokens(SOURCES, tokens, NO_FILES)).toThrow(reason);
  });
});

describe("picker options", () => {
  it("disables empty, unreadable and unsupported harnesses with a hint", () => {
    const options = harnessPickerOptions(SOURCES);
    const byValue = new Map(options.map((option) => [option.value, option]));
    expect(byValue.get("alpha")?.disabled).toBeUndefined();
    expect(byValue.get("gamma")).toMatchObject({ disabled: true, hint: "nothing to import" });
    expect(byValue.get("delta")).toMatchObject({ disabled: true, hint: "bad json" });
    expect(byValue.get("epsilon")).toMatchObject({ disabled: true, hint: "import not supported" });
  });

  it("offers instruction paths plus a do-not-import choice", () => {
    const options = instructionPickerOptions([ALPHA_FILE, OTHER_FILE]);
    expect(options.map((option) => option.value)).toEqual([
      ALPHA_FILE.path,
      OTHER_FILE.path,
      "none",
    ]);
  });
});

describe("applyPicks", () => {
  it("returns the picked harnesses and instruction", () => {
    const selection = applyPicks(SOURCES, { harnesses: ["alpha"], instruction: ALPHA_FILE.path });
    expect(selection).toEqual({
      harnesses: [importOf("alpha", ALPHA_FILE)],
      instructions: ALPHA_FILE,
    });
  });

  it("imports no instructions for the none choice", () => {
    const selection = applyPicks(SOURCES, { harnesses: ["beta"], instruction: "none" });
    expect(selection.instructions).toBeUndefined();
  });

  it("rejects a harness that is not importable", () => {
    expect(() => applyPicks(SOURCES, { harnesses: ["gamma"], instruction: "none" })).toThrow(
      InitError,
    );
    expect(() => applyPicks(SOURCES, { harnesses: ["zeta"], instruction: "none" })).toThrow(
      InitError,
    );
  });

  it("rejects an unknown instruction value", () => {
    expect(() => applyPicks(SOURCES, { harnesses: [], instruction: "/repo/NOPE.md" })).toThrow(
      InitError,
    );
  });

  it("rejects an instruction from a harness that was not picked", () => {
    expect(() => applyPicks(SOURCES, { harnesses: [], instruction: ALPHA_FILE.path })).toThrow(
      InitError,
    );
  });
});

interface FakeScript {
  readonly multiselect: string[] | symbol;
  readonly select?: string | symbol;
}

function fakeApi(script: FakeScript): PromptApi & {
  readonly calls: { kind: "multiselect" | "select"; options: readonly PickerOption[] }[];
} {
  const calls: { kind: "multiselect" | "select"; options: readonly PickerOption[] }[] = [];
  return {
    calls,
    async multiselect(o) {
      calls.push({ kind: "multiselect", options: o.options });
      return script.multiselect;
    },
    async select(o) {
      calls.push({ kind: "select", options: o.options });
      return script.select ?? "none";
    },
    isCancel(value: unknown): value is symbol {
      return typeof value === "symbol";
    },
  };
}

describe("promptImportSelection", () => {
  it("skips the instruction prompt when the candidates agree", async () => {
    const api = fakeApi({ multiselect: ["alpha", "beta"] });
    const result = await promptImportSelection(SOURCES, api);
    expect(api.calls.map((call) => call.kind)).toEqual(["multiselect"]);
    expect(result).toEqual({
      harnesses: [importOf("alpha", ALPHA_FILE), importOf("beta", BETA_FILE)],
      instructions: ALPHA_FILE,
    });
  });

  it("asks for one instruction file when the chosen candidates conflict", async () => {
    const sources = sourcesOf(
      [
        { name: "alpha", availability: { kind: "available", data: importOf("alpha", ALPHA_FILE) } },
        { name: "beta", availability: { kind: "available", data: importOf("beta", OTHER_FILE) } },
      ],
      [ALPHA_FILE, OTHER_FILE],
    );
    const api = fakeApi({ multiselect: ["alpha", "beta"], select: OTHER_FILE.path });
    const result = await promptImportSelection(sources, api);
    expect(api.calls.map((call) => call.kind)).toEqual(["multiselect", "select"]);
    expect(result).toMatchObject({ instructions: OTHER_FILE });
  });

  it("does not offer candidates from an unpicked harness", async () => {
    const sources = sourcesOf(
      [
        { name: "alpha", availability: { kind: "available", data: importOf("alpha", ALPHA_FILE) } },
        { name: "beta", availability: { kind: "available", data: importOf("beta", OTHER_FILE) } },
      ],
      [ALPHA_FILE, OTHER_FILE],
    );
    const api = fakeApi({ multiselect: ["alpha"] });
    const result = await promptImportSelection(sources, api);
    expect(api.calls.map((call) => call.kind)).toEqual(["multiselect"]);
    expect(result).toMatchObject({ instructions: ALPHA_FILE });
  });

  it("returns cancelled when the harness prompt is cancelled", async () => {
    const api = fakeApi({ multiselect: Symbol("cancel") });
    expect(await promptImportSelection(SOURCES, api)).toBe("cancelled");
  });

  it("returns cancelled when the instruction prompt is cancelled", async () => {
    const sources = sourcesOf(
      [
        { name: "alpha", availability: { kind: "available", data: importOf("alpha", ALPHA_FILE) } },
        { name: "beta", availability: { kind: "available", data: importOf("beta", OTHER_FILE) } },
      ],
      [ALPHA_FILE, OTHER_FILE],
    );
    const api = fakeApi({ multiselect: ["alpha", "beta"], select: Symbol("cancel") });
    expect(await promptImportSelection(sources, api)).toBe("cancelled");
  });
});
