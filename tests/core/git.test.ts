import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeExec,
  type Exec,
  type ExecResult,
  type GitContext,
  GitError,
  gitBranch,
  gitDiffStat,
  gitRepoRoot,
  gitSnapshot,
  gitStatusShort,
  stripTrailingNewlines,
} from "../../src/core/git.js";

interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Scripted exec: results keyed by `args.join(" ")`. Unscripted calls throw so a test fails loudly. */
function fakeExec(script: Map<string, ExecResult>): { exec: Exec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    const key = args.join(" ");
    const result = script.get(key);
    if (result === undefined) throw new Error(`unscripted git call: ${key}`);
    return result;
  };
  return { exec, calls };
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(exitCode: number, stderr: string): ExecResult {
  return { stdout: "", stderr, exitCode };
}

const DIFF_HEAD = "diff --stat --no-color --no-ext-diff HEAD";
const DIFF_CACHED = "diff --stat --no-color --no-ext-diff --cached";

describe("git helpers (fake exec)", () => {
  it("gitRepoRoot returns undefined outside a repository (exit 128)", async () => {
    const { exec } = fakeExec(
      new Map([["rev-parse --show-toplevel", fail(128, "fatal: not a git repository")]]),
    );
    await expect(gitRepoRoot({ exec, cwd: "/nowhere" })).resolves.toBeUndefined();
  });

  it("gitRepoRoot strips the trailing newline from the root path", async () => {
    const { exec } = fakeExec(new Map([["rev-parse --show-toplevel", ok("/repo\n")]]));
    await expect(gitRepoRoot({ exec, cwd: "/repo/sub" })).resolves.toBe("/repo");
  });

  it("gitBranch returns an empty string on a detached HEAD (exit 1)", async () => {
    const { exec } = fakeExec(new Map([["symbolic-ref --short -q HEAD", fail(1, "")]]));
    await expect(gitBranch({ exec, cwd: "/repo" })).resolves.toBe("");
  });

  it("gitStatusShort keeps the leading space of a worktree-modified entry", async () => {
    const { exec } = fakeExec(new Map([["status --short", ok(" M a.ts\n?? b\n")]]));
    await expect(gitStatusShort({ exec, cwd: "/repo" })).resolves.toBe(" M a.ts\n?? b");
  });

  it("gitDiffStat diffs against HEAD when HEAD exists", async () => {
    const { exec, calls } = fakeExec(
      new Map([
        ["rev-parse --verify -q HEAD", ok("abc123\n")],
        [DIFF_HEAD, ok(" a.ts | 1 +\n 1 file changed, 1 insertion(+)\n")],
      ]),
    );
    const stat = await gitDiffStat({ exec, cwd: "/repo" });
    expect(stat).toBe(" a.ts | 1 +\n 1 file changed, 1 insertion(+)");
    expect(calls.map((c) => c.args.join(" "))).toEqual(["rev-parse --verify -q HEAD", DIFF_HEAD]);
  });

  it("gitDiffStat uses --cached on an unborn HEAD", async () => {
    const { exec, calls } = fakeExec(
      new Map([
        ["rev-parse --verify -q HEAD", fail(1, "")],
        [DIFF_CACHED, ok("")],
      ]),
    );
    await expect(gitDiffStat({ exec, cwd: "/repo" })).resolves.toBe("");
    expect(calls.map((c) => c.args.join(" "))).toContain(DIFF_CACHED);
  });

  it("gitSnapshot runs git from the repository root, not from the subdirectory", async () => {
    const { exec, calls } = fakeExec(
      new Map([
        ["rev-parse --show-toplevel", ok("/repo\n")],
        ["symbolic-ref --short -q HEAD", ok("main\n")],
        ["status --short", ok("?? b\n")],
        ["rev-parse --verify -q HEAD", ok("abc\n")],
        [DIFF_HEAD, ok(" 1 file changed\n")],
      ]),
    );
    const snap = await gitSnapshot({ exec, cwd: "/repo/sub" }, { includeDiffStat: true });
    expect(snap).toEqual({ branch: "main", statusShort: "?? b", diffStat: " 1 file changed" });
    const rootCalls = calls.filter(
      (c) => c.args[0] !== "rev-parse" || c.args[1] !== "--show-toplevel",
    );
    for (const call of rootCalls) expect(call.cwd).toBe("/repo");
    expect(calls[0]?.cwd).toBe("/repo/sub");
  });

  it("gitSnapshot makes no diff call when includeDiffStat is false", async () => {
    const { exec, calls } = fakeExec(
      new Map([
        ["rev-parse --show-toplevel", ok("/repo\n")],
        ["symbolic-ref --short -q HEAD", fail(1, "")],
        ["status --short", ok("")],
      ]),
    );
    const snap = await gitSnapshot({ exec, cwd: "/repo" }, { includeDiffStat: false });
    expect(snap).toEqual({ branch: "", statusShort: "", diffStat: "" });
    expect(calls.some((c) => c.args[0] === "diff")).toBe(false);
  });

  it("gitSnapshot throws GitError 'not a git repository' outside a repository", async () => {
    const { exec } = fakeExec(
      new Map([["rev-parse --show-toplevel", fail(128, "fatal: not a git repository")]]),
    );
    const err = await gitSnapshot({ exec, cwd: "/nowhere" }, { includeDiffStat: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toBe("not a git repository");
  });

  it("an unexpected exit code throws GitError carrying stderr", async () => {
    const { exec } = fakeExec(new Map([["status --short", fail(2, "fatal: index broken\n")]]));
    const err = await gitStatusShort({ exec, cwd: "/repo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    const gitErr = err as GitError;
    expect(gitErr.exitCode).toBe(2);
    expect(gitErr.stderr).toBe("fatal: index broken\n");
    expect(gitErr.args).toEqual(["status", "--short"]);
  });

  it("stripTrailingNewlines removes only trailing line endings", () => {
    expect(stripTrailingNewlines("  x\r\n\n")).toBe("  x");
    expect(stripTrailingNewlines("  x  ")).toBe("  x  ");
  });
});

describe("createNodeExec (no git required)", () => {
  it("captures stdout and maps the child exit code without rejecting", async () => {
    const exec = createNodeExec({});
    const result = await exec(
      process.execPath,
      ["-e", "process.stdout.write('hi'); process.exit(3)"],
      { cwd: process.cwd() },
    );
    expect(result).toEqual({ stdout: "hi", stderr: "", exitCode: 3 });
  });

  it("rejects when the binary cannot be spawned", async () => {
    const exec = createNodeExec({});
    await expect(
      exec("yoke-no-such-binary-for-tests", [], { cwd: process.cwd() }),
    ).rejects.toThrow();
  });
});

describe("git against a real repository", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const hasGit = spawnSync("git", ["--version"]).status === 0;

  it.skipIf(!hasGit)(
    "reads root, branch, status, and diffstat, including from a subdirectory",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "yoke-git-"));
      tempDirs.push(tmp);
      const repo = join(tmp, "repo");
      const sub = join(repo, "sub");
      mkdirSync(sub, { recursive: true });

      const exec = createNodeExec({ ...process.env, GIT_CONFIG_NOSYSTEM: "1" });
      const git = async (args: readonly string[]): Promise<void> => {
        const result = await exec("git", args, { cwd: repo });
        if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      };

      await git(["init", "-q", "-b", "main"]);
      await writeFile(join(repo, "a.txt"), "one\n");
      await git(["add", "a.txt"]);
      await git([
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "init",
      ]);
      await writeFile(join(repo, "a.txt"), "one\ntwo\n");
      await writeFile(join(repo, "b.txt"), "untracked\n");

      const realRepo = realpathSync(repo);
      const ctx: GitContext = { exec, cwd: repo };
      expect(await gitRepoRoot(ctx)).toBe(realRepo);
      expect(await gitBranch(ctx)).toBe("main");
      expect(await gitStatusShort(ctx)).toBe(" M a.txt\n?? b.txt");
      expect(await gitDiffStat(ctx)).toContain("1 file changed");

      const subCtx: GitContext = { exec, cwd: sub };
      expect(await gitRepoRoot(subCtx)).toBe(realRepo);
      const snap = await gitSnapshot(subCtx, { includeDiffStat: true });
      expect(snap.branch).toBe("main");
      expect(snap.statusShort).toBe(" M a.txt\n?? b.txt");
      expect(snap.diffStat).toContain("1 file changed");
    },
  );
});
