/**
 * src/adapters/claude.ts — Claude Code paths, native key names, and MCP entry translation (SPEC §6, decisions Q1 and Q2).
 *
 * Only this file and src/adapters/claude*.ts may name Claude paths, keys, or transports. Planning is pure: every read
 * goes through an injected ReadFs, and nothing here touches the disk, the environment, or the clock beyond `env`.
 */
import { isAbsolute, join } from "node:path";
import { isNotFound, type ReadFs } from "../core/fs-safe.js";
import type { Env } from "../core/git.js";
import {
  isJsonObject,
  type JsonKeyPath,
  type JsonObject,
  type JsonValue,
} from "../core/json-text.js";
import {
  type McpServerDefinition,
  McpServerDefinitionSchema,
  McpServerNameSchema,
} from "../core/schema.js";
import { type NativeEntry, NativeStateError } from "./base.js";

export const CLAUDE_NAME = "claude";
/** Lock list ids for Claude's two per-project disable lists (decision D7). */
export const DISABLED_SERVERS_LIST = "disabled-servers";
export const DISABLED_MCPJSON_LIST = "disabled-mcpjson";

export interface ClaudePaths {
  readonly userConfig: string;
  readonly userInstructions: string;
  readonly projectMcp: string;
  readonly projectInstructions: string;
  readonly localInstructions: string;
}

/**
 * User config and user instructions. An absolute `CLAUDE_CONFIG_DIR` moves both into that directory (A9); otherwise they
 * live in the home directory. Project files live in the repository root.
 */
export function claudePaths(homeDir: string, env: Env, repoPath: string): ClaudePaths {
  const configDir = env.CLAUDE_CONFIG_DIR;
  const useConfigDir = configDir !== undefined && isAbsolute(configDir);
  return {
    userConfig: useConfigDir ? join(configDir, ".claude.json") : join(homeDir, ".claude.json"),
    userInstructions: useConfigDir
      ? join(configDir, "CLAUDE.md")
      : join(homeDir, ".claude", "CLAUDE.md"),
    projectMcp: join(repoPath, ".mcp.json"),
    projectInstructions: join(repoPath, "CLAUDE.md"),
    localInstructions: join(repoPath, "CLAUDE.local.md"),
  };
}

/** `mcpServers` in the user config file, and the key of `.mcp.json`. */
export const USER_MCP_KEY: JsonKeyPath = ["mcpServers"];

export function localMcpKey(repoKey: string): JsonKeyPath {
  return ["projects", repoKey, "mcpServers"];
}

export function disabledServersKey(repoKey: string): JsonKeyPath {
  return ["projects", repoKey, "disabledMcpServers"];
}

export function disabledMcpjsonKey(repoKey: string): JsonKeyPath {
  return ["projects", repoKey, "disabledMcpjsonServers"];
}

/** The `projects` key for a repository: its realpath, or the given path when it does not exist (decision D8). */
export async function claudeRepoKey(fs: ReadFs, repoPath: string): Promise<string> {
  try {
    return await fs.realpath(repoPath);
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return repoPath;
    }
    throw err;
  }
}

/** Converts an enabled definition to Claude's shape. `${VAR}` strings are copied verbatim. Callers omit disabled servers. */
export function toClaudeEntry(def: McpServerDefinition): JsonObject {
  if (def.enabled === false) {
    throw new Error(`toClaudeEntry called with a disabled server (transport ${def.transport})`);
  }
  switch (def.transport) {
    case "stdio": {
      const out: JsonObject = { type: "stdio", command: def.command };
      if (def.args !== undefined) {
        out.args = [...def.args];
      }
      if (def.env !== undefined) {
        out.env = Object.fromEntries(Object.entries(def.env));
      }
      return out;
    }
    case "http":
    case "sse": {
      const out: JsonObject = { type: def.transport, url: def.url };
      if (def.headers !== undefined) {
        out.headers = Object.fromEntries(Object.entries(def.headers));
      }
      return out;
    }
  }
}

const STDIO_KEYS: ReadonlySet<string> = new Set(["command", "args", "env"]);
const REMOTE_KEYS: ReadonlySet<string> = new Set(["url", "headers"]);
const OWNED_KEYS: ReadonlySet<string> = new Set([
  "type",
  "command",
  "args",
  "env",
  "url",
  "headers",
]);

function hasOwnKey(obj: JsonObject, key: string): boolean {
  return Object.hasOwn(obj, key);
}

