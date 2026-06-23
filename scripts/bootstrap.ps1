# One-line bootstrap for me.md on a fresh Windows machine.
#   irm https://raw.githubusercontent.com/RichardTheBruce/me-md/main/scripts/bootstrap.ps1 | iex
$ErrorActionPreference = "Stop"

Write-Host "==> bootstrapping me.md"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node not found. install Node 20+ first: https://nodejs.org"
  exit 1
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host "ollama not found. install it from https://ollama.com/download then rerun." -ForegroundColor Yellow
  exit 1
}

Write-Host "==> installing me.md globally from github"
npm install -g github:RichardTheBruce/me-md

Write-Host "==> booting (this will pull missing models on first run)"
me up --pull
