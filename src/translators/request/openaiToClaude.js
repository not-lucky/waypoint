/**
 * Translates a UnifiedRequest or OpenAI-shaped payload into an Anthropic Messages API payload.
 *
 * Rationale: Bridges the structural mismatch between OpenAI's ubiquitous Chat Completions API
 * and Anthropic's Messages API. This ensures downstream clients using standard OpenAI SDKs
 * can transparently communicate with Claude models without needing schema awareness.
 *
 * @param {Object} req - The UnifiedRequest object or OpenAI request body.
 * @returns {Object} Anthropic compatible request payload body.
 */
export const translateOpenAIToClaude = (req) => {
  const messages = req.messages || [];

  // Architectural Intent: OpenAI permits multiple 'system' messages interleaved anywhere
  // in the conversation history. Anthropic strictly requires a single top-level `system`
  // property and forbids 'system' roles in the messages array.
  // We extract and aggregate all system messages to ensure no contextual instructions
  // are dropped while adhering to Anthropic's schema.
  const systemMessages = messages.filter((m) => m.role === 'system');
  const systemPrompt = systemMessages
    .map((m) => {
      // Edge Case: OpenAI content can be a scalar string or a structured array of content blocks.
      // We normalize both into a flat string because Anthropic's system prompt does not support
      // complex arrays (only string format is allowed at the top level).
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((block) => block.text || '').join('\n');
      }
      return String(m.content || '');
    })
    .join('\n')
    .trim();

  // Process conversational turns.
  // Rationale: We strip the 'system' roles hoisted above and perform deep translation
  // on multimodal content (like images) to match Anthropic's nested 'source' structures.
  const nonSystemMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      let { content } = m;

      // If content is an array, preserve it (e.g. image content blocks)
      if (Array.isArray(content)) {
        content = content.map((block) => {
          if (block.type === 'image_url') {
            // Rationale: OpenAI embeds image data in a generic `image_url.url` field, which can be
            // an HTTP URL or a Base64 data URI. Anthropic enforces a strict `source` object
            // for Base64 payloads and requires explicit media type extraction.
            // We use Regex to dissect the Data URI into the format Anthropic's validator expects.
            const url = block.image_url?.url || '';
            const match = url.match(/^data:(image\/[a-zA-Z0-9.-]+);base64,(.+)$/);
            if (match) {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: match[1],
                  data: match[2],
                },
              };
            }
          }
          return block;
        });
      }

      // Role Normalization: Anthropic's Messages API enforces strict 'user'/'assistant' roles.
      // It will reject requests containing 'function', 'tool', or unrecognized roles.
      // We safely coerce any non-assistant roles into 'user' to prevent hard API faults,
      // mapping out-of-band context as user utterances if unsupported.
      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content,
      };
    });

  const payload = {
    // Rely on the resolved actualModelId (from registry/routing) or fallback to raw model.
    model: req.actualModelId || req.model,
    messages: nonSystemMessages,
    // Architectural Intent: OpenAI treats `max_tokens` as optional (defaulting to model limits).
    // Anthropic strictly requires `max_tokens` to be explicitly defined. We inject a safe
    // default (4096) to prevent 400 Bad Request errors for unaware OpenAI-native clients.
    max_tokens: req.maxTokens || 4096,
  };

  if (systemPrompt) {
    payload.system = systemPrompt;
  }

  // Pass-through optional configuration if explicitly requested.
  if (req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }

  if (req.stream !== undefined) {
    payload.stream = req.stream;
  }

  // Capability Extension: Maps bespoke custom flags into Anthropic's native extended thinking
  // configuration. This allows standard OpenAI SDKs to unlock Claude's Chain-of-Thought
  // reasoning without requiring new SDK versions.
  const reasoningSupported = req.reasoningSupported || false;
  if (reasoningSupported) {
    let budget = 2048;
    const effort = req.reasoningEffort;
    if (effort) {
      const effortBudgets = {
        minimal: 1024,
        low: 1024,
        medium: 2048,
        high: 4096,
        xhigh: 16384,
        max: 32768,
      };
      budget = effortBudgets[effort.toLowerCase()] || 2048;
    }
    payload.thinking = {
      type: 'enabled',
      budget_tokens: budget,
    };

    // Safety Fallback: Anthropic enforces a strict invariant where `max_tokens`
    // MUST exceed `budget_tokens`.
    // Since we default `max_tokens` to 4096 above, a client requesting a large thinking budget
    // could accidentally trigger an API rejection. We proactively inflate `max_tokens`
    // to absorb the budget and provide a reasonable output buffer.
    if (payload.max_tokens <= budget) {
      payload.max_tokens = budget + 2048;
    }
  }

  return payload;
};
