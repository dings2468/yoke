/**
 * tests/commands/init.test.ts: `runInit` against a temp repo, a fake adapter, a scripted git exec, and fake prompts.
 * Nothing here touches the real home directory or a real harness binary.
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterFactory } from "../../src/adapters/registry.js";
import { EXIT_INTERRUPTED, EXIT_OK, EXIT_PROBLEMS, EXIT_USAGE } from "../../src/commands/exit.js";
import { type InitDeps, type InitPrompts, runInit } from "../../src/commands/init.js";
import { createNodeFs } from "../../src/core/fs-safe.js";
import type { Exec } from "../../src/core/git.js";
import type { PartialYokeConfig } from "../../src/core/schema.js";
import type { CliIo } from "../../src/main.js";

let root: string;
let repo: string;
let home: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "yoke-init-")));
  repo = join(root, "repo");
  home = join(root, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(home, { recursive: true });
  stdout = [];
  stderr = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CANCEL = Symbol("cancel");

function fakePrompts(overrides: Partial<InitPrompts> = {}): InitPrompts {
  return {
    multiselect: async () => ["alpha"],
    select: async () => "none",
    confirm: async () => true,
    isCancel: (value: unknown): value is symbol => typeof value === "symbol",
    ...overrides,
  };
}

/** A harness whose native state is fixed: one project MCP with a literal token, one local MCP, one user MCP, and CLAUDE-like instructions. */
function alphaNative(): PartialYokeConfig {
  return {
    project: {
      mcps: {
        docs: {
          transport: "stdio",
          command: "node",
          args: ["docs.js"],
          env: { API_TOKEN: "sk-testsecret000000000000000000" },
        },
      },
      instructions: { kind: "file", path: join(repo, "ALPHA.md"), content: "# rules\n" },
    },
    local: { mcps: { scratch: { transport: "stdio", command: "node", args: ["s.js"] } } },
    user: { mcps: { personal: { transport: "stdio", command: "node" } } },
  };
}

function alphaFactory(native: PartialYokeConfig): AdapterFactory {
  return () => ({
    name: "alpha",
    capabilities: {
      staticMcp: true,
      staticInstructions: true,
      reverseRead: true,
      sessionExport: false,
      sessionImport: "handoff-file-only",
    },
    detect: async () => ({ installed: true, authenticated: false }),
    readNativeState: async () => native,
    syncStatic: async () => [],
  });
}

function gitExec(result: "inside" | "outside"): Exec {
  return (file) => {
    if (file !== "git") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 127 });
    }
    if (result === "outside") {
      return Promise.resolve({
        stdout: "",
        stderr: "fatal: not a git repository",
        exitCode: 128,
      });
    }
    return Promise.resolve({ stdout: `${repo}\n`, stderr: "", exitCode: 0 });
  };
}

interface Setup {
  readonly interactive?: boolean;
  readonly prompts?: InitPrompts;
  readonly native?: PartialYokeConfig;
  readonly git?: "inside" | "outside";
}

function makeDeps(setup: Setup = {}): InitDeps {
  const io: CliIo = {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    stdoutIsTTY: false,
    stdinIsTTY: setup.interactive ?? false,
  };
  return {
    io,
    cwd: repo,
    homeDir: home,
    env: {},
    fs: createNodeFs(),
    exec: gitExec(setup.git ?? "inside"),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    factories: [alphaFactory(setup.native ?? alphaNative())],
    prompts: setup.prompts ?? fakePrompts(),
    timeoutMs: 1000,
  };
}

const DEFAULT_OPTS = {
  importFrom: ["alpha"],
  secrets: "local" as const,
  gitignore: true,
  force: false,
};

async function listRepo(): Promise<string[]> {
  return (await readdir(repo)).sort();
}

async function seedNativeFile(): Promise<void> {
  await writeFile(join(repo, "ALPHA.md"), "# rules\n", "utf8");
}

