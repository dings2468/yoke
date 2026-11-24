/**
 * src/core/scopes.ts — 3-tier scope merge (SPEC §3.1, §4.1). Pure: no I/O, no environment reads, no clock.
 * Inputs are already-parsed, already-validated scope files; loading them is a separate step.
 */
import { isAbsolute, resolve } from "node:path";
import {
  createYokeDefaults,
  isMcpDisabledStub,
  type McpHttpServer,
  type McpServerDefinition,
  type McpServerEntry,
  type McpSseServer,
  type McpStdioServer,
  type ResolvedMcpServer,
  type ResolvedYokeConfig,
  ResolvedYokeConfigSchema,
  SCOPES,
  type Scope,
  type YokeConfig,
} from "./schema.js";

export interface ScopeInput {
  readonly config: YokeConfig;
  /** absolute dir of the yaml file */
  readonly baseDir: string;
}

export type ScopeInputs = Partial<Record<Scope, ScopeInput>>;

export interface ResolveOptions {
  /** absolute repo root; default instructions.source resolves here */
  readonly projectDir: string;
  readonly warn: (message: string) => void;
}

export function stubWarning(name: string, scope: Scope): string {
  return `mcps.${name}: "enabled: false" in ${scope} scope has no lower-scope definition to suppress; ignored`;
}

interface Accumulated {
  definition: McpServerDefinition;
  enabled: boolean;
  scopes: Scope[];
}

function assertNever(value: never): never {
  throw new Error(`unhandled transport: ${JSON.stringify(value)}`);
}

/** Field-level map merge: higher keys win. Returns undefined only when neither side has the map. */
function mergeMaps(
  lower: Record<string, string> | undefined,
  higher: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (lower === undefined && higher === undefined) {
    return undefined;
  }
  return { ...lower, ...higher };
}

/** Merge two full definitions that share a transport (SPEC §3.1). Returns a fresh object. */
function mergeSameTransport(
  lower: McpServerDefinition,
  higher: McpServerDefinition,
): McpServerDefinition {
  switch (higher.transport) {
    case "stdio": {
      if (lower.transport !== "stdio") {
        throw new Error("internal: mergeSameTransport called with mismatched transports");
      }
      const merged: McpStdioServer = { transport: "stdio", command: higher.command };
      const args = higher.args ?? lower.args;
      if (args !== undefined) {
        merged.args = [...args];
      }
      const env = mergeMaps(lower.env, higher.env);
      if (env !== undefined) {
        merged.env = env;
      }
      return merged;
    }
    case "http":
    case "sse": {
      if (lower.transport === "stdio" || lower.transport !== higher.transport) {
        throw new Error("internal: mergeSameTransport called with mismatched transports");
      }
      const merged: McpHttpServer | McpSseServer = { ...higher };
      const headers = mergeMaps(lower.headers, higher.headers);
      if (headers !== undefined) {
        merged.headers = headers;
      }
      return merged;
    }
    default:
      return assertNever(higher);
  }
}

function applyEntry(
  accumulated: Map<string, Accumulated>,
  name: string,
  scope: Scope,
  entry: McpServerEntry,
  warn: (message: string) => void,
): void {
  const existing = accumulated.get(name);

  if (isMcpDisabledStub(entry)) {
    if (existing === undefined) {
      warn(stubWarning(name, scope));
      return;
    }
    existing.enabled = false;
    existing.scopes.push(scope);
    return;
  }

  if (existing === undefined || existing.definition.transport !== entry.transport) {
    // A transport change (or a first definition) replaces the whole entry: nothing is inherited.
    accumulated.set(name, {
      definition: structuredClone(entry),
      enabled: entry.enabled ?? true,
      scopes: [scope],
    });
    return;
  }

  existing.definition = mergeSameTransport(existing.definition, entry);
  existing.enabled = entry.enabled ?? existing.enabled;
  existing.scopes.push(scope);
}

/**
 * Merge MCP servers across scopes, ascending precedence (user -> project -> local).
 * Output keys are sorted by code unit. Every value is a fresh copy, so callers may mutate the result.
 */
export function mergeMcpServers(
  inputs: ScopeInputs,
  warn: (message: string) => void,
): Record<string, ResolvedMcpServer> {
  const accumulated = new Map<string, Accumulated>();
  for (const scope of SCOPES) {
    const input = inputs[scope];
    if (input === undefined) {
      continue;
    }
    for (const [name, entry] of Object.entries(input.config.mcps ?? {})) {
      applyEntry(accumulated, name, scope, entry, warn);
    }
  }

  const sorted = [...accumulated.entries()].sort(([a], [b]) => {
    if (a < b) {
      return -1;
    }
    return a > b ? 1 : 0;
  });
  return Object.fromEntries(
    sorted.map(([name, acc]) => [
      name,
      { ...acc.definition, enabled: acc.enabled, scopes: [...acc.scopes] },
    ]),
  );
}

/** Merge all scopes into the effective config. Defaults come from createYokeDefaults(). */
export function resolveConfig(inputs: ScopeInputs, opts: ResolveOptions): ResolvedYokeConfig {
  if (!isAbsolute(opts.projectDir)) {
    throw new Error(`projectDir must be an absolute path: ${opts.projectDir}`);
  }

  const defaults = createYokeDefaults();
  let mode = defaults.mode;
  let harnesses: string[] = defaults.harnesses;
  let source = resolve(opts.projectDir, defaults.instructions.source);
  let preferSymlink = defaults.instructions.preferSymlink;
  let maxTurns = defaults.session.maxTurns;
  let includeGitDiffStat = defaults.session.includeGitDiffStat;
  const layers: ResolvedYokeConfig["layers"] = {};

  for (const scope of SCOPES) {
    const input = inputs[scope];
    if (input === undefined) {
      continue;
    }
    if (!isAbsolute(input.baseDir)) {
      throw new Error(`${scope} baseDir must be an absolute path: ${input.baseDir}`);
    }
    const { config, baseDir } = input;
    layers[scope] = structuredClone(config);

    if (config.mode !== undefined) {
      mode = config.mode;
    }
    if (config.harnesses !== undefined) {
      harnesses = [...config.harnesses];
    }
    if (config.instructions?.source !== undefined) {
      source = resolve(baseDir, config.instructions.source);
    }
    if (config.instructions?.preferSymlink !== undefined) {
      preferSymlink = config.instructions.preferSymlink;
    }
    if (config.session?.maxTurns !== undefined) {
      maxTurns = config.session.maxTurns;
    }
    if (config.session?.includeGitDiffStat !== undefined) {
      includeGitDiffStat = config.session.includeGitDiffStat;
    }
  }

  return ResolvedYokeConfigSchema.parse({
    version: 1,
    mode,
    harnesses,
    mcps: mergeMcpServers(inputs, opts.warn),
    instructions: { source, preferSymlink },
    session: { maxTurns, includeGitDiffStat },
    layers,
  });
}
