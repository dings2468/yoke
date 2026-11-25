/**
 * src/adapters/base.ts — harness adapter contract and shared, harness-neutral helpers (SPEC §6).
 *
 * Planning functions are pure reads through an injected ReadFs. Writes happen only inside FileChangePlan.apply(ctx),
 * which receives the writable Fs and the backup session. No clock, no process state, no home directory lookups.
 */
import { dirname, resolve } from "node:path";
import { hasGeneratedHeader } from "../core/compiler.js";
import type { ExpectedTarget } from "../core/drift.js";
import {
  type BackupSession,
  commitJsonPatch,
  commitRemove,
  type FileStat,
  type Fs,
  isNotFound,
  planJsonPatch,
  planRemove,
  type ReadFs,
  readJsonIfExists,
  readTextIfExists,
  relativeLinkTarget,
  safeSymlink,
} from "../core/fs-safe.js";
import type { Env, Exec } from "../core/git.js";
import {
  getAtPath,
  isJsonObject,
  type JsonKeyPath,
  type JsonObject,
  type JsonValue,
} from "../core/json-text.js";
import {
  isMcpDisabledStub,
  type LaunchOptions,
  type McpHttpServer,
  type McpServerDefinition,
  type McpSseServer,
  type McpStdioServer,
  type NativeInstructions,
  type PartialYokeConfig,
  type ResolvedMcpServer,
  type ResolvedYokeConfig,
  type Scope,
  type SyncOptions,
  type YokeSessionIR,
  type YokeStateLock,
} from "../core/schema.js";
import { mergeMcpServers, type ScopeInputs } from "../core/scopes.js";

export interface HarnessCapabilities {
  readonly staticMcp: boolean;
  readonly staticInstructions: boolean;
  /** Required for drift detection and init in v0.1, and for absorption in v0.2. */
  readonly reverseRead: boolean;
  readonly sessionExport: boolean;
  readonly sessionImport: "native" | "seeded" | "handoff-file-only";
}

export interface HarnessStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly version?: string;
}

export type FileChangeAction = "create" | "update" | "symlink" | "patch-json" | "remove" | "noop";

/** Writable context handed to FileChangePlan.apply. Adapters never see the clock or a dry-run flag. */
export interface ApplyContext {
  readonly fs: Fs;
  readonly backup: BackupSession;
}

export interface ApplyResult {
  readonly status: "written" | "unchanged" | "fallback";
  readonly backupPath: string | undefined;
  readonly detail?: string;
}

/**
 * One planned change to one native file. SPEC §6 fields `path`, `action`, `summary`, `before`, and `after` keep their
 * names and string types. `before` and `after` are file text for diffs; `undefined` means a missing file, or a symlink
 * (see `link`). The remaining fields are yoke-specific additions.
 */
export interface FileChangePlan {
  readonly scope: Scope;
  readonly path: string;
  readonly action: FileChangeAction;
  readonly summary: string;
  /** Current file text. undefined = missing file, or a symlink (see `link`). */
  readonly before?: string;
  /** Planned file text. undefined = a symlink, or an advisory plan. */
  readonly after?: string;
  /** Symlink target text before and after the change. */
  readonly link?: { readonly before?: string; readonly after?: string };
  /** Warnings for this change. Planning never calls a warn callback; dry-run and real runs show the same text. */
  readonly warnings: readonly string[];
  /** What the lock records for this path after apply. */
  readonly expected: readonly ExpectedTarget[];
  /** True when apply() re-reads the file and patches only its own key, so several such plans may share a path. */
  readonly composable?: boolean;
  readonly apply: (ctx: ApplyContext) => Promise<ApplyResult>;
}

/** Runtime context an adapter is constructed with. Tests inject every path. */
export interface AdapterContext {
  readonly homeDir: string;
  readonly userConfigDir: string;
  readonly fs: ReadFs;
  readonly exec: Exec;
  readonly env: Env;
  /** Parsed `.yoke/state.json`, validated by the command. */
  readonly lock?: YokeStateLock;
  /** `--force`: proceed past native drift and malformed-but-recoverable state. */
  readonly force?: boolean;
  /** False when the platform cannot create symlinks; adapters then fall back to a copy with a warning. */
  readonly symlinksSupported?: boolean;
}

