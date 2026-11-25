import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AdapterContext,
  type FileChangePlan,
  NativeStateError,
} from "../../src/adapters/base.js";
import {
  CLAUDE_CAPABILITIES,
  createClaudeAdapter,
  detectClaude,
  planClaudeDisables,
  planClaudeSync,
  readClaudeNativeState,
} from "../../src/adapters/claude.js";
import { diffScope, groupExpected, stateEntryFor } from "../../src/core/drift.js";
import { createNodeFs, type Fs, isNotFound } from "../../src/core/fs-safe.js";
import { GENERATED_HEADER } from "../../src/core/instructions.js";
import { parseJsonText } from "../../src/core/json-text.js";
import {
  type McpServerDefinition,
  type ResolvedYokeConfig,
  type StateKey,
  type SyncOptions,
  stateKey,
} from "../../src/core/schema.js";
import { loadScopeInputs, resolveConfig } from "../../src/core/scopes.js";
import {
  cleanupSandbox,
  copyFixture,
  fakeExec,
  loadFixtureConfig,
  lockFrom,
  makeAdapterContext,
  makeApplyContext,
  type Sandbox,
  setupAdapterSandbox,
} from "./helpers.js";

let sb: Sandbox;

beforeEach(async () => {
  sb = await setupAdapterSandbox();
});

afterEach(async () => {
  await cleanupSandbox(sb);
});

const userConfigPath = (): string => join(sb.home, ".claude.json");
const githubDef: McpServerDefinition = { transport: "stdio", command: "gh" };

function syncOpts(scopes: SyncOptions["scopes"]): SyncOptions {
  return { repoPath: sb.repo, scopes, warn: () => {} };
}

async function applyAll(plans: readonly FileChangePlan[]): Promise<void> {
  for (const plan of plans) {
    await plan.apply(makeApplyContext(sb));
  }
}

type JsonRecord = Record<string, unknown>;

async function readUserConfig(): Promise<JsonRecord> {
  return parseJsonText(await readFile(userConfigPath(), "utf8")) as JsonRecord;
}

function repoEntry(root: JsonRecord): JsonRecord {
  const projects = root.projects as Record<string, JsonRecord>;
  return projects[sb.repo] ?? {};
}

/** Writes an inline project stub or local layer, and loads all three scope files. */
async function inlineConfig(files: {
  user?: string;
  project?: string;
  local?: string;
}): Promise<ResolvedYokeConfig> {
  const paths = {
    user: join(sb.userConfigDir, "yoke.yaml"),
    project: join(sb.repo, "yoke.yaml"),
    local: join(sb.repo, "yoke.local.yaml"),
  };
  if (files.user !== undefined) {
    await writeFile(paths.user, files.user, "utf8");
  }
  if (files.project !== undefined) {
    await writeFile(paths.project, files.project, "utf8");
  }
  if (files.local !== undefined) {
    await writeFile(paths.local, files.local, "utf8");
  }
  const readText = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  };
  const inputs = await loadScopeInputs(readText, paths);
  return resolveConfig(inputs, { projectDir: sb.repo, warn: () => {} });
}

const USER_WITH_GITHUB = "version: 1\nmcps:\n  github:\n    transport: stdio\n    command: gh\n";
const PROJECT_STUB_GITHUB = "version: 1\nmcps:\n  github:\n    enabled: false\n";

