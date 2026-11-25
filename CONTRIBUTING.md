# Contributing to yoke

Thanks for helping. This file covers how work flows from an idea to a release.
Sections marked **Maintainer only** describe steps that need write access; contributors can skip them.
Architecture and safety rules live in [AGENTS.md](AGENTS.md) and [SPEC.md](SPEC.md); read SPEC.md before architectural changes.

## Development model

yoke uses trunk-based development:

- `main` is always releasable. All work lands on `main` through short-lived branches and squash-merged pull requests.
- A release is an annotated tag `vX.Y.Z` on a commit on `main`, published as a GitHub Release.
- A `release/X.Y` branch exists only when a patch must ship while `main` holds unreleased work. See "Hotfixes".

## Branch names

| Purpose | Name | Base |
|---|---|---|
| Backlog task | `task-<id>-<slug>`, e.g. `task-0001-empty-json-config` | `main` |
| Small change without a task (typo, docs) | `<type>/<slug>`, e.g. `docs/readme-typo` | `main` |
| Release preparation | `release-prep-vX.Y.Z` | `main` or `release/X.Y` |
| Patch line (maintainer only) | `release/X.Y`, e.g. `release/0.1` | tag `vX.Y.Z` |
| Fix for a patch line | `task-<id>-<slug>` | `release/X.Y` |
| Forward-port of that fix | `task-<id>-<slug>-main` | `main` |

Never open a PR *from* `release/X.Y`. Always use a separate branch.

## Commit messages and PR titles

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, imperative and lower case, no trailing period.

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
- Common scopes: `schema`, `scopes`, `fs-safe`, `plan`, `drift`, `instructions`, `claude`, `agy`, `init`, `sync`, `doctor`, `cli`, `vision`, `agents`, `backlog`, `sandbox`, `release`.
- Do not use `chore(merge)`. Squash merging replaces merge commits.

PRs are **squash-merged**. The **PR title becomes the commit subject** on `main` (GitHub appends ` (#N)`), and the PR description becomes the commit body. Write the title as a final commit subject. Commits inside the branch can be informal.

The squash commit is authored by the PR author (GitHub uses the PR author), so the author credit is automatic. Do not add a trailer for it. To credit a real human co-author, add a GitHub `Co-authored-by: Name <id+username@users.noreply.github.com>` line to the PR description, one line per person, using their real GitHub noreply email. Do not put model or tool attribution (for example Claude or Haiku `Co-Authored-By` trailers) in PR descriptions or squash commit messages. These are not GitHub accounts, and GitHub would record them as co-authors on `main`.

## Pull requests

- One topic per PR; keep it small and short-lived. Rebase on `main` if it falls behind (`git fetch origin && git rebase origin/main`).
- Link the backlog task in the description (`TASK-<id>`).
- Every adapter change includes fixture-based vitest tests (see AGENTS.md).

## Definition of Done

A task is Done, and its PR is ready for review, when:
1. every acceptance criterion is met and checked (`backlog task edit TASK-<id> --check-ac <n>`);
2. `npm run typecheck`, `npm test`, `npm run check` pass (`npm run check:fix` applies fixes);
3. adapter changes include fixture-based vitest tests (see AGENTS.md);
4. a changed contract has its TSDoc updated where it is defined, changed user-facing behavior is in README.md, a changed harness support level is in VISION.md, and a new or changed technical rule has an accepted decision record;
5. `backlog doctor` reports no problems;
6. the task has a final summary and status Done, committed in the same PR.

A PR without a task needs items 2 and 4.

## Kanban workflow with Backlog.md

All planned work is a Backlog.md task in `backlog/`. Use the `backlog` CLI; do not edit task, decision, or milestone files by hand.

**Board.** `backlog board` shows To Do, In Progress, Done. To Do is the queue: pull expedite first, then by priority, then by order. In Progress holds at most **2** tasks (WIP limit). Check with `backlog task list -s "In Progress" --plain` before pulling, and finish or return a task before starting another. Done means the Definition of Done holds; a task is set to Done in the PR that finishes it.

**Classes of service.** Every task has exactly one of these labels:
- `expedite`: a bug in a released version that blocks users, or a breach of a safety invariant. Pulled first; may exceed the WIP limit by one, at most one at a time; ships as a patch (see "Hotfixes").
- `standard`: product features and bugs. Pulled in order; usually in a milestone.
- `tooling`: dev environment, sandbox, CI, docs and process. Counts toward the WIP limit; usually no milestone.

Topic labels (for example `agy`, `sync`) may be added.

**Milestones.** A milestone is a release target (`v0.2` ships as `v0.2.0`). Create it with a one-sentence release goal: `backlog milestone add "vX.Y" -d "<what this release lets users do>"`. The CLI cannot edit the description later, so write it at creation. Tasks without a milestone are unscheduled; schedule one with `backlog task edit TASK-<id> -m vX.Y`. After the release, archive it with `backlog milestone archive vX.Y`.

**Decisions.** A technical rule, format, or rejected alternative is a decision record: `backlog decision create "Title" --context "..." --decision "..." --alternatives "..." -s accepted`. To change one, create a new accepted record and run `backlog decision edit decision-<n> -s superseded --superseded-by decision-<m>`. Code comments cite `decision-<n>` only where the reason is not obvious.

