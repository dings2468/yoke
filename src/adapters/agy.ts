/**
 * src/adapters/agy.ts: agy (Antigravity) paths and MCP entry translation (SPEC §6).
 *
 * Facts used here:
 * - agy loads the project `GEMINI.md` alongside `AGENTS.md` (observed: a model turn listed both as loaded instruction files).
 * - The user `~/.gemini/GEMINI.md` location and the `agy` binary name are UNVERIFIED (SPEC §6).
 * - agy 1.5.16 does not expand `${VAR}` references. yoke stores them literally.
 * - agy 1.5.16 writes `serverUrl` for HTTP servers. yoke writes `url` (SPEC §6) and reads both keys.
 * - agy has no SSE transport. SSE servers are never translated here.
 */
import { join } from "node:path";
import { readJsonIfExists, toReadFs } from "../core/fs-safe.js";
import type { ExecResult } from "../core/git.js";
import { findConditionalTags, hasGeneratedHeader } from "../core/instructions.js";
import {
  getAtPath,
  isJsonObject,
  type JsonKeyPath,
  type JsonObject,
  type JsonValue,
} from "../core/json-text.js";
import {
  type McpHttpServer,
  type McpServerDefinition,
  McpServerDefinitionSchema,
  McpServerNameSchema,
  type McpStdioServer,
  type PartialYokeConfig,
  PartialYokeConfigSchema,
  type ResolvedYokeConfig,
  type Scope,
  type SyncOptions,
  stateKey,
} from "../core/schema.js";
import {
  type AdapterContext,
  advisoryPlan,
  type DesiredEntry,
  definedNames,
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
  stubNames,
  toDefinition,
  toNativeInstructions,
  usesEnvReference,
} from "./base.js";

export const AGY_NAME = "agy";

export interface AgyPaths {
  /** `<home>/.gemini/config/mcp_config.json` */
  readonly mcpConfig: string;
  /** `<home>/.gemini/GEMINI.md`, UNVERIFIED */
  readonly userInstructions: string;
  /** `<repo>/GEMINI.md`, loaded alongside AGENTS.md (observed) */
  readonly projectInstructions: string;
}

export function agyPaths(homeDir: string, repoPath: string): AgyPaths {
  return {
    mcpConfig: join(homeDir, ".gemini", "config", "mcp_config.json"),
    userInstructions: join(homeDir, ".gemini", "GEMINI.md"),
    projectInstructions: join(repoPath, "GEMINI.md"),
  };
}

/** The top-level key that holds MCP servers. yoke patches only this key. */
export const AGY_MCP_KEY: JsonKeyPath = ["mcpServers"];

/** Keys yoke interprets inside an entry. Every other key is kept as an extra. `type` is not in this set. */
const OWNED_KEYS: ReadonlySet<string> = new Set([
  "command",
  "args",
  "env",
  "url",
  "serverUrl",
  "headers",
  "disabled",
]);
const STDIO_ONLY_KEYS: readonly string[] = ["command", "args", "env"];
const HTTP_ONLY_KEYS: readonly string[] = ["url", "serverUrl", "headers"];

/**
 * Translates a yoke definition to an agy entry. `disabled: true` is written only when `enabled` is false.
 * HTTP servers are written with `url`, never `serverUrl`.
 */
export function toAgyEntry(def: McpStdioServer | McpHttpServer, enabled: boolean): JsonObject {
  let out: JsonObject;
  if (def.transport === "stdio") {
    out = { command: def.command };
    if (def.args !== undefined) {
      out.args = [...def.args];
    }
    if (def.env !== undefined) {
      out.env = Object.fromEntries(Object.entries(def.env));
    }
  } else {
    out = { url: def.url };
    if (def.headers !== undefined) {
      out.headers = Object.fromEntries(Object.entries(def.headers));
    }
  }
  if (!enabled) {
    out.disabled = true;
  }
  return out;
}