/**
 * Reads one Claude entry. Owned keys are translated; every other key goes to `extras` verbatim. An entry with an unknown
 * transport, or with no `type` and no string `command`, is opaque and kept as-is. Corrupt owned keys throw NativeStateError.
 */
export function fromClaudeEntry(name: string, raw: JsonValue, path: string): NativeEntry {
  if (!McpServerNameSchema.safeParse(name).success) {
    throw new NativeStateError(`invalid server name "${name}"`, path, name);
  }
  if (!isJsonObject(raw)) {
    throw new NativeStateError(`server "${name}" must be an object`, path, name);
  }
  const typeValue = hasOwnKey(raw, "type") ? raw.type : undefined;
  let transport: string;
  if (typeValue === undefined) {
    if (typeof raw.command !== "string") {
      return { kind: "opaque", raw, reason: "no type" };
    }
    transport = "stdio";
  } else if (typeof typeValue !== "string") {
    throw new NativeStateError(`server "${name}": type must be a string`, path, name);
  } else if (typeValue === "stdio" || typeValue === "http" || typeValue === "sse") {
    transport = typeValue;
  } else {
    return { kind: "opaque", raw, reason: `type "${typeValue}"` };
  }

  const allowed = transport === "stdio" ? STDIO_KEYS : REMOTE_KEYS;
  for (const key of OWNED_KEYS) {
    if (key !== "type" && hasOwnKey(raw, key) && !allowed.has(key)) {
      throw new NativeStateError(
        `server "${name}": "${key}" does not fit transport "${transport}"`,
        path,
        name,
      );
    }
  }

  const candidate: Record<string, unknown> = Object.fromEntries(
    Object.entries({
      transport,
      command: hasOwnKey(raw, "command") ? raw.command : undefined,
      args: hasOwnKey(raw, "args") ? raw.args : undefined,
      env: hasOwnKey(raw, "env") ? raw.env : undefined,
      url: hasOwnKey(raw, "url") ? raw.url : undefined,
      headers: hasOwnKey(raw, "headers") ? raw.headers : undefined,
    }).filter(([, value]) => value !== undefined),
  );
  const parsed = McpServerDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : ` ${issue.path.join(".")}`;
    const why = issue === undefined ? "invalid" : issue.message;
    throw new NativeStateError(`server "${name}":${where} ${why}`, path, name);
  }
  const extras: JsonObject = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !OWNED_KEYS.has(key)),
  );
  return { kind: "managed", def: parsed.data, extras };
}

/** Reads the `mcpServers` object in native key order. Absent yields an empty map. */
export function readClaudeServers(
  raw: JsonValue | undefined,
  path: string,
): ReadonlyMap<string, NativeEntry> {
  const out = new Map<string, NativeEntry>();
  if (raw === undefined) {
    return out;
  }
  if (!isJsonObject(raw)) {
    throw new NativeStateError("mcpServers must be an object", path);
  }
  for (const [name, value] of Object.entries(raw)) {
    out.set(name, fromClaudeEntry(name, value, path));
  }
  return out;
}

/** Reads a list of server names (Claude's per-project disable lists). Absent yields []. */
export function readNameList(
  raw: JsonValue | undefined,
  path: string,
  key: string,
): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new NativeStateError(`${key} must be an array of strings`, path);
  }
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new NativeStateError(`${key} must be an array of strings`, path);
    }
    names.push(item);
  }
  return names;
}

/**
 * The `projects[repoKey]` object of the user config file. Undefined when the file, `projects`, or the key is absent.
 * Other keys are never inspected.
 */
export function projectEntry(
  root: JsonValue | undefined,
  repoKey: string,
  path: string,
): JsonObject | undefined {
  if (root === undefined) {
    return undefined;
  }
  if (!isJsonObject(root)) {
    throw new NativeStateError("top level must be a JSON object", path);
  }
  if (!hasOwnKey(root, "projects")) {
    return undefined;
  }
  const projects = root.projects;
  if (!isJsonObject(projects)) {
    throw new NativeStateError("projects must be an object", path);
  }
  if (!hasOwnKey(projects, repoKey)) {
    return undefined;
  }
  const entry = projects[repoKey];
  if (!isJsonObject(entry)) {
    throw new NativeStateError(`projects[${repoKey}] must be an object`, path);
  }
  return entry;
}
