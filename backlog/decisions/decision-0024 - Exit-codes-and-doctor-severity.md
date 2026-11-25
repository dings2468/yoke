---
id: decision-0024
title: Exit codes and doctor severity
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
CI must tell outcomes apart
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
0/1/2/3/130; a dry run returns the same code as a real run; sessions returns only 0/1/2; doctor is read-only, auth is a credentials heuristic where missing credentials or a probe timeout means unknown, and it exits 1 only on a problem
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
a login probe in v0.1
<!-- SECTION:ALTERNATIVES:END -->

