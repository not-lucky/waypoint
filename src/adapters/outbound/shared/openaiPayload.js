import { resolveReasoningEffort } from './openaiResponse.js';
import { applyExtraBody } from './extraBody.js';

const FORWARDED_CLIENT_KEYS = new Set([
  'messages',
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'tools',
  'tool_choice',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'response_format',
  'stop',
  'n',
  'user',
  'seed',
  'parallel_tool_calls',
  'functions',
  'function_call',
  'metadata',
  'modalities',
  'audio',
  'store',
  'stream_options',
]);

/**
 * Builds an OpenAI-compatible chat/completions request payload from a unified request.
 *
 * It filters and forwards client-supplied parameters (like `messages`, `temperature`, `max_tokens`,
 * `tools`, `tool_choice`, logprobs, etc.) while mapping model identifiers, streaming settings,
 * token parameters, reasoning effort settings, and injecting custom whitelisted extra fields.
 *
 * @param {Object} req - The unified request payload containing model metadata, messages, temperature, maxTokens, etc.
 * @param {boolean} stream - Whether the request is streaming (SSE) or unary.
 * @returns {Object} The constructed OpenAI-compatible request payload object.
 */
export function buildOpenAIChatPayload(req, stream) {
  const client = req.clientParams || {};
  const payload = {};

  for (const key of FORWARDED_CLIENT_KEYS) {
    if (client[key] !== undefined) {
      payload[key] = client[key];
    }
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

  // Merge any whitelisted configuration or client-supplied extra request parameters (extraBody)
  // directly into the outgoing OpenAI-compatible payload.
  return applyExtraBody(payload, req.extraBody);
}
