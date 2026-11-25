---
updated_date: '2026-11-25T21:59:03Z'
id: decision-0012
title: Canonical hashing
date: '2026-11-25T21:04:20Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
The lock stores hashes of MCP definitions and instruction targets. Comparing them against reverse-read native state must not flag a change just because of key order or formatting (SPEC.md §4.3). A CLAUDE.md symlink to AGENTS.md would otherwise count as drift every time AGENTS.md is edited.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- Hashes are lowercase hex sha256 with no sha256: prefix (64 characters).
- The input is sorted-key canonical JSON: keys sorted recursively, array order kept, no whitespace, undefined keys omitted, UTF-8. Non-finite numbers throw.
- Instruction targets are hashed as {kind:"symlink",target} or {kind:"file",content} (src/core/drift.ts).
- ownedNames is never compared.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Hashes are stable across formatting changes.
- Editing AGENTS.md behind a link is not drift.
- Changing the canonical form invalidates every existing lock and would show as drift (inferred).
- Keep in sync: src/core/drift.ts canonicalJson, src/core/schema.ts Sha256HexSchema, tests/drift.test.ts.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- A sha256: prefix on hashes: reason not recorded in SPEC.md or the code.
<!-- SECTION:ALTERNATIVES:END -->

