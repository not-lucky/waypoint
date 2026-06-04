import { describe, it, expect } from 'vitest';
import { completionSchema } from '../../src/middleware/zodValidation.js';

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
});
