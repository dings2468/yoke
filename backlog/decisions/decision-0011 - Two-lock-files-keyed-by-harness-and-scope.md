---
updated_date: '2026-11-25T21:59:03Z'
id: decision-0011
title: Two lock files keyed by harness and scope
date: '2026-11-25T21:04:20Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
Drift detection needs the last-synced hashes per harness and per scope (SPEC.md §4.3, §5). yoke sync --global syncs the user scope and needs no repository (SPEC.md §7), so user-scope state cannot live only in the repo. Shared native lists such as Claude's disable list mix yoke names with user names.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- Two gitignored lock files with the same schema: .yoke/yoke.lock holds project and local; <userConfigDir>/yoke.lock holds user.
- Fields: version: 1, lastSyncedAt (ISO-8601), and harnesses, keyed "<harness>:<scope>" (the field keeps its old name).
- Each entry has mcpHashes, instructionsHash (or null), and optional ownedNames (list id to names yoke added).
- Only names in ownedNames are ever removed from a shared native list.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Repo-free user sync is possible.
- A corrupt lock becomes the lock-corrupt gate reason (decision-0016).
- Locks are written last and only after every write succeeds.
- Keep in sync: src/core/schema.ts YokeStateLockSchema, src/core/plan.ts lock I/O, README "Safety".
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- None named.
<!-- SECTION:ALTERNATIVES:END -->

