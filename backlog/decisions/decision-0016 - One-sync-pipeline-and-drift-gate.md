---
updated_date: '2026-11-25T21:59:04Z'
id: decision-0016
title: One sync pipeline and drift gate
date: '2026-11-25T21:04:21Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
sync, sync --dry-run, and doctor all need the same plan and drift result. Separate code paths could disagree (SPEC.md §6, Sync pipeline). The drift gate (AGENTS.md invariant 5) must be decided before any write, and a partial failure must not leave a lock that claims success.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- buildSyncPlan(PlanRequest) is the single planning path. It reads only, takes no clock, and returns a SyncPlan. In order it validates the request, loads and merges the scope files, loads both locks, builds the adapters and calls syncStatic, raises PlanConflictError when two non-composable plans share a path, and runs the three-way drift check.
- Gate reasons are drift, lock-corrupt, and drift-unchecked. blocked means reasons are present and --force is not passed.
- executePlan decides the gate first: clear, forced, or confirm. An absent confirm means refused.
- Plans apply in order under one backup session. The lock files are written last, atomically and backed up.
- A throwing apply stops the run, writes no lock, and returns failed. An instructions fallback keeps the previous lock value.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- A dry run and doctor see exactly what a real run would do.
- doctor plans one adapter at a time so that one failure does not hide others (src/main.ts plannerFromPlan).
- Keep in sync: src/core/plan.ts TSDoc, tests/core/plan*, tests/plan-adapters.test.ts.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- None named.
<!-- SECTION:ALTERNATIVES:END -->

