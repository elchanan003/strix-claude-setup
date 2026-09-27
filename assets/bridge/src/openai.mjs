/**
 * OpenAI Chat Completions <-> claude -p bridge.
 *
 * This is what lets an OpenAI-Agents / LiteLLM client (Strix, in particular)
 * drive `claude -p` even though `-p` has no native OpenAI-style tool-calling
 * protocol and the runner deliberately keeps Claude's OWN tools off
 * (`--tools ""`, see args.mjs).
 *
 * The trick is "prompted tool calling": the caller's tool definitions are
 * described in the system prompt, and `--json-schema` forces Claude to answer
 * with a small envelope — either a text message or one-or-more calls to the
 * CALLER's tools — which this module translates back into the exact
 * `tool_calls` shape the OpenAI wire format uses. Claude never runs anything
 * itself; it only ever names a tool for the client to run.
 *
 * Everything here is pure (no I/O) so it can be unit-tested without a model.
 * The HTTP glue and the actual subprocess call live in
 * examples/openai-server.mjs.
 */
import { randomUUID } from "node:crypto";
import { inputTokens, totalTokens } from "./usage.mjs";

/** Flatten OpenAI message `content` (string | part[]) to plain text. */
export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" || typeof part?.text === "string") return part.text || "";
      if (part?.type === "image_url" || part?.type === "input_image" || part?.image_url) {
        return "[image omitted — this bridge speaks text-only to claude -p]";
      }
      if (part?.type === "refusal" && part.refusal) return part.refusal;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Split OpenAI `messages` into the system prompt (turn-invariant, so it can be
 * prompt-cached) and a flattened transcript of everything else, written to the
 * child's stdin. `-p` is single-shot: there is no way to hand it a role-tagged
 * history, so prior turns — including assistant tool calls and their tool
 * results — are rendered into one readable transcript.
 */
export function flattenMessages(messages = []) {
  const systemParts = [];
  const lines = [];

  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role;
    if (role === "system" || role === "developer") {
      const t = contentToText(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (role === "user") {
      lines.push(`## User\n${contentToText(m.content)}`);
    } else if (role === "assistant") {
      const text = contentToText(m.content);
      if (text) lines.push(`## Assistant\n${text}`);
      for (const call of m.tool_calls || []) {
        const name = call?.function?.name || call?.name || "unknown";
        const args = call?.function?.arguments ?? call?.arguments ?? "";
        const id = call?.id || "";
        lines.push(`## Assistant → tool call${id ? ` [id=${id}]` : ""}\n${name}(${typeof args === "string" ? args : JSON.stringify(args)})`);
      }
    } else if (role === "tool") {
      const id = m.tool_call_id || "";
      lines.push(`## Tool result${id ? ` [for id=${id}]` : ""}\n${contentToText(m.content)}`);
    }
  }

  return { systemText: systemParts.join("\n\n"), transcript: lines.join("\n\n") };
}

/** Human-readable description of the caller's tools, for the system prompt. */
export function describeTools(tools = []) {
  const fns = (Array.isArray(tools) ? tools : [])
    .map((t) => t?.function || (t?.name ? t : null))
    .filter(Boolean);
  if (!fns.length) return "";

  const blocks = fns.map((fn) => {
    const params = fn.parameters ? JSON.stringify(fn.parameters) : '{"type":"object","properties":{}}';
    return `### ${fn.name}\n${fn.description || "(no description)"}\nParameters (JSON Schema): ${params}`;
  });
  return `# Tools you can call\n\n${blocks.join("\n\n")}`;
}

const PROTOCOL = [
  "# Response protocol",
  "",
  "You have no native tool-calling channel here. Reply with EXACTLY ONE JSON",
  "object and nothing else — no prose, no markdown fences. The object is:",
  "",
  '  {"response_type": "tool_calls" | "message",',
  '   "content": "<text, only when response_type is message>",',
  '   "tool_calls": [{"name": "<tool name>", "arguments": { ... }}]}',
  "",
  "To use a tool set response_type to \"tool_calls\" and put a SINGLE entry in",
  "tool_calls whose name is one of the tools above and whose arguments is an",
  "object matching that tool's parameters schema. To answer the user directly",
  "set response_type to \"message\" and put your text in content."
].join("\n");

/**
 * Assemble the system prompt handed to claude -p: the caller's own system
 * messages, then the tool catalogue, then the envelope protocol.
 */
export function buildSystemPrompt({ systemText, tools, toolChoice }) {
  const parts = [];
  if (systemText) parts.push(systemText);
  const toolDoc = describeTools(tools);
  if (toolDoc) parts.push(toolDoc);
  parts.push(PROTOCOL);

  const forced = toolChoice === "required" || (toolChoice && typeof toolChoice === "object");
  const named = typeof toolChoice === "object" ? toolChoice?.function?.name : null;
  if (named) {
    parts.push(`This turn you MUST call the tool "${named}" (response_type must be "tool_calls").`);
  } else if (forced) {
    parts.push('This turn you MUST call a tool (response_type must be "tool_calls").');
  } else if (toolChoice === "none") {
    parts.push('Do NOT call any tool this turn (response_type must be "message").');
  }
  return parts.join("\n\n");
}

/** The stdin prompt: the transcript, then a nudge to emit the next envelope. */
export function buildStdinPrompt(transcript) {
  return `${transcript}\n\n## Now respond with the single JSON envelope described in the system prompt.`;
}

/**
 * The `--json-schema` envelope. `arguments` is a freeform object — verified to
 * be accepted by the CLI's schema enforcement (a probe returned nested tool
 * args intact). When no tools are offered, only a message is allowed.
 */
export function buildEnvelopeSchema({ hasTools }) {
  const responseTypes = hasTools ? ["tool_calls", "message"] : ["message"];
  return {
    type: "object",
    additionalProperties: false,
    required: ["response_type"],
    properties: {
      response_type: { type: "string", enum: responseTypes },
      content: { type: "string" },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "arguments"],
          properties: {
            name: { type: "string" },
            arguments: { type: "object" }
          }
        }
      }
    }
  };
}

