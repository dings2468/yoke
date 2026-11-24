/**
 * src/commands/init-select.ts — chooses which harness sources and instruction file `yoke init` imports.
 * Pure selection logic (DI5, DI6) plus a prompt wrapper that takes an injected PromptApi, so no terminal is needed to test it.
 */
import {
  type HarnessAvailability,
  type HarnessImport,
  type ImportSelection,
  type ImportSources,
  InitError,
  type InstructionCandidate,
  type SourceToken,
  UsageError,
} from "./init-types.js";

export type InstructionDecision =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly candidate: InstructionCandidate }
  | { readonly kind: "conflict"; readonly candidates: readonly InstructionCandidate[] };

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface PromptApi {
  multiselect(o: {
    message: string;
    options: PickerOption[];
    initialValues: string[];
    required: boolean;
  }): Promise<string[] | symbol>;
  select(o: { message: string; options: PickerOption[] }): Promise<string | symbol>;
  isCancel(value: unknown): value is symbol;
}

/** Picker value that means "import no instructions". Absolute paths can never equal it. */
const NO_INSTRUCTIONS = "none";

/** Compares instruction contents: CRLF becomes LF and trailing whitespace at end of file is ignored (DI6). */
function normaliseInstructions(content: string): string {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

/** Collapses identical instruction contents to their first occurrence and reports what remains (DI6). */
export function decideInstructions(
  candidates: readonly InstructionCandidate[],
): InstructionDecision {
  const distinct = new Map<string, InstructionCandidate>();
  for (const candidate of candidates) {
    const key = normaliseInstructions(candidate.content);
    if (!distinct.has(key)) {
      distinct.set(key, candidate);
    }
  }
  const unique = [...distinct.values()];
  const first = unique[0];
  if (first === undefined) {
    return { kind: "none" };
  }
  if (unique.length === 1) {
    return { kind: "one", candidate: first };
  }
  return { kind: "conflict", candidates: unique };
}

function describeCandidates(candidates: readonly InstructionCandidate[]): string {
  return candidates.map((candidate) => `  ${candidate.path} (${candidate.origin})`).join("\n");
}

function availableHarness(sources: ImportSources, name: string): HarnessImport {
  const entry = sources.harnesses.find((harness) => harness.name === name);
  if (entry === undefined) {
    throw new UsageError(`unknown harness: ${name}`);
  }
  const availability: HarnessAvailability = entry.availability;
  switch (availability.kind) {
    case "available":
      return availability.data;
    case "empty":
      throw new InitError(`${name} has nothing to import`);
    case "unreadable":
      throw new InitError(`${name} cannot be read: ${availability.reason}`);
    case "unsupported":
      throw new InitError(`${name} does not support import`);
  }
}

/**
 * Resolves non-interactive --import-from tokens into a selection (DI3, DI4, DI6).
 * Harness tokens are merged by name; a `name:mcps` token only applies when every token for that name is `:mcps`.
 */
export function selectFromTokens(
  sources: ImportSources,
  tokens: readonly SourceToken[],
  files: ReadonlyMap<string, InstructionCandidate>,
): ImportSelection {
  const harnessMcpsOnly = new Map<string, boolean>();
  const seenFiles = new Set<string>();
  const fileCandidates: InstructionCandidate[] = [];

  for (const token of tokens) {
    if (token.kind === "harness") {
      const previous = harnessMcpsOnly.get(token.name);
      const mcpsOnly = previous === undefined ? token.mcpsOnly : previous && token.mcpsOnly;
      harnessMcpsOnly.set(token.name, mcpsOnly);
      continue;
    }
    if (seenFiles.has(token.path)) {
      continue;
    }
    seenFiles.add(token.path);
    const candidate = files.get(token.path);
    if (candidate === undefined) {
      throw new InitError(`not an importable instruction file: ${token.path}`);
    }
    fileCandidates.push(candidate);
  }

  const harnesses: HarnessImport[] = [];
  const harnessCandidates: InstructionCandidate[] = [];
  for (const [name, mcpsOnly] of harnessMcpsOnly) {
    const data = availableHarness(sources, name);
    harnesses.push(mcpsOnly ? { ...data, instructions: undefined } : data);
    if (!mcpsOnly && data.instructions !== undefined) {
      harnessCandidates.push(data.instructions);
    }
  }

  const decision = decideInstructions([...harnessCandidates, ...fileCandidates]);
  if (decision.kind === "conflict") {
    throw new InitError(
      `instruction files differ and cannot be merged:\n${describeCandidates(decision.candidates)}\n` +
        'use "<harness>:mcps" to skip a harness\'s instructions, and name one instruction file',
    );
  }
  return {
    harnesses,
    instructions: decision.kind === "one" ? decision.candidate : undefined,
  };
}

function describeImport(data: HarnessImport): string {
  const servers = Object.keys(data.project).length + Object.keys(data.local).length;
  const parts: string[] = [];
  if (servers > 0) {
    parts.push(`${servers} MCP server${servers === 1 ? "" : "s"}`);
  }
  if (data.instructions !== undefined) {
    parts.push("instruction file");
  }
  return parts.join(", ");
}

/** Harness choices for the multiselect. Empty, unreadable and unsupported harnesses are shown disabled with the reason. */
function harnessOption(name: string, availability: HarnessAvailability): PickerOption {
  if (availability.kind === "available") {
    return { value: name, label: name, hint: describeImport(availability.data) };
  }
  if (availability.kind === "empty") {
    return { value: name, label: name, hint: "nothing to import", disabled: true };
  }
  if (availability.kind === "unreadable") {
    return { value: name, label: name, hint: availability.reason, disabled: true };
  }
  return { value: name, label: name, hint: "import not supported", disabled: true };
}

export function harnessPickerOptions(sources: ImportSources): readonly PickerOption[] {
  return sources.harnesses.map(({ name, availability }) => harnessOption(name, availability));
}

/** Instruction choices: one option per candidate path, plus "do not import instructions". */
export function instructionPickerOptions(
  candidates: readonly InstructionCandidate[],
): readonly PickerOption[] {
  return [
    ...candidates.map(
      (candidate): PickerOption => ({
        value: candidate.path,
        label: candidate.path,
        hint: candidate.origin,
      }),
    ),
    { value: NO_INSTRUCTIONS, label: "Do not import instructions" },
  ];
}

/** Applies interactive picks. Throws InitError for a value that is not a choice offered by the sources. */
export function applyPicks(
  sources: ImportSources,
  picks: { readonly harnesses: readonly string[]; readonly instruction: string },
): ImportSelection {
  const harnesses: HarnessImport[] = [];
  for (const name of new Set(picks.harnesses)) {
    const entry = sources.harnesses.find((harness) => harness.name === name);
    if (entry?.availability.kind !== "available") {
      throw new InitError(`harness is not importable: ${name}`);
    }
    harnesses.push(entry.availability.data);
  }

  if (picks.instruction === NO_INSTRUCTIONS) {
    return { harnesses, instructions: undefined };
  }
  const candidate = sources.files.find((file) => file.path === picks.instruction);
  if (candidate === undefined) {
    throw new InitError(`unknown instruction choice: ${picks.instruction}`);
  }
  const offered =
    candidate.origin === "existing" ||
    candidate.origin === "file" ||
    picks.harnesses.includes(candidate.origin);
  if (!offered) {
    throw new InitError(
      `instruction choice comes from an unselected harness: ${picks.instruction}`,
    );
  }
  return { harnesses, instructions: candidate };
}

/** Interactive flow (DI5): harness multiselect, then an instruction select only when the candidates differ. */
export async function promptImportSelection(
  sources: ImportSources,
  api: PromptApi,
): Promise<ImportSelection | "cancelled"> {
  const harnessPicks = await api.multiselect({
    message: "Import from which harnesses?",
    options: [...harnessPickerOptions(sources)],
    initialValues: sources.harnesses
      .filter((harness) => harness.availability.kind === "available")
      .map((harness) => harness.name),
    required: false,
  });
  if (api.isCancel(harnessPicks)) {
    return "cancelled";
  }

  const chosen = new Set(harnessPicks);
  const offered = sources.files.filter(
    (candidate) =>
      candidate.origin === "existing" ||
      candidate.origin === "file" ||
      chosen.has(candidate.origin),
  );
  const decision = decideInstructions(offered);
  let instruction: string;
  if (decision.kind === "conflict") {
    const pick = await api.select({
      message: "Which instruction file should yoke import?",
      options: [...instructionPickerOptions(decision.candidates)],
    });
    if (api.isCancel(pick)) {
      return "cancelled";
    }
    instruction = pick;
  } else if (decision.kind === "one") {
    instruction = decision.candidate.path;
  } else {
    instruction = NO_INSTRUCTIONS;
  }

  return applyPicks(sources, { harnesses: harnessPicks, instruction });
}