export interface HarnessAdapter {
  readonly name: string;
  readonly capabilities: HarnessCapabilities;
  detect(): Promise<HarnessStatus>;
  readNativeState(repoPath: string): Promise<PartialYokeConfig>;
  syncStatic(config: ResolvedYokeConfig, opts: SyncOptions): Promise<FileChangePlan[]>;
  exportLatestSession?(repoPath: string): Promise<YokeSessionIR | null>;
  importAndLaunch?(session: YokeSessionIR, opts: LaunchOptions): Promise<void>;
}

/** A native entry that cannot be read safely: corrupt owned key, or an error for a server yoke defines. */
export class NativeStateError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly server?: string,
  ) {
    super(message);
    this.name = "NativeStateError";
  }
}

/**
 * One native MCP entry after translation. `managed` entries are owned by yoke and carry unknown in-entry keys as
 * `extras`. `opaque` entries (unknown transport, for example) are kept verbatim and never compared for drift.
 */
export type NativeEntry =
  | { readonly kind: "managed"; readonly def: McpServerDefinition; readonly extras: JsonObject }
  | { readonly kind: "opaque"; readonly raw: JsonValue; readonly reason: string };

export type FileSnapshot =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly content: string }
  | { readonly kind: "symlink"; readonly target: string };

/** A no-op plan for a warning with no file to change. Its apply does no I/O. */
export function advisoryPlan(
  scope: Scope,
  path: string,
  summary: string,
  warnings: readonly string[],
): FileChangePlan {
  return {
    scope,
    path,
    action: "noop",
    summary,
    warnings: [...warnings],
    expected: [],
    apply: () => Promise.resolve({ status: "unchanged", backupPath: undefined }),
  };
}

function byCodeUnit(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** The merged view of one scope layer alone (empty when the layer is absent). */
export function layerView(
  config: ResolvedYokeConfig,
  scope: Scope,
): Readonly<Record<string, ResolvedMcpServer>> {
  const layer = config.layers[scope];
  if (layer === undefined) {
    return {};
  }
  const inputs: ScopeInputs = {};
  inputs[scope] = { config: layer, baseDir: "/" };
  return mergeMcpServers(inputs, () => {});
}

/** Names with a full (non-stub) definition in `layers[scope].mcps`, sorted. */
export function definedNames(config: ResolvedYokeConfig, scope: Scope): readonly string[] {
  const mcps = config.layers[scope]?.mcps ?? {};
  return Object.entries(mcps)
    .filter(([, entry]) => !isMcpDisabledStub(entry))
    .map(([name]) => name)
    .sort(byCodeUnit);
}

/** Names that have an `enabled: false` stub in `layers[scope].mcps`, sorted. */
export function stubNames(config: ResolvedYokeConfig, scope: Scope): readonly string[] {
  const mcps = config.layers[scope]?.mcps ?? {};
  return Object.entries(mcps)
    .filter(([, entry]) => isMcpDisabledStub(entry))
    .map(([name]) => name)
    .sort(byCodeUnit);
}

/**
 * Names whose merged result is disabled: `enabled: false` in the merged config, plus project and local stubs that
 * the merge dropped (nothing beneath them). Sorted, unique.
 */
export function disabledNames(config: ResolvedYokeConfig): readonly string[] {
  const names = new Set<string>();
  for (const [name, server] of Object.entries(config.mcps)) {
    if (server.enabled === false) {
      names.add(name);
    }
  }
  for (const scope of ["project", "local"] as const) {
    for (const name of stubNames(config, scope)) {
      if (!Object.hasOwn(config.mcps, name)) {
        names.add(name);
      }
    }
  }
  return [...names].sort(byCodeUnit);
}

function disabledFlag(server: { readonly enabled: boolean }): { enabled?: false } {
  return server.enabled ? {} : { enabled: false };
}

function assertNever(value: never): never {
  throw new Error(`unhandled value: ${JSON.stringify(value)}`);
}

/** Converts a merged server to a full definition: drops `scopes`, keeps `enabled` only when false. Returns fresh copies. */
export function toDefinition(server: ResolvedMcpServer): McpServerDefinition {
  switch (server.transport) {
    case "stdio": {
      const out: McpStdioServer = {
        transport: "stdio",
        command: server.command,
        ...disabledFlag(server),
      };
      if (server.args !== undefined) {
        out.args = [...server.args];
      }
      if (server.env !== undefined) {
        out.env = { ...server.env };
      }
      return out;
    }
    case "http": {
      const out: McpHttpServer = { transport: "http", url: server.url, ...disabledFlag(server) };
      if (server.headers !== undefined) {
        out.headers = { ...server.headers };
      }
      return out;
    }
    case "sse": {
      const out: McpSseServer = { transport: "sse", url: server.url, ...disabledFlag(server) };
      if (server.headers !== undefined) {
        out.headers = { ...server.headers };
      }
      return out;
    }
    default:
      return assertNever(server);
  }
}

/**
 * Reads a path without following links: lstat, then readlink for a symlink, or readFile for a file.
 * A missing path yields "missing". A directory throws NativeStateError.
 */
export async function readFileSnapshot(fs: ReadFs, path: string): Promise<FileSnapshot> {
  let stat: FileStat;
  try {
    stat = await fs.lstat(path);
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return { kind: "missing" };
    }
    throw err;
  }
  if (stat.isSymbolicLink) {
    return { kind: "symlink", target: await fs.readlink(path) };
  }
  if (stat.isDirectory) {
    throw new NativeStateError(`expected a file but found a directory: ${path}`, path);
  }
  return { kind: "file", content: await fs.readFile(path) };
}

