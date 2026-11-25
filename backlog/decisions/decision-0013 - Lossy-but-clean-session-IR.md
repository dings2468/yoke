---
updated_date: '2026-11-25T21:59:03Z'
id: decision-0013
title: Lossy-but-clean session IR
date: '2026-11-25T21:04:20Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
v0.2 will hand live sessions between harnesses (SPEC.md §2, §4.4). Provider transcripts contain cryptographic thinking signatures, proprietary tool-call schemas, and large file dumps. SPEC.md §1 lists brittle 1:1 translation of tool-call schemas or signatures as a non-goal. AGENTS.md invariant 6 makes the clean IR non-negotiable.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- YokeSessionIR version 1 is strict, so keys such as thinking or signature are rejected.
- Strip: signatures, raw multi-hundred-line file reads, verbose terminal logs.
- Preserve: user intents, assistant decisions and plans, compact actions[], and live git state.
- Limits: id matches ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$; actions[].summary is 1 to 300 characters, single-line; content is uncapped and the exporter enforces the stripping; branch and turns may be empty; repoPath is non-empty but not checked for being absolute.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- The receiving harness gets context, not a faithful replay (inferred).
- v0.1 adapters implement no session methods (sessionExport: false); the exporters arrive in TASK-0004 to TASK-0006.
- Keep in sync: src/core/schema.ts YokeSessionIRSchema, tests/schema/.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- 1:1 translation of tool-call schemas and thinking signatures: rejected as brittle (SPEC.md §1 non-goals).
<!-- SECTION:ALTERNATIVES:END -->

