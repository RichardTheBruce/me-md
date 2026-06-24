#!/usr/bin/env bash
# One-line bootstrap for me.md on a fresh machine (macOS / Linux).
#   curl -fsSL https://raw.githubusercontent.com/RichardTheBruce/me-md/main/scripts/bootstrap.sh | bash
set -euo pipefail

echo "==> bootstrapping me.md"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. install Node 20+ first: https://nodejs.org" >&2
  exit 1
fi

echo "==> installing me.md globally from github"
npm install -g github:RichardTheBruce/me-md

# 'me up' is turnkey: on first run it stands up the local engine (installing it
# if needed) and sizes one uncensored model to this machine, then opens the
# prompt. Nothing else to install by hand.
echo "==> booting (first run sets up the engine + pulls your model)"
exec me up