**Flow.**
1. `backlog task create "Title" -d "Context" --type bug -l standard --ac "Criterion" -m vX.Y` (bugs include a reproduction).
2. On the task branch, first commit: `backlog task edit TASK-<id> -s "In Progress"`.
3. In the PR that finishes it: check the criteria and set `-s Done --final-summary "What changed"`. Task files are committed on the task branch with the code.

**IDs on parallel branches.** IDs are assigned at creation. Run `git fetch origin` first so the CLI sees other active branches, and run `backlog doctor` before opening the PR.

## Releasing (maintainer only)

Version numbers live in `package.json`, `package-lock.json`, and `src/main.ts` (`VERSION`); `tests/commands/cli-version.test.ts` checks that they match.

1. Create the release-prep branch and bump the version:
   ```bash
   git switch main && git pull --ff-only
   git switch -c release-prep-vX.Y.Z
   npm version X.Y.Z --no-git-tag-version      # updates package.json and package-lock.json
   # edit src/main.ts: export const VERSION = "X.Y.Z";
   ```
2. Update README.md (limits and features) and SPEC.md (roadmap: "released as vX.Y.Z") so they describe the released version.
3. Check the Definition of Done, then the manual sandbox checklist:
   ```bash
   npm run build
   npm run sandbox:build && npm run sandbox
   # inside the sandbox:
   #   yoke --version          -> X.Y.Z
   #   yoke init; yoke sync --dry-run; yoke sync; yoke doctor   -> expected output, exit 0
   #   reproduce each bug fixed in this milestone and confirm it is gone
   ```
4. Open the PR titled `chore(release): vX.Y.Z` and squash-merge it.
5. Tag the squash commit. Verify first that it is the release commit:
   ```bash
   git switch main && git pull --ff-only
   SHA=$(git rev-parse HEAD)
   git log -1 --format=%s "$SHA"                # chore(release): vX.Y.Z (#N)
   git show "$SHA":package.json | grep '"version"'
   git tag -a vX.Y.Z -m "vX.Y.Z" "$SHA"
   git merge-base --is-ancestor vX.Y.Z origin/main && echo reachable
   git push origin vX.Y.Z
   ```
6. Publish the GitHub Release. Write the notes in a file outside the repo:
   ```bash
   gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file /path/to/notes.md --latest
   ```
   Check the notes before running this. Never move or reuse a tag; ship a new patch version instead.

Rules:
- A `vX.Y.0` tag always points at a commit on `main`.
- A patch tag points at a commit on `main` (no release branch) or on `release/X.Y`.

## Hotfixes (maintainer only)

First check whether `main` holds unreleased work:
```bash
git fetch origin --tags
git log --oneline vX.Y.Z..origin/main
```

### Case 1: nothing on `main` you would not ship

The log is empty or holds only changes you are happy to ship (docs, tests, chores).

1. `git switch -c task-<id>-<slug> origin/main`, fix it, add a test, verify, open a `fix(scope): ...` PR, and squash-merge.
2. Run the release steps with the version `X.Y.(Z+1)`.

### Case 2: `main` holds unreleased features

1. Create the patch line, if it does not exist yet, from the last tag on that line:
   ```bash
   git switch -c release/X.Y vX.Y.Z
   git push -u origin release/X.Y
   ```
2. Fix on a branch from `release/X.Y`. Write the fix there, or cherry-pick it if it already exists on `main`:
   ```bash
   git switch -c task-<id>-<slug> origin/release/X.Y
   git cherry-pick -x <sha-on-main>          # or write the fix
   ```
   Verify, open the PR **with base `release/X.Y`**, and squash-merge it.
3. Bump the version on a `release-prep-vX.Y.(Z+1)` branch from `release/X.Y`. PR it into `release/X.Y` and squash-merge.
4. Tag the squash commit on `release/X.Y`:
   ```bash
   git switch release/X.Y && git pull --ff-only
   git tag -a vX.Y.(Z+1) -m "vX.Y.(Z+1)" "$(git rev-parse HEAD)"
   git push origin vX.Y.(Z+1)
   gh release create vX.Y.(Z+1) --verify-tag --title "vX.Y.(Z+1)" --notes-file /path/to/notes.md --latest=false
   ```
   Use `--latest=false` when a newer minor release already exists.
5. Forward-port the fix to `main` the same day if it did not start there. Bring only the fix, not the version bump:
   ```bash
   git switch -c task-<id>-<slug>-main origin/main
   git cherry-pick -x <fix-squash-sha-on-release>
   ```
   Open the PR into `main` and squash-merge. Keep the backlog task In Progress until both PRs are merged.

Squash merging means `release/X.Y` and `main` never share these commits. The same fix exists as two different commits; that is expected.

To avoid divergence:
- Every fix lands on both lines.
- Prefer fixing on `main` first and cherry-picking to `release/X.Y`.
- `cherry-pick -x` records the source SHA. Check with `git log origin/main --grep "cherry picked from"`.
- Never merge `release/X.Y` into `main`.

### When NOT to use a release branch

- `main` has nothing you would not ship. Release the patch from `main` (Case 1).
- The change is a feature or anything that is not a fix for a released bug.
- To prepare a minor or major release. Those are always cut from `main`.
- Keep at most the latest minor line patched. Older `release/*` branches stay frozen.
