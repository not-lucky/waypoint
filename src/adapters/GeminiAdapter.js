import { BaseProvider } from './BaseProvider.js';
import { executeCompletion } from './geminiCompletion.js';
import { executeStream } from './geminiStream.js';

/**
 * WHAT: Provider adapter for Google's Gemini API endpoints.
 * WHY: Serves as the core contract delegator for Gemini standard and stream generation.
 */
export class GeminiAdapter extends BaseProvider {
  constructor(baseUrl = null, timeoutMs = null) {
    super();
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async generateCompletion(req, apiKey, signal, requestLog = null) {
    // Delegate non-streaming request lifecycle to executeCompletion
    return executeCompletion(req, apiKey, signal, requestLog, this);
  }

  async* generateStream(req, apiKey, signal, requestLog = null) {
    // Delegate streaming request lifecycle to executeStream
    yield* executeStream(req, apiKey, signal, requestLog, this);
  }

  // eslint-disable-next-line class-methods-use-this
  normalizeError(error) {
    // Convert upstream Google API error messages and status codes to normalized internal codes
    return BaseProvider.normalizeProviderError(error, 'gemini');
  }
}
