 
import { FORMATS, translateRequest, translateResponse } from '../../transforms/index.js';
import { getThinkingLevel } from './geminiFormatter.js';
import { mapOpenAICompletionResponse } from '../shared/openaiResponse.js';

/**
 * WHAT: Executes standard unary text completion for Gemini.
 * WHY: Supports two different upstream endpoints based on whether reasoning (thinking) is active.
 */
export const executeCompletion = async (req, apiKey, signal, requestLog, adapter) => {
  const reasoningSupported = req.reasoningSupported || false;

  let payload;
  let url;
  let headers;

  if (reasoningSupported) {
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

    if (reasoningSupported) {
      return mapOpenAICompletionResponse(req, resultJson, { extractThoughts: true });
    }

    return translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, resultJson, req);
  } finally {
    cleanup();
  }
};
