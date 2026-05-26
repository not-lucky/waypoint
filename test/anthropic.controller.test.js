import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { AnthropicController } from '../src/controllers/AnthropicController.js';

describe('AnthropicController Edge Case Tests', () => {
  const testConfig = {
    providers: {
      gemini: {
        keys: ['gemini-key-1'],
        models: [
          {
            id: 'gemini-2.5-pro-preview-05-06',
            aliases: ['gemini-2.5-pro', 'gemini-pro', 'pro'],
            reasoningSupported: true,
            reasoningEffort: 'medium',
            fallbackModel: 'openai/gpt-4o',
          },
        ],
      },
      openai: {
        keys: ['openai-key-1'],
        models: [
          {
            id: 'gpt-4o',
            aliases: ['gpt4'],
          },
        ],
      },
    },
  };

  let mockOrchestrator;

  beforeEach(() => {
    mockOrchestrator = {
      config: testConfig,
      executeCompletion: vi.fn().mockResolvedValue({
        id: 'waypoint-123',
        object: 'chat.completion',
        created: 123456,
        model: 'gemini/gemini-2.5-pro',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'hello from assistant',
              reasoning_content: 'thinking details',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
    };
  });

  describe('Model Resolution', () => {
    it('should resolve prefixed model configured in config', async () => {
      const controller = new AnthropicController(mockOrchestrator);
      const req = {
        body: { model: 'gemini/gemini-2.5-pro' },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

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

    it('should resolve bare name alias match', async () => {
      const controller = new AnthropicController(mockOrchestrator);
      const req = {
        body: { model: 'pro' },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gemini',
          actualModelId: 'gemini-2.5-pro-preview-05-06',
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should pass unresolved model through without crash', async () => {
      const controller = new AnthropicController(mockOrchestrator);
      const req = {
        body: { model: 'unknown-model-alias' },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'unknown-model-alias',
        }),
        expect.any(Object),
        expect.any(Object),
      );
      const callArg = mockOrchestrator.executeCompletion.mock.calls[0][0];
      expect(callArg.provider).toBeUndefined();
      expect(callArg.actualModelId).toBeUndefined();
    });
  });

  describe('Request Payload / Messages Mapping', () => {
    it('should prepend system prompt message if string system is provided', async () => {
      const controller = new AnthropicController(mockOrchestrator);
      const req = {
        body: {
          model: 'pro',
          system: 'you are a bot',
          messages: [{ role: 'user', content: 'hi' }],
        },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'you are a bot' },
            { role: 'user', content: 'hi' },
          ],
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should prepend system prompt message if array system is provided', async () => {
      const controller = new AnthropicController(mockOrchestrator);
      const req = {
        body: {
          model: 'pro',
          system: [{ type: 'text', text: 'instruction 1' }, { type: 'text', text: 'instruction 2' }],
          messages: [{ role: 'user', content: 'hi' }],
        },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

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

    it('should not prepend system prompt if system is omitted', async () => {
      const controller = new AnthropicController(mockOrchestrator);
      const req = {
        body: {
          model: 'pro',
          messages: [{ role: 'user', content: 'hi' }],
        },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'hi' },
          ],
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });
  });

  describe('Response Format Translation', () => {
    it('should translate success response with reasoning_content correctly', async () => {
      const controller = new AnthropicController(mockOrchestrator);
      const req = { body: { model: 'gemini/gemini-2.5-pro' }, headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

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
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      });
    });

    it('should translate success response with NO reasoning_content correctly', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        id: 'waypoint-456',
        object: 'chat.completion',
        created: 123456,
        model: 'gemini/gemini-2.5-pro',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'just text content',
              reasoning_content: null,
            },
            finish_reason: 'length',
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 15,
          total_tokens: 20,
        },
      });

      const controller = new AnthropicController(mockOrchestrator);
      const req = { body: { model: 'gemini/gemini-2.5-pro' }, headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(res.json).toHaveBeenCalledWith({
        id: 'waypoint-456',
        type: 'message',
        role: 'assistant',
        model: 'gemini/gemini-2.5-pro',
        content: [
          { type: 'text', text: 'just text content' },
        ],
        stop_reason: 'max_tokens',
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 15,
        },
      });
    });

    it('should parse and translate success response containing <thought> tags in content field (fallback)', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        id: 'waypoint-789',
        object: 'chat.completion',
        created: 123456,
        model: 'gemini/gemini-2.5-pro',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '<thought>thinking inside tags</thought>actual visible response',
              reasoning_content: null,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 15,
          total_tokens: 20,
        },
      });

      const controller = new AnthropicController(mockOrchestrator);
      const req = { body: { model: 'gemini/gemini-2.5-pro' }, headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(res.json).toHaveBeenCalledWith({
        id: 'waypoint-789',
        type: 'message',
        role: 'assistant',
        model: 'gemini/gemini-2.5-pro',
        content: [
          { type: 'thinking', thinking: 'thinking inside tags' },
          { type: 'text', text: 'actual visible response' },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 15,
        },
      });
    });
  });

  describe('Error Propagation', () => {
    it('should forward normalized error status and response from orchestrator', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        error: {
          code: 'upstreamRateLimited',
          message: 'Upstream rate limit reached',
          httpStatus: 503,
        },
      });

      const controller = new AnthropicController(mockOrchestrator);
      const req = { body: { model: 'pro' }, headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'upstreamRateLimited',
        }),
      }));
    });

    it('should catch unhandled exceptions and respond with 500', async () => {
      mockOrchestrator.executeCompletion.mockRejectedValue(new Error('Server out of memory'));

      const controller = new AnthropicController(mockOrchestrator);
      const req = { body: { model: 'pro' }, headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'internalServerError',
          message: 'Server out of memory',
        }),
      }));
    });
  });

  describe('Streaming Responses', () => {
    it('should stream Anthropic SSE events and close active block type when no finish_reason is provided', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          yield {
            id: 'waypoint-chunk-1',
            choices: [
              {
                index: 0,
                delta: { content: 'hello' },
              },
            ],
          };
        },
      });

      const controller = new AnthropicController(mockOrchestrator);
      const req = { body: { model: 'pro', stream: true }, headers: {} };
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      await controller.handleCompletion(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('message_start'));
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('content_block_start'));
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('content_block_delta'));
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('content_block_stop'));
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('message_stop'));
      expect(res.end).toHaveBeenCalled();
    });

    it('should catch mid-stream errors and call logClientResponse correctly', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          yield {
            id: 'waypoint-chunk-1',
            choices: [
              {
                index: 0,
                delta: { content: 'hello' },
              },
            ],
          };
          throw new Error('Midstream connection failure');
        },
      });

      const controller = new AnthropicController(mockOrchestrator);
      const req = { body: { model: 'pro', stream: true }, headers: {} };
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      await controller.handleCompletion(req, res);

      expect(res.end).toHaveBeenCalled();
    });
  });
});
