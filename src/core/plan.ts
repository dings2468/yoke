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
import type { DriftReport } from "./drift.js";
import type { Fs, ReadFs } from "./fs-safe.js";
import { readTextIfExists } from "./fs-safe.js";
import type { Exec } from "./git.js";
import type { ResolvedYokeConfig, Scope, StateKey, YokeStateLock } from "./schema.js";
import { YokeStateLockSchema } from "./schema.js";
import type { Env } from "./scopes.js";

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
