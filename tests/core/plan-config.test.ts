import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFs } from "../../src/core/fs-safe.js";
import type { Exec } from "../../src/core/git.js";
import {
  type AdapterFactory,
  loadPass,
  type PlanRequest,
  SyncRequestError,
  scopesForFlags,
  selectHarnesses,
  validateRequest,
} from "../../src/core/plan.js";
import type { ResolvedYokeConfig, Scope } from "../../src/core/schema.js";
import { fakeAdapterFactory, guardedFs } from "./plan-helpers.js";

const exec: Exec = () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });

describe("plan request and config", () => {
  let root: string;
  let repo: string;
  let home: string;
  let userConfigDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yoke-plan-config-"));
    repo = join(root, "repo");
    home = join(root, "home");
    userConfigDir = join(root, "xdg", "yoke");
    await mkdir(repo, { recursive: true });
    await mkdir(userConfigDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function request(over: Partial<PlanRequest> = {}): PlanRequest {
    return {
      repoPath: repo,
      scopes: ["project", "local"],
      force: false,
      global: false,
      homeDir: home,
      env: {},
      readFs: createNodeFs(),
      exec,
      adapters: new Map<string, AdapterFactory>(),
      ...over,
    };
  }

  it("maps flags to scopes", () => {
    expect(scopesForFlags({ global: false, all: false })).toEqual(["project", "local"]);
    expect(scopesForFlags({ global: true, all: false })).toEqual(["user"]);
    expect(scopesForFlags({ global: false, all: true })).toEqual(["user", "project", "local"]);
  });

  it("rejects --global together with --all", () => {
    expect(() => scopesForFlags({ global: true, all: true })).toThrow(SyncRequestError);
  });

  it("rejects a relative repoPath and a relative homeDir", () => {
    expect(() => validateRequest(request({ repoPath: "repo" }))).toThrow(SyncRequestError);
    expect(() => validateRequest(request({ homeDir: "home" }))).toThrow(SyncRequestError);
  });

  it("rejects empty, duplicated, and invalid scopes", () => {
    expect(() => validateRequest(request({ scopes: [] }))).toThrow(SyncRequestError);
    expect(() => validateRequest(request({ scopes: ["project", "project"] }))).toThrow(
      SyncRequestError,
    );
    expect(() => validateRequest(request({ scopes: ["bogus" as Scope] }))).toThrow(
      SyncRequestError,
    );
  });

  it("rejects global with scopes other than exactly user", () => {
    expect(() => validateRequest(request({ global: true, scopes: ["project"] }))).toThrow(
      SyncRequestError,
    );
    expect(() => validateRequest(request({ global: true, scopes: ["user", "project"] }))).toThrow(
      SyncRequestError,
    );
    expect(() => validateRequest(request({ global: true, scopes: ["user"] }))).not.toThrow();
  });

  it("rejects invalid and duplicated harness names", () => {
    expect(() => validateRequest(request({ harnesses: ["Bad_Name"] }))).toThrow(SyncRequestError);
    expect(() => validateRequest(request({ harnesses: ["alpha", "alpha"] }))).toThrow(
      SyncRequestError,
    );
  });

  it("global does not read the project file", async () => {
    await writeFile(join(repo, "yoke.yaml"), "mode: nonsense\n", "utf8");
    await writeFile(join(userConfigDir, "yoke.yaml"), "version: 1\n", "utf8");
    const { fs, writes } = guardedFs();
    const result = await loadPass(fs, request({ global: true, scopes: ["user"] }), userConfigDir);
    expect(result.pass?.config.layers.project).toBeUndefined();
    expect(result.pass?.config.layers.user).toBeDefined();
    expect(writes).toEqual([]);
  });

  it("global with no user file returns no pass and a warning", async () => {
    const result = await loadPass(
      createNodeFs(),
      request({ global: true, scopes: ["user"] }),
      userConfigDir,
    );
    expect(result.pass).toBeUndefined();
    expect(result.warnings).toEqual([
      `no user config at ${join(userConfigDir, "yoke.yaml")}; nothing to sync for the user scope`,
    ]);
  });

  it("repo pass with no repo files throws SyncRequestError", async () => {
    await expect(loadPass(createNodeFs(), request(), userConfigDir)).rejects.toThrow(
      SyncRequestError,
    );
    await expect(loadPass(createNodeFs(), request(), userConfigDir)).rejects.toThrow(/yoke init/);
  });

  it("surfaces resolver warnings from the repo pass", async () => {
    await writeFile(
      join(repo, "yoke.local.yaml"),
      "version: 1\nmcps:\n  docs:\n    enabled: false\n",
      "utf8",
    );
    const result = await loadPass(createNodeFs(), request(), userConfigDir);
    expect(result.pass?.scopes).toEqual(["project", "local"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"enabled: false" in local scope');
  });

  it("selects harnesses in config order with both warnings", () => {
    const config = { harnesses: ["beta", "gamma", "alpha"] } as ResolvedYokeConfig;
    const factories = new Map<string, AdapterFactory>([
      ["alpha", fakeAdapterFactory({ name: "alpha" })],
      ["beta", fakeAdapterFactory({ name: "beta" })],
    ]);

    const all = selectHarnesses(config, undefined, factories);
    expect(all.names).toEqual(["beta", "alpha"]);
    expect(all.warnings).toEqual([
      'harness "gamma" has no adapter in this version of yoke; skipped',
    ]);

    const filtered = selectHarnesses(config, ["alpha", "gamma", "delta"], factories);
    expect(filtered.names).toEqual(["alpha"]);
    expect(filtered.warnings).toEqual([
      'harness "gamma" has no adapter in this version of yoke; skipped',
      'harness "delta" is not listed in harnesses; skipped',
    ]);
  });
});
