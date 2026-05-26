import { executeThinkingStream } from './geminiThinkingStream.js';
import { executeStandardStream } from './geminiStandardStream.js';

/**
 * Generates a streaming completion.
 * Delivers tokens in real-time, handling tag reconstruction for reasoning models.
 */
export async function* executeStream(req, apiKey, signal, requestLog, adapter) {
  const reasoningSupported = req.reasoningSupported || false;

  if (reasoningSupported) {
    yield* executeThinkingStream(req, apiKey, signal, requestLog, adapter);
  } else {
    yield* executeStandardStream(req, apiKey, signal, requestLog, adapter);
  }
}
