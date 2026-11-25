/**
 * src/commands/init.ts — `yoke init`: choose what to import from native harness files, then write yoke.yaml,
 * yoke.local.yaml, AGENTS.md, and .gitignore lines through the plan pipeline (executePlan). It also writes the
 * user-scope yoke.yaml (merged, never clobbered, backed up first). Init never syncs and never writes .yoke/yoke.lock
 * or .yoke/state.json.
 *
 * Adapters are reached only through the injected factories and their capabilities. Prompts come in through
 * InitDeps; the real terminal wrapper (createClackPrompts) is the only place @clack/prompts is used.
 */
import { join } from "node:path";
import * as clack from "@clack/prompts";
import type { FileChangePlan, HarnessAdapter } from "../adapters/base.js";
import { atomicWrite, type Fs, type ReadFs, readTextIfExists, toReadFs } from "../core/fs-safe.js";
import { gitRepoRoot } from "../core/git.js";
import { hasGeneratedHeader } from "../core/instructions.js";
import { executePlan, type SyncPlan } from "../core/plan.js";
import { createTimedExec, DEFAULT_PROBE_TIMEOUT_MS, probe } from "../core/probe.js";
import type { Mode, YokeConfig } from "../core/schema.js";
import { resolveConfig, userConfigDir } from "../core/scopes.js";
import type { CliDeps } from "../main.js";
import { shouldUseColor } from "./doctor-format.js";
import { EXIT_INTERRUPTED, EXIT_OK, EXIT_PROBLEMS, EXIT_USAGE, UsageError } from "./exit.js";
import {
  buildInitDraft,
  draftToIntents,
  gitignoreLines,
  type SecretPolicy,
} from "./init-convert.js";
import {
  type PickerOption,
  type PromptApi,
  promptImportSelection,
  selectFromTokens,
} from "./init-select.js";
import { listImportSources, parseSourceToken, readFileSource } from "./init-sources.js";
import {
  type ImportSelection,
  type ImportSources,
  InitError,
  type InstructionCandidate,
  type ProjectWriteIntent,
  type UserTextIntent,
} from "./init-types.js";
import { mergeUserConfig } from "./init-user.js";
import { type RenderOptions, renderPlan } from "./sync-render.js";

export interface InitOptions {
  readonly importFrom: readonly string[] | undefined;
  readonly secrets: SecretPolicy;
  readonly gitignore: boolean;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export interface InitPrompts extends PromptApi {
  confirm(o: { message: string }): Promise<boolean | symbol>;
}

export interface InitDeps extends Omit<CliDeps, "planner"> {
  readonly prompts: InitPrompts;
  readonly timeoutMs?: number;
}

/** Label for the changes this command plans. It names the plans only; it is not a harness. */
const INIT_LABEL = "init";

/** The user declined or cancelled a prompt. Nothing has been written when this is thrown. */
class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

type TextIntent = Extract<ProjectWriteIntent, { kind: "text" }>;
type LinesIntent = Extract<ProjectWriteIntent, { kind: "ensure-lines" }>;

type WriteIntent = ProjectWriteIntent | UserTextIntent;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function relativeTo(repoPath: string, path: string): string {
  return path.startsWith(`${repoPath}/`) ? path.slice(repoPath.length + 1) : path;
}

/** Resolves the git top-level directory. Outside a repository is an InitError (exit 1). */
async function findRepoRoot(deps: InitDeps): Promise<string> {
  const root = await gitRepoRoot({ exec: deps.exec, cwd: deps.cwd });
  if (root === undefined) {
    throw new InitError("not inside a git repository; run yoke init from a repository");
  }
  return root;
}

/** True when a .gitignore already ignores the file (exact line, with or without a leading slash). */
function isIgnored(gitignoreText: string | undefined, name: string): boolean {
  if (gitignoreText === undefined) {
    return false;
  }
  return gitignoreText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === name || line === `/${name}`);
}

/** Probes each adapter for its binary. A timed-out or failed probe counts as not installed. */
async function installedHarnesses(
  adapters: readonly HarnessAdapter[],
  timeoutMs: number,
): Promise<string[]> {
  const names: string[] = [];
  for (const adapter of adapters) {
    const outcome = await probe(() => adapter.detect(), timeoutMs, adapter.name);
    if (outcome.kind === "ok" && outcome.value.installed) {
      names.push(adapter.name);
    }
  }
  return names;
}

