import { describe, it, expect } from 'vitest';
import { applyExtraBody } from '../../../../src/adapters/outbound/shared/extraBody.js';

describe('applyExtraBody', () => {
  it('returns the payload unchanged when extraBody is missing or invalid', () => {
    const payload = { model: 'gpt-4o', temperature: 0.5 };

    expect(applyExtraBody(payload, undefined)).toBe(payload);
    expect(applyExtraBody(payload, null)).toBe(payload);
    expect(applyExtraBody(payload, 'invalid')).toBe(payload);
    expect(applyExtraBody(payload, [])).toBe(payload);
    expect(payload).toEqual({ model: 'gpt-4o', temperature: 0.5 });
  });

  it('shallow-merges top-level keys into the outgoing payload', () => {
    const payload = {
      model: 'gpt-4o',
      provider: { sort: 'price', allow_fallbacks: true },
      plugins: [{ id: 'old-plugin' }],
    };

    const result = applyExtraBody(payload, {
      provider: { sort: 'throughput' },
      plugins: [{ id: 'web-search' }],
      metadata: { source: 'waypoint' },
    });

    expect(result).toBe(payload);
    expect(result).toEqual({
      model: 'gpt-4o',
      provider: { sort: 'throughput' },
      plugins: [{ id: 'web-search' }],
      metadata: { source: 'waypoint' },
    });
  });

  it('deep-merges known nested containers like extra_body and metadata, while shallow-merging others', () => {
    const payload = {
      model: 'gpt-4o',
      extra_body: {
        google: {
          thinking_config: { level: 'high' }
        }
      },
      metadata: {
        user: 'admin'
      },
      provider: {
        sort: 'price'
      }
    };

    const extraBody = {
      extra_body: {
        google: {
          google_search: {}
        }
      },
      metadata: {
        department: 'engineering'
      },
      provider: {
        allow_fallbacks: true
      }
    };

    const result = applyExtraBody(payload, extraBody);

    expect(result.extra_body).toEqual({
      google: {
        thinking_config: { level: 'high' },
        google_search: {}
      }
    });

    expect(result.metadata).toEqual({
      user: 'admin',
      department: 'engineering'
    });

    expect(result.provider).toEqual({
      allow_fallbacks: true
    });
  });
});
