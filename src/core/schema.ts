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
// (S1 content)
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
/** State key "<harness>:<scope>", for example "example-harness:project" (agreed in review; replaces bare harness keys). */
export const StateKeySchema = z.templateLiteral([HarnessNameSchema, ":", ScopeSchema]);
export type StateKey = z.infer<typeof StateKeySchema>; // `${string}:user` | `${string}:project` | `${string}:local`

export function stateKey(harness: HarnessName, scope: Scope): StateKey {
  return `${harness}:${scope}`;
}

export const StateEntrySchema = z.strictObject({
  /** server name -> sha256 (hex) of the sorted-key canonical JSON of its canonical McpServerDefinition. */
  mcpHashes: z.record(McpServerNameSchema, Sha256HexSchema),
  /** sha256 of the last-written instruction target, or null when yoke wrote no instructions for this key. */
  instructionsHash: Sha256HexSchema.nullable(),
});
export type StateEntry = z.infer<typeof StateEntrySchema>;

export const YokeStateLockSchema = z.strictObject({
  version: z.literal(1),
  lastSyncedAt: IsoDateTimeSchema,
  /** Field name kept from SPEC §4.3; keys are StateKey, not bare harness names. */
  harnesses: z.record(StateKeySchema, StateEntrySchema),
});
export type YokeStateLock = z.infer<typeof YokeStateLockSchema>;
// #endregion S2 state

// #region S3 session
// (S3 content)
// #endregion S3 session
