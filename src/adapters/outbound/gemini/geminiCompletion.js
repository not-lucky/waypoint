import { FORMATS, translateRequest, translateResponse } from '../../transforms/index.js';
import { getThinkingLevel } from './geminiFormatter.js';
import { mapOpenAICompletionResponse } from '../shared/openaiResponse.js';
import { applyExtraBody } from '../shared/extraBody.js';
import { attachRawResponse } from '../shared/attachRawResponse.js';

/**
 * Resolves the model ID to pass to the Gemini API endpoint.
 *
 * Extracts the model ID either from the explicitly configured `modelid` field
 * or extracts the final segment of a slash-delimited model identifier (e.g. 'models/gemini-1.5-flash' -> 'gemini-1.5-flash').
 *
 * @private
 * @param {Object} req - The unified request payload.
 * @returns {string} The resolved Gemini-specific model identifier.
 */
const resolveGeminiModelId = (req) => {
  if (typeof req?.modelid === 'string' && req.modelid.trim() !== '') {
    return req.modelid;
  }
  return (req?.model || '').split('/').pop();
};

/**
 * Executes a non-streaming chat completion request against the Gemini API.
 *
 * Depending on whether reasoning is supported by the request config:
 * 1. Reasoning models: Directly targets Gemini's OpenAI-compatible endpoint with explicit
 *    `thinking_config` set up, deep-merging client `extraBody` parameters (e.g. google_search),
 *    and extracts nested thoughts using `<thought>` tags back to `reasoning_content`.
 * 2. Standard models: Translates the request to native Gemini format, appends `extraBody` parameters,
 *    submits to the native `generateContent` endpoint, and translates the response back to OpenAI format.
 *
 * In both cases, the raw upstream JSON body is attached to the normalized output as a non-enumerable
 * property for audit logging, and resources are cleaned up cleanly.
 *
 * @async
 * @param {Object} req - The normalized chat completion request payload.
 * @param {string} apiKey - The Google Gemini API key.
 * @param {AbortSignal} signal - Abort signal to cancel the HTTP request.
 * @param {Object|null} [requestLog=null] - Optional audit logger wrapper.
 * @param {Object} adapter - The GeminiAdapter instance calling this utility.
 * @returns {Promise<Object>} The normalized OpenAI-compatible completion response.
 * @throws {Error} Throws if the fetch fails, times out, or returns a non-200 status code.
 */
export const executeCompletion = async ( req, apiKey, signal, requestLog, adapter ) => {
  const reasoningSupported = req.reasoningSupported !== false;

  let payload;
  let url;
  let headers;

  if ( reasoningSupported ) {
    url = adapter.baseUrl
      ? `${ adapter.baseUrl }/chat/completions`
      : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

    headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${ apiKey }`,
    };

    payload = {
      model: resolveGeminiModelId(req),
      messages: req.messages,
      stream: false,
      extra_body: {
        google: {
          thinking_config: {
            thinking_level: getThinkingLevel( req ),
            include_thoughts: true,
          },
        },
      },
    };
    if ( req.temperature !== undefined ) payload.temperature = req.temperature;
    if ( req.maxTokens !== undefined ) payload.max_tokens = req.maxTokens;
    // Deep-merges client extraBody parameters (e.g. google_search) with adapter thinking_config
    applyExtraBody( payload, req.extraBody );
  } else {
    payload = translateRequest( FORMATS.OPENAI, FORMATS.GEMINI, req );
    // Appends client extraBody parameters to the translated non-reasoning Gemini payload
    applyExtraBody( payload, req.extraBody );
    const base = adapter.baseUrl
      ? adapter.baseUrl
      : 'https://generativelanguage.googleapis.com/v1beta';

    const modelId = resolveGeminiModelId(req);
    const urlObj = new URL( `${ base }/models/${ modelId }:generateContent` );
    urlObj.searchParams.set( 'key', apiKey );
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

    let mapped;
    if ( reasoningSupported ) {
      // Gemini embeds reasoning in <thought>...</thought> tags within content.
      // Extract them into reasoning_content when reasoning is supported.
      mapped = mapOpenAICompletionResponse( req, resultJson, {
        taggedReasoning: {
          startTag: '<thought>',
          endTag: '</thought>',
        },
      } );
    } else {
      mapped = translateResponse( FORMATS.OPENAI, FORMATS.GEMINI, resultJson, req );
    }

    // Stash the raw upstream body for the request logger; non-enumerable so it
    // never leaks into the client-bound JSON serialization.
    attachRawResponse(mapped, resultJson);
    return mapped;
  } finally {
    cleanup();
  }
};

