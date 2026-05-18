/* eslint-disable max-len */
import { FORMATS, translateRequest, translateResponse } from '../translators/index.js';
import { getThinkingLevel, extractThoughtTags } from './geminiFormatter.js';

/**
 * WHAT: Executes standard unary text completion for Gemini.
 * WHY: Supports two different upstream endpoints based on whether reasoning (thinking) is active.
 */
export const executeCompletion = async (req, apiKey, signal, requestLog, adapter) => {
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

  let payload;
  let url;
  let headers;

  if (thinkingEnabled) {
    url = adapter.baseUrl
      ? `${adapter.baseUrl.replace(/\/$/, '')}/chat/completions`
      : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

    headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    payload = {
      model: req.actualModelId || req.model,
      messages: req.messages,
      stream: false,
      extra_body: {
        google: {
          thinking_config: {
            thinking_level: getThinkingLevel(req),
            include_thoughts: true,
          },
        },
      },
    };
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;
  } else {
    payload = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, req);
    const base = adapter.baseUrl
      ? adapter.baseUrl.replace(/\/$/, '')
      : 'https://generativelanguage.googleapis.com/v1beta';

    const urlObj = new URL(`${base}/models/${req.actualModelId}:generateContent`);
    urlObj.searchParams.set('key', apiKey);
    url = urlObj.toString();

    headers = {
      'content-type': 'application/json',
    };
  }

  const { response, cleanup } = await adapter.performFetch(
    url,
    headers,
    payload,
    signal,
    requestLog,
    adapter.timeoutMs,
  );

  try {
    const resultJson = await response.json();

    if (thinkingEnabled) {
      let resultId = `waypoint-${Date.now()}`;
      if (resultJson.id) {
        resultId = resultJson.id.startsWith('waypoint-')
          ? resultJson.id
          : `waypoint-${resultJson.id}`;
      }
      return {
        id: resultId,
        object: 'chat.completion',
        created: resultJson.created || Math.floor(Date.now() / 1000),
        model: req.model || resultJson.model,
        choices: (resultJson.choices || []).map((c) => {
          const { content, reasoningContent } = extractThoughtTags(
            c.message?.content || '',
            c.message?.reasoning_content || null,
          );
          return {
            index: c.index ?? 0,
            message: {
              role: c.message?.role || 'assistant',
              content,
              reasoning_content: reasoningContent,
            },
            finish_reason: c.finish_reason ?? c.finishReason ?? 'stop',
          };
        }),
        usage: {
          prompt_tokens:
            resultJson.usage?.prompt_tokens ?? resultJson.usage?.promptTokens ?? 0,
          completion_tokens:
            resultJson.usage?.completion_tokens ?? resultJson.usage?.completionTokens ?? 0,
          total_tokens:
            resultJson.usage?.total_tokens ?? resultJson.usage?.totalTokens ?? 0,
        },
      };
    }

    return translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, resultJson, req);
  } finally {
    cleanup();
  }
};
