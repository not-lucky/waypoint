/**
 * @fileoverview Transport error classification and client status mapping.
 * Handles network/transport failures that have no HTTP status from the provider.
 */

import { ERROR_CATEGORIES, PERMISSION_CODES } from './policy.js';

const CLIENT_STATUS_RULES = [
  {
    match: (_upstreamStatus, _category, code) => code === 'forbidden' || code === 'region_not_supported',
    status: 403,
  },
  {
    match: (_upstreamStatus, _category, code) => code === 'insufficient_quota' || code === 'billing_hard_limit_reached',
    status: 402,
  },
  {
    match: (_upstreamStatus, _category, code) => code === 'invalid_api_key' || code === 'no_api_key',
    status: 401,
  },
  {
    match: (_upstreamStatus, _category, code) => (
      PERMISSION_CODES.has(code)
      && code !== 'forbidden'
      && code !== 'region_not_supported'
    ),
    status: 401,
  },
  {
    match: (upstreamStatus, category) => (
      category === ERROR_CATEGORIES.AUTH && upstreamStatus === 402
    ),
    status: 402,
  },
  {
    match: (upstreamStatus, category) => (
      category === ERROR_CATEGORIES.AUTH && upstreamStatus === 403
    ),
    status: 403,
  },
  {
    match: (_upstreamStatus, category) => category === ERROR_CATEGORIES.AUTH,
    status: 401,
  },
  {
    match: (_upstreamStatus, category, code) => category === ERROR_CATEGORIES.SERVER && code === 'internal_server_error',
    status: 502,
  },
  {
    match: (upstreamStatus) => upstreamStatus === 500,
    status: 502,
  },
];

/**
 * Maps upstream status code and category/code to the status code we return to the client.
 *
 * @param {number} upstreamStatus - HTTP status code from upstream.
 * @param {string} category - Error category slug.
 * @param {string} code - Machine-readable error code.
 * @returns {number} HTTP status code to return to client.
 */
export function getClientHttpStatus(upstreamStatus, category, code) {
  for (const rule of CLIENT_STATUS_RULES) {
    if (rule.match(upstreamStatus, category, code)) {
      return rule.status;
    }
  }
  return upstreamStatus || 502;
}

/**
 * Classifies network/transport failures that have no HTTP status from the provider.
 *
 * @param {any} error - Caught transport error.
 * @returns {{ code: string, category: string, message: string, httpStatus: number }}
 */
export function classifyTransportError(error) {
  const message = error?.message || String(error);
  const msgLower = message.toLowerCase();
  let code = 'connect_timeout';

  if (msgLower.includes('ssl') || msgLower.includes('tls') || msgLower.includes('certificate') || msgLower.includes('cert') || msgLower.includes('handshake')) {
    code = 'tls_error';
  } else if (error?.name === 'TimeoutError' || msgLower.includes('timeout') || msgLower.includes('abort') || error?.code === 'ETIMEDOUT') {
    code = 'read_timeout';
  } else if (msgLower.includes('dns') || msgLower.includes('enotfound') || msgLower.includes('eaddrinfo') || msgLower.includes('econnrefused') || msgLower.includes('econnreset') || msgLower.includes('fetch failed')) {
    code = 'connect_timeout';
  }

  let httpStatus = 503;
  if (code === 'read_timeout') {
    httpStatus = 504;
  }

  return {
    code,
    category: ERROR_CATEGORIES.TRANSPORT,
    message: `Upstream connection failed: ${message}`,
    httpStatus,
  };
}
