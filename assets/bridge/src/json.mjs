/**
 * Non-streaming, schema-constrained call: `claude -p --json-schema ...
 * --output-format json`.
 *
 * Extracted from tutor-local/lib/claude.mjs:130-198.
 *
 * The CLI's own harness enforces the schema, so the caller gets a
 * `structured_output` field already parsed to shape. That is a real upgrade
 * over asking a model to "reply with JSON" and defensively stripping markdown
 * fences off the answer, which is what the REST-based Worker this replaced had
 * to do.
 */
import { spawn } from "node:child_process";
import { resolveClaudeBin } from "./bin.mjs";
import { buildChildEnv } from "./env.mjs";
import { baseArgs, systemPromptFlag } from "./args.mjs";

/**
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {string} opts.stdinPrompt
 * @param {object} opts.jsonSchema     a JSON Schema object; serialized onto argv
 * @param {number} [opts.timeoutMs=60000]
 * @param {string} [opts.systemPromptMode="auto"]
 * @param {object} [opts.env]
 * @returns {Promise<object>} the CLI's full result object: { result,
 *          structured_output, usage, is_error, ... }
 */
export function spawnClaudeJson({
  model,
  systemPrompt,
  stdinPrompt,
  jsonSchema,
  timeoutMs = 60_000,
  systemPromptMode = "auto",
  env,
  signal
}) {
  return new Promise((resolve, reject) => {
    const { flag, cleanup } = systemPromptFlag(systemPrompt, systemPromptMode);
    const args = [...baseArgs(model, flag), "--json-schema", JSON.stringify(jsonSchema), "--output-format", "json"];

    const child = spawn(resolveClaudeBin(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnv(env)
    });

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      cleanup();
      fn(arg);
    };

    /* Rule #5: the HTTP caller hung up — stop paying for an answer nobody will
       read. Wired to res.on("close") by the server via an AbortSignal. */
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(reject, new Error("aborted by caller"));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));

    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => {
      /* A non-zero exit with usable stdout still counts: the CLI reports some
         in-band failures as a well-formed result object carrying is_error. */
      if (code !== 0 && !out.trim()) {
        return finish(reject, new Error(err.trim() || `claude exited ${code}`));
      }
      try {
        finish(resolve, JSON.parse(out));
      } catch (e) {
        finish(reject, new Error(`unparseable output from claude: ${e.message}`));
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(stdinPrompt);
  });
}

/**
 * `--json-schema` was observed, in testing, to occasionally leave a stray
 * `</tag></invoke>` fragment trailing a string field — a harness artifact, not
 * something the model meant to write. Trimmed defensively.
 */
export function cleanField(s) {
  return typeof s === "string" ? s.replace(/<\/[a-zA-Z_]+>\s*(<\/invoke>)?\s*$/, "").trim() : s;
}

/** cleanField applied to every string in a flat object. */
export function cleanFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, cleanField(v)]));
}

/**
 * The parsed object from a spawnClaudeJson response.
 *
 * Prefers `structured_output` (the harness-enforced shape). Falls back to
 * parsing `result` as JSON, stripping markdown fences first — the path the
 * REST-based predecessor always had to take, kept because the CLI omits
 * structured_output when the model errors out mid-answer.
 *
 * @throws if neither path yields an object.
 */
export function parseStructuredOutput(response) {
  if (response?.structured_output && typeof response.structured_output === "object") {
    return cleanFields(response.structured_output);
  }
  const raw = String(response?.result || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  if (!raw) throw new Error("no structured_output and no result text to fall back to");
  return cleanFields(JSON.parse(raw));
}
