---
updated_date: '2026-11-25T21:59:00Z'
id: decision-0001
title: Three-tier scope model
date: '2026-11-25T21:04:19Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
MCP servers and instructions come from three places: settings that apply to every repo, settings the team commits to the repo, and personal changes that must stay out of git (SPEC.md §3). Each needs its own file and git status. User-scope files also need a fixed home outside any repo (SPEC.md §3, src/core/scopes.ts).
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
Three scopes, resolved strictly as local > project > user:
- user: <userConfigDir>/yoke.yaml and <userConfigDir>/AGENTS.md.
- project: ./yoke.yaml and ./AGENTS.md, committed.
- local: ./yoke.local.yaml, gitignored.
<userConfigDir> is $XDG_CONFIG_HOME/yoke when XDG_CONFIG_HOME is an absolute path, otherwise ~/.config/yoke. An empty or comment-only scope file is rejected; every scope file needs at least version: 1.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Personal overrides and disables of inherited servers live in yoke.local.yaml and never reach git.
- A relative XDG_CONFIG_HOME is ignored.
- Harnesses without a native local tier need special handling (decision-0002, decision-0021).
- Keep in sync: src/core/scopes.ts TSDoc (userConfigDir, parseScopeConfig), README "Scopes", tests/scopes.test.ts.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- None named in SPEC.md, the code, or the README.
<!-- SECTION:ALTERNATIVES:END -->

