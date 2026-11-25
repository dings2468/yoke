# AGENTS.md — `yoke` Development Guide

Read `SPEC.md` before making architectural changes. `SPEC.md` is the source of truth for schemas, adapter contracts, and CLI behavior.

## Tech Stack & Commands
- **Runtime:** TypeScript (strict mode, ESM) on Node 20+ / Bun.
- **Core Libraries:** `zod`, `yaml`, `commander`, `@clack/prompts`, `picocolors`, `vitest`.
- **Verification:** Run type-checking and tests before finishing any task:
  ```bash
  npm run typecheck   # tsc --noEmit
  npm test            # vitest run
  npm run check       # biome check (lint + format); `check:fix` applies fixes
  ```
- **Parallel work uses git worktrees:** any agent or subagent that writes files runs in its own `git worktree` on its own branch (for example `git worktree add ../yoke-<task> -b <branch>`), never in the shared checkout. Merge results back through commits on the task branch.

## Agent Workflow (Fixed Rule)
- **Planning:** always done by at least a Sonnet subagent. Use an Opus subagent for complex planning (multi-component design, architectural or safety-invariant changes, ambiguous requirements).
- **Implementation:** done by Haiku subagents, and only after a plan exists. Do not start implementation without a plan.
- The main agent coordinates, reviews results, and runs verification (`npm run typecheck`, `npm test`, `npm run check`).

## Task Tracking (Backlog.md)
- **Source of planned work:** tasks live in `backlog/` (config in `backlog/config.yml`) and are managed with the globally installed `backlog` CLI (installed by `.devcontainer/install-backlog.sh`). Search for an existing task before creating one; skip tasks for questions and trivial mechanical edits.
- **Use the CLI, never edit task files by hand:**
  ```bash
  backlog task list --plain                      # filter: --status "To Do" --labels bug
  backlog search "query" --plain
  backlog task view TASK-0001 --plain
  backlog decision list --plain
  backlog task create "Title" -d "Context" --type bug -l standard --ac "Criterion" -m v0.2
  backlog task edit TASK-0001 -s "In Progress"      # statuses: To Do, In Progress, Done
  ```
- **Kanban:** follow CONTRIBUTING.md "Kanban workflow" (WIP limit 2 In Progress, one class-of-service label per task, Definition of Done).
- Run `backlog instructions overview` once per session, and `backlog <command> --help` for anything else; do not copy Backlog.md's docs here.
- **Fits the fixed workflow above:** the main agent picks and updates tasks; a task's plan comes from the planning subagent, and implementation starts only after it. Task file changes are committed on the task branch like any other change.
- Do not run `backlog init`, `backlog agents`, or MCP setup in this repo: `AGENTS.md` stays the single instruction source and no MCP config is written.

## Branches, PRs, and Releases
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for branch names, commit and PR titles, and the Definition of Done.
- Only the maintainer creates tags, GitHub Releases, `release/*` branches, and merges PRs (CONTRIBUTING.md, "Maintainer only"). Agents prepare the branch and PR; they do not publish.

## Architecture Rules
1. **Strict Adapter Isolation:** Harness-specific paths, JSON keys (Claude `type: "http"` + `url` vs. agy `url` only, where `serverUrl` is accepted as a legacy alias on read), and session parsers belong **exclusively** inside `src/adapters/<harness>.ts`. Never branch on harness names (`if (name === "claude")`) inside `src/core/` or `src/commands/`.
2. **Capability-Driven Core:** Every adapter must implement `HarnessAdapter` and declare `HarnessCapabilities` (`src/adapters/base.ts`). Commands must check capabilities before invoking optional methods (`exportLatestSession`, `importAndLaunch`) and degrade gracefully. Note: agy does not support legacy HTTP+SSE, so `transport: sse` servers are skipped for agy with a warning. agy also has no v0.1 project-level MCP config, so project and local MCP servers are skipped for agy with a warning and never written to the global file.
3. **3-Tier Scope Precedence:** Always resolve configuration in strict order: `local` > `project` > `user`. Respect `enabled: false` to disable inherited `user`-level MCP servers.
4. **Canonical Validation:** Validate all external inputs (`yoke.yaml`, `yoke.local.yaml`, the lock files (`.yoke/yoke.lock`, `<userConfigDir>/yoke.lock`), `YokeSessionIR`) through Zod schemas in `src/core/schema.ts`.

## Non-Negotiable Safety Invariants
Violating any of these is a blocking bug:
1. **Zero-Clobber JSON Patching:** Never overwrite `~/.claude.json` or any shared harness config wholesale. Use `src/core/fs-safe.ts` to read, parse, patch *only* the target key (e.g., `mcpServers`), and write atomically (exclusive `<name>.<random>.yoke.tmp` in the target directory + `rename`, SPEC §8.1).
2. **Automatic Backups:** Always back up before `yoke` overwrites or patches any file, including yoke-managed files. Copy the original to `<userConfigDir>/backups/<timestamp>/` as SPEC §8.2 describes.
3. **Dry-Run Parity:** `syncStatic()` must return `FileChangePlan[]` without performing disk writes. `--dry-run` must execute the exact same planning pipeline and simply skip calling `apply()`.
4. **No Secret Leakage:** Never resolve or expand `${ENV_VAR}` values into plaintext in generated project files. Preserve variable references in the target harness's native syntax.
5. **No Silent Overwrites:** Before overwriting a native harness file, diff against the lock files (`.yoke/yoke.lock`, `<userConfigDir>/yoke.lock`) via the drift gate in `src/core/plan.ts` (`buildSyncPlan`/`executePlan`; hashing in `src/core/drift.ts`). If native drift is detected, prompt the user (or fail in non-interactive mode unless `--force` is passed).
6. **Lossy-but-Clean Session IR:** Never copy provider-specific thinking/thought signatures or raw multi-hundred-line file dumps into `YokeSessionIR`. Flatten tool calls into compact `actions[]` summaries.

## Coding & Testing Standards
- **No `any`:** Use explicit TypeScript types or Zod-inferred types (`z.infer<typeof ...>`).
- **Fixture-Based Adapter Tests:** Every adapter change must include `vitest` tests using fixture files in `tests/fixtures/` (never read or write the developer's real `~/.claude.json` or `~/.gemini/` during tests—inject paths or use temp directories).
- **Test Coverage Priorities:**
  - Zero-clobber patching of `~/.claude.json` (unrelated keys must survive byte-for-byte in structure).
  - HTTP/SSE schema translation (`claude` <-> `agy`) and reverse-parsing (`readNativeState`).
  - 3-way drift detection (`yoke.yaml` vs. `.yoke/yoke.lock` vs. native file).
  - Instruction handling: `AGENTS.md` is the shared source; a `CLAUDE.md` must start with `@AGENTS.md`; leftover `yoke:*-only` tags produce warnings.

