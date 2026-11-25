import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildInitDraft,
  draftToIntents,
  gitignoreLines,
  renderYokeYaml,
} from "../../src/commands/init-convert.js";
import type { HarnessImport, ImportSelection } from "../../src/commands/init-types.js";
import { InitError } from "../../src/commands/init-types.js";
import type { McpServerDefinition } from "../../src/core/schema.js";
import { parseScopeConfig } from "../../src/core/scopes.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yoke-init-convert-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SECRET = `sk-${"a".repeat(24)}`;

function harness(
  name: string,
  parts: {
    readonly project?: Record<string, McpServerDefinition>;
    readonly local?: Record<string, McpServerDefinition>;
    readonly user?: Record<string, McpServerDefinition>;
    readonly instructions?: { readonly path: string; readonly content: string };
  } = {},
): HarnessImport {
  return {
    harness: name,
    project: parts.project ?? {},
    local: parts.local ?? {},
    user: parts.user ?? {},
    instructions:
      parts.instructions === undefined ? undefined : { ...parts.instructions, origin: name },
  };
}

function selection(
  harnesses: readonly HarnessImport[],
  instructions?: { readonly path: string; readonly content: string },
): ImportSelection {
  return {
    harnesses,
    instructions: instructions === undefined ? undefined : { ...instructions, origin: "file" },
  };
}

const plainStdio: McpServerDefinition = {
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  env: { MODE: "fast" },
};

const secretStdio: McpServerDefinition = {
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  env: { API_KEY: SECRET },
};

describe("buildInitDraft", () => {
  it("round-trips the rendered yoke.yaml through parseScopeConfig", () => {
    const draft = buildInitDraft({
      selection: selection([
        harness("alpha", {
          project: {
            plain: plainStdio,
            remote: {
              transport: "http",
              url: "https://example.test/mcp",
              headers: { "X-Mode": "a" },
            },
          },
        }),
      ]),
      installed: ["beta"],
      secrets: "local",
    });
    const parsed = parseScopeConfig(renderYokeYaml(draft.project), "project", "yoke.yaml");
    expect(parsed).toEqual(draft.project);
  });

  it("writes references in yoke.yaml and originals in yoke.local.yaml under the local policy", () => {
    const draft = buildInitDraft({
      selection: selection([harness("alpha", { project: { svc: secretStdio } })]),
      installed: [],
      secrets: "local",
    });
    const yaml = renderYokeYaml(draft.project);
    expect(yaml).not.toContain(SECRET);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal reference under test
    expect(draft.project.mcps?.svc).toMatchObject({ env: { API_KEY: "${API_KEY}" } });
    expect(draft.local?.mcps?.svc).toEqual(secretStdio);
    expect(draft.envVars.map((f) => f.varName)).toEqual(["API_KEY"]);
    expect(draft.notes.join("\n")).toContain("yoke.local.yaml");
  });

  it("keeps originals out of yoke.local.yaml under the ref policy and lists variables to export", () => {
    const draft = buildInitDraft({
      selection: selection([harness("alpha", { project: { svc: secretStdio } })]),
      installed: [],
      secrets: "ref",
    });
    expect(draft.local).toBeUndefined();
    expect(draft.notes.join("\n")).toContain("export these variables before running sync: API_KEY");
    expect(JSON.stringify(draft)).not.toContain(SECRET);
  });

  it("does not write yoke.local.yaml when there are no local servers and no secrets", () => {
    const draft = buildInitDraft({
      selection: selection([harness("alpha", { project: { plain: plainStdio } })]),
      installed: [],
      secrets: "local",
    });
    expect(draft.local).toBeUndefined();
    expect(draft.project.mcps).toEqual({ plain: plainStdio });
  });

  it("collapses identical servers from two harnesses", () => {
    const draft = buildInitDraft({
      selection: selection([
        harness("alpha", { project: { plain: plainStdio } }),
        harness("beta", { project: { plain: plainStdio } }),
      ]),
      installed: [],
      secrets: "local",
    });
    expect(Object.keys(draft.project.mcps ?? {})).toEqual(["plain"]);
  });

  it("fails with InitError when one server name has different definitions in two harnesses", () => {
    const other: McpServerDefinition = { transport: "stdio", command: "other" };
    expect(() =>
      buildInitDraft({
        selection: selection([
          harness("alpha", { project: { plain: plainStdio } }),
          harness("beta", { project: { plain: other } }),
        ]),
        installed: [],
        secrets: "local",
      }),
    ).toThrow(InitError);
  });

  it("fails with InitError when a local-scope conflict hits a secret original", () => {
    expect(() =>
      buildInitDraft({
        selection: selection([
          harness("alpha", {
            project: { svc: secretStdio },
            local: { svc: { transport: "stdio", command: "different" } },
          }),
        ]),
        installed: [],
        secrets: "local",
      }),
    ).toThrow(InitError);
  });

  it("lists installed harnesses and selected sources, sorted and unique", () => {
    const draft = buildInitDraft({
      selection: selection([harness("beta", {}), harness("alpha", {})]),
      installed: ["gamma", "alpha"],
      secrets: "local",
    });
    expect(draft.project.harnesses).toEqual(["alpha", "beta", "gamma"]);
  });

  it("builds a user draft and no longer notes servers left in place", () => {
    const draft = buildInitDraft({
      selection: selection([
        harness("alpha", {
          user: {
            a1: { transport: "stdio", command: "a" },
            a2: { transport: "stdio", command: "a" },
          },
        }),
        harness("beta", { user: { b1: { transport: "stdio", command: "b" } } }),
      ]),
      installed: [],
      secrets: "local",
    });
    expect(draft.notes.some((n) => n.includes("left in place"))).toBe(false);
    expect(Object.keys(draft.user?.mcps ?? {})).toEqual(["a1", "a2", "b1"]);
    expect(draft.user?.harnesses).toEqual(["alpha", "beta"]);
  });

  it("leaves out user servers already in project or local, with a note", () => {
    const draft = buildInitDraft({
      selection: selection([
        harness("alpha", {
          project: { shared: { transport: "stdio", command: "s" } },
          user: {
            shared: { transport: "stdio", command: "s" },
            only: { transport: "stdio", command: "o" },
          },
        }),
      ]),
      installed: [],
      secrets: "local",
    });
    expect(Object.keys(draft.user?.mcps ?? {})).toEqual(["only"]);
    expect(draft.notes).toContain(
      'user server "shared" also defined in project/local; not added to the user file',
    );
  });

  it("keeps user literal secrets under local and references them under ref", () => {
    const input = {
      selection: selection([
        harness("alpha", {
          user: {
            u1: {
              transport: "http",
              url: "https://x.example",
              headers: { Authorization: `Bearer ${SECRET}` },
            },
          },
        }),
      ]),
      installed: [],
    };
    const local = buildInitDraft({ ...input, secrets: "local" });
    expect(JSON.stringify(local.user?.mcps)).toContain(SECRET);
    expect(local.envVars).toEqual([]);

    const ref = buildInitDraft({ ...input, secrets: "ref" });
    expect(JSON.stringify(ref.user?.mcps)).not.toContain(SECRET);
    expect(JSON.stringify(ref.user?.mcps)).toContain("${");
    expect(ref.envVars.length).toBeGreaterThan(0);
    expect(ref.notes.some((n) => n.startsWith("export these variables before running sync"))).toBe(
      true,
    );
  });

  it("uses the chosen instruction file as agents content", () => {
    const draft = buildInitDraft({
      selection: selection([harness("alpha", {})], {
        path: "/repo/CLAUDE.md",
        content: "# Rules\n",
      }),
      installed: [],
      secrets: "local",
    });
    expect(draft.agents).toEqual({ content: "# Rules\n", from: "/repo/CLAUDE.md" });
  });

  it("produces no agents draft when no instruction source was chosen", () => {
    const draft = buildInitDraft({
      selection: selection([harness("alpha", { project: { plain: plainStdio } })]),
      installed: [],
      secrets: "local",
    });
    expect(draft.agents).toBeUndefined();
  });
});

