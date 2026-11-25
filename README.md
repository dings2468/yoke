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
- **A malformed or empty native JSON file blocks sync.** `yoke sync --global` exits 1 and `yoke doctor` reports `invalid JSON in <path>` (for example an empty agy `mcp_config.json`). Tracked as TASK-1 for v0.2.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, PR rules, and how releases are made.