function isStringArray(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringMap(value: JsonValue): boolean {
  return isJsonObject(value) && Object.values(value).every((item) => typeof item === "string");
}

/**
 * Reads one agy entry (Q1). Returns `managed` with the canonical definition and extras. Returns `opaque`, with the
 * raw entry kept byte-for-byte, for an unknown `type`, an entry with neither a command nor a URL, or fields that do
 * not fit its transport (for example `command` with `url`, or `env` on an http entry). Throws NativeStateError for a
 * corrupt value: a non-string env or header value, a non-string-array `args`, an invalid name, `httpUrl`, or a `url`
 * that differs from `serverUrl`.
 */
export function fromAgyEntry(name: string, raw: JsonValue, path: string): NativeEntry {
  const failure = (why: string): NativeStateError =>
    new NativeStateError(`invalid agy MCP server "${name}" in ${path}: ${why}`, path, name);

  if (!McpServerNameSchema.safeParse(name).success) {
    throw failure("server name is not valid");
  }
  if (!isJsonObject(raw)) {
    throw failure("entry must be an object");
  }
  const present = (key: string): JsonValue | undefined =>
    Object.hasOwn(raw, key) ? raw[key] : undefined;

  if (Object.hasOwn(raw, "httpUrl")) {
    throw failure("httpUrl is not supported; use url");
  }
  const disabled = present("disabled");
  if (disabled !== undefined && typeof disabled !== "boolean") {
    throw failure("disabled must be a boolean");
  }
  const url = present("url");
  const serverUrl = present("serverUrl");
  if (
    (url !== undefined && typeof url !== "string") ||
    (serverUrl !== undefined && typeof serverUrl !== "string")
  ) {
    throw failure("url and serverUrl must be strings");
  }
  if (url !== undefined && serverUrl !== undefined && url !== serverUrl) {
    throw failure("url and serverUrl differ");
  }
  // Corrupt values throw whatever the transport, so a field that does not fit the entry still has to be well formed.
  const command = present("command");
  if (command !== undefined && typeof command !== "string") {
    throw failure("command must be a string");
  }
  const args = present("args");
  if (args !== undefined && !isStringArray(args)) {
    throw failure("args must be a string array");
  }
  const env = present("env");
  if (env !== undefined && !isStringMap(env)) {
    throw failure("env values must be strings");
  }
  const headers = present("headers");
  if (headers !== undefined && !isStringMap(headers)) {
    throw failure("headers values must be strings");
  }

  const type = present("type");
  if (type !== undefined && typeof type !== "string") {
    throw failure("type must be a string");
  }
  if (typeof type === "string" && type !== "stdio" && type !== "http") {
    return { kind: "opaque", raw, reason: `type "${type}"` };
  }

  const remoteUrl =
    typeof url === "string" ? url : typeof serverUrl === "string" ? serverUrl : undefined;
  let transport: "stdio" | "http";
  if (Object.hasOwn(raw, "command")) {
    transport = "stdio";
  } else if (remoteUrl !== undefined) {
    transport = "http";
  } else {
    return { kind: "opaque", raw, reason: "no command or url" };
  }

  // agy ignores `type`, but a field that does not fit the entry's transport makes the entry opaque (SPEC §6).
  const transportKey =
    transport === "stdio" ? "command" : Object.hasOwn(raw, "url") ? "url" : "serverUrl";
  const foreignKeys = transport === "stdio" ? HTTP_ONLY_KEYS : STDIO_ONLY_KEYS;
  for (const key of foreignKeys) {
    if (Object.hasOwn(raw, key)) {
      return { kind: "opaque", raw, reason: `"${transportKey}" conflicts with "${key}"` };
    }
  }
  if (type !== undefined && type !== transport) {
    return { kind: "opaque", raw, reason: `type "${type}" conflicts with a ${transport} entry` };
  }

  const wanted: Record<string, unknown> =
    transport === "stdio"
      ? { transport, command, args, env }
      : { transport, url: remoteUrl, headers };
  const candidate: Record<string, unknown> = Object.fromEntries(
    Object.entries(wanted).filter(([, value]) => value !== undefined),
  );
  if (disabled === true) {
    candidate.enabled = false;
  }
  const parsed = McpServerDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw failure(parsed.error.issues[0]?.message ?? "entry does not match the schema");
  }

  const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !OWNED_KEYS.has(key)));
  return { kind: "managed", def: parsed.data, extras };
}

/**
 * Reads the `mcpServers` value in native key order. `undefined` (key absent) yields an empty map.
 * Throws NativeStateError when the value is not an object or an entry is corrupt.
 */
export function readAgyServers(
  raw: JsonValue | undefined,
  path: string,
): ReadonlyMap<string, NativeEntry> {
  if (raw === undefined) {
    return new Map();
  }
  if (!isJsonObject(raw)) {
    throw new NativeStateError(`mcpServers must be an object in ${path}`, path);
  }
  return new Map<string, NativeEntry>(
    Object.entries(raw).map(([name, value]): [string, NativeEntry] => [
      name,
      fromAgyEntry(name, value, path),
    ]),
  );
}

