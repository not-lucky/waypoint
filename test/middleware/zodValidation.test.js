import { describe, it, expect } from 'vitest';
import { anthropicMessagesSchema, completionSchema } from '../../src/infrastructure/web/middleware/zodValidation.js';

describe('completionSchema tool calling', () => {
  const baseTools = [{
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  }];

  it('accepts tools, tool_choice, and tool role messages', () => {
    const result = completionSchema.safeParse({
      model: 'openai/gpt-4o',
      tools: baseTools,
      tool_choice: 'auto',
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"ls"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'main.ts\npackage.json' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts required tool_choice and passthrough provider params', () => {
    const result = completionSchema.safeParse({
      model: 'openai/gpt-4o',
      tools: baseTools,
      tool_choice: 'required',
      top_p: 0.8,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.success).toBe(true);
  });

  it('rejects tool messages without tool_call_id', () => {
    const result = completionSchema.safeParse({
      model: 'openai/gpt-4o',
      messages: [{ role: 'tool', content: 'result' }],
    });

    expect(result.success).toBe(false);
  });

  it('accepts pi-style developer role and content part arrays', () => {
    const result = completionSchema.safeParse({
      model: 'openrouter/nex-n2-pro',
      stream: true,
      tools: baseTools,
      tool_choice: 'auto',
      messages: [
        { role: 'developer', content: 'You are a coding agent.' },
        { role: 'user', content: [{ type: 'text', text: 'list files in this directory' }] },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts multimodal user content blocks', () => {
    const result = completionSchema.safeParse({
      model: 'openai/gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      }],
    });

    expect(result.success).toBe(true);
  });
});

describe('anthropicMessagesSchema tool calling', () => {
  it('accepts Anthropic tools, tool_choice, and tool_result messages', () => {
    const result = anthropicMessagesSchema.safeParse({
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

    expect(result.success).toBe(true);
  });
});