/** Maps a snapshot to a NativeInstructions value. A missing path yields undefined. */
export function toNativeInstructions(
  path: string,
  snap: FileSnapshot,
): NativeInstructions | undefined {
  switch (snap.kind) {
    case "missing":
      return undefined;
    case "file":
      return { kind: "file", path, content: snap.content };
    case "symlink":
      return { kind: "symlink", path, target: snap.target };
    default:
      return assertNever(snap);
  }
}

// #region BA2 json plans

export interface JsonKeyPlanInput {
  readonly scope: Scope;
  readonly path: string;
  readonly keyPath: JsonKeyPath;
  readonly value: JsonValue;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly expected: readonly ExpectedTarget[];
}

/** True for an empty object or an empty array. */
function isEmptyContainer(value: JsonValue): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return isJsonObject(value) && Object.keys(value).length === 0;
}

/**
 * Plans one key-scoped JSON edit. Reads only; `apply` commits through commitJsonPatch, which rebases on the
 * current text and keeps every other key. An empty value on an absent key is a noop that never creates a file.
 */
export async function planJsonKeyPatch(
  fs: ReadFs,
  input: JsonKeyPlanInput,
): Promise<FileChangePlan> {
  const { scope, path, keyPath, value, summary } = input;
  const warnings = [...input.warnings];
  const expected = [...input.expected];

  const cur = await readJsonIfExists(fs, path);
  if (
    isEmptyContainer(value) &&
    (cur === undefined || getAtPath(cur.value, keyPath) === undefined)
  ) {
    return {
      scope,
      path,
      action: "noop",
      summary,
      before: cur?.text,
      after: cur?.text,
      warnings,
      expected,
      composable: true,
      apply: () => Promise.resolve({ status: "unchanged", backupPath: undefined }),
    };
  }

  const planned = await planJsonPatch(fs, path, keyPath, value);
  let action: FileChangeAction = "noop";
  if (planned.before === undefined) {
    action = "create";
  } else if (planned.changed) {
    action = "patch-json";
  }

  return {
    scope,
    path,
    action,
    summary,
    before: planned.before,
    after: planned.after,
    warnings,
    expected,
    composable: true,
    apply: async (ctx: ApplyContext): Promise<ApplyResult> => {
      const result = await commitJsonPatch(ctx.fs, planned, { backup: ctx.backup });
      if (result.written) {
        return { status: "written", backupPath: result.backupPath };
      }
      return { status: "unchanged", backupPath: undefined };
    },
  };
}

/** The native object an adapter wants for one server, with its full definition. */
export interface DesiredEntry {
  readonly def: McpServerDefinition;
  /** Canonical native object from the adapter. */
  readonly entry: JsonObject;
}

export interface MergeEntriesInput {
  readonly harness: string;
  readonly path: string;
  readonly native: ReadonlyMap<string, NativeEntry>;
  readonly desired: ReadonlyMap<string, DesiredEntry>;
  readonly force: boolean;
}

/**
 * Merges desired servers into the native server map (Q1). Output order: native names that survive, in native order,
 * then new desired names sorted. Unknown in-entry keys (`extras`) are kept only when the transport is unchanged.
 */
