/**
 * tests/adapters/agy-mcp.test.ts: agy native state reader and MCP plan (AG2).
 * Fixtures are copied into a sandbox. Every path is injected. The real ~/.gemini is never touched.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGY_MCP_KEY, agyPaths, planAgyMcp, readAgyNativeState } from "../../src/adapters/agy.js";
import type { FileChangePlan } from "../../src/adapters/base.js";
import { READ_METHODS, type ReadFs } from "../../src/core/fs-safe.js";
import {
  getAtPath,
  isJsonObject,
  type JsonObject,
  parseJsonText,
} from "../../src/core/json-text.js";
import type { ResolvedYokeConfig, Scope, SyncOptions } from "../../src/core/schema.js";
import {
  cleanupSandbox,
  copyFixture,
  loadFixtureConfig,
  makeAdapterContext,
  makeApplyContext,
  type Sandbox,
  setupAdapterSandbox,
} from "./helpers.js";

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference copied verbatim from the fixture
const LINEAR_HEADER = "Bearer ${LINEAR_API_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} reference copied verbatim from the fixture
const LOCAL_ENV_REF = "${K}";

const NATIVE_FIXTURE = "agy/home/.gemini/config/mcp_config.json";

function syncOptions(sb: Sandbox, scopes: readonly Scope[]): SyncOptions {
  return { repoPath: sb.repo, scopes, warn: () => {} };
}

/** The `mcpServers` object of a file's text. Throws when the key is absent. */
function serversOf(text: string): JsonObject {
  const servers = getAtPath(parseJsonText(text), AGY_MCP_KEY);
  if (!isJsonObject(servers)) {
    throw new Error("mcpServers is not an object");
  }
  return servers;
}

function planFor(plans: readonly FileChangePlan[], scope: Scope): FileChangePlan {
  const plan = plans.find((p) => p.scope === scope);
  if (plan === undefined) {
    throw new Error(`no plan for scope ${scope}`);
  }
  return plan;
}

