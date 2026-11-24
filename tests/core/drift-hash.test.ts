import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  hashInstructions,
  hashMcp,
  normalizeMcp,
  sha256Hex,
} from "../../src/core/drift.js";
import type { McpServerDefinition } from "../../src/core/schema.js";

const STDIO: McpServerDefinition = { transport: "stdio", command: "npx", args: ["-y", "srv"] };

describe("canonicalJson", () => {
  it("sorts keys recursively, keeps array order, and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,1]},"b":1}',
    );
  });

  it("omits keys whose value is undefined", () => {
    expect(canonicalJson({ a: undefined, b: null, c: false })).toBe('{"b":null,"c":false}');
  });

  it("throws TypeError on non-JSON input", () => {
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(1n)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(Symbol("s"))).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it("keeps variable references verbatim", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} text is the value under test
    expect(canonicalJson({ key: "${API_KEY}" })).toBe('{"key":"${API_KEY}"}');
  });
});

describe("sha256Hex", () => {
  it("hashes the empty string to the known digest", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("normalizeMcp and hashMcp", () => {
  it("treats empty args, env, and headers the same as absent", () => {
    expect(hashMcp({ ...STDIO, args: [] })).toBe(hashMcp({ transport: "stdio", command: "npx" }));
    expect(hashMcp({ transport: "stdio", command: "npx", env: {} })).toBe(
      hashMcp({ transport: "stdio", command: "npx" }),
    );
    expect(hashMcp({ transport: "http", url: "https://x.test", headers: {} })).toBe(
      hashMcp({ transport: "http", url: "https://x.test" }),
    );
  });

  it("treats enabled: true the same as absent, and enabled: false differently", () => {
    expect(hashMcp({ ...STDIO, enabled: true })).toBe(hashMcp(STDIO));
    expect(hashMcp({ ...STDIO, enabled: false })).not.toBe(hashMcp(STDIO));
  });

  it("does not modify its input", () => {
    const def: McpServerDefinition = {
      transport: "stdio",
      command: "npx",
      args: [],
      enabled: true,
    };
    normalizeMcp(def);
    expect(def).toEqual({ transport: "stdio", command: "npx", args: [], enabled: true });
  });

  it("returns a fresh object", () => {
    const def: McpServerDefinition = { transport: "stdio", command: "npx", args: ["a"] };
    const out = normalizeMcp(def);
    expect(out).not.toBe(def);
    expect(out).toEqual(def);
  });
});

describe("hashInstructions", () => {
  it("ignores the path", () => {
    expect(hashInstructions({ kind: "file", path: "/a/AGENTS.md", content: "# Rules\n" })).toBe(
      hashInstructions({ kind: "file", path: "/b/CLAUDE.md", content: "# Rules\n" }),
    );
  });

  it("hashes a symlink differently from a file with equal text", () => {
    const text = "AGENTS.md";
    expect(hashInstructions({ kind: "symlink", path: "/x", target: text })).not.toBe(
      hashInstructions({ kind: "file", path: "/x", content: text }),
    );
  });
});
