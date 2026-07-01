import { executeThinkingStream } from './geminiThinkingStream.js';
import { executeStandardStream } from './geminiStandardStream.js';

/**
 * Routes and executes a streaming chat completion request to the correct upstream Gemini generator.
 *
 * Checks if the request enables reasoning/thinking:
 * 1. If reasoning is supported, delegates to {@link executeThinkingStream} to use the OpenAI-compatible endpoint with thinking config.
 * 2. If reasoning is not supported (standard model), delegates to {@link executeStandardStream} to target the native Gemini streamGenerateContent API.
 *
 * @async
 * @generator
 * @param {Object} req - The normalized chat completion request payload.
 * @param {string} apiKey - The Google Gemini API key.
 * @param {AbortSignal} signal - Abort signal to cancel the stream.
 * @param {Object|null} requestLog - Optional request/response audit logger.
 * @param {Object} adapter - The Gemini adapter instance invoking the stream.
 * @yields {Object} OpenAI-compatible stream chunk deltas.
 */
export async function* executeStream(req, apiKey, signal, requestLog, adapter) {
  const reasoningSupported = req.reasoningSupported !== false;

  if (reasoningSupported) {
    yield* executeThinkingStream(req, apiKey, signal, requestLog, adapter);
  } else {
    yield* executeStandardStream(req, apiKey, signal, requestLog, adapter);
  }
}
