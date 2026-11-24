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
export const InstructionsConfigSchema = z.strictObject({
  /** Path to the canonical instructions file, relative to the directory of the yaml file that declares it. */
  source: z.string().min(1).optional(),
  preferSymlink: z.boolean().optional(),
});
export type InstructionsConfig = z.infer<typeof InstructionsConfigSchema>;

export const SessionConfigSchema = z.strictObject({
  maxTurns: z.number().int().positive().optional(),
  includeGitDiffStat: z.boolean().optional(),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export const HarnessListSchema = z
  .array(HarnessNameSchema)
  .refine((list) => new Set(list).size === list.length, "duplicate harness name");

/** One scope file. Everything except `version` is optional; there are no defaults here (they are applied after merge). */
export const YokeConfigSchema = z.strictObject({
  version: z.literal(1),
  mode: ModeSchema.optional(),
  harnesses: HarnessListSchema.optional(),
  mcps: McpServersSchema.optional(),
  instructions: InstructionsConfigSchema.optional(),
  session: SessionConfigSchema.optional(),
});
export type YokeConfig = z.infer<typeof YokeConfigSchema>;
// #endregion S4 config

// #region S5 resolved
// (S5 content)
// #endregion S5 resolved

// #region S6 native
// (S6 content)
// #endregion S6 native

// #region S7 options
/**
 * Options for HarnessAdapter.syncStatic (SPEC §6). Planning only; adapters never see dry-run or force.
 * Plain interface, not a Zod schema: these are internal call arguments, not external input.
 */
export interface SyncOptions {
  /**
   * Absolute repo root. Project and local targets resolve against it (syncStatic has no repoPath parameter).
   */
  readonly repoPath: string;
  /**
   * Native scopes to plan, in any order. Command mapping (SPEC §7):
   * `yoke sync` -> ["project", "local"]; `--global` -> ["user"]; `--all` -> ["user", "project", "local"].
   * The lock is keyed `<harness>:<scope>` (S2), so the adapter must know which scopes it plans.
   */
  readonly scopes: readonly Scope[];
  /**
   * Non-fatal warnings (for example, a transport or scope a harness cannot represent). Must not throw.
   * FileChangePlan has no warnings field, and warnings must appear identically in dry-run.
   */
  readonly warn: (message: string) => void;
}

/**
 * Options for HarnessAdapter.importAndLaunch (SPEC §6, §7 `yoke switch`).
 * Plain interface, not a Zod schema: these are internal call arguments, not external input.
 */
export interface LaunchOptions {
  /**
   * Absolute repo root: the cwd for the spawned harness and the base for .yoke/ handoff files.
   */
  readonly repoPath: string;
  /** false for `--no-launch`: materialize the session or handoff files and report the command, without spawning. */
  readonly launch: boolean;
}
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