export function mergeServerEntries(input: MergeEntriesInput): {
  readonly value: JsonObject;
  readonly warnings: readonly string[];
} {
  const { harness, path, native, desired, force } = input;
  const warnings: string[] = [];
  const out: [string, JsonValue][] = [];

  for (const [name, entry] of native) {
    const want = desired.get(name);
    if (entry.kind === "opaque") {
      const detail = `${harness}: MCP server "${name}" in ${path} has an unsupported transport (${entry.reason})`;
      if (want === undefined) {
        out.push([name, entry.raw]);
        warnings.push(`${detail}; left unchanged and not managed by yoke`);
      } else if (!force) {
        throw new NativeStateError(
          `${detail} and yoke defines it; rerun with --force to replace it`,
          path,
          name,
        );
      } else {
        out.push([name, want.entry]);
        warnings.push(`${detail}; replaced because --force was given`);
      }
      continue;
    }

    // Managed and not desired: dropped. The drift report shows it.
    if (want === undefined) {
      continue;
    }
    if (want.def.transport === entry.def.transport) {
      const merged = new Map<string, JsonValue>(Object.entries(want.entry));
      for (const [key, value] of Object.entries(entry.extras)) {
        if (!merged.has(key)) {
          merged.set(key, value);
        }
      }
      out.push([name, Object.fromEntries(merged)]);
    } else {
      out.push([name, want.entry]);
      const dropped = Object.keys(entry.extras);
      if (dropped.length > 0) {
        warnings.push(
          `${harness}: MCP server "${name}" in ${path}: dropped native keys ${dropped.join(",")} because the transport changed`,
        );
      }
    }
  }

  const nativeNames = new Set(native.keys());
  const added = [...desired]
    .filter(([name]) => !nativeNames.has(name))
    .sort(([a], [b]) => byCodeUnit(a, b));
  for (const [name, want] of added) {
    out.push([name, want.entry]);
  }

  return { value: Object.fromEntries(out), warnings };
}

/**
 * Computes the new contents of a shared native name list (Q3). `after` removes only names yoke owned that are no
 * longer desired, keeps native order, and appends missing desired names sorted. `owned` claims a desired name
 * unless the user already listed it natively without yoke having added it (A7).
 */
export function updateOwnedList(input: {
  readonly native: readonly string[];
  readonly lockOwned: readonly string[];
  readonly desired: readonly string[];
}): { readonly after: readonly string[]; readonly owned: readonly string[] } {
  const desired = [...new Set(input.desired)];
  const desiredSet = new Set(desired);
  const lockOwned = new Set(input.lockOwned);
  const native = new Set(input.native);

  const kept = input.native.filter((name) => !(lockOwned.has(name) && !desiredSet.has(name)));
  const keptSet = new Set(kept);
  const added = desired.filter((name) => !keptSet.has(name)).sort(byCodeUnit);

  const owned = desired
    .filter((name) => !(native.has(name) && !lockOwned.has(name)))
    .sort(byCodeUnit);

  return { after: [...kept, ...added], owned };
}

const ENV_REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/** True when an env value (stdio) or header value (http, sse) contains a ${VAR} reference. */
export function usesEnvReference(def: McpServerDefinition): boolean {
  const values =
    def.transport === "stdio" ? Object.values(def.env ?? {}) : Object.values(def.headers ?? {});
  return values.some((value) => ENV_REFERENCE.test(value));
}

// #endregion BA2 json plans

// #region BA3 instruction plans

export interface InstructionLinkInput {
  readonly scope: Scope;
  /** Native instructions path that yoke links to the canonical source (user scope). */
  readonly linkPath: string;
  /** Canonical AGENTS.md (absolute). */
  readonly sourcePath: string;
  readonly warnings?: readonly string[];
}

export interface InstructionRemovalInput {
  readonly scope: Scope;
  /** Native instructions path that yoke may have generated earlier. */
  readonly path: string;
  /** Canonical AGENTS.md (absolute). A symlink to it counts as yoke-created. */
  readonly sourcePath: string;
  /** True when the lock records an instructionsHash for this path. */
  readonly recordedInLock?: boolean;
  readonly warnings?: readonly string[];
}

/** True when `target`, read from a link at `linkPath`, resolves to `sourcePath`. */
function linksTo(linkPath: string, target: string, sourcePath: string): boolean {
  return resolve(dirname(linkPath), target) === sourcePath;
}

/**
 * Plans a user-scope instructions link to the canonical source. Returns undefined when the source file does not exist.
 * When symlinks are unsupported, returns a no-op plan with a warning and creates nothing.
 * Reads only; apply() performs the writes.
 */