/** Chooses the import selection from --import-from tokens, or from the interactive picker (DI3, DI5). */
async function chooseSelection(
  opts: InitOptions,
  deps: InitDeps,
  sources: ImportSources,
  interactive: boolean,
): Promise<ImportSelection> {
  if (opts.importFrom !== undefined) {
    const tokens = opts.importFrom.map((raw) => parseSourceToken(raw, deps.cwd));
    const files = new Map<string, InstructionCandidate>(
      sources.files.map((candidate) => [candidate.path, candidate]),
    );
    for (const token of tokens) {
      if (token.kind === "file" && !files.has(token.path)) {
        const candidate = await readFileSource(deps.fs, token.path);
        if (hasGeneratedHeader(candidate.content)) {
          throw new InitError(`${token.path} is generated by yoke; name a harness instead`);
        }
        files.set(token.path, candidate);
      }
    }
    return selectFromTokens(sources, tokens, files);
  }
  if (!interactive) {
    throw new UsageError("not a terminal; pass --import-from");
  }
  const picked = await promptImportSelection(sources, deps.prompts);
  if (picked === "cancelled") {
    throw new CancelledError();
  }
  return picked;
}

/**
 * Paths the adapters would generate for the drafted config, used only for .gitignore lines. syncStatic plans
 * are read for their paths and never applied. Failures become notes; they do not stop init.
 */
async function generatedPaths(input: {
  readonly adapters: readonly HarnessAdapter[];
  readonly project: YokeConfig;
  readonly local: YokeConfig | undefined;
  readonly repoPath: string;
  readonly notes: string[];
}): Promise<{ readonly mode: Mode; readonly paths: readonly string[] }> {
  const warnings: string[] = [];
  const config = resolveConfig(
    {
      project: { config: input.project, baseDir: input.repoPath },
      ...(input.local === undefined
        ? {}
        : { local: { config: input.local, baseDir: input.repoPath } }),
    },
    { projectDir: input.repoPath, warn: (message) => warnings.push(message) },
  );
  input.notes.push(...warnings);
  const paths: string[] = [];
  for (const adapter of input.adapters) {
    if (!config.harnesses.includes(adapter.name)) {
      continue;
    }
    try {
      const plans = await adapter.syncStatic(config, {
        repoPath: input.repoPath,
        scopes: ["project"],
        warn: (message) => input.notes.push(message),
      });
      paths.push(...plans.map((plan) => plan.path));
    } catch (err: unknown) {
      input.notes.push(`could not plan generated paths for ${adapter.name}: ${errorMessage(err)}`);
    }
  }
  return { mode: config.mode, paths };
}

/** Read-only planning for one text write (DI9). Identical content is a noop; a difference follows ifExists. */
async function planText(
  fs: ReadFs,
  repoPath: string,
  intent: TextIntent | UserTextIntent,
): Promise<FileChangePlan> {
  const before = await readTextIfExists(fs, intent.path);
  const rel = relativeTo(repoPath, intent.path);
  if (before === intent.content) {
    return noopPlan(intent.scope, intent.path, `unchanged ${rel}`);
  }
  if (before !== undefined && intent.ifExists === "keep") {
    return noopPlan(intent.scope, intent.path, `kept existing ${rel}`);
  }
  if (before !== undefined && intent.ifExists === "fail") {
    throw new InitError(`${rel} already exists; pass --force to back it up and overwrite`);
  }
  const existed = before !== undefined;
  // Only a created file takes the intent's mode; an existing file keeps its own permissions.
  const createOptions = !existed && intent.scope === "user" ? { mode: intent.mode } : undefined;
  return {
    scope: intent.scope,
    path: intent.path,
    action: existed ? "update" : "create",
    summary: `${existed ? "update" : "create"} ${rel}`,
    before,
    after: intent.content,
    warnings: [],
    expected: [],
    apply: async (ctx) => {
      const backupPath = existed ? await ctx.backup.backup(intent.path) : undefined;
      await atomicWrite(ctx.fs, intent.path, intent.content, createOptions);
      return { status: "written", backupPath };
    },
  };
}

