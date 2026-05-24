import { describe, it, expect } from 'vitest';
import { applyRequestOverrides } from '../src/services/requestOverrides.js';

describe('Request Overrides Tests', () => {
  it('should return immediately when rawReq or headers are missing', () => {
    const req = { temperature: 0.5 };
    applyRequestOverrides(req, null);
    expect(req.temperature).toBe(0.5);

    applyRequestOverrides(req, {});
    expect(req.temperature).toBe(0.5);
  });

  it('should set thinking level and thinkingEnabled from header overrides', () => {
    const req = {};
    const rawReq = {
      headers: {
        'x-gateway-thinking-level': 'high',
      },
    };
    applyRequestOverrides(req, rawReq);
    expect(req.thinkingLevel).toBe('high');
    expect(req.thinkingEnabled).toBe(true);
  });

  it('should apply valid temperature and ignore NaN temperature', () => {
    // Valid case
    let req = { temperature: 0.5 };
    let rawReq = {
      headers: {
        'x-gateway-temperature': '1.2',
      },
    };
    applyRequestOverrides(req, rawReq);
    expect(req.temperature).toBe(1.2);

    // Invalid case (NaN)
    req = { temperature: 0.5 };
    rawReq = {
      headers: {
        'x-gateway-temperature': 'not-a-number',
      },
    };
    applyRequestOverrides(req, rawReq);
    expect(req.temperature).toBe(0.5); // remains unchanged
  });
});
