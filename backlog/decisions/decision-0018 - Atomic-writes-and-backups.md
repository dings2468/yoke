---
updated_date: '2026-11-25T21:59:05Z'
id: decision-0018
title: Atomic writes and backups
date: '2026-11-25T21:04:21Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
~/.claude.json and agy's mcp_config.json hold much more than MCP servers and are shared with the harness. Overwriting them wholesale or leaving them half-written would destroy user state (AGENTS.md invariants 1 and 2, SPEC.md §8).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- yoke reads, parses, patches only the target key (for example mcpServers), and writes atomically.
- The temp file is <name>.<random>.yoke.tmp in the target's directory, created exclusively (wx) and renamed into place.
- Before overwriting, patching, or removing any file, yoke copies the original to <userConfigDir>/backups/<timestamp>/. The timestamp is ISO-8601 with : and . replaced by -; the original absolute path is mirrored; a -N suffix avoids collisions; the directory is mode 0700.
- Shared JSON files are never considered yoke-managed.
- Lock files are backed up too when they already exist.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Unrelated keys survive.
- A crash never leaves a partial target.
- Every run is recoverable from backups.
- Backups accumulate; SPEC.md defines no pruning (not decided in SPEC.md).
- Keep in sync: src/core/fs-safe.ts, src/core/json-text.ts, README "Safety".
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- Wholesale overwrite of shared configs: forbidden by the zero-clobber invariant (SPEC.md §8, invariant 1; AGENTS.md).
<!-- SECTION:ALTERNATIVES:END -->

