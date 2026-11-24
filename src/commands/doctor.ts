/**
 * src/commands/doctor.ts: read-only doctor checks (SPEC §9).
 *
 * Doctor receives a ReadFs and never builds an apply context, so it cannot write. Adapters come from injected
 * factories and are used only through their methods and capabilities. Planning is injected as `planner`.
 */
import type { FileChangePlan, HarnessAdapter } from "../adapters/base.js";
import type { AdapterFactory } from "../adapters/registry.js";
import {
  DRIFT_STATUSES,
  type DriftReport,
  type EntryStatus,
  type ScopeDriftReport,
} from "../core/drift.js";
import { isNotFound, type ReadFs, readTextIfExists, toReadFs } from "../core/fs-safe.js";
import { type Env, type Exec, gitRepoRoot } from "../core/git.js";
import { lockPaths, readLock } from "../core/plan.js";
import { createTimedExec, DEFAULT_PROBE_TIMEOUT_MS, probe, type TimedExec } from "../core/probe.js";
import type {
  PartialYokeConfig,
  ResolvedYokeConfig,
  Scope,
  SyncOptions,
  YokeStateLock,
} from "../core/schema.js";
import {
  defaultScopePaths,
  loadScopeInputs,
  resolveConfig,
  ScopeConfigError,
  type ScopeInputs,
} from "../core/scopes.js";
import type { DoctorCheck, DoctorReport } from "./doctor-format.js";

export interface DoctorPlanResult {
  readonly plans: readonly FileChangePlan[];
  readonly drift: DriftReport | undefined;
}

export type DoctorPlanner = (input: {
  readonly adapter: HarnessAdapter;
  readonly config: ResolvedYokeConfig;
  readonly opts: SyncOptions;
  readonly lock: YokeStateLock | undefined;
}) => Promise<DoctorPlanResult>;

export interface DoctorDeps {
  readonly cwd: string;
  readonly homeDir: string;
  readonly userConfigDir: string;
  readonly env: Env;
  readonly fs: ReadFs;
  readonly exec: Exec;
  readonly factories: readonly AdapterFactory[];
  readonly planner: DoctorPlanner;
  readonly timeoutMs?: number;
}

const DRIFT_HINT =
  "run `yoke sync` to overwrite (originals are backed up), or copy the change into yoke.yaml";
const SCOPE_ORDER: readonly Scope[] = ["user", "project", "local"];

/**
 * Scopes doctor compares for one harness (DD6). `user` is included only when the lock has a `<harness>:user`
 * entry, so a user who never synced globally does not see every native user server as drift.
 */
export function doctorScopes(lock: YokeStateLock | undefined, harness: string): readonly Scope[] {
  const hasUser = lock !== undefined && Object.hasOwn(lock.harnesses, `${harness}:user`);
  return hasUser ? ["user", "project", "local"] : ["project", "local"];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs every read-only check and returns the report. Never writes and never prompts. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const repoRoot = await checkRepo(deps, timeoutMs, checks);
  let config: ResolvedYokeConfig | undefined;
  let lock: YokeStateLock | undefined;
  if (repoRoot !== undefined) {
    config = await checkConfig(deps, repoRoot, checks);
    lock = await checkLock(deps, repoRoot, checks);
  }

  const built: { readonly adapter: HarnessAdapter; readonly timed: TimedExec }[] = [];
  for (const [index, factory] of deps.factories.entries()) {
    const timed = createTimedExec(deps.exec, timeoutMs);
    try {
      const adapter = factory({
        homeDir: deps.homeDir,
        userConfigDir: deps.userConfigDir,
        fs: toReadFs(deps.fs),
        exec: timed.exec,
        env: deps.env,
        lock,
        force: false,
      });
      built.push({ adapter, timed });
    } catch (err: unknown) {
      checks.push({
        kind: "binary",
        subject: `adapter ${index + 1}`,
        status: "problem",
        message: `could not be constructed: ${errorMessage(err)}`,
      });
    }
  }

  const listed = config?.harnesses ?? [];
  for (const { adapter, timed } of built) {
    await checkBinaryAndAuth(adapter, timed, listed.includes(adapter.name), timeoutMs, checks);
  }

  const names = new Set(built.map(({ adapter }) => adapter.name));
  for (const name of listed) {
    if (!names.has(name)) {
      checks.push({
        kind: "config",
        subject: name,
        status: "problem",
        message: "listed in harnesses but no adapter is registered for it",
      });
    }
  }

  if (config !== undefined && repoRoot !== undefined) {
    for (const { adapter } of built) {
      if (!listed.includes(adapter.name)) continue;
      await checkAdapterSync(deps, adapter, config, lock, repoRoot, checks);
    }
  }

  return { checks };
}

