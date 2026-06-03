import { describe, it, expect } from 'vitest';
import { StreamAccumulator } from '../../src/streaming/streamAccumulator.js';

describe('StreamAccumulator Unit Tests', () => {
  it('should initialize with defaults', () => {
    const acc = new StreamAccumulator('default-id', 'default-model');
    const resp = acc.buildNormalizedResponse();

    expect(resp.id).toBe('default-id');
    expect(resp.model).toBe('default-model');
    expect(resp.choices).toEqual([]);
    expect(resp.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it('should extract response id and model from chunk', () => {
    const acc = new StreamAccumulator();
    acc.processChunk({ id: 'chunk-id', model: 'chunk-model' });
    const resp = acc.buildNormalizedResponse();

    expect(resp.id).toBe('chunk-id');
    expect(resp.model).toBe('chunk-model');
  });

  it('should accumulate content and reasoning_content correctly', () => {
    const acc = new StreamAccumulator();

    // First chunk with text and reasoning content (reasoning is initially null)
    acc.processChunk({
      choices: [
        {
          index: 0,
          delta: {
            content: 'hello',
            reasoning_content: 'thinking part 1',
          },
        },
      ],
    });

    // Second chunk (adds to existing content and reasoning_content)
    acc.processChunk({
      choices: [
        {
          index: 0,
          delta: {
            content: ' world',
            reasoning_content: ' thinking part 2',
          },
        },
      ],
    });

    const resp = acc.buildNormalizedResponse();
    expect(resp.choices[0].message.content).toBe('hello world');
    expect(resp.choices[0].message.reasoning_content).toBe('thinking part 1 thinking part 2');
    expect(resp.choices[0].finish_reason).toBe('stop'); // default fallback
  });

  it('should capture finish_reason from stream chunks', () => {
    const acc = new StreamAccumulator();
    acc.processChunk({
      choices: [{ index: 0, finish_reason: 'length' }],
    });
    expect(acc.buildNormalizedResponse().choices[0].finish_reason).toBe('length');
  });

  it('should accumulate token usage from stream chunks', () => {
    const acc = new StreamAccumulator();

    acc.processChunk({
      usage: {
        prompt_tokens: 15,
        completion_tokens: 25,
        total_tokens: 40,
      },
    });

    const resp = acc.buildNormalizedResponse();
    expect(resp.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 25,
      total_tokens: 40,
    });

    // Test totalTokens fallback calculation when missing/falsy
    const accFallback = new StreamAccumulator();
    accFallback.processChunk({
      usage: {
        prompt_tokens: 8,
        completion_tokens: 12,
      },
    });
    expect(accFallback.buildNormalizedResponse().usage.total_tokens).toBe(20);
  });

  it('should not duplicate when OpenRouter sends reasoning and reasoning_details together', () => {
    const acc = new StreamAccumulator();
    acc.processChunk({
      choices: [{
        index: 0,
        delta: {
          reasoning: 'We',
          reasoning_details: [{ type: 'reasoning.text', text: 'We' }],
        },
      }],
    });
    acc.processChunk({
      choices: [{
        index: 0,
        delta: {
          reasoning: ' need',
          reasoning_details: [{ type: 'reasoning.text', text: ' need' }],
        },
      }],
    });

    expect(acc.buildNormalizedResponse().choices[0].message.reasoning_content).toBe('We need');
  });

  it('should accumulate reasoning_details across chunks when reasoning field is absent', () => {
    const acc = new StreamAccumulator();
    acc.processChunk({
      choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', text: 'step 1' }] } }],
    });
    acc.processChunk({
      choices: [{ index: 0, delta: { reasoning: ' step 2' } }],
    });

    expect(acc.buildNormalizedResponse().choices[0].message.reasoning_content).toBe('step 1 step 2');
  });

  it('should handle chunks without choices or delta properties, and fallback index and usage branches', () => {
    const acc = new StreamAccumulator();
    acc.processChunk({});
    acc.processChunk({ choices: [{ delta: { content: 'hello' } }] }); // choice index is undefined, falls back to 0
    acc.processChunk({ choices: [{ index: 0 }] }); // choice but no delta
    acc.processChunk({ usage: {} }); // empty usage block

    const resp = acc.buildNormalizedResponse();
    expect(resp.choices[0].message.content).toBe('hello');
    expect(resp.choices[0].message.reasoning_content).toBeUndefined();
    expect(resp.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });
});
