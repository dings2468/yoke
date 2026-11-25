---
id: TASK-4
title: Export the latest Claude Code session to YokeSessionIR
status: To Do
assignee: []
created_date: '2026-11-25T21:03:55Z'
labels:
  - standard
milestone: m-0
dependencies: []
priority: medium
type: feature
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Export the latest .jsonl session from ~/.claude/projects/<repo-hash>/ into a YokeSessionIR v1 document.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Output is schema-valid YokeSessionIR
- [ ] #2 Signatures, raw dumps and logs are stripped
- [ ] #3 Each action is 1-300 chars on one line
- [ ] #4 Git state is filled in
- [ ] #5 session.maxTurns and includeGitDiffStat are honored
- [ ] #6 Claude adapter declares sessionExport true
- [ ] #7 Fixture .jsonl tests cover the export
<!-- AC:END -->
