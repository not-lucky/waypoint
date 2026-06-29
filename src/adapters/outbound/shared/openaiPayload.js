import { resolveReasoningEffort } from './openaiResponse.js';

const INTERNAL_KEYS = new Set([
  'clientParams',
  'provider',
  'modelid',
  'maxTokens',
  'reasoningSupported',
  'reasoningEffort',
  'extractReasoningFromThinkBlocks',
  'fallbackModel',
  'isFallback',
]);

/**
 * Builds an OpenAI-compatible chat/completions payload from a unified request.
 * Preserves client fields (tools, tool_choice, etc.) while applying model routing.
 */
export function buildOpenAIChatPayload(req, stream) {
  const client = req.clientParams || {};
  const payload = { ...client };

  for (const key of INTERNAL_KEYS) {
    delete payload[key];
  }

  payload.model = req.modelid || client.model || req.model;
  payload.messages = req.messages ?? client.messages;
  payload.stream = stream;

  if (stream) {
    payload.stream_options = { include_usage: true };
  } else {
    delete payload.stream_options;
  }

  if (req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }

  if (req.maxTokens !== undefined) {
    payload.max_tokens = req.maxTokens;
    delete payload.max_completion_tokens;
  } else if (client.max_tokens !== undefined) {
    payload.max_tokens = client.max_tokens;
  } else if (client.max_completion_tokens !== undefined) {
    payload.max_completion_tokens = client.max_completion_tokens;
    delete payload.max_tokens;
  }

  const effort = resolveReasoningEffort(req);
  if (effort && payload.reasoning_effort === undefined) {
    payload.reasoning_effort = effort;
  }
  const reasoningSupported = req.reasoningSupported !== false;
  if (reasoningSupported && payload.include_reasoning === undefined) {
    payload.include_reasoning = true;
  }

  return payload;
}
