# `yoke` — Technical Specification

> **One config, any coding harness.** Sync MCP servers, instructions, and live sessions across Claude Code, Antigravity (`agy`), OpenCode, Gemini CLI, Codex, and beyond.

---

## 1. Vision & Non-Goals

Developers increasingly run multiple AI coding CLIs side by side to work around 5-hour subscription quotas or pair models by strength. Switching harnesses mid-task breaks flow because static configuration (MCP servers, instruction files) and dynamic state (active sessions) are fragmented across incompatible schemas and paths.

`yoke` solves both halves in one CLI—ensuring **pre-flight parity** (detecting and syncing native config drift before handing off a session) so the receiving harness wakes up with the exact same tools, rules, and context.

### Explicit Non-Goals
* `yoke` is **not** an LLM proxy, API router, or OAuth wrapper. It never intercepts model traffic or violates consumer subscription Terms of Service.
* `yoke` does **not** attempt brittle 1:1 translation of proprietary tool-call schemas (`Edit` vs. `replace_file_content`) or cryptographic thinking/thought signatures between providers.

---

## 2. High-Level Architecture

`yoke` is a local CLI built around **two engines**, a **3-way drift tracker**, and a strict **Adapter Pattern**:

```text
                     ┌──▶ Static Sync Engine  ──▶ .mcp.json / ~/.claude.json / CLAUDE.md
yoke.yaml            │                            ~/.gemini/config/mcp_config.json / GEMINI.md
AGENTS.md  ──────────┼──▶ 3-Way Drift Engine  ◄── .yoke/state.json (last-synced hashes)
                     │
                     └──▶ Session Mediator    ──▶ Claude .jsonl ◄─▶ session.json ◄─▶ agy launch/import
```

### Tech Stack
* **Language / Runtime:** TypeScript (Node 20+ / Bun)
* **Core Libraries:**
  * `zod` — strict schema validation for `yoke.yaml`, `.yoke/state.json`, and `YokeSessionIR`
  * `yaml` — YAML parsing and serialization
  * `commander` — CLI command routing
  * `@clack/prompts` — interactive pre-flight drift prompts
  * `picocolors` — colorized diffs and `doctor` output
  * `vitest` — unit and fixture-based adapter tests

---

## 3. Canonical 3-Tier Scope Model

Precedence is strictly **`local` > `project` > `user`**.

`<userConfigDir>` is `$XDG_CONFIG_HOME/yoke` when `XDG_CONFIG_HOME` is an absolute path, otherwise `~/.config/yoke`. An empty or comment-only scope file is rejected; every scope file needs at least `version: 1`.

| Scope | Source Files | Git Status | Purpose |
| :--- | :--- | :--- | :--- |
| **`user`** | `<userConfigDir>/yoke.yaml`<br>`<userConfigDir>/AGENTS.md` | N/A | Global MCPs, global coding style, default harness list |
| **`project`** | `./yoke.yaml`<br>`./AGENTS.md` | Committed | Team-shared MCPs, repo architecture & rules |
| **`local`** | `./yoke.local.yaml`<br>`./AGENTS.local.md` | Gitignored | Personal overrides, local-only MCPs, disabling inherited MCPs |

### Sync Modes (Handling Harness Asymmetry)
Claude Code natively supports a 3rd `local` tier (`CLAUDE.local.md` + per-project overrides in `~/.claude.json`). Other harnesses may not expose an equivalent tier; the scope split for `agy` is unverified in v0.1. `yoke` supports two modes:

1. **`compiled` (Default):** Treats all generated harness files (`.mcp.json`, `CLAUDE.md`, `GEMINI.md`) as gitignored build artifacts. `yoke sync` writes project servers and instructions into the target files for harnesses that support them, and writes local-scope Claude servers to `projects[<git root>].mcpServers` in `~/.claude.json`, never into a repo file, without polluting `git status`. Project and local MCP servers are not written for `agy` in v0.1 (see §6).
2. **`hybrid` (Mixed Teams):** Writes only `project` into tracked files so teammates without `yoke` still get valid configs. Maps `local` natively where supported (Claude), warns if a non-env `local` override cannot be isolated for a harness, and relies on `.env.local` (gitignored) for private tokens. Disabling a user-scope server in hybrid mode uses the `disabledMcpjsonServers` key in place of `disabledMcpServers`.

### 3.1 Merge rules

When the same MCP server name appears in more than one scope, entries are merged in precedence order (`local` > `project` > `user`) using these rules:

