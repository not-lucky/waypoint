import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { OpenAIController } from '../../../src/adapters/inbound/openai/index.js';
import { AnthropicController } from '../../../src/adapters/inbound/anthropic/index.js';

const testConfig = {
  providers: {
    gemini: {
      keys: ['gemini-key-1'],
      models: [{
        id: 'gemini-2.5-pro-preview-05-06',
        aliases: ['gemini-2.5-pro', 'pro'],
        reasoningSupported: true,
        reasoningEffort: 'medium',
        fallbackModel: 'openai/gpt-4o',
      }],
    },
    openai: {
      keys: ['openai-key-1'],
      models: [{ id: 'gpt-4o', aliases: ['gpt4'] }],
    },
  },
};

const mockJsonRes = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
});

const mockStreamRes = () => ({
  setHeader: vi.fn(),
  write: vi.fn(),
  end: vi.fn(),
});

describe('Protocol Controllers', () => {
  let mockOrchestrator;

  beforeEach(() => {
    mockOrchestrator = {
      config: testConfig,
      executeCompletion: vi.fn().mockResolvedValue({
        id: 'waypoint-123',
        object: 'chat.completion',
        created: 123456,
        model: 'gemini/gemini-2.5-pro',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'hello from assistant',
            reasoning_content: 'thinking details',
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
    };
  });

  describe('shared request handling', () => {
    it('resolves configured models and applies model defaults', async () => {
      const controller = new OpenAIController(mockOrchestrator);
      await controller.handleCompletion(
        { body: { model: 'gemini/gemini-2.5-pro' }, headers: {} },
        mockJsonRes(),
      );

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gemini',
          actualModelId: 'gemini-2.5-pro-preview-05-06',
          fallbackModel: 'openai/gpt-4o',
          reasoningSupported: true,
          reasoningEffort: 'medium',
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('forwards orchestrator errors and handles thrown exceptions', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValueOnce({
        error: {
          code: 'poolUnavailable',
          message: 'All keys in cooldown',
          httpStatus: 503,
        },
      });

      const controller = new OpenAIController(mockOrchestrator);
      const res = mockJsonRes();
      await controller.handleCompletion({ body: { model: 'gpt-4o' }, headers: {} }, res);
      expect(res.status).toHaveBeenCalledWith(503);

      mockOrchestrator.executeCompletion.mockRejectedValueOnce(new Error('Database crash'));
      const res2 = mockJsonRes();
      await controller.handleCompletion({ body: { model: 'gpt-4o' }, headers: {} }, res2);
      expect(res2.status).toHaveBeenCalledWith(500);
      expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'internalServerError' }),
      }));
    });
  });

  describe('OpenAIController', () => {
    it('maps token limits and tolerates missing messages', async () => {
      const controller = new OpenAIController(mockOrchestrator);

      await controller.handleCompletion(
        { body: { model: 'gpt-4o', max_tokens: 150 }, headers: {} },
        mockJsonRes(),
      );
      expect(mockOrchestrator.executeCompletion).toHaveBeenLastCalledWith(
        expect.objectContaining({ maxTokens: 150 }),
        expect.any(Object),
        expect.any(Object),
      );

      await controller.handleCompletion(
        { body: { model: 'gpt-4o', max_completion_tokens: 250 }, headers: {} },
        mockJsonRes(),
      );
      expect(mockOrchestrator.executeCompletion).toHaveBeenLastCalledWith(
        expect.objectContaining({ maxTokens: 250 }),
        expect.any(Object),
        expect.any(Object),
      );

      await controller.handleCompletion({ headers: {} }, mockJsonRes());
      expect(mockOrchestrator.executeCompletion).toHaveBeenLastCalledWith(
        expect.objectContaining({ messages: [] }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('streams OpenAI SSE chunks and survives mid-stream failures', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          yield { id: 'chatcmpl-123', choices: [{ index: 0, delta: { content: 'hello' } }] };
          throw new Error('Mid-stream failure');
        },
      });

      const controller = new OpenAIController(mockOrchestrator);
      const res = mockStreamRes();
      await expect(controller.handleCompletion(
        { body: { model: 'gpt-4o', stream: true }, headers: {} },
        res,
      )).resolves.not.toThrow();

      expect(res.write).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();

      const errorWrite = res.write.mock.calls.find(([payload]) => (
        typeof payload === 'string' && payload.includes('"error"')
      ));
      expect(errorWrite).toBeDefined();
      const jsonMatch = errorWrite[0].match(/^data: (.+?)\n\n/);
      expect(jsonMatch).toBeTruthy();
      const parsed = JSON.parse(jsonMatch[1]);
      expect(parsed.error.code).toBeDefined();
      expect(parsed.error.type).toBeDefined();
    });
  });

  describe('AnthropicController', () => {
    it('prepends system prompts into the unified message list', async () => {
      const controller = new AnthropicController(mockOrchestrator);

      await controller.handleCompletion({
        body: {
          model: 'pro',
          system: [{ type: 'text', text: 'instruction 1' }, { type: 'text', text: 'instruction 2' }],
          messages: [{ role: 'user', content: 'hi' }],
        },
        headers: {},
      }, mockJsonRes());

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'instruction 1\ninstruction 2' },
            { role: 'user', content: 'hi' },
          ],
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('translates unified responses into Anthropic message format', async () => {
      const controller = new AnthropicController(mockOrchestrator);
      const res = mockJsonRes();

      await controller.handleCompletion(
        { body: { model: 'gemini/gemini-2.5-pro' }, headers: {} },
        res,
      );

      expect(res.json).toHaveBeenCalledWith({
        id: 'waypoint-123',
        type: 'message',
        role: 'assistant',
        model: 'gemini/gemini-2.5-pro',
        content: [
          { type: 'thinking', thinking: 'thinking details' },
          { type: 'text', text: 'hello from assistant' },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      });
    });

    it('streams Anthropic SSE events', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          yield {
            id: 'waypoint-chunk-1',
            choices: [{ index: 0, delta: { content: 'hello' } }],
          };
        },
      });

      const controller = new AnthropicController(mockOrchestrator);
      const res = mockStreamRes();

      await controller.handleCompletion(
        { body: { model: 'pro', stream: true }, headers: {} },
        res,
      );

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('message_start'));
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('content_block_delta'));
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('message_stop'));
      expect(res.end).toHaveBeenCalled();
    });
  });
});
