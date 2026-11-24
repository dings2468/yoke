/**
 * tests/adapters/agy-sync.test.ts: agy sync plan, detect, and read-only factory (AG3).
 * Every path is injected into a sandbox. The real ~/.gemini and the real GEMINI.md locations are never touched.
 */
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGY_CAPABILITIES,
  AGY_NAME,
  agyPaths,
  createAgyAdapter,
  detectAgy,
  planAgySync,
} from "../../src/adapters/agy.js";
import type { FileChangePlan } from "../../src/adapters/base.js";
import { diffScope, groupExpected, stateEntryFor } from "../../src/core/drift.js";
import { createNodeFs } from "../../src/core/fs-safe.js";
import {
  getAtPath,
  isJsonObject,
  type JsonObject,
  parseJsonText,
} from "../../src/core/json-text.js";
import {
  HarnessNameSchema,
  type ResolvedYokeConfig,
  type SyncOptions,
  stateKey,
} from "../../src/core/schema.js";
import {
  cleanupSandbox,
  copyFixture,
  fakeExec,
  loadFixtureConfig,
  makeAdapterContext,
  makeApplyContext,
  type Sandbox,
  setupAdapterSandbox,
} from "./helpers.js";

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference copied verbatim from the fixture
const GITHUB_TOKEN_REF = "${GITHUB_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference copied verbatim from the fixture
const LINEAR_HEADER = "Bearer ${LINEAR_API_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text used to match warning messages
const VAR_WARNING = "uses ${VAR} references";

function syncOptions(sb: Sandbox, scopes: SyncOptions["scopes"]): SyncOptions {
  return { repoPath: sb.repo, scopes, warn: () => {} };
}

function serversOf(text: string): JsonObject {
  const servers = getAtPath(parseJsonText(text), ["mcpServers"]);
  if (!isJsonObject(servers)) {
    throw new Error("mcpServers is not an object");
  }
  return servers;
}

function planFor(
  plans: readonly FileChangePlan[],
  scope: string,
  pathEnd?: string,
): FileChangePlan {
  const plan = plans.find(
    (p) => p.scope === scope && (pathEnd === undefined || p.path.endsWith(pathEnd)),
  );
  if (plan === undefined) {
    throw new Error(`no plan for scope ${scope}`);
  }
  return plan;
}

