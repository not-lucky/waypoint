import { BaseProvider } from '../base.js';
import { executeCompletion } from './geminiCompletion.js';
import { executeStream } from './geminiStream.js';
import { mapGeminiStatusToType } from '../../../domain/errors/geminiErrorTypes.js';
import { normalizeUpstreamError } from '../../../domain/errors/upstream.js';

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

  async parseUpstreamError(response) {
    const err = await super.parseUpstreamError(response);
    const upstreamStatus = err.upstreamBody?.error?.status;
    if (upstreamStatus) {
      err.errorType = mapGeminiStatusToType(upstreamStatus);
    }
    return err;
  }

  normalizeError(error) {
    const normalized = normalizeUpstreamError(error, this.providerName);
    const upstreamStatus = normalized.upstreamBody?.error?.status
      || error?.upstreamBody?.error?.status
      || error?.errorType
      || normalized.errorType;

    return {
      ...normalized,
      errorType: mapGeminiStatusToType(upstreamStatus) || normalized.errorType,
    };
  }
}
