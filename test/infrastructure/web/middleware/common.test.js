import {
  describe, it, expect, vi,
} from 'vitest';
import { dryRunMiddleware, resolveIngressFormat } from '../../../../src/infrastructure/web/middleware/common.js';

describe('dryRunMiddleware', () => {
  it('sets req.isDryRun to true and calls next', () => {
    const req = {};
    const next = vi.fn();

    dryRunMiddleware(req, {}, next);

    expect(req.isDryRun).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('resolveIngressFormat', () => {
  it('returns anthropic for messages path', () => {
    expect(resolveIngressFormat({ baseUrl: '', originalUrl: '/messages' })).toBe('anthropic');
    expect(resolveIngressFormat({ baseUrl: '', originalUrl: '/v1/messages' })).toBe('anthropic');
  });

  it('returns openai for non-anthropic paths', () => {
    expect(resolveIngressFormat({ baseUrl: '/v1', originalUrl: '/v1/chat/completions', path: '/chat/completions' })).toBe('openai');
    expect(resolveIngressFormat({ baseUrl: '/' })).toBe('openai');
    expect(resolveIngressFormat({ baseUrl: '' })).toBe('openai');
  });

  it('resolves anthropic correctly even if baseUrl is /v1 or /dryrun/v1', () => {
    expect(resolveIngressFormat({ baseUrl: '/v1', originalUrl: '/v1/messages', path: '/messages' })).toBe('anthropic');
    expect(resolveIngressFormat({ baseUrl: '/dryrun/v1', originalUrl: '/dryrun/v1/messages', path: '/messages' })).toBe('anthropic');
    expect(resolveIngressFormat({ baseUrl: '/dryrun', originalUrl: '/dryrun/messages', path: '/messages' })).toBe('anthropic');
  });

  it('falls back to originalUrl when baseUrl is empty', () => {
    expect(resolveIngressFormat({ baseUrl: '', originalUrl: '/v1/messages' })).toBe('anthropic');
    expect(resolveIngressFormat({ baseUrl: '', originalUrl: '/v1/chat/completions' })).toBe('openai');
  });

  it('falls back to path when baseUrl and originalUrl are empty', () => {
    expect(resolveIngressFormat({ baseUrl: '', originalUrl: '', path: '/v1/chat/completions' })).toBe('openai');
    expect(resolveIngressFormat({ baseUrl: '', originalUrl: '', path: '/messages' })).toBe('anthropic');
  });

  it('defaults to openai when no path information is available', () => {
    expect(resolveIngressFormat({})).toBe('openai');
    expect(resolveIngressFormat({ baseUrl: null, originalUrl: null, path: null })).toBe('openai');
  });
});
