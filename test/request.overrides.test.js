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

  it('should map thinking levels to budgets when undefined', () => {
    const req = {};
    const rawReq = {
      headers: {
        'x-gateway-thinking-level': 'high',
      },
    };
    applyRequestOverrides(req, rawReq);
    expect(req.thinkingLevel).toBe('high');
    expect(req.thinkingEnabled).toBe(true);
    expect(req.thinkingBudget).toBe(4096);
  });

  it('should not overwrite thinking budget if already defined', () => {
    const req = { thinkingBudget: 999 };
    const rawReq = {
      headers: {
        'x-gateway-thinking-level': 'low',
      },
    };
    applyRequestOverrides(req, rawReq);
    expect(req.thinkingLevel).toBe('low');
    expect(req.thinkingEnabled).toBe(true);
    expect(req.thinkingBudget).toBe(999);
  });

  it('should map invalid thinking level name to undefined budget without crashing', () => {
    const req = {};
    const rawReq = {
      headers: {
        'x-gateway-thinking-level': 'ultra',
      },
    };
    applyRequestOverrides(req, rawReq);
    expect(req.thinkingLevel).toBe('ultra');
    expect(req.thinkingEnabled).toBe(true);
    expect(req.thinkingBudget).toBeUndefined();
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
