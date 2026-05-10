/* eslint-disable max-len */
import { FORMATS, translateRequest, translateResponse } from '../translators/index.js';
import { sanitizeUrl, serializeHeaders } from '../utils/requestLogger.js';
import { getThinkingLevel, extractThoughtTags } from './geminiFormatter.js';
import { parseUpstreamError } from './BaseProvider.js';

/**
 * WHAT: Executes standard unary text completion for Gemini.
 * WHY: Supports two different upstream endpoints based on whether reasoning (thinking) is active.
 */
export const executeCompletion = async (req, apiKey, signal, requestLog, adapter) => {
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;

  let payload;
  let url;
  let headers;

  // Select endpoint routing based on whether a thinking/reasoning model is requested
  if (thinkingEnabled) {
    // For reasoning models, route to the OpenAI-compatible endpoint since it natively separates thinking content.
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
    // Standard models: translate request to Gemini native structure and call generateContent REST endpoint
    payload = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, req);
    const base = adapter.baseUrl
      ? adapter.baseUrl.replace(/\/$/, '')
      : 'https://generativelanguage.googleapis.com/v1beta';

    // Construct the endpoint URL and safely bind the api key via native URLSearchParams
    const urlObj = new URL(`${base}/models/${req.actualModelId}:generateContent`);
    urlObj.searchParams.set('key', apiKey);
    url = urlObj.toString();

    headers = {
      'content-type': 'application/json',
    };
  }

  // Combine client abort signals with HTTP timeout constraints
  const { signal: fetchSignal, cleanup } = adapter.getTimeoutSignal(signal, adapter.timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: fetchSignal,
    });
  } catch (fetchErr) {
    // Log failure request details before bubbling the raw fetch exception
    if (requestLog) {
      requestLog.logProviderRequest(sanitizeUrl(url), {}, payload);
    }
    throw fetchErr;
  } finally {
    cleanup();
  }

  if (requestLog) {
    requestLog.logProviderRequest(sanitizeUrl(url), serializeHeaders(response.headers), payload);
  }

  // Error check: parse body details for downstream cooldown/retry mappings
  if (!response.ok) {
    throw await parseUpstreamError(response);
  }

  const resultJson = await response.json();

  if (thinkingEnabled) {
    // Reconstruct the response choices to extract mixed xml tag boundaries
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

  // For standard completions, use the default translator mapping
  return translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, resultJson, req);
};
