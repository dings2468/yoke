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
| Backlog task | `task-<id>-<slug>`, e.g. `task-1-empty-json-config` | `main` |
| Small change without a task (typo, docs) | `<type>/<slug>`, e.g. `docs/readme-typo` | `main` |
| Release preparation | `release-prep-vX.Y.Z` | `main` or `release/X.Y` |
| Patch line (maintainer only) | `release/X.Y`, e.g. `release/0.1` | tag `vX.Y.Z` |
| Fix for a patch line | `task-<id>-<slug>` | `release/X.Y` |
| Forward-port of that fix | `task-<id>-<slug>-main` | `main` |

Never open a PR *from* `release/X.Y`. Always use a separate branch.

## Commit messages and PR titles

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, imperative and lower case, no trailing period.

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
- Common scopes: `schema`, `scopes`, `fs-safe`, `plan`, `drift`, `instructions`, `claude`, `agy`, `init`, `sync`, `doctor`, `cli`, `spec`, `agents`, `backlog`, `sandbox`, `release`.
- Do not use `chore(merge)`. Squash merging replaces merge commits.

PRs are **squash-merged**. The **PR title becomes the commit subject** on `main` (GitHub appends ` (#N)`), and the PR description becomes the commit body. Write the title as a final commit subject. Commits inside the branch can be informal.

The squash commit is authored by the PR author (GitHub uses the PR author), so the author credit is automatic. Do not add a trailer for it. To credit a real human co-author, add a GitHub `Co-authored-by: Name <id+username@users.noreply.github.com>` line to the PR description, one line per person, using their real GitHub noreply email. Do not put model or tool attribution (for example Claude or Haiku `Co-Authored-By` trailers) in PR descriptions or squash commit messages. These are not GitHub accounts, and GitHub would record them as co-authors on `main`.

## Pull requests

- One topic per PR; keep it small and short-lived. Rebase on `main` if it falls behind (`git fetch origin && git rebase origin/main`).
- Link the backlog task in the description (`TASK-<id>`).
- Every adapter change includes fixture-based vitest tests (see AGENTS.md).

## Verification checklist (every PR)

```bash
npm run typecheck
npm test
npm run check        # npm run check:fix applies fixes
```

All three must pass before review.

## Planning work with Backlog.md

Tasks live in `backlog/`. Use the `backlog` CLI; do not edit task files by hand.
A milestone is a release version (milestone `v0.2` ships as `v0.2.0`).

```bash
backlog milestone list
backlog milestone add "v0.3" -d "Goals of v0.3"          # maintainer: one per planned release
backlog task create "Title" -d "Context" --type bug --ac "Criterion" -m v0.3
backlog task list -m v0.3 --plain
backlog task edit TASK-<id> -s "In Progress"             # when work starts, on the task branch
backlog task edit TASK-<id> -s Done --final-summary "What changed"   # in the same PR that finishes it
```

Task file changes are committed on the task branch with the code.

## Milestone flow (maintainer only)

1. **Plan**: create the milestone and its tasks (above). Each task has acceptance criteria and, for bugs, a reproduction.
2. **Implement**: one branch and PR per task. Verification passes in each PR. The task is set to Done in its PR.
3. **Finish**: `backlog task list -m vX.Y --plain` shows everything Done, or the leftover tasks are moved to the next milestone (`backlog task edit TASK-<id> -m vX.Z`).
4. **Release**: follow the release checklist below.
5. **Close**: `backlog milestone archive vX.Y`.

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
3. Run the verification checklist, then the manual sandbox checklist:
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
