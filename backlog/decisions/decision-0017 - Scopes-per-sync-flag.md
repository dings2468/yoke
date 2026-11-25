---
updated_date: '2026-11-25T21:59:04Z'
id: decision-0017
title: Scopes per sync flag
date: '2026-11-25T21:04:21Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
User-scope files live in the home directory and affect every repo, while project and local files belong to one repo. A default sync should not silently rewrite global config, and --global must work outside a repo (SPEC.md §6, §7).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- sync plans project and local.
- --global plans user only and needs no repository; without a git root, the current directory is used as repoPath.
- --all plans user, project, and local.
- --global together with --all is a SyncRequestError, which the CLI maps to a usage error (exit 2). Commander also declares the options as conflicting.
- SyncOptions.scopes carries the chosen set to adapters.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Global changes need an explicit flag.
- Claude's disable list is planned only when local is in scope (src/adapters/claude.ts planClaudeDisables).
- Keep in sync: src/core/plan.ts scopesForFlags, src/main.ts option definitions, README "Commands".
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- None named.
<!-- SECTION:ALTERNATIVES:END -->

