# Clean, disposable v0.1 sandbox for yoke. Build and run from the repo root:
#   npm run sandbox:build && npm run sandbox
#   (SSH access, no authentication: npm run sandbox:ssh; sshd is installed but only started by that command.)
# The container runs as a non-root user with an isolated, empty HOME. No host paths are mounted,
# so the host's ~/.claude.json and ~/.gemini are never read or written. Nothing is seeded.
FROM node:22-bookworm-slim

# Set to 0 to skip the real Claude Code CLI (then `claude --version` is not found).
ARG INSTALL_CLAUDE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl bash less procps openssh-server \
 && rm -rf /var/lib/apt/lists/*

# Real Claude Code CLI, so yoke's detection and drift checks run against the real harness.
RUN if [ "$INSTALL_CLAUDE" = "1" ]; then npm install -g @anthropic-ai/claude-code; fi

# STUB agy: Antigravity's CLI is not available in this image. The stub only answers `--version`
# so yoke's detection path can be exercised. It is NOT the real agy.
COPY docker/sandbox/stubs/agy /usr/local/bin/agy
RUN chmod 0755 /usr/local/bin/agy

# Build yoke from the build context. Dependencies are installed first so source edits reuse the layer.
WORKDIR /opt/yoke
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
 && printf '#!/bin/sh\nexec node /opt/yoke/dist/cli.js "$@"\n' > /usr/local/bin/yoke \
 && chmod 0755 /usr/local/bin/yoke

# Non-root user with an isolated HOME. The node image already ships uid 1000 as `node`; use a separate `tester`.
# The empty work directory is created as root and chowned to tester; no git repo is created.
# SANDBOX ONLY: `tester` has an EMPTY password (sshd accepts it, see sshd_config). `passwd -d` also unlocks the
# default `!` hash. tester joins `shadow` so the non-root sshd can read its own (empty) shadow entry.
RUN useradd --create-home --shell /bin/bash --uid 1001 tester \
 && passwd -d tester \
 && usermod -aG shadow tester \
 && mkdir -p /home/tester/work /run/sshd \
 && chown tester:tester /home/tester/work \
 && chmod 0755 /run/sshd /opt/yoke/docker/sandbox/ssh-entrypoint.sh \
 && rm -f /etc/ssh/ssh_host_*
USER tester
ENV HOME=/home/tester \
    XDG_CONFIG_HOME=/home/tester/.config \
    TERM=xterm-256color
WORKDIR /home/tester/work

CMD ["bash", "-l"]
