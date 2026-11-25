/**
 * src/core/schema.ts — canonical Zod schemas for yoke.yaml, the lock files and YokeSessionIR, plus the plain types adapters and commands share; these schemas are the contract and tests/schema/ is its executable spec.
 * Validation and type inference only: no merging, hashing, defaults, or I/O.
 * tsconfig keeps exactOptionalPropertyTypes OFF, so optional fields infer as `T | undefined`.
 * Consumers must treat an `undefined` value exactly like an absent key.
 *
 * yoke.yaml (YokeConfigSchema, one per scope file):
 * - Strict objects: unknown keys are rejected in every file and nested object, which catches typos such as
 *   `mcpServers:`. An older yoke therefore rejects files written by a newer one.
 * - `version: 1` is required in every scope file, including yoke.local.yaml. All other top-level keys are optional.
 * - Strings only: `env` and `headers` values must be YAML strings (`PORT: "8080"`); numbers and booleans are not
 *   coerced. `env` keys match `^[A-Za-z_][A-Za-z0-9_]*$`. YAML `null` is rejected everywhere.
 * - URLs must start with `http://`, `https://`, or a `${VAR}` reference, so `${MCP_HOST}/mcp` is valid.
 * - Names: harness names match `^[a-z][a-z0-9-]{0,31}$` (no `:`, because they form the state key); MCP server names
 *   match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. `harnesses` must not contain duplicates.
 * - No `instructions:` key. Instruction paths are fixed (`<repo>/AGENTS.md` and `<userConfigDir>/AGENTS.md`), so an
 *   `instructions:` key is rejected like any other unknown key.
 * - `session.maxTurns` is a positive integer with no upper bound.
 * - Defaults, applied after merge and never written: mode compiled, harnesses [], session.maxTurns 40,
 *   session.includeGitDiffStat true.
 *
 * Lock files (YokeStateLockSchema): `.yoke/yoke.lock` (project) and `<userConfigDir>/yoke.lock` (user), both
 * gitignored and sharing this schema. Keys are "<harness>:<scope>" (scope is user, project, or local); the field
 * keeps the name `harnesses`. Hashes are lowercase hex sha256 with no `sha256:` prefix (64 characters). Only names in
 * `ownedNames` are ever removed from a shared native list. `lastSyncedAt` is an ISO-8601 date-time.
 *
 * YokeSessionIRSchema limits: `id` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` (it becomes a file name);
 * `sourceHarness` is a harness name; `repoPath` is non-empty but not checked for being absolute; `branch` may be
 * empty (detached or unborn HEAD); `turns` may be empty. Each `actions[].summary` is 1 to 300 characters and
 * single-line. `content` has no length cap; the exporter enforces the lossy-but-clean rule instead. Objects are
 * strict, so keys such as `thinking` or `signature` are rejected. Timestamps are ISO-8601 date-times.
 *
 * Session translation rules: strip cryptographic thinking/thought signatures, raw multi-hundred-line file reads,
 * and verbose terminal logs. Preserve user intents, assistant decisions and plans, compact `actions[]` summaries,
 * and live `git` state.
 */
import { z } from "zod";

// #region S0 primitives
/** Ascending precedence: user < project < local. */
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

/** Values stay verbatim; `${VAR}` references are never expanded (AGENTS.md invariant 4). Strings only, so YAML numbers must be quoted. */
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

/** `{ enabled: false }` with no transport: suppresses an inherited entry (merge rules: resolveConfig in scopes.ts). */
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
  session: SessionConfigSchema.optional(),
});
export type YokeConfig = z.infer<typeof YokeConfigSchema>;
// #endregion S4 config

// #region S5 resolved
const resolvedServerExtras = {
  /** Always explicit after merge. A stub over a full definition yields the definition with enabled: false. */
  enabled: z.boolean(),
  /** Scopes that contributed to this entry, ascending precedence (user -> local), unique, non-empty. */
  scopes: z.array(ScopeSchema).min(1),
};

/** A fully merged server. A stub with nothing beneath it is dropped by the merge and never appears here. */
export const ResolvedMcpServerSchema = z.discriminatedUnion("transport", [
  McpStdioServerSchema.extend(resolvedServerExtras),
  McpHttpServerSchema.extend(resolvedServerExtras),
  McpSseServerSchema.extend(resolvedServerExtras),
]);
export type ResolvedMcpServer = z.infer<typeof ResolvedMcpServerSchema>;

