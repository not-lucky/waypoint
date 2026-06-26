import { extractTaggedText } from '../../../utils/streaming/thinkingBuffer.js';

const reasoningDetailText = (detail) => {
  if (!detail || typeof detail !== 'object') return '';
  return detail.text ?? detail.summary ?? detail.content ?? '';
};

/**
 * Extracts reasoning text from an OpenAI-compatible message or stream delta.
 * OpenRouter mirrors the same incremental token in both `reasoning` and
 * `reasoning_details`, so only one source is used per chunk (not concatenated).
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
 */
export const resolveReasoningEffort = (req) => {
  let effort = req.reasoningEffort;
  if (effort) {
    effort = effort.toLowerCase();
    if (effort === 'minimal') return 'low';
    if (['xhigh', 'max'].includes(effort)) return 'high';
    return effort;
  }
  if (req.reasoningSupported) {
    return 'high';
  }
  return undefined;
};

/**
 * Normalizes OpenAI-style usage metrics.
 */
export const mapUsage = (usage) => {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
};

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
 * Maps an OpenAI-compatible streaming chunk to a StreamChunk.
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
