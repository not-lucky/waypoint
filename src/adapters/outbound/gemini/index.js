import { BaseProvider } from '../base.js';
import { executeCompletion } from './geminiCompletion.js';
import { executeStream } from './geminiStream.js';

export class GeminiAdapter extends BaseProvider {
  constructor({
    baseUrl = null,
    providerName = 'gemini',
    timeoutMs = null,
    streamTimeoutMs = null,
  } = {}) {
    super({
      baseUrl,
      providerName,
      timeoutMs,
      streamTimeoutMs,
    });
  }

  async generateCompletion(req, apiKey, signal, requestLog = null) {
    // Delegate non-streaming request lifecycle to executeCompletion
    return executeCompletion(req, apiKey, signal, requestLog, this);
  }

  async* generateStream(req, apiKey, signal, requestLog = null) {
    // Delegate streaming request lifecycle to executeStream
    yield* executeStream(req, apiKey, signal, requestLog, this);
  }
}
