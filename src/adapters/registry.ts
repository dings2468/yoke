/**
 * src/adapters/registry.ts: the single list of harness adapter factories.
 *
 * Commands obtain adapters only through `createAdapters` and read their `capabilities`. Nothing outside src/adapters/ names a harness.
 * Building adapters performs no exec and no file read; each adapter does its I/O only when a method is called.
 */

import { createAgyAdapter } from "./agy.js";
import type { AdapterContext, HarnessAdapter } from "./base.js";
import { createClaudeAdapter } from "./claude.js";

export type AdapterFactory = (ctx: AdapterContext) => HarnessAdapter;

/** Registered factories, in the order `createAdapters` returns them. */
export const ADAPTER_FACTORIES: readonly AdapterFactory[] = Object.freeze([
  createClaudeAdapter,
  createAgyAdapter,
]);

/** One adapter per registered factory, in registry order. */
export function createAdapters(ctx: AdapterContext): readonly HarnessAdapter[] {
  return ADAPTER_FACTORIES.map((factory) => factory(ctx));
}
