/**
 * @fileoverview Stream-specific error classification rules.
 * Resolves HTTP status codes from stream error payloads for upstream error handling.
 * @module common/errorClassification/streamErrorRules
 */

import { streamRule } from './classifierCore.js';

/**
 * Stream error classification rules.
 * Maps error type/code patterns to HTTP status codes.
 */
const STREAM_STATUS_RULES = [
  streamRule((ctx) => ctx.typeLower.includes('rate_limit') || ctx.codeLower.includes('rate_limit'), 429),
  streamRule((ctx) => ctx.typeLower.includes('authentication') || ctx.codeLower.includes('api_key') || ctx.codeLower === 'no_api_key', 401),
  streamRule((ctx) => ctx.typeLower.includes('permission') || ctx.codeLower === 'forbidden' || ctx.codeLower === 'region_not_supported', 403),
  streamRule((ctx) => ctx.typeLower.includes('billing') || ctx.codeLower.includes('quota') || ctx.codeLower.includes('billing'), 402),
  streamRule((ctx) => ctx.typeLower.includes('invalid_request') || ctx.codeLower.includes('invalid_'), 400),
  streamRule((ctx) => ctx.typeLower.includes('not_found') || ctx.codeLower.includes('not_found'), 404),
  streamRule((ctx) => ctx.typeLower.includes('overloaded') || ctx.codeLower === 'engine_overloaded', 503),
];

function isValidStatusCode(val) {
  return typeof val === 'number' && val >= 100 && val < 600;
}

/**
 * Resolves an HTTP status code from a stream error payload.
 *
 * @param {any} errorPayload - Parsed SSE error JSON.
 * @param {number} [fallback=502] - Default status when none is present.
 * @returns {number}
 */
export function resolveStreamErrorStatus(errorPayload, fallback = 502) {
  const err = errorPayload?.error || errorPayload;
  if (isValidStatusCode(err?.code)) return err.code;
  if (isValidStatusCode(err?.status_code)) return err.status_code;
  if (isValidStatusCode(err?.status)) return err.status;

  const ctx = {
    codeLower: String(err?.code || '').toLowerCase(),
    typeLower: String(err?.type || '').toLowerCase(),
  };

  for (const r of STREAM_STATUS_RULES) {
    if (r.match(ctx)) {
      return r.result(ctx).status;
    }
  }

  return fallback;
}
