---
updated_date: '2026-11-25T21:59:03Z'
id: decision-0010
title: Remove instruction files yoke generated earlier
date: '2026-11-25T21:04:20Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
Earlier yoke versions wrote a project CLAUDE.md, GEMINI.md, or CLAUDE.local.md. Under decision-0007 these are stale and may shadow AGENTS.md. They must be removed without touching files the user wrote (SPEC.md §4.2).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- A file counts as yoke-generated when the lock has its instructionsHash, its first line is the GENERATED header, or it is a symlink resolving to the source. That file gets a remove plan on sync.
- The removal is backed up first and passes the drift gate. If the native file differs from the lock, the gate prompts, or refuses without --force.
- Afterwards instructionsHash is null.
- Any other file gets a no-op plan with a warning and is never touched.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Upgrading yoke cleans up old outputs automatically and recoverably.
- A user who edited a generated file is protected by the gate.
- Keep in sync: src/adapters/base.ts planInstructionRemoval, src/core/instructions.ts GENERATED_HEADER, SPEC.md §8.2 "yoke-managed" definition, README "Instructions".
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- None named.
<!-- SECTION:ALTERNATIVES:END -->

