---
updated_date: '2026-11-25T21:59:01Z'
id: decision-0004
title: enabled false stubs
date: '2026-11-25T21:04:19Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
A project or local scope must be able to turn off an MCP server it inherits from the user scope without redefining it (SPEC.md §3 table, "disabling inherited MCPs"; §4.1 example github: { enabled: false }). The full-definition rule (decision-0003) would otherwise force a complete entry just to disable a server.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- enabled: false with no transport is a stub (McpDisabledStubSchema). It suppresses the inherited entry and is not a transport change.
- A same-transport override that omits enabled keeps the inherited enabled value, so a disabled server stays disabled.
- A transport change resets enabled to true unless the override sets it.
- A stub with nothing beneath it is dropped by the merge.
- After merge, enabled is always explicit; a stub over a full definition yields that definition with enabled: false.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Each adapter renders a disabled server natively: agy writes "disabled": true (decision-0021); Claude omits it and uses a per-project disable list (decision-0020).
- A disable cannot be expressed in Claude hybrid mode in v0.1 (decision-0020).
- Keep in sync: src/core/schema.ts McpDisabledStubSchema, src/core/scopes.ts, README "Merging scopes".
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- None named.
<!-- SECTION:ALTERNATIVES:END -->

