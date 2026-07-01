/**
 * @fileoverview Cloudflare Workers AI outbound adapter.
 *
 * Cloudflare is OpenAI-compatible at the request/response surface, so
 * this adapter extends `OpenAICompatibleAdapter`. The only divergence is
 * the per-account base URL (`https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1`),
 * which is derived from the structured credential's `accountId` field.
 *
 * @module adapters/outbound/cloudflare
 */

import { OpenAICompatibleAdapter } from '../openai/index.js';

/**
 * Outbound adapter for Cloudflare Workers AI.
 *
 * Cloudflare's `/client/v4/accounts/{accountId}/ai/v1` endpoint implements
 * the OpenAI chat-completions shape, so we delegate almost everything to
 * the parent class. The only override is `resolveBaseUrl`, which builds
 * the per-account URL from the credential's `accountId`.
 *
 * @extends OpenAICompatibleAdapter
 */
export class CloudflareAdapter extends OpenAICompatibleAdapter {
  /**
   * @param {Object} [options={}] - Adapter configuration.
   * @param {string} [options.baseUrl=null] - Override base URL; when null, the
   *   per-account URL is computed via `resolveBaseUrl`.
   * @param {string} [options.providerName='cloudflare'] - Provider label for logging/metrics.
   * @param {number|null} [options.timeoutMs=null] - Non-streaming fetch timeout.
   * @param {number|null} [options.streamTimeoutMs=null] - Stream idle timeout.
   */
  constructor({
    baseUrl = null,
    providerName = 'cloudflare',
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

  /**
   * Returns the per-account Cloudflare base URL.
   *
   * Throws when the supplied credential lacks an `accountId`, because
   * Cloudflare's API requires the account ID in the URL — there is no
   * way to issue a completion against an un-scoped endpoint.
   *
   * @param {string|Object} apiCredential - Structured credential `{ apiKey, accountId }`.
   * @returns {string} The Cloudflare base URL.
   * @throws {Error} When `accountId` is missing or empty.
   */
  resolveBaseUrl(apiCredential) {
    const accountId = apiCredential?.accountId;
    if (!accountId) {
      throw new Error(
        'Cloudflare credentials require a non-empty \'accountId\'. '
        + 'Check that the provider keys array includes both \'apiKey\' and \'accountId\'.',
      );
    }

    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  }
}
