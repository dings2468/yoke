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
  | "verify-failed"
  | "duplicate-root-key"
  | "lossy-number";

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
  forEachNumberLiteral(text, (token) => {
    if (!/[.eE]/.test(token) && !Number.isSafeInteger(Number(token))) {
      throw new JsonPatchError(`integer ${token} is outside the safe range`, "unsafe-number");
    }
  });
}

/** Calls `visit` with each number literal in `text`, skipping string literals. */
function forEachNumberLiteral(text: string, visit: (token: string) => void): void {
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
      visit(token);
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

export interface JsonPatchResult {
  /** The patched text. `undefined` only for a no-op deletion on a missing file. */
  readonly content: string | undefined;
  readonly changed: boolean;
  readonly strategy: "span" | "reserialize" | "create" | "noop";
}

interface Member {
  readonly key: string;
  readonly start: number;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface ObjectScan {
  readonly open: number;
  readonly close: number;
  readonly members: readonly Member[];
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const WS = " \t\r\n";

function spliceFailed(message: string, cause?: unknown): JsonPatchError {
  return new JsonPatchError(message, "splice-failed", cause === undefined ? undefined : { cause });
}

function skipWs(text: string, index: number): number {
  let i = index;
  while (i < text.length && WS.includes(text.charAt(i))) {
    i++;
  }
  return i;
}

function scanString(text: string, index: number): number {
  if (text.charAt(index) !== '"') {
    throw spliceFailed(`expected string at ${index}`);
  }
  let i = index + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "\\") {
      i += 2;
    } else if (ch === '"') {
      return i + 1;
    } else {
      i++;
    }
  }
  throw spliceFailed("unterminated string");
}

function scanValue(text: string, index: number): number {
  const first = text.charAt(index);
  if (first === '"') {
    return scanString(text, index);
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let i = index;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (ch === '"') {
        i = scanString(text, i);
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
      }
      i++;
      if (depth === 0) {
        return i;
      }
    }
    throw spliceFailed("unterminated container");
  }
  let i = index;
  while (i < text.length && !",}]".includes(text.charAt(i)) && !WS.includes(text.charAt(i))) {
    i++;
  }
  if (i === index) {
    throw spliceFailed(`no value at ${index}`);
  }
  return i;
}

/** Scans the members of the object whose `{` is at `open`. */
function scanObject(text: string, open: number): ObjectScan {
  if (text.charAt(open) !== "{") {
    throw spliceFailed(`expected object at ${open}`);
  }
  const members: Member[] = [];
  let start = open + 1;
  let i = skipWs(text, start);
  if (text.charAt(i) === "}") {
    return { open, close: i, members };
  }
  for (;;) {
    const keyStart = skipWs(text, start);
    const keyEnd = scanString(text, keyStart);
    let key: unknown;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch (cause) {
      throw spliceFailed("invalid key token", cause);
    }
    if (typeof key !== "string") {
      throw spliceFailed("object key is not a string");
    }
    i = skipWs(text, keyEnd);
    if (text.charAt(i) !== ":") {
      throw spliceFailed(`expected ":" at ${i}`);
    }
    const valueStart = skipWs(text, i + 1);
    const valueEnd = scanValue(text, valueStart);
    members.push({ key, start, keyStart, keyEnd, valueStart, valueEnd });
    i = skipWs(text, valueEnd);
    const delimiter = text.charAt(i);
    if (delimiter === ",") {
      start = i + 1;
      continue;
    }
    if (delimiter === "}") {
      return { open, close: i, members };
    }
    throw spliceFailed(`expected "," or "}" at ${i}`);
  }
}

/** Whitespace at the start of the line containing `index`. */
function lineIndent(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  let i = lineStart;
  while (i < text.length && (text.charAt(i) === " " || text.charAt(i) === "\t")) {
    i++;
  }
  return text.slice(lineStart, i);
}

function render(value: JsonValue, baseIndent: string, format: JsonFormat): string {
  return JSON.stringify(value, null, format.indent).replaceAll("\n", format.eol + baseIndent);
}

/** Wraps `value` in objects for each key in `keys`: ["a","b"] and v becomes {a:{b:v}}. */
function wrapPath(keys: readonly string[], value: JsonValue): JsonValue {
  let wrapped = value;
  for (let i = keys.length - 1; i >= 0; i--) {
    wrapped = Object.fromEntries([[keys[i] as string, wrapped]]);
  }
  return wrapped;
}

function insertEdit(
  text: string,
  scan: ObjectScan,
  key: string,
  value: JsonValue,
  format: JsonFormat,
): Edit {
  const member = JSON.stringify(key);
  const last = scan.members.at(-1);
  if (last === undefined) {
    const parentIndent = lineIndent(text, scan.open);
    const childIndent = parentIndent + format.indent;
    const body =
      format.indent === ""
        ? `${member}:${render(value, "", format)}`
        : `${format.eol}${childIndent}${member}: ${render(value, childIndent, format)}${format.eol}${parentIndent}`;
    return { start: scan.open + 1, end: scan.close, text: body };
  }
  const sep = text.slice(last.keyEnd, last.valueStart);
  const indent = lineIndent(text, last.keyStart);
  const inserted = `,${text.slice(last.start, last.keyStart)}${member}${sep}${render(value, indent, format)}`;
  return { start: last.valueEnd, end: last.valueEnd, text: inserted };
}

/**
 * Returns `text` with the value at `path` replaced, inserted, or deleted, touching only the affected span.
 * `undefined` deletes the key; a missing key with `undefined` is a no-op. Throws `splice-failed` on anything
 * the scanner does not understand. Callers must verify the result.
 */
