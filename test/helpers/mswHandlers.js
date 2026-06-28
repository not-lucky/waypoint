import { http, HttpResponse } from 'msw';

function buildOpenAICompletionResponse( {
  id = 'chatcmpl-msw',
  model = 'gpt-4o',
  content = 'Hello from MSW',
} = {} ) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor( Date.now() / 1000 ),
    model,
    choices: [ {
      index: 0,
      message: {
        role: 'assistant',
        content,
      },
      finish_reason: 'stop',
    } ],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 5,
      total_tokens: 10,
    },
  };
}

function createSseResponse( parts, {
  headers = {},
  closeStream = true,
} = {} ) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream( {
    async start( controller ) {
      for ( const part of parts ) {
        if ( part.delayMs ) {
          await new Promise( ( resolve ) => { setTimeout( resolve, part.delayMs ); } );
        }
        controller.enqueue( encoder.encode( part.data ) );
      }

      if ( closeStream ) {
        controller.close();
      }
    },
  } );

  return new HttpResponse( stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      ...headers,
    },
  } );
}

function getProviderEndpoint( provider, baseUrl ) {
  if ( baseUrl ) {
    return `${ baseUrl }/chat/completions`;
  }

  if ( provider === 'openai' ) {
    return 'https://api.openai.com/v1/chat/completions';
  }

  throw new Error( `Unsupported provider endpoint for '${ provider }'` );
}

export function openaiCompletionHandler( options = {} ) {
  const {
    baseUrl = 'https://api.openai.com/v1',
    status = 200,
    resolver = null,
    response = buildOpenAICompletionResponse(),
  } = options;

  return http.post( `${ baseUrl }/chat/completions`, async ( { request } ) => {
    if ( resolver ) {
      return resolver( { request, HttpResponse } );
    }

    return HttpResponse.json( response, { status } );
  } );
}

export function openaiStreamHandler( options = {} ) {
  const {
    baseUrl = 'https://api.openai.com/v1',
    parts = [
      { data: 'data: {"id":"chatcmpl-msw","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' },
      { data: 'data: {"id":"chatcmpl-msw","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' },
      { data: 'data: [DONE]\n\n' },
    ],
    closeStream = true,
  } = options;

  return http.post( `${ baseUrl }/chat/completions`, () => createSseResponse( parts, { closeStream } ) );
}

export function rateLimitHandler( provider, options = {} ) {
  const {
    baseUrl,
    status = 429,
    code = 'rate_limit_exceeded',
    type = 'rate_limit_error',
    message = 'Rate limit exceeded',
    retryAfterSeconds,
  } = options;

  return http.post( getProviderEndpoint( provider, baseUrl ), () => HttpResponse.json(
    {
      error: {
        code,
        type,
        message,
      },
    },
    {
      status,
      headers: retryAfterSeconds === undefined
        ? {}
        : { 'Retry-After': String( retryAfterSeconds ) },
    },
  ) );
}

export function midStreamErrorHandler( provider, options = {} ) {
  const {
    baseUrl,
    status = 429,
    code = 'rate_limit_exceeded',
    type = 'rate_limit_error',
    message = 'Mid-stream failure',
  } = options;

  if ( provider !== 'openai' ) {
    throw new Error( `Unsupported streaming error handler provider '${ provider }'` );
  }

  return openaiStreamHandler( {
    baseUrl,
    parts: [
      { data: 'data: {"id":"chatcmpl-msw","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n' },
      { data: `data: ${ JSON.stringify( { error: { code, type, message, status } } ) }\n\n` },
    ],
  } );
}

export function malformedSseHandler( provider, options = {} ) {
  if ( provider !== 'openai' ) {
    throw new Error( `Unsupported malformed SSE handler provider '${ provider }'` );
  }

  const { baseUrl } = options;
  return openaiStreamHandler( {
    baseUrl,
    parts: [
      { data: 'data: {"id":"chatcmpl-msw","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n' },
      { data: 'data: {"badJson": \n\n' },
      { data: 'data: [DONE]\n\n' },
    ],
  } );
}

export function serverErrorHandler( provider, options = {} ) {
  const {
    baseUrl,
    status = 500,
    code = 'internal_server_error',
    type = 'api_error',
    message = 'Internal Server Error',
  } = options;

  return http.post( getProviderEndpoint( provider, baseUrl ), () => HttpResponse.json(
    {
      error: {
        code,
        type,
        message,
      },
    },
    { status },
  ) );
}
