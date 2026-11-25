---
id: decision-18
title: Atomic writes and backups
date: '2026-11-25T21:04:21Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
shared configs must never be clobbered
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
patch only the target key; temp file <name>.<random>.yoke.tmp created with wx, then renamed; backups in <userConfigDir>/backups/<ts>/ with the path mirrored, a -N suffix, mode 0700; shared JSON files never count as managed
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
wholesale overwrite
<!-- SECTION:ALTERNATIVES:END -->

