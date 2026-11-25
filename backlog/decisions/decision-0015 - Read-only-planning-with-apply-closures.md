---
updated_date: '2026-11-25T21:59:04Z'
id: decision-0015
title: Read-only planning with apply closures
date: '2026-11-25T21:04:21Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
AGENTS.md invariant 3 requires that --dry-run run the exact same planning pipeline and only skip apply(). If adapters wrote during planning, or branched on a dry-run flag, a dry run could behave differently from a real one (SPEC.md §6, §8 invariant 3).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- AdapterContext.fs is a ReadFs, so detect, readNativeState, and syncStatic cannot write.
- Each FileChangePlan.apply(ctx) receives an ApplyContext with the writable Fs and the run's backup session.
- The only caller of apply is executePlan in src/core/plan.ts, and a noop plan is never applied.
- Adapters never see the clock or a dry-run flag.
- Adapters are built through src/adapters/registry.ts (createAdapters, ADAPTER_FACTORIES); building one performs no I/O.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- A dry run cannot write, by construction.
- doctor reuses planning and cannot write either.
- Every write must be expressed as a closure, and plans carry before and after text for diffs.
- Keep in sync: src/adapters/base.ts and src/core/fs-safe.ts TSDoc, tests/adapters/.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- A dry-run or preview flag passed to adapters: rejected; the code documents that there is no preview flag (src/core/plan.ts header).
<!-- SECTION:ALTERNATIVES:END -->

