---
updated_date: '2026-11-25T21:59:02Z'
id: decision-0007
title: AGENTS.md is the only instruction source
date: '2026-11-25T21:04:20Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
Claude Code and agy both read AGENTS.md natively. Claude stops loading AGENTS.md when a CLAUDE.md exists that does not import it (SPEC.md §4.2, §6 mapping table). Generating per-harness instruction files would duplicate text.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- AGENTS.md is the only shared instruction file, and only the user edits it. yoke writes no project instruction file and never writes CLAUDE.md or GEMINI.md.
- sync and doctor warn when a user-written CLAUDE.md does not start with the line @AGENTS.md.
- There is no instructions: key; paths are fixed at <repo>/AGENTS.md and <userConfigDir>/AGENTS.md.
- Personal text goes in Claude's CLAUDE.local.md, which the user writes. AGENTS.local.md is not supported.
- An optional user GEMINI.md holds agy-only text and is not managed.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- No project instruction drift to track; instructionsHash is null at project scope (inferred from SPEC.md §4.2, §4.3).
- Harness-only text must go in user-written files (decision-0009).
- Keep in sync: src/adapters/claude.ts CLAUDE_IMPORT_LINE, README "Instructions".
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- Generating CLAUDE.md or GEMINI.md: unnecessary, because both harnesses read AGENTS.md natively (SPEC.md §4.2).
- A project GEMINI.md symlink: rejected, because agy would load the same text twice (SPEC.md §4.2).
- AGENTS.local.md: reason not recorded in SPEC.md or the code.
- A configurable instructions: key: rejected, because the paths are fixed (SPEC.md §4.1).
<!-- SECTION:ALTERNATIVES:END -->

