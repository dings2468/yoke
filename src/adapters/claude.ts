/**
 * src/adapters/claude.ts — Claude Code paths, native key names, and MCP entry translation (SPEC §6, decisions Q1 and Q2).
 *
 * Only this file and src/adapters/claude*.ts may name Claude paths, keys, or transports. Planning is pure: every read
 * goes through an injected ReadFs, and nothing here touches the disk, the environment, or the clock beyond `env`.
 */
import { isAbsolute, join } from "node:path";
import { isNotFound, type ReadFs, readJsonIfExists } from "../core/fs-safe.js";
import type { Env } from "../core/git.js";
import {
  getAtPath,
  isJsonObject,
  type JsonKeyPath,
  type JsonObject,
  type JsonValue,
} from "../core/json-text.js";
import {
  type McpServerDefinition,
  McpServerDefinitionSchema,
  McpServerNameSchema,
  type PartialYokeConfig,
  PartialYokeConfigSchema,
  type ResolvedYokeConfig,
  SCOPES,
  type Scope,
  type SyncOptions,
  stateKey,
} from "../core/schema.js";
import {
  type AdapterContext,
  type DesiredEntry,
  definedNames,
  type FileChangePlan,
  layerView,
  mergeServerEntries,
  type NativeEntry,
  NativeStateError,
  planJsonKeyPatch,
  readFileSnapshot,
  toDefinition,
  toNativeInstructions,
} from "./base.js";

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
 * transport, with no `type` and no string `command`, or with owned keys that do not fit its transport is opaque and kept
 * as-is (SPEC §6: an error only when yoke defines the same name, decided by mergeServerEntries). Corrupt owned keys throw
 * NativeStateError.
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
      return {
        kind: "opaque",
        raw,
        reason: `"${key}" does not fit transport "${transport}"`,
      };
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

/** A JSON array of strings as a fresh string array, or undefined when the value is not one. */
function asNameList(raw: JsonValue): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return undefined;
    }
    names.push(item);
  }
  return names;
}

/**
 * Reads a list of server names (Claude's per-project disable lists). Absent yields []. A malformed list throws
 * NativeStateError, unless `force` is set: then it counts as "no owned names", the file is not touched, and `warn`
 * receives one message.
 */
export function readNameList(
  raw: JsonValue | undefined,
  path: string,
  key: string,
  force = false,
  warn: (message: string) => void = () => {},
): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  const names = asNameList(raw);
  if (names !== undefined) {
    return names;
  }
  if (!force) {
    throw new NativeStateError(`${key} must be an array of strings`, path);
  }
  warn(
    `claude: ${key} in ${path} must be an array of strings; ignored because --force was given, and the file is left unchanged`,
  );
  return [];
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

// #region CL2 mcp

/** Requires a top-level JSON object when the file exists. Undefined when the file is missing. */
function topLevelObject(value: JsonValue | undefined, path: string): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    throw new NativeStateError("top level must be a JSON object", path);
  }
  return value;
}

/** Reads a path inside an optional object. Undefined when the object or the key is absent. */
function valueAt(root: JsonObject | undefined, keyPath: JsonKeyPath): JsonValue | undefined {
  return root === undefined ? undefined : getAtPath(root, keyPath);
}

/** Managed definitions only: opaque entries and in-entry extras are not part of the canonical state. */
function managedDefs(entries: ReadonlyMap<string, NativeEntry>): Map<string, McpServerDefinition> {
  const out = new Map<string, McpServerDefinition>();
  for (const [name, entry] of entries) {
    if (entry.kind === "managed") {
      out.set(name, entry.def);
    }
  }
  return out;
}

/** Reads one instructions file as a NativeInstructions value (undefined when missing). */
async function readInstructions(fs: ReadFs, path: string) {
  return toNativeInstructions(path, await readFileSnapshot(fs, path));
}

/**
 * Reads Claude's native state (SPEC §6, Q2). User tier: top-level `mcpServers`. Local tier: `projects[<repo>].mcpServers`
 * in the user config file. Project tier: `.mcp.json`. Names yoke owns in the per-project disable lists (D7, A6) show as
 * `enabled: false` in the local tier when a lower-tier definition exists. Never calls `ctx.exec`.
 */