describe("agy native state and MCP plan", () => {
  let sb: Sandbox;
  let nativePath: string;

  beforeEach(async () => {
    sb = await setupAdapterSandbox();
    nativePath = join(sb.home, ".gemini", "config", "mcp_config.json");
    await copyFixture(sb, NATIVE_FIXTURE, nativePath);
  });

  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  it("paths are under the injected home", () => {
    expect(agyPaths(sb.home, sb.repo).mcpConfig).toBe(nativePath);
  });

  describe("readAgyNativeState", () => {
    it("reads managed user servers, skips opaque entries, and maps disabled to enabled", async () => {
      const state = await readAgyNativeState(makeAdapterContext(sb), sb.repo);

      const mcps = state.user?.mcps ?? {};
      expect(Object.keys(mcps).sort()).toEqual(["legacy", "local", "off", "remote", "tool"]);
      expect(mcps.remote).toEqual({ transport: "http", url: "https://a.test/mcp" });
      expect(mcps.legacy).toEqual({ transport: "http", url: "https://b.test/mcp" });
      expect(mcps.off).toEqual({ transport: "stdio", command: "x", enabled: false });
      expect(mcps.local).toEqual({
        transport: "stdio",
        command: "npx",
        args: ["-y", "s"],
        env: { K: LOCAL_ENV_REF },
      });
      expect(mcps.tool).toEqual({ transport: "stdio", command: "t" });
    });

    it("reports the project tier as read and empty, and has no local tier", async () => {
      const state = await readAgyNativeState(makeAdapterContext(sb), sb.repo);
      expect(state.project).toEqual({ mcps: {} });
      expect(state).not.toHaveProperty("local");
    });

    it("reads an empty state when the config file is absent", async () => {
      const empty = await setupAdapterSandbox();
      try {
        const state = await readAgyNativeState(makeAdapterContext(empty), empty.repo);
        expect(state.user).toEqual({ mcps: {} });
      } finally {
        await cleanupSandbox(empty);
      }
    });
  });

  describe("planAgyMcp, user scope", () => {
    it("drops unknown servers, keeps extras, adds disabled and url servers, and skips sse with warnings", async () => {
      const config = await loadFixtureConfig(sb, { user: "user.yaml" });
      const ctx = makeAdapterContext(sb);
      const plans = await planAgyMcp(ctx, config, syncOptions(sb, ["user"]));

      expect(plans).toHaveLength(1);
      const plan = planFor(plans, "user");
      expect(plan.path).toBe(nativePath);
      expect(plan.action).toBe("patch-json");

      expect(plan.warnings).toContain(
        'agy: MCP server "events" skipped: agy does not support SSE transport',
      );
      expect(plan.warnings.some((w) => w.startsWith('agy: MCP server "wsy" in '))).toBe(true);
      expect(plan.warnings.filter((w) => w.includes("references in env/headers"))).toHaveLength(2);
      expect(plan.warnings.some((w) => w.startsWith('agy: MCP server "github" uses '))).toBe(true);
      expect(plan.warnings.some((w) => w.startsWith('agy: MCP server "linear" uses '))).toBe(true);
      expect(plan.warnings.some((w) => w.includes('"tool"'))).toBe(false);

      const expectedNames = plan.expected.flatMap((t) =>
        t.kind === "mcps" ? Object.keys(t.mcps) : [],
      );
      expect(expectedNames.sort()).toEqual(["github", "linear", "oauthy", "quiet", "tool"]);

      const before = await readFile(nativePath, "utf8");
      await plan.apply(makeApplyContext(sb));
      const after = await readFile(nativePath, "utf8");
      expect(after).toBe(plan.after);

      const servers = serversOf(after);
      expect(Object.keys(servers).sort()).toEqual(
        ["github", "linear", "oauthy", "quiet", "tool", "wsy"].sort(),
      );
      expect(servers.remote).toBeUndefined();
      expect(servers.legacy).toBeUndefined();
      expect(servers.local).toBeUndefined();
      expect(servers.events).toBeUndefined();
      expect(servers.off).toBeUndefined();
      expect(servers.linear).toEqual({
        url: "https://mcp.linear.test/mcp",
        headers: { Authorization: LINEAR_HEADER },
      });
      expect(servers.tool).toEqual({ command: "t", trust: true, timeout: 5 });
      expect(servers.quiet).toEqual({ command: "q", disabled: true });
      expect(servers.wsy).toEqual({ type: "ws", url: "ws://w.test" });

      const root = parseJsonText(after);
      expect(getAtPath(root, ["$comment"])).toBe("keep me");
      expect(getAtPath(root, ["zeta"])).toBe(1);
      // Bytes after the mcpServers value are unchanged.
      expect(after.endsWith(before.slice(before.indexOf('  "zeta"')))).toBe(true);
    });

    it("plans without writing and matches the applied text (dry-run parity)", async () => {
      const config: ResolvedYokeConfig = await loadFixtureConfig(sb, { user: "user.yaml" });
      const real = makeAdapterContext(sb);
      const calls: string[] = [];
      const spy: ReadFs = {
        readFile: (p) => {
          calls.push("readFile");
          return real.fs.readFile(p);
        },
        lstat: (p) => {
          calls.push("lstat");
          return real.fs.lstat(p);
        },
        stat: (p) => {
          calls.push("stat");
          return real.fs.stat(p);
        },
        readlink: (p) => {
          calls.push("readlink");
          return real.fs.readlink(p);
        },
        realpath: (p) => {
          calls.push("realpath");
          return real.fs.realpath(p);
        },
      };

      const original = await readFile(nativePath, "utf8");
      const plans = await planAgyMcp({ ...real, fs: spy }, config, syncOptions(sb, ["user"]));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(READ_METHODS).toContain(call);
      }
      expect(await readFile(nativePath, "utf8")).toBe(original);

      const plan = planFor(plans, "user");
      expect(plan.after).not.toBe(original);
      await plan.apply(makeApplyContext(sb));
      expect(await readFile(nativePath, "utf8")).toBe(plan.after);
    });
  });

  describe("planAgyMcp, project and local scopes", () => {
    it("never writes project or local servers to the global file and only warns", async () => {
      const config = await loadFixtureConfig(sb, { project: "project.yaml", local: "local.yaml" });
      const plans = await planAgyMcp(
        makeAdapterContext(sb),
        config,
        syncOptions(sb, ["project", "local"]),
      );

      const original = await readFile(nativePath, "utf8");
      const warnings = plans.flatMap((p) => p.warnings);
      expect(warnings).toContain(
        'agy: MCP server "github" (project scope) skipped: agy has no project-level MCP config in v0.1; not written to the global file',
      );
      expect(warnings).toContain(
        'agy: MCP server "pg" (local scope) skipped: agy has no project-level MCP config in v0.1; not written to the global file',
      );
      expect(warnings).toContain(
        'agy: MCP server "scratch" (local scope) skipped: agy has no project-level MCP config in v0.1; not written to the global file',
      );

      for (const plan of plans) {
        expect(plan.path).toBe(nativePath);
        expect(plan.action).toBe("noop");
        await plan.apply(makeApplyContext(sb));
      }
      expect(await readFile(nativePath, "utf8")).toBe(original);
    });
  });
});
