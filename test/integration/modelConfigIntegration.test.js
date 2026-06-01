import { describe, it, expect } from 'vitest';
import { authed, createModelConfigTestApp } from '../helpers/testServer.js';

describe('Model Configuration Integration Tests (via dry-run)', () => {
  it('applies flat model defaults to the upstream provider payload', async () => {
    const { app, teardown } = await createModelConfigTestApp();
    try {
      const res = await authed(app)
        .post('/dryrun/openai/chat/completions')
        .send({
          model: 'gemini/gemini-flash-lite-latest-low',
          messages: [{ role: 'user', content: 'defaults' }],
        })
        .expect(200);

      expect(res.body.request.body).toEqual(expect.objectContaining({
        model: 'gemini-flash-lite-latest',
        stream: false,
        temperature: 0.3,
      }));
      expect(res.body.request.url).toContain('generativelanguage.googleapis.com');
    } finally {
      await teardown();
    }
  });

  it('locked overrides take precedence over client-supplied parameters', async () => {
    const { app, teardown } = await createModelConfigTestApp();
    try {
      const res = await authed(app)
        .post('/dryrun/openai/chat/completions')
        .send({
          model: 'gemini/gemini-flash-lite-latest-high',
          messages: [{ role: 'user', content: 'overrides' }],
          temperature: 0.1,
        })
        .expect(200);

      expect(res.body.request.body.temperature).toBe(0.8);
    } finally {
      await teardown();
    }
  });

  it('resolves custom provider baseUrl in dry-run output', async () => {
    const { app, teardown } = await createModelConfigTestApp();
    try {
      const res = await authed(app)
        .post('/dryrun/openai/chat/completions')
        .send({
          model: 'custom-openai/custom-alias',
          messages: [{ role: 'user', content: 'custom' }],
        })
        .expect(200);

      expect(res.body.request.url).toBe('https://custom.example.com/v1/chat/completions');
      expect(res.body.request.body.model).toBe('custom-model');
    } finally {
      await teardown();
    }
  });

  it('client payload overrides flat model defaults but not locked overrides', async () => {
    const { app, teardown } = await createModelConfigTestApp();
    try {
      const defaultsRes = await authed(app)
        .post('/dryrun/openai/chat/completions')
        .send({
          model: 'gemini/gemini-flash-lite-latest-low',
          messages: [{ role: 'user', content: 'client wins over default' }],
          temperature: 0.7,
          max_tokens: 512,
        })
        .expect(200);

      expect(defaultsRes.body.request.body.temperature).toBe(0.7);
      expect(defaultsRes.body.request.body.max_tokens).toBe(512);

      const overrideRes = await authed(app)
        .post('/dryrun/openai/chat/completions')
        .send({
          model: 'gemini/gemini-flash-lite-latest-high',
          messages: [{ role: 'user', content: 'override wins over client' }],
          temperature: 0.1,
          max_tokens: 128,
        })
        .expect(200);

      expect(overrideRes.body.request.body.temperature).toBe(0.8);
      expect(overrideRes.body.request.body.max_tokens).toBe(8192);
    } finally {
      await teardown();
    }
  });
});
