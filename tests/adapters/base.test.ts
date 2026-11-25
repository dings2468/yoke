import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advisoryPlan,
  definedNames,
  disabledNames,
  layerView,
  NativeStateError,
  readFileSnapshot,
  stubNames,
  toDefinition,
  toNativeInstructions,
} from "../../src/adapters/base.js";
import { createNodeFs } from "../../src/core/fs-safe.js";
import type { ResolvedMcpServer } from "../../src/core/schema.js";
import {
  cleanupSandbox,
  loadFixtureConfig,
  makeApplyContext,
  type Sandbox,
  setupAdapterSandbox,
} from "./helpers.js";

function must(
  record: Readonly<Record<string, ResolvedMcpServer>>,
  name: string,
): ResolvedMcpServer {
  const server = record[name];
  if (server === undefined) {
    throw new Error(`missing server in test fixture: ${name}`);
  }
  return server;
}

describe("contract helpers", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await setupAdapterSandbox();
  });

  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  describe("layerView", () => {
    it("returns the merged view of each layer alone", async () => {
      const config = await loadFixtureConfig(sb, {
        user: "user.yaml",
        project: "project.yaml",
        local: "local.yaml",
      });
      expect(Object.keys(layerView(config, "user"))).toEqual([
        "events",
        "github",
        "linear",
        "oauthy",
        "quiet",
        "tool",
      ]);
      // A project stub with nothing beneath it in the project layer is dropped by the merge.
      expect(Object.keys(layerView(config, "project"))).toEqual(["pg"]);
      expect(Object.keys(layerView(config, "local"))).toEqual(["pg", "scratch"]);
      expect(must(layerView(config, "local"), "pg")).toMatchObject({
        transport: "stdio",
        command: "pg",
        env: { PGHOST: "localhost" },
        enabled: true,
        scopes: ["local"],
      });
    });

    it("is empty when the layer is absent", async () => {
      const config = await loadFixtureConfig(sb, { user: "user.yaml" });
      expect(layerView(config, "local")).toEqual({});
    });
  });

  describe("definedNames and stubNames", () => {
    it("separates full definitions from stubs in project.yaml", async () => {
      const config = await loadFixtureConfig(sb, { project: "project.yaml" });
      expect(definedNames(config, "project")).toEqual(["pg"]);
      expect(stubNames(config, "project")).toEqual(["github"]);
    });
  });

  describe("disabledNames", () => {
    it("lists a project stub and a user enabled: false server", async () => {
      const config = await loadFixtureConfig(sb, { user: "user.yaml", project: "project.yaml" });
      expect(disabledNames(config)).toEqual(["github", "quiet"]);
    });

    it("adds a local stub that disables a project server", async () => {
      const config = await loadFixtureConfig(sb, {
        user: "user.yaml",
        project: "project.yaml",
        local: "local-stub-pg.yaml",
      });
      expect(disabledNames(config)).toEqual(["github", "pg", "quiet"]);
    });

    it("drops a name a local server re-enables", async () => {
      const config = await loadFixtureConfig(sb, {
        user: "user.yaml",
        project: "project.yaml",
        local: "local-reenable.yaml",
      });
      expect(disabledNames(config)).toEqual(["quiet"]);
    });

    it("lists a stub that the merge dropped because nothing lies beneath it", async () => {
      const config = await loadFixtureConfig(sb, { project: "project.yaml" });
      expect(config.mcps.github).toBeUndefined();
      expect(disabledNames(config)).toEqual(["github"]);
    });
  });

  describe("toDefinition", () => {
    it("drops scopes and keeps enabled only when false", async () => {
      const config = await loadFixtureConfig(sb, { user: "user.yaml" });
      expect(toDefinition(must(config.mcps, "github"))).toEqual({
        transport: "stdio",
        command: "gh",
        args: ["mcp"],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
        env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      });
      expect(toDefinition(must(config.mcps, "linear"))).toEqual({
        transport: "http",
        url: "https://mcp.linear.test/mcp",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
        headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
      });
      expect(toDefinition(must(config.mcps, "quiet"))).toEqual({
        transport: "stdio",
        command: "q",
        enabled: false,
      });
    });
  });

  describe("readFileSnapshot", () => {
    it("reports a missing path", async () => {
      await expect(readFileSnapshot(createNodeFs(), join(sb.repo, "nope.md"))).resolves.toEqual({
        kind: "missing",
      });
    });

    it("reads a regular file", async () => {
      const path = join(sb.repo, "AGENTS.md");
      await writeFile(path, "# rules\n", "utf8");
      await expect(readFileSnapshot(createNodeFs(), path)).resolves.toEqual({
        kind: "file",
        content: "# rules\n",
      });
    });

    it("reads a symlink as its target text without following it", async () => {
      const path = join(sb.repo, "CLAUDE.md");
      await symlink("AGENTS.md", path);
      await expect(readFileSnapshot(createNodeFs(), path)).resolves.toEqual({
        kind: "symlink",
        target: "AGENTS.md",
      });
    });

    it("throws NativeStateError for a directory", async () => {
      const path = join(sb.repo, "dir");
      await mkdir(path);
      const failure = readFileSnapshot(createNodeFs(), path);
      await expect(failure).rejects.toBeInstanceOf(NativeStateError);
      await expect(failure).rejects.toMatchObject({ name: "NativeStateError", path });
    });
  });

  describe("toNativeInstructions", () => {
    it("maps each snapshot kind", () => {
      const path = join(sb.repo, "AGENTS.md");
      expect(toNativeInstructions(path, { kind: "missing" })).toBeUndefined();
      expect(toNativeInstructions(path, { kind: "file", content: "x" })).toEqual({
        kind: "file",
        path,
        content: "x",
      });
      expect(toNativeInstructions(path, { kind: "symlink", target: "y" })).toEqual({
        kind: "symlink",
        path,
        target: "y",
      });
    });
  });

  describe("advisoryPlan", () => {
    it("is a noop with no before, after, or expected targets, and its apply does no I/O", async () => {
      const path = join(sb.repo, "AGENTS.local.md");
      const plan = advisoryPlan("local", path, "skip local servers", [
        "local servers are not supported",
      ]);
      expect(plan).toMatchObject({
        scope: "local",
        path,
        action: "noop",
        summary: "skip local servers",
        warnings: ["local servers are not supported"],
        expected: [],
      });
      expect(plan.before).toBeUndefined();
      expect(plan.after).toBeUndefined();

      await expect(plan.apply(makeApplyContext(sb))).resolves.toEqual({
        status: "unchanged",
        backupPath: undefined,
      });
      await expect(readFileSnapshot(createNodeFs(), path)).resolves.toEqual({ kind: "missing" });
    });
  });
});
