/**
 * src/core/git.ts — git helpers with an injected exec (SPEC.md §9).
 *
 * Only this module imports `node:child_process`. Every helper takes a `GitContext`
 * whose `exec` is injected, so tests can script git output without a real repository.
 */
import { execFile } from "node:child_process";
import type { SessionGit } from "./schema.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Never rejects for a non-zero exit; rejects only when the binary cannot be spawned. */
export type Exec = (
  file: string,
  args: readonly string[],
  opts: { readonly cwd: string },
) => Promise<ExecResult>;

export type Env = Readonly<Record<string, string | undefined>>;

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Real exec backed by `execFile` (no shell). Git runs with optional locks and prompts disabled. */
export function createNodeExec(baseEnv: Env): Exec {
  return (file, args, opts) =>
    new Promise<ExecResult>((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          cwd: opts.cwd,
          maxBuffer: MAX_BUFFER_BYTES,
          encoding: "utf8",
          env: { ...baseEnv, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ stdout, stderr, exitCode: 0 });
            return;
          }
          if (typeof error.code === "number") {
            resolve({ stdout, stderr, exitCode: error.code });
            return;
          }
          reject(error);
        },
      );
    });
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitContext {
  readonly exec: Exec;
  readonly cwd: string;
}

/** Removes trailing line endings only. Leading and trailing spaces are kept (they are significant in `status --short`). */
export function stripTrailingNewlines(s: string): string {
  return s.replace(/(\r?\n)+$/, "");
}

async function runGit(ctx: GitContext, args: readonly string[]): Promise<ExecResult> {
  return ctx.exec("git", args, { cwd: ctx.cwd });
}

function assertOk(args: readonly string[], result: ExecResult): void {
  if (result.exitCode !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed with exit ${result.exitCode}: ${stripTrailingNewlines(result.stderr)}`,
      args,
      result.exitCode,
      result.stderr,
    );
  }
}

/** Repository top-level directory, or `undefined` when `cwd` is not inside a repository (exit 128). */
export async function gitRepoRoot(ctx: GitContext): Promise<string | undefined> {
  const args = ["rev-parse", "--show-toplevel"] as const;
  const result = await runGit(ctx, args);
  if (result.exitCode === 128) return undefined;
  assertOk(args, result);
  return stripTrailingNewlines(result.stdout);
}

/** Current branch name, or `""` on a detached HEAD (exit 1). */
export async function gitBranch(ctx: GitContext): Promise<string> {
  const args = ["symbolic-ref", "--short", "-q", "HEAD"] as const;
  const result = await runGit(ctx, args);
  if (result.exitCode === 1) return "";
  assertOk(args, result);
  return stripTrailingNewlines(result.stdout);
}

/** `git status --short` output, or `""` when the tree is clean. */
export async function gitStatusShort(ctx: GitContext): Promise<string> {
  const args = ["status", "--short"] as const;
  const result = await runGit(ctx, args);
  assertOk(args, result);
  return stripTrailingNewlines(result.stdout);
}

/**
 * `git diff --stat` of the worktree against HEAD (staged and unstaged changes).
 * Untracked files are NOT counted. On an unborn HEAD (no commits yet) it diffs the index (`--cached`) instead.
 */
export async function gitDiffStat(ctx: GitContext): Promise<string> {
  const head = await runGit(ctx, ["rev-parse", "--verify", "-q", "HEAD"]);
  const base = head.exitCode === 0 ? "HEAD" : "--cached";
  const args = ["diff", "--stat", "--no-color", "--no-ext-diff", base] as const;
  const result = await runGit(ctx, args);
  assertOk(args, result);
  return stripTrailingNewlines(result.stdout);
}

/**
 * Snapshot of the repository containing `ctx.cwd`. Throws `GitError` when it is not inside a repository.
 * All other git calls run from the repository root, because `status --short` paths are relative to cwd.
 * `diffStat` is `""` when `includeDiffStat` is false.
 */
export async function gitSnapshot(
  ctx: GitContext,
  opts: { readonly includeDiffStat: boolean },
): Promise<SessionGit> {
  const root = await gitRepoRoot(ctx);
  if (root === undefined) {
    throw new GitError("not a git repository", ["rev-parse", "--show-toplevel"], 128, "");
  }
  const rootCtx: GitContext = { exec: ctx.exec, cwd: root };
  const branch = await gitBranch(rootCtx);
  const statusShort = await gitStatusShort(rootCtx);
  const diffStat = opts.includeDiffStat ? await gitDiffStat(rootCtx) : "";
  return { branch, statusShort, diffStat };
}
