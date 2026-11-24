/**
 * src/main.ts: the Commander program and the CLI runner. Pure with respect to process state: every
 * environment value, stream, and adapter arrives through `CliDeps`, so tests can drive `runCli` directly.
 * `src/cli.ts` is the only module that builds real dependencies.
 */
import { Command, CommanderError, Option } from "commander";
import type { AdapterFactory } from "./adapters/registry.js";
import { type DoctorPlanner, runDoctor } from "./commands/doctor.js";
import { doctorExitCode, formatDoctorReport, shouldUseColor } from "./commands/doctor-format.js";
import { EXIT_OK, EXIT_PROBLEMS, EXIT_USAGE, UsageError } from "./commands/exit.js";
import { createClackPrompts, runInit } from "./commands/init.js";
import type { SecretPolicy } from "./commands/init-convert.js";
import type { Fs, ReadFs } from "./core/fs-safe.js";
import type { Env, Exec } from "./core/git.js";
import { buildSyncPlan } from "./core/plan.js";
import { userConfigDir } from "./core/scopes.js";

export const VERSION = "0.0.0";

/** Output sinks. The runner never touches the process streams itself. */
export interface CliIo {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly stdoutIsTTY: boolean | undefined;
  readonly stdinIsTTY: boolean | undefined;
}

export interface CliDeps {
  readonly io: CliIo;
  readonly cwd: string;
  readonly homeDir: string;
  readonly env: Env;
  readonly fs: Fs;
  readonly exec: Exec;
  readonly now: () => Date;
  readonly factories: readonly AdapterFactory[];
  readonly planner: DoctorPlanner;
}

/** Commander help, version, and help-command exits are successes; every other parse error is a usage error. */
const SUCCESS_COMMANDER_CODES: ReadonlySet<string> = new Set([
  "commander.helpDisplayed",
  "commander.help",
  "commander.version",
]);

/**
 * Builds the program. `setExit` receives the exit code chosen by a command's action, so `runCli` can return it.
 * Output configuration and `exitOverride` are set before any subcommand is added, so subcommands inherit them.
 */
export function buildProgram(deps: CliDeps, setExit: (code: number) => void): Command {
  const program = new Command()
    .name("yoke")
    .description("One config, any coding harness.")
    .version(VERSION, "--version");
  program.exitOverride().configureOutput({
    writeOut: (text) => deps.io.stdout(text),
    writeErr: (text) => deps.io.stderr(text),
  });

  program
    .command("doctor")
    .description("Check binaries, config, lock, symlinks, and drift. Writes nothing.")
    .action(async () => {
      const report = await runDoctor({
        cwd: deps.cwd,
        homeDir: deps.homeDir,
        userConfigDir: userConfigDir(deps.env, deps.homeDir),
        env: deps.env,
        fs: deps.fs,
        exec: deps.exec,
        factories: deps.factories,
        planner: deps.planner,
      });
      deps.io.stdout(
        formatDoctorReport(report, {
          color: shouldUseColor({ isTTY: deps.io.stdoutIsTTY, env: deps.env }),
        }),
      );
      setExit(doctorExitCode(report));
    });

  // #region I-CLI init
  program
    .command("init")
    .description(
      "Create yoke.yaml, yoke.local.yaml, AGENTS.md, and .gitignore lines. Can import from harnesses.",
    )
    .option(
      "--import-from <source...>",
      "harness name (MCPs and instructions), name:mcps, or an instruction file path",
    )
    .addOption(
      new Option("--secrets <policy>", "where literal secrets go")
        .choices(["local", "ref"])
        .default("local"),
    )
    .option("--no-gitignore", "do not write .gitignore lines")
    .option("--force", "overwrite existing yoke files (originals are backed up)")
    .action(
      async (opts: {
        importFrom?: string[];
        secrets: SecretPolicy;
        gitignore: boolean;
        force: boolean;
      }) => {
        const code = await runInit(
          {
            importFrom: opts.importFrom,
            secrets: opts.secrets,
            gitignore: opts.gitignore,
            force: opts.force,
          },
          {
            io: deps.io,
            cwd: deps.cwd,
            homeDir: deps.homeDir,
            env: deps.env,
            fs: deps.fs,
            exec: deps.exec,
            now: deps.now,
            factories: deps.factories,
            prompts: createClackPrompts(),
          },
        );
        setExit(code);
      },
    );
  // #endregion I-CLI init

  return program;
}

/**
 * Parses `argv` (node and script entries first, as the Node argument vector), runs the matched command, and returns
 * the exit code: 0 clean, 1 problems or an unexpected runtime failure, 2 usage error (see exit.ts).
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let code: number = EXIT_OK;
  const program = buildProgram(deps, (chosen) => {
    code = chosen;
  });
  try {
    await program.parseAsync([...argv], { from: "node" });
    return code;
  } catch (err: unknown) {
    if (err instanceof CommanderError) {
      // Commander has already written its own message through configureOutput.
      return SUCCESS_COMMANDER_CODES.has(err.code) ? EXIT_OK : EXIT_USAGE;
    }
    if (err instanceof UsageError) {
      deps.io.stderr(`${err.message}\n`);
      return EXIT_USAGE;
    }
    deps.io.stderr(`yoke: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_PROBLEMS;
  }
}

export interface PlannerDeps {
  readonly fs: ReadFs;
  readonly homeDir: string;
  readonly env: Env;
  readonly exec: Exec;
}

/**
 * Doctor planner backed by `buildSyncPlan`. It plans one adapter at a time, so a failure in one adapter does not hide
 * the others. Only the adapter passed in is registered, and the request is read-only (no writeFs, no clock).
 * Warnings from the plan are forwarded to `opts.warn`, which doctor collects.
 */
export function plannerFromPlan(deps: PlannerDeps): DoctorPlanner {
  return async ({ adapter, opts }) => {
    const adapters = new Map<string, AdapterFactory>([[adapter.name, () => adapter]]);
    const plan = await buildSyncPlan({
      repoPath: opts.repoPath,
      scopes: opts.scopes,
      harnesses: [adapter.name],
      force: false,
      global: false,
      homeDir: deps.homeDir,
      env: deps.env,
      readFs: deps.fs,
      exec: deps.exec,
      adapters,
    });
    for (const message of plan.warnings) {
      opts.warn(message);
    }
    return { plans: plan.plans, drift: plan.drift };
  };
}
