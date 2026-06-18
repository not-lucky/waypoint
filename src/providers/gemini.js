import { BaseProvider } from './base.js';
import { executeCompletion } from './gemini/geminiCompletion.js';
import { executeStream } from './gemini/geminiStream.js';

export class GeminiAdapter extends BaseProvider {
  constructor({
    baseUrl = null,
    timeoutMs = null,
    streamTimeoutMs = null,
  } = {}) {
    super();
    this.baseUrl = baseUrl?.replace(/\/$/, '') ?? null;
    this.timeoutMs = timeoutMs;
    this.streamTimeoutMs = streamTimeoutMs;
  }

  async generateCompletion(req, apiKey, signal, requestLog = null) {
    // Delegate non-streaming request lifecycle to executeCompletion
    return executeCompletion(req, apiKey, signal, requestLog, this);
  }

  async* generateStream(req, apiKey, signal, requestLog = null) {
    // Delegate streaming request lifecycle to executeStream
    yield* executeStream(req, apiKey, signal, requestLog, this);
  }

   
  normalizeError(error, req = null) {
    // Convert upstream Google API error messages and status codes to normalized internal codes
    return BaseProvider.normalizeProviderError(error, 'gemini', req);
  }
}