export function spliceJsonKey(
  text: string,
  path: JsonKeyPath,
  value: JsonValue | undefined,
): string {
  try {
    const format = detectJsonFormat(text);
    const rootOpen = skipWs(text, format.bom ? 1 : 0);
    let scan = scanObject(text, rootOpen);
    let edit: Edit | undefined;

    for (let depth = 0; depth < path.length; depth++) {
      const key = path[depth] as string;
      const member = scan.members.find((m) => m.key === key);
      const isLeaf = depth === path.length - 1;

      if (member === undefined) {
        if (value !== undefined) {
          edit = insertEdit(text, scan, key, wrapPath(path.slice(depth + 1), value), format);
        }
        break;
      }

      if (isLeaf) {
        if (value === undefined) {
          edit = deleteEdit(scan, member);
        } else {
          edit = {
            start: member.valueStart,
            end: member.valueEnd,
            text: render(value, lineIndent(text, member.keyStart), format),
          };
        }
        break;
      }

      scan = scanObject(text, member.valueStart);
    }

    if (edit === undefined) {
      return text;
    }
    return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  } catch (error) {
    if (error instanceof JsonPatchError && error.code === "splice-failed") {
      throw error;
    }
    throw spliceFailed("unexpected JSON layout", error);
  }
}

function deleteEdit(scan: ObjectScan, target: Member): Edit {
  const index = scan.members.indexOf(target);
  const previous = scan.members[index - 1];
  const next = scan.members[index + 1];
  if (scan.members.length === 1) {
    return { start: scan.open + 1, end: scan.close, text: "" };
  }
  if (previous !== undefined) {
    return { start: previous.valueEnd, end: target.valueEnd, text: "" };
  }
  return { start: target.start, end: (next as Member).start, text: "" };
}

/** Canonical decimal form of a number literal, so equal values compare equal ("1.5e300" and "1.5e+300"). */
function decimalKey(literal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (match === null) {
    return literal;
  }
  const [, sign = "", intPart = "", frac = "", exp = "0"] = match;
  let digits = intPart + frac;
  let point = intPart.length + Number(exp);
  const leading = digits.length - digits.replace(/^0+/, "").length;
  digits = digits.slice(leading);
  point -= leading;
  digits = digits.replace(/0+$/, "");
  if (digits === "") {
    return "0";
  }
  return `${sign}${digits}e${point}`;
}

/** True when the literal's exact value is what JSON.stringify writes back for it. */
function isRoundTripNumber(token: string): boolean {
  const parsed = Number(token);
  return Number.isFinite(parsed) && decimalKey(token) === decimalKey(String(parsed));
}

/** Throws `duplicate-root-key` or `lossy-number` when a re-serialize would silently change the document. */
function assertReserializable(text: string): void {
  let rootKeys: readonly string[];
  try {
    const format = detectJsonFormat(text);
    rootKeys = scanObject(text, skipWs(text, format.bom ? 1 : 0)).members.map((m) => m.key);
  } catch (cause) {
    throw new JsonPatchError(
      "root object keys could not be scanned, so duplicate keys cannot be ruled out; refusing to re-serialize",
      "duplicate-root-key",
      { cause },
    );
  }
  if (new Set(rootKeys).size !== rootKeys.length) {
    throw new JsonPatchError(
      "root object has a duplicate key; re-serializing would silently drop a value, so the file was not changed",
      "duplicate-root-key",
    );
  }
  forEachNumberLiteral(text, (token) => {
    if (!isRoundTripNumber(token)) {
      throw new JsonPatchError(
        `number ${token} does not round-trip through JSON.parse and JSON.stringify; re-serializing would rewrite it, so the file was not changed`,
        "lossy-number",
      );
    }
  });
}

/**
 * Sets (or deletes, with `undefined`) the key at `path` in `original`, editing only the target span.
 * Every splice is re-parsed and compared with the expected structure. On a splice or verify failure it
 * falls back to re-serializing with the detected format, unless the document has a duplicate root key or a
 * number literal that does not round-trip; those throw instead. Invalid JSON, a non-object root, and unsafe
 * integers are never patched and always throw. A deletion on a missing or blank file is a no-op.
 */
export function patchJsonKey(
  original: string | undefined,
  path: JsonKeyPath,
  value: JsonValue | undefined,
): JsonPatchResult {
  if (original === undefined || original.trim() === "") {
    if (value === undefined) {
      return { content: original, changed: false, strategy: "noop" };
    }
    const content = serializeJson(setAtPath({}, path, value), DEFAULT_JSON_FORMAT);
    return { content, changed: true, strategy: "create" };
  }

  const parsed = parseJsonText(original);
  if (!isJsonObject(parsed)) {
    throw new JsonPatchError("JSON root must be an object", "not-an-object");
  }
  if (jsonEqual(getAtPath(parsed, path), value)) {
    return { content: original, changed: false, strategy: "noop" };
  }

  try {
    const content = spliceJsonKey(original, path, value);
    verifyJsonPatch(original, content, path, value);
    return { content, changed: content !== original, strategy: "span" };
  } catch (error) {
    const recoverable =
      error instanceof JsonPatchError &&
      (error.code === "splice-failed" || error.code === "verify-failed");
    if (!recoverable) {
      throw error;
    }
  }

  assertReserializable(original);
  const content = patchJsonReserialize(original, path, value);
  verifyJsonPatch(original, content, path, value);
  return { content, changed: content !== original, strategy: "reserialize" };
}