// #region AG2 mcp

/** Managed (non-opaque) user-tier servers from the native file. Opaque entries are left out. */
function managedDefinitions(
  entries: ReadonlyMap<string, NativeEntry>,
): Readonly<Record<string, McpServerDefinition>> {
  const out: [string, McpServerDefinition][] = [];
  for (const [name, entry] of entries) {
    if (entry.kind === "managed") {
      out.push([name, entry.def]);
    }
  }
  return Object.fromEntries(out);
}

/**
 * Reads agy's user tier (`mcp_config.json`) and the GEMINI.md instructions. `user` holds the managed MCP definitions and
 * the user instructions. `project` holds an empty MCP map and the project instructions. There is no local tier.
 */
export async function readAgyNativeState(
  ctx: AdapterContext,
  repoPath: string,
): Promise<PartialYokeConfig> {
  const paths = agyPaths(ctx.homeDir, repoPath);
  const cur = await readJsonIfExists(ctx.fs, paths.mcpConfig);
  const raw = cur === undefined ? undefined : getAtPath(cur.value, AGY_MCP_KEY);
  const servers = readAgyServers(raw, paths.mcpConfig);

  const userInstructions = toNativeInstructions(
    paths.userInstructions,
    await readFileSnapshot(ctx.fs, paths.userInstructions),
  );
  const projectInstructions = toNativeInstructions(
    paths.projectInstructions,
    await readFileSnapshot(ctx.fs, paths.projectInstructions),
  );

  const user = {
    mcps: managedDefinitions(servers),
    ...(userInstructions === undefined ? {} : { instructions: userInstructions }),
  };
  const project = {
    mcps: {},
    ...(projectInstructions === undefined ? {} : { instructions: projectInstructions }),
  };
  return PartialYokeConfigSchema.parse({ user, project });
}

/** Translates the user-tier desired servers. SSE is skipped with a warning; `${VAR}` gets one warning per server. */
function userDesired(config: ResolvedYokeConfig): {
  readonly desired: ReadonlyMap<string, DesiredEntry>;
  readonly mcps: Readonly<Record<string, McpServerDefinition>>;
  readonly warnings: readonly string[];
} {
  const desired = new Map<string, DesiredEntry>();
  const mcps: Record<string, McpServerDefinition> = {};
  const warnings: string[] = [];
  for (const [name, server] of Object.entries(layerView(config, "user"))) {
    const def = toDefinition(server);
    if (def.transport === "sse") {
      warnings.push(`agy: MCP server "${name}" skipped: agy does not support SSE transport`);
      continue;
    }
    desired.set(name, { def, entry: toAgyEntry(def, server.enabled) });
    mcps[name] = def;
    if (usesEnvReference(def)) {
      warnings.push(
        `agy: MCP server "${name}" uses \${VAR} references in env/headers; agy does not expand them, so the literal text is sent`,
      );
    }
  }
  return { desired, mcps, warnings };
}

async function planUserMcp(
  ctx: AdapterContext,
  config: ResolvedYokeConfig,
  path: string,
): Promise<FileChangePlan> {
  const cur = await readJsonIfExists(ctx.fs, path);
  const raw = cur === undefined ? undefined : getAtPath(cur.value, AGY_MCP_KEY);
  const native = readAgyServers(raw, path);
  const { desired, mcps, warnings } = userDesired(config);
  const merged = mergeServerEntries({
    harness: AGY_NAME,
    path,
    native,
    desired,
    force: ctx.force ?? false,
  });
  return planJsonKeyPatch(ctx.fs, {
    scope: "user",
    path,
    keyPath: AGY_MCP_KEY,
    value: merged.value,
    summary: `agy: user MCP servers in ${path}`,
    warnings: [...warnings, ...merged.warnings],
    expected: [{ kind: "mcps", scope: "user", mcps }],
  });
}

/**
 * Plans the agy MCP config (SPEC §6). The user scope writes `mcp_config.json`. Project and local servers are never
 * written to the global file: each one produces a warning in an advisory plan that changes nothing.
 */
