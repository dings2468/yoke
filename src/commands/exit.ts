/**
 * src/commands/exit.ts — process exit codes (SPEC.md §7, "Exit codes").
 */

/** Success, nothing to do, or a clean check. */
export const EXIT_OK = 0;
/** Failure: doctor found a problem, or a command failed at runtime. */
export const EXIT_PROBLEMS = 1;
/** Usage error: unknown option, bad or missing argument, or prompt needed without a TTY. */
export const EXIT_USAGE = 2;
/** Drift refusal: native changes detected and the run could not proceed without --force. */
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
