import { describe, it, expect } from 'vitest';
import { mergeToolCallDeltas } from '../../src/adapters/outbound/shared/openaiToolCalls.js';

describe('mergeToolCallDeltas', () => {
  it('assembles streaming tool call fragments by index', () => {
    let merged = null;

    merged = mergeToolCallDeltas(merged, [{
      index: 0,
      id: 'call_abc',
      type: 'function',
      function: { name: 'read', arguments: '' },
    }]);
    merged = mergeToolCallDeltas(merged, [{
      index: 0,
      function: { arguments: '{"path":"' },
    }]);
    merged = mergeToolCallDeltas(merged, [{
      index: 0,
      function: { arguments: 'src/main.ts"}' },
    }]);

    expect(merged).toEqual([{
      index: 0,
      id: 'call_abc',
      type: 'function',
      function: {
        name: 'read',
        arguments: '{"path":"src/main.ts"}',
      },
    }]);
  });

  it('merges multiple tool calls in parallel', () => {
    const merged = mergeToolCallDeltas(null, [
      { index: 0, id: 'call_1', function: { name: 'a', arguments: '{}' } },
      { index: 1, id: 'call_2', function: { name: 'b', arguments: '{}' } },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe('call_1');
    expect(merged[1].id).toBe('call_2');
  });
});
