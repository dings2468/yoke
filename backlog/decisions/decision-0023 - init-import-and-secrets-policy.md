---
updated_date: '2026-11-25T21:59:06Z'
id: decision-0023
title: init import and secrets policy
date: '2026-11-25T21:04:22Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
yoke init imports existing native MCP servers and instructions. Native configs often hold literal tokens, and the project yoke.yaml is committed, so importing must not leak secrets (AGENTS.md invariant 4, SPEC.md §7 init, §8 invariant 4). Users may already have a hand-edited user-scope file.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- Sources are harness names (claude, agy) or instruction file paths. Native MCP JSON files are not a v0.1 source (TASK-0013).
- User-only servers go to ~/.config/yoke/yoke.yaml.
- --secrets local (default) writes literal values to that user file at mode 0600. --secrets ref writes ${VAR} references instead.
- Project yoke.yaml always uses ${VAR}. Under local, the full originals go to yoke.local.yaml (src/commands/init-convert.ts).
- An existing user file only gains missing servers, never replaced even with --force, and its comments are kept.
- --import-from makes selection non-interactive; without it and without a TTY, init is a usage error.
- Differing instruction sources are never auto-merged; the user picks one.
- Init never writes the lock files.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- The committed file is secret-free, and the code asserts it.
- There is no concurrent-change check (TASK-0015).
- Keep in sync: src/core/secrets.ts, src/commands/init*.ts, README "Commands".
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- Auto-merging differing instruction sources: rejected (SPEC.md §7: the user picks one); reason not recorded.
- Importing native MCP JSON files: deferred past v0.1 (TASK-0013); reason not recorded.
<!-- SECTION:ALTERNATIVES:END -->

