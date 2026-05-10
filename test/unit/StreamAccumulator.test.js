import { describe, it, expect } from 'vitest';
import { StreamAccumulator } from '../../src/utils/StreamAccumulator.js';

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

  it('should capture finish_reason and finishReason correctly', () => {
    // Test finish_reason
    const acc1 = new StreamAccumulator();
    acc1.processChunk({
      choices: [{ index: 0, finish_reason: 'length' }],
    });
    expect(acc1.buildNormalizedResponse().choices[0].finish_reason).toBe('length');

    // Test finishReason
    const acc2 = new StreamAccumulator();
    acc2.processChunk({
      choices: [{ index: 0, finishReason: 'content_filter' }],
    });
    expect(acc2.buildNormalizedResponse().choices[0].finish_reason).toBe('content_filter');
  });

  it('should handle alternative token usage structures', () => {
    const acc = new StreamAccumulator();

    // Test camelCase usage tokens
    acc.processChunk({
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
    });

    let resp = acc.buildNormalizedResponse();
    expect(resp.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });

    // Test snake_case usage tokens
    acc.processChunk({
      usage: {
        prompt_tokens: 15,
        completion_tokens: 25,
        total_tokens: 40,
      },
    });

    resp = acc.buildNormalizedResponse();
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
