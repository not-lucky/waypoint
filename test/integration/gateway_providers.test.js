import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createTestApp } from '../helpers/testServer.js';
import { createMSWServer } from '../helpers/mswSetup.js';

const server = createMSWServer();

function createSseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Gateway E2E Provider Integrations', () => {
  let app;
  let close;

  beforeAll(async () => {
    server.listen({
      onUnhandledRequest(req, print) {
        const url = new URL(req.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;
        print.error();
      },
    });

    // Initialize test app with default config.yaml (config.example.yaml)
    ({ app, close } = await createTestApp());
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (close) await close();
  });

  describe('Anthropic Adapter Integration', () => {
    it('translates and routes OpenAI-format completion requests to Anthropic upstream', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', async ({ request: upstreamReq }) => {
          const headers = Object.fromEntries(upstreamReq.headers.entries());
          expect(headers['x-api-key']).toBe('anthropic-key-1');
          expect(headers['anthropic-version']).toBe('2023-06-01');

          const body = await upstreamReq.json();
          expect(body.model).toBe('claude-sonnet-4-20250514');
          expect(body.messages).toEqual([{ role: 'user', content: 'hello claude' }]);
          expect(body.stream).toBe(false);

          return HttpResponse.json({
            id: 'msg_anthropic_non_stream',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-20250514',
            content: [{ type: 'text', text: 'Hello, I am Claude.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 12, output_tokens: 15 },
          });
        })
      );

      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hello claude' }],
        })
        .expect(200);

      expect(res.body.id).toBe('waypoint-msg_anthropic_non_stream');
      expect(res.body.choices[0].message.content).toBe('Hello, I am Claude.');
      expect(res.body.choices[0].finish_reason).toBe('stop');
      expect(res.body.usage.prompt_tokens).toBe(12);
      expect(res.body.usage.completion_tokens).toBe(15);
    });

    it('translates and routes OpenAI-format streaming requests to Anthropic upstream', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', async () => {
          return createSseResponse([
            'event: message_start\n' +
            'data: {"type": "message_start", "message": {"id": "msg_anthropic_stream", "type": "message", "role": "assistant", "model": "claude-sonnet-4-20250514", "usage": {"input_tokens": 10, "output_tokens": 0}}}\n\n',
            'event: content_block_start\n' +
            'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}\n\n',
            'event: content_block_delta\n' +
            'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello "}}\n\n',
            'event: content_block_delta\n' +
            'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Claude stream!"}}\n\n',
            'event: message_delta\n' +
            'data: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 8}}\n\n',
            'event: message_stop\n' +
            'data: {"type": "message_stop"}\n\n',
          ]);
        })
      );

      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hello claude stream' }],
          stream: true,
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');

      const lines = res.text.split('\n').filter(l => l.startsWith('data: '));
      const chunks = lines
        .map(line => line.replace('data: ', '').trim())
        .filter(line => line !== '[DONE]')
        .map(line => JSON.parse(line));

      expect(chunks[0].choices[0].delta.content).toBe('Hello ');
      expect(chunks[1].choices[0].delta.content).toBe('Claude stream!');
      expect(chunks[2].choices[0].finish_reason).toBe('stop');
      expect(chunks[2].usage.prompt_tokens).toBe(0);
      expect(chunks[2].usage.completion_tokens).toBe(8);
    });

    it('handles Anthropic ingress to Anthropic egress routing (passthrough mode)', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', async ({ request: upstreamReq }) => {
          const body = await upstreamReq.json();
          expect(body.model).toBe('claude-sonnet-4-20250514');
          return HttpResponse.json({
            id: 'msg_anth_pass',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Anthropic reply' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 5 },
          });
        })
      );

      const res = await request(app)
        .post('/v1/messages')
        .set('x-api-key', 'mock-webui-token')
        .send({
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hello in anthropic shape' }],
          max_tokens: 100,
        })
        .expect(200);

      expect(res.body.id).toBe('waypoint-msg_anth_pass');
      expect(res.body.content[0].text).toBe('Anthropic reply');
    });
  });

  describe('Gemini Adapter Integration', () => {
    it('translates and routes non-reasoning models to native Gemini generateContent API', async () => {
      server.use(
        http.post('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', async ({ request: upstreamReq }) => {
          const url = new URL(upstreamReq.url);
          expect(url.searchParams.get('key')).toBe('gemini-key-1');

          const body = await upstreamReq.json();
          expect(body.contents[0].role).toBe('user');
          expect(body.contents[0].parts[0].text).toBe('hello gemini');

          return HttpResponse.json({
            candidates: [{
              content: {
                parts: [{ text: 'Hello, I am Gemini.' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            }],
            usageMetadata: {
              promptTokenCount: 15,
              candidatesTokenCount: 20,
              totalTokenCount: 35,
            },
          });
        })
      );

      // 'flash' alias maps to gemini-2.0-flash with reasoningSupported: false
      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'gemini/flash',
          messages: [{ role: 'user', content: 'hello gemini' }],
        })
        .expect(200);

      expect(res.body.id).toContain('waypoint-');
      expect(res.body.choices[0].message.content).toBe('Hello, I am Gemini.');
      expect(res.body.choices[0].finish_reason).toBe('stop');
      expect(res.body.usage.prompt_tokens).toBe(15);
      expect(res.body.usage.completion_tokens).toBe(20);
    });

    it('translates and routes non-reasoning streaming requests to native Gemini streamGenerateContent', async () => {
      server.use(
        http.post('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent', async () => {
          return createSseResponse([
            'data: {"candidates": [{"content": {"parts": [{"text": "Hello "}], "role": "model"}, "index": 0}]}\n\n',
            'data: {"candidates": [{"content": {"parts": [{"text": "Gemini stream!"}], "role": "model"}, "finishReason": "STOP", "index": 0}], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 10, "totalTokenCount": 20}}\n\n',
          ]);
        })
      );

      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'gemini/flash',
          messages: [{ role: 'user', content: 'hello stream gemini' }],
          stream: true,
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');

      const lines = res.text.split('\n').filter(l => l.startsWith('data: '));
      const chunks = lines
        .map(line => line.replace('data: ', '').trim())
        .filter(line => line !== '[DONE]')
        .map(line => JSON.parse(line));

      expect(chunks[0].choices[0].delta.content).toBe('Hello ');
      expect(chunks[1].choices[0].delta.content).toBe('Gemini stream!');
      expect(chunks[1].choices[0].finish_reason).toBe('stop');
      expect(chunks[1].usage.prompt_tokens).toBe(10);
      expect(chunks[1].usage.completion_tokens).toBe(10);
    });

    it('translates and routes reasoning models via OpenAI-compatibility endpoint with thinking_config', async () => {
      server.use(
        http.post('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', async ({ request: upstreamReq }) => {
          const headers = Object.fromEntries(upstreamReq.headers.entries());
          expect(headers.authorization).toBe('Bearer gemini-key-1');

          const body = await upstreamReq.json();
          expect(body.model).toBe('gemini-flash-lite-latest');
          expect(body.extra_body.google.thinking_config.thinking_level).toBe('low');

          return HttpResponse.json({
            id: 'chatcmpl-gemini-cot',
            object: 'chat.completion',
            model: 'gemini-flash-lite-latest',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '<thought>Let me verify the math: 2+2=4</thought>The answer is 4.',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
          });
        })
      );

      // 'gemini-flash-lite-latest-low' alias has reasoningSupported: true, reasoningEffort: 'low'
      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'gemini/gemini-flash-lite-latest-low',
          messages: [{ role: 'user', content: '2+2' }],
        })
        .expect(200);

      expect(res.body.choices[0].message.content).toBe('The answer is 4.');
      expect(res.body.choices[0].message.reasoning_content).toBe('Let me verify the math: 2+2=4');
    });

    it('translates and routes reasoning model streaming requests splitting content and reasoning_content', async () => {
      server.use(
        http.post('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', async () => {
          return createSseResponse([
            'data: {"id": "cot-stream-1", "choices": [{"index": 0, "delta": {"content": "<thought>Thinking details"}, "finish_reason": null}]}\n\n',
            'data: {"id": "cot-stream-2", "choices": [{"index": 0, "delta": {"content": " here</thought>Final content"}, "finish_reason": null}]}\n\n',
            'data: {"id": "cot-stream-3", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 15, "completion_tokens": 25, "total_tokens": 40}}\n\n',
            'data: [DONE]\n\n',
          ]);
        })
      );

      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'gemini/gemini-flash-lite-latest-low',
          messages: [{ role: 'user', content: 'thinking stream please' }],
          stream: true,
        })
        .expect(200);

      const lines = res.text.split('\n').filter(l => l.startsWith('data: '));
      const chunks = lines.map(line => {
        try {
          return JSON.parse(line.replace('data: ', ''));
        } catch {
          return null;
        }
      }).filter(Boolean);

      // Verify reasoning_content and content extraction across stream chunks
      let accumulatedReasoning = '';
      let accumulatedContent = '';
      for (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta;
        if (delta) {
          if (delta.reasoning_content) accumulatedReasoning += delta.reasoning_content;
          if (delta.content) accumulatedContent += delta.content;
        }
      }

      expect(accumulatedReasoning).toBe('Thinking details here');
      expect(accumulatedContent).toBe('Final content');
    });
  });

  describe('Custom Compatible Providers', () => {
    it('routes to custom OpenAI compatible model and supports extractReasoningFromThinkBlocks', async () => {
      server.use(
        http.post('https://api.openai.com/v1/chat/completions', async ({ request: upstreamReq }) => {
          const body = await upstreamReq.json();
          expect(body.model).toBe('minimax-m3');

          return HttpResponse.json({
            id: 'chatcmpl-minimax-123',
            object: 'chat.completion',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '<think>Let me formulate advice</think>My custom advice is here.',
              },
              finish_reason: 'stop',
            }],
          });
        })
      );

      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'custom-openai/minimax-m3',
          messages: [{ role: 'user', content: 'give advice' }],
        })
        .expect(200);

      expect(res.body.choices[0].message.content).toBe('My custom advice is here.');
      expect(res.body.choices[0].message.reasoning_content).toBe('Let me formulate advice');
    });

    it('routes to custom Anthropic compatible model', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', async ({ request: upstreamReq }) => {
          const body = await upstreamReq.json();
          expect(body.model).toBe('claude-sonnet-4');

          return HttpResponse.json({
            id: 'msg_custom_anth',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Custom anthropic response' }],
            stop_reason: 'end_turn',
          });
        })
      );

      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'custom-anthropic/custom-sonnet',
          messages: [{ role: 'user', content: 'custom anthropic please' }],
        })
        .expect(200);

      expect(res.body.choices[0].message.content).toBe('Custom anthropic response');
    });
  });

  describe('Cloudflare Provider Adapter Settings', () => {
    it('correctly maps Cloudflare account scope credentials', async () => {
      // Initialize a custom app instance specifically to configure the cloudflare provider
      const customConfig = {
        gateway: { port: 0, globalRetryLimit: 1 },
        logging: { enableConsole: false, enableFile: false, format: 'json' },
        clients: [{ name: 'test', token: 'token-cf' }],
        providers: {
          cloudflare: {
            keys: [
              { apiKey: 'cf-key-secret', accountId: 'cf-acct-12345' },
            ],
            models: [
              { modelid: '@cf/meta/llama-3.1-8b-instruct', aliases: ['cf-llama'] },
            ],
          },
        },
      };

      const { app: cfApp, close: cfClose } = await createTestApp({ config: customConfig });

      server.use(
        http.post('https://api.cloudflare.com/client/v4/accounts/cf-acct-12345/ai/v1/chat/completions', async ({ request: upstreamReq }) => {
          const headers = Object.fromEntries(upstreamReq.headers.entries());
          expect(headers.authorization).toBe('Bearer cf-key-secret');

          const body = await upstreamReq.json();
          expect(body.model).toBe('@cf/meta/llama-3.1-8b-instruct');

          return HttpResponse.json({
            id: 'cf-completions-123',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Cloudflare response.' },
              finish_reason: 'stop',
            }],
          });
        })
      );

      try {
        const res = await request(cfApp)
          .post('/chat/completions')
          .set('Authorization', 'Bearer token-cf')
          .send({
            model: 'cloudflare/cf-llama',
            messages: [{ role: 'user', content: 'cf message' }],
          })
          .expect(200);

        expect(res.body.choices[0].message.content).toBe('Cloudflare response.');
      } finally {
        await cfClose();
      }
    });

    it('correctly routes Cloudflare streaming completions and uses credentials', async () => {
      const customConfig = {
        gateway: { port: 0, globalRetryLimit: 1 },
        logging: { enableConsole: false, enableFile: false, format: 'json' },
        clients: [{ name: 'test', token: 'token-cf' }],
        providers: {
          cloudflare: {
            keys: [
              { apiKey: 'cf-key-secret-stream', accountId: 'cf-acct-54321' },
            ],
            models: [
              { modelid: '@cf/meta/llama-3.1-8b-instruct', aliases: ['cf-llama'] },
            ],
          },
        },
      };

      const { app: cfApp, close: cfClose } = await createTestApp({ config: customConfig });

      server.use(
        http.post('https://api.cloudflare.com/client/v4/accounts/cf-acct-54321/ai/v1/chat/completions', async ({ request: upstreamReq }) => {
          const headers = Object.fromEntries(upstreamReq.headers.entries());
          expect(headers.authorization).toBe('Bearer cf-key-secret-stream');

          const body = await upstreamReq.json();
          expect(body.stream).toBe(true);

          return createSseResponse([
            'data: {"id": "cf-chunk-1", "choices": [{"index": 0, "delta": {"content": "Hello Cloudflare"}, "finish_reason": null}]}\n\n',
            'data: {"id": "cf-chunk-2", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}\n\n',
            'data: [DONE]\n\n',
          ]);
        })
      );

      try {
        const res = await request(cfApp)
          .post('/chat/completions')
          .set('Authorization', 'Bearer token-cf')
          .send({
            model: 'cloudflare/cf-llama',
            messages: [{ role: 'user', content: 'cf message stream' }],
            stream: true,
          })
          .expect(200);

        expect(res.text).toContain('Hello Cloudflare');
      } finally {
        await cfClose();
      }
    });
  });

  describe('Anthropic & Custom Compatible Stream Reasoning Integration', () => {
    it('translates Anthropic streaming response thinking blocks to standard reasoning_content', async () => {
      server.use(
        http.post('https://api.anthropic.com/v1/messages', async () => {
          return createSseResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_anth_thinking","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think about this..."}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The final answer is hello."}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]);
        })
      );

      const res = await request(app)
        .post('/chat/completions')
        .set('Authorization', 'Bearer mock-webui-token')
        .send({
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'thinking please' }],
          stream: true,
        })
        .expect(200);

      const lines = res.text.split('\n').filter(l => l.startsWith('data: '));
      const chunks = lines.map(line => {
        try {
          return JSON.parse(line.replace('data: ', ''));
        } catch {
          return null;
        }
      }).filter(Boolean);

      let accumulatedReasoning = '';
      let accumulatedContent = '';
      for (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta;
        if (delta) {
          if (delta.reasoning_content) accumulatedReasoning += delta.reasoning_content;
          if (delta.content) accumulatedContent += delta.content;
        }
      }

      expect(accumulatedReasoning).toBe('Let me think about this...');
      expect(accumulatedContent).toBe('The final answer is hello.');
    });

    it('extracts reasoning from think blocks on custom compatible streaming requests', async () => {
      const customConfig = {
        gateway: { port: 0, globalRetryLimit: 1 },
        logging: { enableConsole: false, enableFile: false, format: 'json' },
        clients: [{ name: 'test', token: 'token-custom' }],
        providers: {
          'custom-provider': {
            type: 'openai-compatible',
            baseUrl: 'https://custom-openai.example/v1',
            keys: ['key-custom'],
            models: [{
              modelid: 'custom-model',
              extractReasoningFromThinkBlocks: true,
            }],
          },
        },
      };

      const { app: customApp, close: customClose } = await createTestApp({ config: customConfig });

      server.use(
        http.post('https://custom-openai.example/v1/chat/completions', async () => {
          return createSseResponse([
            'data: {"id": "chunk1", "choices": [{"index": 0, "delta": {"content": "<think>Let me formulate advice"}, "finish_reason": null}]}\n\n',
            'data: {"id": "chunk2", "choices": [{"index": 0, "delta": {"content": "</think>My advice is here."}, "finish_reason": "stop"}]}\n\n',
            'data: [DONE]\n\n',
          ]);
        })
      );

      try {
        const res = await request(customApp)
          .post('/chat/completions')
          .set('Authorization', 'Bearer token-custom')
          .send({
            model: 'custom-provider/custom-model',
            messages: [{ role: 'user', content: 'custom advice please' }],
            stream: true,
          })
          .expect(200);

        const lines = res.text.split('\n').filter(l => l.startsWith('data: '));
        const chunks = lines.map(line => {
          try {
            return JSON.parse(line.replace('data: ', ''));
          } catch {
            return null;
          }
        }).filter(Boolean);

        let accumulatedReasoning = '';
        let accumulatedContent = '';
        for (const chunk of chunks) {
          const delta = chunk.choices[0]?.delta;
          if (delta) {
            if (delta.reasoning_content) accumulatedReasoning += delta.reasoning_content;
            if (delta.content) accumulatedContent += delta.content;
          }
        }

        expect(accumulatedReasoning).toBe('Let me formulate advice');
        expect(accumulatedContent).toBe('My advice is here.');
      } finally {
        await customClose();
      }
    });
  });
});

