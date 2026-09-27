# How Strix is driven by `claude -p`

Read this when you need to explain, debug, or extend the bridge — not required
for a plain install (the scripts handle that).

## The mismatch

[Strix](https://github.com/usestrix/strix) (`strix-agent` on PyPI, Python ≥3.12)
is an autonomous pentester built on `openai-agents[litellm]`. Every step is
driven by **native OpenAI tool-calling**: each turn Strix sends the model a list
of `tools` and expects `tool_calls` back in OpenAI wire format, which it then
executes inside a Docker sandbox.

`claude -p` (the Claude Code CLI in print mode) has **no** such protocol, and
`claude-cli-runner` deliberately runs it with `--tools ""` so Claude cannot use
its *own* tools. So there are two gaps to close: Strix speaks the OpenAI HTTP
API, and it needs structured tool calls that `claude -p` does not natively emit.

## The bridge: an OpenAI-compatible shim + "prompted tool calling"

`claude-cli-runner`'s `examples/openai-server.mjs` exposes a real
OpenAI Chat Completions endpoint on `127.0.0.1:8801`:

- `GET  /health` → `{ok, version, mode, credential, model, spentToday}`
- `GET  /v1/models` → one placeholder model
- `POST /v1/chat/completions` → `chat.completion` (streaming and non-streaming)

Each request is translated by `src/openai.mjs` (pure, unit-tested, no I/O):

1. **Tools → system prompt.** The caller's `tools` are rendered as a catalogue
   in the system prompt, followed by a strict "response protocol".
2. **`--json-schema` forces an envelope.** Claude must answer with exactly one
   JSON object: `{"response_type": "message"|"tool_calls", "content": ...,
   "tool_calls": [{"name","arguments"}]}`. When no tools are offered, only
   `message` is allowed.
3. **Envelope → OpenAI `tool_calls`.** The envelope is translated back into the
   exact `tool_calls` wire shape and (for streaming) replayed as
   `chat.completion.chunk` SSE events, ending in `finish_reason: "tool_calls"`
   and `data: [DONE]`.

Claude only ever *names* a tool; **Strix executes it**. This is why `--tools ""`
stays intact — the injected prompt can name a tool but cannot invoke one. The
model's subscription login does the paying, not a metered API key.

## Three details that make or break it

- **The exposed model name must NOT contain "claude".** It is advertised as
  `strix-runner`. If it did contain "claude", Strix adds Anthropic-only request
  kwargs that the SDK's generic OpenAI client rejects. The *real* Claude model
  is chosen server-side by `SHIM_CLAUDE_MODEL` (default `sonnet`; `opus` for
  hard targets) and is invisible to Strix.
- **`STRIX_LLM=openai/strix-runner`.** The `openai/` prefix makes LiteLLM use
  its plain OpenAI client (and send `tool_choice=required`), which is exactly
  what the shim speaks. `OPENAI_BASE_URL` / `OPENAI_API_KEY` (any non-empty
  string on loopback) point it at the shim.
- **No token-by-token streaming.** `--json-schema` needs the whole reply before
  it can be parsed, so the shim calls `claude -p` once and *replays* the result
  as SSE. Strix does not care — it consumes whole tool calls, not partial text.

## Files (what lives where)

| File | Role | On GitHub? |
|---|---|---|
| `src/openai.mjs` | pure OpenAI↔envelope translation | **No — bundled in this skill** |
| `examples/openai-server.mjs` | the HTTP shim | **No — bundled** |
| `test/openai.test.mjs` | unit tests for the translation | **No — bundled** |
| `src/index.mjs` | adds the `openai.mjs` exports | modified — bundled full copy |
| `src/json.mjs` | adds the `signal` (abort) param to `spawnClaudeJson` | modified — bundled full copy |
| `src/{bin,args,env,stream,usage}.mjs` | runner support code | yes — from the base clone |
| `~/.local/bin/strix-claude` | launcher (starts shim, then `exec strix`) | bundled |
| `~/.strix/cli-config.json` | points Strix at the shim | bundled |

The base repo `elchanan003/claude-cli-runner` is frozen at its initial commit;
the bridge was never committed there, which is why the skill carries it.

## Auth notes

On a personal box the shim uses `credential: "inherited"` — your existing
interactive `claude` login. For a container or a fresh box with no interactive
login, run `claude setup-token` and export `CLAUDE_CODE_OAUTH_TOKEN` before
starting the shim.

## Where scan output goes

Non-interactive runs (`-n`) write to `~/strix_runs/<name>/`
(`findings.sarif`, `coverage.json`, `strix.log`, `run.json`) — **not** stdout
(stdout stalls on the banner). SARIF `results` with ruleId `strix-coverage/*`
are surface-coverage records, not vulnerabilities; real findings show as
`findings_filed` in `coverage.json`. A `~standard` scan costs ~13–14M
subscription tokens; watch spend via `GET /health` → `spentToday`.
