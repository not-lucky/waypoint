import { executeThinkingStream, processThinkingBuffer, parseSSEEventData } from './geminiThinkingStream.js';
import { executeStandardStream } from './geminiStandardStream.js';

export { processThinkingBuffer, parseSSEEventData };

/**
 * Generates a streaming completion.
 * Delivers tokens in real-time, handling tag reconstruction for reasoning models.
 */
export async function* executeStream(req, apiKey, signal, requestLog, adapter) {
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

  if (thinkingEnabled) {
    yield* executeThinkingStream(req, apiKey, signal, requestLog, adapter);
  } else {
    yield* executeStandardStream(req, apiKey, signal, requestLog, adapter);
  }
}