describe("runInit, non-interactive", () => {
  it("writes only the allowed files and leaves the native file alone", async () => {
    await seedNativeFile();
    const code = await runInit({ ...DEFAULT_OPTS }, makeDeps());

    expect(code).toBe(EXIT_OK);
    expect(await listRepo()).toEqual([
      ".gitignore",
      "AGENTS.md",
      "ALPHA.md",
      "yoke.local.yaml",
      "yoke.yaml",
    ]);
    expect(await readFile(join(repo, "ALPHA.md"), "utf8")).toBe("# rules\n");
    expect(await readFile(join(repo, "AGENTS.md"), "utf8")).toBe("# rules\n");
  });

  it("keeps literal secrets out of yoke.yaml and keeps full definitions in yoke.local.yaml", async () => {
    await seedNativeFile();
    await runInit({ ...DEFAULT_OPTS }, makeDeps());

    const shared = await readFile(join(repo, "yoke.yaml"), "utf8");
    const local = await readFile(join(repo, "yoke.local.yaml"), "utf8");
    expect(shared).not.toContain("sk-testsecret");
    expect(shared).toContain("${");
    expect(shared).toContain("alpha");
    expect(local).toContain("sk-testsecret");
  });

  it("adds gitignore lines and no longer reports user servers left in place", async () => {
    await seedNativeFile();
    stdout = [];
    await runInit({ ...DEFAULT_OPTS }, makeDeps());

    const gitignore = await readFile(join(repo, ".gitignore"), "utf8");
    expect(gitignore).toContain(".yoke/");
    expect(gitignore).toContain("yoke.local.yaml");
    expect(gitignore).toContain("AGENTS.local.md");
    const out = stdout.join("");
    expect(out).not.toContain("left in place");
    expect(out).toContain("next: yoke sync");
  });

  it("does not write .yoke/ state, and under home writes only the user-scope yoke.yaml", async () => {
    await seedNativeFile();
    await runInit({ ...DEFAULT_OPTS }, makeDeps());

    expect(await listRepo()).not.toContain(".yoke");
    expect(await readdir(home)).toEqual([".config"]);
    expect(await readdir(join(home, ".config", "yoke"))).toEqual(["yoke.yaml"]);
  });

  it("skips yoke.local.yaml when there is nothing local to protect", async () => {
    await seedNativeFile();
    const native: PartialYokeConfig = {
      project: {
        mcps: { docs: { transport: "stdio", command: "node" } },
      },
    };
    const code = await runInit({ ...DEFAULT_OPTS }, makeDeps({ native }));

    expect(code).toBe(EXIT_OK);
    expect(await listRepo()).not.toContain("yoke.local.yaml");
  });

  it("fails with exit 1 when a named file does not exist", async () => {
    const code = await runInit(
      { ...DEFAULT_OPTS, importFrom: [join(repo, "missing.md")] },
      makeDeps(),
    );

    expect(code).toBe(EXIT_PROBLEMS);
    expect(stderr.join("")).toContain("file not found");
    expect(await listRepo()).toEqual([]);
  });

  it("fails with exit 2 for an unknown harness", async () => {
    const code = await runInit({ ...DEFAULT_OPTS, importFrom: ["nope"] }, makeDeps());

    expect(code).toBe(EXIT_USAGE);
    expect(stderr.join("")).toContain("unknown harness: nope");
    expect(await listRepo()).toEqual([]);
  });

  it("fails with exit 2 when there is no terminal and no --import-from", async () => {
    const code = await runInit({ ...DEFAULT_OPTS, importFrom: undefined }, makeDeps());

    expect(code).toBe(EXIT_USAGE);
    expect(stderr.join("")).toContain("pass --import-from");
    expect(await listRepo()).toEqual([]);
  });

  it("fails with exit 1 outside a git repository", async () => {
    const code = await runInit({ ...DEFAULT_OPTS }, makeDeps({ git: "outside" }));

    expect(code).toBe(EXIT_PROBLEMS);
    expect(stderr.join("")).toContain("not inside a git repository");
  });

  it("refuses an existing yoke.yaml without --force and writes nothing", async () => {
    await writeFile(join(repo, "yoke.yaml"), "version: 1\nharnesses: []\n", "utf8");
    const code = await runInit({ ...DEFAULT_OPTS }, makeDeps());

    expect(code).toBe(EXIT_PROBLEMS);
    expect(stderr.join("")).toContain("pass --force");
    expect(await readFile(join(repo, "yoke.yaml"), "utf8")).toBe("version: 1\nharnesses: []\n");
    expect(await listRepo()).toEqual(["yoke.yaml"]);
  });

  it("with --force, backs up an existing yoke.yaml before overwriting it", async () => {
    await writeFile(join(repo, "yoke.yaml"), "version: 1\nharnesses: []\n", "utf8");
    const code = await runInit({ ...DEFAULT_OPTS, force: true }, makeDeps());

    expect(code).toBe(EXIT_OK);
    expect(await readFile(join(repo, "yoke.yaml"), "utf8")).toContain("alpha");
    const backups = await readdir(join(home, ".config", "yoke", "backups"));
    expect(backups.length).toBe(1);
  });

  it("refuses a different existing AGENTS.md without --force and leaves it unchanged", async () => {
    await seedNativeFile();
    await writeFile(join(repo, "AGENTS.md"), "# mine\n", "utf8");
    const code = await runInit({ ...DEFAULT_OPTS }, makeDeps());

    expect(code).toBe(EXIT_PROBLEMS);
    expect(await readFile(join(repo, "AGENTS.md"), "utf8")).toBe("# mine\n");
    expect(await listRepo()).not.toContain("yoke.yaml");
  });

  it("refuses --secrets local with --no-gitignore when yoke.local.yaml is not ignored", async () => {
    await seedNativeFile();
    const code = await runInit({ ...DEFAULT_OPTS, gitignore: false }, makeDeps());

    expect(code).toBe(EXIT_USAGE);
    expect(stderr.join("")).toContain("yoke.local.yaml ignored");
    expect(await listRepo()).toEqual(["ALPHA.md"]);
  });

  it("allows --secrets ref with --no-gitignore and writes no gitignore", async () => {
    await seedNativeFile();
    const code = await runInit({ ...DEFAULT_OPTS, secrets: "ref", gitignore: false }, makeDeps());

    expect(code).toBe(EXIT_OK);
    expect(await listRepo()).not.toContain(".gitignore");
    expect(stdout.join("")).toContain("export these variables");
  });
});

