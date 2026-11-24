import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessAdapter, HarnessCapabilities } from "../../src/adapters/base.js";
import {
  listImportSources,
  parseSourceToken,
  readFileSource,
} from "../../src/commands/init-sources.js";
import { InitError, UsageError } from "../../src/commands/init-types.js";
import { GENERATED_HEADER } from "../../src/core/compiler.js";
import { createNodeFs } from "../../src/core/fs-safe.js";
import type { PartialYokeConfig } from "../../src/core/schema.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yoke-init-sources-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CAPS: HarnessCapabilities = {
  staticMcp: true,
  staticInstructions: true,
  reverseRead: true,
  sessionExport: false,
  sessionImport: "handoff-file-only",
};

function fakeAdapter(
  name: string,
  read: (repoPath: string) => Promise<PartialYokeConfig>,
  caps: Partial<HarnessCapabilities> = {},
): HarnessAdapter {
  return {
    name,
    capabilities: { ...CAPS, ...caps },
    detect: () => Promise.resolve({ installed: false, authenticated: false }),
    readNativeState: read,
    syncStatic: () => Promise.resolve([]),
  };
}

describe("parseSourceToken", () => {
  it("parses a harness name and the :mcps form", () => {
    expect(parseSourceToken("alpha", dir)).toEqual({
      kind: "harness",
      name: "alpha",
      mcpsOnly: false,
    });
    expect(parseSourceToken("alpha:mcps", dir)).toEqual({
      kind: "harness",
      name: "alpha",
      mcpsOnly: true,
    });
    expect(parseSourceToken("beta-2:mcps", dir)).toEqual({
      kind: "harness",
      name: "beta-2",
      mcpsOnly: true,
    });
  });

  it("treats anything else as a path resolved against cwd", () => {
    expect(parseSourceToken("./NOTES.md", dir)).toEqual({
      kind: "file",
      path: resolve(dir, "./NOTES.md"),
    });
    expect(parseSourceToken("Upper.md", dir)).toEqual({
      kind: "file",
      path: resolve(dir, "Upper.md"),
    });
    expect(parseSourceToken("Alpha", dir)).toEqual({ kind: "file", path: resolve(dir, "Alpha") });
    const longName = "a".repeat(33);
    expect(parseSourceToken(longName, dir)).toEqual({ kind: "file", path: resolve(dir, longName) });
  });

  it("rejects an empty token and a .json path with UsageError", () => {
    expect(() => parseSourceToken("", dir)).toThrow(UsageError);
    expect(() => parseSourceToken("   ", dir)).toThrow(UsageError);
    expect(() => parseSourceToken("x.json", dir)).toThrow(/not supported in v0\.1/);
    expect(() => parseSourceToken("x.json", dir)).toThrow(UsageError);
  });
});

