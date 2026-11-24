/**
 * src/commands/init-sources.ts — parses --import-from tokens and lists what each harness and the repo can import.
 * Reads only. Adapters are reached through their HarnessAdapter interface and capabilities.
 */
import { resolve } from "node:path";
import type { HarnessAdapter } from "../adapters/base.js";
import { hasGeneratedHeader } from "../core/compiler.js";
import { type FileStat, isNotFound, type ReadFs } from "../core/fs-safe.js";
import type { NativeInstructions, PartialYokeConfig } from "../core/schema.js";
import {
  type HarnessAvailability,
  type ImportSources,
  InitError,
  type InstructionCandidate,
  type SourceToken,
  UsageError,
} from "./init-types.js";

const HARNESS_TOKEN = /^[a-z][a-z0-9-]{0,31}(:mcps)?$/;
const MCPS_SUFFIX = ":mcps";
const JSON_SOURCE_MESSAGE =
  "native MCP JSON sources are not supported in v0.1; name the harness instead";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parses one --import-from value (DI3). Paths resolve against cwd. Throws UsageError for a malformed token. */
export function parseSourceToken(raw: string, cwd: string): SourceToken {
  if (raw.trim() === "") {
    throw new UsageError("empty --import-from value");
  }
  if (HARNESS_TOKEN.test(raw)) {
    const mcpsOnly = raw.endsWith(MCPS_SUFFIX);
    const name = mcpsOnly ? raw.slice(0, -MCPS_SUFFIX.length) : raw;
    return { kind: "harness", name, mcpsOnly };
  }
  if (raw.toLowerCase().endsWith(".json")) {
    throw new UsageError(JSON_SOURCE_MESSAGE);
  }
  return { kind: "file", path: resolve(cwd, raw) };
}

/** Returns the project-tier instructions when they are a plain file that yoke does not generate. */
function importableInstructions(
  origin: string,
  native: NativeInstructions | undefined,
): InstructionCandidate | undefined {
  if (native === undefined || native.kind !== "file") {
    return undefined;
  }
  if (hasGeneratedHeader(native.content)) {
    return undefined;
  }
  return { path: native.path, content: native.content, origin };
}

async function readAvailability(
  adapter: HarnessAdapter,
  repoPath: string,
): Promise<HarnessAvailability> {
  if (!adapter.capabilities.reverseRead) {
    return { kind: "unsupported" };
  }
  let state: PartialYokeConfig;
  try {
    state = await adapter.readNativeState(repoPath);
  } catch (err: unknown) {
    return { kind: "unreadable", reason: errorMessage(err) };
  }
  const project = state.project?.mcps ?? {};
  const local = state.local?.mcps ?? {};
  const userCount = Object.keys(state.user?.mcps ?? {}).length;
  const instructions = importableInstructions(adapter.name, state.project?.instructions);
  if (
    Object.keys(project).length === 0 &&
    Object.keys(local).length === 0 &&
    instructions === undefined
  ) {
    return { kind: "empty", userCount };
  }
  return {
    kind: "available",
    data: { harness: adapter.name, project, local, userCount, instructions },
  };
}

/** The repo's canonical instructions file, when it is a plain file that yoke does not generate. */
async function canonicalCandidate(
  fs: ReadFs,
  path: string,
): Promise<InstructionCandidate | undefined> {
  let stat: FileStat;
  try {
    stat = await fs.lstat(path);
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return undefined;
    }
    throw err;
  }
  if (!stat.isFile || stat.isSymbolicLink) {
    return undefined;
  }
  const content = await fs.readFile(path);
  if (hasGeneratedHeader(content)) {
    return undefined;
  }
  return { path, content, origin: "existing" };
}

/** Lists harness import availability and instruction-file candidates (DI1, DI2). Reads only. */
export async function listImportSources(input: {
  readonly adapters: readonly HarnessAdapter[];
  readonly repoPath: string;
  readonly fs: ReadFs;
  readonly canonicalPath: string;
}): Promise<ImportSources> {
  const harnesses: { name: string; availability: HarnessAvailability }[] = [];
  const candidates: InstructionCandidate[] = [];
  for (const adapter of input.adapters) {
    const availability = await readAvailability(adapter, input.repoPath);
    harnesses.push({ name: adapter.name, availability });
    if (availability.kind === "available" && availability.data.instructions !== undefined) {
      candidates.push(availability.data.instructions);
    }
  }
  const canonical = await canonicalCandidate(input.fs, input.canonicalPath);
  if (canonical !== undefined) {
    candidates.push(canonical);
  }
  const seen = new Set<string>();
  const files = candidates.filter((candidate) => {
    if (seen.has(candidate.path)) {
      return false;
    }
    seen.add(candidate.path);
    return true;
  });
  return { harnesses, files };
}

/** Reads an explicit instruction file named on the command line. Throws InitError when it cannot be used. */
export async function readFileSource(fs: ReadFs, path: string): Promise<InstructionCandidate> {
  if (path.toLowerCase().endsWith(".json")) {
    throw new InitError(JSON_SOURCE_MESSAGE);
  }
  let stat: FileStat;
  try {
    stat = await fs.stat(path);
  } catch (err: unknown) {
    throw new InitError(
      isNotFound(err) ? `file not found: ${path}` : `cannot read ${path}: ${errorMessage(err)}`,
    );
  }
  if (!stat.isFile) {
    throw new InitError(`not a regular file: ${path}`);
  }
  let content: string;
  try {
    content = await fs.readFile(path);
  } catch (err: unknown) {
    throw new InitError(`cannot read ${path}: ${errorMessage(err)}`);
  }
  return { path, content, origin: "file" };
}
