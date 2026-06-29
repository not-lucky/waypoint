import { OpenAICompatibleAdapter } from '../openai/index.js';

export class CloudflareAdapter extends OpenAICompatibleAdapter {
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
