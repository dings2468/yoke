/**
 * tests/commands/cli-version.test.ts: the CLI's VERSION constant must match the version in package.json.
 * Reads only the repo's package.json; nothing is written.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/main.js";

describe("CLI version", () => {
  it("matches the version field of package.json", async () => {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (typeof pkg !== "object" || pkg === null || !("version" in pkg)) {
      throw new Error("package.json has no version field");
    }
    expect(VERSION).toBe(pkg.version);
  });
});
