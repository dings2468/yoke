---
updated_date: '2026-11-25T21:59:01Z'
id: decision-0003
title: Merge rules for same-named servers
date: '2026-11-25T21:04:19Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
The same MCP server name can be defined in more than one scope, for example a user server overridden in the project. Without fixed rules the effective definition would be ambiguous (SPEC.md §3.1). The merge lives in src/core/scopes.ts.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
Entries are merged in precedence order (local > project > user):
- Maps (env, headers) merge field by field, and higher-precedence keys win.
- Arrays (args) are replaced whole.
- A change of transport replaces the whole entry, with nothing inherited.
- Non-MCP keys (mode, session) take the value from the highest scope that sets them.
- harnesses is replaced whole.
- Every non-stub entry must be a complete definition with a transport; partial overrides (only env in yoke.local.yaml) are invalid.
ResolvedMcpServer.scopes lists the contributing scopes in ascending precedence.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Users must repeat a full definition to change one field (README "Merging scopes").
- Merge results are deterministic and can be hashed (inferred).
- Keep in sync: src/core/scopes.ts TSDoc (it duplicates these rules), README "Merging scopes", tests/scopes.test.ts.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- Concatenating arrays: reason not recorded in SPEC.md or the code.
- Partial overrides of a lower-scope server: reason not recorded in SPEC.md or the code.
<!-- SECTION:ALTERNATIVES:END -->

