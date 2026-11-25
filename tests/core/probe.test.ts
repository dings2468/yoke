import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeExec, type Exec, type ExecResult } from "../../src/core/git.js";
import { createTimedExec, ProbeTimeoutError, probe } from "../../src/core/probe.js";

const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yoke-probe-"));
  cleanup.push(dir);
  return dir;
}

const OK: ExecResult = { stdout: "ok\n", stderr: "", exitCode: 0 };

describe("createTimedExec", () => {
  it("rejects with ProbeTimeoutError and aborts the signal when the base never settles", async () => {
    let seen: AbortSignal | undefined;
    const base: Exec = (_file, _args, opts) => {
      seen = opts.signal;
      return new Promise<ExecResult>(() => undefined);
    };
    const timed = createTimedExec(base, 20);
    const started = Date.now();

    const error: unknown = await timed.exec("git", ["status"], { cwd: "/nowhere" }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ProbeTimeoutError);
    expect(error).toMatchObject({ name: "ProbeTimeoutError", label: "git", timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(timed.timedOut()).toBe(true);
    expect(seen?.aborted).toBe(true);
  });

  it("resolves a fast exec and leaves timedOut() false", async () => {
    const base: Exec = () => Promise.resolve(OK);
    const timed = createTimedExec(base, 1000);

    await expect(timed.exec("git", ["status"], { cwd: "/nowhere" })).resolves.toEqual(OK);
    expect(timed.timedOut()).toBe(false);
  });

  it("propagates a rejection from the base without marking a timeout", async () => {
    const boom = new Error("spawn failed");
    const timed = createTimedExec(() => Promise.reject(boom), 1000);

    await expect(timed.exec("git", [], { cwd: "/nowhere" })).rejects.toBe(boom);
    expect(timed.timedOut()).toBe(false);
  });

  it("combines a caller signal: an already-aborted caller signal reaches the base", async () => {
    const caller = new AbortController();
    caller.abort();
    let seen: AbortSignal | undefined;
    const base: Exec = (_file, _args, opts) => {
      seen = opts.signal;
      return Promise.reject(new Error("aborted"));
    };
    const timed = createTimedExec(base, 1000);

    await expect(timed.exec("git", [], { cwd: "/nowhere", signal: caller.signal })).rejects.toThrow(
      "aborted",
    );
    expect(seen?.aborted).toBe(true);
    expect(timed.timedOut()).toBe(false);
  });
});

describe("probe", () => {
  it("maps a resolved value to ok", async () => {
    await expect(probe(() => Promise.resolve(42), 1000, "x")).resolves.toEqual({
      kind: "ok",
      value: 42,
    });
  });

  it("maps a slow run to timeout", async () => {
    const outcome = await probe(() => new Promise<number>(() => undefined), 20, "x");
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("maps a thrown error to error with the label in the message", async () => {
    const outcome = await probe(
      () => Promise.reject(new Error("no binary")),
      1000,
      "claude --version",
    );
    expect(outcome).toEqual({ kind: "error", message: "claude --version: no binary" });
  });

  it("maps a synchronous throw to error instead of rejecting", async () => {
    const outcome = await probe(
      () => {
        throw "plain string";
      },
      1000,
      "y",
    );
    expect(outcome).toEqual({ kind: "error", message: "y: plain string" });
  });
});

describe("createNodeExec abort", () => {
  it("rejects quickly when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = createNodeExec({});
    const started = Date.now();

    await expect(
      exec(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
        cwd: tempDir(),
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