export async function readClaudeNativeState(
  ctx: AdapterContext,
  repoPath: string,
  warn: (message: string) => void = () => {},
): Promise<PartialYokeConfig> {
  const paths = claudePaths(ctx.homeDir, ctx.env, repoPath);
  const repoKey = await claudeRepoKey(ctx.fs, repoPath);

  const userFile = await readJsonIfExists(ctx.fs, paths.userConfig);
  const userRoot = topLevelObject(userFile?.value, paths.userConfig);
  const projectFile = await readJsonIfExists(ctx.fs, paths.projectMcp);
  const projectRoot = topLevelObject(projectFile?.value, paths.projectMcp);

  const user = managedDefs(readClaudeServers(valueAt(userRoot, USER_MCP_KEY), paths.userConfig));
  const project = managedDefs(
    readClaudeServers(valueAt(projectRoot, USER_MCP_KEY), paths.projectMcp),
  );
  const repoEntry = projectEntry(userRoot, repoKey, paths.userConfig);
  const local = managedDefs(
    readClaudeServers(valueAt(repoEntry, ["mcpServers"]), paths.userConfig),
  );

  const ownedLists = ctx.lock?.harnesses[stateKey(CLAUDE_NAME, "local")]?.ownedNames ?? {};
  const disableLists: readonly { readonly id: string; readonly key: string }[] = [
    { id: DISABLED_SERVERS_LIST, key: "disabledMcpServers" },
    { id: DISABLED_MCPJSON_LIST, key: "disabledMcpjsonServers" },
  ];
  const owned = new Set<string>();
  for (const { id, key } of disableLists) {
    const claimed = ownedLists[id] ?? [];
    if (claimed.length === 0) {
      continue;
    }
    const native = readNameList(
      valueAt(repoEntry, [key]),
      paths.userConfig,
      key,
      ctx.force ?? false,
      warn,
    );
    for (const name of claimed) {
      if (native.includes(name)) {
        owned.add(name);
      }
    }
  }
  for (const name of owned) {
    const localDef = local.get(name);
    if (localDef !== undefined) {
      local.set(name, { ...localDef, enabled: false });
      continue;
    }
    const lower = project.get(name) ?? user.get(name);
    if (lower !== undefined) {
      local.set(name, { ...lower, enabled: false });
    }
  }

  const userInstructions = await readInstructions(ctx.fs, paths.userInstructions);
  const projectInstructions = await readInstructions(ctx.fs, paths.projectInstructions);
  const localInstructions = await readInstructions(ctx.fs, paths.localInstructions);

  return PartialYokeConfigSchema.parse({
    user: {
      mcps: Object.fromEntries(user),
      ...(userInstructions === undefined ? {} : { instructions: userInstructions }),
    },
    project: {
      mcps: Object.fromEntries(project),
      ...(projectInstructions === undefined ? {} : { instructions: projectInstructions }),
    },
    local: {
      mcps: Object.fromEntries(local),
      ...(localInstructions === undefined ? {} : { instructions: localInstructions }),
    },
  });
}

/**
 * Enabled servers that a scope should carry in its native file (Q2). Local uses the fully resolved definition from
 * `config.mcps`, because Claude does not field-merge. Project drops names that the local layer stubs out, in compiled
 * mode only (hybrid mode uses the disable lists instead, CL3).
 */
function desiredServers(
  config: ResolvedYokeConfig,
  scope: Scope,
  compiled: boolean,
): Map<string, McpServerDefinition> {
  const out = new Map<string, McpServerDefinition>();
  if (scope === "local") {
    for (const name of definedNames(config, "local")) {
      const server = config.mcps[name];
      if (server?.enabled === true) {
        out.set(name, toDefinition(server));
      }
    }
    return out;
  }
  for (const [name, server] of Object.entries(layerView(config, scope))) {
    if (!server.enabled) {
      continue;
    }
    if (scope === "project" && compiled && config.mcps[name]?.enabled === false) {
      continue;
    }
    out.set(name, toDefinition(server));
  }
  return out;
}

/**
 * Plans the MCP server key in each Claude file for the requested scopes. Every change is a key-scoped patch that
 * keeps the rest of the file. Native entries are merged with mergeServerEntries (Q1), so unknown keys survive.
 */
export async function planClaudeMcp(
  ctx: AdapterContext,
  config: ResolvedYokeConfig,
  opts: SyncOptions,
): Promise<FileChangePlan[]> {
  const paths = claudePaths(ctx.homeDir, ctx.env, opts.repoPath);
  const repoKey = await claudeRepoKey(ctx.fs, opts.repoPath);
  const compiled = config.mode === "compiled";
  const plans: FileChangePlan[] = [];

  for (const scope of SCOPES) {
    if (!opts.scopes.includes(scope)) {
      continue;
    }
    const isLocal = scope === "local";
    const path = scope === "project" ? paths.projectMcp : paths.userConfig;
    const keyPath = isLocal ? localMcpKey(repoKey) : USER_MCP_KEY;

    const file = await readJsonIfExists(ctx.fs, path);
    const root = topLevelObject(file?.value, path);
    const raw = isLocal
      ? valueAt(projectEntry(root, repoKey, path), ["mcpServers"])
      : valueAt(root, USER_MCP_KEY);
    const native = readClaudeServers(raw, path);

    const defs = desiredServers(config, scope, compiled);
    const desired = new Map<string, DesiredEntry>();
    for (const [name, def] of defs) {
      desired.set(name, { def, entry: toClaudeEntry(def) });
    }

    const merged = mergeServerEntries({
      harness: CLAUDE_NAME,
      path,
      native,
      desired,
      force: ctx.force ?? false,
    });
    plans.push(
      await planJsonKeyPatch(ctx.fs, {
        scope,
        path,
        keyPath,
        value: merged.value,
        summary: `${path}: ${keyPath.join(".")} (${defs.size} server${defs.size === 1 ? "" : "s"})`,
        warnings: merged.warnings,
        expected: [{ kind: "mcps", scope, mcps: Object.fromEntries(defs) }],
      }),
    );
  }

  return plans;
}

// #endregion CL2 mcp
