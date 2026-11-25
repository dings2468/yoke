---
id: decision-22
title: Unknown and opaque native entries
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
native files hold things yoke does not model
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
unknown keys kept when the transport is unchanged and ignored for drift; unknown top-level keys untouched; unknown transports left unmanaged; fields that do not fit the transport make the entry opaque (kept byte-for-byte, with a warning); an error only when yoke defines the same name, unless --force; corrupt values stay errors
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
none named
<!-- SECTION:ALTERNATIVES:END -->

