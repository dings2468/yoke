/**
 * src/core/probe.ts — per-probe timeouts for injected exec and async work.
 *
 * Pure: no clock reads and no process access. Only `setTimeout` and `clearTimeout` are used,
 * so tests can drive timeouts with a short `timeoutMs`.
 */
import type { Exec, ExecResult } from "./git.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** Thrown by a timed exec when its timer fires before the child settles. */
export class ProbeTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} timed out after ${timeoutMs} ms`);
    this.name = "ProbeTimeoutError";
  }
}

export interface TimedExec {
  readonly exec: Exec;
  /** True once any exec call made through `exec` has hit its timeout. */
  readonly timedOut: () => boolean;
}

/**
 * Wraps `base` so every call is aborted after `timeoutMs`. Each call gets its own AbortController,
 * combined with the caller's signal (if any). On timeout the child is aborted, the flag is set,
 * and the call rejects with `ProbeTimeoutError`. The timer is cleared when the call settles.
 */
export function createTimedExec(base: Exec, timeoutMs: number): TimedExec {
  let timedOut = false;
  const exec: Exec = (file, args, opts) =>
    new Promise<ExecResult>((resolve, reject) => {
      const controller = new AbortController();
      const signal =
        opts.signal === undefined
          ? controller.signal
          : AbortSignal.any([opts.signal, controller.signal]);
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ProbeTimeoutError(file, timeoutMs));
      }, timeoutMs);
      base(file, args, { cwd: opts.cwd, signal }).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  return { exec, timedOut: () => timedOut };
}

export type ProbeOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Runs `run` with a deadline. Never rejects: a result after the deadline is ignored, and a thrown
 * error becomes `{ kind: "error" }` with the label prefixed to the message. This function does
 * not abort `run`; use `createTimedExec` when the work can be cancelled.
 */
export async function probe<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<ProbeOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProbeOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const work = (async (): Promise<ProbeOutcome<T>> => {
    try {
      return { kind: "ok", value: await run() };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "error", message: `${label}: ${reason}` };
    }
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
