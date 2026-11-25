---
updated_date: '2026-11-25T21:59:01Z'
id: decision-0005
title: Strict schemas, version 1
date: '2026-11-25T21:04:19Z'
status: proposed
---
## Context

<!-- SECTION:CONTEXT:BEGIN -->
Config files are hand-edited YAML, and a typo such as mcpServers: would otherwise be silently ignored (SPEC.md §4.1). AGENTS.md requires that all external inputs (yoke.yaml, yoke.local.yaml, both lock files, YokeSessionIR) be validated through Zod schemas in src/core/schema.ts.
<!-- SECTION:CONTEXT:END -->

## Decision

<!-- SECTION:DECISION:BEGIN -->
- All schemas are strict objects: unknown keys are rejected in every file and nested object.
- version: 1 is required in every scope file, including yoke.local.yaml.
- An empty or comment-only scope file is rejected.
- YAML null is rejected everywhere in v0.1.
- An older yoke rejects files written by a newer one.
- Defaults are applied after merge and never written.
- Open, not decided in SPEC.md: whether null should later remove an inherited field.
<!-- SECTION:DECISION:END -->

## Consequences

<!-- SECTION:CONSEQUENCES:BEGIN -->
- Typos fail loudly.
- Files are not forward compatible: a newer schema needs a version bump or a yoke upgrade (inferred).
- There is no way yet to remove an inherited field.
- Keep in sync: src/core/schema.ts TSDoc, tests/schema/.
<!-- SECTION:CONSEQUENCES:END -->

## Alternatives

<!-- SECTION:ALTERNATIVES:BEGIN -->
- Ignoring unknown keys: rejected, because strict objects catch typos such as mcpServers: (SPEC.md §4.1).
<!-- SECTION:ALTERNATIVES:END -->

