---
updated_date: '2026-11-25T21:59:02Z'
id: decision-0009
title: Retire yoke:*-only tags
date: '2026-11-25T21:04:20Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
An earlier design let AGENTS.md carry <!-- yoke:claude-only --> and <!-- yoke:agy-only --> blocks. That only works if yoke generates per-harness files. Since yoke no longer generates instruction text (decision-0007), the tags have no effect (SPEC.md §4.2).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- The tags are not supported.
- If AGENTS.md still contains them, sync and doctor warn with the file and 1-based line numbers. Both harnesses see the raw text.
- Detection matches any opening or closing yoke:<word>-only comment on a line; fences are not parsed (src/core/instructions.ts LEGACY_TAG).
- Users move claude-only text to CLAUDE.md and agy-only text to GEMINI.md by hand.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Leftover tags leak raw harness-specific text to both harnesses until moved.
- A tag inside a code fence also warns (inferred from "fences are not parsed").
- Keep in sync: src/core/instructions.ts, README "Instructions", the AGENTS.md test priority on leftover tags.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- Keeping conditional tags: reason not recorded beyond yoke no longer generating instruction files.
- A migration helper: SPEC.md says only that there is no migration helper; reason not recorded.
<!-- SECTION:ALTERNATIVES:END -->

