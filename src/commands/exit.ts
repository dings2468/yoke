/**
 * src/commands/exit.ts — process exit codes (exit codes are documented for users in README.md, section Exit codes).
 *
 * | Code | Meaning | Returned by |
 * | :--- | :--- | :--- |
 * | `0` | Success, nothing to do, or a clean check. `--help` and `--version` also exit `0`. | all commands |
 * | `1` | Failure: `doctor` found at least one problem, or the command failed at runtime (invalid `yoke.yaml`, unreadable native state, plan conflict, apply failure, import error). | `sync`, `init`, `doctor`, `switch` (v0.2) |
 * | `2` | Usage error: unknown option, bad or missing argument, or an interactive prompt required without a terminal. | all commands |
 * | `3` | Drift refusal: native changes detected and the run was non-interactive without `--force`, or the user chose "Abort". A blocked dry run also returns `3`. | `sync`, `switch` (v0.2) |
 * | `130` | Interrupted: the user cancelled a prompt or sent SIGINT before anything was written. | `init`, `sync`, `switch` (v0.2) |
 *
 * `yoke sessions` is not yet available; when added it returns only `0`, `1`, and `2`. `--dry-run` returns the same code a
 * real run would, so `yoke sync --dry-run` can be used as a CI drift check.
 */

/** Success, nothing to do, or a clean check. */
export const EXIT_OK = 0;
/** Failure: doctor found a problem, or a command failed at runtime. */
export const EXIT_PROBLEMS = 1;
/** Usage error: unknown option, bad or missing argument, or prompt needed without a TTY. */
export const EXIT_USAGE = 2;
/** Drift refusal: native changes detected and the run could not proceed without --force, or a blocked dry run. */
export const EXIT_DRIFT = 3;
/** Interrupted by the user before anything was written. */
export const EXIT_INTERRUPTED = 130;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_PROBLEMS
  | typeof EXIT_USAGE
  | typeof EXIT_DRIFT
  | typeof EXIT_INTERRUPTED;

/** Thrown for command-line usage errors. `runCli` maps it to {@link EXIT_USAGE}. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
