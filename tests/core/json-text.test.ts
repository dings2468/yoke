import { describe, expect, it } from "vitest";
import {
  assertSafeJsonNumbers,
  detectJsonFormat,
  getAtPath,
  JsonPatchError,
  type JsonValue,
  jsonEqual,
  parseJsonText,
  patchJsonReserialize,
  serializeJson,
  setAtPath,
  verifyJsonPatch,
} from "../../src/core/json-text.js";

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

describe("detectJsonFormat", () => {
  it("detects two-space indent with a final newline", () => {
    expect(detectJsonFormat('{\n  "a": 1\n}\n')).toEqual({
      indent: "  ",
      eol: "\n",
      finalNewline: true,
      bom: false,
    });
  });

  it("detects a tab indent", () => {
    expect(detectJsonFormat('{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n').indent).toBe("\t");
  });

  it("detects compact JSON as an empty indent", () => {
    expect(detectJsonFormat('{"a":1}')).toEqual({
      indent: "",
      eol: "\n",
      finalNewline: false,
      bom: false,
    });
  });

  it("detects CRLF line endings", () => {
    const format = detectJsonFormat('{\r\n    "a": 1\r\n}\r\n');
    expect(format.eol).toBe("\r\n");
    expect(format.indent).toBe("    ");
    expect(format.finalNewline).toBe(true);
  });

  it("detects a missing final newline", () => {
    expect(detectJsonFormat('{\n  "a": 1\n}').finalNewline).toBe(false);
  });

  it("detects a leading BOM and strips it before measuring indent", () => {
    const format = detectJsonFormat('﻿{\n  "a": 1\n}\n');
    expect(format.bom).toBe(true);
    expect(format.indent).toBe("  ");
  });
});

describe("assertSafeJsonNumbers and parseJsonText", () => {
  it("rejects an unsafe integer literal", () => {
    expectCode(() => assertSafeJsonNumbers('{"a": 12345678901234567890}'), "unsafe-number");
    expectCode(() => parseJsonText('{"a": 12345678901234567890}'), "unsafe-number");
  });

  it("accepts a large float literal and a large numeric string", () => {
    expect(parseJsonText('{"a": 1.5e300}')).toEqual({ a: 1.5e300 });
    expect(parseJsonText('{"a": "12345678901234567890"}')).toEqual({
      a: "12345678901234567890",
    });
  });

  it("accepts a safe integer at the boundary", () => {
    expect(() => assertSafeJsonNumbers('{"a": 9007199254740991}')).not.toThrow();
  });

  it("maps syntax errors to invalid-json", () => {
    expectCode(() => parseJsonText('{"a": '), "invalid-json");
  });

  it("strips a leading BOM", () => {
    expect(parseJsonText('﻿{"a": 1}')).toEqual({ a: 1 });
  });
});

describe("serializeJson", () => {
  it("keeps BOM, CRLF, and final newline from the format", () => {
    const text = serializeJson(
      { a: 1 },
      { indent: "\t", eol: "\r\n", finalNewline: true, bom: true },
    );
    expect(text).toBe('﻿{\r\n\t"a": 1\r\n}\r\n');
  });

  it("emits no trailing newline when finalNewline is false", () => {
    expect(
      serializeJson({ a: [1] }, { indent: "", eol: "\n", finalNewline: false, bom: false }),
    ).toBe('{"a":[1]}');
  });
});

describe("setAtPath", () => {
  it("does not mutate its input", () => {
    const root: JsonValue = { a: { b: 1 } };
    setAtPath(root, ["a", "b"], 2);
    expect(root).toEqual({ a: { b: 1 } });
  });

  it("creates missing nested objects", () => {
    expect(setAtPath({}, ["a", "b", "c"], 1)).toEqual({ a: { b: { c: 1 } } });
  });

  it("deletes the final key when the value is undefined", () => {
    expect(setAtPath({ a: { b: 1, c: 2 } }, ["a", "b"], undefined)).toEqual({ a: { c: 2 } });
  });

  it("does nothing when deleting under a missing path", () => {
    expect(setAtPath({ x: 1 }, ["a", "b"], undefined)).toEqual({ x: 1 });
  });

  it("rejects a non-object root and a non-object intermediate", () => {
    expectCode(() => setAtPath([1], ["a"], 1), "not-an-object");
    expectCode(() => setAtPath({ a: 1 }, ["a", "b"], 2), "not-an-object");
  });

  it("keeps __proto__ as an own key and leaves Object.prototype untouched", () => {
    const root = parseJsonText('{"__proto__": {"x": 1}}');
    const result = setAtPath(root, ["__proto__", "y"], 2);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(getAtPath(result, ["__proto__", "y"])).toBe(2);
    expect(getAtPath(result, ["__proto__", "x"])).toBe(1);
    expect(Object.hasOwn(Object.prototype, "y")).toBe(false);
    expect(({} as Record<string, unknown>).y).toBeUndefined();
  });
});

describe("getAtPath", () => {
  it("returns undefined for a missing or non-object path", () => {
    expect(getAtPath({ a: 1 }, ["a", "b"])).toBeUndefined();
    expect(getAtPath({ a: { b: "x" } }, ["a", "b"])).toBe("x");
  });
});

describe("jsonEqual", () => {
  it("ignores object key order", () => {
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("treats array order as significant", () => {
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });

  it("distinguishes undefined from missing and nested differences", () => {
    expect(jsonEqual(undefined, undefined)).toBe(true);
    expect(jsonEqual(undefined, null)).toBe(false);
    expect(jsonEqual({ a: { b: [1] } }, { a: { b: [2] } })).toBe(false);
  });
});

describe("verifyJsonPatch", () => {
  it("accepts a correct patch", () => {
    expect(() =>
      verifyJsonPatch('{"a": 1}', '{"a": 1, "m": {"x": 2}}', ["m", "x"], 2),
    ).not.toThrow();
  });

  it("throws verify-failed on a wrong patch", () => {
    expectCode(
      () => verifyJsonPatch('{"a": 1}', '{"a": 1, "m": {"x": 3}}', ["m", "x"], 2),
      "verify-failed",
    );
  });

  it("treats an undefined original as an empty object", () => {
    expect(() => verifyJsonPatch(undefined, '{"m": {"x": 2}}', ["m", "x"], 2)).not.toThrow();
  });

  it("throws verify-failed when the patched text is not JSON", () => {
    expectCode(() => verifyJsonPatch("{}", "{", ["a"], 1), "verify-failed");
  });
});

describe("patchJsonReserialize", () => {
  it("sets the key and keeps CRLF, tab indent, BOM, and final newline", () => {
    const original = '﻿{\r\n\t"a": 1\r\n}\r\n';
    const text = patchJsonReserialize(original, ["m", "x"], 2);
    expect(text).toBe('﻿{\r\n\t"a": 1,\r\n\t"m": {\r\n\t\t"x": 2\r\n\t}\r\n}\r\n');
    expect(() => verifyJsonPatch(original, text, ["m", "x"], 2)).not.toThrow();
  });

  it("rejects an invalid original", () => {
    expectCode(() => patchJsonReserialize("[1", ["a"], 1), "invalid-json");
  });
});
