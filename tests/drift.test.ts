import { describe, expect, it } from "vitest";
import {
  classifyEntry,
  type DesiredScopeState,
  detectDrift,
  diffScope,
  type EntryStatus,
  groupExpected,
  hashInstructions,
  hashMcp,
  stateEntryFor,
} from "../src/core/drift.js";
import {
  type McpServerDefinition,
  type NativeInstructions,
  type StateEntry,
  StateEntrySchema,
  stateKey,
} from "../src/core/schema.js";

const oldGithub: McpServerDefinition = { transport: "stdio", command: "npx", args: ["gh-v1"] };
const newGithub: McpServerDefinition = { transport: "stdio", command: "npx", args: ["gh-v2"] };
const postgres: McpServerDefinition = { transport: "stdio", command: "pg" };
const fileA: NativeInstructions = { kind: "file", path: "/repo/AGENTS.md", content: "one" };
const fileB: NativeInstructions = { kind: "file", path: "/repo/AGENTS.md", content: "two" };
const symlink: NativeInstructions = {
  kind: "symlink",
  path: "/repo/CLAUDE.md",
  target: "AGENTS.md",
};

const key = stateKey("example-harness", "project");

function lockWith(desired: DesiredScopeState): StateEntry {
  return stateEntryFor(desired);
}

describe("classifyEntry (D5 order)", () => {
  const cases: [string, Parameters<typeof classifyEntry>[0], EntryStatus][] = [
    ["native equals desired", { native: "a", desired: "a" }, "in-sync"],
    ["native and lock absent", { desired: "b" }, "create"],
    ["native equals lock, desired changed", { native: "a", lock: "a", desired: "b" }, "stale"],
    ["native deleted, lock present", { lock: "a", desired: "a" }, "removed"],
    ["native present, lock absent", { native: "a", desired: "b" }, "added"],
    ["native differs from lock and desired", { native: "a", lock: "b", desired: "c" }, "modified"],
  ];
  it.each(cases)("%s -> %s", (_label, input, expected) => {
    expect(classifyEntry(input)).toBe(expected);
  });
});

describe("groupExpected", () => {
  it("merges several mcps targets of one scope", () => {
    const groups = groupExpected([
      { kind: "mcps", scope: "project", mcps: { github: oldGithub } },
      { kind: "mcps", scope: "project", mcps: { postgres } },
      { kind: "mcps", scope: "local", mcps: {} },
    ]);
    expect(Object.keys(groups.project?.mcps ?? {}).sort()).toEqual(["github", "postgres"]);
    expect(groups.local?.mcps).toEqual({});
    expect(groups.user).toBeUndefined();
  });

  it("keeps instructions and owned-names per scope", () => {
    const groups = groupExpected([
      { kind: "instructions", scope: "local", instructions: fileA },
      { kind: "owned-names", scope: "local", list: "disabled-servers", names: ["github"] },
    ]);
    expect(groups.local?.instructions).toEqual(fileA);
    expect(groups.local?.ownedNames).toEqual({ "disabled-servers": ["github"] });
    expect(groups.local?.mcps).toBeUndefined();
  });

  it("throws on a duplicate MCP server name in one scope", () => {
    expect(() =>
      groupExpected([
        { kind: "mcps", scope: "project", mcps: { github: oldGithub } },
        { kind: "mcps", scope: "project", mcps: { github: newGithub } },
      ]),
    ).toThrow("duplicate MCP server github in project scope");
  });

  it("throws on a second instructions target in one scope", () => {
    expect(() =>
      groupExpected([
        { kind: "instructions", scope: "user", instructions: fileA },
        { kind: "instructions", scope: "user", instructions: fileB },
      ]),
    ).toThrow("duplicate instructions target in user scope");
  });

  it("throws on a repeated owned-names list in one scope", () => {
    expect(() =>
      groupExpected([
        { kind: "owned-names", scope: "local", list: "disabled-servers", names: ["a"] },
        { kind: "owned-names", scope: "local", list: "disabled-servers", names: ["b"] },
      ]),
    ).toThrow("duplicate owned-names list disabled-servers in local scope");
  });
});