export async function planInstructionLink(
  ctx: AdapterContext,
  input: InstructionLinkInput,
): Promise<FileChangePlan | undefined> {
  const warnings = input.warnings ?? [];
  const source = await readTextIfExists(ctx.fs, input.sourcePath);
  if (source === undefined) {
    return undefined;
  }
  if (ctx.symlinksSupported === false) {
    return advisoryPlan(
      input.scope,
      input.linkPath,
      `skip ${input.linkPath}: symlinks unsupported`,
      [...warnings, `symlinks are unsupported on this platform; skipped ${input.linkPath}`],
    );
  }

  const rel = relativeLinkTarget(input.linkPath, input.sourcePath);
  const snap = await readFileSnapshot(ctx.fs, input.linkPath);
  const unchanged = snap.kind === "symlink" && snap.target === rel;
  const before = snap.kind === "file" ? snap.content : undefined;
  const linkBefore = snap.kind === "symlink" ? snap.target : undefined;
  return {
    scope: input.scope,
    path: input.linkPath,
    action: unchanged ? "noop" : "symlink",
    summary: `symlink ${input.linkPath} -> ${rel}`,
    before,
    after: undefined,
    link: { before: linkBefore, after: rel },
    warnings,
    expected: [
      {
        kind: "instructions",
        scope: input.scope,
        instructions: { kind: "symlink", path: input.linkPath, target: rel },
      },
    ],
    apply: async (applyCtx: ApplyContext): Promise<ApplyResult> => {
      const result = await safeSymlink(applyCtx.fs, input.linkPath, input.sourcePath, {
        backup: applyCtx.backup,
      });
      if (result.kind === "fallback") {
        return { status: "fallback", backupPath: undefined, detail: result.detail };
      }
      return {
        status: result.kind === "linked" ? "written" : "unchanged",
        backupPath: result.backupPath,
      };
    },
  };
}

/**
 * Plans removal of a native instructions file or link, but only when yoke generated it: the lock records it, a file
 * starts with the GENERATED header, or a link resolves to the canonical source. Anything else is left alone with a
 * warning (a no-op plan). Reads only; apply() backs up and unlinks through commitRemove.
 */
export async function planInstructionRemoval(
  ctx: AdapterContext,
  input: InstructionRemovalInput,
): Promise<FileChangePlan> {
  const warnings = input.warnings ?? [];
  const recorded = input.recordedInLock === true;
  const planned = await planRemove(ctx.fs, input.path);
  const before = planned.before;
  const absent: ExpectedTarget = { kind: "instructions", scope: input.scope, instructions: null };

  if (before.kind === "missing") {
    return noopPlan(input, `${input.path}: nothing to remove`, warnings, recorded ? [absent] : []);
  }

  let reason: string | undefined;
  if (recorded) {
    reason = "recorded in lock";
  } else if (before.kind === "file" && hasGeneratedHeader(before.content)) {
    reason = "generated header";
  } else if (before.kind === "link" && linksTo(input.path, before.target, input.sourcePath)) {
    reason = "link to AGENTS.md";
  }
  if (reason === undefined) {
    return noopPlan(
      input,
      `leave ${input.path} alone`,
      [...warnings, `${input.path} is not yoke-generated; left in place`],
      [],
    );
  }

  return {
    scope: input.scope,
    path: input.path,
    action: "remove",
    summary: `remove ${input.path} (${reason})`,
    before: before.kind === "file" ? before.content : undefined,
    after: undefined,
    ...(before.kind === "link" ? { link: { before: before.target, after: undefined } } : {}),
    warnings,
    expected: [absent],
    apply: async (applyCtx: ApplyContext): Promise<ApplyResult> => {
      const result = await commitRemove(applyCtx.fs, planned, { backup: applyCtx.backup });
      return { status: result.removed ? "written" : "unchanged", backupPath: result.backupPath };
    },
  };
}

function noopPlan(
  input: InstructionRemovalInput,
  summary: string,
  warnings: readonly string[],
  expected: readonly ExpectedTarget[],
): FileChangePlan {
  return {
    scope: input.scope,
    path: input.path,
    action: "noop",
    summary,
    warnings,
    expected,
    apply: () => Promise.resolve({ status: "unchanged", backupPath: undefined }),
  };
}

// #endregion BA3 instruction plans
