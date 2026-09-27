---
name: strix-claude-setup
description: >-
  Install and wire up the Strix autonomous pentester so it runs on a personal
  Claude subscription through `claude -p` instead of a metered Anthropic API
  key, using the claude-cli-runner OpenAI-compatible bridge. Use this whenever
  the user wants to install, set up, deploy, reinstall, repair, or verify Strix
  (usestrix / strix-agent) on this or a fresh machine; connect Strix, an
  openai-agents / LiteLLM pentest agent, or any OpenAI-tool-calling client to
  `claude -p`; stand up the `strix-claude` launcher or the OpenAI shim on
  :8801; or confirm that Strix's tool-calling still works after a change. Also
  triggers on "run Strix without an API key", "Strix on my Claude Max/Pro
  subscription", "point Strix at claude", or "the strix-claude bridge".
---

# Strix on `claude -p`

This skill installs [Strix](https://github.com/usestrix/strix) (the autonomous
pentester) and connects it to Claude through `claude -p` — so it runs on a
personal Claude subscription login rather than a metered API key — then verifies
the connection without burning a full scan.

It carries the piece that makes this work: the **claude-cli-runner OpenAI shim +
prompted-tool-calling bridge**, which is *not* published on GitHub. The base
runner is cloned from GitHub; the bridge files are overlaid from this skill's
`assets/`.

## When to use it

Installing/repairing Strix, wiring Strix (or any openai-agents/LiteLLM client)
to `claude -p`, standing up the `:8801` shim or the `strix-claude` launcher, or
checking that tool-calling survived a change. If you only need to understand how
the bridge works, read `references/architecture.md` and stop there.

## What "connected" means here

Strix demands **native OpenAI tool-calling**; `claude -p` has none and the
runner keeps Claude's own tools off (`--tools ""`). The bridge closes the gap
with *prompted tool calling*: the caller's tools go into the system prompt,
`--json-schema` forces Claude to answer with a `{response_type, content,
tool_calls}` envelope, and the shim translates that back into OpenAI
`tool_calls`. **Claude only names a tool; Strix runs it.** Full detail lives in
`references/architecture.md` — read it before changing the bridge or explaining
it.

## Install (from scratch)

Run the installer. It is idempotent and needs no root:

```bash
bash scripts/install.sh
```

It performs, in order:

1. **Prerequisites** — checks `git`, `curl`, and a logged-in `claude` CLI;
   auto-installs `uv` and Node (via nvm) if missing. Set `SKIP_UV_INSTALL=1` or
   `SKIP_NODE_INSTALL=1` to fail instead of auto-installing.
2. **Runner + bridge** — clones `elchanan003/claude-cli-runner` into
   `~/claude-cli-runner`, overlays the bundled bridge files, `npm install`, then
   runs the bridge **unit tests** and aborts if they fail.
3. **Strix** — `uv tool install strix-agent --python 3.12` (upgrades if already
   present); binary lands at `~/.local/bin/strix`.
4. **Launcher** — installs `~/.local/bin/strix-claude`.
5. **Config** — writes `~/.strix/cli-config.json` (backs up any existing one
   that differs) pointing Strix at `http://127.0.0.1:8801/v1` as
   `openai/strix-runner`.

Useful knobs (env): `RUNNER_DIR`, `PORT` (default 8801), `SHIM_CLAUDE_MODEL`
(default `sonnet`, use `opus` for hard targets).

> Container / fresh box with no interactive login: run `claude setup-token`
> and export `CLAUDE_CODE_OAUTH_TOKEN` before starting the shim — see
> `references/architecture.md`.

## Verify (cheap — proves capabilities are intact)

```bash
bash scripts/verify.sh
```

This is deliberately light (a few thousand tokens, no pentest). It checks:

- bridge **unit tests** pass;
- the shim answers `/health`;
- the exposed model id is a neutral placeholder (**not** containing "claude" —
  the name that would break Strix's OpenAI client);
- a forced tool call round-trips **non-streaming** as a well-formed
  `run_terminal_cmd` `tool_call` with `finish_reason: "tool_calls"`;
- the same round-trips over **streaming SSE** (the path Strix actually uses),
  ending in `[DONE]`;
- Strix is installed and `~/.strix/cli-config.json` + the launcher point at the
  shim.

Tool-calling is the one capability Strix cannot function without, so a green
verify is the evidence that the bridge did not degrade it. Report the
PASS/FAIL summary to the user; on any FAIL, read the referenced
`/tmp/strix-verify-*` log and follow **Troubleshooting** below.

### Optional: a real scan (opt-in, expensive)

Only against a target the user owns, and only if they ask — a `~standard` scan
costs ~13–14M subscription tokens and runs for a while:

```bash
bash scripts/verify.sh --live-scan http://target-you-own.example
# or directly:
strix-claude -t http://target-you-own.example -n -m standard
```

Output lands in `~/strix_runs/<name>/` (`findings.sarif`, `coverage.json`,
`strix.log`), **not** stdout. Real findings appear as `findings_filed` in
`coverage.json`; `strix-coverage/*` SARIF rules are surface coverage, not vulns.
Watch spend via `GET /health` → `spentToday`.

## Everyday use, once installed

```bash
strix-claude -t http://target.example -n     # starts the shim if needed, then Strix
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `strix` warns `strix-runner` isn't a recommended model | Expected — the real model is hidden behind the bridge. Harmless; the run continues. |
| Shim won't start | Node not found. Re-run `install.sh`, or ensure nvm's node is on PATH (the launcher re-discovers it). Check `/tmp/strix-verify-shim.log`. |
| `Not logged in` / `credential: "inherited"` warning in a container | Run `claude setup-token`, export `CLAUDE_CODE_OAUTH_TOKEN`, restart the shim. |
| Strix errors about unexpected request kwargs | The exposed model id contains "claude". Keep `SHIM_MODEL_ID=strix-runner`; never name it with "claude". |
| Verify's tool_call checks fail | The bridge overlay is wrong or Claude returned prose. Inspect `/tmp/strix-verify-nonstream.json`; re-run `install.sh` to restore the overlay. |
| Checking if a scan is still alive | Use the PID from `ps`, not a loose `pgrep bin/strix` (gives false negatives mid-run). |

## Bundled resources

- `scripts/install.sh` — the from-scratch installer described above.
- `scripts/verify.sh` — the cheap health + tool-calling check (`--live-scan` opt-in).
- `assets/bridge/` — the OpenAI shim + translation files overlaid onto the base
  runner (`src/openai.mjs`, `examples/openai-server.mjs`, `test/openai.test.mjs`,
  plus modified `src/index.mjs` and `src/json.mjs`).
- `assets/strix-claude` — the launcher.
- `assets/config/cli-config.json` — the `~/.strix` config template.
- `references/architecture.md` — deep explanation of the bridge; read before
  changing or explaining it.
