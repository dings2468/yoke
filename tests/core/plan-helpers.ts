/**
 * tests/core/plan-helpers.ts: harness-neutral fake adapter and sandbox helpers for the core plan tests.
 *
 * The fake adapter names no harness. Its native files sit under the injected home and repo paths, so these helpers never
 * read or write the real home directory. Core plan tests use this adapter and never the real adapter factories.
 */
import { readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AdapterContext,
  type ApplyResult,
  type FileChangePlan,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessStatus,
  layerView,
  planInstructionLink,
  planJsonKeyPatch,
  readFileSnapshot,
  toDefinition,
  toNativeInstructions,
} from "../../src/adapters/base.js";
import { canonicalJson, normalizeMcp } from "../../src/core/drift.js";
import {
  createNodeFs,
  type Fs,
  isNotFound,
  type ReadFs,
  readJsonIfExists,
  toReadFs,
} from "../../src/core/fs-safe.js";
import {
  getAtPath,
  isJsonObject,
  type JsonKeyPath,
  type JsonObject,
  type JsonValue,
  parseJsonText,
} from "../../src/core/json-text.js";
import {
  type McpServerDefinition,
  McpServerDefinitionSchema,
  type PartialYokeConfig,
  type ResolvedYokeConfig,
  SCOPES,
  type Scope,
  type SyncOptions,
} from "../../src/core/schema.js";
import { loadScopeInputs, resolveConfig } from "../../src/core/scopes.js";
import type { Sandbox } from "../adapters/helpers.js";

export interface FakeAdapterOptions {
  readonly name?: string; // default "alpha"
  readonly capabilities?: Partial<HarnessCapabilities>;
  readonly failApplyOn?: string; // apply() of the plan with this path rejects with Error("boom")
  readonly fallbackOn?: string; // apply() of this path returns { status: "fallback", backupPath: undefined, detail: "refused" }, writes nothing
}

export interface FakePaths {
  readonly user: string;
  readonly project: string;
  readonly instructions: string;
}

interface ScopeTarget {
  readonly path: string;
  readonly keyPath: JsonKeyPath;
}

interface ScopeWant {
  readonly mcps: Readonly<Record<string, McpServerDefinition>>;
  readonly value: JsonObject;
}

/** Native file locations for the fake adapter. `user` is shared by the user and local tiers. */
export function fakePaths(home: string, repo: string, name = "alpha"): FakePaths {
  return {
    user: join(home, `.${name}`, "servers.json"),
    project: join(repo, `.${name}.json`),
    instructions: join(repo, `${name.toUpperCase()}.md`),
  };
}

function mcpTarget(scope: Scope, paths: FakePaths, repoPath: string): ScopeTarget {
  switch (scope) {
    case "user":
      return { path: paths.user, keyPath: ["servers"] };
    case "project":
      return { path: paths.project, keyPath: ["servers"] };
    case "local":
      return { path: paths.user, keyPath: ["projects", repoPath, "servers"] };
  }
}

/** Enabled servers of one scope layer, as full definitions and as the canonical JSON value stored in the native file. */
function wantFor(config: ResolvedYokeConfig, scope: Scope): ScopeWant {
  const defs = Object.entries(layerView(config, scope))
    .filter(([, server]) => server.enabled)
    .map(([name, server]): [string, McpServerDefinition] => [name, toDefinition(server)]);
  return {
    mcps: Object.fromEntries(defs),
    value: Object.fromEntries(
      defs.map(([name, def]): [string, JsonValue] => [
        name,
        parseJsonText(canonicalJson(normalizeMcp(def))),
      ]),
    ),
  };
}

function withFaults(plan: FileChangePlan, opts: FakeAdapterOptions): FileChangePlan {
  if (plan.path === opts.failApplyOn) {
    return { ...plan, apply: () => Promise.reject(new Error("boom")) };
  }
  if (plan.path === opts.fallbackOn) {
    const refused: ApplyResult = { status: "fallback", backupPath: undefined, detail: "refused" };
    return { ...plan, apply: () => Promise.resolve(refused) };
  }
  return plan;
}

function capabilitiesFor(over: Partial<HarnessCapabilities> | undefined): HarnessCapabilities {
  return {
    staticMcp: over?.staticMcp ?? true,
    staticInstructions: over?.staticInstructions ?? true,
    reverseRead: over?.reverseRead ?? true,
    sessionExport: over?.sessionExport ?? true,
    sessionImport: over?.sessionImport ?? "handoff-file-only",
  };
}

async function planStatic(
  ctx: AdapterContext,
  name: string,
  opts: FakeAdapterOptions,
  config: ResolvedYokeConfig,
  sync: SyncOptions,
): Promise<FileChangePlan[]> {
  const fs = toReadFs(ctx.fs);
  const paths = fakePaths(ctx.homeDir, sync.repoPath, name);
  const plans: FileChangePlan[] = [];
  for (const scope of SCOPES) {
    if (!sync.scopes.includes(scope)) {
      continue;
    }
    const target = mcpTarget(scope, paths, sync.repoPath);
    const want = wantFor(config, scope);
    const plan = await planJsonKeyPatch(fs, {
      scope,
      path: target.path,
      keyPath: target.keyPath,
      value: want.value,
      summary: `${name} ${scope} MCP servers in ${target.path}`,
      warnings: [],
      expected: [{ kind: "mcps", scope, mcps: want.mcps }],
    });
    plans.push(withFaults(plan, opts));
  }
  if (sync.scopes.includes("project")) {
    const plan = await planInstructionLink(
      { ...ctx, fs },
      {
        scope: "project",
        linkPath: paths.instructions,
        sourcePath: join(sync.repoPath, "AGENTS.md"),
      },
    );
    if (plan !== undefined) {
      plans.push(withFaults(plan, opts));
    }
  }
  return plans;
}

