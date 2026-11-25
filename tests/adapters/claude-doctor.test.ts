/**
 * tests/adapters/claude-doctor.test.ts: the Claude adapter's read-only doctor advice about a project CLAUDE.md.
 * Every path lives in a temp sandbox; the real home directory is never touched.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "../../src/adapters/base.js";
import { createClaudeAdapter } from "../../src/adapters/claude.js";
import {
  cleanupSandbox,
  makeAdapterContext,
  type Sandbox,
  setupAdapterSandbox,
} from "./helpers.js";

let sb: Sandbox;
let adapter: HarnessAdapter;

beforeEach(async () => {
  sb = await setupAdapterSandbox();
  adapter = createClaudeAdapter(makeAdapterContext(sb));
});

afterEach(async () => {
  await cleanupSandbox(sb);
});

function warnings(): Promise<readonly string[]> {
  if (adapter.doctorWarnings === undefined) {
    throw new Error("claude adapter must define doctorWarnings");
  }
  return adapter.doctorWarnings({ repoPath: sb.repo });
}

describe("claude doctorWarnings", () => {
  it("warns when CLAUDE.md does not start with the @AGENTS.md import", async () => {
    await writeFile(join(sb.repo, "CLAUDE.md"), "# Claude notes\n\n@AGENTS.md\n", "utf8");
    const found = await warnings();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("@AGENTS.md");
    expect(found[0]).toContain("will not load AGENTS.md");
  });

  it("is silent when the first non-empty line is @AGENTS.md", async () => {
    await writeFile(join(sb.repo, "CLAUDE.md"), "\n\n@AGENTS.md\r\nLocal notes\n", "utf8");
    expect(await warnings()).toEqual([]);
  });

  it("accepts a UTF-8 byte order mark before the import line", async () => {
    await writeFile(join(sb.repo, "CLAUDE.md"), "﻿@AGENTS.md\n", "utf8");
    expect(await warnings()).toEqual([]);
  });

  it("is silent when CLAUDE.md is absent", async () => {
    expect(await warnings()).toEqual([]);
  });

  it("warns when CLAUDE.md has no non-empty line", async () => {
    await writeFile(join(sb.repo, "CLAUDE.md"), "\n  \n", "utf8");
    expect(await warnings()).toHaveLength(1);
  });
});
