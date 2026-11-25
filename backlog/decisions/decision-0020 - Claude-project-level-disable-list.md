---
updated_date: '2026-11-25T21:59:05Z'
id: decision-0020
title: Claude project-level disable list
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
- A repo must be able to turn off an inherited user-scope Claude server (decision-0004), but Claude has no documented per-project disable key.
- projects[<repo>].disabledMcpServers is undocumented. It was checked statically on 2.1.331 and by a non-interactive throwaway-home probe on 2.1.332, but not in an interactive session.
- A probe showed that disabledMcpjsonServers does not disable user-scope servers (SPEC.md §6).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- For a project-level disable of a user-scope server, yoke writes the name into projects[<repo realpath>].disabledMcpServers in ~/.claude.json.
- It tracks the name in .yoke/yoke.lock under claude:local, ownedNames["disabled-servers"], and removes only owned names.
- This is planned only when local is in scope, and only for names defined in the user tier.
- In hybrid mode nothing is written: each name gets a warning, and the owned names are kept.
- A malformed list is an error unless --force. With --force, yoke writes nothing, keeps the owned names, and warns with the manual fix /mcp disable <name>.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Relies on an undocumented key that may break.
- Hybrid users must disable by hand (TASK-0010).
- Keep in sync: src/adapters/claude.ts planClaudeDisables, README "v0.1 limits".
- To check before accepting: the SPEC.md hybrid sentence does not say which key "that key" refers to.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- disabledMcpjsonServers: rejected, because a probe showed it does not disable user-scope servers (SPEC.md §6).
- Writing disables in hybrid mode: deferred, because Claude's approval list shares that key's meaning for rejected names, so yoke cannot tell its entries apart (SPEC.md §6).
<!-- SECTION:ALTERNATIVES:END -->