describe("gitignoreLines", () => {
  it("adds generated paths only in compiled mode, anchored and POSIX", () => {
    const repoPath = "/repo";
    const generatedPaths = [
      "/repo/CLAUDE.md",
      "/repo/CLAUDE.md",
      "/repo/AGENTS.md",
      "/repo/yoke.yaml",
      "/repo/docs/GUIDE.md",
      "/elsewhere/GEMINI.md",
      "/repo/..hidden.md",
    ];
    expect(gitignoreLines({ mode: "compiled", repoPath, generatedPaths })).toEqual([
      ".yoke/",
      "/..hidden.md",
      "/CLAUDE.md",
      "/docs/GUIDE.md",
      "yoke.local.yaml",
    ]);
  });

  it("ignores generated paths in hybrid mode", () => {
    expect(
      gitignoreLines({ mode: "hybrid", repoPath: "/repo", generatedPaths: ["/repo/CLAUDE.md"] }),
    ).toEqual([".yoke/", "yoke.local.yaml"]);
  });
});

describe("draftToIntents", () => {
  it("returns only the allowed repo paths", () => {
    const draft = buildInitDraft({
      selection: selection([harness("alpha", { project: { svc: secretStdio } })], {
        path: join(dir, "AGENTS.md"),
        content: "# Rules\n",
      }),
      installed: [],
      secrets: "local",
    });
    const intents = draftToIntents(draft, {
      repoPath: dir,
      force: false,
      gitignore: gitignoreLines({ mode: "hybrid", repoPath: dir, generatedPaths: [] }),
    });
    expect(intents.map((i) => i.path)).toEqual([
      join(dir, "yoke.yaml"),
      join(dir, "yoke.local.yaml"),
      join(dir, "AGENTS.md"),
      join(dir, ".gitignore"),
    ]);
  });

  it("uses fail without force and overwrite-with-backup with force", () => {
    const draft = buildInitDraft({
      selection: selection([harness("alpha", { project: { plain: plainStdio } })]),
      installed: [],
      secrets: "local",
    });
    const noForce = draftToIntents(draft, { repoPath: dir, force: false, gitignore: undefined });
    const withForce = draftToIntents(draft, { repoPath: dir, force: true, gitignore: undefined });
    expect(noForce.map((i) => (i.kind === "text" ? i.ifExists : i.kind))).toEqual(["fail"]);
    expect(withForce.map((i) => (i.kind === "text" ? i.ifExists : i.kind))).toEqual([
      "overwrite-with-backup",
    ]);
  });

  it("omits the gitignore intent for --no-gitignore", () => {
    const draft = buildInitDraft({
      selection: selection([harness("alpha", { project: { plain: plainStdio } })]),
      installed: [],
      secrets: "ref",
    });
    const intents = draftToIntents(draft, { repoPath: dir, force: false, gitignore: undefined });
    expect(intents.some((i) => i.kind === "ensure-lines")).toBe(false);
  });
});
