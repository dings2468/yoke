---
id: TASK-6
title: agy session export and seeded launch with .yoke/HANDOFF.md
status: To Do
assignee: []
created_date: '2026-11-25T21:03:55Z'
labels:
  - standard
milestone: m-0
dependencies: []
priority: medium
type: feature
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Export from the latest agy log, falling back to .yoke/HANDOFF.md. Launch agy with a bootstrap prompt that seeds the session. Record evidence for the agy log location (unverified).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Export reads the latest agy log and falls back to HANDOFF
- [ ] #2 agy is spawned with a bootstrap prompt
- [ ] #3 Adapter declares sessionImport seeded
- [ ] #4 Evidence for the agy log location is recorded and marked unverified
<!-- AC:END -->
