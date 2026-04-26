/**
 * Translates an Anthropic/Claude Messages request into an OpenAI-compatible request body.
 *
 * This functions as the ingress translator, standardizing an incoming Claude-style
 * request into our internal UnifiedRequest format (which is OpenAI shaped).
 *
 * @param {Object} body - Claude Messages API request body.
 * @returns {Object} OpenAI-compatible request structure.
 */
export function translateClaudeToOpenAIRequest(body) {
  const messages = [];
  
  // Anthropic separates system messages at the root of the JSON.
  // We fold it back into the standard OpenAI messages array with role 'system'.
  if (body.system) {
    let systemContent = '';
    if (typeof body.system === 'string') {
      systemContent = body.system;
    } else if (Array.isArray(body.system)) {
      systemContent = body.system.map((block) => block.text || '').join('\n');
    } else {
      systemContent = String(body.system);
    }
    messages.push({ role: 'system', content: systemContent });
  }
  if (Array.isArray(body.messages)) {
    messages.push(...body.messages);
  }

  return {
    model: body.model,
    messages,
    temperature: body.temperature,
    // Anthropic recently migrated from max_tokens_to_sample to max_tokens,
    // we support both along with our own internal maxTokens for maximum compatibility.
    maxTokens: body.max_tokens ?? body.max_tokens_to_sample ?? body.maxTokens,
    stream: body.stream || false,
    isFallback: false,
  };
}

export default translateClaudeToOpenAIRequest;