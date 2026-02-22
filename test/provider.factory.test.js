import { describe, it, expect } from 'vitest';
import { ProviderFactory } from '../src/adapters/ProviderFactory';

describe('ProviderFactory Tests', () => {
  it('should register a stub, get returns same instance', () => {
    const factory = new ProviderFactory();
    const stubAdapter = { name: 'stub-adapter' };

    factory.register('stub', stubAdapter);

    expect(factory.get('stub')).toBe(stubAdapter);
  });
});
