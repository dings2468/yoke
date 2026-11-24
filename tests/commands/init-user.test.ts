import { describe, expect, it } from "vitest";
import { buildInitDraft } from "../../src/commands/init-convert.js";
import type { HarnessImport, ImportSelection } from "../../src/commands/init-types.js";
import { InitError } from "../../src/commands/init-types.js";
import { mergeUserConfig } from "../../src/commands/init-user.js";
import type { McpServerDefinition } from "../../src/core/schema.js";
import { parseScopeConfig } from "../../src/core/scopes.js";

const PATH = "/home/user/.config/yoke/yoke.yaml";
const SECRET = `sk-${"b".repeat(24)}`;

const ALPHA: McpServerDefinition = { transport: "stdio", command: "alpha", args: ["--x"] };
const OTHER: McpServerDefinition = { transport: "stdio", command: "other" };

function draft(
  mcps: Record<string, McpServerDefinition>,
  harnesses: readonly string[] = ["alpha"],
): { readonly mcps: Record<string, McpServerDefinition>; readonly harnesses: readonly string[] } {
  return { mcps, harnesses };
}

function harness(name: string, user: Record<string, McpServerDefinition>): HarnessImport {
  return {
    harness: name,
    project: {},
    local: {},
    user,
    instructions: undefined,
  };
}

function selection(harnesses: HarnessImport[]): ImportSelection {
  return { harnesses, instructions: undefined };
}

const EXISTING = `# My user-level yoke config
version: 1 # pinned
mode: hybrid
harnesses: [beta]
mcps:
  # keep this one as it is
  existing:
    transport: stdio
    command: old
`;

describe("mergeUserConfig: new file", () => {
  it("renders version, harnesses, and mcps", () => {
    const result = mergeUserConfig(undefined, draft({ alpha: ALPHA }), PATH);
    expect(result.content).toBeDefined();
    const config = parseScopeConfig(result.content ?? "", "user", PATH);
    expect(config.version).toBe(1);
    expect(config.harnesses).toEqual(["alpha"]);
    expect(config.mcps).toEqual({ alpha: ALPHA });
    expect(result.added).toEqual(["alpha"]);
    expect(result.kept).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("writes nothing when there are no servers", () => {
    const result = mergeUserConfig(undefined, draft({}, []), PATH);
    expect(result.content).toBeUndefined();
    expect(result.added).toEqual([]);
  });
});

describe("mergeUserConfig: existing file", () => {
  it("keeps every original line byte-for-byte and appends the new server", () => {
    const result = mergeUserConfig({ text: EXISTING, path: PATH }, draft({ alpha: ALPHA }), PATH);
    expect(result.content).toBeDefined();
    const output = result.content ?? "";
    expect(output.startsWith(EXISTING)).toBe(true);
    expect(output).toContain("# keep this one as it is");
    expect(output).toContain("mode: hybrid");
    expect(output).toContain("harnesses: [beta]");
    const config = parseScopeConfig(output, "user", PATH);
    expect(config.mcps?.alpha).toEqual(ALPHA);
    expect(config.mcps?.existing).toEqual({ transport: "stdio", command: "old" });
    expect(result.added).toEqual(["alpha"]);
  });

  it("keeps an equal entry and reports nothing to write", () => {
    const text = `version: 1\nmcps:\n  alpha:\n    transport: stdio\n    command: alpha\n    args: [--x]\n`;
    const result = mergeUserConfig({ text, path: PATH }, draft({ alpha: ALPHA }), PATH);
    expect(result.kept).toEqual(["alpha"]);
    expect(result.added).toEqual([]);
    expect(result.content).toBeUndefined();
  });

  it("reports a different definition as a conflict and keeps the existing one", () => {
    const result = mergeUserConfig(
      { text: EXISTING, path: PATH },
      draft({ existing: ALPHA }),
      PATH,
    );
    expect(result.conflicts).toEqual([
      `user server "existing" already in ${PATH} with a different definition; kept the existing one`,
    ]);
    expect(result.content).toBeUndefined();
  });

  it("reports a disabled stub as a conflict", () => {
    const text = "version: 1\nmcps:\n  alpha:\n    enabled: false\n";
    const result = mergeUserConfig({ text, path: PATH }, draft({ alpha: ALPHA }), PATH);
    expect(result.conflicts).toHaveLength(1);
    expect(result.added).toEqual([]);
    expect(result.content).toBeUndefined();
  });

  it("adds harnesses when the key is absent", () => {
    const text = "version: 1\nmode: compiled\n";
    const result = mergeUserConfig({ text, path: PATH }, draft({ alpha: ALPHA }), PATH);
    const config = parseScopeConfig(result.content ?? "", "user", PATH);
    expect(config.harnesses).toEqual(["alpha"]);
    expect(config.mode).toBe("compiled");
  });

  it("leaves harnesses untouched when the key is present", () => {
    const result = mergeUserConfig({ text: EXISTING, path: PATH }, draft({ alpha: ALPHA }), PATH);
    const config = parseScopeConfig(result.content ?? "", "user", PATH);
    expect(config.harnesses).toEqual(["beta"]);
  });

  it("adds a server whose name is an Object.prototype key", () => {
    const result = mergeUserConfig(
      { text: "version: 1\n", path: PATH },
      draft({ constructor: OTHER }),
      PATH,
    );
    expect(result.added).toEqual(["constructor"]);
    const config = parseScopeConfig(result.content ?? "", "user", PATH);
    expect(config.mcps?.constructor).toEqual(OTHER);
  });

  it("throws InitError for an invalid existing file and does not change it", () => {
    const bad = "version: 2\n";
    expect(() => mergeUserConfig({ text: bad, path: PATH }, draft({ alpha: ALPHA }), PATH)).toThrow(
      InitError,
    );
  });
});

describe("mergeUserConfig with buildInitDraft", () => {
  it("keeps literal secrets under local and writes variable references under ref", () => {
    const input = {
      selection: selection([
        harness("alpha", {
          u1: {
            transport: "http",
            url: "https://x.example",
            headers: { Authorization: `Bearer ${SECRET}` },
          },
        }),
      ]),
      installed: [],
    };
    const localDraft = buildInitDraft({ ...input, secrets: "local" });
    const localMerge = mergeUserConfig(undefined, localDraft.user ?? draft({}, []), PATH);
    expect(localMerge.content).toContain(SECRET);

    const refDraft = buildInitDraft({ ...input, secrets: "ref" });
    const refMerge = mergeUserConfig(undefined, refDraft.user ?? draft({}, []), PATH);
    expect(refMerge.content).not.toContain(SECRET);
    expect(refMerge.content).toContain("${");
  });

  it("does not write a server that is also defined in project or local", () => {
    const built = buildInitDraft({
      selection: selection([
        {
          ...harness("alpha", {
            shared: { transport: "stdio", command: "s" },
            only: { transport: "stdio", command: "o" },
          }),
          project: { shared: { transport: "stdio", command: "s" } },
        },
      ]),
      installed: [],
      secrets: "local",
    });
    const result = mergeUserConfig(undefined, built.user ?? draft({}, []), PATH);
    expect(result.added).toEqual(["only"]);
    expect(result.content).not.toContain("shared");
  });
});
