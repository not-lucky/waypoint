import { describe, it, expect } from 'vitest';
import {
  translateRequest,
  translateResponse,
  translateStreamChunk,
  FORMATS,
} from '../../src/translators/index.js';
import { translateClaudeToOpenAIRequest } from '../../src/translators/request/claudeToOpenai.js';
import { translateOpenAIToClaude } from '../../src/translators/request/openaiToClaude.js';
import { translateOpenAIToGemini } from '../../src/translators/request/openaiToGemini.js';
import { translateClaudeChunkToOpenAI } from '../../src/translators/response/claudeToOpenai.js';
import { translateGeminiToOpenAI, translateGeminiChunkToOpenAI } from '../../src/translators/response/geminiToOpenai.js';
import { translateOpenAIToClaudeResponse } from '../../src/translators/response/openaiToClaude.js';

describe('Translators', () => {
  it('routes hub translations and rejects unsupported formats', () => {
    const payload = { model: 'gpt-4o' };
    expect(translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, payload)).toBe(payload);
    expect(translateResponse(FORMATS.GEMINI, FORMATS.GEMINI, payload)).toBe(payload);

    expect(() => translateRequest(FORMATS.OPENAI, 'unsupported-format', {}))
      .toThrow('Unsupported request translation');
    expect(() => translateResponse('unsupported-format', FORMATS.OPENAI, {}))
      .toThrow('Unsupported response translation');
    expect(translateStreamChunk('unsupported', {}, 'chunk-1')).toBeNull();
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
        { role: 'system', content: [{ type: 'text', text: 'system 2' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this image' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo' } },
          ],
        },
      ],
      reasoningSupported: true,
      reasoningEffort: 'low',
      maxTokens: 500,
      stream: true,
      temperature: 0.8,
    });

    expect(res.system).toBe('system 1\nsystem 2');
    expect(res.stream).toBe(true);
    expect(res.temperature).toBe(0.8);
    expect(res.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(res.max_tokens).toBe(3072);
    expect(res.messages[0].content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgo',
      },
    });
  });

  it('translates unified requests to Gemini contents and generation config', () => {
    const res = translateOpenAIToGemini({
      messages: [
        { role: 'system', content: 'system 1' },
        { role: 'system', content: 'system 2' },
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

    expect(res.systemInstruction.parts[0].text).toBe('system 1\nsystem 2');
    expect(res.generationConfig).toEqual({
      temperature: 0.7,
      maxOutputTokens: 100,
    });
    expect(res.contents[0].parts).toEqual([
      { text: 'look' },
      { inlineData: { mimeType: 'image/jpeg', data: 'abc' } },
    ]);
  });

  it('translates Gemini responses and stream chunks into OpenAI shape', () => {
    const response = translateGeminiToOpenAI({
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'let me think' },
            { text: 'my final answer' },
          ],
        },
        finishReason: 'STOP',
        index: 0,
      }],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 25,
      },
    });

    expect(response.choices[0].message).toEqual({
      role: 'assistant',
      content: 'my final answer',
      reasoning_content: 'let me think',
    });

    const chunk = translateGeminiChunkToOpenAI({
      candidates: [{
        content: {
          parts: [{ thought: true, text: 'thinking delta' }],
        },
      }],
    }, 'chunk-1');

    expect(chunk.choices[0].delta).toEqual({
      content: null,
      reasoning_content: 'thinking delta',
    });

    expect(translateGeminiChunkToOpenAI({
      candidates: [{ content: { parts: [{ text: '' }] } }],
    }, 'chunk-1')).toBeNull();
  });

  it('translates Anthropic ingress tool history into the OpenAI hub shape', () => {
    const res = translateClaudeToOpenAIRequest({
      model: 'claude-sonnet-4',
      max_tokens: 1024,
      tools: [{
        name: 'bash',
        input_schema: { type: 'object', properties: {} },
      }],
      tool_choice: { type: 'auto' },
      messages: [
        { role: 'user', content: 'run ls' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_01',
            name: 'bash',
            input: { command: 'ls' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: 'main.ts',
          }],
        },
      ],
    });

    expect(res.tools).toEqual([{
      type: 'function',
      function: {
        name: 'bash',
        parameters: { type: 'object', properties: {} },
      },
    }]);
    expect(res.messages).toEqual([
      { role: 'user', content: 'run ls' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'toolu_01',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'toolu_01', content: 'main.ts' },
    ]);
  });

  it('translates Anthropic stream chunks and egress responses', () => {
    expect(translateClaudeChunkToOpenAI({ data: '{invalid-json' }, 'session-1')).toBeNull();

    const toolStart = translateClaudeChunkToOpenAI({
      data: JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'bash',
          input: {},
        },
      }),
    }, 'session-1');
    expect(toolStart.choices[0].delta.tool_calls[0].function.name).toBe('bash');

    const toolDelta = translateClaudeChunkToOpenAI({
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
      }),
    }, 'session-1');
    expect(toolDelta.choices[0].delta.tool_calls[0].function.arguments).toBe('{"command":"ls"}');

    const response = translateOpenAIToClaudeResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: '<thought>still thinking...',
        },
        finish_reason: 'stop',
      }],
    });

    expect(response.content).toEqual([
      { type: 'thinking', thinking: 'still thinking...' },
      { type: 'text', text: '' },
    ]);
  });
});
