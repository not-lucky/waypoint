import { describe, it, expect } from 'vitest';
import { buildOpenAIChatPayload } from '../../../src/adapters/outbound/shared/openaiPayload.js';

describe('buildOpenAIChatPayload', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  }];

  it('forwards tools, tool_choice, and tool messages from clientParams', () => {
    const payload = buildOpenAIChatPayload({
      model: 'openrouter/gpt-4o',
      actualModelId: 'openai/gpt-4o',
      messages: [
        { role: 'user', content: 'read main.ts' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"main.ts"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
      ],
      clientParams: {
        model: 'openrouter/gpt-4o',
        messages: [
          { role: 'user', content: 'read main.ts' },
        ],
        tools,
        tool_choice: 'auto',
        top_p: 0.9,
      },
    }, false);

    expect(payload.model).toBe('openai/gpt-4o');
    expect(payload.stream).toBe(false);
    expect(payload.tools).toEqual(tools);
    expect(payload.tool_choice).toBe('auto');
    expect(payload.top_p).toBe(0.9);
    expect(payload.messages).toHaveLength(3);
    expect(payload.stream_options).toBeUndefined();
  });

  it('sets stream_options for streaming requests', () => {
    const payload = buildOpenAIChatPayload({
      model: 'openai/gpt-4o',
      actualModelId: 'gpt-4o',
      messages: [],
      maxTokens: 512,
      reasoningSupported: true,
      clientParams: { tools, tool_choice: 'required' },
    }, true);

    expect(payload.stream).toBe(true);
    expect(payload.stream_options).toEqual({ include_usage: true });
    expect(payload.max_tokens).toBe(512);
    expect(payload.include_reasoning).toBe(true);
    expect(payload.tool_choice).toBe('required');
  });
});
