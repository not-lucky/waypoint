import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
} from 'vitest';
import { OpenAIController } from '../../src/adapters/inbound/openai/index.js';
import { AnthropicController } from '../../src/adapters/inbound/anthropic/index.js';

const testConfig = {
  providers: {
    gemini: {
      keys: ['gemini-key-1'],
      allowedExtraBody: '*',
      models: [{
        modelid: 'gemini-2.5-pro-preview-05-06',
        aliases: ['gemini-2.5-pro', 'pro'],
        reasoningSupported: true,
        reasoningEffort: 'medium',
        fallbackModel: 'openai/gpt-4o',
      }],
    },
    openai: {
      keys: ['openai-key-1'],
      allowedExtraBody: '*',
      models: [{ modelid: 'gpt-4o', aliases: ['gpt4'] }],
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

  describe('OpenAIController', () => {
    it('resolves configured models and applies model settings', async () => {
      const controller = new OpenAIController(mockOrchestrator);
      await controller.handleCompletion(
        { body: { model: 'gemini/gemini-2.5-pro' }, headers: {} },
        mockJsonRes(),
      );

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gemini',
          modelid: 'gemini-2.5-pro-preview-05-06',
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
    });

    it('streams OpenAI SSE chunks and handles failures mid-stream', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          yield { id: 'chatcmpl-123', choices: [{ index: 0, delta: { content: 'hello' } }] };
          throw new Error('Mid-stream failure');
        },
      });

      const controller = new OpenAIController(mockOrchestrator);
      const res = mockStreamRes();
      await controller.handleCompletion(
        { body: { model: 'gpt-4o', stream: true }, headers: {} },
        res,
      );

      expect(res.write).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('AnthropicController', () => {
    it('prepends system prompts into the unified message list', async () => {
      const controller = new AnthropicController(mockOrchestrator);
      await controller.handleCompletion({
        body: {
          model: 'pro',
          system: [{ type: 'text', text: 'instruction 1' }],
          messages: [{ role: 'user', content: 'hi' }],
        },
        headers: {},
      }, mockJsonRes());

      expect(mockOrchestrator.executeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'instruction 1' },
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

    it('streams Anthropic SSE chunks successfully', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          yield {
            id: 'chatcmpl-123',
            choices: [{
              index: 0,
              delta: {
                reasoning_content: 'thinking-text',
                content: 'content-text',
                tool_calls: [{
                  id: 'tool_1',
                  function: { name: 'my_tool', arguments: '{"a":' }
                }]
              }
            }]
          };
          yield {
            id: 'chatcmpl-123',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: ' 1}' }
                }]
              },
              finish_reason: 'tool_calls'
            }]
          };
        }
      });

      const controller = new AnthropicController(mockOrchestrator);
      const res = mockStreamRes();
      await controller.handleCompletion(
        { body: { model: 'pro', stream: true }, headers: {} },
        res
      );

      expect(res.write).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });

    it('handles streaming errors in AnthropicController', async () => {
      mockOrchestrator.executeCompletion.mockResolvedValue({
        async* [Symbol.asyncIterator]() {
          yield { id: 'dummy' };
          throw new Error('Upstream failed');
        }
      });

      const controller = new AnthropicController(mockOrchestrator);
      const res = mockStreamRes();
      await controller.handleCompletion(
        { body: { model: 'pro', stream: true }, headers: {} },
        res
      );

      expect(res.write).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });

    it('returns 502 if dry run is requested but request logging is disabled', async () => {
      mockOrchestrator.config = {
        ...testConfig,
        logging: { logRequests: false }
      };
      const controller = new AnthropicController(mockOrchestrator);
      const res = mockJsonRes();
      await controller.handleCompletion(
        { body: { model: 'pro' }, isDryRun: true, headers: {} },
        res
      );

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Dry run requires request logging to be enabled'
        }
      });
    });

    it('handles dry run success exceptions', async () => {
      mockOrchestrator.executeCompletion.mockImplementation(() => {
        const err = new Error('Dry run');
        err.isDryRun = true;
        err.url = 'https://api.openai.com';
        err.headers = {};
        err.payload = { model: 'gpt-4o' };
        throw err;
      });

      const controller = new OpenAIController(mockOrchestrator);
      const res = mockJsonRes();
      await controller.handleCompletion(
        { body: { model: 'gpt4' }, headers: {} },
        res
      );

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        dryRun: true,
        request: expect.any(Object),
      }));
    });

    it('handles unexpected errors with custom code and status', async () => {
      mockOrchestrator.executeCompletion.mockImplementation(() => {
        const err = new Error('Custom exception');
        err.code = 'customErrorCode';
        err.httpStatus = 418;
        throw err;
      });

      const controller = new OpenAIController(mockOrchestrator);
      const res = mockJsonRes();
      await controller.handleCompletion(
        { body: { model: 'gpt4' }, headers: {} },
        res
      );

      expect(res.status).toHaveBeenCalledWith(418);
    });

    it('handles unexpected errors with statusCode', async () => {
      mockOrchestrator.executeCompletion.mockImplementation(() => {
        const err = new Error('Status exception');
        err.statusCode = 403;
        throw err;
      });

      const controller = new OpenAIController(mockOrchestrator);
      const res = mockJsonRes();
      await controller.handleCompletion(
        { body: { model: 'gpt4' }, headers: {} },
        res
      );

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('handles unexpected generic errors', async () => {
      mockOrchestrator.executeCompletion.mockImplementation(() => {
        throw new Error('Generic error');
      });

      const controller = new OpenAIController(mockOrchestrator);
      const res = mockJsonRes();
      await controller.handleCompletion(
        { body: { model: 'gpt4' }, headers: {} },
        res
      );

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
