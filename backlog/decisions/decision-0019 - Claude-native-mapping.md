---
updated_date: '2026-11-25T21:59:05Z'
id: decision-0019
title: Claude native mapping
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
Claude Code stores MCP servers in three native places with different files and keys. The adapter must map each yoke scope to the right one while keeping AGENTS.md rule 1: harness paths only inside the adapter (SPEC.md §6, Concrete File and Schema Mappings).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- user: the top-level mcpServers key of ~/.claude.json, patched only.
- project: ./.mcp.json.
- local: projects[<git root realpath>].mcpServers in ~/.claude.json. If the realpath fails because the path does not exist, the given path is used.
- Remote servers are written as "type": "http" with "url"; SSE keeps "type": "sse". ${VAR} is copied verbatim, and Claude expands it at runtime.
- Disabled servers are omitted from Claude entries (toClaudeEntry).
- An absolute CLAUDE_CONFIG_DIR moves the user config and user instructions into that directory (code only; not in SPEC.md).
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Local servers never touch the repo.
- Moving a repo changes its projects key (inferred).
- Keep in sync: src/adapters/claude.ts header and claudePaths, README "Where yoke writes" (which does not mention CLAUDE_CONFIG_DIR), tests/fixtures/ and tests/adapters/.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- None named.
<!-- SECTION:ALTERNATIVES:END -->

