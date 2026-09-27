#!/usr/bin/env bash
# install.sh — stand up Strix driven by `claude -p` from scratch.
#
# Installs (or repairs) every piece of the bridge documented in SKILL.md:
#   1. prerequisites   git, curl, a Claude CLI login, uv, Node
#   2. claude-cli-runner  cloned from GitHub, then the bridge files overlaid
#   3. Strix           uv tool install strix-agent (Python 3.12)
#   4. launcher        ~/.local/bin/strix-claude
#   5. config          ~/.strix/cli-config.json  (points Strix at the shim)
#
# It is idempotent: re-running updates in place and never clobbers a customized
# config without backing it up first. Nothing here needs root.
#
# Knobs (env):
#   RUNNER_DIR         where claude-cli-runner lives   (default ~/claude-cli-runner)
#   RUNNER_REPO        base repo to clone              (default the URL below)
#   PORT               shim port                       (default 8801)
#   SHIM_CLAUDE_MODEL  real claude model the shim runs (default sonnet)
#   SKIP_NODE_INSTALL=1  don't auto-install Node via nvm, just fail if missing
#   SKIP_UV_INSTALL=1    don't auto-install uv, just fail if missing
set -euo pipefail

# --- locate the skill so we can copy the bundled bridge/launcher/config -------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETS="$SKILL_DIR/assets"

RUNNER_DIR="${RUNNER_DIR:-$HOME/claude-cli-runner}"
RUNNER_REPO="${RUNNER_REPO:-https://github.com/elchanan003/claude-cli-runner}"
PORT="${PORT:-8801}"
SHIM_CLAUDE_MODEL="${SHIM_CLAUDE_MODEL:-sonnet}"

say()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

# --- make nvm's node and ~/.local/bin reachable regardless of caller shell ----
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
export PATH="$HOME/.local/bin:$PATH"

# ---------------------------------------------------------------- 1. prereqs --
say "checking prerequisites"
command -v git  >/dev/null || die "git is required but not found"
command -v curl >/dev/null || die "curl is required but not found"
command -v claude >/dev/null || die "the 'claude' CLI is required and must be logged in (run 'claude' once, or 'claude setup-token')"

# uv (for Strix)
if ! command -v uv >/dev/null; then
  if [ "${SKIP_UV_INSTALL:-0}" = "1" ]; then
    die "uv not found and SKIP_UV_INSTALL=1"
  fi
  say "installing uv (astral)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  command -v uv >/dev/null || die "uv install did not put uv on PATH; open a new shell and re-run"
fi
say "uv: $(uv --version)"

# node (for the shim). The launcher also re-discovers nvm at runtime.
if ! command -v node >/dev/null; then
  if [ "${SKIP_NODE_INSTALL:-0}" = "1" ]; then
    die "node not found and SKIP_NODE_INSTALL=1"
  fi
  say "installing Node via nvm"
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
  [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
  command -v node >/dev/null || die "node install failed"
fi
say "node: $(node --version)  npm: $(npm --version)"

# ---------------------------------------------- 2. claude-cli-runner + bridge --
if [ -d "$RUNNER_DIR/.git" ]; then
  say "updating existing claude-cli-runner at $RUNNER_DIR"
  git -C "$RUNNER_DIR" fetch --quiet origin || warn "fetch failed (offline?), using local checkout"
  # Only fast-forward the base if the tree is clean, so we never trample the overlay.
  if git -C "$RUNNER_DIR" diff --quiet && git -C "$RUNNER_DIR" diff --cached --quiet; then
    git -C "$RUNNER_DIR" merge --ff-only origin/main --quiet 2>/dev/null || true
  fi
else
  say "cloning $RUNNER_REPO -> $RUNNER_DIR"
  git clone --quiet "$RUNNER_REPO" "$RUNNER_DIR"
fi

say "overlaying bridge files (the part that is NOT on GitHub)"
cp "$ASSETS/bridge/src/openai.mjs"            "$RUNNER_DIR/src/openai.mjs"
cp "$ASSETS/bridge/src/index.mjs"             "$RUNNER_DIR/src/index.mjs"
cp "$ASSETS/bridge/src/json.mjs"              "$RUNNER_DIR/src/json.mjs"
cp "$ASSETS/bridge/examples/openai-server.mjs" "$RUNNER_DIR/examples/openai-server.mjs"
mkdir -p "$RUNNER_DIR/test"
cp "$ASSETS/bridge/test/openai.test.mjs"      "$RUNNER_DIR/test/openai.test.mjs"

say "installing runner deps (npm install)"
( cd "$RUNNER_DIR" && npm install --silent --no-audit --no-fund )

say "running the bridge unit tests (pure translation, no model)"
( cd "$RUNNER_DIR" && node --test test/openai.test.mjs ) \
  || die "bridge unit tests failed — the overlay is broken, not proceeding"

# --------------------------------------------------------------- 3. Strix -----
if uv tool list 2>/dev/null | grep -q '^strix-agent'; then
  say "Strix already installed; upgrading"
  uv tool upgrade strix-agent >/dev/null 2>&1 || warn "strix upgrade skipped"
else
  say "installing Strix (uv tool install strix-agent --python 3.12)"
  uv tool install strix-agent --python 3.12
fi
command -v strix >/dev/null || export PATH="$HOME/.local/bin:$PATH"
command -v strix >/dev/null || die "strix not on PATH after install (expected ~/.local/bin/strix)"
say "strix: $(strix --version 2>&1 | head -1)"

# --------------------------------------------------------------- 4. launcher --
say "installing launcher ~/.local/bin/strix-claude"
mkdir -p "$HOME/.local/bin"
cp "$ASSETS/strix-claude" "$HOME/.local/bin/strix-claude"
chmod +x "$HOME/.local/bin/strix-claude"

# ---------------------------------------------------------------- 5. config ---
STRIX_CFG="$HOME/.strix/cli-config.json"
mkdir -p "$HOME/.strix"
if [ -f "$STRIX_CFG" ] && ! cmp -s "$ASSETS/config/cli-config.json" "$STRIX_CFG"; then
  BAK="$STRIX_CFG.bak.$(date +%Y%m%d-%H%M%S)"
  warn "existing $STRIX_CFG differs — backing up to $BAK"
  cp "$STRIX_CFG" "$BAK"
fi
cp "$ASSETS/config/cli-config.json" "$STRIX_CFG"
say "wrote $STRIX_CFG (STRIX_LLM=openai/strix-runner -> http://127.0.0.1:$PORT/v1)"

say "done. Verify with:  bash \"$SCRIPT_DIR/verify.sh\""
say "then run a scan with: strix-claude -t <your-target-url> -n"
