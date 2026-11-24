/**
 * src/adapters/agy.ts: agy (Antigravity) paths and MCP entry translation (SPEC §6).
 *
 * Facts used here:
 * - The GEMINI.md locations and the `agy` binary name are UNVERIFIED (SPEC §6).
 * - agy 1.5.16 does not expand `${VAR}` references. yoke stores them literally.
 * - agy 1.5.16 writes `serverUrl` for HTTP servers. yoke writes `url` (SPEC §6) and reads both keys.
 * - agy has no SSE transport. SSE servers are never translated here.
 */
import { join } from "node:path";
import {
  isJsonObject,
  type JsonKeyPath,
  type JsonObject,
  type JsonValue,
} from "../core/json-text.js";
import {
  type McpHttpServer,
  McpServerDefinitionSchema,
  McpServerNameSchema,
  type McpStdioServer,
} from "../core/schema.js";
import { type NativeEntry, NativeStateError } from "./base.js";

export const AGY_NAME = "agy";

export interface AgyPaths {
  /** `<home>/.gemini/config/mcp_config.json` */
  readonly mcpConfig: string;
  /** `<home>/.gemini/GEMINI.md`, UNVERIFIED */
  readonly userInstructions: string;
  /** `<repo>/GEMINI.md`, UNVERIFIED */
  readonly projectInstructions: string;
}

export function agyPaths(homeDir: string, repoPath: string): AgyPaths {
  return {
    mcpConfig: join(homeDir, ".gemini", "config", "mcp_config.json"),
    userInstructions: join(homeDir, ".gemini", "GEMINI.md"),
    projectInstructions: join(repoPath, "GEMINI.md"),
  };
}

/** The top-level key that holds MCP servers. yoke patches only this key. */
export const AGY_MCP_KEY: JsonKeyPath = ["mcpServers"];

/** Keys yoke interprets inside an entry. Every other key is kept as an extra. `type` is not in this set. */
const OWNED_KEYS: ReadonlySet<string> = new Set([
  "command",
  "args",
  "env",
  "url",
  "serverUrl",
  "headers",
  "disabled",
]);
const STDIO_ONLY_KEYS: readonly string[] = ["command", "args", "env"];
const HTTP_ONLY_KEYS: readonly string[] = ["url", "serverUrl", "headers"];

/**
 * Translates a yoke definition to an agy entry. `disabled: true` is written only when `enabled` is false.
 * HTTP servers are written with `url`, never `serverUrl`.
 */
export function toAgyEntry(def: McpStdioServer | McpHttpServer, enabled: boolean): JsonObject {
  let out: JsonObject;
  if (def.transport === "stdio") {
    out = { command: def.command };
    if (def.args !== undefined) {
      out.args = [...def.args];
    }
    if (def.env !== undefined) {
      out.env = Object.fromEntries(Object.entries(def.env));
    }
  } else {
    out = { url: def.url };
    if (def.headers !== undefined) {
      out.headers = Object.fromEntries(Object.entries(def.headers));
    }
  }
  if (!enabled) {
    out.disabled = true;
  }
  return out;
}

/**
 * Reads one agy entry (Q1). Returns `managed` with the canonical definition and extras, `opaque` for an unknown
 * `type` or an entry with neither a command nor a URL, or throws NativeStateError for a corrupt entry.
 */
export function fromAgyEntry(name: string, raw: JsonValue, path: string): NativeEntry {
  const failure = (why: string): NativeStateError =>
    new NativeStateError(`invalid agy MCP server "${name}" in ${path}: ${why}`, path, name);

  if (!McpServerNameSchema.safeParse(name).success) {
    throw failure("server name is not valid");
  }
  if (!isJsonObject(raw)) {
    throw failure("entry must be an object");
  }
  const present = (key: string): JsonValue | undefined =>
    Object.hasOwn(raw, key) ? raw[key] : undefined;

  if (Object.hasOwn(raw, "httpUrl")) {
    throw failure("httpUrl is not supported; use url");
  }
  const disabled = present("disabled");
  if (disabled !== undefined && typeof disabled !== "boolean") {
    throw failure("disabled must be a boolean");
  }
  const url = present("url");
  const serverUrl = present("serverUrl");
  if (
    (url !== undefined && typeof url !== "string") ||
    (serverUrl !== undefined && typeof serverUrl !== "string")
  ) {
    throw failure("url and serverUrl must be strings");
  }
  if (url !== undefined && serverUrl !== undefined && url !== serverUrl) {
    throw failure("url and serverUrl differ");
  }
  const type = present("type");
  if (type !== undefined && typeof type !== "string") {
    throw failure("type must be a string");
  }
  if (typeof type === "string" && type !== "stdio" && type !== "http") {
    return { kind: "opaque", raw, reason: `type "${type}"` };
  }

  const remoteUrl =
    typeof url === "string" ? url : typeof serverUrl === "string" ? serverUrl : undefined;
  let transport: "stdio" | "http";
  if (Object.hasOwn(raw, "command")) {
    transport = "stdio";
  } else if (remoteUrl !== undefined) {
    transport = "http";
  } else {
    return { kind: "opaque", raw, reason: "no command or url" };
  }
  if (type !== undefined && type !== transport) {
    throw failure(`type "${String(type)}" does not fit a ${transport} entry`);
  }
  const foreignKeys = transport === "stdio" ? HTTP_ONLY_KEYS : STDIO_ONLY_KEYS;
  for (const key of foreignKeys) {
    if (Object.hasOwn(raw, key)) {
      throw failure(`"${key}" does not fit a ${transport} entry`);
    }
  }

  const wanted: Record<string, unknown> =
    transport === "stdio"
      ? {
          transport,
          command: present("command"),
          args: present("args"),
          env: present("env"),
        }
      : { transport, url: remoteUrl, headers: present("headers") };
  const candidate: Record<string, unknown> = Object.fromEntries(
    Object.entries(wanted).filter(([, value]) => value !== undefined),
  );
  if (disabled === true) {
    candidate.enabled = false;
  }
  const parsed = McpServerDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw failure(parsed.error.issues[0]?.message ?? "entry does not match the schema");
  }

  const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !OWNED_KEYS.has(key)));
  return { kind: "managed", def: parsed.data, extras };
}

/**
 * Reads the `mcpServers` value in native key order. `undefined` (key absent) yields an empty map.
 * Throws NativeStateError when the value is not an object or an entry is corrupt.
 */
export function readAgyServers(
  raw: JsonValue | undefined,
  path: string,
): ReadonlyMap<string, NativeEntry> {
  if (raw === undefined) {
    return new Map();
  }
  if (!isJsonObject(raw)) {
    throw new NativeStateError(`mcpServers must be an object in ${path}`, path);
  }
  return new Map<string, NativeEntry>(
    Object.entries(raw).map(([name, value]): [string, NativeEntry] => [
      name,
      fromAgyEntry(name, value, path),
    ]),
  );
}