export const ResolvedYokeConfigSchema = z.strictObject({
  version: z.literal(1),
  mode: ModeSchema,
  harnesses: z.array(HarnessNameSchema),
  /** Effective view: local > project > user. */
  mcps: z.record(McpServerNameSchema, ResolvedMcpServerSchema),
  session: z.strictObject({
    maxTurns: z.number().int().positive(),
    includeGitDiffStat: z.boolean(),
  }),
  /** Validated per-scope inputs. Adapters need them for hybrid mode (project-only tracked files) and per-scope targets. */
  layers: z.strictObject({
    user: YokeConfigSchema.optional(),
    project: YokeConfigSchema.optional(),
    local: YokeConfigSchema.optional(),
  }),
});
export type ResolvedYokeConfig = z.infer<typeof ResolvedYokeConfigSchema>;

export type YokeDefaults = Pick<ResolvedYokeConfig, "mode" | "harnesses" | "session">;

/** Fresh object on each call, so no shared mutable defaults. Defaults, applied after merge and never written: mode compiled, harnesses [], session.maxTurns 40, session.includeGitDiffStat true. */
export function createYokeDefaults(): YokeDefaults {
  return {
    mode: "compiled",
    harnesses: [],
    session: { maxTurns: 40, includeGitDiffStat: true },
  };
}
// #endregion S5 resolved

// #region S6 native
/** A native instruction target as found on disk: either a real file (content) or a symlink (its target). */
export const NativeInstructionsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), path: z.string().min(1), content: z.string() }),
  z.strictObject({
    kind: z.literal("symlink"),
    path: z.string().min(1),
    target: z.string().min(1),
  }),
]);
export type NativeInstructions = z.infer<typeof NativeInstructionsSchema>;

/** One native tier, translated to canonical form. A disabled native entry becomes a full definition with enabled: false. */
export const NativeScopeStateSchema = z.strictObject({
  mcps: z.record(McpServerNameSchema, McpServerDefinitionSchema),
  instructions: NativeInstructionsSchema.optional(),
});
export type NativeScopeState = z.infer<typeof NativeScopeStateSchema>;

/**
 * Result of HarnessAdapter.readNativeState. A key is present only for tiers the harness exposes and the
 * adapter read. A present key with `mcps: {}` means "read, empty"; an absent key means "not supported or not read".
 */
export const PartialYokeConfigSchema = z.strictObject({
  user: NativeScopeStateSchema.optional(),
  project: NativeScopeStateSchema.optional(),
  local: NativeScopeStateSchema.optional(),
});
export type PartialYokeConfig = z.infer<typeof PartialYokeConfigSchema>;
// #endregion S6 native

// #region S7 options
/**
 * Options for HarnessAdapter.syncStatic . Planning only; adapters never see dry-run or force.
 * Plain interface, not a Zod schema: these are internal call arguments, not external input.
 */
export interface SyncOptions {
  /**
   * Absolute repo root. Project and local targets resolve against it (syncStatic has no repoPath parameter).
   */
  readonly repoPath: string;
  /**
   * Native scopes to plan, in any order. Command mapping:
   * `yoke sync` -> ["project", "local"]; `--global` -> ["user"]; `--all` -> ["user", "project", "local"].
   * The lock is keyed `<harness>:<scope>` (S2), so the adapter must know which scopes it plans.
   */
  readonly scopes: readonly Scope[];
  /**
   * Non-fatal warnings (for example, a transport or scope a harness cannot represent). Must not throw.
   * Adapters put warnings on FileChangePlan.warnings and do not call this; kept for adapter-interface compatibility.
   */
  readonly warn: (message: string) => void;
}

/**
 * Options for HarnessAdapter.importAndLaunch (used by `yoke switch`, v0.2).
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

/** Adapter-chosen id of a shared native name list, for example "disabled-servers". */
export const OwnedListIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const StateEntrySchema = z.strictObject({
  /** server name -> sha256 (hex) of the sorted-key canonical JSON of its canonical McpServerDefinition. */
  mcpHashes: z.record(McpServerNameSchema, Sha256HexSchema),
  /** sha256 of the last-written instruction target, or null when yoke wrote no instructions for this key. */
  instructionsHash: Sha256HexSchema.nullable(),
  /** Names yoke added to shared native name lists, per list id. Absent means none. Only these names are ever removed by yoke. */
  ownedNames: z.record(OwnedListIdSchema, z.array(McpServerNameSchema)).optional(),
});
export type StateEntry = z.infer<typeof StateEntrySchema>;

export const YokeStateLockSchema = z.strictObject({
  version: z.literal(1),
  lastSyncedAt: IsoDateTimeSchema,
  /** Field name harnesses kept for lock version 1; keys are StateKey, not bare harness names. */
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
