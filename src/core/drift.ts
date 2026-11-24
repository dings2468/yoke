/**
 * src/core/drift.ts — canonical hashing (SPEC §4.3) and desired-state types for drift checks (SPEC §5).
 * Pure functions only: no file I/O, no process state, no clock, no home directory.
 */
import { createHash } from "node:crypto";
import type {
  McpHttpServer,
  McpServerDefinition,
  McpSseServer,
  NativeInstructions,
  Scope,
} from "./schema.js";

// #region DR1 hashing

/** Recursively serialize a JSON-compatible value: keys sorted by code unit, no whitespace, `undefined` keys omitted. */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalJson: non-finite number is not JSON");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item: unknown) => {
          if (item === undefined) {
            throw new TypeError("canonicalJson: undefined array element is not JSON");
          }
          return canonicalJson(item);
        });
        return `[${items.join(",")}]`;
      }
      const record: Record<string, unknown> = { ...value };
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not JSON`);
  }
}

/** Lower-case hex sha256 over the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical form of an MCP definition for hashing. Drops `enabled` unless it is `false`, and drops empty
 * `args`, `env`, and `headers`. Returns a fresh object; the input is not modified.
 */
export function normalizeMcp(def: McpServerDefinition): McpServerDefinition {
  switch (def.transport) {
    case "stdio": {
      const out: McpServerDefinition = { transport: "stdio", command: def.command };
      if (def.args !== undefined && def.args.length > 0) {
        out.args = [...def.args];
      }
      if (def.env !== undefined && Object.keys(def.env).length > 0) {
        out.env = { ...def.env };
      }
      if (def.enabled === false) {
        out.enabled = false;
      }
      return out;
    }
    case "http":
    case "sse": {
      const out: McpHttpServer | McpSseServer = { transport: def.transport, url: def.url };
      if (def.headers !== undefined && Object.keys(def.headers).length > 0) {
        out.headers = { ...def.headers };
      }
      if (def.enabled === false) {
        out.enabled = false;
      }
      return out;
    }
  }
}

/** sha256 of the canonical JSON of the normalized MCP definition (SPEC §4.3). */
export function hashMcp(def: McpServerDefinition): string {
  return sha256Hex(canonicalJson(normalizeMcp(def)));
}

/** sha256 of `{kind,target}` for a symlink or `{kind,content}` for a file. The path is never hashed. */
export function hashInstructions(ins: NativeInstructions): string {
  const hashed =
    ins.kind === "symlink"
      ? { kind: ins.kind, target: ins.target }
      : { kind: ins.kind, content: ins.content };
  return sha256Hex(canonicalJson(hashed));
}

// #endregion DR1 hashing

// #region DR1 desired state

/** What one plan leaves on disk, in canonical form. */
export type ExpectedTarget =
  | {
      readonly kind: "mcps";
      readonly scope: Scope;
      readonly mcps: Readonly<Record<string, McpServerDefinition>>;
    }
  | {
      readonly kind: "instructions";
      readonly scope: Scope;
      readonly instructions: NativeInstructions;
    }
  | {
      readonly kind: "owned-names";
      readonly scope: Scope;
      readonly list: string;
      readonly names: readonly string[];
    };

/** Desired canonical state for one scope. */
export interface DesiredScopeState {
  /** undefined = MCPs of this scope are not managed (not compared, not hashed). */
  readonly mcps?: Readonly<Record<string, McpServerDefinition>>;
  readonly instructions?: NativeInstructions;
  readonly ownedNames?: Readonly<Record<string, readonly string[]>>;
}

// #endregion DR1 desired state
