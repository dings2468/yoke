/**
 * src/commands/sync-prompt.ts — the interactive drift prompt for `yoke sync` (SPEC.md §5, v0.1).
 * `createDriftConfirm` is pure over an injected DriftPromptApi and is tested with fakes. The only @clack/prompts use in
 * this file is `createClackDriftPrompt`, the real terminal wrapper.
 */
import * as clack from "@clack/prompts";
import type { ConfirmDrift } from "../core/plan.js";

export interface DriftPromptApi {
  select(o: {
    readonly message: string;
    readonly options: readonly { readonly value: string; readonly label: string }[];
  }): Promise<string | symbol>;
  isCancel(value: unknown): value is symbol;
}

/** Thrown when the user cancels the drift prompt (Ctrl-C). Nothing has been written at that point. */
export class SyncCancelledError extends Error {
  constructor(message = "sync prompt cancelled") {
    super(message);
    this.name = "SyncCancelledError";
  }
}

export const DRIFT_PROMPT_MESSAGE = "How do you want to proceed?";
export const OVERWRITE = { value: "overwrite", label: "Overwrite with yoke config" } as const;
export const ABORT = { value: "abort", label: "Abort" } as const;

/** Maps the prompt answer to a confirm decision. Only "overwrite" confirms; anything else refuses. */
export function createDriftConfirm(api: DriftPromptApi): ConfirmDrift {
  return async () => {
    const answer = await api.select({
      message: DRIFT_PROMPT_MESSAGE,
      options: [OVERWRITE, ABORT],
    });
    if (api.isCancel(answer)) {
      throw new SyncCancelledError();
    }
    return answer === OVERWRITE.value;
  };
}

/** Real terminal prompt. The only clack use in this file. */
export function createClackDriftPrompt(): DriftPromptApi {
  return {
    select: (o) =>
      clack.select<string>({
        message: o.message,
        options: o.options.map((option) => ({ value: option.value, label: option.label })),
      }),
    isCancel: (value: unknown): value is symbol => clack.isCancel(value),
  };
}
