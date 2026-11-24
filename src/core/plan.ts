/**
 * Sync planning: types, lock file I/O, plan building, drift gate, and apply.
 *
 * Planning is read-only. Only `executePlan` calls `apply()` on an adapter, and it runs
 * only after the drift gate has been checked. There is no preview flag: a preview is a
 * plan that is built and never executed. Harness-specific behavior lives in adapters,
 * which reach this module through `SyncRequest.adapters`.
 */
import { isAbsolute, join } from "node:path";
import type {
  AdapterContext,
  ApplyResult,
  FileChangePlan,
  HarnessAdapter,
} from "../adapters/base.js";
import {
  canonicalJson,
  type DesiredScopeState,
  type DriftReport,
  type ExpectedTarget,
  stateEntryFor,
} from "./drift.js";
import type { Fs, ReadFs } from "./fs-safe.js";
import { readTextIfExists, toReadFs } from "./fs-safe.js";
import type { Exec } from "./git.js";
import type { ResolvedYokeConfig, Scope, StateEntry, StateKey, YokeStateLock } from "./schema.js";
import { HarnessNameSchema, ScopeSchema, YokeStateLockSchema } from "./schema.js";
import {
  defaultScopePaths,
  type Env,
  loadScopeInputs,
  parseScopeConfig,
  resolveConfig,
} from "./scopes.js";

// #region P2 types and lock io
export const LOCK_DIR = ".yoke";
export const LOCK_FILE = "yoke.lock";

export type AdapterFactory = (ctx: AdapterContext) => HarnessAdapter;

export interface SyncRequest {
  /** Absolute repo root (git root; cwd for --global outside a repo). */
  readonly repoPath: string;
  /** Native scopes to plan; see scopesForFlags. Non-empty, unique. */
  readonly scopes: readonly Scope[];
  /** Harness filter; undefined = every harness in config.harnesses. */
  readonly harnesses?: readonly string[];
  readonly force: boolean;
  /** --global: user scope file only; requires scopes = ["user"]. */
  readonly global: boolean;
  readonly now: () => Date;
  readonly homeDir: string;
  readonly env: Env;
  readonly readFs: ReadFs;
  readonly writeFs: Fs;
  readonly exec: Exec;
  /** Harness name -> factory. Built outside src/core (src/core may not name harnesses). */
  readonly adapters: ReadonlyMap<string, AdapterFactory>;
  readonly symlinksSupported?: boolean;
}
/** What buildSyncPlan may see: no write access, no clock. */
export type PlanRequest = Omit<SyncRequest, "writeFs" | "now">;

export type LockFileKind = "repo" | "user";
export type LockLoad =
  | { readonly status: "missing"; readonly path: string }
  | { readonly status: "ok"; readonly path: string; readonly lock: YokeStateLock }
  | { readonly status: "corrupt"; readonly path: string; readonly reason: string };
export interface LockUpdate {
  readonly file: LockFileKind;
  readonly path: string;
  readonly previous: LockLoad;
  /** Full map to write, keys sorted. */
  readonly entries: YokeStateLock["harnesses"];
  readonly changed: boolean;
}

export type GateReason =
  | { readonly kind: "drift"; readonly keys: readonly StateKey[] }
  | { readonly kind: "lock-corrupt"; readonly path: string; readonly reason: string }
  | { readonly kind: "drift-unchecked"; readonly harness: string };

export interface PlannedChange {
  readonly harness: string;
  readonly plan: FileChangePlan;
}

export interface SyncPlan {
  /** Every plan, in apply order (adapter order of config.harnesses, then the adapter's order). */
  readonly plans: readonly FileChangePlan[];
  /** Same order as plans, with the harness that produced each. */
  readonly changes: readonly PlannedChange[];
  readonly drift: DriftReport;
  readonly warnings: readonly string[];
  /** gate.length > 0 && !force */
  readonly blocked: boolean;
  readonly gate: readonly GateReason[];
  readonly locks: readonly LockUpdate[];
  /** <userConfigDir>/backups */
  readonly backupRoot: string;
  readonly force: boolean;
}

export type ConfirmDrift = (plan: SyncPlan) => Promise<boolean>;
export interface ExecuteInput {
  readonly plan: SyncPlan;
  readonly fs: Fs;
  readonly now: () => Date;
  /** Present only in interactive runs. */
  readonly confirm?: ConfirmDrift;
}

