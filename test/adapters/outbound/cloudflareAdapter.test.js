import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { CloudflareAdapter } from '../../../src/adapters/outbound/cloudflare/index.js';

describe('CloudflareAdapter Tests', () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('assert: Cloudflare credentials derive account-scoped base URL', async () => {
    const adapter = new CloudflareAdapter();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-123',
        choices: [{ message: { content: 'hello' } }],
      }),
    });

    await adapter.generateCompletion(
      { modelid: '@cf/meta/llama-3.1-8b-instruct', messages: [] },
      { apiKey: 'cf-key', accountId: 'acct-123' },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer cf-key',
        }),
      }),
    );
  });

  it('assert: Cloudflare adapter throws when accountId is missing from the credential', async () => {
    const adapter = new CloudflareAdapter();

    expect(() => adapter.resolveBaseUrl({ apiKey: 'cf-key' })).toThrow(/accountId/);
    expect(() => adapter.resolveBaseUrl(null)).toThrow(/accountId/);
    expect(() => adapter.resolveBaseUrl(undefined)).toThrow(/accountId/);

    await expect(adapter.generateCompletion(
      { modelid: '@cf/meta/llama-3.1-8b-instruct', messages: [] },
      { apiKey: 'cf-key' },
    )).rejects.toThrow(/accountId/);
  });
});
