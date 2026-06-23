#!/usr/bin/env bash
# One-line bootstrap for me.md on a fresh machine (macOS / Linux).
#   curl -fsSL https://raw.githubusercontent.com/RichardTheBruce/me-md/main/scripts/bootstrap.sh | bash
set -euo pipefail

echo "==> bootstrapping me.md"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. install Node 20+ first: https://nodejs.org" >&2
  exit 1
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "==> installing ollama"
  curl -fsSL https://ollama.com/install.sh | sh
fi

echo "==> installing me.md globally from github"
npm install -g github:RichardTheBruce/me-md

echo "==> booting (this will pull missing models on first run)"
exec me up --pull