* **Maps** (`env`, `headers`) merge field by field; higher-precedence keys win.
* **Arrays** (`args`) are replaced whole, never concatenated.
* **A change of `transport`** replaces the whole server entry; no fields are inherited from the lower scope.
* **`enabled: false` with no `transport`** is not a transport change. It is a stub that suppresses the inherited entry.
* **`enabled` across a redefinition:** a same-transport override that omits `enabled` keeps the inherited `enabled` value, so a disabled server stays disabled. A transport change resets `enabled` to `true` unless the override sets it.
* **Non-MCP keys** (`mode`, `instructions`, `session`, and so on) take the value from the highest scope that sets them. `harnesses` is replaced whole, never merged.

* **Full definitions only:** every non-stub entry must be a complete definition with a `transport`. Partial overrides of a lower-scope server (for example, only `env` in `yoke.local.yaml`) are not valid; use a full entry, which follows the transport-change or field-merge rules above.
* **YAML `null` is rejected** everywhere in v0.1 (`env: { KEY: null }`, `headers: null`, and so on).

**Open item:** whether `null` should later remove an inherited field is undecided.

---

## 4. Canonical Schemas

### 4.1 `yoke.yaml` (Static Configuration)

```yaml
version: 1
mode: compiled # compiled | hybrid
harnesses:
  - claude
  - agy

mcps:
  # Local stdio server
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
    env:
      LOG_LEVEL: info

  # Remote server (http, or sse where the harness supports it)
  linear:
    transport: http # http | sse
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: "Bearer ${LINEAR_API_KEY}"

  # Disable an inherited user-level MCP in this project
  github:
    enabled: false

instructions:
  source: AGENTS.md
  preferSymlink: true # Symlink when no conditional blocks or local overrides exist

session:
  maxTurns: 40
  includeGitDiffStat: true
```

