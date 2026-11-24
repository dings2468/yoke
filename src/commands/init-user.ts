/**
 * src/commands/init-user.ts — merges the user-scope draft into `<userConfigDir>/yoke.yaml` without clobbering it (U4).
 * Pure: takes the existing file text (or none) and returns the text to write, plus what changed. Nothing is written here.
 */
import { parseDocument } from "yaml";
import { hashMcp } from "../core/drift.js";
import { isMcpDisabledStub, type McpServerDefinition, type YokeConfig } from "../core/schema.js";
import { parseScopeConfig, ScopeConfigError } from "../core/scopes.js";
import { type InitDraft, renderYokeYaml } from "./init-convert.js";
import { InitError } from "./init-types.js";

type UserDraft = NonNullable<InitDraft["user"]>;

export interface UserMergeResult {
  /** Text to write, or undefined when nothing was added (no write). */
  readonly content: string | undefined;
  /** Server names added to the file, sorted. */
  readonly added: readonly string[];
  /** Server names already in the file with an equal definition, sorted. */
  readonly kept: readonly string[];
  /** Server names present in the file with a different definition or as a stub; the existing entry is kept. */
  readonly conflicts: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Computes the user-scope file text. An existing file is validated first (an invalid file is an InitError). Only
 * servers missing from the file are added; existing entries are never replaced, even with --force. Comments, key
 * order, and untouched lines are preserved by the yaml Document API.
 */
export function mergeUserConfig(
  existing: { readonly text: string; readonly path: string } | undefined,
  draft: UserDraft,
  path: string,
): UserMergeResult {
  const names = Object.keys(draft.mcps).sort();

  if (existing === undefined) {
    if (names.length === 0) {
      return { content: undefined, added: [], kept: [], conflicts: [], notes: [] };
    }
    const mcps: Record<string, McpServerDefinition> = {};
    for (const name of names) {
      const def = draft.mcps[name];
      if (def !== undefined) {
        mcps[name] = def;
      }
    }
    const config: YokeConfig = {
      version: 1,
      ...(draft.harnesses.length > 0 ? { harnesses: [...draft.harnesses] } : {}),
      mcps,
    };
    const content = renderYokeYaml(config);
    parseScopeConfig(content, "user", path);
    return { content, added: names, kept: [], conflicts: [], notes: [] };
  }

  let config: YokeConfig;
  try {
    config = parseScopeConfig(existing.text, "user", existing.path);
  } catch (error: unknown) {
    if (error instanceof ScopeConfigError) {
      throw new InitError(error.message);
    }
    throw error;
  }

  const existingMcps = config.mcps ?? {};
  const doc = parseDocument(existing.text);
  const added: string[] = [];
  const kept: string[] = [];
  const conflicts: string[] = [];
  const notes: string[] = [];

  for (const name of names) {
    const def = draft.mcps[name];
    if (def === undefined) {
      continue;
    }
    if (!Object.hasOwn(existingMcps, name)) {
      doc.setIn(["mcps", name], def);
      added.push(name);
      continue;
    }
    const current = existingMcps[name];
    if (current !== undefined && !isMcpDisabledStub(current) && hashMcp(current) === hashMcp(def)) {
      kept.push(name);
      continue;
    }
    conflicts.push(
      `user server "${name}" already in ${path} with a different definition; kept the existing one`,
    );
  }

  if (added.length === 0) {
    return { content: undefined, added, kept, conflicts, notes };
  }

  if (config.harnesses === undefined && draft.harnesses.length > 0) {
    doc.setIn(["harnesses"], [...draft.harnesses]);
    notes.push(`added harnesses to ${path}`);
  }

  const content = doc.toString({ flowCollectionPadding: false });
  parseScopeConfig(content, "user", path);
  return { content, added, kept, conflicts, notes };
}