describe("runInit, interactive", () => {
  it("imports the picked harness without any file prompt when there is one candidate", async () => {
    await seedNativeFile();
    const code = await runInit(
      { ...DEFAULT_OPTS, importFrom: undefined },
      makeDeps({ interactive: true }),
    );

    expect(code).toBe(EXIT_OK);
    expect(await readFile(join(repo, "AGENTS.md"), "utf8")).toBe("# rules\n");
  });

  it("returns exit 130 and writes nothing when the user cancels the picker", async () => {
    await seedNativeFile();
    const prompts = fakePrompts({ multiselect: async () => CANCEL });
    const code = await runInit(
      { ...DEFAULT_OPTS, importFrom: undefined },
      makeDeps({ interactive: true, prompts }),
    );

    expect(code).toBe(EXIT_INTERRUPTED);
    expect(await listRepo()).toEqual(["ALPHA.md"]);
  });

  it("asks before overwriting a different AGENTS.md and backs it up when confirmed", async () => {
    await seedNativeFile();
    await writeFile(join(repo, "AGENTS.md"), "# mine\n", "utf8");
    let asked = 0;
    const prompts = fakePrompts({
      select: async () => join(repo, "ALPHA.md"),
      confirm: async () => {
        asked += 1;
        return true;
      },
    });
    const code = await runInit(
      { ...DEFAULT_OPTS, importFrom: undefined },
      makeDeps({ interactive: true, prompts }),
    );

    expect(code).toBe(EXIT_OK);
    expect(asked).toBe(1);
    expect(await readFile(join(repo, "AGENTS.md"), "utf8")).toBe("# rules\n");
    const backups = await readdir(join(home, ".config", "yoke", "backups"));
    expect(backups.length).toBe(1);
  });

  it("returns exit 130 when the user declines the AGENTS.md overwrite", async () => {
    await seedNativeFile();
    await writeFile(join(repo, "AGENTS.md"), "# mine\n", "utf8");
    const prompts = fakePrompts({
      select: async () => join(repo, "ALPHA.md"),
      confirm: async () => false,
    });
    const code = await runInit(
      { ...DEFAULT_OPTS, importFrom: undefined },
      makeDeps({ interactive: true, prompts }),
    );

    expect(code).toBe(EXIT_INTERRUPTED);
    expect(await readFile(join(repo, "AGENTS.md"), "utf8")).toBe("# mine\n");
    expect(await listRepo()).not.toContain("yoke.yaml");
  });
});

