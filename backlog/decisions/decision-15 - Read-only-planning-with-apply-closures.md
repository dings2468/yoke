---
id: decision-15
title: Read-only planning with apply closures
date: '2026-11-25T21:04:21Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
dry-run parity should come from the design
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
planning gets a ReadFs; apply(ctx) gets the writable fs and the backup session; only executePlan applies; noop plans never run; the registry does no I/O
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
passing a dry-run flag to adapters
<!-- SECTION:ALTERNATIVES:END -->

