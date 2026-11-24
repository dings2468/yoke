#!/usr/bin/env node
/**
 * src/cli.ts: the only module that reads process state. It builds real dependencies and hands them to `runCli`.
 */
import { homedir } from "node:os";
import { ADAPTER_FACTORIES } from "./adapters/registry.js";
import { createNodeFs } from "./core/fs-safe.js";
import { createNodeExec } from "./core/git.js";
import { plannerFromPlan, runCli } from "./main.js";

const env = process.env;
const homeDir = homedir();
const fs = createNodeFs();
const exec = createNodeExec(env);

process.exitCode = await runCli(process.argv, {
  io: {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdoutIsTTY: process.stdout.isTTY,
    stdinIsTTY: process.stdin.isTTY,
  },
  cwd: process.cwd(),
  homeDir,
  env,
  fs,
  exec,
  now: () => new Date(),
  factories: ADAPTER_FACTORIES,
  planner: plannerFromPlan({ fs, homeDir, env, exec }),
});
