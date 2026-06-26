import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest'
import request from 'supertest'
import { createTestApp } from '../helpers/testServer.js'
import {
  malformedSseHandler,
  midStreamErrorHandler,
} from '../helpers/mswHandlers.js'
import { createMSWServer } from '../helpers/mswSetup.js'

const BASE_URL = 'https://requesty.example/v1'
const server = createMSWServer()

function createStreamingConfig( streamTimeoutMs = 30000 ) {
  return {
    gateway: {
      port: 0,
      globalRetryLimit: 1,
      streamTimeoutMs,
      routing: { strategy: 'round-robin' },
    },
    logging: { enableConsole: false, enableFile: false, format: 'json' },
    clients: [ {
      name: 'test-client',
      token: 'test-client-token',
      rateLimit: { windowMs: 60000, max: 100 },
    } ],
    providers: {
      requesty: {
        type: 'openai-compatible',
        baseUrl: BASE_URL,
        keys: [ 'requesty-key' ],
        models: [ { id: 'custom-model' } ],
      },
    },
  }
}

describe( 'Provider streaming errors with MSW', () => {
  beforeAll( () => {
    server.listen( {
      onUnhandledRequest( req, print ) {
        const url = new URL( req.url )
        if ( url.hostname === '127.0.0.1' || url.hostname === 'localhost' ) {
          return
        }
        print.error()
      },
    } )
  } )

  afterEach( () => {
    server.resetHandlers()
  } )

  afterAll( () => {
    server.close()
  } )

  it( 'emits an OpenAI SSE error envelope on mid-stream upstream failure', async () => {
    server.use( midStreamErrorHandler( 'openai', { baseUrl: BASE_URL } ) )
    const { app, close } = await createTestApp( { config: createStreamingConfig() } )

    try {
      const response = await request( app )
        .post( '/chat/completions' )
        .set( 'Authorization', 'Bearer test-client-token' )
        .send( {
          model: 'requesty/custom-model',
          messages: [ { role: 'user', content: 'stream please' } ],
          stream: true,
        } )
        .expect( 200 )

      expect( response.headers[ 'content-type' ] ).toMatch( /text\/event-stream/ )
      expect( response.text ).toContain( '"content":"partial"' )
      expect( response.text ).toContain( '"code":"rate_limit_exceeded"' )
      expect( response.text ).toContain( 'data: [DONE]' )
    } finally {
      await close()
    }
  } )

  it( 'handles malformed SSE payloads gracefully and still terminates the stream', async () => {
    server.use( malformedSseHandler( 'openai', { baseUrl: BASE_URL } ) )
    const { app, close } = await createTestApp( { config: createStreamingConfig() } )

    try {
      const response = await request( app )
        .post( '/chat/completions' )
        .set( 'Authorization', 'Bearer test-client-token' )
        .send( {
          model: 'requesty/custom-model',
          messages: [ { role: 'user', content: 'stream malformed' } ],
          stream: true,
        } )
        .expect( 200 )

      expect( response.text ).toContain( '"content":"partial"' )
      expect( response.text ).toContain( 'data: [DONE]' )
    } finally {
      await close()
    }
  } )
} )
