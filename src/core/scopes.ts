/**
 * src/core/scopes.ts — 3-tier scope merge. Pure: no I/O, no environment reads, no clock.
 * Inputs are already-parsed, already-validated scope files; loading them is a separate step.
 *
 * Precedence is strictly local > project > user. `<userConfigDir>` is `$XDG_CONFIG_HOME/yoke` when
 * XDG_CONFIG_HOME is an absolute path, otherwise `~/.config/yoke`. An empty or comment-only scope file is rejected
 * (parseScopeConfig); every scope file needs at least `version: 1`.
 *
 * Merge rules, applied when the same MCP server name appears in more than one scope, in precedence order:
 * - Maps (`env`, `headers`) merge field by field; higher-precedence keys win.
 * - Arrays (`args`) are replaced whole, never concatenated.
 * - A change of `transport` replaces the whole server entry; no fields are inherited from the lower scope.
 * - `enabled: false` with no `transport` is not a transport change. It is a stub that suppresses the inherited entry.
 * - `enabled` across a redefinition: a same-transport override that omits `enabled` keeps the inherited value, so a
 *   disabled server stays disabled. A transport change resets `enabled` to true unless the override sets it.
 * - Non-MCP keys (`mode`, `session`, and so on) take the value from the highest scope that sets them. `harnesses`
 *   is replaced whole, never merged.
 * - Full definitions only: every non-stub entry must be a complete definition with a `transport`. Partial overrides
 *   of a lower-scope server (for example, only `env` in yoke.local.yaml) are not valid.
 * - Whether `null` should later remove an inherited field is an open item (decision-5); YAML `null` is rejected in v0.1.
 */
import { dirname, isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
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
  YokeConfigSchema,
} from "./schema.js";

export interface ScopeInput {
  readonly config: YokeConfig;
  /** absolute dir of the yaml file */
  readonly baseDir: string;
}

export type ScopeInputs = Partial<Record<Scope, ScopeInput>>;

export interface ResolveOptions {
  /** absolute repo root */
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

/** Merge two full definitions that share a transport. Returns a fresh object. */
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

/** Merge all scopes into the effective config, local > project > user. Defaults come from createYokeDefaults(); merge rules are in the file header. */
export function resolveConfig(inputs: ScopeInputs, opts: ResolveOptions): ResolvedYokeConfig {
  if (!isAbsolute(opts.projectDir)) {
    throw new Error(`projectDir must be an absolute path: ${opts.projectDir}`);
  }

  const defaults = createYokeDefaults();
  let mode = defaults.mode;
  let harnesses: string[] = defaults.harnesses;
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
    const { config } = input;
    layers[scope] = structuredClone(config);

    if (config.mode !== undefined) {
      mode = config.mode;
    }
    if (config.harnesses !== undefined) {
      harnesses = [...config.harnesses];
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
    session: { maxTurns, includeGitDiffStat },
    layers,
  });
}

// #region R2 loader
/** Reads a file as UTF-8 text. `undefined` means the file does not exist. */
export type ReadText = (path: string) => Promise<string | undefined>;

export type Env = Readonly<Record<string, string | undefined>>;

/** Absolute paths of the yaml files for each scope. `user` is omitted when no user config dir applies. */
export interface ScopePaths {
  readonly user?: string;
  readonly project: string;
  readonly local: string;
}

/** `XDG_CONFIG_HOME/yoke` when that variable is absolute, otherwise `<homeDir>/.config/yoke`. */
export function userConfigDir(env: Env, homeDir: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homeDir, ".config");
  return join(base, "yoke");
}

export function defaultScopePaths(opts: {
  readonly repoRoot: string;
  readonly userConfigDir?: string;
}): ScopePaths {
  if (!isAbsolute(opts.repoRoot)) {
    throw new Error(`repoRoot must be an absolute path: ${opts.repoRoot}`);
  }
  const repo = {
    project: join(opts.repoRoot, "yoke.yaml"),
    local: join(opts.repoRoot, "yoke.local.yaml"),
  };
  if (opts.userConfigDir === undefined) {
    return repo;
  }
  return { user: join(opts.userConfigDir, "yoke.yaml"), ...repo };
}

export class ScopeConfigError extends Error {
  constructor(
    message: string,
    readonly scope: Scope,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ScopeConfigError";
  }
}

/** Parses and validates one scope file. No defaults are applied. */
export function parseScopeConfig(text: string, scope: Scope, path: string): YokeConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScopeConfigError(`${path}: ${detail}`, scope, path, { cause: error });
  }
  if (doc === null) {
    throw new ScopeConfigError(
      `${path}: file is empty; expected at least "version: 1"`,
      scope,
      path,
    );
  }
  const result = YokeConfigSchema.safeParse(doc);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${path}: ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new ScopeConfigError(lines.join("\n"), scope, path, { cause: result.error });
  }
  return result.data;
}

/** Reads all present scope files in parallel. A missing file is omitted from the result. */
export async function loadScopeInputs(read: ReadText, paths: ScopePaths): Promise<ScopeInputs> {
  const entries: [Scope, string][] = [];
  if (paths.user !== undefined) {
    entries.push(["user", paths.user]);
  }
  entries.push(["project", paths.project], ["local", paths.local]);

  for (const [, path] of entries) {
    if (!isAbsolute(path)) {
      throw new Error(`scope path must be absolute: ${path}`);
    }
  }

  const texts = await Promise.all(entries.map(([, path]) => read(path)));
  const inputs: ScopeInputs = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const text = texts[i];
    if (entry === undefined || text === undefined) {
      continue;
    }
    const [scope, path] = entry;
    inputs[scope] = { config: parseScopeConfig(text, scope, path), baseDir: dirname(path) };
  }
  return inputs;
}
// #endregion R2 loader
