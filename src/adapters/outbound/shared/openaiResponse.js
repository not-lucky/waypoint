import { extractTaggedText } from '../../../utils/streaming/thinkingBuffer.js';

/**
 * Unpacks the raw text content from a structured reasoning details object.
 *
 * @private
 * @param {*} detail - The reasoning details parameter.
 * @returns {string} The text content of the reasoning details.
 */
const reasoningDetailText = (detail) => {
  if (!detail || typeof detail !== 'object') return '';
  return detail.text ?? detail.summary ?? detail.content ?? '';
};

/**
 * Extracts raw reasoning text from a standard or extended OpenAI message/delta.
 *
 * Checks reasoning details array, native `reasoning_content` field, and custom `reasoning` keys.
 * Handles OpenRouter specific duplicates safely by prioritizing `reasoning_details` then `reasoning_content`.
 *
 * @param {Object|null|undefined} source - The delta/choice source object to check.
 * @returns {string|null} The reasoning string if found; otherwise null.
 */
export const extractReasoningText = (source) => {
  if (!source) return null;

  if (Array.isArray(source.reasoning_details) && source.reasoning_details.length > 0) {
    const fromDetails = source.reasoning_details.map(reasoningDetailText).join('');
    if (fromDetails) return fromDetails;
  }

  if (typeof source.reasoning_content === 'string' && source.reasoning_content) {
    return source.reasoning_content;
  }

  if (typeof source.reasoning === 'string' && source.reasoning) {
    return source.reasoning;
  }

  return null;
};

/**
 * Maps unified reasoning settings to OpenAI reasoning_effort values.
 *
 * Translates Waypoint settings (e.g. 'minimal', 'xhigh') to standard OpenAI `reasoning_effort` strings.
 *
 * @param {Object} req - The unified request payload.
 * @returns {string|undefined} The resolved reasoning effort string, or undefined.
 */
export const resolveReasoningEffort = (req) => {
  let effort = req.reasoningEffort;
  if (effort) {
    effort = effort.toLowerCase();
    if (effort === 'minimal') return 'low';
    if (['xhigh', 'max'].includes(effort)) return 'high';
    return effort;
  }
  if (req.reasoningSupported !== false) {
    return 'high';
  }
  return undefined;
};

/**
 * Normalizes OpenAI-compatible usage tokens object.
 *
 * @param {Object|null|undefined} usage - Raw usage metadata object from provider.
 * @returns {Object|undefined} The mapped usage tokens object containing prompt_tokens, completion_tokens, and total_tokens.
 */
export const mapUsage = (usage) => {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
};

/**
 * Normalizes a stream chunk delta object by resolving raw reasoning keys down to standard `reasoning_content`.
 *
 * @private
 * @param {Object|null|undefined} delta - The raw delta chunk choices item.
 * @returns {Object} A copy of the delta containing normalized keys.
 */
const normalizeStreamDelta = (delta) => {
  if (!delta) return {};

  const normalized = { ...delta };
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent !== null) {
    normalized.reasoning_content = reasoningContent;
  }
  delete normalized.reasoning;
  delete normalized.reasoning_details;
  return normalized;
};

/**
 * Recovers "trailing" reasoning from a content string when a `</think>` end
 * tag is present without a matching `<think>` start tag in the same string.
 *
 * This is the non-streaming counterpart to the "premature `</think>`"
 * recovery in the streaming pipeline: when native `reasoning_content` is
 * present (so the buffer was bypassed in the streaming path), the upstream
 * may still emit a `</think>` somewhere in `content`. When that happens:
 *
 * - If a `<think>` start tag appears before the end tag, the tags are
 *   already balanced and the content is returned unchanged.
 * - Otherwise, the text before the end tag is appended to the existing
 *   reasoning and the trailing text is kept as content.
 *
 * @param {string} content - The raw assistant content from the upstream.
 * @param {string} reasoningContent - The native reasoning already extracted
 *   from the response (may be `null`).
 * @param {{startTag: string, endTag: string}} taggedReasoning - Tag pair.
 * @returns {{content: string, reasoningContent: string|null}}
 */
const extractTrailingTaggedReasoning = (content, reasoningContent, taggedReasoning) => {
  const { startTag, endTag } = taggedReasoning;
  if (typeof content !== 'string' || !endTag || !content.includes(endTag)) {
    return { content, reasoningContent };
  }

  const endIndex = content.indexOf(endTag);
  const startIndex = startTag ? content.indexOf(startTag) : -1;
  if (startIndex !== -1 && startIndex < endIndex) {
    return { content, reasoningContent };
  }

  return {
    content: content.slice(endIndex + endTag.length),
    reasoningContent: reasoningContent + content.slice(0, endIndex),
  };
};

