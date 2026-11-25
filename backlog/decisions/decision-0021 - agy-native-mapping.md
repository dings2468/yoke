---
updated_date: '2026-11-25T21:59:05Z'
id: decision-0021
title: agy native mapping
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
- agy has only a user-level MCP file, ~/.gemini/config/mcp_config.json.
- agy does not support legacy HTTP+SSE.
- It has no known v0.1 project-level MCP mechanism (unverified; no evidence of one).
- agy 1.5.16 writes serverUrl from its CLI and does not expand ${VAR} (SPEC.md §6; src/adapters/agy.ts header).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- yoke patches only the top-level mcpServers of mcp_config.json.
- HTTP entries are written with url; readNativeState accepts url and the legacy alias serverUrl. A url that differs from serverUrl, or an httpUrl, is a corrupt value.
- "disabled": true is emitted only when the merged result still has a full definition.
- transport: sse servers are skipped with a warning and excluded from agy's mcpHashes.
- Project and local servers are skipped with a warning (an advisory plan) and never written to the global file.
- ${VAR} is stored literally, with one warning per affected server.
- Capabilities: reverse-read true, sessionExport false.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Only user-scope servers reach agy (TASK-0014).
- ${VAR} values may fail at runtime in agy (inferred from "does not expand").
- detect().authenticated is always false in v0.1 (TASK-0012).
- Keep in sync: src/adapters/agy.ts, README "v0.1 limits", tests/fixtures/.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- Writing project or local servers into the global file: rejected; SPEC.md and AGENTS.md say they are never written to the global file, with no further reason recorded.
- Writing serverUrl: reason not recorded in SPEC.md or the code.
<!-- SECTION:ALTERNATIVES:END -->

