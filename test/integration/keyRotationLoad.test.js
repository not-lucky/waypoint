import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest'
import request from 'supertest'
import { HttpResponse, http } from 'msw'
import { createTestApp } from '../helpers/testServer.js'
import { createMSWServer } from '../helpers/mswSetup.js'

const BASE_URL = 'https://requesty.example/v1'
const server = createMSWServer()

function createRotationConfig() {
  return {
    gateway: {
      port: 0,
      globalRetryLimit: 2,
      cooldown: {
        baseSeconds: 30,
        maxSeconds: 120,
      },
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
        keys: [ 'key-a', 'key-b' ],
        models: [ { id: 'custom-model' } ],
      },
    },
  }
}

describe( 'Key rotation under load with MSW', () => {
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

  it( 'distributes concurrent requests across keys in round-robin order', async () => {
    const authorizations = []
    server.use( http.post( `${ BASE_URL }/chat/completions`, async ( { request } ) => {
      authorizations.push( request.headers.get( 'authorization' ) )
      return HttpResponse.json( {
        id: 'chatcmpl-load',
        object: 'chat.completion',
        created: Math.floor( Date.now() / 1000 ),
        model: 'custom-model',
        choices: [ {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        } ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } )
    } ) )

    const { app, close } = await createTestApp( { config: createRotationConfig() } )

    try {
      await Promise.all(
        Array.from( { length: 4 }, () => request( app )
          .post( '/chat/completions' )
          .set( 'Authorization', 'Bearer test-client-token' )
          .send( {
            model: 'requesty/custom-model',
            messages: [ { role: 'user', content: 'rotate me' } ],
          } )
          .expect( 200 ) ),
      )

      const counts = authorizations.reduce( ( acc, value ) => ( {
        ...acc,
        [ value ]: ( acc[ value ] || 0 ) + 1,
      } ), {} )

      expect( counts[ 'Bearer key-a' ] ).toBe( 2 )
      expect( counts[ 'Bearer key-b' ] ).toBe( 2 )
    } finally {
      await close()
    }
  } )

  it( 'returns pool unavailable when all keys are cooling', async () => {
    const { app, close, services } = await createTestApp( { config: createRotationConfig() } )

    try {
      services.keyRegistry.flagFailure( 'requesty', 'key-a', { statusCode: 429 } )
      services.keyRegistry.flagFailure( 'requesty', 'key-b', { statusCode: 429 } )

      const response = await request( app )
        .post( '/chat/completions' )
        .set( 'Authorization', 'Bearer test-client-token' )
        .send( {
          model: 'requesty/custom-model',
          messages: [ { role: 'user', content: 'all keys cooling' } ],
        } )
        .expect( 503 )

      expect( response.body.error.code ).toBe( 'poolUnavailable' )
    } finally {
      await close()
    }
  } )

  it( 'reroutes to the remaining key after one key enters cooldown', async () => {
    const attemptsByAuth = new Map()
    server.use( http.post( `${ BASE_URL }/chat/completions`, async ( { request } ) => {
      const authorization = request.headers.get( 'authorization' )
      attemptsByAuth.set( authorization, ( attemptsByAuth.get( authorization ) || 0 ) + 1 )

      if ( authorization === 'Bearer key-a' && attemptsByAuth.get( authorization ) === 1 ) {
        return HttpResponse.json(
          { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error', message: 'Too many requests' } },
          { status: 429 },
        )
      }

      return HttpResponse.json( {
        id: 'chatcmpl-reroute',
        object: 'chat.completion',
        created: Math.floor( Date.now() / 1000 ),
        model: 'custom-model',
        choices: [ {
          index: 0,
          message: { role: 'assistant', content: authorization },
          finish_reason: 'stop',
        } ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } )
    } ) )

    const { app, close } = await createTestApp( { config: createRotationConfig() } )

    try {
      const first = await request( app )
        .post( '/chat/completions' )
        .set( 'Authorization', 'Bearer test-client-token' )
        .send( {
          model: 'requesty/custom-model',
          messages: [ { role: 'user', content: 'first request' } ],
        } )
        .expect( 200 )

      const second = await request( app )
        .post( '/chat/completions' )
        .set( 'Authorization', 'Bearer test-client-token' )
        .send( {
          model: 'requesty/custom-model',
          messages: [ { role: 'user', content: 'second request' } ],
        } )
        .expect( 200 )

      expect( first.body.choices[ 0 ].message.content ).toBe( 'Bearer key-b' )
      expect( second.body.choices[ 0 ].message.content ).toBe( 'Bearer key-b' )
      expect( attemptsByAuth.get( 'Bearer key-a' ) ).toBe( 1 )
      expect( attemptsByAuth.get( 'Bearer key-b' ) ).toBeGreaterThanOrEqual( 2 )
    } finally {
      await close()
    }
  } )
} )
