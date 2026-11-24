/**
 * src/core/json-text.ts — pure JSON text helpers for fs-safe (plan J1, decision D2, ambiguity A9).
 * No I/O: no imports except the standard library, and nothing here reads the clock, env, or disk.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonKeyPath = readonly [string, ...string[]];

export interface JsonFormat {
  readonly indent: string;
  readonly eol: "\n" | "\r\n";
  readonly finalNewline: boolean;
  readonly bom: boolean;
}

export const DEFAULT_JSON_FORMAT: JsonFormat = Object.freeze({
  indent: "  ",
  eol: "\n",
  finalNewline: true,
  bom: false,
});

export type JsonPatchErrorCode =
  | "invalid-json"
  | "not-an-object"
  | "unsafe-number"
  | "splice-failed"
  | "verify-failed";

export class JsonPatchError extends Error {
  readonly code: JsonPatchErrorCode;

  constructor(message: string, code: JsonPatchErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JsonPatchError";
    this.code = code;
  }
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const BOM = "﻿";
const LEADING_KEY_INDENT = /^([ \t]+)"/;
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Detects BOM, EOL, final newline, and the indent of the first indented key. */
export function detectJsonFormat(text: string): JsonFormat {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const eol: "\n" | "\r\n" = body.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/.test(text);
  let indent = "";
  for (const line of body.split("\n")) {
    const match = LEADING_KEY_INDENT.exec(line);
    if (match?.[1] !== undefined) {
      indent = match[1];
      break;
    }
  }
  return { indent, eol, finalNewline, bom };
}

/**
 * Throws `unsafe-number` for any integer literal outside Number.MAX_SAFE_INTEGER. Skips string literals
 * and numbers with a fraction or exponent, so those are never rejected.
 */
export function assertSafeJsonNumbers(text: string): void {
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"') {
      i++;
      while (i < text.length && text.charAt(i) !== '"') {
        i += text.charAt(i) === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      JSON_NUMBER.lastIndex = i;
      const match = JSON_NUMBER.exec(text);
      if (match === null) {
        i++;
        continue;
      }
      const token = match[0];
      if (!/[.eE]/.test(token) && !Number.isSafeInteger(Number(token))) {
        throw new JsonPatchError(`integer ${token} is outside the safe range`, "unsafe-number");
      }
      i += token.length;
      continue;
    }
    i++;
  }
}

/** Parses JSON text. Strips a leading BOM, rejects unsafe integers, and maps syntax errors to `invalid-json`. */
export function parseJsonText(text: string): JsonValue {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  assertSafeJsonNumbers(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new JsonPatchError("invalid JSON text", "invalid-json", { cause });
  }
  // JSON.parse only produces JSON-compatible values, so this cast is sound.
  return parsed as JsonValue;
}

export function serializeJson(value: JsonValue, format: JsonFormat): string {
  const body = JSON.stringify(value, null, format.indent).replaceAll("\n", format.eol);
  return (format.bom ? BOM : "") + body + (format.finalNewline ? format.eol : "");
}

export function getAtPath(root: JsonValue, path: JsonKeyPath): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const key of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * Returns a copy with `value` at `path`, leaving the input unchanged. Missing intermediates become `{}`.
 * `undefined` deletes the final key. Keys are built with Object.fromEntries, so "__proto__" stays an own key.
 */
export function setAtPath(
  root: JsonValue,
  path: JsonKeyPath,
  value: JsonValue | undefined,
): JsonObject {
  if (!isJsonObject(root)) {
    throw new JsonPatchError("JSON root must be an object", "not-an-object");
  }
  return setIn(root, path, 0, value);
}

function setIn(
  node: JsonObject,
  path: readonly string[],
  index: number,
  value: JsonValue | undefined,
): JsonObject {
  const key = path[index];
  if (key === undefined) {
    throw new JsonPatchError("key path must not be empty", "not-an-object");
  }
  const entries = new Map<string, JsonValue>(Object.entries(node));
  if (index === path.length - 1) {
    if (value === undefined) {
      entries.delete(key);
    } else {
      entries.set(key, value);
    }
    return Object.fromEntries(entries);
  }

  const child = entries.get(key);
  if (child === undefined && value === undefined) {
    return Object.fromEntries(entries);
  }
  let childObject: JsonObject;
  if (child === undefined) {
    childObject = {};
  } else if (isJsonObject(child)) {
    childObject = child;
  } else {
    throw new JsonPatchError(`path segment "${key}" is not an object`, "not-an-object");
  }
  entries.set(key, setIn(childObject, path, index + 1, value));
  return Object.fromEntries(entries);
}

/** Deep equality. Object key order is ignored; array order is significant. */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isJsonObject(a)) {
    if (!isJsonObject(b)) {
      return false;
    }
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * Throws `verify-failed` unless `patched` parses to the original with `value` set at `path`.
 * `original` undefined means a file that does not exist yet, which is treated as `{}`.
 */
export function verifyJsonPatch(
  original: string | undefined,
  patched: string,
  path: JsonKeyPath,
  value: JsonValue | undefined,
): void {
  const base: JsonValue = original === undefined ? {} : parseJsonText(original);
  const expected = setAtPath(base, path, value);
  let actual: JsonValue;
  try {
    actual = parseJsonText(patched);
  } catch (cause) {
    throw new JsonPatchError("patched text is not valid JSON", "verify-failed", { cause });
  }
  if (!jsonEqual(expected, actual)) {
    throw new JsonPatchError("patched JSON does not match the requested change", "verify-failed");
  }
}

/** Fallback patch: parse, set the key, and re-serialize with the detected format. Keeps the BOM, EOL, and final newline. */
export function patchJsonReserialize(
  original: string,
  path: JsonKeyPath,
  value: JsonValue | undefined,
): string {
  const patched = setAtPath(parseJsonText(original), path, value);
  return serializeJson(patched, detectJsonFormat(original));
}