describe("stateEntryFor", () => {
  it("hashes MCPs and instructions, with no ownedNames when every list is empty", () => {
    const entry = stateEntryFor({
      mcps: { github: oldGithub },
      instructions: fileA,
      ownedNames: { "disabled-servers": [] },
    });
    expect(entry.mcpHashes).toEqual({ github: hashMcp(oldGithub) });
    expect(entry.instructionsHash).toBe(hashInstructions(fileA));
    expect(entry).not.toHaveProperty("ownedNames");
    expect(StateEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("writes null instructionsHash and empty mcpHashes when those are not managed", () => {
    const entry = stateEntryFor({});
    expect(entry).toEqual({ mcpHashes: {}, instructionsHash: null });
  });

  it("includes non-empty owned lists with sorted names", () => {
    const entry = stateEntryFor({
      mcps: {},
      ownedNames: { "disabled-servers": ["zeta", "alpha"], "disabled-mcpjson": [] },
    });
    expect(entry.ownedNames).toEqual({ "disabled-servers": ["alpha", "zeta"] });
    expect(StateEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe("diffScope", () => {
  it("reports an unknown native server as added on the first sync", () => {
    const report = diffScope({
      key,
      native: { mcps: { other: postgres } },
      lock: undefined,
      desired: { mcps: {} },
    });
    expect(report.mcps).toEqual([
      { name: "other", status: "added", native: postgres, desired: undefined },
    ]);
    expect(report.hasDrift).toBe(true);
  });

  it("reports native equal to desired without a lock as in-sync", () => {
    const report = diffScope({
      key,
      native: { mcps: { github: oldGithub } },
      lock: undefined,
      desired: { mcps: { github: oldGithub } },
    });
    expect(report.mcps.map((entry) => entry.status)).toEqual(["in-sync"]);
    expect(report.hasDrift).toBe(false);
  });

  it("reports a yoke-side change over the last sync as stale, which is not drift", () => {
    const lock = lockWith({ mcps: { github: oldGithub } });
    const report = diffScope({
      key,
      native: { mcps: { github: oldGithub } },
      lock,
      desired: { mcps: { github: newGithub } },
    });
    expect(report.mcps.map((entry) => entry.status)).toEqual(["stale"]);
    expect(report.hasDrift).toBe(false);
  });

  it("reports a server deleted natively as removed", () => {
    const lock = lockWith({ mcps: { github: oldGithub } });
    const report = diffScope({
      key,
      native: { mcps: {} },
      lock,
      desired: { mcps: { github: oldGithub } },
    });
    expect(report.mcps.map((entry) => entry.status)).toEqual(["removed"]);
    expect(report.hasDrift).toBe(true);
  });

  it("reports a native edit that matches neither lock nor desired as modified", () => {
    const lock = lockWith({ mcps: { github: oldGithub } });
    const report = diffScope({
      key,
      native: { mcps: { github: postgres } },
      lock,
      desired: { mcps: { github: newGithub } },
    });
    expect(report.mcps.map((entry) => entry.status)).toEqual(["modified"]);
    expect(report.hasDrift).toBe(true);
  });

  it("reports a missing server with no lock or native entry as create", () => {
    const report = diffScope({
      key,
      native: undefined,
      lock: undefined,
      desired: { mcps: { github: oldGithub } },
    });
    expect(report.mcps.map((entry) => entry.status)).toEqual(["create"]);
    expect(report.hasDrift).toBe(false);
  });

  it("returns no MCP entries when desired.mcps is undefined", () => {
    const report = diffScope({
      key,
      native: { mcps: { other: postgres } },
      lock: lockWith({ mcps: { github: oldGithub } }),
      desired: {},
    });
    expect(report.mcps).toEqual([]);
    expect(report.hasDrift).toBe(false);
  });

  it("keeps a symlink in-sync when only the linked file changed", () => {
    const lock = lockWith({ instructions: symlink });
    const report = diffScope({
      key,
      native: { mcps: {}, instructions: symlink },
      lock,
      desired: { instructions: symlink },
    });
    expect(report.instructions?.status).toBe("in-sync");
    expect(report.hasDrift).toBe(false);
  });

  it("reports a symlink replaced by a file as modified", () => {
    const lock = lockWith({ instructions: symlink });
    const report = diffScope({
      key,
      native: { mcps: {}, instructions: fileA },
      lock,
      desired: { instructions: symlink },
    });
    expect(report.instructions?.status).toBe("modified");
    expect(report.hasDrift).toBe(true);
  });

  it("treats a null lock instructionsHash as absent", () => {
    const report = diffScope({
      key,
      native: { mcps: {}, instructions: fileA },
      lock: { mcpHashes: {}, instructionsHash: null },
      desired: { instructions: fileA },
    });
    expect(report.instructions?.status).toBe("in-sync");
  });

  it("leaves instructions out when desired.instructions is undefined", () => {
    const report = diffScope({
      key,
      native: { mcps: {}, instructions: fileB },
      lock: undefined,
      desired: {},
    });
    expect(report.instructions).toBeUndefined();
  });

  it("never compares ownedNames", () => {
    const report = diffScope({
      key,
      native: { mcps: {} },
      lock: { mcpHashes: {}, instructionsHash: null, ownedNames: { "disabled-servers": ["x"] } },
      desired: { mcps: {}, ownedNames: { "disabled-servers": [] } },
    });
    expect(report.mcps).toEqual([]);
    expect(report.hasDrift).toBe(false);
  });
});

describe("detectDrift", () => {
  it("is clean when every scope is clean and dirty when any scope is dirty", () => {
    const cleanInput = {
      key: stateKey("example-harness", "user"),
      native: { mcps: { github: oldGithub } },
      lock: undefined,
      desired: { mcps: { github: oldGithub } },
    };
    const dirtyInput = {
      key,
      native: { mcps: { other: postgres } },
      lock: undefined,
      desired: { mcps: {} },
    };
    expect(detectDrift([cleanInput]).hasDrift).toBe(false);
    const report = detectDrift([cleanInput, dirtyInput]);
    expect(report.hasDrift).toBe(true);
    expect(report.scopes.map((scope) => scope.key)).toEqual([cleanInput.key, dirtyInput.key]);
  });
});