**Defaults (applied after merge, not in the scope files):** `mode: compiled`, `harnesses: []`, `instructions.source: AGENTS.md` (in `ResolvedYokeConfig` the source is an absolute path, resolved against the declaring file's directory or, for the default, the repo root), `instructions.preferSymlink: true`, `session.maxTurns: 40`, `session.includeGitDiffStat: true`.

**Schema rules** (`src/core/schema.ts`):
* **Strict objects:** unknown keys are rejected in every file and nested object (this catches typos such as `mcpServers:`). An older `yoke` therefore rejects files written by a newer one.
* **`version: 1` is required** in every scope file, including `yoke.local.yaml`. All other top-level keys are optional.
* **Strings only:** `env` and `headers` values must be YAML strings (`PORT: "8080"`); numbers and booleans are not coerced. `env` keys match `^[A-Za-z_][A-Za-z0-9_]*$`.
* **URLs** must start with `http://`, `https://`, or a `${VAR}` reference, so `${MCP_HOST}/mcp` is valid.
* **Names:** harness names match `^[a-z][a-z0-9-]{0,31}$` (no `:`, because they form the state key); MCP server names match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. `harnesses` must not contain duplicates.
* **`instructions.source`** is relative to the directory of the yaml file that declares it.
* **`session.maxTurns`** is a positive integer with no upper bound.

### 4.2 Conditional Instruction Blocks (`AGENTS.md`)
The instruction compiler supports optional harness-scoped blocks:

```markdown
<!-- yoke:claude-only -->
Use the native Edit tool for surgical refactors.
<!-- /yoke:claude-only -->

<!-- yoke:agy-only -->
Summarize large directory scans before proposing edits.
<!-- /yoke:agy-only -->
```

* If no conditional blocks and no `AGENTS.local.md` exist (and `preferSymlink: true`), adapters create symlinks (`CLAUDE.md -> AGENTS.md`, `GEMINI.md -> AGENTS.md`).
* Otherwise, adapters compile target-specific files prefixed with `<!-- GENERATED BY YOKE — DO NOT EDIT DIRECTLY -->`. The compiled form is also used when symlinks are unsupported.

**Compilation rules:**
* A tag must stand alone on its line. Tags inside fenced code blocks are ignored.
* Nested, unclosed, or mismatched tags are errors.
* Blocks for targets other than the one being compiled are removed; the tag lines of the matching target are dropped and its content kept.
* The local instruction file (`AGENTS.local.md`, derived from the source path by putting `.local` before the extension) is compiled the same way and appended after a blank line.

### 4.3 Drift Lockfile (`.yoke/state.json`, gitignored)
Tracks the last-synced canonical snapshot per harness so `yoke` can distinguish **new native edits** from **stale values**:

```typescript
export interface YokeStateLock {
  version: 1;
  lastSyncedAt: string;
  harnesses: Record<
    string, // "<harness>:<scope>", e.g. "claude:project"
    {
      mcpHashes: Record<string, string>; // serverName -> sha256 of canonical MCP definition
      instructionsHash: string | null;   // sha256 of last-written instruction target; null if yoke wrote none
    }
  >;
}
```

* **Keys** are `"<harness>:<scope>"` (scope is `user`, `project`, or `local`). The field keeps the name `harnesses`.
* **Hashes** are lowercase hex sha256 with no `sha256:` prefix (64 characters). Hashed input is the sorted-key canonical JSON of the value: keys sorted recursively, array order kept, no whitespace, `undefined`-valued keys omitted, UTF-8. `lastSyncedAt` is an ISO-8601 date-time.
* **Symlinked instructions:** the instruction target is hashed as `{kind:"symlink",target}` for a symlink and `{kind:"file",content}` for a file, so editing `AGENTS.md` behind a `CLAUDE.md` symlink is not drift. This is applied by `src/core/drift.ts`; `schema.ts` only models the native shape (§6).

### 4.4 Mediator Session IR (`.yoke/sessions/<id>.json`, gitignored)

```typescript
export interface YokeSessionIR {
  version: 1;
  id: string;
  createdAt: string;
  sourceHarness: string;
  repoPath: string;
  git: {
    branch: string;
    statusShort: string;
    diffStat: string;
  };
  turns: Array<{
    role: "user" | "assistant";
    timestamp?: string;
    content: string;
    /** Flattened, human-readable summaries of tool actions (no raw schemas/dumps) */
    actions?: Array<{
      kind: "read" | "edit" | "command" | "search" | "mcp" | "other";
      summary: string; // e.g., "Edited src/auth.ts (+14/-3)"
    }>;
  }>;
}
```

**Schema limits:** `id` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` (it becomes a file name); `sourceHarness` is a harness name; `repoPath` is non-empty but not checked for being absolute; `branch` may be empty (detached or unborn HEAD); `turns` may be empty. Each `actions[].summary` is 1 to 300 characters and single-line. `content` has no length cap (the exporter enforces invariant 6). Objects are strict, so keys such as `thinking` or `signature` are rejected. Timestamps are ISO-8601 date-times.

**Session Translation Rules:**
* **Strip:** Cryptographic thinking/thought signatures, raw multi-hundred-line file reads, and verbose terminal logs.
* **Preserve:** User intents, assistant decisions/plans, compact `actions[]` summaries, and live `git` state.

---

## 5. Pre-Flight Drift Detection (v0.1) and Absorption (v0.2)

Developers frequently add MCP servers (`claude mcp add ...`) or edit `CLAUDE.md` natively mid-session. Before overwriting configs (`yoke sync`) or switching harnesses (`yoke switch <target>`), `yoke` runs a **3-way drift check**:

1. **Reverse-read:** Call `sourceAdapter.readNativeState(repoPath)` to parse the harness's current native MCPs and instructions back into canonical `yoke` format.
2. **Diff against `.yoke/state.json`:** Any server or instruction block that differs from the last-synced hash is flagged as a *native mutation*.
3. **Prompt the user (v0.1):** Drift offers only two choices:
   ```text
   Native changes detected in Claude Code since last sync:
     + MCP server: "postgres" (stdio: npx -y @modelcontextprotocol/server-postgres)
     ~ CLAUDE.md: +3 lines added

   ? How do you want to proceed?
     > Overwrite with yoke config
       Abort
   ```
   In non-interactive mode, `yoke` aborts unless `--force` is passed. Before overwriting, the original file is backed up (see §8, invariant 2).

### v0.2

In v0.2, the prompt is replaced by an absorption flow:

3. **Prompt the user:**
   ```text
   Pre-flight check (claude -> agy)
     Detected native changes in Claude Code since last sync:
     + MCP server: "postgres" (stdio: npx -y @modelcontextprotocol/server-postgres)
     ~ CLAUDE.md: +3 lines added

   ? Bring these changes into yoke and sync to agy before switching?
     > Yes — add to yoke.yaml (project) & sync to agy
       Yes — add to yoke.local.yaml (local/gitignored) & sync to agy
       Only MCPs (skip instruction diff)
       No — switch session only (keep changes in Claude)
   ```
4. **Absorb & Sync:** Write accepted changes back to `yoke.yaml` / `yoke.local.yaml`, sync the target harness, update `.yoke/state.json`, and proceed with the session handoff.

---

## 6. Adapter Contract & Capability Matrix

Every harness implements a single interface (`src/adapters/base.ts`) with an explicit `capabilities` declaration so the core engine degrades gracefully for partial adapters.

```typescript
export interface HarnessCapabilities {
  staticMcp: boolean;
  staticInstructions: boolean;
  reverseRead: boolean; // Required for drift detection and init in v0.1, and for absorption in v0.2
  sessionExport: boolean;
  sessionImport: "native" | "seeded" | "handoff-file-only";
}

export interface HarnessStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
}

