# strix-claude-setup

A Claude Code **skill** that installs the [Strix](https://github.com/usestrix/strix)
autonomous pentester and wires it to run on a personal **Claude subscription**
through `claude -p` — instead of a metered Anthropic API key — then verifies the
connection without burning a full scan.

It carries the piece that makes this work: the **claude-cli-runner
OpenAI-compatible shim + prompted-tool-calling bridge**, which is not published
in the base runner repo. The base runner is cloned from GitHub; the bridge files
are overlaid from this skill's `assets/`.

## What it does

Strix demands **native OpenAI tool-calling**; `claude -p` has none, and the
runner keeps Claude's own tools off (`--tools ""`). The bridge closes the gap
with *prompted tool calling*: the caller's tools go into the system prompt,
`--json-schema` forces Claude to answer with a `{response_type, content,
tool_calls}` envelope, and the shim translates that back into OpenAI
`tool_calls`. **Claude only names a tool; Strix runs it.** Full detail in
[`references/architecture.md`](references/architecture.md).

## Install as a skill

Clone into your Claude Code skills directory, then invoke it from a session:

```bash
git clone https://github.com/elchanan003/strix-claude-setup \
  ~/.claude/skills/strix-claude-setup
```

Then in Claude Code, ask to "install Strix on my Claude subscription" (or run
the scripts directly).

## Or run the scripts directly

```bash
bash scripts/install.sh    # clone runner + overlay bridge + install Strix + launcher + config
bash scripts/verify.sh     # cheap health + tool-calling round-trip (8 checks)
strix-claude -t http://target-you-own.example -n    # everyday use
```

`install.sh` is idempotent and needs no root. Knobs: `RUNNER_DIR`, `PORT`
(default 8801), `SHIM_CLAUDE_MODEL` (default `sonnet`, use `opus` for hard
targets). See [`SKILL.md`](SKILL.md) for the full workflow and troubleshooting.

## Requirements

- A logged-in `claude` CLI (`claude`, or `claude setup-token` +
  `CLAUDE_CODE_OAUTH_TOKEN` for a container)
- `git`, `curl` (the installer auto-installs `uv` and Node via nvm if missing)

## Layout

| Path | Role |
|---|---|
| `SKILL.md` | the skill (frontmatter + workflow) |
| `scripts/install.sh` | from-scratch installer |
| `scripts/verify.sh` | cheap health + tool-calling verifier (`--live-scan <url>` opt-in) |
| `assets/bridge/` | the OpenAI shim + translation overlaid onto the base runner |
| `assets/strix-claude` | the launcher |
| `assets/config/cli-config.json` | the `~/.strix` config template |
| `references/architecture.md` | deep explanation of the bridge |
