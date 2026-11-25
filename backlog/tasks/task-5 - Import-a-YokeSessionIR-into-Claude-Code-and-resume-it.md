---
id: TASK-5
title: Import a YokeSessionIR into Claude Code and resume it
status: To Do
assignee: []
created_date: '2026-11-25T21:03:55Z'
labels:
  - standard
milestone: m-0
dependencies: []
priority: medium
type: feature
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Synthesize a Claude Code .jsonl from a YokeSessionIR and run claude --resume <id>.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 --no-launch does not spawn claude
- [ ] #2 Claude adapter declares sessionImport native
- [ ] #3 Fixture tests use an injected exec
<!-- AC:END -->
