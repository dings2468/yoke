/**
 * src/core/drift.ts — canonical hashing for the lock files and the desired-state types for the three-way drift check.
 * Pure functions only: no file I/O, no process state, no clock, no home directory.
 *
 * Hash format: lowercase hex sha256 with no `sha256:` prefix (64 characters). The hashed input is the sorted-key
 * canonical JSON of the value: keys sorted recursively, array order kept, no whitespace, `undefined`-valued keys
 * omitted, UTF-8. Symlinked instructions are hashed as `{kind:"symlink",target}` and files as `{kind:"file",content}`
 * (decision-0012), so editing AGENTS.md behind an instruction-file symlink is not drift.
 *
 * Three-way drift check (run before yoke overwrites native files):
 * 1. Reverse-read: the source adapter's readNativeState parses the harness's current native MCPs and instructions
 *    back into canonical form.
 * 2. Diff against the lock: any server or instruction block whose hash differs from the last-synced hash is flagged
 *    as a native mutation. This module only detects and reports; the gate in plan.ts decides what happens next.
 * 3. Prompt (v0.1): the user chooses between overwriting with the yoke config and aborting. Non-interactive runs
 *    abort unless `--force` is passed. The original file is backed up before any overwrite (AGENTS.md invariant 2).
 */
import { createHash } from "node:crypto";
import type {
  McpHttpServer,
  McpServerDefinition,
  McpSseServer,
  NativeInstructions,
  NativeScopeState,
  Scope,
  StateEntry,
  StateKey,
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

/** sha256 of the canonical JSON of the normalized MCP definition. */
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
      /** null = the instruction file is absent after the plan. */
      readonly instructions: NativeInstructions | null;
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
  /** undefined = instructions are not managed; null = the instruction file is absent. */
  readonly instructions?: NativeInstructions | null;
  readonly ownedNames?: Readonly<Record<string, readonly string[]>>;
}

// #endregion DR1 desired state

// #region DR2 diff

/** Desired state of one scope, with the duplicate-key checks applied while grouping. */
interface MutableScopeGroup {
  mcps?: Map<string, McpServerDefinition>;
  instructions?: NativeInstructions | null;
  ownedNames?: Map<string, readonly string[]>;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnion(lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())].sort(compareCodeUnits);
}

/**
 * Group a plan's expected targets into desired state per scope. Several `mcps` targets of one scope are merged;
 * a server name repeated in one scope throws. A second instructions target or a repeated owned-names list throws.
 */
export function groupExpected(
  targets: readonly ExpectedTarget[],
): Partial<Record<Scope, DesiredScopeState>> {
  const groups = new Map<Scope, MutableScopeGroup>();
  for (const target of targets) {
    const group = groups.get(target.scope) ?? {};
    groups.set(target.scope, group);
    switch (target.kind) {
      case "mcps": {
        const mcps = group.mcps ?? new Map<string, McpServerDefinition>();
        group.mcps = mcps;
        for (const [name, def] of Object.entries(target.mcps)) {
          if (mcps.has(name)) {
            throw new Error(`duplicate MCP server ${name} in ${target.scope} scope`);
          }
          mcps.set(name, def);
        }
        break;
      }
      case "instructions":
        if (group.instructions !== undefined) {
          throw new Error(`duplicate instructions target in ${target.scope} scope`);
        }
        group.instructions = target.instructions;
        break;
      case "owned-names": {
        const owned = group.ownedNames ?? new Map<string, readonly string[]>();
        group.ownedNames = owned;
        if (owned.has(target.list)) {
          throw new Error(`duplicate owned-names list ${target.list} in ${target.scope} scope`);
        }
        owned.set(target.list, [...target.names]);
        break;
      }
    }
  }
  const out: Partial<Record<Scope, DesiredScopeState>> = {};
  for (const [scope, group] of groups) {
    out[scope] = {
      ...(group.mcps !== undefined ? { mcps: Object.fromEntries(group.mcps) } : {}),
      ...(group.instructions !== undefined ? { instructions: group.instructions } : {}),
      ...(group.ownedNames !== undefined
        ? { ownedNames: Object.fromEntries(group.ownedNames) }
        : {}),
    };
  }
  return out;
}

/**
 * Lock entry for one scope, as written after a sync. `ownedNames` appears only when some list is non-empty;
 * names and list ids are sorted and empty lists are left out.
 */
export function stateEntryFor(desired: DesiredScopeState): StateEntry {
  const mcpHashes = Object.fromEntries(
    Object.entries(desired.mcps ?? {})
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([name, def]): [string, string] => [name, hashMcp(def)]),
  );
  const instructionsHash =
    desired.instructions === undefined || desired.instructions === null
      ? null
      : hashInstructions(desired.instructions);
  const lists = Object.entries(desired.ownedNames ?? {})
    .filter(([, names]) => names.length > 0)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([list, names]): [string, string[]] => [list, [...names].sort(compareCodeUnits)]);
  return {
    mcpHashes,
    instructionsHash,
    ...(lists.length > 0 ? { ownedNames: Object.fromEntries(lists) } : {}),
  };
}

