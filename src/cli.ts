#!/usr/bin/env node
import { Command } from "commander";

export const VERSION = "0.0.0";

export function buildProgram(): Command {
  return new Command().name("yoke").description("One config, any coding harness.").version(VERSION);
}

await buildProgram().parseAsync(process.argv);