async function checkRepo(
  deps: DoctorDeps,
  timeoutMs: number,
  checks: DoctorCheck[],
): Promise<string | undefined> {
  const timed = createTimedExec(deps.exec, timeoutMs);
  try {
    const root = await gitRepoRoot({ cwd: deps.cwd, exec: timed.exec });
    if (root === undefined) {
      checks.push({
        kind: "repo",
        subject: "cwd",
        status: "info",
        message: "not inside a git repository; project checks skipped",
      });
      return undefined;
    }
    checks.push({ kind: "repo", subject: "git root", status: "ok", message: root });
    return root;
  } catch (err: unknown) {
    checks.push({
      kind: "repo",
      subject: "cwd",
      status: timed.timedOut() ? "unknown" : "problem",
      message: timed.timedOut()
        ? `no answer within ${timeoutMs} ms`
        : `git could not report the repository root: ${errorMessage(err)}`,
    });
    return undefined;
  }
}

async function checkConfig(
  deps: DoctorDeps,
  repoRoot: string,
  checks: DoctorCheck[],
): Promise<ResolvedYokeConfig | undefined> {
  const read = (path: string): Promise<string | undefined> => readTextIfExists(deps.fs, path);
  let inputs: ScopeInputs;
  try {
    inputs = await loadScopeInputs(
      read,
      defaultScopePaths({ repoRoot, userConfigDir: deps.userConfigDir }),
    );
  } catch (err: unknown) {
    checks.push({
      kind: "config",
      subject: err instanceof ScopeConfigError ? err.path : "scope files",
      status: "problem",
      message: errorMessage(err),
    });
    return undefined;
  }
  if (inputs.project === undefined) {
    checks.push({
      kind: "config",
      subject: "yoke.yaml",
      status: "info",
      message: "not found in the repository; drift checks skipped",
      hint: "run `yoke init` to create yoke.yaml",
    });
    return undefined;
  }
  const warnings: string[] = [];
  try {
    const config = resolveConfig(inputs, {
      projectDir: repoRoot,
      warn: (message) => warnings.push(message),
    });
    checks.push({
      kind: "config",
      subject: "scope files",
      status: "ok",
      message: `loaded ${Object.keys(inputs).join(", ")}`,
    });
    for (const message of new Set(warnings)) {
      checks.push({ kind: "config", subject: "merge", status: "warn", message });
    }
    return config;
  } catch (err: unknown) {
    checks.push({
      kind: "config",
      subject: "scope files",
      status: "problem",
      message: errorMessage(err),
    });
    return undefined;
  }
}

async function checkLock(
  deps: DoctorDeps,
  repoRoot: string,
  checks: DoctorCheck[],
): Promise<YokeStateLock | undefined> {
  const paths = lockPaths({ repoPath: repoRoot, userConfigDir: deps.userConfigDir });
  const repo = await loadLock(deps.fs, paths.repo, "repo", checks);
  const user = await loadLock(deps.fs, paths.user, "user", checks);
  const primary = repo ?? user;
  if (primary === undefined) return undefined;
  return {
    version: 1,
    lastSyncedAt: primary.lastSyncedAt,
    harnesses: { ...user?.harnesses, ...repo?.harnesses },
  };
}

async function loadLock(
  fs: ReadFs,
  path: string,
  subject: "repo" | "user",
  checks: DoctorCheck[],
): Promise<YokeStateLock | undefined> {
  try {
    const load = await readLock(fs, path);
    if (load.status === "ok") {
      checks.push({
        kind: "lock",
        subject,
        status: "ok",
        message: `${Object.keys(load.lock.harnesses).length} entries`,
      });
      return load.lock;
    }
    if (load.status === "corrupt") {
      checks.push({
        kind: "lock",
        subject,
        status: "problem",
        message: `${load.path}: ${load.reason}`,
      });
      return undefined;
    }
  } catch (err: unknown) {
    checks.push({ kind: "lock", subject, status: "problem", message: errorMessage(err) });
    return undefined;
  }
  if (subject === "repo") {
    checks.push({
      kind: "lock",
      subject,
      status: "info",
      message: "no .yoke/yoke.lock; not synced yet",
    });
  }
  return undefined;
}

async function checkBinaryAndAuth(
  adapter: HarnessAdapter,
  timed: TimedExec,
  listed: boolean,
  timeoutMs: number,
  checks: DoctorCheck[],
): Promise<void> {
  const name = adapter.name;
  const outcome = await probe(() => adapter.detect(), timeoutMs, `${name} detect`);
  if (timed.timedOut() || outcome.kind === "timeout") {
    checks.push({
      kind: "binary",
      subject: name,
      status: "unknown",
      message: `no answer within ${timeoutMs} ms`,
    });
    checks.push({
      kind: "auth",
      subject: name,
      status: "unknown",
      message: "not verified: the binary probe gave no answer",
    });
    return;
  }
  if (outcome.kind === "error") {
    checks.push({ kind: "binary", subject: name, status: "unknown", message: outcome.message });
    checks.push({
      kind: "auth",
      subject: name,
      status: "unknown",
      message: "not verified: the binary probe failed",
    });
    return;
  }

  const status = outcome.value;
  if (status.installed) {
    const version = status.version === undefined ? "" : ` (version ${status.version})`;
    checks.push({ kind: "binary", subject: name, status: "ok", message: `installed${version}` });
  } else if (listed) {
    checks.push({
      kind: "binary",
      subject: name,
      status: "problem",
      message: "not installed",
      hint: `install ${name} or remove it from harnesses in yoke.yaml`,
    });
  } else {
    checks.push({
      kind: "binary",
      subject: name,
      status: "info",
      message: "not installed; not listed in harnesses",
    });
  }

  if (status.authenticated) {
    checks.push({
      kind: "auth",
      subject: name,
      status: "ok",
      message: "credentials found (heuristic)",
    });
  } else {
    checks.push({
      kind: "auth",
      subject: name,
      status: "unknown",
      message: "not verified: yoke runs no login probe in v0.1",
    });
  }
}