/** Drift status of one entry: `in-sync`/`stale` are clean; `create`, `added`, `modified`, `removed` are reported. */
export type EntryStatus = "in-sync" | "stale" | "create" | "added" | "modified" | "removed";

/** Statuses that count as drift. */
export const DRIFT_STATUSES: readonly EntryStatus[] = ["added", "modified", "removed"];

/**
 * Classify one entry from its hashes (checked in this order). `native` is the hash of the file on disk, `lock` the hash recorded at
 * the last sync, `desired` the hash of what yoke would write now. An absent hash means the item is missing.
 */
export function classifyEntry(h: {
  readonly native?: string;
  readonly lock?: string;
  readonly desired?: string;
}): EntryStatus {
  if (h.native !== undefined && h.native === h.desired) {
    return "in-sync";
  }
  if (h.native === undefined && h.lock === undefined) {
    return "create";
  }
  if (h.native !== undefined && h.native === h.lock) {
    return "stale";
  }
  if (h.native === undefined) {
    return "removed";
  }
  if (h.lock === undefined) {
    return "added";
  }
  return "modified";
}

export interface McpDriftEntry {
  readonly name: string;
  readonly status: EntryStatus;
  readonly native: McpServerDefinition | undefined;
  readonly desired: McpServerDefinition | undefined;
}

export interface InstructionsDriftEntry {
  readonly status: EntryStatus;
  /** From the desired target, else the native one. */
  readonly path: string;
  readonly native: NativeInstructions | undefined;
  /** null = the desired state is an absent instruction file. */
  readonly desired: NativeInstructions | null;
}

export interface ScopeDriftInput {
  readonly key: StateKey;
  /** undefined = the harness did not read this tier (treated as no MCPs and no instructions). */
  readonly native: NativeScopeState | undefined;
  /** undefined = no lock entry for this key yet. */
  readonly lock: StateEntry | undefined;
  readonly desired: DesiredScopeState;
}

export interface ScopeDriftReport {
  readonly key: StateKey;
  readonly mcps: readonly McpDriftEntry[];
  readonly instructions: InstructionsDriftEntry | undefined;
  readonly hasDrift: boolean;
}

export interface DriftReport {
  readonly scopes: readonly ScopeDriftReport[];
  readonly hasDrift: boolean;
}

/**
 * Compare native, lock, and desired for one scope (detect and report only; the gate in plan.ts decides). MCPs are compared only when
 * `desired.mcps` is set; instructions only when `desired.instructions` is set. A `null` lock hash counts as absent.
 * `ownedNames` is bookkeeping and is never compared.
 */
export function diffScope(input: ScopeDriftInput): ScopeDriftReport {
  const mcps: McpDriftEntry[] = [];
  if (input.desired.mcps !== undefined) {
    const nativeMap = new Map(Object.entries(input.native?.mcps ?? {}));
    const lockMap = new Map(Object.entries(input.lock?.mcpHashes ?? {}));
    const desiredMap = new Map(Object.entries(input.desired.mcps));
    for (const name of sortedUnion([
      [...nativeMap.keys()],
      [...lockMap.keys()],
      [...desiredMap.keys()],
    ])) {
      const native = nativeMap.get(name);
      const desired = desiredMap.get(name);
      const status = classifyEntry({
        native: native === undefined ? undefined : hashMcp(native),
        lock: lockMap.get(name),
        desired: desired === undefined ? undefined : hashMcp(desired),
      });
      mcps.push({ name, status, native, desired });
    }
  }

  let instructions: InstructionsDriftEntry | undefined;
  if (input.desired.instructions !== undefined) {
    const desired = input.desired.instructions;
    const native = input.native?.instructions;
    const path = desired?.path ?? native?.path;
    // Absent on both sides: nothing is written and nothing is on disk, so there is no entry to report.
    if (path !== undefined) {
      const status = classifyEntry({
        native: native === undefined ? undefined : hashInstructions(native),
        lock: input.lock?.instructionsHash ?? undefined,
        desired: desired === null ? undefined : hashInstructions(desired),
      });
      instructions = { status, path, native, desired };
    }
  }

  const hasDrift =
    mcps.some((entry) => DRIFT_STATUSES.includes(entry.status)) ||
    (instructions !== undefined && DRIFT_STATUSES.includes(instructions.status));
  return { key: input.key, mcps, instructions, hasDrift };
}

/** Run `diffScope` over every scope; `hasDrift` is true when any scope reports drift. Input order is kept. */
export function detectDrift(inputs: readonly ScopeDriftInput[]): DriftReport {
  const scopes = inputs.map((input) => diffScope(input));
  return { scopes, hasDrift: scopes.some((scope) => scope.hasDrift) };
}

// #endregion DR2 diff
