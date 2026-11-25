/**
 * src/commands/doctor-format.ts — doctor report types, plain-text formatter and exit mapping.
 * Pure: no IO, no process access. Callers pass the TTY flag and environment in.
 */
import pc from "picocolors";
import { EXIT_OK, EXIT_PROBLEMS } from "./exit.js";

export type CheckStatus = "ok" | "info" | "warn" | "unknown" | "problem";
export type CheckKind =
  | "repo"
  | "config"
  | "lock"
  | "binary"
  | "auth"
  | "symlink"
  | "drift"
  | "plan";

export interface DoctorCheck {
  readonly kind: CheckKind;
  readonly subject: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly hint?: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
}

export interface ColorIo {
  readonly isTTY: boolean | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const TAGS: Readonly<Record<CheckStatus, string>> = {
  ok: "ok",
  info: "info",
  warn: "warn",
  unknown: "unknown",
  problem: "PROBLEM",
};

/** Exit code for a doctor report: 1 when any check is a problem, otherwise 0. */
export function doctorExitCode(report: DoctorReport): typeof EXIT_OK | typeof EXIT_PROBLEMS {
  return report.checks.some((check) => check.status === "problem") ? EXIT_PROBLEMS : EXIT_OK;
}

/**
 * Colour is used only on a TTY, when NO_COLOR is unset or empty, and when TERM is not "dumb".
 */
export function shouldUseColor(io: ColorIo): boolean {
  const noColor = io.env.NO_COLOR;
  const noColorSet = noColor !== undefined && noColor !== "";
  return io.isTTY === true && !noColorSet && io.env.TERM !== "dumb";
}

function plural(count: number, singular: string, plainPlural: string): string {
  return `${count} ${count === 1 ? singular : plainPlural}`;
}

function summaryLine(report: DoctorReport): string {
  const counts: Record<CheckStatus, number> = { ok: 0, info: 0, warn: 0, unknown: 0, problem: 0 };
  for (const check of report.checks) {
    counts[check.status] += 1;
  }
  const parts: string[] = [];
  if (counts.problem > 0) parts.push(plural(counts.problem, "problem", "problems"));
  if (counts.warn > 0) parts.push(plural(counts.warn, "warning", "warnings"));
  if (counts.unknown > 0) parts.push(`${counts.unknown} unknown`);
  if (parts.length === 0) return "doctor: no problems found";
  return `doctor: ${parts.join(", ")}`;
}

/**
 * Renders one line per check, an optional hint line, and a final summary line.
 * The tag column is coloured only when `opts.color` is true.
 */
export function formatDoctorReport(
  report: DoctorReport,
  opts: { readonly color: boolean },
): string {
  const colors = pc.createColors(opts.color);
  const paint: Record<CheckStatus, (text: string) => string> = {
    ok: colors.green,
    info: colors.dim,
    warn: colors.yellow,
    unknown: colors.cyan,
    problem: colors.red,
  };

  const lines: string[] = [];
  for (const check of report.checks) {
    const tag = paint[check.status](TAGS[check.status].padEnd(7));
    lines.push(`${tag} ${check.kind} ${check.subject}: ${check.message}`);
    if (check.hint !== undefined) {
      lines.push(`  hint: ${check.hint}`);
    }
  }
  lines.push(summaryLine(report));
  return `${lines.join("\n")}\n`;
}
