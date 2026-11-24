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
// (S2 content)
// #endregion S2 state

// #region S3 session
// (S3 content)
// #endregion S3 session
