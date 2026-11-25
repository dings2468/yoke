#!/bin/bash
# Starts a non-root sshd (empty password, no authentication; sandbox only) and keeps the container alive.
# No key material is baked into the image; host keys are generated fresh on every start.
set -eu

SSHD_DIR="$HOME/.sshd"
mkdir -p "$SSHD_DIR"
chmod 700 "$SSHD_DIR"

# Fresh host keys per container start.
rm -f "$SSHD_DIR"/ssh_host_*
ssh-keygen -q -t ed25519 -N '' -f "$SSHD_DIR/ssh_host_ed25519_key"
echo "sandbox-ssh: host key fingerprint:"
ssh-keygen -l -f "$SSHD_DIR/ssh_host_ed25519_key.pub"

/usr/sbin/sshd -f /opt/yoke/docker/sandbox/sshd_config -e
echo "sandbox-ssh: sshd listening on 2222 as $(id -un) (empty password, no authentication)"

# Keep PID 1 alive and stop sshd on container stop.
trap 'kill "$(cat "$SSHD_DIR/sshd.pid")" 2>/dev/null; exit 0' TERM INT
while :; do sleep 3600 & wait $!; done
