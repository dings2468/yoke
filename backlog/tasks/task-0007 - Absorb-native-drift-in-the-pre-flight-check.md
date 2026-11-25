---
id: TASK-0007
title: Absorb native drift in the pre-flight check
status: To Do
assignee: []
created_date: '2026-11-25T21:03:55Z'
labels:
  - standard
milestone: m-0
dependencies: []
priority: medium
type: feature
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
v0.2

In v0.2, the prompt is replaced by an absorption flow:

3. **Prompt the user:**
   ```text
   Pre-flight check (claude -> agy)
     Detected native changes in Claude Code since last sync:
     + MCP server: "postgres" (stdio: npx -y @modelcontextprotocol/server-postgres)
     ~ CLAUDE.md: +3 lines added

   ? Bring these changes into yoke and sync to agy before switching?
     > Yes — add to yoke.yaml (project) & sync to agy
       Yes — add to yoke.local.yaml (local/gitignored) & sync to agy
       Only MCPs (skip instruction diff)
       No — switch session only (keep changes in Claude)
   ```
4. **Absorb & Sync:** Write accepted changes back to `yoke.yaml` / `yoke.local.yaml`, sync the target harness, update `.yoke/yoke.lock`, and proceed with the session handoff.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The four options work
- [ ] #2 Accepted changes go to yoke.yaml or yoke.local.yaml with comments kept
- [ ] #3 The target is synced and the lock is updated
- [ ] #4 "Only MCPs" skips the instruction diff
- [ ] #5 "No" switches the session only
- [ ] #6 Non-interactive runs keep the v0.1 rule (exit 3 unless --force)
- [ ] #7 A harness without reverseRead is reported as drift-unchecked
<!-- AC:END -->