export type GateOutcome =
  | { readonly kind: "clear" }
  | { readonly kind: "forced"; readonly reasons: readonly GateReason[] }
  | { readonly kind: "confirmed"; readonly reasons: readonly GateReason[] }
  | {
      readonly kind: "refused";
      readonly reasons: readonly GateReason[];
      readonly interactive: boolean;
      readonly drift: DriftReport;
    };

export interface AppliedChange {
  readonly harness: string;
  readonly path: string;
  readonly action: FileChangePlan["action"];
  readonly result: ApplyResult;
}

export interface SyncResult {
  readonly status: "applied" | "refused" | "failed";
  readonly gate: GateOutcome;
  readonly applied: readonly AppliedChange[];
  /** Set when status is "failed". */
  readonly failure?: { readonly harness: string; readonly path: string; readonly error: unknown };
  /** Lock file paths written. */
  readonly locksWritten: readonly string[];
  readonly backupDir: string | undefined;
  readonly warnings: readonly string[];
}

export interface PlanPass {
  readonly scopes: readonly Scope[];
  readonly config: ResolvedYokeConfig;
}

export class SyncRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncRequestError";
  }
}

export class PlanConflictError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PlanConflictError";
  }
}

/** Paths of the repo lock (`<repoPath>/.yoke/yoke.lock`) and the user lock (`<userConfigDir>/yoke.lock`). */
export function lockPaths(p: { readonly repoPath: string; readonly userConfigDir: string }): {
  readonly repo: string;
  readonly user: string;
} {
  if (!isAbsolute(p.repoPath) || !isAbsolute(p.userConfigDir)) {
    throw new SyncRequestError(
      `lock paths need absolute repoPath and userConfigDir; got "${p.repoPath}" and "${p.userConfigDir}"`,
    );
  }
  return {
    repo: join(p.repoPath, LOCK_DIR, LOCK_FILE),
    user: join(p.userConfigDir, LOCK_FILE),
  };
}

/** Which lock file holds a scope's entries: user -> "user", project/local -> "repo". */
export function lockFileFor(scope: Scope): LockFileKind {
  return scope === "user" ? "user" : "repo";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads and validates a lock file. Only an unreadable path (not a missing one) throws. */
export async function readLock(fs: ReadFs, path: string): Promise<LockLoad> {
  const text = await readTextIfExists(fs, path);
  if (text === undefined) return { status: "missing", path };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: unknown) {
    return { status: "corrupt", path, reason: `invalid JSON: ${errorMessage(err)}` };
  }
  const parsed = YokeStateLockSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const reason =
      issue === undefined
        ? "lock failed validation"
        : `${issue.path.map(String).join(".")}: ${issue.message}`;
    return { status: "corrupt", path, reason };
  }
  return { status: "ok", path, lock: parsed.data };
}

/** Canonical lock text: validated, harness keys sorted by code unit, two-space indent, trailing newline. */
export function serializeLock(lock: YokeStateLock): string {
  const valid = YokeStateLockSchema.parse(lock);
  const sorted = Object.entries(valid.harnesses).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const harnesses = Object.fromEntries(sorted);
  return `${JSON.stringify({ version: valid.version, lastSyncedAt: valid.lastSyncedAt, harnesses }, null, 2)}\n`;
}
// #endregion P2 types and lock io

// #region P4 request and config
/** sync -> ["project","local"]; global -> ["user"]; all -> ["user","project","local"]; both flags -> SyncRequestError. */
export function scopesForFlags(flags: {
  readonly global: boolean;
  readonly all: boolean;
}): readonly Scope[] {
  if (flags.global && flags.all) {
    throw new SyncRequestError("--global and --all cannot be used together");
  }
  if (flags.global) return ["user"];
  if (flags.all) return ["user", "project", "local"];
  return ["project", "local"];
}