/** Normalize a parsed envelope into OpenAI tool_calls (or a text message). */
function envelopeToMessageParts(envelope) {
  const calls = Array.isArray(envelope?.tool_calls) ? envelope.tool_calls : [];
  const wantsTools = envelope?.response_type === "tool_calls" && calls.length > 0;

  if (!wantsTools) {
    return { content: typeof envelope?.content === "string" ? envelope.content : "", tool_calls: null };
  }

  const tool_calls = calls.map((c) => ({
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name: String(c?.name || ""),
      arguments: JSON.stringify(c?.arguments ?? {})
    }
  }));
  return { content: null, tool_calls };
}

function usageBlock(result) {
  const usage = result?.usage || {};
  const prompt = inputTokens(usage);
  const completion = usage.output_tokens || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: totalTokens(result) };
}

/** Build a non-streaming `chat.completion` response from a claude JSON result. */
export function toChatCompletion(result, { model }) {
  const envelope = result?.structured_output && typeof result.structured_output === "object" ? result.structured_output : safeParse(result?.result);
  const { content, tool_calls } = envelopeToMessageParts(envelope || {});
  const message = { role: "assistant", content };
  if (tool_calls) message.tool_calls = tool_calls;

  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: tool_calls ? "tool_calls" : "stop" }],
    usage: usageBlock(result)
  };
}

/**
 * Build the SSE chunk list for a streaming response. claude -p is called once,
 * in full (streaming partial JSON would be meaningless), then its result is
 * replayed as OpenAI `chat.completion.chunk` events — role, then the tool_calls
 * or content, then a finish, then optionally usage, then [DONE].
 */
export function toChatCompletionSSE(result, { model, includeUsage }) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const envelope = result?.structured_output && typeof result.structured_output === "object" ? result.structured_output : safeParse(result?.result);
  const { content, tool_calls } = envelopeToMessageParts(envelope || {});

  const base = { id, object: "chat.completion.chunk", created, model };
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }], usage: null })}\n\n`;

  const out = [];
  out.push(chunk({ role: "assistant" }));
  if (tool_calls) {
    tool_calls.forEach((call, index) => {
      out.push(chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } }] }));
    });
    out.push(chunk({}, "tool_calls"));
  } else {
    if (content) out.push(chunk({ content }));
    out.push(chunk({}, "stop"));
  }
  if (includeUsage) {
    out.push(`data: ${JSON.stringify({ ...base, choices: [], usage: usageBlock(result) })}\n\n`);
  }
  out.push("data: [DONE]\n\n");
  return out;
}

function safeParse(text) {
  if (!text || typeof text !== "string") return null;
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    return JSON.parse(raw);
  } catch {
    /* Not the envelope — treat the whole thing as a plain text answer. */
    return { response_type: "message", content: text };
  }
}

/**
 * Map the model name the client asked for onto a claude -p `--model` value.
 * Real Claude aliases/ids pass through; anything else (e.g. the placeholder
 * "strix-runner") falls back to `defaultModel`.
 */
export function mapModel(requested, defaultModel = "sonnet") {
  const name = String(requested || "").trim().toLowerCase().replace(/^openai\//, "");
  if (name === "opus" || name === "sonnet" || name === "haiku") return name;
  if (name.startsWith("claude-")) return name;
  return defaultModel;
}

/** Read tool_choice + tools off an OpenAI request into the flags this module needs. */
export function requestShape(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const hasTools = tools.length > 0;
  let toolChoice = body?.tool_choice;
  if (toolChoice === undefined) toolChoice = hasTools ? "auto" : "none";
  return { tools, hasTools, toolChoice };
}
