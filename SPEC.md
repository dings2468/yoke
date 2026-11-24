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

| Scope | Source Files | Git Status | Purpose |
| :--- | :--- | :--- | :--- |
| **`user`** | `~/.config/yoke/yoke.yaml`<br>`~/.config/yoke/AGENTS.md` | N/A | Global MCPs, global coding style, default harness list |
| **`project`** | `./yoke.yaml`<br>`./AGENTS.md` | Committed | Team-shared MCPs, repo architecture & rules |
| **`local`** | `./yoke.local.yaml`<br>`./AGENTS.local.md` | Gitignored | Personal overrides, local-only MCPs, disabling inherited MCPs |

### Sync Modes (Handling Harness Asymmetry)
Claude Code natively supports a 3rd `local` tier (`CLAUDE.local.md` + per-project overrides in `~/.claude.json`). Other harnesses may not expose an equivalent tier; the scope split for `agy` is unverified in v0.1. `yoke` supports two modes:

1. **`compiled` (Default):** Treats all generated harness files (`.mcp.json`, `CLAUDE.md`, `GEMINI.md`) as gitignored build artifacts. `yoke sync` merges `project + local` into the target files for harnesses that support them, without polluting `git status`. Project and local MCP servers are not written for `agy` in v0.1 (see §6).
2. **`hybrid` (Mixed Teams):** Writes only `project` into tracked files so teammates without `yoke` still get valid configs. Maps `local` natively where supported (Claude), warns if a non-env `local` override cannot be isolated for a harness, and relies on `.env.local` (gitignored) for private tokens.

### 3.1 Merge rules

When the same MCP server name appears in more than one scope, entries are merged in precedence order (`local` > `project` > `user`) using these rules:

* **Maps** (`env`, `headers`) merge field by field; higher-precedence keys win.
* **Arrays** (`args`) are replaced whole, never concatenated.
* **A change of `transport`** replaces the whole server entry; no fields are inherited from the lower scope.
* **`enabled: false` with no `transport`** is not a transport change. It is a stub that suppresses the inherited entry.

**Open item:** YAML `null` semantics (for example, `env: { KEY: null }` or `headers: null` to remove an inherited field) are undecided.

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
* Otherwise, adapters compile target-specific files prefixed with `<!-- GENERATED BY YOKE — DO NOT EDIT DIRECTLY -->`.

### 4.3 Drift Lockfile (`.yoke/state.json`, gitignored)
Tracks the last-synced canonical snapshot per harness so `yoke` can distinguish **new native edits** from **stale values**:

```typescript
export interface YokeStateLock {
  version: 1;
  lastSyncedAt: string;
  harnesses: Record<
    string,
    {
      mcpHashes: Record<string, string>; // serverName -> sha256 of canonical MCP definition
      instructionsHash: string;          // sha256 of last-written instruction file
    }
  >;
}
```

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
| **Remote HTTP Key** | `"type": "http"`, `"url": "..."` | `"url": "..."` (`readNativeState` also accepts the legacy alias `serverUrl`) |
| **Disable (`enabled: false`)** | Entry is omitted | `"disabled": true`, emitted only when the merged result still has a full definition. A stub with only `enabled: false` (no transport) suppresses the inherited entry. |
| **User Instructions** | `~/.claude/CLAUDE.md` | `~/.gemini/GEMINI.md` *(unverified)* |
| **Project Instructions** | `./CLAUDE.md` (+ `./CLAUDE.local.md` in hybrid) | `./GEMINI.md` *(unverified)* |
| **Session Export** | Latest `.jsonl` in `~/.claude/projects/<repo-hash>/` | Latest local `agy` session log or `.yoke/HANDOFF.md` |
| **Session Import** | Synthesize valid `.jsonl` + spawn `claude --resume <id>` | Render `.yoke/HANDOFF.md` + spawn `agy` with bootstrap prompt |

**Mapping rules:**
* agy does not support legacy HTTP+SSE. `transport: sse` servers are skipped for agy with a warning in `sync` and `doctor`, and are excluded from agy's `mcpHashes`. Claude keeps `type: "sse"`.
* agy project-level MCP is not supported in v0.1 (unverified; no evidence of a per-project mechanism). Project and local MCP servers are SKIPPED for agy with a warning. They are never written to the global file.

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
2. **Automatic Backups:** Always back up. Before `yoke` overwrites or patches any file, it copies the original to `~/.config/yoke/backups/<timestamp>/`. This includes yoke-managed files when drift is detected and the user chooses overwrite, and JSON-patched shared files (`~/.claude.json`, agy `mcp_config.json`), which are never considered managed. A file is "yoke-managed" if it carries the `GENERATED` header or is a symlink yoke created.
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
│   ├── scopes.test.ts
│   ├── drift.test.ts
│   └── adapters.test.ts
└── package.json
```

### Milestones
* **v0.1 — Static Core & Drift Protection:** `schema.ts`, `scopes.ts`, `fs-safe.ts`, `compiler.ts`, `drift.ts`, `claude` & `agy` static adapters (including `readNativeState`), `yoke init`, `yoke sync --dry-run`, `yoke doctor`.
* **v0.2 — Interactive Pre-Flight & Session Handoff:** `YokeSessionIR`, Claude `.jsonl` parser/writer (`claude --resume`), `agy` handoff launcher, `yoke switch <target>` with interactive drift absorption, `yoke sessions`.
* **v0.3 — Ecosystem Adapters:** Add `opencode` and `gemini-cli` adapters to validate the `HarnessAdapter` abstraction for community contributors.