import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeStateError } from "../../src/adapters/base.js";
import {
  DISABLED_SERVERS_LIST,
  planClaudeMcp,
  readClaudeNativeState,
} from "../../src/adapters/claude.js";
import { createNodeFs, isNotFound, toReadFs } from "../../src/core/fs-safe.js";
import { parseJsonText } from "../../src/core/json-text.js";
import type { ResolvedYokeConfig, SyncOptions } from "../../src/core/schema.js";
import { loadScopeInputs, resolveConfig } from "../../src/core/scopes.js";
import {
  ADAPTER_FIXTURES,
  cleanupSandbox,
  copyFixture,
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

function syncOpts(scopes: SyncOptions["scopes"]): SyncOptions {
  return { repoPath: sb.repo, scopes, warn: () => {} };
}

/** Writes inline YAML scope files and resolves them, mirroring loadFixtureConfig. */
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

async function fixtureText(from: string, to: string): Promise<string> {
  await copyFixture(sb, from, to);
  return readFile(to, "utf8");
}

const userConfigPath = (): string => join(sb.home, ".claude.json");

describe("planClaudeMcp: zero-clobber user patch", () => {
  it("changes only mcpServers byte-for-byte and keeps every other top-level key", async () => {
    const before = await fixtureText("claude/home/.claude.json", userConfigPath());
    const config = await loadFixtureConfig(sb, { user: "user.yaml" });
    const ctx = makeAdapterContext(sb);

    const plans = await planClaudeMcp(ctx, config, syncOpts(["user"]));
    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan?.action).toBe("patch-json");
    expect(plan?.warnings).toEqual([
      'claude: MCP server "wsy" in ' +
        userConfigPath() +
        ' has an unsupported transport (type "ws"); left unchanged and not managed by yoke',
    ]);

    const result = await plan?.apply(makeApplyContext(sb));
    const after = await readFile(userConfigPath(), "utf8");

    const start = before.indexOf('\n  "mcpServers": ');
    const end = before.indexOf('\n  "oauthAccount"');
    expect(start).toBeGreaterThan(0);
    expect(after.startsWith(before.slice(0, start))).toBe(true);
    expect(after.endsWith(before.slice(end))).toBe(true);

    const golden = await readFile(
      join(ADAPTER_FIXTURES, "claude/expected/user-patched.claude.json"),
      "utf8",
    );
    const escapedRepo = JSON.stringify(sb.repo).slice(1, -1);
    expect(parseJsonText(after)).toEqual(parseJsonText(golden.replaceAll("__REPO__", escapedRepo)));

    const beforeObject = parseJsonText(before) as Record<string, unknown>;
    const afterObject = parseJsonText(after) as Record<string, unknown>;
    expect(Object.keys(afterObject).sort()).toEqual(Object.keys(beforeObject).sort());
    for (const key of Object.keys(beforeObject)) {
      if (key !== "mcpServers") {
        expect(afterObject[key]).toEqual(beforeObject[key]);
      }
    }

    expect(result?.backupPath).toBeDefined();
    const backupText = await readFile(result?.backupPath ?? "", "utf8");
    expect(backupText).toBe(before);
  });

  it("keeps oauth and timeout on a same-transport rewrite, and writes Claude's entry shape", async () => {
    await fixtureText("claude/home/.claude.json", userConfigPath());
    const config = await loadFixtureConfig(sb, { user: "user.yaml" });
    const [plan] = await planClaudeMcp(makeAdapterContext(sb), config, syncOpts(["user"]));
    await plan?.apply(makeApplyContext(sb));

    const parsed = parseJsonText(await readFile(userConfigPath(), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.oauthy).toEqual({
      type: "http",
      url: "https://o.test/mcp",
      oauth: { clientId: "abc", callbackPort: 8123 },
      timeout: 5,
    });
    expect(parsed.mcpServers.wsy).toEqual({ type: "ws", url: "ws://w.test" });
    expect(parsed.mcpServers.old).toBeUndefined();
  });

  it("drops extras with a warning when the transport changes", async () => {
    await fixtureText("claude/home/.claude.json", userConfigPath());
    const config = await inlineConfig({
      user: "version: 1\nmcps:\n  oauthy:\n    transport: stdio\n    command: x\n",
    });
    const [plan] = await planClaudeMcp(makeAdapterContext(sb), config, syncOpts(["user"]));
    expect(plan?.warnings).toContain(
      `claude: MCP server "oauthy" in ${userConfigPath()}: dropped native keys oauth,timeout because the transport changed`,
    );
    await plan?.apply(makeApplyContext(sb));
    const parsed = parseJsonText(await readFile(userConfigPath(), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.oauthy).toEqual({ type: "stdio", command: "x" });
  });

  it("throws for a yoke-defined server with an unsupported transport, and --force replaces it", async () => {
    await fixtureText("claude/home/.claude.json", userConfigPath());
    const config = await inlineConfig({
      user: "version: 1\nmcps:\n  wsy:\n    transport: stdio\n    command: w\n",
    });
    await expect(
      planClaudeMcp(makeAdapterContext(sb), config, syncOpts(["user"])),
    ).rejects.toBeInstanceOf(NativeStateError);

    const [plan] = await planClaudeMcp(
      makeAdapterContext(sb, { force: true }),
      config,
      syncOpts(["user"]),
    );
    expect(plan?.warnings).toEqual([
      `claude: MCP server "wsy" in ${userConfigPath()} has an unsupported transport (type "ws"); replaced because --force was given`,
    ]);
    await plan?.apply(makeApplyContext(sb));
    const parsed = parseJsonText(await readFile(userConfigPath(), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.wsy).toEqual({ type: "stdio", command: "w" });
  });
});

describe("planClaudeMcp: compiled local tier (Q2)", () => {
  it("puts local servers in projects[repo].mcpServers and keeps project servers in .mcp.json", async () => {
    await fixtureText("claude/home/.claude.json", userConfigPath());
    const config = await loadFixtureConfig(sb, { project: "project.yaml", local: "local.yaml" });
    const plans = await planClaudeMcp(
      makeAdapterContext(sb),
      config,
      syncOpts(["project", "local"]),
    );
    expect(plans.map((plan) => plan.scope)).toEqual(["project", "local"]);
    for (const plan of plans) {
      await plan.apply(makeApplyContext(sb));
    }

    const mcpJson = parseJsonText(await readFile(join(sb.repo, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcpJson.mcpServers)).toEqual(["pg"]);
    expect(mcpJson.mcpServers.pg).toEqual({ type: "stdio", command: "pg" });

    const home = parseJsonText(await readFile(userConfigPath(), "utf8")) as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
      mcpServers?: unknown;
    };
    const repoEntry = home.projects[sb.repo];
    expect(repoEntry?.mcpServers.scratch).toEqual({ type: "stdio", command: "scratch" });
    expect(repoEntry?.mcpServers.pg).toEqual({
      type: "stdio",
      command: "pg",
      env: { PGHOST: "localhost" },
    });
    expect(home.projects["/other/repo"]).toEqual({
      mcpServers: { x: { type: "stdio", command: "x" } },
    });
    expect(home.mcpServers).toBeDefined();
  });

  it("omits a local stub from .mcp.json and leaves the native files untouched when nothing remains", async () => {
    const config = await loadFixtureConfig(sb, {
      project: "project.yaml",
      local: "local-stub-pg.yaml",
    });
    const plans = await planClaudeMcp(
      makeAdapterContext(sb),
      config,
      syncOpts(["project", "local"]),
    );
    expect(plans.map((plan) => plan.action)).toEqual(["noop", "noop"]);
    for (const plan of plans) {
      await plan.apply(makeApplyContext(sb));
    }
    await expect(readFile(join(sb.repo, ".mcp.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(userConfigPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("planClaudeMcp: values, dry-run parity", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${VAR} reference is the behaviour under test
  it("copies ${VAR} references verbatim, keeps sse type, and omits disabled servers", async () => {
    await fixtureText("claude/home/.claude.json", userConfigPath());
    const config = await loadFixtureConfig(sb, { user: "user.yaml" });
    const [plan] = await planClaudeMcp(makeAdapterContext(sb), config, syncOpts(["user"]));
    await plan?.apply(makeApplyContext(sb));
    const text = await readFile(userConfigPath(), "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference, must stay unexpanded
    expect(text).toContain('"Bearer ${LINEAR_API_KEY}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference, must stay unexpanded
    expect(text).toContain('"GITHUB_TOKEN": "${GITHUB_TOKEN}"');
    const parsed = parseJsonText(text) as { mcpServers: Record<string, { type?: string }> };
    expect(parsed.mcpServers.events).toEqual({ type: "sse", url: "https://events.test/sse" });
    expect(parsed.mcpServers.quiet).toBeUndefined();
  });

  it("plans identically twice and writes nothing when only planning", async () => {
    const before = await fixtureText("claude/home/.claude.json", userConfigPath());
    const config = await loadFixtureConfig(sb, { user: "user.yaml" });
    const ctx = makeAdapterContext(sb, { fs: toReadFs(createNodeFs()) });
    const first = await planClaudeMcp(ctx, config, syncOpts(["user"]));
    const second = await planClaudeMcp(ctx, config, syncOpts(["user"]));
    const strip = ({ apply: _apply, ...rest }: (typeof first)[number]) => rest;
    expect(first.map(strip)).toEqual(second.map(strip));
    expect(await readFile(userConfigPath(), "utf8")).toBe(before);
    expect(await readdir(sb.backupsRoot)).toEqual([]);
  });

  it("creates no file when there is nothing to write", async () => {
    const config = await inlineConfig({ user: "version: 1\nmcps: {}\n" });
    const plans = await planClaudeMcp(
      makeAdapterContext(sb),
      config,
      syncOpts(["user", "project", "local"]),
    );
    expect(plans.every((plan) => plan.action === "noop")).toBe(true);
    await expect(readFile(userConfigPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("readClaudeNativeState", () => {
  it("reads the user, project, and local tiers and skips opaque and extra keys", async () => {
    await fixtureText("claude/home/.claude.json", userConfigPath());
    await copyFixture(sb, "claude/repo/.mcp.json", join(sb.repo, ".mcp.json"));
    const claudeMd = await fixtureText("claude/repo/CLAUDE.md", join(sb.repo, "CLAUDE.md"));

    const state = await readClaudeNativeState(makeAdapterContext(sb), sb.repo);
    expect(Object.keys(state.user?.mcps ?? {})).toEqual(["old", "oauthy"]);
    expect(state.user?.mcps.old).toEqual({
      transport: "stdio",
      command: "old",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference, must stay unexpanded
      env: { TOKEN: "${OLD_TOKEN}" },
    });
    expect(state.user?.mcps.oauthy).toEqual({ transport: "http", url: "https://o.test/mcp" });
    expect(Object.keys(state.project?.mcps ?? {})).toEqual(["linear", "fs"]);
    expect(state.project?.mcps.fs).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    });
    expect(state.local?.mcps).toEqual({
      "native-local": { transport: "stdio", command: "nl" },
    });
    expect(state.project?.instructions).toEqual({
      kind: "file",
      path: join(sb.repo, "CLAUDE.md"),
      content: claudeMd,
    });
    expect(state.local?.instructions).toBeUndefined();
  });

  it("reports empty tiers when the user config is missing", async () => {
    const state = await readClaudeNativeState(makeAdapterContext(sb), sb.repo);
    expect(state.user?.mcps).toEqual({});
    expect(state.local?.mcps).toEqual({});
    expect(state.project?.mcps).toEqual({});
  });

  it("marks a lock-owned disable as enabled false only when a lower definition exists", async () => {
    await fixtureText("claude/home/.claude.json", userConfigPath());
    const lock = lockFrom({
      "claude:local": {
        mcpHashes: {},
        instructionsHash: null,
        ownedNames: { [DISABLED_SERVERS_LIST]: ["other"] },
      },
    });

    // The fixture's disabledMcpServers lists "other", but no tier defines it.
    const withoutLower = await readClaudeNativeState(makeAdapterContext(sb, { lock }), sb.repo);
    expect(withoutLower.local?.mcps.other).toBeUndefined();

    // A user-tier definition of "other" makes the owned disable visible in the local tier.
    const home = parseJsonText(await readFile(userConfigPath(), "utf8")) as Record<
      string,
      unknown
    > & { mcpServers: Record<string, unknown> };
    home.mcpServers.other = { type: "stdio", command: "o" };
    await writeFile(userConfigPath(), `${JSON.stringify(home, null, 2)}\n`, "utf8");

    const withLower = await readClaudeNativeState(makeAdapterContext(sb, { lock }), sb.repo);
    expect(withLower.local?.mcps.other).toEqual({
      transport: "stdio",
      command: "o",
      enabled: false,
    });
  });

  it("ignores a lock-owned name that the native list does not contain", async () => {
    await fixtureText("claude/home/.claude.json", userConfigPath());
    const lock = lockFrom({
      "claude:local": {
        mcpHashes: {},
        instructionsHash: null,
        ownedNames: { [DISABLED_SERVERS_LIST]: ["gone"] },
      },
    });
    const state = await readClaudeNativeState(makeAdapterContext(sb, { lock }), sb.repo);
    expect(state.local?.mcps.gone).toBeUndefined();
  });
});
