---
updated_date: '2026-11-25T21:59:02Z'
id: decision-0006
title: Value and name rules
date: '2026-11-25T21:04:19Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
- Harness names become part of the lock state key <harness>:<scope>, so they must not contain ":".
- Session ids become file names (SPEC.md §4.1, §4.4).
- Values copied into native JSON must keep ${VAR} references verbatim (AGENTS.md invariant 4).
- YAML would otherwise turn 8080 into a number.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- env and headers values must be YAML strings; numbers and booleans are not coerced.
- env keys match ^[A-Za-z_][A-Za-z0-9_]*$.
- URLs start with http://, https://, or a ${VAR} reference.
- Harness names match ^[a-z][a-z0-9-]{0,31}$; MCP server names match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$.
- harnesses has no duplicates.
- session.maxTurns is a positive integer with no upper bound.
- Header names must be HTTP token characters (src/core/schema.ts HeaderMapSchema; not in SPEC.md).
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Users must quote PORT: "8080".
- Native entries with invalid names or non-string values are corrupt values and errors (decision-0022).
- Keep in sync: src/core/schema.ts regexes and TSDoc, README "Configuration", tests/schema/.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- Coercing numbers and booleans: reason not recorded in SPEC.md or the code.
- z.url() for URLs: rejected because it rejects ${VAR} (src/core/schema.ts RemoteUrlSchema TSDoc).
<!-- SECTION:ALTERNATIVES:END -->