/** Throws SyncRequestError for an invalid request. Pure: no I/O. */
export function validateRequest(req: PlanRequest): void {
  if (!isAbsolute(req.repoPath)) {
    throw new SyncRequestError(`repoPath must be absolute: "${req.repoPath}"`);
  }
  if (!isAbsolute(req.homeDir)) {
    throw new SyncRequestError(`homeDir must be absolute: "${req.homeDir}"`);
  }
  if (req.scopes.length === 0) {
    throw new SyncRequestError("no scopes to plan");
  }
  const seen = new Set<Scope>();
  for (const scope of req.scopes) {
    if (!ScopeSchema.safeParse(scope).success) {
      throw new SyncRequestError(`invalid scope "${String(scope)}"`);
    }
    if (seen.has(scope)) {
      throw new SyncRequestError(`duplicate scope "${scope}"`);
    }
    seen.add(scope);
  }
  if (req.global && !(req.scopes.length === 1 && req.scopes[0] === "user")) {
    throw new SyncRequestError('global requires scopes to be exactly ["user"]');
  }
  if (req.harnesses !== undefined) {
    const names = new Set<string>();
    for (const name of req.harnesses) {
      if (!HarnessNameSchema.safeParse(name).success) {
        throw new SyncRequestError(`invalid harness name "${name}"`);
      }
      if (names.has(name)) {
        throw new SyncRequestError(`duplicate harness "${name}"`);
      }
      names.add(name);
    }
  }
}

/**
 * Loads the scope files and resolves the config. Reads go through the read-only view of `fs` only.
 * global reads only `<userConfigDir>/yoke.yaml`; a repo run needs a project or local file.
 */
export async function loadPass(
  fs: ReadFs,
  req: PlanRequest,
  userConfigDir: string,
): Promise<{ readonly pass: PlanPass | undefined; readonly warnings: readonly string[] }> {
  validateRequest(req);
  if (!isAbsolute(userConfigDir)) {
    throw new SyncRequestError(`userConfigDir must be absolute: "${userConfigDir}"`);
  }
  const read = toReadFs(fs);
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };

  if (req.global) {
    const path = join(userConfigDir, "yoke.yaml");
    const text = await readTextIfExists(read, path);
    if (text === undefined) {
      return {
        pass: undefined,
        warnings: [`no user config at ${path}; nothing to sync for the user scope`],
      };
    }
    const userConfig = parseScopeConfig(text, "user", path);
    const config = resolveConfig(
      { user: { config: userConfig, baseDir: userConfigDir } },
      { projectDir: req.repoPath, warn },
    );
    return { pass: { scopes: req.scopes, config }, warnings };
  }

  const paths = defaultScopePaths({ repoRoot: req.repoPath, userConfigDir });
  const inputs = await loadScopeInputs((path) => readTextIfExists(read, path), paths);
  if (inputs.project === undefined && inputs.local === undefined) {
    throw new SyncRequestError(
      `no yoke.yaml or yoke.local.yaml in ${req.repoPath}; run "yoke init" in this repo first`,
    );
  }
  const config = resolveConfig(inputs, { projectDir: req.repoPath, warn });
  return { pass: { scopes: req.scopes, config }, warnings };
}

/**
 * Harness selection in config order. `requested` (when given) filters the list. A name without a factory is skipped with a
 * warning; a requested name missing from config.harnesses is skipped with a warning.
 */
export function selectHarnesses(
  config: ResolvedYokeConfig,
  requested: readonly string[] | undefined,
  factories: ReadonlyMap<string, AdapterFactory>,
): { readonly names: readonly string[]; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const names: string[] = [];
  const wanted = requested === undefined ? undefined : new Set(requested);
  for (const name of config.harnesses) {
    if (wanted !== undefined && !wanted.has(name)) continue;
    if (!factories.has(name)) {
      warnings.push(`harness "${name}" has no adapter in this version of yoke; skipped`);
      continue;
    }
    names.push(name);
  }
  for (const name of requested ?? []) {
    if (!config.harnesses.includes(name)) {
      warnings.push(`harness "${name}" is not listed in harnesses; skipped`);
    }
  }
  return { names, warnings };
}
// #endregion P4 request and config

// #region P5 pure helpers
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Entries of a lock file as read, as a mutable map keyed by state key. Only an ok load has entries. */
function previousEntries(previous: LockLoad): Map<string, StateEntry> {
  return new Map<string, StateEntry>(
    previous.status === "ok" ? Object.entries(previous.lock.harnesses) : [],
  );
}

/** Map to lock entries, keys sorted by code unit. */
function sortedEntries(map: ReadonlyMap<string, StateEntry>): YokeStateLock["harnesses"] {
  const sorted = [...map.entries()].sort(([a], [b]) => compareCodeUnits(a, b));
  return Object.fromEntries(sorted);
}