describe("planClaudeSync: per-project disable of a user-scope server", () => {
  it("adds the name to projects[repo].disabledMcpServers and leaves every other key alone", async () => {
    await copyFixture(sb, "claude/home/.claude.json", userConfigPath());
    const before = await readUserConfig();
    const config = await inlineConfig({ user: USER_WITH_GITHUB, project: PROJECT_STUB_GITHUB });
    const ctx = makeAdapterContext(sb);

    const plans = await planClaudeSync(ctx, config, syncOpts(["user", "project", "local"]));
    expect(await readUserConfig()).toEqual(before);
    await applyAll(plans);

    const after = await readUserConfig();
    expect(repoEntry(after).disabledMcpServers).toEqual(["other", "github"]);
    expect(repoEntry(after).disabledMcpjsonServers).toEqual([]);
    expect(repoEntry(after).enabledMcpjsonServers).toEqual(["fs"]);

    const beforeRest = structuredClone(before) as JsonRecord;
    const afterRest = structuredClone(after) as JsonRecord;
    delete beforeRest.mcpServers;
    delete afterRest.mcpServers;
    for (const root of [beforeRest, afterRest]) {
      delete repoEntry(root).disabledMcpServers;
      delete repoEntry(root).mcpServers;
    }
    expect(afterRest).toEqual(beforeRest);
  });

  it("drops a lock-owned name once the stub is removed, and keeps the user's own entry", async () => {
    await copyFixture(sb, "claude/home/.claude.json", userConfigPath());
    const stubbed = await inlineConfig({ user: USER_WITH_GITHUB, project: PROJECT_STUB_GITHUB });
    const first = await planClaudeSync(
      makeAdapterContext(sb),
      stubbed,
      syncOpts(["user", "project", "local"]),
    );
    await applyAll(first);
    const lock = lockFrom({
      "claude:local": stateEntryFor(
        groupExpected(first.flatMap((plan) => plan.expected)).local ?? {},
      ),
    });

    const plainConfig = await inlineConfig({ user: USER_WITH_GITHUB, project: "version: 1\n" });
    const second = await planClaudeSync(
      makeAdapterContext(sb, { lock }),
      plainConfig,
      syncOpts(["user", "project", "local"]),
    );
    await applyAll(second);
    expect(repoEntry(await readUserConfig()).disabledMcpServers).toEqual(["other"]);
  });

  it("does not disable a name that a local layer re-enables", async () => {
    await copyFixture(sb, "claude/home/.claude.json", userConfigPath());
    const config = await inlineConfig({
      user: USER_WITH_GITHUB,
      project: PROJECT_STUB_GITHUB,
      local:
        "version: 1\nmcps:\n  github:\n    transport: stdio\n    command: gh\n    enabled: true\n",
    });
    await applyAll(
      await planClaudeSync(makeAdapterContext(sb), config, syncOpts(["user", "project", "local"])),
    );
    expect(repoEntry(await readUserConfig()).disabledMcpServers).toEqual(["other"]);
  });

  it("throws for a malformed list unless force is set", async () => {
    await copyFixture(sb, "claude/invalid/disabled-list.claude.json", userConfigPath());
    const config = await inlineConfig({ user: USER_WITH_GITHUB, project: PROJECT_STUB_GITHUB });
    await expect(
      planClaudeSync(makeAdapterContext(sb), config, syncOpts(["user", "project", "local"])),
    ).rejects.toBeInstanceOf(NativeStateError);
  });

  it("with force, keeps the lock's owned names, writes nothing, and warns for each wanted name", async () => {
    await copyFixture(sb, "claude/invalid/disabled-list.claude.json", userConfigPath());
    const before = await readFile(userConfigPath(), "utf8");
    const config = await inlineConfig({ user: USER_WITH_GITHUB, project: PROJECT_STUB_GITHUB });
    const lock = lockFrom({
      "claude:local": {
        mcpHashes: {},
        instructionsHash: null,
        ownedNames: { "disabled-servers": ["github"] },
      },
    });
    const ctx = makeAdapterContext(sb, { force: true, lock });
    const plans = await planClaudeDisables(ctx, config, syncOpts(["local"]), {
      user: { github: githubDef },
      project: {},
    });

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan?.action).toBe("noop");
    expect(plan?.warnings).toEqual([
      `claude: cannot disable "github" (local scope, yoke.local.yaml): it is still defined in Claude user config ${userConfigPath()} and will load in this repo; run /mcp disable github inside Claude in this repo (do not use "claude mcp remove", which deletes it everywhere and wipes its OAuth tokens)`,
    ]);
    expect(plan?.expected).toContainEqual({
      kind: "owned-names",
      scope: "local",
      list: "disabled-servers",
      names: ["github"],
    });
    await plan?.apply(makeApplyContext(sb));
    expect(await readFile(userConfigPath(), "utf8")).toBe(before);
  });
});

