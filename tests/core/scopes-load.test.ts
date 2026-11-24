import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  defaultScopePaths,
  loadScopeInputs,
  parseScopeConfig,
  type ReadText,
  resolveConfig,
  ScopeConfigError,
  type ScopePaths,
  userConfigDir,
} from "../../src/core/scopes.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/core/scopes-load/", import.meta.url));
const USER_YAML = resolve("/yoke-test/user/yoke.yaml");
const PROJECT_YAML = resolve("/yoke-test/repo/yoke.yaml");
const LOCAL_YAML = resolve("/yoke-test/repo/yoke.local.yaml");
const REPO_DIR = resolve("/yoke-test/repo");

const PATHS: ScopePaths = { user: USER_YAML, project: PROJECT_YAML, local: LOCAL_YAML };

/** In-memory reader. Contents come from repo fixtures, so no real file outside the repo is ever touched. */
async function fixtureReader(files: Readonly<Record<string, string>>): Promise<ReadText> {
  const map = new Map<string, string>();
  for (const [path, fixture] of Object.entries(files)) {
    map.set(path, await readFile(`${FIXTURES}${fixture}`, "utf8"));
  }
  return async (path) => map.get(path);
}

describe("userConfigDir", () => {
  it("uses an absolute XDG_CONFIG_HOME", () => {
    expect(userConfigDir({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/yoke");
  });

  it("ignores a relative XDG_CONFIG_HOME", () => {
    expect(userConfigDir({ XDG_CONFIG_HOME: "rel" }, "/h")).toBe("/h/.config/yoke");
  });

  it("falls back to <home>/.config when unset", () => {
    expect(userConfigDir({}, "/h")).toBe("/h/.config/yoke");
  });
});

describe("defaultScopePaths", () => {
  it("omits user when no user config dir is given", () => {
    expect(defaultScopePaths({ repoRoot: "/r" })).toEqual({
      project: "/r/yoke.yaml",
      local: "/r/yoke.local.yaml",
    });
  });

  it("includes user when a user config dir is given", () => {
    expect(defaultScopePaths({ repoRoot: "/r", userConfigDir: "/u" })).toEqual({
      user: "/u/yoke.yaml",
      project: "/r/yoke.yaml",
      local: "/r/yoke.local.yaml",
    });
  });

  it("rejects a relative repo root", () => {
    expect(() => defaultScopePaths({ repoRoot: "repo" })).toThrow(/absolute/);
  });
});

describe("parseScopeConfig", () => {
  it("throws ScopeConfigError with scope and path for an empty file", () => {
    const err = captureError(() => parseScopeConfig("", "project", PROJECT_YAML));
    expect(err).toBeInstanceOf(ScopeConfigError);
    expect(err).toMatchObject({ scope: "project", path: PROJECT_YAML });
    expect(err.message).toBe(`${PROJECT_YAML}: file is empty; expected at least "version: 1"`);
  });

  it("throws ScopeConfigError for a comment-only file", () => {
    expect(() => parseScopeConfig("# nothing here\n", "user", USER_YAML)).toThrow(ScopeConfigError);
  });

  it("throws ScopeConfigError with the YAML error as cause for a duplicate key", async () => {
    const text = await readFile(`${FIXTURES}duplicate-key.yaml`, "utf8");
    const err = captureError(() => parseScopeConfig(text, "local", LOCAL_YAML));
    expect(err).toBeInstanceOf(ScopeConfigError);
    expect(err).toMatchObject({ scope: "local", path: LOCAL_YAML });
    expect(err.cause).toBeDefined();
  });

  it("names the path and the unknown key for an unknown top-level key", async () => {
    const text = await readFile(`${FIXTURES}unknown-key.yaml`, "utf8");
    const err = captureError(() => parseScopeConfig(text, "project", PROJECT_YAML));
    expect(err).toBeInstanceOf(ScopeConfigError);
    expect(err.message.startsWith(`${PROJECT_YAML}: `)).toBe(true);
    expect(err.message).toContain("mcpServers");
  });

  it("throws ScopeConfigError for a null env value", async () => {
    const text = await readFile(`${FIXTURES}null-env.yaml`, "utf8");
    const err = captureError(() => parseScopeConfig(text, "user", USER_YAML));
    expect(err).toBeInstanceOf(ScopeConfigError);
    expect(err).toMatchObject({ scope: "user", path: USER_YAML });
    expect(err.message).toContain(`${USER_YAML}: mcps.search.env.KEY:`);
  });
});

describe("loadScopeInputs", () => {
  it("loads all three scopes with correct baseDirs and feeds resolveConfig end to end", async () => {
    const read = await fixtureReader({
      [USER_YAML]: "user.yaml",
      [PROJECT_YAML]: "project.yaml",
      [LOCAL_YAML]: "local.yaml",
    });
    const inputs = await loadScopeInputs(read, PATHS);

    expect(inputs.user?.baseDir).toBe(resolve("/yoke-test/user"));
    expect(inputs.project?.baseDir).toBe(REPO_DIR);
    expect(inputs.local?.baseDir).toBe(REPO_DIR);

    const warn = vi.fn();
    const resolved = resolveConfig(inputs, { projectDir: REPO_DIR, warn });
    expect(warn).not.toHaveBeenCalled();
    expect(resolved.mode).toBe("hybrid");
    expect(resolved.instructions.source).toBe(resolve(REPO_DIR, "docs/AGENTS.md"));
    // project switches search to http, then local switches it back to stdio: a transport change
    // replaces the whole entry, so only the local scope remains.
    expect(resolved.mcps.search).toEqual({
      transport: "stdio",
      command: "npx",
      env: { LOG_LEVEL: "debug" },
      enabled: true,
      scopes: ["local"],
    });
  });

  it("omits a missing local file", async () => {
    const read = await fixtureReader({
      [USER_YAML]: "user.yaml",
      [PROJECT_YAML]: "project.yaml",
    });
    const inputs = await loadScopeInputs(read, PATHS);
    expect(inputs.user).toBeDefined();
    expect(inputs.project).toBeDefined();
    expect(inputs.local).toBeUndefined();
  });

  it("omits user when paths.user is not given", async () => {
    const read = await fixtureReader({ [PROJECT_YAML]: "project.yaml" });
    const inputs = await loadScopeInputs(read, { project: PROJECT_YAML, local: LOCAL_YAML });
    expect(inputs.user).toBeUndefined();
    expect(inputs.project).toBeDefined();
  });

  it("propagates ScopeConfigError with scope and path set", async () => {
    const read = await fixtureReader({ [PROJECT_YAML]: "empty.yaml" });
    const err = await loadScopeInputs(read, { project: PROJECT_YAML, local: LOCAL_YAML }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ScopeConfigError);
    expect(err).toMatchObject({ scope: "project", path: PROJECT_YAML });
  });

  it("throws for a non-absolute path before reading anything", async () => {
    const read = vi.fn<ReadText>(async () => undefined);
    await expect(
      loadScopeInputs(read, { project: "yoke.yaml", local: LOCAL_YAML }),
    ).rejects.toThrow(/absolute/);
    expect(read).not.toHaveBeenCalled();
  });
});

function captureError(fn: () => unknown): ScopeConfigError {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof ScopeConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected ScopeConfigError");
}
