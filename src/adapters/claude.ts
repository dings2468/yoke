/**
 * src/adapters/claude.ts — Claude Code paths, native key names, and MCP entry translation (SPEC §6, decisions Q1 and Q2).
 *
 * Only this file and src/adapters/claude*.ts may name Claude paths, keys, or transports. Planning is pure: every read
 * goes through an injected ReadFs, and nothing here touches the disk, the environment, or the clock beyond `env`.
 */
import { isAbsolute, join } from "node:path";
import {
  isNotFound,
  type ReadFs,
  readJsonIfExists,
  readTextIfExists,
  toReadFs,
} from "../core/fs-safe.js";
import type { Env, ExecResult } from "../core/git.js";
import { findConditionalTags, hasGeneratedHeader } from "../core/instructions.js";
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
  advisoryPlan,
  type DesiredEntry,
  definedNames,
  disabledNames,
  type FileChangePlan,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessStatus,
  type InstructionRemovalInput,
  layerView,
  mergeServerEntries,
  type NativeEntry,
  NativeStateError,
  planInstructionLink,
  planInstructionRemoval,
  planJsonKeyPatch,
  readFileSnapshot,
  toDefinition,
  toNativeInstructions,
  updateOwnedList,
} from "./base.js";

export const CLAUDE_NAME = "claude";

