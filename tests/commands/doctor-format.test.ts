import { describe, expect, it } from "vitest";
import {
  type DoctorCheck,
  type DoctorReport,
  doctorExitCode,
  formatDoctorReport,
  shouldUseColor,
} from "../../src/commands/doctor-format.js";
import { EXIT_OK, EXIT_PROBLEMS, UsageError } from "../../src/commands/exit.js";

const ESC = String.fromCharCode(27);
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function check(overrides: Partial<DoctorCheck> & Pick<DoctorCheck, "status">): DoctorCheck {
  return {
    kind: "repo",
    subject: "project",
    message: "message",
    ...overrides,
  };
}

const MIXED: DoctorReport = {
  checks: [
    check({ kind: "repo", subject: "project", status: "ok", message: "git root found" }),
    check({
      kind: "binary",
      subject: "alpha",
      status: "problem",
      message: "not installed",
      hint: "install alpha",
    }),
    check({ kind: "lock", subject: "yoke.lock", status: "warn", message: "stale" }),
    check({ kind: "auth", subject: "alpha", status: "unknown", message: "not verified" }),
  ],
};

describe("formatDoctorReport", () => {
  it("renders the exact plain-text layout with a hint and summary", () => {
    const expected = [
      "ok      repo project: git root found",
      "PROBLEM binary alpha: not installed",
      "  hint: install alpha",
      "warn    lock yoke.lock: stale",
      "unknown auth alpha: not verified",
      "doctor: 1 problem, 1 warning, 1 unknown",
      "",
    ].join("\n");
    expect(formatDoctorReport(MIXED, { color: false })).toBe(expected);
  });

  it("reports no problems when there are no problem, warn or unknown checks", () => {
    const report: DoctorReport = {
      checks: [
        check({ kind: "repo", subject: "project", status: "ok", message: "fine" }),
        check({ kind: "config", subject: "yoke.yaml", status: "info", message: "absent" }),
      ],
    };
    expect(formatDoctorReport(report, { color: false })).toBe(
      "ok      repo project: fine\n" +
        "info    config yoke.yaml: absent\n" +
        "doctor: no problems found\n",
    );
  });

  it("prints only the summary for an empty report", () => {
    expect(formatDoctorReport({ checks: [] }, { color: false })).toBe(
      "doctor: no problems found\n",
    );
  });

  it("pluralises counts and omits zero counts", () => {
    const report: DoctorReport = {
      checks: [
        check({ status: "problem", message: "a" }),
        check({ status: "problem", message: "b" }),
        check({ status: "warn", message: "c" }),
        check({ status: "unknown", message: "d" }),
        check({ status: "unknown", message: "e" }),
        check({ status: "unknown", message: "f" }),
      ],
    };
    const lines = formatDoctorReport(report, { color: false }).trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe("doctor: 2 problems, 1 warning, 3 unknown");

    const single = formatDoctorReport(
      { checks: [check({ status: "problem", message: "a" })] },
      { color: false },
    );
    expect(single.trimEnd().split("\n").pop()).toBe("doctor: 1 problem");
  });

  it("ends with a newline and never emits escape codes when color is false", () => {
    const output = formatDoctorReport(MIXED, { color: false });
    expect(output.endsWith("\n")).toBe(true);
    expect(output.includes("\u001b")).toBe(false);
  });

  it("emits escape codes when color is true, and stripping them gives the plain output", () => {
    const coloured = formatDoctorReport(MIXED, { color: true });
    expect(coloured.includes(ESC)).toBe(true);
    const stripped = coloured.replace(SGR_PATTERN, "");
    expect(stripped).toBe(formatDoctorReport(MIXED, { color: false }));
  });
});

describe("doctorExitCode", () => {
  it("returns EXIT_PROBLEMS only when at least one check is a problem", () => {
    expect(doctorExitCode(MIXED)).toBe(EXIT_PROBLEMS);
    expect(doctorExitCode({ checks: [] })).toBe(EXIT_OK);
    expect(
      doctorExitCode({
        checks: [
          check({ status: "warn" }),
          check({ status: "unknown" }),
          check({ status: "info" }),
          check({ status: "ok" }),
        ],
      }),
    ).toBe(EXIT_OK);
  });

  it("gives UsageError the name used by runCli", () => {
    const error = new UsageError("unknown option");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UsageError");
    expect(error.message).toBe("unknown option");
  });
});

describe("shouldUseColor", () => {
  it("uses colour only on a TTY with NO_COLOR unset and TERM not dumb", () => {
    expect(shouldUseColor({ isTTY: true, env: {} })).toBe(true);
    expect(shouldUseColor({ isTTY: true, env: { TERM: "xterm-256color" } })).toBe(true);
  });

  it("treats NO_COLOR as unset when it is empty", () => {
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: "" } })).toBe(true);
  });

  it("disables colour when NO_COLOR is set to a non-empty value", () => {
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
  });

  it("disables colour when TERM is dumb", () => {
    expect(shouldUseColor({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
  });

  it("disables colour when stdout is not a TTY", () => {
    expect(shouldUseColor({ isTTY: false, env: {} })).toBe(false);
    expect(shouldUseColor({ isTTY: undefined, env: {} })).toBe(false);
  });
});