describe("listImportSources", () => {
  it("reports an available harness with project and local servers, and its instructions", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    const adapter = fakeAdapter("alpha", () =>
      Promise.resolve({
        user: {
          mcps: {
            u1: { transport: "stdio", command: "u" },
            u2: { transport: "stdio", command: "u" },
          },
        },
        project: {
          mcps: { gh: { transport: "stdio", command: "npx" } },
          instructions: { kind: "file", path: join(repo, "ALPHA.md"), content: "rules\n" },
        },
        local: { mcps: { loc: { transport: "http", url: "https://example.test/mcp" } } },
      }),
    );
    const sources = await listImportSources({
      adapters: [adapter],
      repoPath: repo,
      fs: createNodeFs(),
      canonicalPath: join(repo, "AGENTS.md"),
    });
    const [entry] = sources.harnesses;
    expect(entry?.name).toBe("alpha");
    expect(entry?.availability.kind).toBe("available");
    if (entry?.availability.kind !== "available") {
      throw new Error("expected available");
    }
    expect(Object.keys(entry.availability.data.user)).toEqual(["u1", "u2"]);
    expect(Object.keys(entry.availability.data.project)).toEqual(["gh"]);
    expect(Object.keys(entry.availability.data.local)).toEqual(["loc"]);
    expect(entry.availability.data.instructions).toEqual({
      path: join(repo, "ALPHA.md"),
      content: "rules\n",
      origin: "alpha",
    });
    expect(sources.files.map((f) => f.path)).toEqual([join(repo, "ALPHA.md")]);
  });

  it("treats a harness with only user-level servers as available", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    const adapter = fakeAdapter("beta", () =>
      Promise.resolve({
        user: {
          mcps: {
            one: { transport: "stdio", command: "x" },
            two: { transport: "stdio", command: "y" },
          },
        },
      }),
    );
    const sources = await listImportSources({
      adapters: [adapter],
      repoPath: repo,
      fs: createNodeFs(),
      canonicalPath: join(repo, "AGENTS.md"),
    });
    const availability = sources.harnesses[0]?.availability;
    expect(availability?.kind).toBe("available");
    if (availability?.kind !== "available") {
      throw new Error("expected available");
    }
    expect(Object.keys(availability.data.user)).toEqual(["one", "two"]);
    expect(availability.data.project).toEqual({});
    expect(availability.data.local).toEqual({});
    expect(sources.files).toEqual([]);
  });

  it("reports empty only when every tier and the instructions are empty", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    const adapter = fakeAdapter("gamma", () => Promise.resolve({ user: { mcps: {} } }));
    const sources = await listImportSources({
      adapters: [adapter],
      repoPath: repo,
      fs: createNodeFs(),
      canonicalPath: join(repo, "AGENTS.md"),
    });
    expect(sources.harnesses[0]?.availability).toEqual({ kind: "empty" });
  });

  it("skips symlinked and generated project instructions", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    const generated = `${GENERATED_HEADER}\nmanaged\n`;
    const linked = fakeAdapter("alpha", () =>
      Promise.resolve({
        project: {
          mcps: {},
          instructions: { kind: "symlink", path: join(repo, "A.md"), target: "AGENTS.md" },
        },
      }),
    );
    const managed = fakeAdapter("beta", () =>
      Promise.resolve({
        project: {
          mcps: {},
          instructions: { kind: "file", path: join(repo, "B.md"), content: generated },
        },
      }),
    );
    const sources = await listImportSources({
      adapters: [linked, managed],
      repoPath: repo,
      fs: createNodeFs(),
      canonicalPath: join(repo, "AGENTS.md"),
    });
    expect(sources.harnesses.map((h) => h.availability.kind)).toEqual(["empty", "empty"]);
    expect(sources.files).toEqual([]);
  });

  it("does not read native state for a harness without reverseRead", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    let called = false;
    const adapter = fakeAdapter(
      "alpha",
      () => {
        called = true;
        return Promise.resolve({});
      },
      { reverseRead: false },
    );
    const sources = await listImportSources({
      adapters: [adapter],
      repoPath: repo,
      fs: createNodeFs(),
      canonicalPath: join(repo, "AGENTS.md"),
    });
    expect(sources.harnesses[0]?.availability).toEqual({ kind: "unsupported" });
    expect(called).toBe(false);
  });

  it("reports a throwing readNativeState as unreadable with its message", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    const adapter = fakeAdapter("alpha", () => Promise.reject(new Error("corrupt owned key")));
    const sources = await listImportSources({
      adapters: [adapter],
      repoPath: repo,
      fs: createNodeFs(),
      canonicalPath: join(repo, "AGENTS.md"),
    });
    expect(sources.harnesses[0]?.availability).toEqual({
      kind: "unreadable",
      reason: "corrupt owned key",
    });
  });

  it("lists the canonical AGENTS.md as existing, once, and skips a generated or symlinked one", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    const canonical = join(repo, "AGENTS.md");
    await writeFile(canonical, "team rules\n");
    const sharedAdapter = fakeAdapter("alpha", () =>
      Promise.resolve({
        project: {
          mcps: {},
          instructions: { kind: "file", path: canonical, content: "team rules\n" },
        },
      }),
    );
    const withCanonical = await listImportSources({
      adapters: [sharedAdapter],
      repoPath: repo,
      fs: createNodeFs(),
      canonicalPath: canonical,
    });
    expect(withCanonical.files).toEqual([
      { path: canonical, content: "team rules\n", origin: "alpha" },
    ]);

    const linkRepo = join(dir, "linked");
    await mkdir(linkRepo);
    await writeFile(join(linkRepo, "real.md"), "real\n");
    await symlink(join(linkRepo, "real.md"), join(linkRepo, "AGENTS.md"));
    const linked = await listImportSources({
      adapters: [],
      repoPath: linkRepo,
      fs: createNodeFs(),
      canonicalPath: join(linkRepo, "AGENTS.md"),
    });
    expect(linked.files).toEqual([]);

    const genRepo = join(dir, "generated");
    await mkdir(genRepo);
    await writeFile(join(genRepo, "AGENTS.md"), `${GENERATED_HEADER}\nx\n`);
    const generated = await listImportSources({
      adapters: [],
      repoPath: genRepo,
      fs: createNodeFs(),
      canonicalPath: join(genRepo, "AGENTS.md"),
    });
    expect(generated.files).toEqual([]);
  });

  it("has no canonical file when AGENTS.md is missing", async () => {
    const sources = await listImportSources({
      adapters: [],
      repoPath: dir,
      fs: createNodeFs(),
      canonicalPath: join(dir, "AGENTS.md"),
    });
    expect(sources).toEqual({ harnesses: [], files: [] });
  });
});

describe("readFileSource", () => {
  it("reads a regular file as an explicit candidate", async () => {
    const path = join(dir, "NOTES.md");
    await writeFile(path, "notes\n");
    await expect(readFileSource(createNodeFs(), path)).resolves.toEqual({
      path,
      content: "notes\n",
      origin: "file",
    });
  });

  it("rejects a .json path without touching the disk", async () => {
    await expect(readFileSource(createNodeFs(), join(dir, "missing.json"))).rejects.toThrow(
      InitError,
    );
  });

  it("rejects a missing file and a directory with InitError", async () => {
    await expect(readFileSource(createNodeFs(), join(dir, "nope.md"))).rejects.toThrow(
      /file not found/,
    );
    await mkdir(join(dir, "sub"));
    await expect(readFileSource(createNodeFs(), join(dir, "sub"))).rejects.toThrow(
      /not a regular file/,
    );
  });
});
