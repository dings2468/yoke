/**
 * src/core/schema.ts — canonical Zod schemas (SPEC §4) and the types SPEC §6 references.
 * Validation and type inference only: no merging, hashing, defaults, or I/O.
 * tsconfig keeps exactOptionalPropertyTypes OFF, so optional fields infer as `T | undefined`.
 * Consumers must treat an `undefined` value exactly like an absent key.
 */
import { z } from "zod";

// #region S0 primitives
/** Ascending precedence: user < project < local (SPEC §3). */
export const SCOPES = ["user", "project", "local"] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

export const ModeSchema = z.enum(["compiled", "hybrid"]);
export type Mode = z.infer<typeof ModeSchema>;

/** Lower-case adapter id. Never contains ":" because it is part of the state key "<harness>:<scope>". */
export const HarnessNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, "harness name must match ^[a-z][a-z0-9-]{0,31}$");
export type HarnessName = z.infer<typeof HarnessNameSchema>;

export const McpServerNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
    "MCP server name must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$",
  );
export type McpServerName = z.infer<typeof McpServerNameSchema>;

/** Lower-case hex sha256 digest with no prefix. */
export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected 64 lower-case hex chars");

/** ISO-8601 date-time; accepts `Z` and numeric offsets. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
// #endregion S0 primitives

// #region S1 mcp
export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export const McpTransportSchema = z.enum(MCP_TRANSPORTS);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/** Values stay verbatim; `${VAR}` references are never expanded (SPEC §8.4). Strings only, so YAML numbers must be quoted. */
export const EnvMapSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string());
export type EnvMap = z.infer<typeof EnvMapSchema>;
export const HeaderMapSchema = z.record(
  z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  z.string(),
);
export type HeaderMap = z.infer<typeof HeaderMapSchema>;

/** http(s) URL, or a URL that starts with a ${VAR} reference. z.url() is deliberately not used because it rejects ${VAR}. */
export const RemoteUrlSchema = z
  .string()
  .regex(
    /^(https?:\/\/|\$\{[A-Za-z_][A-Za-z0-9_]*\})\S*$/,
    `url must start with http://, https:// or \${VAR}`,
  );

export const McpStdioServerSchema = z.strictObject({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: EnvMapSchema.optional(),
  enabled: z.boolean().optional(),
});
export const McpHttpServerSchema = z.strictObject({
  transport: z.literal("http"),
  url: RemoteUrlSchema,
  headers: HeaderMapSchema.optional(),
  enabled: z.boolean().optional(),
});
export const McpSseServerSchema = z.strictObject({
  transport: z.literal("sse"),
  url: RemoteUrlSchema,
  headers: HeaderMapSchema.optional(),
  enabled: z.boolean().optional(),
});
export type McpStdioServer = z.infer<typeof McpStdioServerSchema>;
export type McpHttpServer = z.infer<typeof McpHttpServerSchema>;
export type McpSseServer = z.infer<typeof McpSseServerSchema>;

/** A full definition, which always has a transport. */
export const McpServerDefinitionSchema = z.discriminatedUnion("transport", [
  McpStdioServerSchema,
  McpHttpServerSchema,
  McpSseServerSchema,
]);
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;

/** `{ enabled: false }` with no transport: suppresses an inherited entry (SPEC §3.1). */
export const McpDisabledStubSchema = z.strictObject({
  transport: z.undefined().optional(),
  enabled: z.literal(false),
});
export type McpDisabledStub = z.infer<typeof McpDisabledStubSchema>;

/** One entry under `mcps:` in any scope file. */
export const McpServerEntrySchema = z.discriminatedUnion("transport", [
  McpStdioServerSchema,
  McpHttpServerSchema,
  McpSseServerSchema,
  McpDisabledStubSchema,
]);
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

export const McpServersSchema = z.record(McpServerNameSchema, McpServerEntrySchema);
export type McpServers = z.infer<typeof McpServersSchema>;

export function isMcpDisabledStub(entry: McpServerEntry): entry is McpDisabledStub {
  return entry.transport === undefined;
}
// #endregion S1 mcp

// #region S4 config
// (S4 content)
// #endregion S4 config

// #region S5 resolved
// (S5 content)
// #endregion S5 resolved

// #region S6 native
// (S6 content)
// #endregion S6 native

// #region S7 options
// (S7 content)
// #endregion S7 options

// #region S2 state
// (S2 content)
// #endregion S2 state

// #region S3 session
// (S3 content)
// #endregion S3 session
