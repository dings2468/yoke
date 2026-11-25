#!/usr/bin/env bash
# Install the Backlog.md CLI globally (idempotent). Run by postCreateCommand.
set -eu

if command -v backlog >/dev/null 2>&1; then
  echo "backlog already installed: $(backlog --version)"
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "install-backlog: npm not found on PATH (node feature missing?)" >&2
  exit 1
fi

prefix="$(npm config get prefix)"
if [ ! -w "$prefix/lib/node_modules" ] && [ ! -w "$prefix" ]; then
  echo "install-backlog: npm global prefix $prefix is not writable by $(id -un); not using sudo" >&2
  exit 1
fi

npm i -g backlog.md@1.57.4
echo "backlog installed: $(backlog --version)"