describe("runInit, user-scope yoke.yaml", () => {
  const userDir = (): string => join(home, ".config", "yoke");
  const userPath = (): string => join(userDir(), "yoke.yaml");

  /** Text of every file under a directory, recursively. A missing directory gives an empty list. */
  async function filesUnder(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const texts: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        texts.push(...(await filesUnder(path)));
      } else if (entry.isFile()) {
        texts.push(await readFile(path, "utf8"));
      }
    }
    return texts;
  }

  it("creates the user-scope yoke.yaml with the user server, mode 0600, and keeps it out of the project file", async () => {
    await seedNativeFile();
    const code = await runInit({ ...DEFAULT_OPTS }, makeDeps());

    expect(code).toBe(EXIT_OK);
    const user = await readFile(userPath(), "utf8");
    expect(user).toContain("personal");
    expect((await stat(userPath())).mode & 0o777).toBe(0o600);
    expect(await readFile(join(repo, "yoke.yaml"), "utf8")).not.toContain("personal");
    expect(stdout.join("")).toContain(`written: ${userPath()}`);
    expect(stdout.join("")).toContain("next: yoke sync --global");
  });

  it("keeps an existing user file's comment and servers, adds the missing one, and backs up the original", async () => {
    await seedNativeFile();
    const original =
      "version: 1\n# my servers\nmcps:\n  other:\n    transport: stdio\n    command: uvx\n";
    await mkdir(userDir(), { recursive: true });
    await writeFile(userPath(), original, "utf8");
    const code = await runInit({ ...DEFAULT_OPTS }, makeDeps());

    expect(code).toBe(EXIT_OK);
    const user = await readFile(userPath(), "utf8");
    expect(user).toContain("# my servers");
    expect(user).toContain("other:");
    expect(user).toContain("personal:");
    expect(await filesUnder(join(userDir(), "backups"))).toContain(original);
    expect(stdout.join("")).toContain(`written: ${userPath()} (backup: `);
  });

  it("makes the user plan a noop on a rerun with --force and does not back the user file up again", async () => {
    await seedNativeFile();
    await runInit({ ...DEFAULT_OPTS }, makeDeps());
    const first = await readFile(userPath(), "utf8");
    stdout = [];
    const code = await runInit({ ...DEFAULT_OPTS, force: true }, makeDeps());

    expect(code).toBe(EXIT_OK);
    expect(await readFile(userPath(), "utf8")).toBe(first);
    expect(stdout.join("")).not.toContain(userPath());
    expect(stdout.join("")).not.toContain("next: yoke sync --global");
  });

  it("keeps a conflicting existing entry unchanged, prints a note, and writes nothing", async () => {
    await seedNativeFile();
    const original =
      "version: 1\nmcps:\n  personal:\n    transport: stdio\n    command: other-bin\n";
    await mkdir(userDir(), { recursive: true });
    await writeFile(userPath(), original, "utf8");
    const code = await runInit({ ...DEFAULT_OPTS }, makeDeps());

    expect(code).toBe(EXIT_OK);
    expect(await readFile(userPath(), "utf8")).toBe(original);
    expect(stdout.join("")).toContain(
      `note: user server "personal" already in ${userPath()} with a different definition`,
    );
    expect(await readdir(userDir())).toEqual(["yoke.yaml"]);
  });

  it("fails with exit 1 and writes nothing when the existing user file is invalid", async () => {
    await seedNativeFile();
    await mkdir(userDir(), { recursive: true });
    await writeFile(userPath(), "version: 2\n", "utf8");
    const code = await runInit({ ...DEFAULT_OPTS }, makeDeps());

    expect(code).toBe(EXIT_PROBLEMS);
    expect(await readFile(userPath(), "utf8")).toBe("version: 2\n");
    expect(await listRepo()).toEqual(["ALPHA.md"]);
  });
});
