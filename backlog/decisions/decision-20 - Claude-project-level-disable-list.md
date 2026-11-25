---
id: decision-20
title: Claude project-level disable list
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
a repo must be able to turn off a user server
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
projects[<repo>].disabledMcpServers with owned names (undocumented; checked on 2.1.331 and 2.1.332, not in an interactive session); hybrid mode only warns; fallback is a manual /mcp disable
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
disabledMcpjsonServers (a probe showed it does not disable user servers); hybrid writes (approval-list entries cannot be told apart)
<!-- SECTION:ALTERNATIVES:END -->

