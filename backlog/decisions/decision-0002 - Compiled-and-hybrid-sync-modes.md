---
updated_date: '2026-11-25T21:59:01Z'
id: decision-0002
title: Compiled and hybrid sync modes
date: '2026-11-25T21:04:19Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
Claude Code has a native third tier (CLAUDE.local.md, per-project overrides in ~/.claude.json). Other harnesses may not, and the agy scope split is unverified in v0.1 (SPEC.md §3, Sync Modes). Some teams want generated files kept out of git status. Mixed teams have members without yoke who still need working configs.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
mode is compiled (default) or hybrid.
- compiled: generated files such as .mcp.json are gitignored build artifacts. Local-scope Claude servers go to projects[<git root>].mcpServers in ~/.claude.json, never a repo file.
- hybrid: only project is written into tracked files. local is mapped natively where supported (Claude). yoke warns when a non-env local override cannot be isolated, and relies on a gitignored .env.local for private tokens. A project-level disable of a user-scope Claude server is not written; it is reported as a warning.
In both modes yoke generates no instruction file, and writes no project or local servers for agy in v0.1.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- compiled keeps git clean; hybrid lets teammates without yoke work.
- Hybrid cannot disable inherited user servers in v0.1 (TASK-0010, decision-0020).
- The default mode: compiled is applied after merge (src/core/schema.ts).
- Keep in sync: README "Scopes" and "v0.1 limits", src/adapters/claude.ts planClaudeDisables.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- None named.
<!-- SECTION:ALTERNATIVES:END -->

