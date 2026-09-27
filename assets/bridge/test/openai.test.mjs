/**
 * Offline unit tests for the OpenAI <-> claude -p bridge (src/openai.mjs).
 * No model calls. Run: node test/openai.test.mjs
 */
import assert from "node:assert/strict";
import {
  contentToText,
  flattenMessages,
  describeTools,
  buildSystemPrompt,
  buildEnvelopeSchema,
  toChatCompletion,
  toChatCompletionSSE,
  mapModel,
  requestShape
} from "../src/openai.mjs";

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

test("contentToText handles string and parts, drops images", () => {
  assert.equal(contentToText("hi"), "hi");
  assert.equal(contentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.match(contentToText([{ type: "image_url", image_url: { url: "x" } }]), /image omitted/);
});

test("flattenMessages splits system out and renders tool calls + results", () => {
  const { systemText, transcript } = flattenMessages([
    { role: "system", content: "SYS" },
    { role: "developer", content: "DEV" },
    { role: "user", content: "start" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "shell", arguments: '{"cmd":"ls"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "file.txt" }
  ]);
  assert.equal(systemText, "SYS\n\nDEV");
  assert.match(transcript, /## User\nstart/);
  assert.match(transcript, /tool call \[id=c1\]\nshell\(\{"cmd":"ls"\}\)/);
  assert.match(transcript, /## Tool result \[for id=c1\]\nfile\.txt/);
});

test("describeTools renders each function schema", () => {
  const doc = describeTools([{ type: "function", function: { name: "shell", description: "run", parameters: { type: "object" } } }]);
  assert.match(doc, /### shell/);
  assert.match(doc, /run/);
  assert.match(doc, /JSON Schema/);
});

test("buildSystemPrompt forces a tool call when required", () => {
  const p = buildSystemPrompt({ systemText: "S", tools: [{ function: { name: "x" } }], toolChoice: "required" });
  assert.match(p, /MUST call a tool/);
  const named = buildSystemPrompt({ systemText: "S", tools: [{ function: { name: "x" } }], toolChoice: { type: "function", function: { name: "x" } } });
  assert.match(named, /MUST call the tool "x"/);
  const none = buildSystemPrompt({ systemText: "S", tools: [], toolChoice: "none" });
  assert.match(none, /Do NOT call any tool/);
});

test("buildEnvelopeSchema restricts response types by tool availability", () => {
  assert.deepEqual(buildEnvelopeSchema({ hasTools: true }).properties.response_type.enum, ["tool_calls", "message"]);
  assert.deepEqual(buildEnvelopeSchema({ hasTools: false }).properties.response_type.enum, ["message"]);
});

test("requestShape defaults tool_choice sensibly", () => {
  assert.deepEqual(requestShape({ tools: [{}], }).toolChoice, "auto");
  assert.deepEqual(requestShape({}).toolChoice, "none");
  assert.equal(requestShape({ tools: [{}], tool_choice: "required" }).toolChoice, "required");
});

test("toChatCompletion emits tool_calls with stringified arguments", () => {
  const result = {
    structured_output: { response_type: "tool_calls", tool_calls: [{ name: "shell", arguments: { cmd: "ls" } }] },
    usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 }
  };
  const cc = toChatCompletion(result, { model: "strix-runner" });
  assert.equal(cc.object, "chat.completion");
  assert.equal(cc.choices[0].finish_reason, "tool_calls");
  const call = cc.choices[0].message.tool_calls[0];
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "shell");
  assert.equal(call.function.arguments, '{"cmd":"ls"}'); // string, per OpenAI wire format
  assert.equal(cc.choices[0].message.content, null);
  assert.equal(cc.usage.prompt_tokens, 105);
  assert.equal(cc.usage.completion_tokens, 20);
  assert.equal(cc.usage.total_tokens, 125);
});

test("toChatCompletion emits a plain message when response_type is message", () => {
  const cc = toChatCompletion({ structured_output: { response_type: "message", content: "hello" }, usage: {} }, { model: "m" });
  assert.equal(cc.choices[0].finish_reason, "stop");
  assert.equal(cc.choices[0].message.content, "hello");
  assert.equal(cc.choices[0].message.tool_calls, undefined);
});

test("toChatCompletion falls back to parsing result text when structured_output is absent", () => {
  const cc = toChatCompletion({ result: '```json\n{"response_type":"message","content":"hi"}\n```', usage: {} }, { model: "m" });
  assert.equal(cc.choices[0].message.content, "hi");
});

test("toChatCompletionSSE frames a tool call as valid OpenAI chunks", () => {
  const events = toChatCompletionSSE(
    { structured_output: { response_type: "tool_calls", tool_calls: [{ name: "shell", arguments: { cmd: "ls" } }] }, usage: { output_tokens: 3 } },
    { model: "m", includeUsage: true }
  );
  assert.equal(events[events.length - 1], "data: [DONE]\n\n");
  const parsed = events.slice(0, -1).map((e) => JSON.parse(e.replace(/^data: /, "").trim()));
  assert.equal(parsed[0].choices[0].delta.role, "assistant");
  const toolChunk = parsed.find((c) => c.choices[0]?.delta?.tool_calls);
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, "shell");
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].index, 0);
  const finish = parsed.find((c) => c.choices[0]?.finish_reason === "tool_calls");
  assert.ok(finish);
  const usageChunk = parsed.find((c) => c.usage);
  assert.equal(usageChunk.usage.completion_tokens, 3);
});

test("mapModel passes real claude names, defaults the rest", () => {
  assert.equal(mapModel("openai/strix-runner", "sonnet"), "sonnet");
  assert.equal(mapModel("opus", "sonnet"), "opus");
  assert.equal(mapModel("claude-sonnet-5", "sonnet"), "claude-sonnet-5");
  assert.equal(mapModel(undefined, "haiku"), "haiku");
});

console.log(`\n${passed} passed`);
