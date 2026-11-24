import { describe, expect, it } from "vitest";
import {
  ABORT,
  createDriftConfirm,
  DRIFT_PROMPT_MESSAGE,
  type DriftPromptApi,
  OVERWRITE,
  SyncCancelledError,
} from "../../src/commands/sync-prompt.js";
import type { SyncPlan } from "../../src/core/plan.js";

const CANCEL = Symbol("cancel");

interface SelectCall {
  readonly message: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

function fakeApi(answer: string | symbol): { api: DriftPromptApi; calls: SelectCall[] } {
  const calls: SelectCall[] = [];
  const api: DriftPromptApi = {
    select: async (o) => {
      calls.push(o);
      return answer;
    },
    isCancel: (value: unknown): value is symbol => value === CANCEL,
  };
  return { api, calls };
}

// The confirm callback ignores its plan argument, so an empty stand-in is enough.
const plan = {} as SyncPlan;

describe("createDriftConfirm", () => {
  it("shows the SPEC §5 message and the two choices in order, calling select once", async () => {
    const { api, calls } = fakeApi("overwrite");
    await createDriftConfirm(api)(plan);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("How do you want to proceed?");
    expect(DRIFT_PROMPT_MESSAGE).toBe("How do you want to proceed?");
    expect(calls[0]?.options).toEqual([
      { value: "overwrite", label: "Overwrite with yoke config" },
      { value: "abort", label: "Abort" },
    ]);
  });

  it("resolves true when the user chooses overwrite", async () => {
    const { api } = fakeApi(OVERWRITE.value);
    await expect(createDriftConfirm(api)(plan)).resolves.toBe(true);
  });

  it("resolves false when the user chooses abort", async () => {
    const { api } = fakeApi(ABORT.value);
    await expect(createDriftConfirm(api)(plan)).resolves.toBe(false);
  });

  it("resolves false for any unexpected answer", async () => {
    const { api } = fakeApi("something-else");
    await expect(createDriftConfirm(api)(plan)).resolves.toBe(false);
  });

  it("throws SyncCancelledError when the prompt is cancelled", async () => {
    const { api } = fakeApi(CANCEL);
    const confirm = createDriftConfirm(api);
    const outcome = await confirm(plan).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(SyncCancelledError);
    expect((outcome as Error).name).toBe("SyncCancelledError");
  });
});
