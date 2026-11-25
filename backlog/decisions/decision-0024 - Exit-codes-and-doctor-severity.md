---
updated_date: '2026-11-25T21:59:06Z'
id: decision-0024
title: Exit codes and doctor severity
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
CI and scripts must tell success, failure, usage errors, drift refusal, and interruption apart. yoke sync --dry-run is meant to work as a CI drift check (SPEC.md §7, Exit codes). v0.1 cannot verify logins, so doctor must not report unverifiable auth as a failure.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- Exit codes (src/commands/exit.ts): 0 success, nothing to do, or a clean check. 1 a doctor problem, or a runtime failure (invalid config, unreadable native state, plan conflict, apply failure, import error). 2 a usage error, including a prompt needed without a TTY. 3 drift refused, the user chose Abort, or a blocked dry run. 130 interrupted before anything was written.
- --dry-run returns the same code as a real run. yoke sessions will return only 0, 1 and 2.
- doctor is read-only and uses the statuses ok, info, warn, unknown, problem. It exits 1 only when a check is a problem.
- Auth is a credentials heuristic with no login probe. A harness without found credentials is unknown, and a probe timeout is unknown.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Auth is never a hard failure.
- agy auth is always unknown, because authenticated is always false.
- A probe that fails without timing out is a problem.
- Keep in sync: src/commands/exit.ts table, src/commands/doctor-format.ts, README "Exit codes" (still links SPEC.md §7).
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- A login probe in v0.1: deferred (SPEC.md §9, TASK-0012); reason not recorded.
<!-- SECTION:ALTERNATIVES:END -->

