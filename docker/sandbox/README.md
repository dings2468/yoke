# yoke v0.1 sandbox

A clean, disposable container for using yoke freely with different harnesses, without touching your real `~/.claude.json`, `~/.gemini/`, or `~/.config/yoke/`. Nothing is seeded: no prepared settings, no demo project, no scenarios.

## Run

From the repo root (inside the devcontainer, which has docker-in-docker enabled):

```bash
npm run sandbox:build   # builds the yoke-sandbox image from this checkout
npm run sandbox         # opens an interactive bash login shell in a fresh container
```

Each `npm run sandbox` starts from a clean image, and `--rm` deletes the container on exit.

## What is installed

- `yoke` on PATH, built from this checkout (`/opt/yoke/dist/cli.js`).
- The real Claude Code CLI (`claude`), installed unpinned (`npm install -g @anthropic-ai/claude-code`), so the version tracks latest at build time. To skip it, build with `npm run sandbox:build -- --build-arg INSTALL_CLAUDE=0`.
- A **stub** `agy` (`stubs/agy`) that only answers `--version`, so yoke's agy detection path runs. It is not the real Antigravity CLI, and any other invocation fails on purpose.
- `git`, `curl`, `bash`, `less`, `procps`.
- User `tester` (uid 1001, non-root) with `HOME=/home/tester`. No host paths are mounted.

## Open in VS Code

The sandbox workspace is `/home/tester/work`. It starts empty, and files yoke writes there show up in VS Code's explorer. No extensions or settings are preinstalled, and the host repo is not mounted. VS Code downloads its server into the container at attach time, so the container needs network access.

If you are already inside a devcontainer (for example this repo's own, which has docker-in-docker), attach to a running sandbox instead of reopening:

1. In a terminal in your current devcontainer, start a persistent sandbox. The image has no ENTRYPOINT and its CMD is `bash -l`, so `sleep infinity` keeps it running:

   ```bash
   docker run -d --name yoke-sandbox yoke-sandbox sleep infinity
   ```

2. In VS Code, run "Dev Containers: Attach to Running Container..." and pick `yoke-sandbox`. A new window opens.
3. In the new window, open the folder `/home/tester/work`.
4. When done, clean up from the same terminal:

   ```bash
   docker rm -f yoke-sandbox
   ```

This attach flow does not use the anonymous volume. `~/work` is just the image's directory and is removed together with the container by `docker rm -f`.

We have not verified the VS Code attach flow locally.

Alternative, from a VS Code window that is NOT already in a devcontainer (host side): run "Dev Containers: Reopen in Container" and choose "yoke sandbox" (`.devcontainer/sandbox/devcontainer.json`). Here the workspace is an anonymous volume at `/home/tester/work`. Do not do this from inside your current devcontainer: it replaces that window's container.

## SSH access (Remote-SSH)

For when you cannot attach VS Code to the inner container. **There is no authentication.** The `tester` account has an empty password and sshd accepts it. This is acceptable only because the sandbox adds no trust boundary: sshd is published solely on the devcontainer's loopback (127.0.0.1), and the devcontainer already runs docker-in-docker, so anyone who can reach that port can already control Docker. It is the same trust domain as the devcontainer. Do not publish port 2222 on any non-loopback address, do not forward it to a shared or public interface, and do not reuse this image anywhere else. No root login, no PAM, and nothing secret is baked into the image.

1. `npm run sandbox:build`
2. `npm run sandbox:ssh`
3. In VS Code, make sure devcontainer port 2222 is forwarded (Ports panel: forward port 2222), bound to localhost only.
4. On your HOST, add to `~/.ssh/config`:

   ```
   Host yoke-sandbox
     HostName localhost
     Port 2222
     User tester
     PreferredAuthentications password
     PubkeyAuthentication no
     NumberOfPasswordPrompts 1
     StrictHostKeyChecking accept-new
     UserKnownHostsFile ~/.ssh/known_hosts.yoke-sandbox
   ```

5. `ssh yoke-sandbox` asks for a password. Press Enter (empty password). VS Code: "Remote-SSH: Connect to Host..." and choose `yoke-sandbox`. It shows the same password prompt, so press Enter again. Then run `claude`, `agy` (stub) and `yoke` in the integrated terminal.
6. Stop with `npm run sandbox:ssh:stop`. The container is removed, so its state is lost.

Host keys are regenerated on every start, so the fingerprint changes each time. Clear the dedicated known_hosts file (or remove that host's line) after a restart. `docker logs yoke-sandbox-ssh` shows the fingerprint and any errors.
Only port 2222 is published, and only on the devcontainer's loopback (127.0.0.1).

## Starting state

- `HOME` is empty: no `~/.claude.json`, no `~/.claude/`, no `~/.config/yoke/`.
- You start in `~/work`, an empty directory. It is not a git repo. yoke's project scope expects one, so run `git init` yourself first.
- Nothing is seeded and there is no startup banner.

## Logging in to Claude

Run `claude` and follow its interactive login flow. This needs network access. Credentials land in the container's own `~/.claude*` files and disappear with the container (see below to keep them). Alternatively export `ANTHROPIC_API_KEY` in the shell.

## Things to try

```bash
git init
yoke --help
yoke init --dry-run
yoke init
yoke sync --dry-run
yoke sync
yoke doctor
```

Use `--import-from claude` with `yoke init` once Claude has some config worth importing. `${VAR}` references in generated files stay unexpanded.

## Keeping state between runs

Containers are ephemeral. To keep a session (HOME, login, work directory), stop removing the container and reuse it:

```bash
docker run -it --name yoke-sb yoke-sandbox   # first run
docker start -ai yoke-sb                     # later runs, same HOME
docker rm -f yoke-sb                         # discard
```

## Files

- `Dockerfile`: image definition. Build context is the repo root (see `/.dockerignore`).
- `stubs/agy`: the agy `--version` stub.
