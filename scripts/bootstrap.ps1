# One-line bootstrap for me.md on a fresh Windows machine.
#   irm https://raw.githubusercontent.com/RichardTheBruce/me-md/main/scripts/bootstrap.ps1 | iex
$ErrorActionPreference = "Stop"

Write-Host "==> bootstrapping me.md"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node not found. install Node 20+ first: https://nodejs.org"
  exit 1
}

Write-Host "==> installing me.md globally from github"
npm install -g github:RichardTheBruce/me-md

# 'me up' is turnkey: on first run it stands up the local engine (installing it
# if needed) and sizes one uncensored model to this machine, then opens the
# prompt. Nothing else to install by hand.
Write-Host "==> booting (first run sets up the engine + pulls your model)"
me up
