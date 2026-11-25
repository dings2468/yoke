---
updated_date: '2026-11-25T21:59:02Z'
id: decision-0008
title: User instructions as symlinks
date: '2026-11-25T21:04:20Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
User-scope instructions live in <userConfigDir>/AGENTS.md, but Claude reads ~/.claude/CLAUDE.md and agy reads ~/.gemini/GEMINI.md (the agy path is unverified, TASK-0011). SPEC.md §8.2 states that yoke never writes text to an instruction path; it only creates, replaces, or removes links.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- ~/.claude/CLAUDE.md and ~/.gemini/GEMINI.md are relative symlinks to <userConfigDir>/AGENTS.md. An absolute CLAUDE_CONFIG_DIR moves the Claude link to $CLAUDE_CONFIG_DIR/CLAUDE.md (code only).
- There is no copy fallback. When symlinks are not supported, planning returns an advisory plan with a warning and creates nothing.
- If the link call is refused at apply time (EPERM, ENOTSUP, EOPNOTSUPP, EACCES), or the path is a directory, apply reports fallback and the previous lock value is kept.
- The link is created at a temp name and renamed into place, after backing up an existing file or foreign link.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Editing AGENTS.md behind the link is not drift (decision-0012).
- Windows is not handled in v0.1 (TASK-0016).
- The agy link needs agy in user-scope harnesses (README "v0.1 limits").
- To fix: the AdapterContext.symlinksSupported TSDoc in src/adapters/base.ts (about line 130) says "fall back to a copy", which contradicts the code.
- Keep in sync: README "Instructions".
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- A copy fallback: reason not recorded in SPEC.md or the code.
<!-- SECTION:ALTERNATIVES:END -->

