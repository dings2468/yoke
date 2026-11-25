import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { type Scope, YokeConfigSchema } from "../src/core/schema.js";
import {
  resolveConfig,
  type ScopeInput,
  type ScopeInputs,
  stubWarning,
} from "../src/core/scopes.js";

const USER_DIR = resolve("/yoke-test/user");
const REPO_DIR = resolve("/yoke-test/repo");

/** Builds a `${NAME}` reference without writing the literal in a plain string (biome noTemplateCurlyInString). */
function envRef(name: string): string {
  return `$\{${name}}`;
}

function load(scope: Scope): ScopeInput {
  const url = new URL(`./fixtures/core/scopes/${scope}.yaml`, import.meta.url);
  const config = YokeConfigSchema.parse(parse(readFileSync(url, "utf8")));
  return { config, baseDir: scope === "user" ? USER_DIR : REPO_DIR };
}

describe("resolveConfig: scope merge rules", () => {
  it("resolves empty inputs to the defaults", () => {
    const warn = vi.fn();
    const result = resolveConfig({}, { projectDir: REPO_DIR, warn });
    expect(result).toEqual({
      version: 1,
      mode: "compiled",
      harnesses: [],
      mcps: {},
      session: { maxTurns: 40, includeGitDiffStat: true },
      layers: {},
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("disables an inherited user server with a stub and keeps its definition", () => {
    const warn = vi.fn();
    const result = resolveConfig(
      { user: load("user"), project: load("project") },
      { projectDir: REPO_DIR, warn },
    );
    expect(result.mcps.github).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "github-server"],
      env: { GITHUB_REGION: "us" },
      enabled: false,
      scopes: ["user", "project"],
    });
  });

  it("warns once per stub with no lower definition and produces no entry", () => {
    const warn = vi.fn();
    const result = resolveConfig({ project: load("project") }, { projectDir: REPO_DIR, warn });
    expect(warn.mock.calls).toEqual([
      [stubWarning("github", "project")],
      [stubWarning("ghost", "project")],
    ]);
    expect(stubWarning("ghost", "project")).toBe(
      'mcps.ghost: "enabled: false" in project scope has no lower-scope definition to suppress; ignored',
    );
    expect(result.mcps.ghost).toBeUndefined();
    expect(result.mcps.github).toBeUndefined();
  });

  it("replaces args and merges env for a same-transport override", () => {
    const warn = vi.fn();
    const result = resolveConfig(
      { user: load("user"), local: load("local") },
      { projectDir: REPO_DIR, warn },
    );
    expect(result.mcps.filesystem).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "fs-server", "/srv"],
      env: { LOG_LEVEL: "debug", ROOT: "/home/user" },
      enabled: true,
      scopes: ["user", "local"],
    });
  });

  it("replaces the whole entry on a transport change", () => {
    const warn = vi.fn();
    const result = resolveConfig(
      { user: load("user"), project: load("project") },
      { projectDir: REPO_DIR, warn },
    );
    expect(result.mcps.search).toEqual({
      transport: "http",
      url: `${envRef("SEARCH_HOST")}/mcp`,
      enabled: true,
      scopes: ["project"],
    });
  });

  it("keeps enabled false when a same-transport override omits enabled", () => {
    const warn = vi.fn();
    const result = resolveConfig(
      { user: load("user"), project: load("project"), local: load("local") },
      { projectDir: REPO_DIR, warn },
    );
    expect(result.mcps.github).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "github-server", "--read-only"],
      env: { GITHUB_REGION: "us", GITHUB_TOKEN: envRef("GITHUB_TOKEN") },
      enabled: false,
      scopes: ["user", "project", "local"],
    });
  });

  it("keeps env-var references verbatim", () => {
    const warn = vi.fn();
    const result = resolveConfig(
      { user: load("user"), project: load("project") },
      { projectDir: REPO_DIR, warn },
    );
    const linear = result.mcps.linear;
    expect(linear?.transport === "http" && linear.headers?.Authorization).toBe(
      `Bearer ${envRef("LINEAR_API_KEY")}`,
    );
    expect(result.mcps.search).toMatchObject({ url: `${envRef("SEARCH_HOST")}/mcp` });
  });

  it("sorts output keys by name", () => {
    const warn = vi.fn();
    const result = resolveConfig(
      { user: load("user"), project: load("project"), local: load("local") },
      { projectDir: REPO_DIR, warn },
    );
    expect(Object.keys(result.mcps)).toEqual(["filesystem", "github", "linear", "search"]);
  });

  it("does not alias the inputs, so mutating the result leaves the inputs unchanged", () => {
    const warn = vi.fn();
    const inputs: ScopeInputs = {
      user: load("user"),
      project: load("project"),
      local: load("local"),
    };
    const snapshot = structuredClone(inputs);
    const result = resolveConfig(inputs, { projectDir: REPO_DIR, warn });

    result.harnesses.push("mutated");
    const filesystem = result.mcps.filesystem;
    if (filesystem?.transport === "stdio") {
      filesystem.args?.push("mutated");
      filesystem.env = { LOG_LEVEL: "mutated" };
    }
    const linear = result.mcps.linear;
    if (linear?.transport === "http" && linear.headers) {
      linear.headers.Authorization = "mutated";
    }

    expect(inputs).toEqual(snapshot);
  });

  it("takes harnesses from the highest scope that sets them, including an empty list", () => {
    const warn = vi.fn();
    const userOnly = resolveConfig({ user: load("user") }, { projectDir: REPO_DIR, warn });
    expect(userOnly.harnesses).toEqual(["example-harness"]);

    const withLocal = resolveConfig(
      { user: load("user"), local: load("local") },
      { projectDir: REPO_DIR, warn },
    );
    expect(withLocal.harnesses).toEqual([]);
  });

  it("merges user and project mode and session values", () => {
    const warn = vi.fn();
    const result = resolveConfig(
      { user: load("user"), project: load("project") },
      { projectDir: REPO_DIR, warn },
    );
    expect(result.mode).toBe("hybrid");
    expect(result.session).toEqual({ maxTurns: 10, includeGitDiffStat: false });
  });

  it("keeps the per-scope inputs in layers", () => {
    const warn = vi.fn();
    const user = load("user");
    const result = resolveConfig(
      { user, project: load("project") },
      { projectDir: REPO_DIR, warn },
    );
    expect(result.layers.user).toEqual(user.config);
    expect(result.layers.project).toBeDefined();
    expect(result.layers).not.toHaveProperty("local");
  });

  it("rejects relative project and scope directories", () => {
    const warn = vi.fn();
    expect(() => resolveConfig({}, { projectDir: "relative/repo", warn })).toThrow(
      /projectDir must be an absolute path/,
    );
    expect(() =>
      resolveConfig(
        { user: { config: load("user").config, baseDir: "relative/user" } },
        { projectDir: REPO_DIR, warn },
      ),
    ).toThrow(/baseDir must be an absolute path/);
  });
});
