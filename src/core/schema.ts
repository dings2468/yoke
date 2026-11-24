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
// (S2 content)
// #endregion S2 state

// #region S3 session
export const SESSION_ACTION_KINDS = ["read", "edit", "command", "search", "mcp", "other"] as const;
export const SessionActionKindSchema = z.enum(SESSION_ACTION_KINDS);
export type SessionActionKind = z.infer<typeof SessionActionKindSchema>;

/** Compact, single-line, human-readable summary (invariant 6), for example "Edited src/auth.ts (+14/-3)". */
export const SessionActionSchema = z.strictObject({
  kind: SessionActionKindSchema,
  summary: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[^\r\n]*$/, "summary must be a single line"),
});
export type SessionAction = z.infer<typeof SessionActionSchema>;

/** Strict: unknown keys such as `thinking` or `signature` are rejected (invariant 6). */
export const SessionTurnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  timestamp: IsoDateTimeSchema.optional(),
  content: z.string(),
  actions: z.array(SessionActionSchema).optional(),
});
export type SessionTurn = z.infer<typeof SessionTurnSchema>;

export const SessionGitSchema = z.strictObject({
  branch: z.string(), // "" allowed (detached HEAD / unborn)
  statusShort: z.string(), // "" = clean
  diffStat: z.string(), // "" when session.includeGitDiffStat is false
});
export type SessionGit = z.infer<typeof SessionGitSchema>;

/** File-name safe: the id becomes .yoke/sessions/<id>.json, so path traversal is impossible. */
export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

export const YokeSessionIRSchema = z.strictObject({
  version: z.literal(1),
  id: SessionIdSchema,
  createdAt: IsoDateTimeSchema,
  sourceHarness: HarnessNameSchema,
  repoPath: z.string().min(1),
  git: SessionGitSchema,
  turns: z.array(SessionTurnSchema),
});
export type YokeSessionIR = z.infer<typeof YokeSessionIRSchema>;
// #endregion S3 session