async function readMcps(
  fs: ReadFs,
  target: ScopeTarget,
): Promise<Record<string, McpServerDefinition>> {
  const cur = await readJsonIfExists(fs, target.path);
  const raw = cur === undefined ? undefined : getAtPath(cur.value, target.keyPath);
  if (raw === undefined) {
    return {};
  }
  if (!isJsonObject(raw)) {
    throw new Error(`expected an object at ${target.keyPath.join(".")} in ${target.path}`);
  }
  return Object.fromEntries(
    Object.entries(raw).map(([serverName, value]): [string, McpServerDefinition] => [
      serverName,
      McpServerDefinitionSchema.parse(value),
    ]),
  );
}

async function readNative(
  ctx: AdapterContext,
  name: string,
  repoPath: string,
): Promise<PartialYokeConfig> {
  const fs = toReadFs(ctx.fs);
  const paths = fakePaths(ctx.homeDir, repoPath, name);
  const instructions = toNativeInstructions(
    paths.instructions,
    await readFileSnapshot(fs, paths.instructions),
  );
  return {
    user: { mcps: await readMcps(fs, mcpTarget("user", paths, repoPath)) },
    project: {
      mcps: await readMcps(fs, mcpTarget("project", paths, repoPath)),
      ...(instructions === undefined ? {} : { instructions }),
    },
    local: { mcps: await readMcps(fs, mcpTarget("local", paths, repoPath)) },
  };
}

/**
 * Factory for the harness-neutral fake adapter. Name defaults to "alpha". It plans every requested scope, reads the same
 * native keys back, and never writes outside apply().
 */
export function fakeAdapterFactory(
  opts: FakeAdapterOptions = {},
): (ctx: AdapterContext) => HarnessAdapter {
  const name = opts.name ?? "alpha";
  const capabilities = capabilitiesFor(opts.capabilities);
  return (ctx) => ({
    name,
    capabilities,
    detect: (): Promise<HarnessStatus> => Promise.resolve({ installed: true, authenticated: true }),
    readNativeState: (repoPath) => readNative(ctx, name, repoPath),
    syncStatic: (config, sync) => planStatic(ctx, name, opts, config, sync),
  });
}

/** The three scope files of a sandbox: user -> userConfigDir/yoke.yaml, project -> repo/yoke.yaml, local -> repo/yoke.local.yaml. */
function scopeFilePaths(sb: Sandbox): {
  readonly user: string;
  readonly project: string;
  readonly local: string;
} {
  return {
    user: join(sb.userConfigDir, "yoke.yaml"),
    project: join(sb.repo, "yoke.yaml"),
    local: join(sb.repo, "yoke.local.yaml"),
  };
}

/** Writes yaml text to the scope files that are given. Omitted tiers are left absent. */
export async function writeScopeFiles(
  sb: Sandbox,
  files: { readonly user?: string; readonly project?: string; readonly local?: string },
): Promise<void> {
  const paths = scopeFilePaths(sb);
  if (files.user !== undefined) {
    await writeFile(paths.user, files.user, "utf8");
  }
  if (files.project !== undefined) {
    await writeFile(paths.project, files.project, "utf8");
  }
  if (files.local !== undefined) {
    await writeFile(paths.local, files.local, "utf8");
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return undefined;
    }
    throw err;
  }
}

/** Loads and resolves the scope files written by writeScopeFiles. Warnings are dropped. */
export async function loadSandboxConfig(sb: Sandbox): Promise<ResolvedYokeConfig> {
  const inputs = await loadScopeInputs(readOptional, scopeFilePaths(sb));
  return resolveConfig(inputs, { projectDir: sb.repo, warn: () => {} });
}

/** A writable-looking Fs whose write methods reject and record their names in `writes`. */
export function guardedFs(): { readonly fs: Fs; readonly writes: string[] } {
  const writes: string[] = [];
  const denied = (method: string) => (): Promise<never> => {
    writes.push(method);
    return Promise.reject(new Error(`write attempted during read-only work: ${method}`));
  };
  const fs: Fs = {
    ...createNodeFs(),
    writeFile: denied("writeFile"),
    rename: denied("rename"),
    mkdir: denied("mkdir"),
    copyFile: denied("copyFile"),
    symlink: denied("symlink"),
    unlink: denied("unlink"),
    chmod: denied("chmod"),
  };
  return { fs, writes };
}

/** Lists every file, directory, and link under `dir` with its content, so any change shows in a comparison. */
export async function snapshotTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        out.push(`d ${full}`);
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        out.push(`l ${full} -> ${await readlink(full)}`);
      } else {
        out.push(`f ${full} ${await readFile(full, "utf8")}`);
      }
    }
  };
  await walk(dir);
  return out.sort();
}