/** D5 `changed`: ok compares canonical JSON; corrupt always changes; missing changes only when entries exist. */
function lockChanged(previous: LockLoad, entries: YokeStateLock["harnesses"]): boolean {
  switch (previous.status) {
    case "ok":
      return canonicalJson(previous.lock.harnesses) !== canonicalJson(entries);
    case "corrupt":
      return true;
    case "missing":
      return Object.keys(entries).length > 0;
  }
}

/**
 * D6: throws PlanConflictError when a path has more than one non-noop plan, unless all of them come from one
 * harness and are all composable. Noop plans never conflict.
 */
export function checkPathConflicts(changes: readonly PlannedChange[]): void {
  const byPath = new Map<string, PlannedChange[]>();
  for (const change of changes) {
    if (change.plan.action === "noop") continue;
    const group = byPath.get(change.plan.path) ?? [];
    group.push(change);
    byPath.set(change.plan.path, group);
  }
  for (const [path, group] of byPath) {
    if (group.length < 2) continue;
    const harnesses = [...new Set(group.map((change) => change.harness))];
    const allComposable = group.every((change) => change.plan.composable === true);
    if (harnesses.length === 1 && allComposable) continue;
    throw new PlanConflictError(
      `more than one plan writes ${path} (${harnesses.join(", ")}) and they cannot be merged`,
      path,
    );
  }
}

/** D7: flatten the groups in order, dropping exact duplicates and keeping the first occurrence. */
export function collectWarnings(groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())];
}

/**
 * Merged in-memory view of the ok loads, for adapters that read ctx.lock. Undefined when no load is ok.
 * lastSyncedAt comes from the first ok load; a key present in two loads keeps the later entry.
 */
export function mergedLockView(loads: readonly LockLoad[]): YokeStateLock | undefined {
  const locks = loads.flatMap((load) => (load.status === "ok" ? [load.lock] : []));
  const first = locks[0];
  if (first === undefined) return undefined;
  const harnesses = new Map<string, StateEntry>();
  for (const lock of locks) {
    for (const [key, entry] of Object.entries(lock.harnesses)) {
      harnesses.set(key, entry);
    }
  }
  return {
    version: first.version,
    lastSyncedAt: first.lastSyncedAt,
    harnesses: Object.fromEntries(harnesses),
  };
}

/**
 * D5: starts from the previous ok entries, then for each processed key sets stateEntryFor(desired), or deletes the key
 * when it has no desired state. Keys outside `processed` are kept as they were. Keys are sorted.
 */
export function computeLockUpdate(input: {
  readonly file: LockFileKind;
  readonly path: string;
  readonly previous: LockLoad;
  readonly processed: readonly StateKey[];
  readonly desired: ReadonlyMap<StateKey, DesiredScopeState>;
}): LockUpdate {
  const map = previousEntries(input.previous);
  for (const key of input.processed) {
    const desired = input.desired.get(key);
    if (desired === undefined) {
      map.delete(key);
    } else {
      map.set(key, stateEntryFor(desired));
    }
  }
  const entries = sortedEntries(map);
  return {
    file: input.file,
    path: input.path,
    previous: input.previous,
    entries,
    changed: lockChanged(input.previous, entries),
  };
}

/**
 * D5: for each fallen instructions target, the entry's instructionsHash is restored from the previous lock entry
 * (null when there is none). Other target kinds and keys without an entry in the update are left alone.
 */
export function carryOverFallbacks(
  update: LockUpdate,
  fallen: readonly { readonly key: StateKey; readonly target: ExpectedTarget }[],
): LockUpdate {
  const map = new Map<string, StateEntry>(Object.entries(update.entries));
  for (const { key, target } of fallen) {
    if (target.kind !== "instructions") continue;
    const current = map.get(key);
    if (current === undefined) continue;
    const prior: StateEntry | undefined =
      update.previous.status === "ok" ? update.previous.lock.harnesses[key] : undefined;
    map.set(key, { ...current, instructionsHash: prior?.instructionsHash ?? null });
  }
  const entries = sortedEntries(map);
  return { ...update, entries, changed: lockChanged(update.previous, entries) };
}
// #endregion P5 pure helpers
