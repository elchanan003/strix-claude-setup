#!/usr/bin/env node
/**
 * An OpenAI-compatible Chat Completions endpoint backed by `claude -p`.
 *
 * Built so an OpenAI-Agents / LiteLLM client — Strix, specifically — can drive
 * Claude through the CLI, tool calls and all, using its personal subscription
 * login instead of a metered API key. See src/openai.mjs for how the tool
 * protocol is bridged, and README.md ("Driving Strix") for the wiring.
 *
 *   GET  /health              -> {ok, version, mode, credential, model}
 *   GET  /v1/models           -> the one placeholder model this exposes
 *   POST /v1/chat/completions -> OpenAI chat.completion, streaming or not
 *
 * Run (single operator, loopback — what Strix on the same box needs):
 *   RUNNER_MODE=personal node examples/openai-server.mjs
 */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  preflight,
  assertRunnerConfig,
  detectCredential,
  spawnClaudeJson,
  totalTokens,
  summarizeUsage,
  summarizeRateLimit,
  RunnerConfigError,
  ClaudeBinaryError,
  flattenMessages,
  buildSystemPrompt,
  buildStdinPrompt,
  buildEnvelopeSchema,
  toChatCompletion,
  toChatCompletionSSE,
  mapModel,
  requestShape
} from "../src/index.mjs";

const cfg = {
  mode: process.env.RUNNER_MODE,
  bind: process.env.BIND || "127.0.0.1",
  port: Number(process.env.PORT || 8801),
  allowRemote: process.env.RUNNER_ALLOW_REMOTE === "1",
  secretSha256: (process.env.RUNNER_SECRET_SHA256 || "").toLowerCase(),
  model: process.env.SHIM_CLAUDE_MODEL || "sonnet",
  modelId: process.env.SHIM_MODEL_ID || "strix-runner",
  timeoutMs: Number(process.env.SHIM_TIMEOUT_MS || 300_000),
  dailyTokenBudget: Number(process.env.DAILY_TOKEN_BUDGET || 0), // 0 = no budget
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 32_000_000)
};

// ------------------------------------------------------------------ startup
const credential = detectCredential();
try {
  assertRunnerConfig({
    mode: cfg.mode,
    bind: cfg.bind,
    allowRemote: cfg.allowRemote,
    hasSecret: Boolean(cfg.secretSha256),
    credential
  });
} catch (err) {
  if (err instanceof RunnerConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

let cliVersion;
try {
  cliVersion = preflight();
} catch (err) {
  if (err instanceof ClaudeBinaryError) {
    console.error(`\nRefusing to start: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

if (credential === "inherited") {
  console.warn(
    "No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY set — relying on this user's existing\n" +
      "interactive `claude` login. Fine on your own box; for a container run `claude setup-token`\n" +
      "and pass CLAUDE_CODE_OAUTH_TOKEN instead."
  );
}

let spentToday = 0;
let spentDay = new Date().toISOString().slice(0, 10);
function recordSpend(result) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== spentDay) {
    spentDay = day;
    spentToday = 0;
  }
  spentToday += totalTokens(result);
}
function budgetExhausted() {
  return cfg.dailyTokenBudget > 0 && spentToday >= cfg.dailyTokenBudget;
}

// ---------------------------------------------------------------- utilities
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function sameDigest(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > cfg.maxBodyBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * When a secret is configured, require it as a bearer token. Loopback personal
 * mode needs none (the config guard allows that); a secret is still honored if
 * set. Returns true when the request may proceed.
 */
function authorized(req) {
  if (!cfg.secretSha256) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
  if (!bearer) return false;
  return sameDigest(sha256(bearer), cfg.secretSha256);
}

// -------------------------------------------------------- chat/completions
async function handleChatCompletions(req, res, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) return sendJson(res, 400, { error: { message: "messages is required", type: "invalid_request_error" } });

  if (budgetExhausted()) {
    return sendJson(res, 429, { error: { message: "daily token budget exhausted", type: "rate_limit_error" } });
  }

  const { tools, hasTools, toolChoice } = requestShape(body);
  const { systemText, transcript } = flattenMessages(messages);
  const systemPrompt = buildSystemPrompt({ systemText, tools, toolChoice });
  const stdinPrompt = buildStdinPrompt(transcript);
  const jsonSchema = buildEnvelopeSchema({ hasTools });
  const model = mapModel(body?.model, cfg.model);
  const stream = Boolean(body?.stream);
  const includeUsage = Boolean(body?.stream_options?.include_usage);

  /* Kill the child if the client disconnects (rule #5). */
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  let result;
  try {
    result = await spawnClaudeJson({
      model,
      systemPrompt,
      stdinPrompt,
      jsonSchema,
      timeoutMs: cfg.timeoutMs,
      signal: ac.signal
    });
  } catch (err) {
    if (res.writableEnded) return; // client already gone
    return sendJson(res, 502, { error: { message: String(err?.message || err), type: "upstream_error" } });
  }

  recordSpend(result);
  console.log(
    `[chat] model ${model} · ${hasTools ? tools.length + " tools" : "no tools"} · choice ${JSON.stringify(toolChoice)} · ` +
      JSON.stringify(summarizeUsage(result))
  );
  if (result.is_error) {
    if (res.writableEnded) return;
    return sendJson(res, 502, { error: { message: String(result.result || "model error"), type: "upstream_error" } });
  }

  if (!stream) {
    if (res.writableEnded) return;
    return sendJson(res, 200, toChatCompletion(result, { model: cfg.modelId }));
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  for (const event of toChatCompletionSSE(result, { model: cfg.modelId, includeUsage })) {
    res.write(event);
  }
  res.end();
}

// ------------------------------------------------------------------- router
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      version: cliVersion,
      mode: cfg.mode,
      credential,
      model: cfg.model,
      spentToday,
      dailyTokenBudget: cfg.dailyTokenBudget
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(res, 200, {
      object: "list",
      data: [{ id: cfg.modelId, object: "model", created: 0, owned_by: "claude-cli-runner" }]
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (!authorized(req)) return sendJson(res, 401, { error: { message: "unauthorized", type: "invalid_request_error" } });
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: { message: "bad request body", type: "invalid_request_error" } });
    }
    return handleChatCompletions(req, res, body);
  }

  return sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
});

server.listen(cfg.port, cfg.bind, () => {
  console.log(`openai-compat (claude -p) on http://${cfg.bind}:${cfg.port}/v1`);
  console.log(`cli ${cliVersion} · claude model ${cfg.model} · exposed as "${cfg.modelId}" · auth ${credential} · mode ${cfg.mode}`);
  console.log("Point Strix at it:");
  console.log(`  STRIX_LLM=openai/${cfg.modelId}  LLM_API_BASE=http://${cfg.bind}:${cfg.port}/v1  LLM_API_KEY=<any-non-empty>`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
