# yoke

yoke keeps one configuration for several AI coding CLIs. You write `yoke.yaml` (MCP servers, harness settings) and `AGENTS.md` (shared instructions) once, and `yoke sync` generates the native files for Claude Code and Antigravity (`agy`). It plans every change before writing, backs up files it did not create, and refuses to overwrite native edits it does not recognize. Design details are in [SPEC.md](SPEC.md).

## Install

Requires Node 20.19 or later.

```bash
npm ci && npm run build && npm link
```

This puts `yoke` on your PATH from the built `dist/` directory.

## Quickstart

```bash
# 1. Import existing Claude Code MCP servers and instructions
yoke init --import-from claude

# 2. Edit AGENTS.md with the shared instructions for this repo

# 3. Preview, then apply, the generated project files
yoke sync --dry-run
yoke sync

# 4. Apply user-scope (global) config to your home directory
yoke sync --global

# 5. Check the setup (read-only)
yoke doctor
```

`yoke sync --dry-run` prints the same plan a real run would apply and writes nothing. Use it as a CI drift check.

## Try it in a sandbox

`docker/sandbox/` builds a clean, disposable container with yoke, the real Claude Code CLI, and a stub `agy`, so you can use v0.1 interactively without touching your own config. HOME starts empty and nothing is seeded; run `git init` in `~/work` and log in with `claude` yourself:

```bash
npm run sandbox:build && npm run sandbox
```

See [docker/sandbox/README.md](docker/sandbox/README.md) for what is installed, login, and keeping state.

## Configuration

You describe your setup in `yoke.yaml`. A minimal example looks like this:

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

If a key is missing, yoke uses these defaults: `mode: compiled`, no harnesses (`harnesses: []`), `session.maxTurns: 40`, and `session.includeGitDiffStat: true`. The defaults are applied after the scope files are merged, so they do not appear in those files.

Rules to know:

- Unknown keys are rejected in every file and every nested object. This catches typos such as `mcpServers:`. An older yoke also rejects files written for a newer one.
- Every scope file needs `version: 1`, including `yoke.local.yaml`. All other top-level keys are optional.
- An empty file, or a file with only comments, is rejected.
- Environment and header values must be strings, so quote numbers and booleans: `PORT: "8080"`.
- Environment variable names must start with a letter or underscore and contain only letters, digits, and underscores.
- URLs must start with `http://` or `https://`, or with a `${VAR}` reference, so `${MCP_HOST}/mcp` is valid.
- Harness names are lowercase letters, digits, and dashes, up to 32 characters. MCP server names are letters, digits, dashes, underscores, and dots, up to 64 characters. A harness may appear only once in `harnesses`.
- There is no `instructions:` key. Instruction file locations are fixed, so this key is rejected.
- YAML `null` is rejected everywhere, for example `env: { KEY: null }` or `headers: null`.
- `session.maxTurns` must be a positive whole number.

## Scopes

Settings come from three scopes. A higher scope overrides a lower one: `local` beats `project`, and `project` beats `user`.

| Scope | Source files | Git status | Purpose |
| :--- | :--- | :--- | :--- |
| **`user`** | `<userConfigDir>/yoke.yaml`<br>`<userConfigDir>/AGENTS.md` | N/A | Global MCP servers, global coding style, default harness list |
| **`project`** | `./yoke.yaml`<br>`./AGENTS.md` | Committed | Team-shared MCP servers, repo architecture and rules |
| **`local`** | `./yoke.local.yaml` | Gitignored | Personal overrides, local-only MCP servers, disabling inherited servers |

`<userConfigDir>` is `$XDG_CONFIG_HOME/yoke` when `XDG_CONFIG_HOME` is an absolute path, and `~/.config/yoke` otherwise.

Pick a mode with `mode` in `yoke.yaml`:

- **`compiled`** (default): generated files are gitignored, so `git status` stays clean. Project servers go into the target files of each harness, and local Claude servers go into your user Claude config rather than a repo file.
- **`hybrid`**: only the project scope is written to tracked files, so teammates without yoke still get working configs. Private tokens belong in a gitignored `.env.local`.

Claude Code has a third, local tier of its own. Other harnesses may not have one, so the scope split for agy is not verified yet.

## Merging scopes

When the same MCP server name appears in more than one scope, yoke merges the entries in precedence order:

- Maps (`env`, `headers`) merge key by key, and the higher scope wins for each key.
- Arrays (`args`) are replaced whole, never joined.
- Changing `transport` replaces the whole entry. Nothing is inherited from the lower scope.
- `enabled: false` with no `transport` is a stub. It suppresses the inherited server.
- An override that keeps the same transport and omits `enabled` keeps the inherited `enabled` value, so a disabled server stays disabled. A transport change sets `enabled` back to `true` unless the override sets it.
- Other keys, such as `mode` and `session`, take the value from the highest scope that sets them. `harnesses` is replaced whole, never merged.
- Every full entry needs a `transport`. You cannot override only one field of a lower-scope server (for example just `env` in `yoke.local.yaml`). Write the full entry instead.

## Instructions

- `AGENTS.md` is the only shared instruction file, and you are the one who edits it. Claude Code and agy both read it natively, so yoke writes no project instruction file.
- yoke never writes `CLAUDE.md` or `GEMINI.md`. Claude stops loading `AGENTS.md` when a `CLAUDE.md` exists that does not import it. So if your `CLAUDE.md` does not start with the line `@AGENTS.md`, `sync` and `doctor` warn you.
- Personal instruction text goes in `CLAUDE.local.md`, which you write yourself. `AGENTS.local.md` is not supported.
- A `GEMINI.md` is optional for agy-only text. yoke does not manage it.
- User-level instruction files, `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md`, are symlinks to `<userConfigDir>/AGENTS.md`. There is no copy fallback. If symlinks are not supported, `sync` warns and skips them.
- The old `<!-- yoke:claude-only -->` and `<!-- yoke:agy-only -->` tags are not supported. If `AGENTS.md` still contains them, `sync` and `doctor` warn with the file and line numbers, and both harnesses see the raw text. Move Claude-only text to `CLAUDE.md` and agy-only text to `GEMINI.md` by hand. There is no migration helper.
- If yoke generated a project `CLAUDE.md`, `GEMINI.md`, or `CLAUDE.local.md` in an earlier version, `sync` removes it after a backup, subject to the drift check. Files that yoke does not manage are never touched.

## Commands

| Command | What it does |
| :--- | :--- |
| `yoke init [--import-from <source>...] [--dry-run] [--secrets <local\|ref>]` | Detects installed harnesses and imports their MCP servers and instructions into `yoke.yaml` and `AGENTS.md`. User-level servers go to the user-scope file, not the project file. Can also update `.gitignore`. `--dry-run` shows what would be written and writes nothing. `--secrets local` (the default) stores literal secrets in the user-scope file at mode 0600. `--secrets ref` writes `${VAR}` references instead. Without flags, `init` asks questions interactively. |
| `yoke sync [--dry-run] [--global \| --all] [--force]` | Builds a plan, prints a diff, and applies that same plan. By default it syncs the project and local scopes. `--global` syncs only the user scope and needs no repository. `--all` syncs all three scopes. `--force` goes past native drift, with a warning, after backing up. |
| `yoke doctor` | Read-only check of the repo, config files, harness binaries, credentials, lock files, instruction links, the `CLAUDE.md` import line, leftover tags, planned changes, and native drift. Credentials are only guessed from what is on disk, so a harness without found credentials is reported as `unknown`, not as a problem. |
| `yoke switch` and `yoke sessions` | Planned for v0.2. |

## Where yoke writes

| Harness | Scope | File | What it holds |
| :--- | :--- | :--- | :--- |
| `claude` | user | `~/.claude.json` | Only the `mcpServers` key is patched. Remote servers use `"type": "http"` and `"url"`. A project-level disable of a user server is written to `projects[<repo>].disabledMcpServers`. |
| `claude` | project | `./.mcp.json` | Project MCP servers |
| `claude` | local | `~/.claude.json`, under `projects[<git root>].mcpServers` | Local MCP servers for this repo, kept out of the repo |
| `agy` | user | `~/.gemini/config/mcp_config.json` | Only the top-level `mcpServers` object is patched. Remote servers use `"url"`. A disabled server gets `"disabled": true`. |
| `agy` | project | Not supported in v0.1 | Project MCP servers are skipped with a warning |
| `agy` | local | Not supported in v0.1 | Local MCP servers are skipped with a warning |
| `claude` | instructions | `~/.claude/CLAUDE.md` (symlink to `<userConfigDir>/AGENTS.md`) and `./CLAUDE.md` | yoke writes no project file here. If you write `./CLAUDE.md`, it must start with `@AGENTS.md`. |
| `agy` | instructions | `~/.gemini/GEMINI.md` (symlink to `<userConfigDir>/AGENTS.md`, unverified) and `./AGENTS.md` | agy reads the project `AGENTS.md` directly. No `GEMINI.md` is written for the project. |

