# yoke vision

**One config, any coding harness.** Sync MCP servers, instructions, and live sessions across Claude Code, Antigravity, OpenCode, Gemini CLI, Codex, and beyond.

## What yoke is for

Developers increasingly run several AI coding CLIs side by side. Each one has its own configuration, its own usage quota, and its own strengths, and people switch between them to work around quota limits or to pair a model with the task it handles best. Every switch breaks flow: the tools, the rules, and the context that were set up in one harness do not carry over to the next.

yoke gives every harness one configuration and one set of instructions, so the same tools and rules are present wherever you work. It also lets you move a live session from one harness to another with the same tools, rules, and context, after first checking that the receiving harness has not drifted from the shared configuration.

## Who it is for

- **Developers** who run several AI coding CLIs side by side, or who switch to another one when a quota runs out.
- **Teams** with mixed harness use who want one shared, versioned configuration in the repository instead of a copy per tool.
- **Contributors** who want to add support for a new harness.

## Non-goals

* yoke is **not** an LLM proxy, API router, or OAuth wrapper. It never intercepts model traffic or violates consumer subscription Terms of Service.
* yoke does **not** attempt brittle 1:1 translation of proprietary tool-call schemas (`Edit` vs. `replace_file_content`) or cryptographic thinking/thought signatures between providers.

## Harness compatibility

| Harness | Static MCP and instructions | Drift check | Session export | Session import | Status |
| --- | --- | --- | --- | --- | --- |
| Claude Code | yes (v0.1) | yes (v0.1) | planned (v0.2) | planned (v0.2) | released in v0.1.0 |
| Antigravity (agy) | yes (v0.1, user scope only; SSE servers and project or local servers are skipped) | yes (v0.1) | planned (v0.2) | planned (v0.2) | released in v0.1.0 |
| OpenCode | planned | planned | planned | planned | not scheduled |
| Gemini CLI | planned | planned | planned | planned | not scheduled |
| Codex CLI | planned | planned | planned | planned | not scheduled |
| Cursor | planned | planned | planned (handoff file only) | planned (handoff file only) | not scheduled |

"Not scheduled" means no release has been assigned yet.

Note: how Antigravity picks up user-level instructions is not yet verified, so instruction sync for Antigravity should be treated as provisional.

## Releases

- **v0.1:** static core and drift protection. Released as v0.1.0.
- **v0.2:** interactive pre-flight and session handoff between Claude Code and Antigravity. Planned (milestone v0.2).
- **Later releases:** not scheduled.

## Where the details live

The README documents how to use yoke. The code and its tests define the contract that yoke keeps with users and harnesses. The backlog decision list explains why the project is built the way it is. The backlog task list holds the plan for upcoming work.