/**
 * Resolves the final `{content, reasoningContent}` pair for a single choice,
 * applying tag-based extraction only when `taggedReasoning` is configured.
 *
 * - No tag config → pass through the upstream values unchanged.
 * - No native reasoning and tag config is present → run the full
 *   `extractTaggedText` pass to split the first `<think>…</think>` block
 *   into `reasoningContent`.
 * - Native reasoning already present → run only the trailing-tag recovery
 *   (see `extractTrailingTaggedReasoning`) to avoid double-stripping tags
 *   the upstream intentionally included in `content`.
 *
 * @param {string} content - The raw assistant content.
 * @param {string|null} reasoningContent - Native reasoning, or `null` when
 *   the upstream did not provide one.
 * @param {{startTag: string, endTag: string}|null} taggedReasoning - Tag
 *   pair, or `null` when tag-based extraction is disabled.
 * @returns {{content: string, reasoningContent: string|null}}
 */
const resolveTaggedCompletionContent = (content, reasoningContent, taggedReasoning) => {
  if (!taggedReasoning) {
    return { content, reasoningContent };
  }

  if (reasoningContent === null) {
    return extractTaggedText(content, reasoningContent, taggedReasoning);
  }

  return extractTrailingTaggedReasoning(content, reasoningContent, taggedReasoning);
};

/**
 * Maps an OpenAI choice item to a normalized choice structure, extracting tagged reasoning blocks.
 *
 * @private
 * @param {Object} c - The raw choice object from the API response.
 * @param {Object|null} [taggedReasoning=null] - Configuration for reasoning tags.
 * @returns {Object} Normalized choice object.
 */
const mapCompletionChoice = (c, taggedReasoning = null) => {
  const rawMessage = c.message || {};
  let content = rawMessage.content ?? '';
  if (content === null) content = '';
  let reasoningContent = extractReasoningText(rawMessage);
  ({ content, reasoningContent } = resolveTaggedCompletionContent(
    content,
    reasoningContent,
    taggedReasoning,
  ));

  const message = {
    role: rawMessage.role || 'assistant',
    content,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(rawMessage.tool_calls ? { tool_calls: rawMessage.tool_calls } : {}),
    ...(rawMessage.refusal ? { refusal: rawMessage.refusal } : {}),
  };

  return {
    index: c.index ?? 0,
    message,
    finish_reason: c.finish_reason ?? 'stop',
  };
};

/**
 * Maps an OpenAI-compatible chat completion JSON body to a NormalizedResponse.
 *
 * Re-namespaces IDs with a "waypoint-" prefix and formats choices & usage metrics consistently.
 *
 * @param {Object} req - The original request context.
 * @param {Object} resultJson - The raw JSON response body from the upstream provider.
 * @param {Object} [options={}] - Options object.
 * @param {Object|null} [options.taggedReasoning=null] - Tag settings for reasoning extraction.
 * @returns {Object} The normalized chat completion response object.
 */
export const mapOpenAICompletionResponse = (
  req,
  resultJson,
  { taggedReasoning = null } = {},
) => {
  let resultId = `waypoint-${Date.now()}`;
  if (resultJson.id) {
    resultId = resultJson.id.startsWith('waypoint-') ? resultJson.id : `waypoint-${resultJson.id}`;
  }

  return {
    id: resultId,
    object: 'chat.completion',
    created: resultJson.created || Math.floor(Date.now() / 1000),
    model: req.model || resultJson.model,
    choices: (resultJson.choices || []).map((c) => mapCompletionChoice(c, taggedReasoning)),
    usage: mapUsage(resultJson.usage) ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
};

/**
 * Translates an OpenAI streaming chunk into a normalized StreamChunk format.
 *
 * Normalizes reasoning fields inside choices deltas and forwards usage records if present.
 *
 * @param {Object} parsedData - The raw parsed JSON data of the chunk.
 * @param {string} chunkId - The fallback session chunk ID.
 * @returns {Object} The normalized StreamChunk object.
 */
export const mapOpenAIStreamChunk = (parsedData, chunkId) => ({
  id: parsedData.id || chunkId,
  object: parsedData.object || 'chat.completion.chunk',
  created: parsedData.created,
  model: parsedData.model,
  choices: (parsedData.choices || []).map((c) => ({
    index: c.index ?? 0,
    delta: normalizeStreamDelta(c.delta),
    finish_reason: c.finish_reason ?? null,
    logprobs: c.logprobs ?? null,
  })),
  usage: mapUsage(parsedData.usage),
});

