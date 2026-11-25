---
id: TASK-3
title: Retire SPEC.md into VISION.md, code TSDoc, README and decision records
status: In Progress
assignee: []
created_date: '2026-11-25T21:03:35Z'
labels:
  - tooling
dependencies: []
type: docs
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md is the old contract. Its content moves to VISION.md (vision, users, non-goals, harness compatibility matrix), TSDoc in src/, README.md, and accepted decision records. Plan: see the Kanban restructuring PRs in the branch list (task-3-*).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SPEC.md is deleted and grep -rn SPEC src tests AGENTS.md CONTRIBUTING.md README.md VISION.md .gitignore docker is empty
- [ ] #2 No old plan IDs (Q1-Q3, D1-D11, DI1-DI10, U2-U5, A6, A7, A9, J1, 'decision N') remain in src/ or tests/
- [ ] #3 VISION.md holds vision, users, non-goals and the harness compatibility matrix, with no technical decisions
- [ ] #4 The technical contract is TSDoc in schema.ts, base.ts, plan.ts, scopes.ts, drift.ts, fs-safe.ts, exit.ts, claude.ts and agy.ts
- [ ] #5 README.md documents configuration, scopes, merge rules, instructions, commands, exit codes, safety and the files yoke writes
- [ ] #6 24 decision records exist
- [ ] #7 The v0.2 features are tasks in milestone v0.2 and the seven v0.1 deferrals are tasks without a milestone
- [ ] #8 CONTRIBUTING.md has the Kanban workflow and the Definition of Done, and AGENTS.md points to the new locations
- [ ] #9 The v0.2 milestone description states the release goal
- [ ] #10 typecheck, test and check pass, and backlog doctor is clean
<!-- AC:END -->
