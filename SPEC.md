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
                     ┌──▶ Static Sync Engine  ──▶ .mcp.json / ~/.claude.json
yoke.yaml            │                            ~/.gemini/config/mcp_config.json
AGENTS.md  ──────────┼──▶ 3-Way Drift Engine  ◄── .yoke/yoke.lock (last-synced hashes)
                     │
                     └──▶ Session Mediator    ──▶ Claude .jsonl ◄─▶ session.json ◄─▶ agy launch/import
```

### Tech Stack
* **Language / Runtime:** TypeScript (Node 20+ / Bun)
* **Core Libraries:**
  * `zod` — strict schema validation for `yoke.yaml`, `.yoke/yoke.lock`, and `YokeSessionIR`
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
| **`local`** | `./yoke.local.yaml` | Gitignored | Personal overrides, local-only MCPs, disabling inherited MCPs |

### Sync Modes (Handling Harness Asymmetry)
Claude Code natively supports a 3rd `local` tier (`CLAUDE.local.md`, which the user writes and yoke does not manage, + per-project overrides in `~/.claude.json`). Other harnesses may not expose an equivalent tier; the scope split for `agy` is unverified in v0.1. `yoke` supports two modes:

1. **`compiled` (Default):** Treats all generated files (`.mcp.json`) as gitignored build artifacts. `yoke sync` writes project servers into the target files for harnesses that support them, and writes local-scope Claude servers to `projects[<git root>].mcpServers` in `~/.claude.json`, never into a repo file, without polluting `git status`. Instructions are not generated: `AGENTS.md` is the only instruction file (§4.2). Project and local MCP servers are not written for `agy` in v0.1 (see §6).
2. **`hybrid` (Mixed Teams):** Writes only `project` into tracked files so teammates without `yoke` still get valid configs. Maps `local` natively where supported (Claude), warns if a non-env `local` override cannot be isolated for a harness, and relies on `.env.local` (gitignored) for private tokens. In `hybrid` mode, a project-level disable of a user-scope Claude server is not written to a tracked file in v0.1; it is reported as a warning instead (see §6).

### 3.1 Merge rules

When the same MCP server name appears in more than one scope, entries are merged in precedence order (`local` > `project` > `user`) using these rules:

* **Maps** (`env`, `headers`) merge field by field; higher-precedence keys win.
* **Arrays** (`args`) are replaced whole, never concatenated.
* **A change of `transport`** replaces the whole server entry; no fields are inherited from the lower scope.
* **`enabled: false` with no `transport`** is not a transport change. It is a stub that suppresses the inherited entry.
* **`enabled` across a redefinition:** a same-transport override that omits `enabled` keeps the inherited `enabled` value, so a disabled server stays disabled. A transport change resets `enabled` to `true` unless the override sets it.
* **Non-MCP keys** (`mode`, `session`, and so on) take the value from the highest scope that sets them. `harnesses` is replaced whole, never merged.

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

session:
  maxTurns: 40
  includeGitDiffStat: true
```

**Defaults (applied after merge, not in the scope files):** `mode: compiled`, `harnesses: []`, `session.maxTurns: 40`, `session.includeGitDiffStat: true`.

**Schema rules** (`src/core/schema.ts`):
* **Strict objects:** unknown keys are rejected in every file and nested object (this catches typos such as `mcpServers:`). An older `yoke` therefore rejects files written by a newer one.
* **`version: 1` is required** in every scope file, including `yoke.local.yaml`. All other top-level keys are optional.
* **Strings only:** `env` and `headers` values must be YAML strings (`PORT: "8080"`); numbers and booleans are not coerced. `env` keys match `^[A-Za-z_][A-Za-z0-9_]*$`.
* **URLs** must start with `http://`, `https://`, or a `${VAR}` reference, so `${MCP_HOST}/mcp` is valid.
* **Names:** harness names match `^[a-z][a-z0-9-]{0,31}$` (no `:`, because they form the state key); MCP server names match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. `harnesses` must not contain duplicates.
* **No `instructions:` key.** Instruction paths are fixed (`<repo>/AGENTS.md` and `<userConfigDir>/AGENTS.md`), so an `instructions:` key is rejected like any other unknown key.
* **`session.maxTurns`** is a positive integer with no upper bound.