export interface FileChangePlan {
  path: string;
  action: "create" | "update" | "symlink" | "patch-json" | "noop";
  summary: string;
  before?: string; // current content, for diffs
  after?: string;  // planned content, for diffs
  apply: () => Promise<void>;
}

export interface HarnessAdapter {
  readonly name: string;
  readonly capabilities: HarnessCapabilities;
  detect(): Promise<HarnessStatus>;
  readNativeState(repoPath: string): Promise<PartialYokeConfig>;
  syncStatic(config: ResolvedYokeConfig, opts: SyncOptions): Promise<FileChangePlan[]>;
  exportLatestSession?(repoPath: string): Promise<YokeSessionIR | null>;
  importAndLaunch?(session: YokeSessionIR, opts: LaunchOptions): Promise<void>;
}
```

### Adapter Types (`src/core/schema.ts`)

The types below are defined in `src/core/schema.ts` and imported by adapters and commands.

```typescript
// Result of readNativeState: one entry per native tier the adapter exposes and read.
// An absent key means "not supported or not read"; `mcps: {}` means "read, empty".
interface PartialYokeConfig {
  user?: NativeScopeState;
  project?: NativeScopeState;
  local?: NativeScopeState;
}
interface NativeScopeState {
  mcps: Record<string, McpServerDefinition>; // disabled native entry => full definition with enabled: false
  instructions?:
    | { kind: "file"; path: string; content: string }
    | { kind: "symlink"; path: string; target: string };
}

// Merged effective config (local > project > user), defaults applied.
interface ResolvedYokeConfig {
  version: 1;
  mode: "compiled" | "hybrid";
  harnesses: string[];
  mcps: Record<string, McpServerDefinition & { enabled: boolean; scopes: Scope[] }>;
  instructions: { source: string; preferSymlink: boolean };
  session: { maxTurns: number; includeGitDiffStat: boolean };
  layers: { user?: YokeConfig; project?: YokeConfig; local?: YokeConfig }; // validated per-scope inputs
}

interface SyncOptions {
  readonly repoPath: string;          // absolute repo root
  readonly scopes: readonly Scope[];  // `sync` -> project, local; `--global` -> user; `--all` -> all three
  readonly warn: (message: string) => void;
}

