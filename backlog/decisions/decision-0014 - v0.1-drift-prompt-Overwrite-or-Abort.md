---
updated_date: '2026-11-25T21:59:04Z'
id: decision-0014
title: 'v0.1 drift prompt: Overwrite or Abort'
date: '2026-11-25T21:04:21Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
Users edit native configs mid-session (claude mcp add, editing CLAUDE.md). Overwriting them silently would violate AGENTS.md invariant 5 (SPEC.md §5). Bringing such edits back into yoke ("absorption") is planned for v0.2 (TASK-0007), so v0.1 needs a simpler choice.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- Interactive drift offers exactly two choices: "Overwrite with yoke config" and "Abort" (src/commands/sync-prompt.ts).
- Non-interactive drift is refused with exit 3 and nothing written, unless --force is passed.
- Abort also exits 3. Cancelling the prompt (Ctrl-C) exits 130.
- --force proceeds with a warning, after backups.
- The original file is always backed up before an overwrite.
- In v0.2 this prompt is replaced by the absorption flow (SPEC.md §5 "v0.2", TASK-0007).
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- In v0.1 native edits are lost, recoverable only from the backup, unless the user copies them into yoke by hand (inferred).
- CI can rely on exit 3.
- Keep in sync: src/commands/sync-prompt.ts labels, src/commands/exit.ts, README "Safety". TASK-0007 must supersede this record.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- The v0.2 absorption options ("add to yoke.yaml", "add to yoke.local.yaml", "Only MCPs", "switch session only"): deferred to v0.2; SPEC.md records no reason for the deferral.
<!-- SECTION:ALTERNATIVES:END -->

