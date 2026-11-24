import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  JsonPatchError,
  type JsonValue,
  parseJsonText,
  patchJsonKey,
  patchJsonReserialize,
  spliceJsonKey,
} from "../../src/core/json-text.js";

const FIXTURES = new URL("../fixtures/core/json/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(JsonPatchError);
    expect((error as JsonPatchError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

const TWO_SERVERS: JsonValue = {
  alpha: { type: "stdio", command: "alpha-cmd", args: [] },
  beta: { type: "http", url: "https://example.test/mcp" },
};

describe("patchJsonKey span strategy", () => {
  it("replaces mcpServers byte-for-byte and keeps integer-like key order", () => {
    const original = fixture("claude-like.json");
    const result = patchJsonKey(original, ["mcpServers"], TWO_SERVERS);
    expect(result.strategy).toBe("span");
    expect(result.changed).toBe(true);
    expect(result.content).toBe(fixture("claude-like.patched.json"));
  });

  it("returns noop with identical content when the value already matches", () => {
    const original = fixture("claude-like.json");
    const result = patchJsonKey(original, ["numStartups"], 3);
    expect(result).toEqual({ content: original, changed: false, strategy: "noop" });
  });

  it("inserts a missing top-level key after the last member", () => {
    const original = fixture("no-mcp.json");
    const result = patchJsonKey(original, ["mcpServers"], { alpha: { command: "a" } });
    const prefix = original.slice(0, original.lastIndexOf("\n}"));
    expect(result.strategy).toBe("span");
    expect(result.content).toBe(
      `${prefix},\n  "mcpServers": {\n    "alpha": {\n      "command": "a"\n    }\n  }\n}\n`,
    );
  });

  it("inserts into a nested path with the child indent", () => {
    const original = fixture("no-mcp.json");
    const result = patchJsonKey(original, ["projects", "/repo", "mcpServers"], {
      alpha: { command: "a" },
    });
    expect(result.strategy).toBe("span");
    expect(result.content).toBe(
      [
        "{",
        '  "numStartups": 1,',
        '  "projects": {',
        '    "/repo": {',
        '      "allowedTools": [],',
        '      "mcpServers": {',
        '        "alpha": {',
        '          "command": "a"',
        "        }",
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(parseJsonText(result.content)).toEqual({
      numStartups: 1,
      projects: { "/repo": { allowedTools: [], mcpServers: { alpha: { command: "a" } } } },
    });
  });

  it("preserves CRLF and tab indentation", () => {
    const crlfTab =
      '{\r\n\t"numStartups": 1,\r\n\t"mcpServers": {\r\n\t\t"old": {\r\n\t\t\t"command": "o"\r\n\t\t}\r\n\t}\r\n}\r\n';
    const result = patchJsonKey(crlfTab, ["mcpServers"], {
      new: { command: "n" },
    });
    expect(result.strategy).toBe("span");
    expect(result.content).toBe(
      '{\r\n\t"numStartups": 1,\r\n\t"mcpServers": {\r\n\t\t"new": {\r\n\t\t\t"command": "n"\r\n\t\t}\r\n\t}\r\n}\r\n',
    );
  });

  it("preserves compact formatting", () => {
    const compact = '{"numStartups":1,"mcpServers":{"old":{"command":"o"}}}\n';
    const result = patchJsonKey(compact, ["mcpServers"], { new: { command: "n" } });
    expect(result.strategy).toBe("span");
    expect(result.content).toBe('{"numStartups":1,"mcpServers":{"new":{"command":"n"}}}\n');
  });

  it("keeps a leading BOM", () => {
    expect(spliceJsonKey('﻿{\n  "a": 1\n}\n', ["a"], 2)).toBe('﻿{\n  "a": 2\n}\n');
  });

  it("treats braces and escaped quotes inside string values as text", () => {
    const text = '{"s": "}\\"{", "k": 1}';
    expect(spliceJsonKey(text, ["k"], 2)).toBe('{"s": "}\\"{", "k": 2}');
    const result = patchJsonKey(fixture("claude-like.json"), ["mcpServers"], {
      x: { command: 'a}"b' },
    });
    expect(parseJsonText(result.content)).toMatchObject({ mcpServers: { x: { command: 'a}"b' } } });
  });
});

describe("spliceJsonKey delete", () => {
  it("removes a non-first member", () => {
    const original = fixture("claude-like.json");
    const removed =
      ',\n  "mcpServers": {\n    "old": {\n      "type": "stdio",\n      "command": "old-cmd"\n    }\n  }';
    expect(spliceJsonKey(original, ["mcpServers"], undefined)).toBe(original.replace(removed, ""));
  });

  it("removes the first member", () => {
    const original = fixture("claude-like.json");
    expect(spliceJsonKey(original, ["numStartups"], undefined)).toBe(
      original.replace('\n  "numStartups": 3,', ""),
    );
  });

  it("empties an object with a single member", () => {
    expect(spliceJsonKey('{\n  "a": 1\n}\n', ["a"], undefined)).toBe("{}\n");
  });

  it("is a no-op for a missing key", () => {
    const original = fixture("no-mcp.json");
    expect(spliceJsonKey(original, ["mcpServers"], undefined)).toBe(original);
    const result = patchJsonKey(original, ["mcpServers"], undefined);
    expect(result).toEqual({ content: original, changed: false, strategy: "noop" });
  });
});

describe("spliceJsonKey insert into empty objects", () => {
  it("writes a multi-line member into an empty nested object", () => {
    expect(spliceJsonKey('{\n  "x": {}\n}\n', ["x", "a"], 1)).toBe(
      '{\n  "x": {\n    "a": 1\n  }\n}\n',
    );
  });
});

describe("patchJsonKey create and errors", () => {
  it("creates a new file from undefined or blank text", () => {
    for (const original of [undefined, " \n"]) {
      const result = patchJsonKey(original, ["mcpServers"], { x: { command: "c" } });
      expect(result.strategy).toBe("create");
      expect(result.changed).toBe(true);
      expect(parseJsonText(result.content)).toEqual({ mcpServers: { x: { command: "c" } } });
      expect(result.content.endsWith("\n")).toBe(true);
    }
  });

  it("rejects unsafe integers without falling back", () => {
    expectCode(() => patchJsonKey(fixture("unsafe-number.json"), ["a"], 2), "unsafe-number");
  });

  it("rejects invalid JSON without falling back", () => {
    expectCode(() => patchJsonKey('{"a":', ["a"], 2), "invalid-json");
  });

  it("rejects a non-object root", () => {
    expectCode(() => patchJsonKey("[1]", ["a"], 2), "not-an-object");
  });

  it("throws splice-failed for a malformed layout", () => {
    expectCode(() => spliceJsonKey('{"a": 1 "b": 2}', ["b"], 3), "splice-failed");
    expectCode(() => spliceJsonKey('{"a": 1}', ["a", "b"], 3), "splice-failed");
  });
});

describe("patchJsonKey reserialize fallback", () => {
  it("falls back when the splice cannot preserve duplicate keys", () => {
    const result = patchJsonKey('{"a":1,"a":2}', ["a"], 3);
    expect(result).toEqual({ content: '{"a":3}', changed: true, strategy: "reserialize" });
  });

  it("reserialize reorders integer-like keys, which is why span editing exists", () => {
    const content = patchJsonReserialize(fixture("claude-like.json"), ["mcpServers"], TWO_SERVERS);
    expect(content.indexOf('"10"')).toBeLessThan(content.indexOf('"numStartups"'));
    expect(parseJsonText(content)).toMatchObject({ numStartups: 3, mcpServers: TWO_SERVERS });
  });
});
