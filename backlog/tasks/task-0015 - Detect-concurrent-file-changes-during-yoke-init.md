---
id: TASK-0015
title: Detect concurrent file changes during yoke init
status: To Do
assignee: []
created_date: '2026-11-25T21:04:02Z'
updated_date: '2026-11-25T21:46:45Z'
labels:
  - standard
  - cli
dependencies: []
priority: low
type: enhancement
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Detect a target that changed between plan and write during yoke init.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A target that changed between plan and write is refused unless --force is passed
- [ ] #2 Fixture test covers the concurrent change
<!-- AC:END -->
