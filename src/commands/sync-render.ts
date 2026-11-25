/**
 * src/commands/sync-render.ts — pure renderer for sync plans, drift gates, refusals, and results.
 * Pure: no IO, no clock, no environment. The same functions serve dry-run and real runs, so their output
 * is identical for the same plan. Every printed diff line passes through maskSecretLine.
 */
import pc from "picocolors";
import type { FileChangeAction } from "../adapters/base.js";
import type { DriftReport, EntryStatus } from "../core/drift.js";
import { DRIFT_STATUSES } from "../core/drift.js";
import type { GateReason, PlannedChange, SyncResult } from "../core/plan.js";
import { isSecretKey, looksSecretValue } from "../core/secrets.js";

export interface RenderOptions {
  readonly color: boolean;
  readonly repoPath: string;
  readonly homeDir: string;
  readonly dryRun: boolean;
  /** "yoke sync" | "yoke init" */
  readonly command: string;
}

export type DiffLine = { readonly kind: " " | "-" | "+" | "@"; readonly text: string };

const CONTEXT_LINES = 3;
const MAX_DIFF_CELLS = 4_000_000;
const REDACTED = "<redacted>";
/** `key: value` or `"key": "value"`, with an optional trailing comma. Group 3 is an opening quote, group 5 a closing one. */
const KEY_VALUE_RE = /^(\s*"?([^"\s:]+)"?\s*:\s*)("?)(.*?)("?)(,?\s*)$/;

/** Empty text has no lines, so a missing `before` (passed as "") makes every line an addition. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * Line diff by longest common subsequence. `before` undefined means every line is an addition. When the product of
 * line counts exceeds 4,000,000, the diff is replaced by a single "@" marker line with the counts.
 * `context` is the number of unchanged lines kept around each change; hunks are separated by "@@" lines.
 */
export function lineDiff(before: string, after: string, context: number): readonly DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_DIFF_CELLS) {
    return [{ kind: "@", text: `(diff too large: -${n} +${m} lines)` }];
  }

  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * width + j;
      lcs[idx] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const ops: { kind: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      ops.push({ kind: "-", text: a[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j] ?? "" });
      j++;
    }
  }
  for (; i < n; i++) {
    ops.push({ kind: "-", text: a[i] ?? "" });
  }
  for (; j < m; j++) {
    ops.push({ kind: "+", text: b[j] ?? "" });
  }

  const keep = ops.map(() => false);
  ops.forEach((op, k) => {
    if (op.kind !== " ") {
      const lo = Math.max(0, k - context);
      const hi = Math.min(ops.length - 1, k + context);
      for (let q = lo; q <= hi; q++) {
        keep[q] = true;
      }
    }
  });

  const out: DiffLine[] = [];
  let previous = -2;
  ops.forEach((op, k) => {
    if (!keep[k]) {
      return;
    }
    if (previous >= 0 && k !== previous + 1) {
      out.push({ kind: "@", text: "@@" });
    }
    out.push({ kind: op.kind, text: op.text });
    previous = k;
  });
  return out;
}

/** Replaces the value of a secret-looking `key: value` line with `<redacted>`. Values with `${` references are kept. */
export function maskSecretLine(line: string): string {
  const match = KEY_VALUE_RE.exec(line);
  if (match === null) {
    return line;
  }
  const [, prefix = "", key = "", openQuote = "", value = "", closeQuote = "", suffix = ""] = match;
  if (value.length === 0 || value.includes("${")) {
    return line;
  }
  if (!isSecretKey(key) && !looksSecretValue(value)) {
    return line;
  }
  return `${prefix}${openQuote}${REDACTED}${closeQuote}${suffix}`;
}

