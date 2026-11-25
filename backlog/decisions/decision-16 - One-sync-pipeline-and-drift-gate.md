---
id: decision-16
title: One sync pipeline and drift gate
date: '2026-11-25T21:04:21Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
one planning path for sync, dry-run and doctor
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
buildSyncPlan only (read-only, no clock); PlanConflictError for shared paths; gate reasons drift, lock-corrupt, drift-unchecked; apply in order, locks last; a failure writes no lock; an instructions fallback keeps the old lock value
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
none named
<!-- SECTION:ALTERNATIVES:END -->

