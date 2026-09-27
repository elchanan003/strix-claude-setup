/**
 * claude-cli-runner — run the Claude Code CLI as a subprocess behind a service.
 *
 * Extracted from devops-005-gitops-guides/tutor-local. See README.md for the
 * scope this is built for (single operator) and the guard that enforces it.
 */
export { resolveClaudeBin, resetBinCache, preflight, ClaudeBinaryError } from "./bin.mjs";
export {
  buildChildEnv,
  detectCredential,
  isMeteredCredential,
  assertRunnerConfig,
  isLoopback,
  BEDROCK_VARS,
  VERTEX_VARS,
  RunnerConfigError
} from "./env.mjs";
export { baseArgs, systemPromptFlag, SYSTEM_PROMPT_ARGV_LIMIT } from "./args.mjs";
export { spawnClaudeStream } from "./stream.mjs";
export { spawnClaudeJson, parseStructuredOutput, cleanField, cleanFields } from "./json.mjs";
export { totalTokens, inputTokens, summarizeUsage, summarizeRateLimit } from "./usage.mjs";
export {
  flattenMessages,
  describeTools,
  buildSystemPrompt,
  buildStdinPrompt,
  buildEnvelopeSchema,
  toChatCompletion,
  toChatCompletionSSE,
  mapModel,
  requestShape,
  contentToText
} from "./openai.mjs";
