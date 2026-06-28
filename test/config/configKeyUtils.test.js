import { describe, it, expect, vi } from 'vitest';
import {
  filterValidKeys,
  getProviderKeyCandidate,
  isCloudflareKeyEntry,
} from '../../src/config/configKeyUtils.js';

describe( 'filterValidKeys', () => {
  it( 'filters null, undefined, and empty string keys while logging warnings', () => {
    const logger = {
      warning: vi.fn(),
    };

    const result = filterValidKeys(
      [ 'key-1', '', '  ', null, undefined, 'key-2' ],
      'openai',
      logger,
    );

    expect( result ).toEqual( [ 'key-1', 'key-2' ] );
    expect( logger.warning ).toHaveBeenCalledTimes( 4 );
  } );

  it( 'supports validating derived values while returning original entries', () => {
    const logger = {
      warning: vi.fn(),
    };

    const entries = [
      { index: 0, item: 'key-1' },
      { index: 1, item: '' },
      { index: 2, item: 'key-2' },
    ];

    const result = filterValidKeys( entries, 'anthropic', logger, ( { item } ) => item );

    expect( result ).toEqual( [
      { index: 0, item: 'key-1' },
      { index: 2, item: 'key-2' },
    ] );
    expect( logger.warning ).toHaveBeenCalledOnce();
  } );

  it( 'extracts apiKey from Cloudflare credential entries', () => {
    expect( getProviderKeyCandidate( {
      apiKey: 'cf-key',
      accountId: 'acct-123',
    } ) ).toBe( 'cf-key' );
  } );

  it( 'detects Cloudflare credential entries', () => {
    expect( isCloudflareKeyEntry( {
      apiKey: 'cf-key',
      accountId: 'acct-123',
    } ) ).toBe( true );
    expect( isCloudflareKeyEntry( 'plain-key' ) ).toBe( false );
  } );

  it( 'rejects Cloudflare-shaped objects with empty or non-string fields', () => {
    expect( isCloudflareKeyEntry( { apiKey: '', accountId: 'acct' } ) ).toBe( false );
    expect( isCloudflareKeyEntry( { apiKey: 'k', accountId: '' } ) ).toBe( false );
    expect( isCloudflareKeyEntry( { apiKey: 'k' } ) ).toBe( false );
    expect( isCloudflareKeyEntry( { apiKey: 42, accountId: 'acct' } ) ).toBe( false );
    expect( isCloudflareKeyEntry( { apiKey: 'k', accountId: null } ) ).toBe( false );
    expect( isCloudflareKeyEntry( null ) ).toBe( false );
    expect( isCloudflareKeyEntry( undefined ) ).toBe( false );
  } );
} );