async function checkAdapterSync(
  deps: DoctorDeps,
  adapter: HarnessAdapter,
  config: ResolvedYokeConfig,
  lock: YokeStateLock | undefined,
  repoRoot: string,
  checks: DoctorCheck[],
): Promise<void> {
  const name = adapter.name;
  if (adapter.capabilities.reverseRead) {
    await checkSymlinks(adapter, deps.fs, repoRoot, checks);
  } else {
    checks.push({
      kind: "symlink",
      subject: name,
      status: "unknown",
      message: "not checked: adapter cannot read native state",
    });
  }

  const extraWarnings: string[] = [];
  const opts: SyncOptions = {
    repoPath: repoRoot,
    scopes: doctorScopes(lock, name),
    warn: (message) => {
      extraWarnings.push(message);
    },
  };
  let result: DoctorPlanResult;
  try {
    result = await deps.planner({ adapter, config, opts, lock });
  } catch (err: unknown) {
    checks.push({ kind: "drift", subject: name, status: "problem", message: errorMessage(err) });
    return;
  }

  if (result.drift === undefined) {
    checks.push({
      kind: "drift",
      subject: name,
      status: "unknown",
      message: "not checked: adapter cannot read native state",
    });
  } else {
    checks.push(...driftChecks(result.drift));
  }

  const warnings = new Set([...extraWarnings, ...result.plans.flatMap((plan) => plan.warnings)]);
  for (const message of warnings) {
    checks.push({ kind: "plan", subject: name, status: "warn", message });
  }
}

async function checkSymlinks(
  adapter: HarnessAdapter,
  fs: ReadFs,
  repoRoot: string,
  checks: DoctorCheck[],
): Promise<void> {
  const name = adapter.name;
  let native: PartialYokeConfig;
  try {
    native = await adapter.readNativeState(repoRoot);
  } catch (err: unknown) {
    checks.push({ kind: "symlink", subject: name, status: "problem", message: errorMessage(err) });
    return;
  }
  for (const scope of SCOPE_ORDER) {
    const instructions = native[scope]?.instructions;
    if (instructions === undefined || instructions.kind !== "symlink") continue;
    const subject = `${name}:${scope}`;
    const { path, target } = instructions;
    try {
      await fs.stat(path);
      checks.push({
        kind: "symlink",
        subject,
        status: "ok",
        message: `${path} -> ${target} resolves`,
      });
    } catch (err: unknown) {
      if (isNotFound(err)) {
        checks.push({
          kind: "symlink",
          subject,
          status: "problem",
          message: `broken symlink ${path} -> ${target}`,
        });
      } else {
        checks.push({
          kind: "symlink",
          subject,
          status: "unknown",
          message: `could not stat ${path}: ${errorMessage(err)}`,
        });
      }
    }
  }
}

/** One line per drift entry, or one `ok` line per state key when nothing needs attention (DD5). */
function driftChecks(drift: DriftReport): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  for (const scope of drift.scopes) {
    const lines = scopeDriftChecks(scope);
    if (lines.length === 0) {
      out.push({ kind: "drift", subject: scope.key, status: "ok", message: "no drift" });
    } else {
      out.push(...lines);
    }
  }
  return out;
}

function scopeDriftChecks(scope: ScopeDriftReport): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  for (const entry of scope.mcps) {
    const check = driftCheck(scope.key, entry.status, `MCP server "${entry.name}"`);
    if (check !== undefined) out.push(check);
  }
  if (scope.instructions !== undefined) {
    const { status, path } = scope.instructions;
    const check = driftCheck(scope.key, status, `instructions ${path}`);
    if (check !== undefined) out.push(check);
  }
  return out;
}

function driftCheck(subject: string, status: EntryStatus, noun: string): DoctorCheck | undefined {
  if (DRIFT_STATUSES.includes(status)) {
    return {
      kind: "drift",
      subject,
      status: "problem",
      message: `${status} ${noun}`,
      hint: DRIFT_HINT,
    };
  }
  if (status === "create") {
    return { kind: "drift", subject, status: "info", message: `not yet synced: ${noun}` };
  }
  return undefined;
}
