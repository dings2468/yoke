import { homedir } from "node:os";
import { describe, expect, it } from "vitest";

const modules = [
  "../src/core/schema.js",
  "../src/core/scopes.js",
  "../src/core/drift.js",
  "../src/core/compiler.js",
  "../src/core/git.js",
  "../src/core/fs-safe.js",
  "../src/adapters/base.js",
  "../src/adapters/claude.js",
  "../src/adapters/agy.js",
  "../src/commands/init.js",
  "../src/commands/sync.js",
  "../src/commands/switch.js",
  "../src/commands/sessions.js",
  "../src/commands/doctor.js",
] as const;

describe("bootstrap skeleton", () => {
  it.each(modules)("imports %s", async (path) => {
    const mod: unknown = await import(path);
    expect(mod).toBeTypeOf("object");
  });

  it("isolates HOME to a temp directory", () => {
    expect(homedir()).toBe(process.env.HOME);
    expect(homedir()).toContain("yoke-test-home-");
  });
});
