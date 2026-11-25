---
id: decision-0023
title: init import and secrets policy
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
importing must not leak secrets
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
sources are harnesses or instruction files; --secrets local (default, user file at 0600) or ref; project yoke.yaml always uses ${VAR}; an existing user file only gains missing servers, even with --force, and keeps its comments; the flag makes init non-interactive
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
auto-merging differing instruction sources
<!-- SECTION:ALTERNATIVES:END -->

