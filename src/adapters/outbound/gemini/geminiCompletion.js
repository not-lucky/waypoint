import { FORMATS, translateRequest, translateResponse } from '../../transforms/index.js';
import { getThinkingLevel } from './geminiFormatter.js';
import { mapOpenAICompletionResponse } from '../shared/openaiResponse.js';
import { applyExtraBody } from '../shared/extraBody.js';

const resolveGeminiModelId = (req) => {
  if (typeof req?.modelid === 'string' && req.modelid.trim() !== '') {
    return req.modelid;
  }
  return (req?.model || '').split('/').pop();
};

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

    if ( reasoningSupported ) {
      // Gemini embeds reasoning in <thought>...</thought> tags within content.
      // Extract them into reasoning_content when reasoning is supported.
      return mapOpenAICompletionResponse( req, resultJson, {
        taggedReasoning: {
          startTag: '<thought>',
          endTag: '</thought>',
        },
      } );
    }

    return translateResponse( FORMATS.OPENAI, FORMATS.GEMINI, resultJson, req );
  } finally {
    cleanup();
  }
};