Rules for these files:

- agy does not support legacy HTTP+SSE. `transport: sse` servers are skipped for agy with a warning, and Claude keeps them.
- Project and local MCP servers are skipped for agy with a warning. They are never written to agy's global file.
- The Claude disable key is undocumented in Claude Code. It was checked against Claude Code 2.1.331 and 2.1.332 but not in an interactive session. If yoke cannot write it, it warns and tells you to run `/mcp disable <name>` yourself.
- Unknown keys inside an MCP entry are kept when the transport stays the same. Unknown top-level keys in a native file are never read or changed.
- An entry with a transport yoke does not know (for example Claude's `ws`) is left unchanged and not managed. It is an error only if yoke defines a server with the same name, unless you pass `--force`.
- An entry whose fields do not fit its transport (for example `headers` on a stdio entry) is kept byte for byte and marked opaque, with a warning. It is an error only if yoke defines a server with the same name, unless you pass `--force`. Invalid values, such as a non-string header or a malformed server name, are always errors.
- `${VAR}` is written literally to both harnesses. Claude expands it at runtime. agy does not, so yoke warns for each agy server that uses `${VAR}`.

## Safety

- **Plan before write.** `yoke sync` builds one plan, shows it, and applies that same plan. `--dry-run` shows the same plan and writes nothing.
- **Atomic, key-only writes.** yoke reads a shared file, changes only its own key (for example `mcpServers`), and writes a temporary file next to it. It then renames the temporary file over the original, so the file is never half-written.
- **Backups.** Before yoke overwrites or patches a file, it copies the original to a timestamped folder under `<userConfigDir>/backups/`. The original path is mirrored inside that folder, and the folder is readable only by you.
- **Secrets stay out of project files.** Generated project files keep `${VAR}` references and never contain expanded values. Under `--secrets local`, the user-scope file may hold literal values, with mode 0600.
- **Drift check.** If a native file differs from what yoke last wrote, `sync` stops and asks you. Non-interactive runs fail. Pass `--force` to overwrite anyway.
- **Lock files are gitignored.** `.yoke/yoke.lock` in the repo and `yoke.lock` in `<userConfigDir>` record what yoke last wrote, so it can tell your edits from stale values.

## Exit codes

Exit codes for every command are listed in [SPEC.md §7](SPEC.md#7-cli-command-surface). In short: `0` success or clean, `1` failure or a doctor problem, `2` usage error, `3` drift refusal, `130` interrupted.

## v0.1 limits

- **agy project and local MCP servers are skipped** with a warning. Only user-scope MCP servers reach agy.
- **SSE servers are skipped for agy.** Use HTTP or stdio servers for agy.
- **Hybrid mode warns instead of disabling.** If a repo needs a user-scope Claude server turned off, yoke prints a warning. Run `/mcp disable <name>` inside Claude in that repo.
- **Auth is reported as `unknown`.** `yoke doctor` uses a credentials heuristic and does not probe logins.
- **The user `GEMINI.md` path is unverified.** Check the agy user-level instructions link before relying on it.
- **agy user link needs `agy` in `harnesses`.** Add `agy` to the user-scope `harnesses` list in `~/.config/yoke/yoke.yaml` to get the agy user link.
- **`yoke switch` and `yoke sessions` are v0.2.** They are not available in v0.1.
- **Native MCP JSON files are not an init source.** `yoke init` imports from harnesses and instruction files only, not `.mcp.json` or the agy config.
- **`yoke init` has no concurrent-change check.** It does not detect files that change while it runs.
- **Windows symlinks are not handled.** Links fall back with a warning.
- **A malformed or empty native JSON file blocks sync.** `yoke sync --global` exits 1 and `yoke doctor` reports `invalid JSON in <path>` (for example an empty agy `mcp_config.json`). Tracked as TASK-0001 for v0.2.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, PR rules, and how releases are made.
