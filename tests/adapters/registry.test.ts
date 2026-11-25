import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterContext } from "../../src/adapters/base.js";
import { ADAPTER_FACTORIES, createAdapters } from "../../src/adapters/registry.js";
import { HarnessNameSchema } from "../../src/core/schema.js";
import {
  cleanupSandbox,
  makeAdapterContext,
  type Sandbox,
  setupAdapterSandbox,
} from "./helpers.js";

const CAPABILITY_FIELDS = [
  "staticMcp",
  "staticInstructions",
  "reverseRead",
  "sessionExport",
  "sessionImport",
] as const;

describe("adapter registry", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await setupAdapterSandbox();
  });

  afterEach(async () => {
    await cleanupSandbox(sb);
  });

  it("freezes the factory list", () => {
    expect(Object.isFrozen(ADAPTER_FACTORIES)).toBe(true);
    expect(ADAPTER_FACTORIES).toHaveLength(2);
  });

  it("gives every adapter a unique name that matches HarnessNameSchema", () => {
    const adapters = createAdapters(makeAdapterContext(sb));
    const names = adapters.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(HarnessNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("declares all five capability fields on every adapter", () => {
    for (const adapter of createAdapters(makeAdapterContext(sb))) {
      for (const field of CAPABILITY_FIELDS) {
        expect(adapter.capabilities, `${adapter.name}.${field}`).toHaveProperty(field);
      }
      expect(["native", "seeded", "handoff-file-only"]).toContain(
        adapter.capabilities.sessionImport,
      );
    }
  });

  it("returns one adapter per factory, in registry order", () => {
    const ctx = makeAdapterContext(sb);
    const adapters = createAdapters(ctx);
    expect(adapters).toHaveLength(ADAPTER_FACTORIES.length);
    ADAPTER_FACTORIES.forEach((factory, i) => {
      expect(adapters[i]?.name).toBe(factory(ctx).name);
    });
  });

  it("runs no exec call and reads no file while building adapters", async () => {
    const reads: string[] = [];
    const base = makeAdapterContext(sb);
    const execCalls: string[] = [];
    const ctx: AdapterContext = {
      ...base,
      exec: async (file, args) => {
        execCalls.push(`${file} ${args.join(" ")}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      fs: {
        readFile: async (path) => {
          reads.push(path);
          throw new Error(`unexpected read: ${path}`);
        },
        lstat: async (path) => {
          reads.push(path);
          throw new Error(`unexpected lstat: ${path}`);
        },
        stat: async (path) => {
          reads.push(path);
          throw new Error(`unexpected stat: ${path}`);
        },
        readlink: async (path) => {
          reads.push(path);
          throw new Error(`unexpected readlink: ${path}`);
        },
        realpath: async (path) => {
          reads.push(path);
          throw new Error(`unexpected realpath: ${path}`);
        },
      },
    };
    createAdapters(ctx);
    expect(execCalls).toEqual([]);
    expect(reads).toEqual([]);
  });
});
