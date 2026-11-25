/**
 * src/core/secrets.ts — literal secret detection and `${VAR}` redaction (AGENTS.md invariant 4).
 * Policy: literal secret values are never written into generated project files; they are replaced by `${VAR}`
 * references kept in the target harness's native syntax.
 * Pure: no I/O, no clock, no process access. Inputs are never mutated.
 */
import type { EnvMap, McpServerDefinition, McpStdioServer } from "./schema.js";

export type SecretField = "env" | "headers" | "args" | "url";

export interface SecretFinding {
  readonly server: string;
  readonly field: SecretField;
  readonly key: string;
  readonly varName: string;
}

export interface RedactResult {
  /** Every input server; literal secrets replaced by `${VAR}`. */
  readonly safe: Readonly<Record<string, McpServerDefinition>>;
  /** Only servers with findings, as unchanged copies. */
  readonly original: Readonly<Record<string, McpServerDefinition>>;
  readonly findings: readonly SecretFinding[];
}

type Servers = Readonly<Record<string, McpServerDefinition>>;

const SECRET_KEY_RE =
  /(token|secret|passw(or)?d|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|cookie|session)/i;
const SECRET_PREFIX_RE =
  /^(sk-|sk_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|ya29\.|eyJ)/;
const LONG_TOKEN_RE = /^[A-Za-z0-9_\-+/=.]{32,}$/;
const VAR_REF_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AUTH_PREFIX_RE = /^(Bearer |Basic |Token )/;

/** A key whose name marks it as holding a credential. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** A value shaped like a credential, after an optional Bearer/Basic/Token prefix. */
export function looksSecretValue(value: string): boolean {
  if (VAR_REF_RE.test(value)) {
    return false;
  }
  const stripped = value.replace(AUTH_PREFIX_RE, "");
  if (stripped.length === 0) {
    return false;
  }
  if (SECRET_PREFIX_RE.test(stripped)) {
    return true;
  }
  return LONG_TOKEN_RE.test(stripped) && /[A-Za-z]/.test(stripped) && /[0-9]/.test(stripped);
}

/** Non-empty and free of `${NAME}` references, so it is a literal that yoke must redact. */
function isLiteral(value: string): boolean {
  return value.length > 0 && !VAR_REF_RE.test(value);
}

function ref(name: string): string {
  return `\${${name}}`;
}

/** Upper-case `<server>_<key>`-style name: non-alphanumerics to `_`, trimmed, `_` before a leading digit. */
function envName(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) {
    return "SECRET";
  }
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

type Allocate = (preferred: string | undefined, fallback: string, value: string) => string;

/**
 * Chooses variable names. The preferred name wins when free; a name already used for a different value
 * (or reserved by the caller) gets `_2`, `_3`, ... A name reused for the same value is shared.
 */
function createAllocator(taken: ReadonlySet<string>): Allocate {
  const used = new Map<string, string>();
  return (preferred, fallback, value) => {
    const usable = (name: string): boolean =>
      !taken.has(name) && (used.get(name) ?? value) === value;
    let chosen: string | undefined;
    if (preferred !== undefined && usable(preferred)) {
      chosen = preferred;
    }
    for (let i = 1; chosen === undefined; i++) {
      const candidate = i === 1 ? fallback : `${fallback}_${i}`;
      if (usable(candidate)) {
        chosen = candidate;
      }
    }
    used.set(chosen, value);
    return chosen;
  };
}

interface Ctx {
  readonly server: string;
  readonly alloc: Allocate;
  readonly findings: SecretFinding[];
}

function redactEnv(ctx: Ctx, env: EnvMap): EnvMap {
  const entries = Object.entries(env)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]): [string, string] => {
      if (!isLiteral(value) || !(isSecretKey(key) || looksSecretValue(value))) {
        return [key, value];
      }
      const preferred = ENV_NAME_RE.test(key) ? key : undefined;
      const varName = ctx.alloc(preferred, envName(`${ctx.server}_${key}`), value);
      ctx.findings.push({ server: ctx.server, field: "env", key, varName });
      return [key, ref(varName)];
    });
  return Object.fromEntries(entries);
}

function redactHeaders(
  ctx: Ctx,
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const entries = Object.entries(headers)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]): [string, string] => {
      const prefix = AUTH_PREFIX_RE.exec(value)?.[0] ?? "";
      const rest = value.slice(prefix.length);
      if (!isLiteral(rest) || !(isSecretKey(key) || looksSecretValue(rest))) {
        return [key, value];
      }
      const varName = ctx.alloc(undefined, envName(`${ctx.server}_${key}`), rest);
      ctx.findings.push({ server: ctx.server, field: "headers", key, varName });
      return [key, `${prefix}${ref(varName)}`];
    });
  return Object.fromEntries(entries);
}