interface LaunchOptions {
  readonly repoPath: string;  // absolute repo root
  readonly launch: boolean;   // false for --no-launch
}
```

Planning receives a read-only filesystem; each `apply` closure holds the writable filesystem and the backup session. Adapters receive `fs`, `homeDir`, and `env` at construction, so tests can inject them. Conditional-block target validation uses the configured `harnesses` list, so a misspelled target is an error.

`ResolvedMcpServer.scopes` lists contributing scopes in ascending precedence. A stub with nothing beneath it is dropped by the merge. `SyncOptions` and `LaunchOptions` are plain TypeScript interfaces, not Zod schemas, and live in `schema.ts` so core and commands share one types module.

### Target Capability Matrix

| Harness | Static MCP & Rules | Reverse-Read (Drift) | Session Export | Session Import |
| :--- | :---: | :---: | :---: | :---: |
| **Claude Code** *(v0.1)* | Yes | Yes | Yes (`.jsonl`) | Native (`--resume`) |
| **Antigravity (`agy`)** *(v0.1)* | Yes | Yes | Yes | Seeded launch (`HANDOFF.md`) |
| **OpenCode** *(v0.3)* | Yes | Yes | Yes (SQLite) | Native / Seeded launch |
| **Gemini CLI** *(v0.3)* | Yes | Yes | Yes | Seeded launch |
| **Codex CLI** *(v0.3)* | Yes | Yes | Yes (`.jsonl`) | Native / Seeded launch |
| **Cursor** *(v0.3)* | Yes | Yes | Partial | `HANDOFF.md` only |

### Concrete File & Schema Mappings (v0.1)

| Feature | `claude` Adapter | `agy` Adapter |
| :--- | :--- | :--- |
| **User MCP** | `~/.claude.json` (patch *only* `mcpServers`) | `~/.gemini/config/mcp_config.json` (top-level `mcpServers` object; patch only that key) |
| **Project MCP** | `./.mcp.json` | Not supported in v0.1 |
| **Local MCP** | `projects[<git root realpath>].mcpServers` in `~/.claude.json` | Not supported in v0.1; local servers are skipped with a warning (see mapping rules) |
| **Remote HTTP Key** | `"type": "http"`, `"url": "..."` | `"url": "..."` is the key yoke writes (`readNativeState` also accepts the legacy alias `serverUrl`). agy 1.5.16 writes `serverUrl` when set via its CLI; yoke reads both and writes `url`. |
| **Disable (`enabled: false`)** | For a project-level disable of a user-scope server, write the server name into `projects[<repo>].disabledMcpServers` in `~/.claude.json`, and track the name in `.yoke/state.json` so only yoke-added names are removed later. This key is undocumented in Claude Code (undocumented; verified against Claude Code 2.1.331). In `hybrid` mode, the same disable is written to `projects[<repo>].disabledMcpjsonServers` instead, because `.mcp.json` is the tracked file in that mode. If the write is not possible, yoke warns and names the file, the harness, the scope, and the manual fix (`/mcp disable`). | `"disabled": true`, emitted only when the merged result still has a full definition. A stub with only `enabled: false` (no transport) suppresses the inherited entry. |
| **User Instructions** | `~/.claude/CLAUDE.md` | `~/.gemini/GEMINI.md` *(unverified)* |
| **Project Instructions** | `./CLAUDE.md` (+ `./CLAUDE.local.md` in hybrid) | `./GEMINI.md` *(unverified)* |
| **Session Export** | Latest `.jsonl` in `~/.claude/projects/<repo-hash>/` | Latest local `agy` session log or `.yoke/HANDOFF.md` |
| **Session Import** | Synthesize valid `.jsonl` + spawn `claude --resume <id>` | Render `.yoke/HANDOFF.md` + spawn `agy` with bootstrap prompt |

**Mapping rules:**
* agy does not support legacy HTTP+SSE. `transport: sse` servers are skipped for agy with a warning in `sync` and `doctor`, and are excluded from agy's `mcpHashes`. Claude keeps `type: "sse"`.
* agy project-level MCP is not supported in v0.1 (unverified; no evidence of a per-project mechanism). Project and local MCP servers are SKIPPED for agy with a warning. They are never written to the global file.
* Unknown keys inside an MCP entry are kept on rewrite when the transport is unchanged and are excluded from drift. Unknown top-level keys in a native config file are never parsed or modified.
* An entry with an unknown transport (for example Claude's `ws`) is left unchanged and not managed. It is an error only when yoke defines a server with the same name, unless `--force` is passed.
* `${VAR}` is stored literally in both harnesses. Claude expands it at runtime; agy does not, so yoke warns for each agy server whose env or headers use `${VAR}`.

---

## 7. CLI Command Surface

| Command | Behavior |
| :--- | :--- |
| `yoke init [--import-from <source>...]` | Detects installed harnesses, imports existing MCPs & instructions into `yoke.yaml` + `AGENTS.md`, and optionally updates `.gitignore`. Sources are a harness name (`claude`, `agy`) or a file path (`CLAUDE.md`, `GEMINI.md`, a native MCP JSON). Without the flag, init prompts interactively; with the flag, it runs non-interactively. If instruction sources differ, init must not auto-merge; the user picks one. Literal secrets found in imported `env` or `headers` become `${VAR}` references or go to `yoke.local.yaml`, never into committed `yoke.yaml`. |
| `yoke sync [--dry-run] [--global \| --all] [--force]` | Checks for native drift (unless `--force`); on drift, offers "Overwrite with yoke config" or "Abort" (v0.1; absorption arrives in v0.2). Compiles/symlinks configs across enabled harnesses, prints a colorized diff, and updates `.yoke/state.json`. |
| `yoke switch <target> [--from <source>] [--no-launch]` | Runs pre-flight drift check (absorption in v0.2) -> exports active session to `YokeSessionIR` -> imports/launches `<target>`. |
| `yoke sessions` | Lists saved `YokeSessionIR` snapshots in `.yoke/sessions/` for resuming in any harness. |
| `yoke doctor` | Verifies CLI binaries, auth status (`claude --version`, `agy models` *(unverified)*), broken symlinks, and config drift. |

---

## 8. Non-Negotiable Safety Invariants

1. **Zero-Clobber JSON Patching:** Never overwrite any shared harness config (`~/.claude.json`, agy `mcp_config.json`, and other shared files) wholesale. Read -> parse -> patch *only* the target key (e.g., `mcpServers`) -> atomic write (write to `.tmp` + `rename`).

   **Temp file (§8.1):** the temp file is `<name>.<random>.yoke.tmp` in the target's directory, created exclusively (`wx`) and renamed into place.
2. **Automatic Backups:** Always back up. Before `yoke` overwrites or patches any file, it copies the original to `<userConfigDir>/backups/<timestamp>/`. This includes yoke-managed files when drift is detected and the user chooses overwrite, and JSON-patched shared files (`~/.claude.json`, agy `mcp_config.json`), which are never considered managed. A file is "yoke-managed" if it carries the `GENERATED` header or is a symlink yoke created.

   **Backup location (§8.2):** backups go to `<userConfigDir>/backups/<timestamp>/`, where the timestamp is ISO-8601 with `:` and `.` replaced by `-`. The original absolute path is mirrored under that directory. A `-N` suffix avoids collisions between sessions. The directory is mode `0700`. Writes never follow a yoke-managed instruction symlink; the symlink is replaced instead.
3. **Dry-Run Parity:** `sync` always computes a `FileChangePlan[]` before touching disk; `--dry-run` executes the exact same planning pipeline without calling `apply()`.
4. **No Secret Leakage:** Never expand `${ENV_VAR}` values into plaintext inside generated project files; preserve variable references in the target harness's native syntax.
5. **No Silent Overwrites:** If a native file differs from `.yoke/state.json`, `yoke sync` must prompt (or abort in non-interactive CI unless `--force` is passed).
6. **Lossy-but-Clean Session IR:** Never copy provider-specific thinking/thought signatures or raw multi-hundred-line file dumps into `YokeSessionIR`. Flatten tool calls into compact `actions[]` summaries.

---

## 9. Repository Layout & Implementation Milestones

```text
yoke/
├── src/
│   ├── cli.ts                  # Commander entrypoint
│   ├── core/
│   │   ├── schema.ts           # Zod schemas (yoke.yaml, YokeStateLock, YokeSessionIR)
│   │   ├── scopes.ts           # 3-tier loader & deep-merge engine
│   │   ├── json-text.ts        # Text-preserving JSON patching (zero-clobber edits)
│   │   ├── drift.ts            # 3-way diff; absorption in v0.2
│   │   ├── compiler.ts         # AGENTS.md conditional block compiler
│   │   ├── git.ts              # Repo root, branch, status, diffStat helpers
│   │   └── fs-safe.ts          # Atomic write, JSON patch, backup, symlink utils
│   ├── adapters/
│   │   ├── base.ts             # HarnessAdapter + HarnessCapabilities
│   │   ├── claude.ts           # Claude Code adapter
│   │   └── agy.ts              # Antigravity (agy) adapter
│   └── commands/
│       ├── init.ts
│       ├── sync.ts
│       ├── switch.ts
│       ├── sessions.ts
│       └── doctor.ts
├── tests/
│   ├── fixtures/               # Sample ~/.claude.json, .mcp.json, .jsonl logs
│   ├── core/                   # compiler, fs-safe, json-text, scope loader, git tests
│   ├── schema/                 # Zod schema tests
│   ├── setup/                  # Test setup (isolated HOME)
│   ├── scopes.test.ts
│   ├── drift.test.ts           # placeholder until the adapter step
│   └── adapters.test.ts        # placeholder until the adapter step
└── package.json
```

### Milestones
* **v0.1 — Static Core & Drift Protection:** `schema.ts`, `scopes.ts`, `fs-safe.ts`, `compiler.ts`, `drift.ts`, `claude` & `agy` static adapters (including `readNativeState`), `yoke init`, `yoke sync --dry-run`, `yoke doctor`.
* **v0.2 — Interactive Pre-Flight & Session Handoff:** `YokeSessionIR`, Claude `.jsonl` parser/writer (`claude --resume`), `agy` handoff launcher, `yoke switch <target>` with interactive drift absorption, `yoke sessions`.
* **v0.3 — Ecosystem Adapters:** Add `opencode` and `gemini-cli` adapters to validate the `HarnessAdapter` abstraction for community contributors.