async function applyAll(sb: Sandbox, plans: readonly FileChangePlan[]): Promise<void> {
  const ctx = makeApplyContext(sb);
  for (const plan of plans) {
    await plan.apply(ctx);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("agy sync plan", () => {
  let sb: Sandbox;
  let mcpConfig: string;
  let userGemini: string;
  let projectGemini: string;

  beforeEach(async () => {
    sb = await setupAdapterSandbox();
    const paths = agyPaths(sb.home, sb.repo);
    mcpConfig = paths.mcpConfig;
    userGemini = paths.userInstructions;
    projectGemini = paths.projectInstructions;
    await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.userConfigDir, "AGENTS.md"));
    await copyFixture(sb, "instructions/AGENTS.plain.md", join(sb.repo, "AGENTS.md"));
  });

  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  it("paths: GEMINI.md locations are under the injected home and repo", () => {
    expect(mcpConfig).toBe(join(sb.home, ".gemini", "config", "mcp_config.json"));
    expect(userGemini).toBe(join(sb.home, ".gemini", "GEMINI.md"));
    expect(projectGemini).toBe(join(sb.repo, "GEMINI.md"));
  });

  it("contract: name, capabilities, and no session methods", () => {
    const adapter = createAgyAdapter(makeAdapterContext(sb));
    expect(adapter.name).toBe(AGY_NAME);
    expect(HarnessNameSchema.safeParse(adapter.name).success).toBe(true);
    expect(adapter.capabilities).toEqual(AGY_CAPABILITIES);
    expect(AGY_CAPABILITIES).toEqual({
      staticMcp: true,
      staticInstructions: true,
      reverseRead: true,
      sessionExport: false,
      sessionImport: "handoff-file-only",
    });
    expect(adapter.exportLatestSession).toBeUndefined();
    expect(adapter.importAndLaunch).toBeUndefined();
  });

  it("user scope writes url for http, disabled for enabled:false, and skips sse with a warning", async () => {
    const config = await loadFixtureConfig(sb, { user: "user.yaml" });
    const plans = await planAgySync(makeAdapterContext(sb), config, syncOptions(sb, ["user"]));
    const mcp = planFor(plans, "user", "mcp_config.json");

    const servers = serversOf(mcp.after ?? "");
    expect(servers.linear).toEqual({
      url: "https://mcp.linear.test/mcp",
      headers: { Authorization: LINEAR_HEADER },
    });
    expect(servers.quiet).toEqual({ command: "q", disabled: true });
    expect(servers.tool).toEqual({ command: "t" });
    expect(Object.hasOwn(servers, "events")).toBe(false);
    expect(
      Object.values(servers).some(
        (entry) => isJsonObject(entry) && Object.hasOwn(entry, "serverUrl"),
      ),
    ).toBe(false);
    expect(mcp.warnings).toContain(
      'agy: MCP server "events" skipped: agy does not support SSE transport',
    );
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test title names the literal ${VAR} syntax
  it("keeps ${VAR} references literally with one warning per affected server", async () => {
    const config = await loadFixtureConfig(sb, { user: "user.yaml" });
    const plans = await planAgySync(makeAdapterContext(sb), config, syncOptions(sb, ["user"]));
    const mcp = planFor(plans, "user", "mcp_config.json");

    const servers = serversOf(mcp.after ?? "");
    expect(getAtPath(servers, ["github", "env", "GITHUB_TOKEN"])).toBe(GITHUB_TOKEN_REF);
    expect(getAtPath(servers, ["linear", "headers", "Authorization"])).toBe(LINEAR_HEADER);

    const varWarnings = mcp.warnings.filter((w) => w.includes(VAR_WARNING));
    expect(varWarnings).toHaveLength(2);
    expect(varWarnings.some((w) => w.includes('"github"'))).toBe(true);
    expect(varWarnings.some((w) => w.includes('"linear"'))).toBe(true);
  });

  it("project and local servers are never written to the global file", async () => {
    const config = await loadFixtureConfig(sb, { project: "project.yaml", local: "local.yaml" });
    const plans = await planAgySync(
      makeAdapterContext(sb),
      config,
      syncOptions(sb, ["project", "local"]),
    );

    expect(plans.some((p) => p.scope === "user")).toBe(false);
    const warnings = plans.flatMap((p) => p.warnings);
    expect(warnings.some((w) => w.includes('"pg" (project scope) skipped'))).toBe(true);
    expect(warnings.some((w) => w.includes('"scratch" (local scope) skipped'))).toBe(true);

    await applyAll(sb, plans);
    expect(await exists(mcpConfig)).toBe(false);
  });

  it("symlinks GEMINI.md to the plain user and project sources", async () => {
    const config = await loadFixtureConfig(sb, {});
    const plans = await planAgySync(
      makeAdapterContext(sb),
      config,
      syncOptions(sb, ["user", "project"]),
    );
    expect(planFor(plans, "user", "GEMINI.md").action).toBe("symlink");
    expect(planFor(plans, "project", "GEMINI.md").action).toBe("symlink");

    await applyAll(sb, plans);
    expect((await lstat(userGemini)).isSymbolicLink()).toBe(true);
    expect((await lstat(projectGemini)).isSymbolicLink()).toBe(true);
    expect(await readFile(userGemini, "utf8")).toContain("Use TypeScript strict mode.");
    expect(await readFile(projectGemini, "utf8")).toContain("Use TypeScript strict mode.");
  });

  it("compiles agy blocks only for a blocks source, without the claude-only text", async () => {
    await copyFixture(sb, "instructions/AGENTS.blocks.md", join(sb.repo, "AGENTS.md"));
    const config = await loadFixtureConfig(sb, { project: "project.yaml" });
    const plans = await planAgySync(makeAdapterContext(sb), config, syncOptions(sb, ["project"]));
    const instructions = planFor(plans, "project", "GEMINI.md");

    expect(instructions.action).toBe("create");
    expect(instructions.after).toContain("Antigravity-specific");
    expect(instructions.after).not.toContain("TodoWrite");
    expect(instructions.after).not.toContain("Claude-specific");
  });

  it("hybrid mode warns when a local instructions override exists and does not apply it", async () => {
    await writeFile(join(sb.repo, "AGENTS.local.md"), "Local only.\n", "utf8");
    const config = await loadFixtureConfig(sb, { project: "hybrid-project.yaml" });
    expect(config.mode).toBe("hybrid");
    const plans = await planAgySync(makeAdapterContext(sb), config, syncOptions(sb, ["project"]));
    const instructions = planFor(plans, "project", "GEMINI.md");

    expect(instructions.warnings).toContain(
      `agy: ${join(sb.repo, "AGENTS.local.md")} cannot be isolated in hybrid mode; not applied`,
    );
  });

  it("the plan is read-only: syncStatic writes nothing even with a writable fs", async () => {
    const writable = createNodeFs();
    const guarded = {
      ...writable,
      writeFile: (): never => {
        throw new Error("write attempted during planning");
      },
    };
    const adapter = createAgyAdapter({ ...makeAdapterContext(sb), fs: guarded });
    const config = await loadFixtureConfig(sb, { user: "user.yaml", project: "project.yaml" });
    const plans = await adapter.syncStatic(config, syncOptions(sb, ["user", "project", "local"]));

    expect(plans.length).toBeGreaterThan(0);
    expect(await exists(mcpConfig)).toBe(false);
    expect(await exists(userGemini)).toBe(false);
    expect(await exists(projectGemini)).toBe(false);
  });

  it("round trip: applied --all state reads back in sync and re-plans to noop", async () => {
    const config: ResolvedYokeConfig = await loadFixtureConfig(sb, {
      user: "user.yaml",
      project: "project.yaml",
      local: "local.yaml",
    });
    const adapter = createAgyAdapter(makeAdapterContext(sb));
    const opts = syncOptions(sb, ["user", "project", "local"]);
    const plans = await adapter.syncStatic(config, opts);
    await applyAll(sb, plans);

    const desired = groupExpected(plans.flatMap((p) => p.expected));
    const native = await adapter.readNativeState(sb.repo);
    for (const scope of ["user", "project"] as const) {
      const want = desired[scope] ?? {};
      const report = diffScope({
        key: stateKey(AGY_NAME, scope),
        native: native[scope],
        lock: stateEntryFor(want),
        desired: want,
      });
      expect(report.hasDrift).toBe(false);
    }

    const again = await adapter.syncStatic(config, opts);
    expect(again.every((p) => p.action === "noop")).toBe(true);
  });
});

describe("detectAgy", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await setupAdapterSandbox();
  });

  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  it("reports the version from agy --version and runs no other command", async () => {
    const exec = fakeExec(
      new Map([["agy --version", { stdout: "agy 1.5.16\n", stderr: "", exitCode: 0 }]]),
    );
    const status = await detectAgy(makeAdapterContext(sb, { exec }));
    expect(status).toEqual({ installed: true, authenticated: false, version: "1.5.16" });
    expect(exec.calls).toEqual(["agy --version"]);
  });

  it("reports not installed when the binary cannot be spawned", async () => {
    const exec = fakeExec(new Map([["agy --version", "ENOENT"]]));
    const status = await detectAgy(makeAdapterContext(sb, { exec }));
    expect(status).toEqual({ installed: false, authenticated: false });
  });

  it("reports not installed for a non-zero exit", async () => {
    const exec = fakeExec(
      new Map([["agy --version", { stdout: "", stderr: "boom", exitCode: 2 }]]),
    );
    const status = await detectAgy(makeAdapterContext(sb, { exec }));
    expect(status.installed).toBe(false);
  });
});
