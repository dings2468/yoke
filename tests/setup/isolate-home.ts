import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const fakeHome = mkdtempSync(join(tmpdir(), "yoke-test-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});
