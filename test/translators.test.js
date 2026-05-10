import { describe, it, expect } from 'vitest';
import {
  translateRequest,
  translateResponse,
  translateStreamChunk,
  FORMATS,
} from '../src/translators/index.js';
import { translateClaudeToOpenAIRequest } from '../src/translators/request/claude-to-openai.js';
import { translateOpenAIToClaude } from '../src/translators/request/openai-to-claude.js';
import { translateOpenAIToGemini } from '../src/translators/request/openai-to-gemini.js';
import { translateClaudeChunkToOpenAI } from '../src/translators/response/claude-to-openai.js';
import { translateGeminiToOpenAI, translateGeminiChunkToOpenAI } from '../src/translators/response/gemini-to-openai.js';
import { translateOpenAIToClaudeResponse } from '../src/translators/response/openai-to-claude.js';

describe('Translators Comprehensive Tests', () => {
  describe('Index Router Tests', () => {
    it('should return payload if source format matches target format', () => {
      const payload = { model: 'gpt-4o' };
      expect(translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, payload)).toBe(payload);
      expect(translateResponse(FORMATS.GEMINI, FORMATS.GEMINI, payload)).toBe(payload);
    });

    it('should throw error on unsupported target request translation', () => {
      expect(() => {
        translateRequest(FORMATS.OPENAI, 'unsupported-format', {});
      }).toThrow('Unsupported request translation');
    });

    it('should throw error on unsupported target response translation', () => {
      expect(() => {
        translateResponse('unsupported-format', FORMATS.OPENAI, {});
      }).toThrow('Unsupported response translation');
    });

    it('should return chunk as is for OpenAI format stream chunk', () => {
      const chunk = { choices: [] };
      expect(translateStreamChunk(FORMATS.OPENAI, chunk, 'chunk-1')).toBe(chunk);
    });

    it('should return null for unsupported stream chunk format', () => {
      expect(translateStreamChunk('unsupported', {}, 'chunk-1')).toBeNull();
    });
  });

  describe('Request Translators', () => {
    describe('translateClaudeToOpenAIRequest', () => {
      it('should handle non-string/non-array system prompt and map maxTokens/stream correctly', () => {
        const reqBody = {
          model: 'claude-3',
          system: 12345, // invalid type, should convert to string
          max_tokens: 100,
          stream: true,
        };
        const res = translateClaudeToOpenAIRequest(reqBody);
        expect(res.messages).toEqual([{ role: 'system', content: '12345' }]);
        expect(res.maxTokens).toBe(100);
        expect(res.stream).toBe(true);
      });
    });

    describe('translateOpenAIToClaude', () => {
      it('should handle system messages of multiple types', () => {
        const req = {
          messages: [
            { role: 'system', content: 'system 1' },
            { role: 'system', content: [{ type: 'text', text: 'system 2' }] },
            { role: 'system', content: null },
            { role: 'user', content: 'hello' },
          ],
        };
        const res = translateOpenAIToClaude(req);
        expect(res.system).toBe('system 1\nsystem 2');
      });

      it('should map base64 image URL and keep other content blocks', () => {
        const req = {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'describe this image' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo' } },
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }, // not base64, keep as is
              ],
            },
          ],
        };
        const res = translateOpenAIToClaude(req);
        expect(res.messages[0].content).toEqual([
          { type: 'text', text: 'describe this image' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgo',
            },
          },
          { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
        ]);
      });
    });

    describe('translateOpenAIToGemini', () => {
      it('should handle system messages of multiple types', () => {
        const req = {
          messages: [
            { role: 'system', content: 'system 1' },
            { role: 'system', content: [{ type: 'text', text: 'system 2' }] },
            { role: 'system', content: null },
            { role: 'user', content: 'hello' },
          ],
        };
        const res = translateOpenAIToGemini(req);
        expect(res.systemInstruction.parts[0].text).toBe('system 1\nsystem 2');
      });

      it('should map base64 image URL in content array', () => {
        const req = {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'look' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
                { type: 'image_url', image_url: { url: 'http://example.com' } },
              ],
            },
          ],
        };
        const res = translateOpenAIToGemini(req);
        expect(res.contents[0].parts).toEqual([
          { text: 'look' },
          { inlineData: { mimeType: 'image/jpeg', data: 'abc' } },
          { type: 'image_url', image_url: { url: 'http://example.com' } },
        ]);
      });
    });
  });

  describe('Response Translators', () => {
    describe('translateClaudeChunkToOpenAI', () => {
      it('should return null on JSON parse error', () => {
        const res = translateClaudeChunkToOpenAI({ data: '{invalid-json' }, 'session-1');
        expect(res).toBeNull();
      });
    });

    describe('translateGeminiToOpenAI', () => {
      it('should handle candidates and parts with thought property', () => {
        const geminiRes = {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'let me think' },
                  { text: 'my final answer' },
                ],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 15,
            candidatesTokenCount: 25,
            totalTokenCount: 40,
          },
        };
        const res = translateGeminiToOpenAI(geminiRes);
        expect(res.choices[0].message).toEqual({
          role: 'assistant',
          content: 'my final answer',
          reasoning_content: 'let me think',
        });
        expect(res.choices[0].finish_reason).toBe('stop');
      });
    });

    describe('translateGeminiChunkToOpenAI', () => {
      it('should return null when text, reasoning, and finishReason are all empty', () => {
        const chunk = {
          candidates: [{ content: { parts: [{ text: '' }] } }],
        };
        const res = translateGeminiChunkToOpenAI(chunk, 'chunk-1');
        expect(res).toBeNull();
      });

      it('should collect reasoning content from parts with thought property', () => {
        const chunk = {
          candidates: [
            {
              content: {
                parts: [{ thought: true, text: 'thinking delta' }],
              },
            },
          ],
        };
        const res = translateGeminiChunkToOpenAI(chunk, 'chunk-1');
        expect(res.choices[0].delta).toEqual({
          content: null,
          reasoning_content: 'thinking delta',
        });
      });
    });

    describe('translateOpenAIToClaudeResponse', () => {
      it('should extract unclosed thought tags', () => {
        const normalized = {
          choices: [
            {
              message: {
                role: 'assistant',
                content: '<thought>still thinking...',
              },
              finish_reason: 'stop',
            },
          ],
        };
        const res = translateOpenAIToClaudeResponse(normalized);
        expect(res.content).toEqual([
          { type: 'thinking', thinking: 'still thinking...' },
          { type: 'text', text: '' },
        ]);
      });
    });
  });
});
