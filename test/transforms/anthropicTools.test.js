import { describe, it, expect } from 'vitest';
import {
  anthropicMessageToOpenAI,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  anthropicContentToOpenAIMessage,
  openAIMessageToAnthropicContent,
  openAIMessagesToAnthropic,
  openAIToolsToAnthropic,
  openAIToolChoiceToAnthropic,
} from '../../src/transforms/shared/anthropicTools.js';

describe('anthropicTools conversions', () => {
  const tools = [{
    name: 'bash',
    description: 'Run a shell command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
    },
  }];

  it('converts tool definitions and tool_choice both ways', () => {
    expect(anthropicToolsToOpenAI(tools)).toEqual([{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command',
        parameters: tools[0].input_schema,
      },
    }]);
    expect(openAIToolsToAnthropic(anthropicToolsToOpenAI(tools))).toEqual(tools);

    expect(anthropicToolChoiceToOpenAI({ type: 'tool', name: 'bash' })).toEqual({
      type: 'function',
      function: { name: 'bash' },
    });
    expect(openAIToolChoiceToAnthropic('required')).toEqual({ type: 'any' });
  });

  it('converts assistant tool_use and user tool_result messages to OpenAI', () => {
    const openaiMessages = anthropicMessageToOpenAI({
      role: 'assistant',
      content: [
        { type: 'text', text: 'running command' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'bash',
          input: { command: 'ls' },
        },
      ],
    });

    expect(openaiMessages).toEqual([{
      role: 'assistant',
      content: 'running command',
      tool_calls: [{
        id: 'toolu_01',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"ls"}',
        },
      }],
    }]);

    expect(anthropicMessageToOpenAI({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_01',
        content: 'main.ts',
      }],
    })).toEqual([{
      role: 'tool',
      tool_call_id: 'toolu_01',
      content: 'main.ts',
    }]);
  });

  it('converts OpenAI tool history back to Anthropic messages', () => {
    const anthropicMessages = openAIMessagesToAnthropic([
      { role: 'user', content: 'list files' },
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

    expect(anthropicMessages).toEqual([
      { role: 'user', content: 'list files' },
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
    ]);
  });

  it('converts response content blocks both ways', () => {
    const openaiMessage = anthropicContentToOpenAIMessage([
      { type: 'thinking', thinking: 'planning' },
      { type: 'text', text: 'done' },
      {
        type: 'tool_use',
        id: 'toolu_02',
        name: 'read_file',
        input: { path: 'README.md' },
      },
    ]);

    expect(openaiMessage.tool_calls).toHaveLength(1);
    expect(openaiMessage.reasoning_content).toBe('planning');

    const anthropicContent = openAIMessageToAnthropicContent(openaiMessage);
    expect(anthropicContent).toEqual([
      { type: 'thinking', thinking: 'planning' },
      { type: 'text', text: 'done' },
      {
        type: 'tool_use',
        id: 'toolu_02',
        name: 'read_file',
        input: { path: 'README.md' },
      },
    ]);
  });
});