/** Read-only planning for ensure-lines (DI9): appends only the lines that are not already present. */
async function planLines(
  fs: ReadFs,
  repoPath: string,
  intent: LinesIntent,
): Promise<FileChangePlan> {
  const before = await readTextIfExists(fs, intent.path);
  const rel = relativeTo(repoPath, intent.path);
  const current = before ?? "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trimEnd()));
  const missing = [...new Set(intent.lines)].filter((line) => !present.has(line.trimEnd()));
  if (missing.length === 0) {
    return noopPlan(intent.scope, intent.path, `unchanged ${rel}`);
  }
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  const after = `${current}${separator}${missing.join("\n")}\n`;
  const existed = before !== undefined;
  const count = `${missing.length} line${missing.length === 1 ? "" : "s"}`;
  return {
    scope: intent.scope,
    path: intent.path,
    action: existed ? "update" : "create",
    summary: `${existed ? "update" : "create"} ${rel} (${count})`,
    before,
    after,
    warnings: [],
    expected: [],
    apply: async (ctx) => {
      const backupPath = existed ? await ctx.backup.backup(intent.path) : undefined;
      await atomicWrite(ctx.fs, intent.path, after);
      return { status: "written", backupPath };
    },
  };
}

function noopPlan(scope: FileChangePlan["scope"], path: string, summary: string): FileChangePlan {
  return {
    scope,
    path,
    action: "noop",
    summary,
    warnings: [],
    expected: [],
    apply: async () => ({ status: "unchanged", backupPath: undefined }),
  };
}

/** Plans every intent without writing. An existing file without --force throws InitError before any write. */
async function planWrites(
  fs: ReadFs,
  repoPath: string,
  intents: readonly WriteIntent[],
): Promise<FileChangePlan[]> {
  const plans: FileChangePlan[] = [];
  for (const intent of intents) {
    plans.push(
      intent.kind === "text"
        ? await planText(fs, repoPath, intent)
        : await planLines(fs, repoPath, intent),
    );
  }
  return plans;
}

/** Real terminal prompts. The only place @clack/prompts is used. */
export function createClackPrompts(): InitPrompts {
  const toOption = (option: PickerOption): clack.Option<string> => ({
    value: option.value,
    label: option.label,
    ...(option.hint === undefined ? {} : { hint: option.hint }),
    ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
  });
  return {
    multiselect: (o) =>
      clack.multiselect<string>({
        message: o.message,
        options: o.options.map(toOption),
        initialValues: o.initialValues,
        required: o.required,
      }),
    select: (o) => clack.select<string>({ message: o.message, options: o.options.map(toOption) }),
    confirm: (o) => clack.confirm({ message: o.message }),
    isCancel: (value: unknown): value is symbol => clack.isCancel(value),
  };
}

/**
 * Runs `yoke init`. Returns 0 on success, 1 for an InitError or a failed write, 2 for a usage error, and 130 when
 * the user cancels before anything is written. Usage and init errors are printed here.
 */
export async function runInit(opts: InitOptions, deps: InitDeps): Promise<number> {
  try {
    return await initFlow(opts, deps);
  } catch (err: unknown) {
    if (err instanceof CancelledError) {
      deps.io.stderr("cancelled; nothing was written\n");
      return EXIT_INTERRUPTED;
    }
    if (err instanceof UsageError) {
      deps.io.stderr(`${err.message}\n`);
      return EXIT_USAGE;
    }
    if (err instanceof InitError) {
      deps.io.stderr(`${err.message}\n`);
      return EXIT_PROBLEMS;
    }
    throw err;
  }
}

