import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { OpenAIController } from '../src/controllers/OpenAIController.js';

describe('OpenAIController Edge Case Tests', () => {
  const testConfig = {
    providers: {
      gemini: {
        keys: ['gemini-key-1'],
        models: [
          {
            id: 'gemini-2.5-pro-preview-05-06',
            aliases: ['gemini-2.5-pro', 'gemini-pro', 'pro'],
            thinking_supported: true,
            reasoning_effort: 'medium',
            fallback_model: 'openai/gpt-4o',
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
              content: 'hello',
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
      const controller = new OpenAIController(mockOrchestrator);
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
          thinking_supported: true,
          thinkingLevel: 'medium',
          thinkingEnabled: true,
          reasoningEffort: 'medium',
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should default actualModelId to modelPart if provider is matched but model is unconfigured', async () => {
      const controller = new OpenAIController(mockOrchestrator);
      const req = {
        body: { model: 'gemini/unconfigured-model-id' },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gemini',
          actualModelId: 'unconfigured-model-id',
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should resolve bare name exact match', async () => {
      const controller = new OpenAIController(mockOrchestrator);
      const req = {
        body: { model: 'gpt-4o' },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          actualModelId: 'gpt-4o',
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should resolve bare name alias match', async () => {
      const controller = new OpenAIController(mockOrchestrator);
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
      const controller = new OpenAIController(mockOrchestrator);
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

  describe('Request Payload / Param Mappings', () => {
    it('should map max_tokens to maxTokens', async () => {
      const controller = new OpenAIController(mockOrchestrator);
      const req = {
        body: { model: 'gpt-4o', max_tokens: 150 },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTokens: 150,
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should map max_completion_tokens to maxTokens', async () => {
      const controller = new OpenAIController(mockOrchestrator);
      const req = {
        body: { model: 'gpt-4o', max_completion_tokens: 250 },
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTokens: 250,
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should handle undefined body/messages safely without crashing', async () => {
      const controller = new OpenAIController(mockOrchestrator);
      const req = {
        headers: {},
      };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [],
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });
  });

  describe('Error Propagation', () => {
    it('should forward normalized error status and response from orchestrator', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        error: {
          code: 'all_keys_exhausted',
          message: 'All keys in cooldown',
          httpStatus: 503,
        },
      });

      const controller = new OpenAIController(mockOrchestrator);
      const req = { body: { model: 'gpt-4o' }, headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'all_keys_exhausted',
        }),
      }));
    });

    it('should fallback to status 500 when orchestrator response error is missing httpStatus', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        error: {
          code: 'generic_error',
          message: 'Generic failure without http status',
        },
      });

      const controller = new OpenAIController(mockOrchestrator);
      const req = { body: { model: 'gpt-4o' }, headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should catch unhandled exceptions and respond with 500', async () => {
      mockOrchestrator.executeCompletion.mockRejectedValue(new Error('Database crash'));

      const controller = new OpenAIController(mockOrchestrator);
      const req = { body: { model: 'gpt-4o' }, headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'internal_server_error',
          message: 'Database crash',
        }),
      }));
    });

    it('should use String(err) fallback when catch error message is empty', async () => {
      mockOrchestrator.executeCompletion.mockRejectedValue(new Error(''));

      const controller = new OpenAIController(mockOrchestrator);
      const req = { body: { model: 'gpt-4o' }, headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      await controller.handleCompletion(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'internal_server_error',
          message: 'Error',
        }),
      }));
    });
  });

  describe('Streaming Error Propagation', () => {
    it('should catch mid-stream errors and terminate the socket gracefully', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          yield { id: 'chatcmpl-123', choices: [{ index: 0, delta: { content: 'hello' } }] };
          throw new Error('Mid-stream failure');
        },
      });

      const controller = new OpenAIController(mockOrchestrator);
      const req = { body: { model: 'gpt-4o', stream: true }, headers: {} };
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      await expect(controller.handleCompletion(req, res)).resolves.not.toThrow();
      expect(res.write).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });
  });
});
