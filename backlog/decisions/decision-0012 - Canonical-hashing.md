---
id: decision-0012
title: Canonical hashing
date: '2026-11-25T21:04:20Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
hashes must not depend on key order or formatting
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
lowercase hex sha256 of sorted-key canonical JSON; instructions hashed as symlink or file kind, so editing AGENTS.md behind a link is not drift
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
a sha256 prefix
<!-- SECTION:ALTERNATIVES:END -->