/** The one line Claude needs at the top of a user-written CLAUDE.md to load the shared AGENTS.md. */
const CLAUDE_IMPORT_LINE = "@AGENTS.md";
const BOM = "﻿";
/** Lock list id for Claude's per-project disable list of user-scope servers (decision D7). */
export const DISABLED_SERVERS_LIST = "disabled-servers";

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

  const claimed =
    ctx.lock?.harnesses[stateKey(CLAUDE_NAME, "local")]?.ownedNames?.[DISABLED_SERVERS_LIST] ?? [];
  const owned = new Set<string>();
  if (claimed.length > 0) {
    const native = readNameList(
      valueAt(repoEntry, ["disabledMcpServers"]),
      paths.userConfig,
      "disabledMcpServers",
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

// #region CL3 sync

/** D11: sync and detect only. No session methods are implemented, so sessionExport is false. */
export const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  staticMcp: true,
  staticInstructions: true,
  reverseRead: true,
  sessionExport: false,
  sessionImport: "handoff-file-only",
};

/** The `mcps` map one plan expects for a scope, or undefined when that scope was not planned. */
function plannedMcps(
  plans: readonly FileChangePlan[],
  scope: Scope,
): Record<string, McpServerDefinition> | undefined {
  for (const plan of plans) {
    if (plan.scope !== scope) {
      continue;
    }
    for (const target of plan.expected) {
      if (target.kind === "mcps") {
        return { ...target.mcps };
      }
    }
  }
  return undefined;
}

/**
 * Lock `mcps` for owned disables: each name's lower-tier definition (project first, then user), with `enabled: false`.
 * Names with no definition in `post.user` are left out.
 */
function disabledDefs(
  names: readonly string[],
  post: {
    readonly user: Readonly<Record<string, McpServerDefinition>>;
    readonly project: Readonly<Record<string, McpServerDefinition>>;
  },
): Record<string, McpServerDefinition> {
  const out: Record<string, McpServerDefinition> = {};
  for (const name of names) {
    const lower = Object.hasOwn(post.project, name) ? post.project[name] : post.user[name];
    if (lower !== undefined) {
      out[name] = { ...lower, enabled: false };
    }
  }
  return out;
}

/**
 * Plans Claude's per-project disable list for user-scope servers (`projects[<repo>].disabledMcpServers` in the user
 * config). Runs only when `local` is in `opts.scopes`. Names come from the merged config's disabled set that exist in
 * the user tier. A malformed list throws unless `force` is set; then nothing is written, the lock's previous owned
 * names are kept, and each wanted name gets a fallback warning. In hybrid mode nothing is written: the list is left alone,
 * the lock's owned names are kept, and each wanted name gets a warning to disable it inside Claude.
 */
export async function planClaudeDisables(
  ctx: AdapterContext,
  config: ResolvedYokeConfig,
  opts: SyncOptions,
  post: {
    readonly user: Readonly<Record<string, McpServerDefinition>>;
    readonly project: Readonly<Record<string, McpServerDefinition>>;
  },
): Promise<FileChangePlan[]> {
  if (!opts.scopes.includes("local")) {
    return [];
  }
  const paths = claudePaths(ctx.homeDir, ctx.env, opts.repoPath);
  const repoKey = await claudeRepoKey(ctx.fs, opts.repoPath);
  const lockOwned =
    ctx.lock?.harnesses[stateKey(CLAUDE_NAME, "local")]?.ownedNames?.[DISABLED_SERVERS_LIST] ?? [];
  const desired = disabledNames(config).filter((name) => Object.hasOwn(post.user, name));

  if (config.mode === "hybrid") {
    // Hybrid mode does not write the native list in v0.1 (SPEC §3, D1). It warns, leaves the list alone, and keeps owned names.
    const hybridWarnings = desired.map(
      (name) =>
        `claude: hybrid mode does not disable user server "${name}" for this repo in v0.1; run /mcp disable ${name} inside Claude in this repo`,
    );
    const hybridKept = lockOwned.filter((name) => Object.hasOwn(post.user, name));
    return [
      {
        ...advisoryPlan(
          "local",
          paths.userConfig,
          `claude: hybrid mode: ${paths.userConfig} projects[${repoKey}].disabledMcpServers left unchanged`,
          hybridWarnings,
        ),
        expected: [
          { kind: "owned-names", scope: "local", list: DISABLED_SERVERS_LIST, names: lockOwned },
          { kind: "mcps", scope: "local", mcps: disabledDefs(hybridKept, post) },
        ],
      },
    ];
  }

  const file = await readJsonIfExists(ctx.fs, paths.userConfig);
  const root = topLevelObject(file?.value, paths.userConfig);
  const entry = projectEntry(root, repoKey, paths.userConfig);
  const listDesc = `${paths.userConfig} projects[${repoKey}].disabledMcpServers`;

  let nativeList: readonly string[];
  try {
    nativeList = readNameList(
      valueAt(entry, ["disabledMcpServers"]),
      paths.userConfig,
      "disabledMcpServers",
      false,
    );
  } catch (err: unknown) {
    if (!(err instanceof NativeStateError) || ctx.force !== true) {
      throw err;
    }
    const warnings = desired.map(
      (name) =>
        `claude: cannot disable "${name}" (local scope, yoke.local.yaml): it is still defined in Claude user config ${paths.userConfig} and will load in this repo; run /mcp disable ${name} inside Claude in this repo (do not use "claude mcp remove", which deletes it everywhere and wipes its OAuth tokens)`,
    );
    const kept = lockOwned.filter((name) => Object.hasOwn(post.user, name));
    return [
      {
        ...advisoryPlan(
          "local",
          paths.userConfig,
          `claude: ${listDesc} is malformed; left unchanged`,
          warnings,
        ),
        expected: [
          { kind: "owned-names", scope: "local", list: DISABLED_SERVERS_LIST, names: lockOwned },
          { kind: "mcps", scope: "local", mcps: disabledDefs(kept, post) },
        ],
      },
    ];
  }

  const { after, owned } = updateOwnedList({ native: nativeList, lockOwned, desired });
  const lines = [
    ...owned
      .filter((name) => !nativeList.includes(name))
      .map((name) => `claude: disabled user server "${name}" for this repo (${listDesc})`),
    ...lockOwned
      .filter((name) => nativeList.includes(name) && !after.includes(name))
      .map((name) => `claude: re-enabled user server "${name}" for this repo (${listDesc})`),
  ];
  const plan = await planJsonKeyPatch(ctx.fs, {
    scope: "local",
    path: paths.userConfig,
    keyPath: disabledServersKey(repoKey),
    value: [...after],
    summary: lines.length > 0 ? lines.join("\n") : `claude: ${listDesc} unchanged`,
    warnings: [],
    expected: [
      { kind: "owned-names", scope: "local", list: DISABLED_SERVERS_LIST, names: owned },
      { kind: "mcps", scope: "local", mcps: disabledDefs(owned, post) },
    ],
  });
  return [plan];
}

/** True when the lock records an instructions hash for Claude at this scope, so yoke wrote that file earlier. */
function instructionsRecorded(ctx: AdapterContext, scope: Scope): boolean {
  return (ctx.lock?.harnesses[stateKey(CLAUDE_NAME, scope)]?.instructionsHash ?? null) !== null;
}

/**
 * A removal plan for a native instructions path that yoke may have generated. A user-written file that the lock does
 * not record is never planned, so it produces no warning and is never touched. A missing path with no lock record is
 * skipped too.
 */
async function planGeneratedRemoval(
  ctx: AdapterContext,
  input: InstructionRemovalInput,
): Promise<FileChangePlan | undefined> {
  if (input.recordedInLock !== true) {
    const snap = await readFileSnapshot(ctx.fs, input.path);
    if (snap.kind === "missing") {
      return undefined;
    }
    if (snap.kind === "file" && !hasGeneratedHeader(snap.content)) {
      return undefined;
    }
  }
  return planInstructionRemoval(ctx, input);
}

/** An advisory warning when a canonical AGENTS.md still has legacy yoke:*-only tags (decision 4). */
async function legacyTagPlan(
  ctx: AdapterContext,
  scope: Scope,
  sourcePath: string,
): Promise<FileChangePlan | undefined> {
  const snap = await readFileSnapshot(ctx.fs, sourcePath);
  if (snap.kind !== "file") {
    return undefined;
  }
  const lines = findConditionalTags(snap.content);
  if (lines.length === 0) {
    return undefined;
  }
  const plural = lines.length === 1 ? "" : "s";
  return advisoryPlan(scope, sourcePath, `${sourcePath}: legacy yoke tags`, [
    `claude: ${sourcePath} has legacy yoke:*-only tags on line${plural} ${lines.join(", ")}; move claude-only text to CLAUDE.md, agy-only text to GEMINI.md`,
  ]);
}

/**
 * An advisory warning for a user-written project CLAUDE.md whose first non-blank line is not `@AGENTS.md`. Yoke never
 * writes that file (decision 3). A file yoke generated (recorded or with the header) is left to the removal plan.
 */
async function claudeImportPlan(
  ctx: AdapterContext,
  path: string,
  recorded: boolean,
): Promise<FileChangePlan | undefined> {
  const snap = await readFileSnapshot(ctx.fs, path);
  if (snap.kind !== "file" || recorded || hasGeneratedHeader(snap.content)) {
    return undefined;
  }
  const first = snap.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (first === "@AGENTS.md") {
    return undefined;
  }
  return advisoryPlan("project", path, `${path}: user-written CLAUDE.md`, [
    `claude: ${path} does not start with the line @AGENTS.md, so Claude will not read the shared AGENTS.md; add it as the first line`,
  ]);
}

/**
 * Doctor advice: a user-written project CLAUDE.md whose first non-empty line is not exactly `@AGENTS.md` means Claude
 * will not load AGENTS.md. Read-only: it uses only the injected read handle.
 */
export async function claudeDoctorWarnings(
  fs: ReadFs,
  repoPath: string,
): Promise<readonly string[]> {
  const text = await readTextIfExists(fs, join(repoPath, "CLAUDE.md"));
  if (text === undefined) {
    return [];
  }
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const first = body
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .find((line) => line.trim() !== "");
  if (first === CLAUDE_IMPORT_LINE) {
    return [];
  }
  return [
    "CLAUDE.md does not start with @AGENTS.md, so Claude will not load AGENTS.md while this file exists; add `@AGENTS.md` as its first line",
  ];
}

/**
 * Plans Claude's instruction files (decisions 3, 6-8). User scope links CLAUDE.md to the canonical user AGENTS.md. Project
 * and local scope write no file: a yoke-generated CLAUDE.md or CLAUDE.local.md is removed with a backup, and a user-written
 * CLAUDE.md gets a warning when it does not import AGENTS.md. Legacy tags in AGENTS.md get a warning.
 */
async function planClaudeInstructions(
  ctx: AdapterContext,
  opts: SyncOptions,
): Promise<FileChangePlan[]> {
  const paths = claudePaths(ctx.homeDir, ctx.env, opts.repoPath);
  const userSource = join(ctx.userConfigDir, "AGENTS.md");
  const projectSource = join(opts.repoPath, "AGENTS.md");
  const plans: FileChangePlan[] = [];
  const add = (plan: FileChangePlan | undefined): void => {
    if (plan !== undefined) {
      plans.push(plan);
    }
  };

  if (opts.scopes.includes("user")) {
    add(
      await planInstructionLink(ctx, {
        scope: "user",
        linkPath: paths.userInstructions,
        sourcePath: userSource,
      }),
    );
    add(await legacyTagPlan(ctx, "user", userSource));
  }
  if (opts.scopes.includes("project")) {
    const recorded = instructionsRecorded(ctx, "project");
    add(
      await planGeneratedRemoval(ctx, {
        scope: "project",
        path: paths.projectInstructions,
        sourcePath: projectSource,
        recordedInLock: recorded,
      }),
    );
    add(await claudeImportPlan(ctx, paths.projectInstructions, recorded));
    add(await legacyTagPlan(ctx, "project", projectSource));
  }
  if (opts.scopes.includes("local")) {
    add(
      await planGeneratedRemoval(ctx, {
        scope: "local",
        path: paths.localInstructions,
        sourcePath: projectSource,
        recordedInLock: instructionsRecorded(ctx, "local"),
      }),
    );
  }
  return plans;
}

/**
 * Plans every Claude file for the requested scopes: MCP keys, disable list, and instructions. Reads only. Each
 * FileChangePlan carries an apply closure built by the shared commit functions, which are the only writers.
 */
export async function planClaudeSync(
  ctx: AdapterContext,
  config: ResolvedYokeConfig,
  opts: SyncOptions,
): Promise<FileChangePlan[]> {
  const mcp = await planClaudeMcp(ctx, config, opts);
  const native = await readClaudeNativeState(ctx, opts.repoPath);
  const post = {
    user: plannedMcps(mcp, "user") ?? native.user?.mcps ?? {},
    project: plannedMcps(mcp, "project") ?? native.project?.mcps ?? {},
  };
  const disables = await planClaudeDisables(ctx, config, opts, post);
  const instructions = await planClaudeInstructions(ctx, opts);

  return [...mcp, ...disables, ...instructions];
}

/**
 * Detects the Claude Code CLI. Runs `claude --version` only; never writes. A spawn failure or a non-zero exit means
 * not installed. `authenticated` is a heuristic: an `oauthAccount` object in the user config, or a non-empty
 * ANTHROPIC_API_KEY. An unreadable user config counts as not authenticated.
 */
export async function detectClaude(ctx: AdapterContext): Promise<HarnessStatus> {
  let result: ExecResult;
  try {
    result = await ctx.exec("claude", ["--version"], { cwd: ctx.homeDir });
  } catch {
    return { installed: false, authenticated: false };
  }
  if (result.exitCode !== 0) {
    return { installed: false, authenticated: false };
  }
  const version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
  return {
    installed: true,
    authenticated: await claudeAuthenticated(ctx),
    ...(version === undefined ? {} : { version }),
  };
}

async function claudeAuthenticated(ctx: AdapterContext): Promise<boolean> {
  if ((ctx.env.ANTHROPIC_API_KEY ?? "") !== "") {
    return true;
  }
  const path = claudePaths(ctx.homeDir, ctx.env, ctx.homeDir).userConfig;
  try {
    const file = await readJsonIfExists(ctx.fs, path);
    const root = topLevelObject(file?.value, path);
    return isJsonObject(valueAt(root, ["oauthAccount"]));
  } catch {
    return false;
  }
}

/**
 * The Claude adapter. The context's filesystem is narrowed to read methods here, so planning cannot reach a write
 * method even when the caller passes a full Fs. Writes happen only inside plan apply closures.
 */
export function createClaudeAdapter(ctx: AdapterContext): HarnessAdapter {
  const readCtx: AdapterContext = { ...ctx, fs: toReadFs(ctx.fs) };
  return {
    name: CLAUDE_NAME,
    capabilities: CLAUDE_CAPABILITIES,
    detect: () => detectClaude(readCtx),
    readNativeState: (repoPath) => readClaudeNativeState(readCtx, repoPath),
    syncStatic: (config, opts) => planClaudeSync(readCtx, config, opts),
    doctorWarnings: (p) => claudeDoctorWarnings(readCtx.fs, p.repoPath),
  };
}

// #endregion CL3 sync
