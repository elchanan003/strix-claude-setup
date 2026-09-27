#!/usr/bin/env bash
# verify.sh — prove the claude -p bridge is healthy and that Strix's one
# non-negotiable capability, native tool-calling, survives the round-trip.
#
# It is deliberately cheap: two small chat/completions calls (a few thousand
# tokens), not a live pentest. A real scan is opt-in — pass --live-scan <url>
# to run one against a target you own.
#
#   bash verify.sh                     # health + tool_calls round-trip
#   bash verify.sh --live-scan http://target.example   # + a real Strix scan
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="${RUNNER_DIR:-$HOME/claude-cli-runner}"
PORT="${PORT:-8801}"
SHIM_CLAUDE_MODEL="${SHIM_CLAUDE_MODEL:-sonnet}"
BASE="http://127.0.0.1:$PORT"

LIVE_SCAN=""
[ "${1:-}" = "--live-scan" ] && LIVE_SCAN="${2:-}"

pass=0; fail=0
ok()   { printf '\033[1;32m  PASS\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '\033[1;31m  FAIL\033[0m %s\n' "$*"; fail=$((fail+1)); }
say()  { printf '\033[1;36m[verify]\033[0m %s\n' "$*"; }

NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
export PATH="$HOME/.local/bin:$PATH"

# --- 0. bridge unit tests (pure translation, no model, no network) -----------
say "bridge unit tests"
if ( cd "$RUNNER_DIR" && node --test test/openai.test.mjs ) >/tmp/strix-verify-unit.log 2>&1; then
  ok "openai.test.mjs green"
else
  bad "openai.test.mjs failed — see /tmp/strix-verify-unit.log"
fi

# --- 1. make sure the shim is listening (start it if not) --------------------
started_shim=""
if curl -sf "$BASE/health" >/dev/null 2>&1; then
  say "shim already up on :$PORT"
else
  say "starting shim on :$PORT (model $SHIM_CLAUDE_MODEL)"
  RUNNER_MODE=personal BIND=127.0.0.1 PORT="$PORT" SHIM_CLAUDE_MODEL="$SHIM_CLAUDE_MODEL" \
    nohup node "$RUNNER_DIR/examples/openai-server.mjs" >/tmp/strix-verify-shim.log 2>&1 &
  started_shim=$!
  for _ in $(seq 1 40); do curl -sf "$BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
fi

cleanup() { [ -n "$started_shim" ] && kill "$started_shim" 2>/dev/null || true; }
trap cleanup EXIT

# --- 2. /health --------------------------------------------------------------
say "GET /health"
HEALTH="$(curl -sf "$BASE/health" 2>/dev/null || true)"
if printf '%s' "$HEALTH" | grep -q '"ok":true'; then
  ok "health ok ($(printf '%s' "$HEALTH" | grep -o '"version":"[^"]*"'))"
else
  bad "no healthy shim on :$PORT — see /tmp/strix-verify-shim.log"; echo; say "$pass passed, $fail failed"; exit 1
fi

# --- 3. exposed model must NOT be named 'claude' (Strix kwargs trap) ----------
say "GET /v1/models"
MODELS="$(curl -sf "$BASE/v1/models" 2>/dev/null || true)"
MODEL_ID="$(printf '%s' "$MODELS" | grep -o '"id":"[^"]*"' | head -1)"
if printf '%s' "$MODEL_ID" | grep -qi 'claude'; then
  bad "exposed model id contains 'claude' ($MODEL_ID) — Strix will add Anthropic-only kwargs the OpenAI client rejects"
else
  ok "exposed model id is a neutral placeholder ($MODEL_ID)"
fi

# --- 4. NON-STREAMING tool call: the capability Strix lives or dies on --------
# Force a tool call and check the OpenAI tool_calls shape comes back intact.
read -r -d '' REQ <<'JSON'
{"model":"strix-runner","tool_choice":"required","tools":[
 {"type":"function","function":{"name":"run_terminal_cmd","description":"Run a shell command in the sandbox",
  "parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}],
 "messages":[{"role":"system","content":"You are a pentest agent."},
             {"role":"user","content":"List the files in the current directory using the terminal tool."}]}
JSON
# Each check is one live claude -p turn, so an occasional turn stalls or comes
# back empty. That is a flaky model turn, not a broken bridge — retry a few
# times before calling it a failure. No -f, so real HTTP errors reach the log.
say "POST /v1/chat/completions (non-streaming, tool_choice=required)"
nonstream_ok=""
for attempt in 1 2 3; do
  RESP="$(curl -s "$BASE/v1/chat/completions" -H 'content-type: application/json' -d "$REQ" 2>/dev/null || true)"
  printf '%s' "$RESP" >/tmp/strix-verify-nonstream.json
  if printf '%s' "$RESP" | grep -q '"tool_calls"' \
     && printf '%s' "$RESP" | grep -q '"name":"run_terminal_cmd"' \
     && printf '%s' "$RESP" | grep -q '"finish_reason":"tool_calls"'; then
    nonstream_ok=1; break
  fi
  say "  non-streaming attempt $attempt did not match; retrying"
  sleep 2
done
if [ -n "$nonstream_ok" ]; then
  ok "non-streaming returned a well-formed tool_call for run_terminal_cmd"
else
  bad "non-streaming did not return the expected tool_call after 3 tries — see /tmp/strix-verify-nonstream.json"
fi

# --- 5. STREAMING tool call: same, over SSE (this is the path Strix uses) -----
say "POST /v1/chat/completions (streaming SSE, tool_choice=required)"
SREQ="${REQ/\"model\":\"strix-runner\"/\"model\":\"strix-runner\",\"stream\":true}"
stream_ok=""
for attempt in 1 2 3; do
  SRESP="$(curl -s -N "$BASE/v1/chat/completions" -H 'content-type: application/json' -d "$SREQ" 2>/dev/null || true)"
  printf '%s' "$SRESP" >/tmp/strix-verify-stream.sse
  if printf '%s' "$SRESP" | grep -q 'chat.completion.chunk' \
     && printf '%s' "$SRESP" | grep -q '"tool_calls"' \
     && printf '%s' "$SRESP" | grep -q '"finish_reason":"tool_calls"' \
     && printf '%s' "$SRESP" | grep -q 'data: \[DONE\]'; then
    stream_ok=1; break
  fi
  say "  streaming attempt $attempt did not match; retrying"
  sleep 2
done
if [ -n "$stream_ok" ]; then
  ok "streaming SSE carried the tool_call deltas + [DONE]"
else
  bad "streaming SSE malformed after 3 tries — see /tmp/strix-verify-stream.sse"
fi

# --- 6. Strix side: binary present and pointed at the shim --------------------
say "Strix install + config"
if command -v strix >/dev/null; then
  ok "strix on PATH ($(strix --version 2>&1 | head -1))"
else
  bad "strix not on PATH"
fi
CFG="$HOME/.strix/cli-config.json"
if grep -q 'openai/strix-runner' "$CFG" 2>/dev/null \
   && grep -q "127.0.0.1:$PORT/v1" "$CFG" 2>/dev/null; then
  ok "~/.strix/cli-config.json points Strix at the shim"
else
  bad "~/.strix/cli-config.json is not wired to the shim on :$PORT"
fi
if [ -x "$HOME/.local/bin/strix-claude" ]; then
  ok "launcher ~/.local/bin/strix-claude present"
else
  bad "launcher ~/.local/bin/strix-claude missing or not executable"
fi

# --- 7. optional: a real scan against a target you own -----------------------
if [ -n "$LIVE_SCAN" ]; then
  say "LIVE SCAN against $LIVE_SCAN (this costs real subscription tokens and takes a while)"
  say "output lands in ~/strix_runs/<name>/ ; streaming banner on stdout is normal"
  strix-claude -t "$LIVE_SCAN" -n -m standard || bad "live scan exited non-zero"
fi

echo
say "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
