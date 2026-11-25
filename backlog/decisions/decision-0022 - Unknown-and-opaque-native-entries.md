---
updated_date: '2026-11-25T21:59:06Z'
id: decision-0022
title: Unknown and opaque native entries
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
Native files contain things yoke does not model: extra keys inside entries, unrelated top-level keys, unknown transports such as Claude's ws, and malformed entries. Rewriting or rejecting them would break zero-clobber (AGENTS.md invariant 1) or block sync on harmless data (SPEC.md §6 mapping rules).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- Unknown keys inside an MCP entry (extras) are kept on rewrite when the transport is unchanged, and are excluded from drift.
- Unknown top-level keys in a native file are never parsed or modified.
- An entry with an unknown transport, or with fields that do not fit its transport (headers on stdio, command on http), is opaque. It is kept byte-for-byte with a warning and never compared for drift.
- An opaque entry is an error only when yoke defines a server with the same name, unless --force.
- Corrupt values remain errors: non-string env or header values, non-string-list args, invalid server names.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Harness features yoke does not know survive syncs.
- Changing the transport drops the extras.
- Corrupt native files block sync (see TASK-0001 for empty or malformed JSON).
- Keep in sync: src/adapters/base.ts mergeServerEntries, fromClaudeEntry and fromAgyEntry, README "Where yoke writes", the fixture tests.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- None named.
<!-- SECTION:ALTERNATIVES:END -->