function redactArgs(ctx: Ctx, args: readonly string[]): string[] {
  return args.map((arg, i) => {
    const flagged = /^(--?[A-Za-z][A-Za-z0-9_-]*)=(.*)$/s.exec(arg);
    if (flagged) {
      const flag = flagged[1] ?? "";
      const value = flagged[2] ?? "";
      const name = flag.replace(/^-+/, "");
      if (isLiteral(value) && (isSecretKey(name) || looksSecretValue(value))) {
        const varName = ctx.alloc(undefined, envName(`${ctx.server}_${name}`), value);
        ctx.findings.push({ server: ctx.server, field: "args", key: name, varName });
        return `${flag}=${ref(varName)}`;
      }
      return arg;
    }
    const prev = i > 0 ? (args[i - 1] ?? "") : "";
    const prevName = prev.replace(/^-+/, "");
    if (
      /^--?[A-Za-z]/.test(prev) &&
      !prev.includes("=") &&
      isSecretKey(prevName) &&
      isLiteral(arg) &&
      !arg.startsWith("-")
    ) {
      const varName = ctx.alloc(undefined, envName(`${ctx.server}_${prevName}`), arg);
      ctx.findings.push({ server: ctx.server, field: "args", key: prevName, varName });
      return ref(varName);
    }
    // Paths are not credentials, even when they are long and mixed-case.
    if (
      !arg.startsWith("-") &&
      !arg.includes("/") &&
      !arg.includes("\\") &&
      isLiteral(arg) &&
      looksSecretValue(arg)
    ) {
      const fallback = envName(`${ctx.server}_ARG${i}`);
      const varName = ctx.alloc(undefined, fallback, arg);
      ctx.findings.push({ server: ctx.server, field: "args", key: String(i), varName });
      return ref(varName);
    }
    return arg;
  });
}

function redactUrl(ctx: Ctx, url: string): string {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const fragment = hashAt >= 0 ? url.slice(hashAt) : "";
  const queryAt = beforeHash.indexOf("?");
  let base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : undefined;

  const userinfo = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i.exec(base);
  if (userinfo) {
    const info = userinfo[2] ?? "";
    const colon = info.indexOf(":");
    const password = colon >= 0 ? info.slice(colon + 1) : "";
    if (isLiteral(password)) {
      const varName = ctx.alloc(undefined, envName(`${ctx.server}_PASSWORD`), password);
      ctx.findings.push({ server: ctx.server, field: "url", key: "password", varName });
      const newInfo = `${info.slice(0, colon)}:${ref(varName)}`;
      base = `${userinfo[1] ?? ""}${newInfo}@${base.slice(userinfo[0].length)}`;
    }
  }

  let newQuery = query;
  if (query !== undefined) {
    newQuery = query
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0) {
          return pair;
        }
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (!isLiteral(value) || !(isSecretKey(key) || looksSecretValue(value))) {
          return pair;
        }
        const varName = ctx.alloc(undefined, envName(`${ctx.server}_${key}`), value);
        ctx.findings.push({ server: ctx.server, field: "url", key, varName });
        return `${key}=${ref(varName)}`;
      })
      .join("&");
  }

  return `${base}${newQuery !== undefined ? `?${newQuery}` : ""}${fragment}`;
}

function redactServer(
  server: string,
  def: McpServerDefinition,
  alloc: Allocate,
): { readonly def: McpServerDefinition; readonly findings: readonly SecretFinding[] } {
  const findings: SecretFinding[] = [];
  const ctx: Ctx = { server, alloc, findings };
  switch (def.transport) {
    case "stdio": {
      const next: McpStdioServer = { ...def };
      if (def.env !== undefined) {
        next.env = redactEnv(ctx, def.env);
      }
      if (def.args !== undefined) {
        next.args = redactArgs(ctx, def.args);
      }
      return { def: next, findings };
    }
    case "http":
    case "sse": {
      const next = { ...def };
      if (def.headers !== undefined) {
        next.headers = redactHeaders(ctx, def.headers);
      }
      next.url = redactUrl(ctx, def.url);
      return { def: next, findings };
    }
  }
}

/** Sorted server names with their definitions, so name allocation is deterministic. */
function sortedEntries(servers: Servers): [string, McpServerDefinition][] {
  return Object.entries(servers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Replaces every literal secret with a `${VAR}` reference. `taken` lists variable names the caller already
 * uses; they are never allocated.
 */
export function redactSecrets(
  servers: Servers,
  taken: ReadonlySet<string> = new Set(),
): RedactResult {
  const alloc = createAllocator(taken);
  const safeEntries: [string, McpServerDefinition][] = [];
  const originalEntries: [string, McpServerDefinition][] = [];
  const findings: SecretFinding[] = [];
  for (const [name, def] of sortedEntries(servers)) {
    const result = redactServer(name, def, alloc);
    safeEntries.push([name, result.def]);
    if (result.findings.length > 0) {
      originalEntries.push([name, structuredClone(def)]);
    }
    findings.push(...result.findings);
  }
  return {
    safe: Object.fromEntries(safeEntries),
    original: Object.fromEntries(originalEntries),
    findings,
  };
}

/** Literal secrets that would remain in `servers` (empty for redacted output). */
export function findLiteralSecrets(servers: Servers): readonly SecretFinding[] {
  return redactSecrets(servers).findings;
}