/** Repo-relative inside the repo, `~/...` under the home directory, otherwise the path unchanged. */
export function displayPath(path: string, o: Pick<RenderOptions, "repoPath" | "homeDir">): string {
  if (path === o.repoPath) {
    return ".";
  }
  if (path.startsWith(`${o.repoPath}/`)) {
    return path.slice(o.repoPath.length + 1);
  }
  if (path.startsWith(`${o.homeDir}/`)) {
    return `~/${path.slice(o.homeDir.length + 1)}`;
  }
  return path;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function paint(o: Pick<RenderOptions, "color">) {
  return pc.createColors(o.color);
}

function changeMarker(action: FileChangeAction): string {
  switch (action) {
    case "create":
      return "+ create";
    case "update":
      return "~ update";
    case "patch-json":
      return "* patch-json";
    case "symlink":
      return "> symlink";
    case "remove":
      return "- remove";
    case "noop":
      return "noop";
  }
}

function diffFor(change: PlannedChange): readonly DiffLine[] {
  const plan = change.plan;
  if (plan.action === "symlink" || plan.after === undefined) {
    return [];
  }
  const context = plan.action === "patch-json" ? 0 : CONTEXT_LINES;
  return lineDiff(plan.before ?? "", plan.after, context);
}

function renderDiffLine(line: DiffLine, o: Pick<RenderOptions, "color">): string {
  const c = paint(o);
  if (line.kind === "@") {
    return c.dim(`    ${line.text}`);
  }
  const text = maskSecretLine(line.text);
  if (line.kind === "+") {
    return c.green(`    +${text}`);
  }
  if (line.kind === "-") {
    return c.red(`    -${text}`);
  }
  return `     ${text}`;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Plan block (S5 steps 1 to 3): header, one entry per non-noop change with its diff, then warnings.
 * Returns lines joined with "\n" and no trailing newline.
 */
export function renderPlan(
  changes: readonly PlannedChange[],
  warnings: readonly string[],
  o: RenderOptions,
): string {
  const c = paint(o);
  const active = changes.filter((change) => change.plan.action !== "noop");
  const unchanged = changes.length - active.length;
  const dry = o.dryRun ? " --dry-run" : "";
  const lines: string[] = [
    c.bold(
      `${o.command}${dry}: ${plural(active.length, "change", "changes")}, ${unchanged} unchanged`,
    ),
  ];

  for (const change of active) {
    const plan = change.plan;
    const path = displayPath(plan.path, o);
    lines.push(
      `${changeMarker(plan.action)} ${path} (${change.harness}, ${plan.scope}): ${plan.summary}`,
    );
    if (plan.action === "symlink" || (plan.action === "remove" && plan.link !== undefined)) {
      const before = plan.link?.before ?? "(none)";
      const after = plan.link?.after ?? "(none)";
      lines.push(`    link: ${before} -> ${after}`);
    }
    for (const line of diffFor(change)) {
      lines.push(renderDiffLine(line, o));
    }
  }

  const unique = uniqueInOrder(warnings);
  if (unique.length > 0) {
    lines.push("warnings:");
    for (const warning of unique) {
      lines.push(`  ${warning}`);
    }
  }
  return lines.join("\n");
}

function driftMarker(status: EntryStatus): string {
  switch (status) {
    case "added":
      return "+";
    case "modified":
      return "~";
    case "removed":
      return "-";
    default:
      return " ";
  }
}

function renderMarker(status: EntryStatus, o: Pick<RenderOptions, "color">): string {
  const c = paint(o);
  const marker = driftMarker(status);
  if (marker === "+") {
    return c.green(marker);
  }
  if (marker === "-") {
    return c.red(marker);
  }
  if (marker === "~") {
    return c.yellow(marker);
  }
  return marker;
}

function isDriftStatus(status: EntryStatus): boolean {
  return DRIFT_STATUSES.includes(status);
}

/**
 * Gate entries (D2): drift lines grouped by `<harness>:<scope>`, then lock-corrupt and drift-unchecked reasons.
 * Returns lines joined with "\n" and no trailing newline.
 */
export function renderGate(
  reasons: readonly GateReason[],
  drift: DriftReport,
  o: Pick<RenderOptions, "color" | "repoPath" | "homeDir">,
): string {
  const lines: string[] = [];
  for (const scope of drift.scopes) {
    const mcps = scope.mcps.filter((entry) => isDriftStatus(entry.status));
    const instructions =
      scope.instructions !== undefined && isDriftStatus(scope.instructions.status)
        ? scope.instructions
        : undefined;
    if (mcps.length === 0 && instructions === undefined) {
      continue;
    }
    lines.push(`  ${scope.key}`);
    for (const entry of mcps) {
      lines.push(
        `    ${renderMarker(entry.status, o)} MCP server "${entry.name}" (${entry.status})`,
      );
    }
    if (instructions !== undefined) {
      const path = displayPath(instructions.path, o);
      lines.push(
        `    ${renderMarker(instructions.status, o)} instructions ${path} (${instructions.status})`,
      );
    }
  }

  for (const reason of reasons) {
    if (reason.kind === "lock-corrupt") {
      const path = displayPath(reason.path, o);
      lines.push(`  ${path} is not a valid lock (${reason.reason}); it would be replaced`);
    } else if (reason.kind === "drift-unchecked") {
      lines.push(`  ${reason.harness}: drift not checked; native state could not be read`);
    }
  }
  return lines.join("\n");
}

/**
 * Refusal text (D2). Non-interactive: the refused header, the gate block, and the --force hint.
 * Interactive (the user chose Abort): the aborted line, followed by the gate block.
 */
export function renderRefusal(
  reasons: readonly GateReason[],
  drift: DriftReport,
  o: RenderOptions & { readonly interactive: boolean },
): string {
  const gate = renderGate(reasons, drift, o);
  const body = gate.length > 0 ? [gate] : [];
  if (o.interactive) {
    return ["aborted; nothing was written", ...body].join("\n");
  }
  return [
    `${o.command}: refused: native changes since the last sync; nothing was written.`,
    ...body,
    "Rerun with --force to overwrite (originals are backed up), or run in a terminal to confirm.",
  ].join("\n");
}

/**
 * Result block (S12). Lines joined with "\n" and no trailing newline.
 */
export function renderResult(
  result: SyncResult,
  planWarnings: readonly string[],
  o: RenderOptions,
): string {
  const lines: string[] = [];
  const written = result.applied.filter((change) => change.result.status !== "unchanged");
  for (const change of written) {
    const path = displayPath(change.path, o);
    if (change.result.status === "fallback") {
      const detail = change.result.detail ?? "";
      lines.push(`fallback: ${path}: ${detail}`);
    } else {
      const backup = change.result.backupPath;
      const suffix = backup === undefined ? "" : ` (backup: ${displayPath(backup, o)})`;
      lines.push(`written: ${path}${suffix}`);
    }
  }

  const known = new Set(planWarnings);
  for (const note of uniqueInOrder(result.warnings)) {
    if (!known.has(note)) {
      lines.push(`note: ${note}`);
    }
  }
  for (const lockPath of result.locksWritten) {
    lines.push(`lock: ${displayPath(lockPath, o)}`);
  }
  if (result.backupDir !== undefined) {
    lines.push(`backups: ${displayPath(result.backupDir, o)}`);
  }
  lines.push(
    written.length === 0 ? "nothing to do" : `synced ${plural(written.length, "file", "files")}`,
  );
  return lines.join("\n");
}
