import { describe, expect, expectTypeOf, it } from "vitest";
import type { LaunchOptions, Scope, SyncOptions } from "../../src/core/schema.js";

describe("SyncOptions and LaunchOptions", () => {
  it("SyncOptions.warn collects messages without throwing", () => {
    const warnings: string[] = [];
    const opts: SyncOptions = {
      repoPath: "/repo",
      scopes: ["project", "local"],
      warn: (message: string) => {
        warnings.push(message);
      },
    };
    opts.warn("transport not supported");
    expect(warnings).toEqual(["transport not supported"]);
  });

  it("SyncOptions.scopes is a readonly list of Scope", () => {
    expectTypeOf<SyncOptions["scopes"]>().toEqualTypeOf<readonly Scope[]>();
  });

  it("SyncOptions rejects unknown scopes at compile time", () => {
    const bad: SyncOptions = {
      repoPath: "/repo",
      // @ts-expect-error "global" is not a Scope
      scopes: ["global"],
      warn: () => {},
    };
    expect(bad.repoPath).toBe("/repo");
  });

  it("LaunchOptions.launch is a boolean", () => {
    expectTypeOf<LaunchOptions["launch"]>().toEqualTypeOf<boolean>();
    const opts: LaunchOptions = { repoPath: "/repo", launch: false };
    expect(opts.launch).toBe(false);
  });
});