export async function planAgyMcp(
  ctx: AdapterContext,
  config: ResolvedYokeConfig,
  opts: SyncOptions,
): Promise<FileChangePlan[]> {
  const paths = agyPaths(ctx.homeDir, opts.repoPath);
  const plans: FileChangePlan[] = [];
  if (opts.scopes.includes("user")) {
    plans.push(await planUserMcp(ctx, config, paths.mcpConfig));
  }
  for (const scope of ["project", "local"] as const) {
    if (!opts.scopes.includes(scope)) {
      continue;
    }
    const names = [...definedNames(config, scope), ...stubNames(config, scope)].sort();
    if (names.length === 0) {
      continue;
    }
    plans.push(
      advisoryPlan(
        scope,
        paths.mcpConfig,
        `agy: ${scope} MCP servers are not written`,
        names.map(
          (name) =>
            `agy: MCP server "${name}" (${scope} scope) skipped: agy has no project-level MCP config in v0.1; not written to the global file`,
        ),
      ),
    );
  }
  return plans;
}

// #endregion AG2 mcp

// #region AG3 sync

/** Capabilities of the agy adapter in v0.1 (decision D11). */
export const AGY_CAPABILITIES: HarnessCapabilities = {
  staticMcp: true,
  staticInstructions: true,
  reverseRead: true,
  sessionExport: false,
  sessionImport: "handoff-file-only",
};

/** True when the lock records an instructions hash for agy at this scope, so yoke wrote that file earlier. */
function instructionsRecorded(ctx: AdapterContext, scope: Scope): boolean {
  return (ctx.lock?.harnesses[stateKey(AGY_NAME, scope)]?.instructionsHash ?? null) !== null;
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
    `agy: ${sourcePath} has legacy yoke:*-only tags on line${plural} ${lines.join(", ")}; move claude-only text to CLAUDE.md, agy-only text to GEMINI.md`,
  ]);
}

/**
 * Plans the agy instruction files (decisions 2, 6-8). User scope links `<home>/.gemini/GEMINI.md` to the canonical user
 * AGENTS.md. Project scope writes no file: a yoke-generated `<repo>/GEMINI.md` is removed with a backup, and a
 * user-written one is never touched. Legacy tags in AGENTS.md get a warning. The project GEMINI.md is observed to load
 * alongside AGENTS.md; the user `~/.gemini/GEMINI.md` location is UNVERIFIED (SPEC §6).
 */
async function planAgyInstructions(
  ctx: AdapterContext,
  opts: SyncOptions,
): Promise<FileChangePlan[]> {
  const paths = agyPaths(ctx.homeDir, opts.repoPath);
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
    add(
      await planGeneratedRemoval(ctx, {
        scope: "project",
        path: paths.projectInstructions,
        sourcePath: projectSource,
        recordedInLock: instructionsRecorded(ctx, "project"),
      }),
    );
    add(await legacyTagPlan(ctx, "project", projectSource));
  }

  return plans;
}

/**
 * Plans every agy change for a sync: the MCP config first, then the instruction files. Reads only. The caller applies
 * each returned plan. No plan writes to the global MCP file for project or local servers.
 */
export async function planAgySync(
  ctx: AdapterContext,
  config: ResolvedYokeConfig,
  opts: SyncOptions,
): Promise<FileChangePlan[]> {
  const mcp = await planAgyMcp(ctx, config, opts);
  const instructions = await planAgyInstructions(ctx, opts);
  return [...mcp, ...instructions];
}

/**
 * Detects the agy binary. Runs `agy --version` only, and writes nothing. `authenticated` is always false in v0.1.
 * v0.1 runs no login probe (SPEC §6); doctor reports auth as unknown.
 */
export async function detectAgy(ctx: AdapterContext): Promise<HarnessStatus> {
  let result: ExecResult;
  try {
    result = await ctx.exec("agy", ["--version"], { cwd: ctx.homeDir });
  } catch {
    return { installed: false, authenticated: false };
  }
  if (result.exitCode !== 0) {
    return { installed: false, authenticated: false };
  }
  const version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
  return {
    installed: true,
    authenticated: false,
    ...(version === undefined ? {} : { version }),
  };
}

/**
 * Builds the agy HarnessAdapter. The filesystem is wrapped with toReadFs, so every planning call is read-only. Only the
 * apply closures of the returned plans write, and they use the ApplyContext the caller supplies.
 */
export function createAgyAdapter(ctx: AdapterContext): HarnessAdapter {
  const readOnly: AdapterContext = { ...ctx, fs: toReadFs(ctx.fs) };
  return {
    name: AGY_NAME,
    capabilities: AGY_CAPABILITIES,
    detect: () => detectAgy(readOnly),
    readNativeState: (repoPath) => readAgyNativeState(readOnly, repoPath),
    syncStatic: (config, opts) => planAgySync(readOnly, config, opts),
  };
}

// #endregion AG3 sync
