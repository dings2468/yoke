---
id: TASK-8
title: yoke switch <target> [--from <source>] [--no-launch]
status: To Do
assignee: []
created_date: '2026-11-25T21:03:55Z'
labels:
  - standard
milestone: m-0
dependencies:
  - TASK-4
  - TASK-5
  - TASK-6
  - TASK-7
priority: medium
type: feature
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Run pre-flight, then export, then save to .yoke/sessions/<id>.json, then import and launch. Checks capabilities and falls back to handoff-file-only. Exit codes 0/1/2/3/130.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Pre-flight runs before export
- [ ] #2 Snapshot is saved to .yoke/sessions/<id>.json
- [ ] #3 Capabilities are checked and handoff-file-only is the fallback
- [ ] #4 Exit codes are 0/1/2/3/130
<!-- AC:END -->
