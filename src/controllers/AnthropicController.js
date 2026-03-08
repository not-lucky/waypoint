import { resolveModel, applyModelConfig, applyHeaderOverrides } from '../utils/modelResolver.js';

// Maps OpenAI-style finish_reason values to Anthropic stop_reason equivalents.
// Unmapped reasons (e.g. 'content_filter') are passed through as-is.
const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
};

/**
 * Converts an Anthropic system prompt (string or content-block array) to a
 * single string suitable for the unified system message.
 * Anthropic's API accepts system as either a plain string or an array of
 * content blocks like [{ type: 'text', text: '...' }].
 */
const formatSystemContent = (system) => {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((block) => block.text || '').join('\n');
  return String(system);
};

/**
 * Translates a NormalizedResponse (OpenAI-shaped) into the Anthropic Messages API format.
 * Maps reasoning_content to a 'thinking' content block and content to a 'text' block.
 * Converts usage from prompt_tokens/completion_tokens to input_tokens/output_tokens.
 */
const translateResponse = (normalized) => {
  const choice = normalized.choices?.[0] || {};
  const message = choice.message || {};

  // Build content blocks: thinking block first (if present), then text block
  const content = [];
  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }
  content.push({ type: 'text', text: message.content || '' });

  return {
    id: normalized.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: normalized.model,
    content,
    stop_reason: STOP_REASON_MAP[choice.finish_reason] || choice.finish_reason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: normalized.usage?.prompt_tokens ?? 0,
      output_tokens: normalized.usage?.completion_tokens ?? 0,
    },
  };
};

/**
 * Protocol controller for the Anthropic-compatible ingress endpoints.
 * Translates inbound Anthropic Messages requests into UnifiedRequest format,
 * resolves model configuration and header overrides, dispatches to the orchestrator,
 * then translates the NormalizedResponse back into the Anthropic Messages schema.
 *
 * Mounted on: /anthropic/messages, /anthropic/v1/messages
 */
export class AnthropicController {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }

  async handleCompletion(req, res) {
    try {
      const body = req.body || {};
      const providersConfig = this.orchestrator.config?.providers || {};

      // Anthropic sends system prompt as a top-level 'system' field, not inside messages.
      // We prepend it as a standard system message for the unified format.
      const messages = [];
      if (body.system) {
        messages.push({ role: 'system', content: formatSystemContent(body.system) });
      }
      if (Array.isArray(body.messages)) {
        messages.push(...body.messages);
      }

      // Build the unified internal request from the Anthropic payload.
      // Anthropic uses max_tokens (current) or max_tokens_to_sample (legacy).
      const unifiedReq = {
        model: body.model,
        messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens ?? body.max_tokens_to_sample ?? body.maxTokens,
        stream: body.stream || false,
        isFallback: false,
      };

      // Resolve model config then apply header-level overrides
      applyModelConfig(unifiedReq, resolveModel(body.model, providersConfig));
      const cleanRawReq = applyHeaderOverrides(unifiedReq, req);

      const response = await this.orchestrator.executeCompletion(unifiedReq, cleanRawReq);

      // Error responses use the same format regardless of client protocol
      if (response?.error) {
        return res.status(response.error.httpStatus || 500).json(response);
      }

      // Translate from NormalizedResponse (OpenAI-shaped) to Anthropic Messages format
      return res.json(translateResponse(response));
    } catch (err) {
      // Catch-all for unexpected errors
      return res.status(500).json({
        error: {
          code: 'internal_server_error',
          message: err.message || String(err),
          httpStatus: 500,
        },
      });
    }
  }
}

export default AnthropicController;
