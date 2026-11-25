---
id: TASK-1
title: Empty or malformed JSON MCP config blocks global sync
status: To Do
assignee: []
created_date: '2026-11-25T14:34:52Z'
labels:
  - agy
  - sync
  - doctor
milestone: m-0
dependencies: []
priority: medium
type: bug
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An empty or malformed agy `~/.gemini/config/mcp_config.json` makes `yoke sync --global` exit 1 with `invalid JSON in <path>` and makes `yoke doctor` report a problem.

Expected: name the file and skip only that scope/harness, do not block the rest. Safe to refuse (never overwrite an unparseable file).

Repro:
1. `yoke init`
2. add agy to user harnesses in `~/.config/yoke/yoke.yaml`
3. `yoke sync --global`
4. empty `~/.gemini/config/mcp_config.json`

Target: v0.2.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 yoke sync --global names the unparseable file, skips only the affected harness/scope, and still syncs the others
- [ ] #2 yoke doctor reports the unparseable file as a scoped problem without failing other checks
- [ ] #3 An unparseable native config file is never overwritten
- [ ] #4 Fixture-based vitest tests cover empty and malformed mcp_config.json
<!-- AC:END -->