describe("planClaudeSync: round trip", () => {
  it("applies --all, reads back in sync, and re-plans as noop", async () => {
    await copyFixture(sb, "claude/home/.claude.json", userConfigPath());
    const config = await loadFixtureConfig(sb, {
      user: "user.yaml",
      project: "project.yaml",
      local: "local.yaml",
    });
    const opts = syncOpts(["user", "project", "local"]);
    const plans = await planClaudeSync(makeAdapterContext(sb), config, opts);
    await applyAll(plans);

    const groups = groupExpected(plans.flatMap((plan) => plan.expected));
    const lock = lockFrom(
      Object.fromEntries(
        (["user", "project", "local"] as const).map((scope) => [
          stateKey("claude", scope),
          stateEntryFor(groups[scope] ?? {}),
        ]),
      ),
    );
    const ctx = makeAdapterContext(sb, { lock });
    const native = await readClaudeNativeState(ctx, sb.repo);
    for (const scope of ["user", "project", "local"] as const) {
      const report = diffScope({
        key: stateKey("claude", scope) as StateKey,
        native: native[scope],
        lock: lock.harnesses[stateKey("claude", scope)],
        desired: groups[scope] ?? {},
      });
      expect(report.hasDrift).toBe(false);
      expect(report.mcps.every((entry) => entry.status === "in-sync")).toBe(true);
    }

    const replan = await planClaudeSync(ctx, config, opts);
    expect(replan.every((plan) => plan.action === "noop")).toBe(true);
  });
});

