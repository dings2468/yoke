/**
 * src/commands/sync.ts — `yoke sync` (SPEC.md §5 and §7). One planning path: buildSyncPlan runs once, the plan is rendered,
 * and a real run hands the same plan to executePlan. A dry run stops after rendering. This module never writes files itself.
 *
 * Adapters are reached only through the injected factories. The drift prompt comes in through SyncDeps; the terminal
 * wrapper lives in sync-prompt.ts.
 */
import type { AdapterContext, HarnessAdapter } from "../adapters/base.js";
import { toReadFs } from "../core/fs-safe.js";
import { gitRepoRoot } from "../core/git.js";
import {
  type AdapterFactory,
  buildSyncPlan,
  type ConfirmDrift,
  executePlan,
  type PlanRequest,
  SyncRequestError,
  scopesForFlags,
} from "../core/plan.js";
import type { Scope } from "../core/schema.js";
import { userConfigDir } from "../core/scopes.js";
import type { CliDeps } from "../main.js";
import { shouldUseColor } from "./doctor-format.js";
import {
  EXIT_DRIFT,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_PROBLEMS,
  EXIT_USAGE,
  type ExitCode,
  UsageError,
} from "./exit.js";
import { createDriftConfirm, type DriftPromptApi, SyncCancelledError } from "./sync-prompt.js";
import {
  displayPath,
  type RenderOptions,
  renderGate,
  renderPlan,
  renderRefusal,
  renderResult,
} from "./sync-render.js";

export interface SyncCommandOptions {
  readonly dryRun: boolean;
  readonly global: boolean;
  readonly all: boolean;
  readonly force: boolean;
}

export interface SyncDeps extends Omit<CliDeps, "planner"> {
  readonly prompts: DriftPromptApi;
}

const COMMAND = "yoke sync";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Maps each harness name to its factory. Building an adapter does no I/O. A duplicate name throws. */
export function adapterMap(
  factories: readonly AdapterFactory[],
  ctx: AdapterContext,
): ReadonlyMap<string, AdapterFactory> {
  const map = new Map<string, AdapterFactory>();
  for (const factory of factories) {
    const adapter: HarnessAdapter = factory(ctx);
    if (map.has(adapter.name)) {
      throw new Error(`duplicate adapter name "${adapter.name}"`);
    }
    map.set(adapter.name, factory);
  }
  return map;
}

/** Writes text to a sink, adding the final newline when the text is not empty. */
function writeBlock(write: (s: string) => void, text: string): void {
  if (text.length > 0) {
    write(`${text}\n`);
  }
}

/**
 * Runs `yoke sync`. Returns 0 for applied, nothing-to-do, a clean dry run, or a forced run; 1 for an error or a failed
 * write; 2 for a usage error; 3 for drift refusal or a blocked dry run; 130 when the drift prompt is cancelled. Errors and
 * refusals are printed here.
 */
export async function runSync(opts: SyncCommandOptions, deps: SyncDeps): Promise<ExitCode> {
  try {
    return await syncFlow(opts, deps);
  } catch (err: unknown) {
    if (err instanceof SyncCancelledError) {
      deps.io.stderr("cancelled; nothing was written\n");
      return EXIT_INTERRUPTED;
    }
    if (err instanceof UsageError) {
      deps.io.stderr(`${err.message}\n`);
      return EXIT_USAGE;
    }
    deps.io.stderr(`${COMMAND}: ${errorMessage(err)}\n`);
    return EXIT_PROBLEMS;
  }
}

async function syncFlow(opts: SyncCommandOptions, deps: SyncDeps): Promise<ExitCode> {
  let scopes: readonly Scope[];
  try {
    scopes = scopesForFlags({ global: opts.global, all: opts.all });
  } catch (err: unknown) {
    if (err instanceof SyncRequestError) {
      throw new UsageError(err.message);
    }
    throw err;
  }

  const gitRoot = await gitRepoRoot({ exec: deps.exec, cwd: deps.cwd });
  const repoPath = gitRoot ?? (opts.global ? deps.cwd : undefined);
  if (repoPath === undefined) {
    throw new Error("not inside a git repository");
  }

  const ucd = userConfigDir(deps.env, deps.homeDir);
  const readFs = toReadFs(deps.fs);
  const adapters = adapterMap(deps.factories, {
    homeDir: deps.homeDir,
    userConfigDir: ucd,
    fs: readFs,
    exec: deps.exec,
    env: deps.env,
  });

  const request: PlanRequest = {
    repoPath,
    scopes,
    force: opts.force,
    global: opts.global,
    homeDir: deps.homeDir,
    env: deps.env,
    readFs,
    exec: deps.exec,
    adapters,
  };
  const plan = await buildSyncPlan(request);

  const render: RenderOptions = {
    color: shouldUseColor({ isTTY: deps.io.stdoutIsTTY, env: deps.env }),
    repoPath,
    homeDir: deps.homeDir,
    dryRun: opts.dryRun,
    command: COMMAND,
  };
  writeBlock(deps.io.stdout, renderPlan(plan.changes, plan.warnings, render));

  if (plan.force && plan.gate.length > 0) {
    deps.io.stdout("warning: --force: proceeding past:\n");
    writeBlock(deps.io.stdout, renderGate(plan.gate, plan.drift, render));
  }

  if (opts.dryRun) {
    if (plan.blocked) {
      writeBlock(deps.io.stdout, renderGate(plan.gate, plan.drift, render));
      return EXIT_DRIFT;
    }
    return EXIT_OK;
  }

  const interactive = deps.io.stdinIsTTY === true;
  if (plan.blocked && interactive) {
    writeBlock(deps.io.stdout, renderGate(plan.gate, plan.drift, render));
  }
  const confirm: ConfirmDrift | undefined = interactive
    ? createDriftConfirm(deps.prompts)
    : undefined;

  const result = await executePlan({ plan, fs: deps.fs, now: deps.now, confirm });

  if (result.status === "refused") {
    const gate = result.gate;
    const interactiveAbort = gate.kind === "refused" && gate.interactive;
    const reasons = gate.kind === "refused" ? gate.reasons : plan.gate;
    const drift = gate.kind === "refused" ? gate.drift : plan.drift;
    writeBlock(
      deps.io.stderr,
      renderRefusal(reasons, drift, { ...render, interactive: interactiveAbort }),
    );
    return EXIT_DRIFT;
  }

  writeBlock(deps.io.stdout, renderResult(result, plan.warnings, render));

  if (result.status === "failed") {
    const failure = result.failure;
    const message = failure === undefined ? "write failed" : errorMessage(failure.error);
    deps.io.stderr(`${COMMAND}: ${message}\n`);
    if (failure !== undefined) {
      deps.io.stderr(`path: ${displayPath(failure.path, render)}\n`);
    }
    deps.io.stderr("no lock was updated\n");
    if (result.backupDir !== undefined) {
      deps.io.stderr(`backups: ${result.backupDir}\n`);
    }
    return EXIT_PROBLEMS;
  }

  return EXIT_OK;
}
