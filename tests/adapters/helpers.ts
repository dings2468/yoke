/**
 * tests/adapters/helpers.ts: temp sandbox and fake exec for adapter tests.
 *
 * Every path is injected. Nothing here reads or writes the real home directory, `~/.claude.json`, or `~/.gemini`.
 * Fixtures under tests/fixtures/adapters/ are copied into a fresh directory under `os.tmpdir()`.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterContext, ApplyContext } from "../../src/adapters/base.js";
import { createBackupSession, createNodeFs, toReadFs } from "../../src/core/fs-safe.js";
import type { Exec, ExecResult } from "../../src/core/git.js";
import {
  type ResolvedYokeConfig,
  type StateEntry,
  type YokeStateLock,
  YokeStateLockSchema,
} from "../../src/core/schema.js";
import { loadScopeInputs, resolveConfig } from "../../src/core/scopes.js";

export const ADAPTER_FIXTURES = fileURLToPath(new URL("../fixtures/adapters/", import.meta.url));

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly repo: string;
  readonly userConfigDir: string;
  readonly backupsRoot: string;
}

/** Throws unless `target` is `base` or lies inside it. */
function assertInside(base: string, target: string): void {
  const rel = relative(base, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new Error(`path escapes sandbox: ${target}`);
}

/** Creates `<tmp>/yoke-adapter-*` with home, repo, xdg/yoke, and backups. The root is a realpath (the Claude repo key is a realpath). */
export async function setupAdapterSandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "yoke-adapter-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const userConfigDir = join(root, "xdg", "yoke");
  const backupsRoot = join(userConfigDir, "backups");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(repo, { recursive: true }),
    mkdir(backupsRoot, { recursive: true }),
  ]);
  return { root, home, repo, userConfigDir, backupsRoot };
}

/**
 * Copies one fixture into the sandbox. `from` is relative to ADAPTER_FIXTURES; `to` is absolute and must lie inside sb.root.
 * Every `__REPO__` placeholder is replaced with the sandbox repo path, JSON-escaped for use inside a string literal.
 */
export async function copyFixture(sb: Sandbox, from: string, to: string): Promise<void> {
  const source = resolve(ADAPTER_FIXTURES, from);
  assertInside(ADAPTER_FIXTURES, source);
  const target = resolve(to);
  assertInside(sb.root, target);
  const text = await readFile(source, "utf8");
  const escapedRepo = JSON.stringify(sb.repo).slice(1, -1);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text.replaceAll("__REPO__", escapedRepo), "utf8");
}

/** Removes the sandbox. The root must lie inside the OS temp directory. */
export async function cleanupSandbox(sb: Sandbox): Promise<void> {
  assertInside(tmpdir(), sb.root);
  await rm(sb.root, { recursive: true, force: true });
}

/**
 * Scripted exec. The key is `${file} ${args.join(" ")}`. "ENOENT" rejects like a missing binary; an unknown key exits 127.
 * Every call is recorded in `calls` using the same key format.
 */
export function fakeExec(
  script: ReadonlyMap<string, ExecResult | "ENOENT">,
): Exec & { readonly calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    calls.push(key);
    const entry = script.get(key);
    if (entry === "ENOENT") {
      throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    }
    if (entry === undefined) {
      return { stdout: "", stderr: `unexpected command: ${key}`, exitCode: 127 };
    }
    return entry;
  };
  return Object.assign(exec, { calls });
}

/**
 * Copies config fixtures (names relative to config/, e.g. "user.yaml") to the scope paths and resolves them.
 * Scope files: user -> userConfigDir/yoke.yaml, project -> repo/yoke.yaml, local -> repo/yoke.local.yaml.
 */
export async function loadFixtureConfig(
  sb: Sandbox,
  files: { user?: string; project?: string; local?: string },
): Promise<ResolvedYokeConfig> {
  const paths = {
    user: join(sb.userConfigDir, "yoke.yaml"),
    project: join(sb.repo, "yoke.yaml"),
    local: join(sb.repo, "yoke.local.yaml"),
  };
  const copies: [string | undefined, string][] = [
    [files.user, paths.user],
    [files.project, paths.project],
    [files.local, paths.local],
  ];
  await Promise.all(
    copies.map(([name, to]) =>
      name === undefined ? undefined : copyFixture(sb, `config/${name}`, to),
    ),
  );
  const readText = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(path, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };
  const inputs = await loadScopeInputs(readText, paths);
  return resolveConfig(inputs, { projectDir: sb.repo, warn: () => {} });
}

// #region BA1 contract helpers

/** Adapter context whose paths all live in the sandbox. `exec` is an empty fakeExec unless overridden. */
export function makeAdapterContext(sb: Sandbox, over?: Partial<AdapterContext>): AdapterContext {
  return {
    homeDir: sb.home,
    userConfigDir: sb.userConfigDir,
    fs: toReadFs(createNodeFs()),
    exec: fakeExec(new Map()),
    env: {},
    ...over,
  };
}

/** Apply context with a real writable fs and a backup session rooted in the sandbox at a fixed clock. */
export function makeApplyContext(sb: Sandbox): ApplyContext {
  const fs = createNodeFs();
  return {
    fs,
    backup: createBackupSession({
      fs,
      root: sb.backupsRoot,
      now: () => new Date("2026-11-24T10:00:00.000Z"),
    }),
  };
}

/** A parsed `.yoke/yoke.lock` with a fixed `lastSyncedAt`. Entries are keyed by `<harness>:<scope>`. */
export function lockFrom(entries: Readonly<Record<string, StateEntry>>): YokeStateLock {
  return YokeStateLockSchema.parse({
    version: 1,
    lastSyncedAt: "2026-11-24T10:00:00.000Z",
    harnesses: entries,
  });
}

// #endregion BA1 contract helpers