describe("planClaudeSync: instructions", () => {
  const projectClaudeMd = (): string => join(sb.repo, "CLAUDE.md");
  const userClaudeMd = (): string => join(sb.home, ".claude", "CLAUDE.md");

  it("links the user CLAUDE.md to the user AGENTS.md and writes no project file", async () => {
    await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.userConfigDir, "AGENTS.md"));
    await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.repo, "AGENTS.md"));
    const config = await inlineConfig({});
    const ctx = makeAdapterContext(sb, { symlinksSupported: true });
    const plans = await planClaudeSync(ctx, config, syncOpts(["user", "project", "local"]));

    const link = plans.find((plan) => plan.path === userClaudeMd());
    expect(link?.action).toBe("symlink");
    expect(link?.link?.after).toBe(
      relative(join(sb.home, ".claude"), join(sb.userConfigDir, "AGENTS.md")),
    );
    expect(plans.some((plan) => plan.path === projectClaudeMd() && plan.action !== "noop")).toBe(
      false,
    );

    await applyAll(plans);
    expect((await lstat(userClaudeMd())).isSymbolicLink()).toBe(true);
    expect(await readFile(userClaudeMd(), "utf8")).toContain("Use TypeScript strict mode.");
    expect(await exists(projectClaudeMd())).toBe(false);
  });

  it("warns about a user-written project CLAUDE.md that does not start with @AGENTS.md, and leaves it", async () => {
    await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.repo, "AGENTS.md"));
    await writeFile(projectClaudeMd(), "# Mine\n", "utf8");
    const plans = await planClaudeSync(
      makeAdapterContext(sb),
      await inlineConfig({}),
      syncOpts(["project"]),
    );

    const warnings = plans.flatMap((plan) => plan.warnings);
    expect(warnings).toContainEqual(
      `claude: ${projectClaudeMd()} does not start with the line @AGENTS.md, so Claude will not read the shared AGENTS.md; add it as the first line`,
    );
    await applyAll(plans);
    expect(await readFile(projectClaudeMd(), "utf8")).toBe("# Mine\n");
  });

  it("accepts a user-written project CLAUDE.md whose first non-blank line is @AGENTS.md", async () => {
    await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.repo, "AGENTS.md"));
    await writeFile(projectClaudeMd(), "\n@AGENTS.md\n\n# Claude notes\n", "utf8");
    const plans = await planClaudeSync(
      makeAdapterContext(sb),
      await inlineConfig({}),
      syncOpts(["project"]),
    );

    expect(plans.flatMap((plan) => plan.warnings)).toEqual([]);
    expect(plans.some((plan) => plan.action === "remove")).toBe(false);
  });

  it("removes a yoke-generated project CLAUDE.md with a backup and records no instructions hash", async () => {
    await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.repo, "AGENTS.md"));
    await writeFile(projectClaudeMd(), `${GENERATED_HEADER}\n\nold generated text\n`, "utf8");
    const plans = await planClaudeSync(
      makeAdapterContext(sb),
      await inlineConfig({}),
      syncOpts(["project"]),
    );
    const removal = plans.find((plan) => plan.path === projectClaudeMd());
    expect(removal?.action).toBe("remove");
    expect(removal?.expected).toContainEqual({
      kind: "instructions",
      scope: "project",
      instructions: null,
    });

    const result = await removal?.apply(makeApplyContext(sb));
    expect(result?.status).toBe("written");
    expect(result?.backupPath).toBeDefined();
    expect(await exists(projectClaudeMd())).toBe(false);
  });

  it("warns with line numbers when AGENTS.md still has legacy yoke tags", async () => {
    await writeFile(
      join(sb.repo, "AGENTS.md"),
      "# Shared\n\n<!-- yoke:claude-only -->\nTodo tools.\n<!-- /yoke:claude-only -->\n",
      "utf8",
    );
    const plans = await planClaudeSync(
      makeAdapterContext(sb),
      await inlineConfig({}),
      syncOpts(["project"]),
    );

    expect(plans.flatMap((plan) => plan.warnings)).toContainEqual(
      `claude: ${join(sb.repo, "AGENTS.md")} has legacy yoke:*-only tags on lines 3, 5; move claude-only text to CLAUDE.md, agy-only text to GEMINI.md`,
    );
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

describe("detectClaude", () => {
  it("reports the version from --version and authentication from the user config", async () => {
    await copyFixture(sb, "claude/home/.claude.json", userConfigPath());
    const exec = fakeExec(
      new Map([
        ["claude --version", { stdout: "2.1.331 (Claude Code)\n", stderr: "", exitCode: 0 }],
      ]),
    );
    const status = await detectClaude(makeAdapterContext(sb, { exec, env: {} }));
    expect(status).toEqual({ installed: true, authenticated: true, version: "2.1.331" });
    expect(exec.calls).toEqual(["claude --version"]);
  });

  it("reports not installed when the binary cannot be spawned", async () => {
    const exec = fakeExec(new Map([["claude --version", "ENOENT"]]));
    expect(await detectClaude(makeAdapterContext(sb, { exec }))).toEqual({
      installed: false,
      authenticated: false,
    });
  });

  it("treats an API key in the environment as authentication", async () => {
    await writeFile(userConfigPath(), "{}\n", "utf8");
    const exec = fakeExec(
      new Map([["claude --version", { stdout: "1.0.0", stderr: "", exitCode: 0 }]]),
    );
    const status = await detectClaude(
      makeAdapterContext(sb, { exec, env: { ANTHROPIC_API_KEY: "k" } }),
    );
    expect(status).toEqual({ installed: true, authenticated: true, version: "1.0.0" });
  });
});

describe("createClaudeAdapter", () => {
  it("declares the D11 capabilities and no session methods", () => {
    const adapter = createClaudeAdapter(makeAdapterContext(sb));
    expect(adapter.name).toBe("claude");
    expect(adapter.capabilities).toEqual(CLAUDE_CAPABILITIES);
    expect(adapter.exportLatestSession).toBeUndefined();
    expect(adapter.importAndLaunch).toBeUndefined();
  });

  it("never reaches a write method through the context fs during planning or detection", async () => {
    await copyFixture(sb, "claude/home/.claude.json", userConfigPath());
    const fs: Fs = createNodeFs();
    const writes = (
      ["writeFile", "rename", "mkdir", "copyFile", "symlink", "unlink", "chmod"] as const
    ).map((method) => vi.spyOn(fs, method));
    const config = await inlineConfig({ user: USER_WITH_GITHUB, project: PROJECT_STUB_GITHUB });
    const before = await readFile(userConfigPath(), "utf8");
    const ctx: AdapterContext = makeAdapterContext(sb, {
      fs,
      exec: fakeExec(new Map([["claude --version", { stdout: "1.0.0", stderr: "", exitCode: 0 }]])),
    });
    const adapter = createClaudeAdapter(ctx);

    const plans = await adapter.syncStatic(config, syncOpts(["user", "project", "local"]));
    expect(plans.length).toBeGreaterThan(0);
    await adapter.readNativeState(sb.repo);
    await adapter.detect();

    for (const spy of writes) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(await readFile(userConfigPath(), "utf8")).toBe(before);
  });
});
