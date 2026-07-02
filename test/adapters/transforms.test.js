import { describe, it, expect } from 'vitest';
import {
  translateRequest,
  translateResponse,
  translateError,
  FORMATS,
} from '../../src/adapters/transforms/index.js';
import { translateClaudeToOpenAIRequest } from '../../src/adapters/transforms/request/claudeToOpenai.js';
import { translateOpenAIToClaude } from '../../src/adapters/transforms/request/openaiToClaude.js';
import { translateOpenAIToGemini } from '../../src/adapters/transforms/request/openaiToGemini.js';
import { translateGeminiToOpenAI, translateGeminiChunkToOpenAI } from '../../src/adapters/transforms/response/geminiToOpenai.js';
import {
  anthropicMessageToOpenAI,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  openAIMessagesToAnthropic,
  openAIToolsToAnthropic,
} from '../../src/adapters/transforms/shared/anthropicTools.js';
import { buildClientErrorEnvelope } from '../../src/domain/errors/envelope.js';

describe('Hub Format & Request/Response Translators', () => {
  it('routes hub translations and rejects unsupported formats', () => {
    const payload = { model: 'gpt-4o' };
    expect(translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, payload)).toBe(payload);
    expect(translateResponse(FORMATS.GEMINI, FORMATS.GEMINI, payload)).toBe(payload);

    expect(() => translateRequest(FORMATS.OPENAI, 'unsupported', {}))
      .toThrow('Unsupported request translation');
    expect(() => translateResponse('unsupported', FORMATS.OPENAI, {}))
      .toThrow('Unsupported response translation');
  });

  it('translates Claude ingress requests into the unified OpenAI shape', () => {
    const res = translateClaudeToOpenAIRequest({
      model: 'claude-3',
      system: [{ type: 'text', text: 'be helpful' }],
      max_tokens: 100,
      stream: true,
    });
    expect(res.messages).toEqual([{ role: 'system', content: 'be helpful' }]);
    expect(res.maxTokens).toBe(100);
    expect(res.stream).toBe(true);
  });

  it('translates unified requests to Anthropic with thinking and media support', () => {
    const res = translateOpenAIToClaude({
      messages: [
        { role: 'system', content: 'system 1' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw' } },
          ],
        },
      ],
      reasoningSupported: true,
      reasoningEffort: 'low',
      maxTokens: 500,
    });

    expect(res.system).toBe('system 1');
    expect(res.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(res.messages[0].content[1].type).toBe('image');
  });

  it('translates unified requests to Gemini contents and generation config', () => {
    const res = translateOpenAIToGemini({
      messages: [
        { role: 'system', content: 'system instruction' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
          ],
        },
      ],
      temperature: 0.7,
      maxTokens: 100,
    });

    expect(res.systemInstruction.parts[0].text).toBe('system instruction');
    expect(res.generationConfig.temperature).toBe(0.7);
    expect(res.contents[0].parts[1].inlineData.mimeType).toBe('image/jpeg');
  });

  it('translates Gemini responses and stream chunks into OpenAI shape', () => {
    const response = translateGeminiToOpenAI({
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'let me think' },
            { text: 'final' },
          ],
        },
        finishReason: 'STOP',
        index: 0,
      }],
    });
    expect(response.choices[0].message).toEqual({
      role: 'assistant',
      content: 'final',
      reasoning_content: 'let me think',
    });

    const chunk = translateGeminiChunkToOpenAI({
      candidates: [{
        content: { parts: [{ thought: true, text: 'thinking delta' }] },
      }],
    }, 'chunk-1');
    expect(chunk.choices[0].delta.reasoning_content).toBe('thinking delta');
  });
});

describe('Anthropic Tool Calling translation', () => {
  const tools = [{
    name: 'bash',
    description: 'Run bash',
    input_schema: { type: 'object', properties: {} },
  }];

  it('translates tool definitions and choices both ways', () => {
    const openaiTools = openAIToolsToAnthropic(anthropicToolsToOpenAI(tools));
    expect(openaiTools).toEqual(tools);

    expect(anthropicToolChoiceToOpenAI({ type: 'tool', name: 'bash' })).toEqual({
      type: 'function',
      function: { name: 'bash' },
    });
  });

  it('translates messages with tool use and results both ways', () => {
    const openaiMessages = anthropicMessageToOpenAI({
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'ls' } },
      ],
    });
    expect(openaiMessages[0].tool_calls[0].id).toBe('u1');

    const anthropicMessages = openAIMessagesToAnthropic([
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'u1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'u1', content: 'output' },
    ]);
    expect(anthropicMessages[1].content[0].type).toBe('tool_use');
    expect(anthropicMessages[2].content[0].type).toBe('tool_result');
  });
});

describe('translateError Cross-Protocol Error Projection', () => {
  const OPENAI_ERROR = {
    message: 'Too many requests',
    statusCode: 429,
    errorCode: 'rate_limit_exceeded',
    errorType: 'api_error',
    retryAfterSeconds: 15,
    provider: 'openai',
    upstreamBody: { error: { message: 'Too many requests', code: 'rate_limit_exceeded' } },
  };

  it('translates OpenAI error to OpenAi/Anthropic/Gemini ingress shape preserving data', () => {
    const targetFormats = [FORMATS.OPENAI, FORMATS.ANTHROPIC, FORMATS.GEMINI];
    for (const target of targetFormats) {
      const translated = translateError(FORMATS.OPENAI, target, OPENAI_ERROR);
      expect(translated.statusCode).toBe(429);
      expect(translated.message).toBe('Too many requests');
      expect(translated.upstreamCode).toBe('rate_limit_exceeded');
      expect(translated.retryAfterSeconds).toBe(15);
    }
  });

  it('translates Gemini to OpenAI error shape and constructs error envelope', () => {
    const geminiErr = {
      message: 'Not found',
      statusCode: 404,
      errorCode: 'NOT_FOUND',
      provider: 'gemini',
      upstreamBody: { error: { message: 'Not found', status: 'NOT_FOUND' } },
    };
    const translated = translateError(FORMATS.GEMINI, FORMATS.OPENAI, geminiErr);
    const envelope = buildClientErrorEnvelope({
      statusCode: translated.statusCode,
      message: translated.message,
      errorCode: translated.code,
      errorType: translated.type,
      provider: translated.provider,
    });
    expect(envelope.error.code).toBe('NOT_FOUND');
    expect(envelope.error.type).toBe('not_found_error');
  });

  it('falls back to upstream_error when code is missing', () => {
    const emptyErr = {
      message: 'Unknown failure',
      statusCode: 500,
      provider: 'openai',
      upstreamBody: {},
    };
    const translated = translateError(FORMATS.OPENAI, FORMATS.OPENAI, emptyErr);
    expect(translated.code).toBe('upstream_error');
  });
});