async function initFlow(opts: InitOptions, deps: InitDeps): Promise<number> {
  const repoPath = await findRepoRoot(deps);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const userDir = userConfigDir(deps.env, deps.homeDir);
  const fs: Fs = deps.fs;
  const interactive = deps.io.stdinIsTTY === true;

  const adapters = deps.factories.map((factory) =>
    factory({
      homeDir: deps.homeDir,
      userConfigDir: userDir,
      fs: toReadFs(fs),
      exec: createTimedExec(deps.exec, timeoutMs).exec,
      env: deps.env,
      force: opts.force,
    }),
  );

  const installed = await installedHarnesses(adapters, timeoutMs);
  const sources = await listImportSources({
    adapters,
    repoPath,
    fs,
    canonicalPath: join(repoPath, "AGENTS.md"),
  });
  const selection = await chooseSelection(opts, deps, sources, interactive);

  const gitignoreText = await readTextIfExists(fs, join(repoPath, ".gitignore"));
  const draft = buildInitDraft({ selection, installed, secrets: opts.secrets });
  if (
    opts.secrets === "local" &&
    draft.local !== undefined &&
    !opts.gitignore &&
    !isIgnored(gitignoreText, "yoke.local.yaml")
  ) {
    throw new UsageError(
      "--secrets local with --no-gitignore needs yoke.local.yaml ignored by .gitignore; add it there or pass --secrets ref",
    );
  }

  const notes: string[] = [...draft.notes];
  const generated = await generatedPaths({
    adapters,
    project: draft.project,
    local: draft.local,
    repoPath,
    notes,
  });
  const ignoreLines = opts.gitignore
    ? gitignoreLines({ mode: generated.mode, repoPath, generatedPaths: generated.paths })
    : undefined;

  let intents: readonly WriteIntent[] = draftToIntents(draft, {
    repoPath,
    force: opts.force,
    gitignore: ignoreLines,
  });

  // User-scope file (U4, U5). mergeUserConfig validates an existing file first, so an invalid one fails before any write.
  const userPath = join(userDir, "yoke.yaml");
  let userAdded = false;
  if (draft.user !== undefined) {
    const existingUser = await readTextIfExists(fs, userPath);
    const merge = mergeUserConfig(
      existingUser === undefined ? undefined : { text: existingUser, path: userPath },
      draft.user,
      userPath,
    );
    notes.push(...merge.notes, ...merge.conflicts);
    userAdded = merge.added.length > 0;
    if (merge.content !== undefined) {
      intents = [
        ...intents,
        {
          kind: "text",
          scope: "user",
          path: userPath,
          content: merge.content,
          ifExists: "overwrite-with-backup",
          mode: 0o600,
        },
      ];
    }
  }

  const agentsPath = join(repoPath, "AGENTS.md");
  if (draft.agents !== undefined && !opts.force) {
    const existing = await readTextIfExists(fs, agentsPath);
    if (existing !== undefined && existing !== draft.agents.content) {
      if (!interactive) {
        throw new InitError(
          "AGENTS.md exists and differs from the chosen instructions; pass --force to back it up and overwrite",
        );
      }
      const confirmed = await deps.prompts.confirm({
        message: "Overwrite AGENTS.md with the chosen instructions? The original is backed up.",
      });
      if (deps.prompts.isCancel(confirmed) || confirmed !== true) {
        throw new CancelledError();
      }
      intents = intents.map(
        (intent): WriteIntent =>
          intent.kind === "text" && intent.path === agentsPath
            ? { ...intent, ifExists: "overwrite-with-backup" }
            : intent,
      );
    }
  }

  const plans = await planWrites(fs, repoPath, intents);
  if (opts.dryRun) {
    // Same renderer as `yoke sync`. Nothing is passed to executePlan, so no file, backup, or lock is created.
    const render: RenderOptions = {
      color: shouldUseColor({ isTTY: deps.io.stdoutIsTTY, env: deps.env }),
      repoPath,
      homeDir: deps.homeDir,
      dryRun: true,
      command: "yoke init",
    };
    const changes = plans.map((plan) => ({ harness: INIT_LABEL, plan }));
    deps.io.stdout(`${renderPlan(changes, notes, render)}\n`);
    return EXIT_OK;
  }
  const syncPlan: SyncPlan = {
    plans,
    changes: plans.map((plan) => ({ harness: INIT_LABEL, plan })),
    drift: { scopes: [], hasDrift: false },
    warnings: [],
    blocked: false,
    gate: [],
    locks: [],
    backupRoot: join(userDir, "backups"),
    force: opts.force,
  };
  const result = await executePlan({ plan: syncPlan, fs, now: deps.now });

  if (result.status === "failed") {
    const failure = result.failure;
    const where = failure === undefined ? "a file" : relativeTo(repoPath, failure.path);
    const why = failure === undefined ? "unknown error" : errorMessage(failure.error);
    deps.io.stderr(`yoke: failed writing ${where}: ${why}\n`);
    return EXIT_PROBLEMS;
  }
  for (const change of result.applied) {
    const backup =
      change.result.backupPath === undefined ? "" : ` (backup: ${change.result.backupPath})`;
    deps.io.stdout(`${change.result.status}: ${relativeTo(repoPath, change.path)}${backup}\n`);
  }
  for (const note of notes) {
    deps.io.stdout(`note: ${note}\n`);
  }
  deps.io.stdout(`harnesses: ${(draft.project.harnesses ?? []).join(", ") || "(none)"}\n`);
  deps.io.stdout("next: yoke sync\n");
  if (userAdded) {
    deps.io.stdout("next: yoke sync --global\n");
  }
  return EXIT_OK;
}