### 4.2 Instruction Files
`AGENTS.md` is the only shared instruction file, and the user is the only one who edits it. Both harnesses read it natively, so `yoke` writes no project instruction file.

* **`CLAUDE.md`:** yoke never writes it. Claude stops loading `AGENTS.md` when a `CLAUDE.md` exists unless that file imports it, so `sync` and `doctor` warn if a user-written `CLAUDE.md` does not start with the line `@AGENTS.md`.
* **`GEMINI.md`:** yoke never writes it. `agy` reads `AGENTS.md` natively (observed with agy: a model turn listed both `AGENTS.md` and `GEMINI.md` as loaded instruction files). A user may add a `GEMINI.md` for agy-only text; yoke does not manage it.
* **Personal text:** `AGENTS.local.md` is not supported. Personal instruction text goes in Claude's `CLAUDE.local.md`, which the user writes.
* **User scope:** `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md` are symlinks to `<userConfigDir>/AGENTS.md`. There is no copy fallback; when symlinks are unsupported, `sync` warns and skips them.
* **Project scope:** yoke writes no instruction symlinks. A `GEMINI.md` link would make agy load the same text twice.
* **Leftover conditional tags:** `<!-- yoke:claude-only -->` and `<!-- yoke:agy-only -->` are not supported. If `AGENTS.md` still contains them, `sync` and `doctor` warn with the file and line numbers, and both harnesses see the raw text. Move claude-only text to `CLAUDE.md` and agy-only text to `GEMINI.md`. There is no migration helper.
* **Files yoke generated earlier:** a project `CLAUDE.md`, `GEMINI.md`, or `CLAUDE.local.md` that yoke wrote before (it has the lock's `instructionsHash`, a `GENERATED` header on its first line, or is a symlink to the source) gets a `remove` plan on `sync`, with a backup and the drift gate. If the native file differs from the lock, the gate prompts, or refuses without `--force`. Afterwards `instructionsHash` is `null`. Files that are not managed are never touched.

### 4.3 Drift Lockfile (`.yoke/yoke.lock` and `<userConfigDir>/yoke.lock`, gitignored)
Tracks the last-synced canonical snapshot per harness so `yoke` can distinguish **new native edits** from **stale values**:

There are two lock files: the project lock `.yoke/yoke.lock`, and the user-scope lock `<userConfigDir>/yoke.lock`, which holds the entries for the user scope. Both are gitignored and both have the same schema, described below.

```typescript
export interface YokeStateLock {
  version: 1;
  lastSyncedAt: string;
  harnesses: Record<
    string, // "<harness>:<scope>", e.g. "claude:project"
    {
      mcpHashes: Record<string, string>; // serverName -> sha256 of canonical MCP definition
      instructionsHash: string | null;   // sha256 of last-written instruction target; null if yoke wrote none
      ownedNames?: Record<string, string[]>; // list id -> names yoke added (e.g. "disabled-servers")
    }
  >;
}
```

* **Owned names:** only names in `ownedNames` are ever removed from a shared native list.
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
2. **Diff against `.yoke/yoke.lock`:** Any server or instruction block that differs from the last-synced hash is flagged as a *native mutation*.
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
4. **Absorb & Sync:** Write accepted changes back to `yoke.yaml` / `yoke.local.yaml`, sync the target harness, update `.yoke/yoke.lock`, and proceed with the session handoff.

---

## 6. Adapter Contract & Capability Matrix

Every harness implements a single interface (`src/adapters/base.ts`) with an explicit `capabilities` declaration so the core engine degrades gracefully for partial adapters.

```typescript
export interface HarnessCapabilities {
  readonly staticMcp: boolean;
  readonly staticInstructions: boolean;
  readonly reverseRead: boolean; // Required for drift detection and init in v0.1, and for absorption in v0.2
  readonly sessionExport: boolean;
  readonly sessionImport: "native" | "seeded" | "handoff-file-only";
}

export interface HarnessStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly version?: string;
}

export type FileChangeAction = "create" | "update" | "symlink" | "patch-json" | "remove" | "noop";

/** Writable context handed to apply(). Adapters never see the clock or a dry-run flag. */
export interface ApplyContext {
  readonly fs: Fs;               // writable filesystem
  readonly backup: BackupSession; // one session per sync run
}

export interface ApplyResult {
  readonly status: "written" | "unchanged" | "fallback";
  readonly backupPath: string | undefined;
  readonly detail?: string;
}

export interface FileChangePlan {
  readonly scope: Scope;
  readonly path: string;
  readonly action: FileChangeAction;
  readonly summary: string;
  readonly before?: string; // current file text; undefined = missing file, or a symlink (see `link`)
  readonly after?: string;  // planned file text; undefined = a symlink, or an advisory plan
  readonly link?: { readonly before?: string; readonly after?: string }; // symlink target text
  readonly warnings: readonly string[]; // planning never calls a warn callback
  readonly expected: readonly ExpectedTarget[]; // what the lock records for this path after apply
  readonly composable?: boolean; // apply() re-reads the file and patches only its own key, so plans may share a path
  readonly apply: (ctx: ApplyContext) => Promise<ApplyResult>;
}

/** Runtime context an adapter is constructed with. Tests inject every path. */
export interface AdapterContext {
  readonly homeDir: string;
  readonly userConfigDir: string;
  readonly fs: ReadFs;   // read-only
  readonly exec: Exec;
  readonly env: Env;
  readonly lock?: YokeStateLock;        // merged view of the validated lock files
  readonly force?: boolean;             // --force
  readonly symlinksSupported?: boolean; // false => user links skipped with a warning
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

**Planning is read-only.** `AdapterContext.fs` is a `ReadFs`, so `detect`, `readNativeState`, and `syncStatic` cannot write. Each plan's `apply(ctx)` closure receives an `ApplyContext` holding the writable `Fs` and the run's backup session. The only caller of `apply` is `executePlan` in `src/core/plan.ts`. A `noop` plan is never applied. `detect().authenticated` is a credentials heuristic; v0.1 runs no login probe. Adapters are created through `src/adapters/registry.ts` (`createAdapters`, `ADAPTER_FACTORIES`); building one performs no I/O, and nothing outside `src/adapters/` names a harness.

### Sync pipeline (`src/core/plan.ts`)

`buildSyncPlan(PlanRequest)` is the single planning path. It validates the request, loads and merges the scope files, loads the lock files (`<repo>/.yoke/yoke.lock` for `project` and `local`; `<userConfigDir>/yoke.lock` for `user`), constructs each configured adapter, calls `syncStatic`, checks that no two non-composable plans share a path (`PlanConflictError`), runs the 3-way drift check, and returns a `SyncPlan` (`plans`, `changes`, `drift`, `warnings`, `gate`, `blocked`, `locks`, `backupRoot`, `force`). It reads only and takes no clock. `PlanRequest` is `SyncRequest` without `writeFs` and `now`.

The **gate** collects reasons: `drift` (native changes since the last sync), `lock-corrupt`, and `drift-unchecked` (a harness that cannot be reverse-read). `blocked` is `gate.length > 0 && !force`. `executePlan({ plan, fs, now, confirm? })` decides the gate first: clear when there are no reasons, forced under `--force`, otherwise `confirm` decides (present only in interactive runs; absent means refused). A refused gate returns before any write. Otherwise every non-`noop` plan is applied in order with one backup session, then the lock files are written last, each atomically and each backed up first when it already exists. A throwing `apply` stops the run, writes no lock, and returns `status: "failed"`. An instructions plan that reports `fallback` keeps the previous lock value. `SyncResult.status` is `applied`, `refused`, or `failed`.

Scopes per command: `sync` plans `project` and `local`; `--global` plans `user` only; `--all` plans all three; `--global` with `--all` is a `SyncRequestError`, which the CLI maps to a usage error.

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

Planning receives a read-only filesystem (see above); each `apply` closure receives the writable filesystem and the backup session. Adapters receive `AdapterContext` (`homeDir`, `userConfigDir`, `fs`, `exec`, `env`, and optional `lock`, `force`, `symlinksSupported`) at construction, so tests can inject them.

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

v0.1 adapters implement static sync and reverse-read only; session columns are v0.2 targets. Both v0.1 adapters declare `sessionExport: false`.

### Concrete File & Schema Mappings (v0.1)

| Feature | `claude` Adapter | `agy` Adapter |
| :--- | :--- | :--- |
| **User MCP** | `~/.claude.json` (patch *only* `mcpServers`) | `~/.gemini/config/mcp_config.json` (top-level `mcpServers` object; patch only that key) |
| **Project MCP** | `./.mcp.json` | Not supported in v0.1 |
| **Local MCP** | `projects[<git root realpath>].mcpServers` in `~/.claude.json` | Not supported in v0.1; local servers are skipped with a warning (see mapping rules) |
| **Remote HTTP Key** | `"type": "http"`, `"url": "..."` | `"url": "..."` is the key yoke writes (`readNativeState` also accepts the legacy alias `serverUrl`). agy 1.5.16 writes `serverUrl` when set via its CLI; yoke reads both and writes `url`. |
| **Disable (`enabled: false`)** | For a project-level disable of a user-scope server, write the server name into `projects[<repo>].disabledMcpServers` in `~/.claude.json`, and track the name in `.yoke/yoke.lock` so only yoke-added names are removed later. This key is undocumented in Claude Code; it was checked statically on Claude Code 2.1.331 and by a non-interactive throwaway-home probe on 2.1.332, and is not confirmed in an interactive session. A probe showed that `disabledMcpjsonServers` does not disable a user-scope server, so it is not used. Claude's approval list shares that key's meaning for rejected names, so yoke cannot tell its entries apart; hybrid-mode disables are deferred (in `hybrid` mode the disable is reported as a warning and no disable list is written). If the write is not possible, yoke warns and names the file, the harness, the scope, and the manual fix (`/mcp disable`). | `"disabled": true`, emitted only when the merged result still has a full definition. A stub with only `enabled: false` (no transport) suppresses the inherited entry. |
| **User Instructions** | `~/.claude/CLAUDE.md`, a symlink to `<userConfigDir>/AGENTS.md` | `~/.gemini/GEMINI.md`, a symlink to `<userConfigDir>/AGENTS.md` *(unverified)* |
| **Project Instructions** | `@AGENTS.md` in `./CLAUDE.md`, only when the user wrote one; yoke writes no project instruction file | `./AGENTS.md`, read natively (observed with agy: a model turn listed both `AGENTS.md` and `GEMINI.md` as loaded instruction files); no `GEMINI.md` is written |
| **Session Export** | Latest `.jsonl` in `~/.claude/projects/<repo-hash>/` | Latest local `agy` session log or `.yoke/HANDOFF.md` |
| **Session Import** | Synthesize valid `.jsonl` + spawn `claude --resume <id>` | Render `.yoke/HANDOFF.md` + spawn `agy` with bootstrap prompt |

**Mapping rules:**
* agy does not support legacy HTTP+SSE. `transport: sse` servers are skipped for agy with a warning in `sync` and `doctor`, and are excluded from agy's `mcpHashes`. Claude keeps `type: "sse"`.
* agy project-level MCP is not supported in v0.1 (unverified; no evidence of a per-project mechanism). Project and local MCP servers are SKIPPED for agy with a warning. They are never written to the global file.
* Unknown keys inside an MCP entry are kept on rewrite when the transport is unchanged and are excluded from drift. Unknown top-level keys in a native config file are never parsed or modified.
* An entry with an unknown transport (for example Claude's `ws`) is left unchanged and not managed. It is an error only when yoke defines a server with the same name, unless `--force` is passed.
* An entry whose fields do not fit its transport (for example `headers` on a stdio entry, or `command` on an http entry) is kept byte-for-byte and marked opaque. It produces a warning. It is an error only when yoke defines a server with the same name, unless `--force` is passed. Corrupt values (non-string env or header values, `args` that is not a string list, an invalid server name) remain errors.
* `${VAR}` is stored literally in both harnesses. Claude expands it at runtime; agy does not, so yoke warns for each agy server whose env or headers use `${VAR}`.

---

## 7. CLI Command Surface

| Command | Behavior |
| :--- | :--- |
| `yoke init [--import-from <source>...] [--dry-run] [--secrets <local\|ref>]` | Detects installed harnesses, imports existing MCPs & instructions into `yoke.yaml` + `AGENTS.md` (user-level MCP servers found only in a user-level native config are imported into the user-scope file `~/.config/yoke/yoke.yaml`, not the project's `yoke.yaml`), and optionally updates `.gitignore`. Sources are a harness name (`claude`, `agy`) or a file path (`CLAUDE.md`, `GEMINI.md`). Importing native MCP JSON files directly (such as `.mcp.json` or agy's config) as a source is deferred past v0.1; v0.1 imports from harnesses and instruction files only. `yoke init --dry-run` prints the files init would write, with a diff, and writes nothing. `--secrets <local|ref>`: `local` (the default) writes literal secret values to the user-scope file `~/.config/yoke/yoke.yaml` at mode 0600; `ref` writes `${VAR}` references in their place. Project `yoke.yaml` always uses `${VAR}` references and never a literal secret, whatever the option. When `~/.config/yoke/yoke.yaml` already exists, init adds only the servers that are missing from it. It never replaces an existing entry, even with `--force`, and it keeps the file's comments. Without the flag, init prompts interactively; with the flag, it runs non-interactively. If instruction sources differ, init must not auto-merge; the user picks one. Literal secrets found in imported `env` or `headers` become `${VAR}` references or go to `yoke.local.yaml`, never into committed `yoke.yaml`. |
| `yoke sync [--dry-run] [--global \| --all] [--force]` | Plans once with `buildSyncPlan`, prints a colorized diff, and applies the same plan unless `--dry-run`. Default scopes are `project` and `local`; `--global` syncs only the user scope and needs no repository; `--all` syncs `user`, `project`, and `local`. `--global` together with `--all` is a usage error (exit 2). Native drift is checked unless `--force`: non-interactive drift is refused (exit 3, nothing written); interactive drift offers "Overwrite with yoke config" or "Abort" (v0.1; absorption arrives in v0.2). `--force` proceeds past drift with a warning, after backups. Warns when a user-written `CLAUDE.md` does not start with `@AGENTS.md`, and when `AGENTS.md` has leftover conditional tags. Removes project instruction files that yoke generated earlier (backed up, behind the drift gate). Updates `.yoke/yoke.lock` (and the user lock) only after every write succeeds. |
| *(v0.2, not in v0.1)* `yoke switch <target> [--from <source>] [--no-launch]` | Runs pre-flight drift check (absorption in v0.2) -> exports active session to `YokeSessionIR` -> imports/launches `<target>`. |
| *(v0.2, not in v0.1)* `yoke sessions` | Lists saved `YokeSessionIR` snapshots in `.yoke/sessions/` for resuming in any harness. |
| `yoke doctor` | Read-only. Checks the repo, config files, each harness binary (`detect()`), credentials, the lock files, user instruction links, the `CLAUDE.md` import line, leftover conditional tags, planned changes, and native drift. Auth is a credentials heuristic with no login probe in v0.1: a harness with no found credentials is reported as `unknown` (not verified), never `problem`. Probes time out and report `unknown`. Exit `1` only when a check is a `problem`. |

### Exit codes

| Code | Meaning | Returned by |
| :--- | :--- | :--- |
| `0` | Success, nothing to do, or a clean check. `--help` and `--version` also exit `0`. | all commands |
| `1` | Failure: `doctor` found at least one problem, or the command failed at runtime (invalid `yoke.yaml`, unreadable native state, plan conflict, apply failure, import error). | `sync`, `init`, `doctor`, `switch` (v0.2) |
| `2` | Usage error: unknown option, bad or missing argument, or an interactive prompt required without a terminal. | all commands |
| `3` | Drift refusal: native changes detected and the run was non-interactive without `--force`, or the user chose "Abort". A blocked dry run also returns `3`. | `sync`, `switch` (v0.2) |
| `130` | Interrupted: the user cancelled a prompt or sent SIGINT before anything was written. | `init`, `sync`, `switch` (v0.2) |

`yoke sessions` is not yet available; when added it returns only `0`, `1`, and `2`. `--dry-run` returns the same code a real run would, so `yoke sync --dry-run` can be used as a CI drift check.

---

## 8. Non-Negotiable Safety Invariants

1. **Zero-Clobber JSON Patching:** Never overwrite any shared harness config (`~/.claude.json`, agy `mcp_config.json`, and other shared files) wholesale. Read -> parse -> patch *only* the target key (e.g., `mcpServers`) -> atomic write (write to `.tmp` + `rename`).

   **Temp file (§8.1):** the temp file is `<name>.<random>.yoke.tmp` in the target's directory, created exclusively (`wx`) and renamed into place.
2. **Automatic Backups:** Always back up. Before `yoke` overwrites or patches any file, it copies the original to `<userConfigDir>/backups/<timestamp>/`. This includes yoke-managed files when drift is detected and the user chooses overwrite, and JSON-patched shared files (`~/.claude.json`, agy `mcp_config.json`), which are never considered managed. A file is "yoke-managed" if the lock records it, it carries the `GENERATED` header, or it is a symlink yoke created.

   **Backup location (§8.2):** backups go to `<userConfigDir>/backups/<timestamp>/`, where the timestamp is ISO-8601 with `:` and `.` replaced by `-`. The original absolute path is mirrored under that directory. A `-N` suffix avoids collisions between sessions. The directory is mode `0700`. yoke never writes text to an instruction path; it only creates, replaces, or removes links and removes files it generated earlier. A `remove` action is backed up first.
3. **Dry-Run Parity:** `sync` always computes a `FileChangePlan[]` before touching disk; `--dry-run` executes the exact same planning pipeline without calling `apply()`.
4. **No Secret Leakage:** Never expand `${ENV_VAR}` values into plaintext inside generated project files; preserve variable references in the target harness's native syntax. The user-scope file in the user config directory may hold literal values under `--secrets local`, written at mode 0600; generated project files never do.
5. **No Silent Overwrites:** If a native file differs from `.yoke/yoke.lock`, `yoke sync` must prompt (or abort in non-interactive CI unless `--force` is passed).
6. **Lossy-but-Clean Session IR:** Never copy provider-specific thinking/thought signatures or raw multi-hundred-line file dumps into `YokeSessionIR`. Flatten tool calls into compact `actions[]` summaries.

---

## 9. Repository Layout & Implementation Milestones

```text
yoke/
├── src/
│   ├── cli.ts                  # Process entrypoint: builds real deps, calls runCli
│   ├── main.ts                 # Commander program, runCli, doctor planner (pure; deps injected)
│   ├── core/
│   │   ├── schema.ts           # Zod schemas (yoke.yaml, YokeStateLock, YokeSessionIR)
│   │   ├── scopes.ts           # 3-tier loader & deep-merge engine
│   │   ├── json-text.ts        # Text-preserving JSON patching (zero-clobber edits)
│   │   ├── drift.ts            # 3-way diff; absorption in v0.2
│   │   ├── plan.ts             # buildSyncPlan, executePlan, drift gate, lock file I/O
│   │   ├── instructions.ts     # Generated-header detection, leftover tag scan
│   │   ├── git.ts              # Repo root, branch, status, diffStat helpers; exec
│   │   ├── probe.ts            # Timed probes for doctor
│   │   ├── secrets.ts          # Secret detection and ${VAR} conversion for init
│   │   └── fs-safe.ts          # Atomic write, JSON patch, backup, symlink utils
│   ├── adapters/
│   │   ├── base.ts             # HarnessAdapter, HarnessCapabilities, FileChangePlan, AdapterContext
│   │   ├── registry.ts         # Adapter factory list (createAdapters)
│   │   ├── claude.ts           # Claude Code adapter
│   │   └── agy.ts              # Antigravity (agy) adapter
│   └── commands/
│       ├── exit.ts             # Exit codes and UsageError
│       ├── init.ts             # init command
│       ├── init-types.ts       # init shared types
│       ├── init-sources.ts     # --import-from source parsing and reading
│       ├── init-select.ts      # Conflict selection between sources
│       ├── init-convert.ts     # Native -> canonical conversion, secrets policy
│       ├── init-user.ts        # User-scope file writer (~/.config/yoke/yoke.yaml)
│       ├── sync.ts             # sync command
│       ├── sync-render.ts      # Plan, gate, refusal, and result rendering
│       ├── sync-prompt.ts      # Interactive drift prompt (Overwrite / Abort)
│       ├── doctor.ts           # doctor checks
│       ├── doctor-format.ts    # Doctor report formatting and exit code
│       ├── switch.ts           # not yet available
│       └── sessions.ts         # not yet available
├── tests/
│   ├── fixtures/               # Sample ~/.claude.json, .mcp.json, .jsonl logs
│   ├── adapters/               # base, claude, agy, registry tests; helpers.ts
│   ├── commands/               # sync, sync-render, sync-prompt, init-*, doctor tests; CLI tests
│   ├── core/                   # instructions, fs-safe, json-text, plan, probe, secrets, scope loader, git tests
│   ├── schema/                 # Zod schema tests
│   ├── setup/                  # Test setup (isolated HOME)
│   ├── scopes.test.ts
│   ├── drift.test.ts
│   ├── plan-adapters.test.ts
│   └── adapters.test.ts
└── package.json
```

### Milestones
* **v0.1 — Static Core & Drift Protection (released as v0.1.0):** `schema.ts`, `scopes.ts`, `fs-safe.ts`, `instructions.ts`, `drift.ts`, `plan.ts`, `claude` & `agy` static adapters (including `readNativeState`), `yoke init`, `yoke sync` (`--dry-run`, `--global`, `--all`, `--force`), `yoke doctor`. Deferred from v0.1:
  * Hybrid-mode disable of user-scope Claude servers (reported as a warning).
  * Verification of the agy `GEMINI.md` path (user).
  * agy auth probe (auth is always `unknown` in v0.1).
  * Importing native MCP JSON files (`.mcp.json`, agy config) as an `init` source.
  * agy project and local MCP servers (skipped with a warning).
  * Concurrent-change check for `init` writes.
  * Windows symlink support (links fall back with a warning).
* **v0.2 — Interactive Pre-Flight & Session Handoff:** `YokeSessionIR`, Claude `.jsonl` parser/writer (`claude --resume`), `agy` handoff launcher, `yoke switch <target>` with interactive drift absorption, `yoke sessions`.
* **v0.3 — Ecosystem Adapters:** Add `opencode` and `gemini-cli` adapters to validate the `HarnessAdapter` abstraction for community contributors.