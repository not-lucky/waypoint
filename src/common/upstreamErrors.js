/**
 * @fileoverview Single-source-of-truth error classification and mapping for upstream providers.
 */

export const ERROR_CATEGORIES = {
  AUTH: 'Auth & billing',
  BILLING: 'Auth & billing',
  VALIDATION: 'Request validation',
  RATE_LIMIT: 'Rate limiting',
  MODEL_RESOURCE: 'Model & resource',
  CONTENT_POLICY: 'Content policy',
  SERVER: 'Server errors',
  STREAMING: 'Streaming',
  TRANSPORT: 'Network/transport',
};

export class UpstreamError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.statusCode = options.statusCode || 500;
    this.errorType = options.errorType || 'api_error';
    this.errorCode = options.errorCode || 'internal_server_error';
    this.upstreamBody = options.upstreamBody || null;
    this.provider = options.provider || 'unknown';
    this.retryAfterSeconds = options.retryAfterSeconds || undefined;
    this.category = options.category || ERROR_CATEGORIES.SERVER;
  }
}

/**
 * Classifies an upstream error message, status code, and body.
 *
 * @param {number} statusCode - HTTP status code from upstream.
 * @param {any} errorBody - Parsed JSON or string body from upstream.
 * @param {Object} [headers] - Response headers (e.g. for Retry-After).
 * @returns {{ type: string, code: string, category: string, message: string }}
 */
export function classifyUpstreamError(statusCode, errorBody, headers = {}) {
  const errObj = errorBody?.error || errorBody || {};
  const type = errObj?.type || '';
  const code = errObj?.code || '';
  const message = errObj?.message || (typeof errorBody === 'string' ? errorBody : '');

  // Normalize inputs to lowercase for robust keyword matching
  const msgLower = message.toLowerCase();
  const codeLower = String(code).toLowerCase();

  // Retry-After header extraction
  let retryAfterSeconds;
  if (headers) {
    const retryAfterHeader = headers['retry-after'] || headers['Retry-After'];
    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10);
      if (!Number.isNaN(parsed)) {
        retryAfterSeconds = parsed;
      }
    }
  }

  // 1. HTTP 401 - Auth
  if (statusCode === 401) {
    let errorCode = 'invalid_api_key';
    if (msgLower.includes('no authorization') || msgLower.includes('missing') || codeLower === 'no_api_key') {
      errorCode = 'no_api_key';
    }
    return {
      type: 'authentication_error',
      code: errorCode,
      category: ERROR_CATEGORIES.AUTH,
      message,
    };
  }

  // 2. HTTP 403 - Permission Denied
  if (statusCode === 403) {
    return {
      type: 'permission_denied_error',
      code: 'forbidden',
      category: ERROR_CATEGORIES.AUTH,
      message,
    };
  }

  // 3. HTTP 402 - Billing / Insufficient Quota
  if (statusCode === 402) {
    let errorCode = 'insufficient_quota';
    if (msgLower.includes('hard limit') || codeLower.includes('hard_limit')) {
      errorCode = 'billing_hard_limit_reached';
    }
    return {
      type: 'billing_error',
      code: errorCode,
      category: ERROR_CATEGORIES.BILLING,
      message,
    };
  }

  // 4. HTTP 429 - Rate Limiting
  if (statusCode === 429) {
    let errorCode = 'rate_limit_exceeded';
    if (msgLower.includes('tokens per minute') || msgLower.includes('tpm') || codeLower.includes('tokens')) {
      errorCode = 'tokens_per_minute_exceeded';
    } else if (msgLower.includes('concurrent') || codeLower.includes('concurrent')) {
      errorCode = 'concurrent_requests_exceeded';
    } else if (msgLower.includes('daily') || msgLower.includes('monthly') || codeLower.includes('daily') || codeLower.includes('quota')) {
      errorCode = 'daily_tokens_exceeded';
    }
    return {
      type: 'rate_limit_error',
      code: errorCode,
      category: ERROR_CATEGORIES.RATE_LIMIT,
      message,
      retryAfterSeconds,
    };
  }

  // 5. HTTP 404 - Not Found / Endpoint
  if (statusCode === 404) {
    let errorCode = 'model_not_found';
    if (msgLower.includes('endpoint') || msgLower.includes('path') || msgLower.includes('url') || msgLower.includes('page') || msgLower.includes('route') || msgLower.includes('html')) {
      errorCode = 'endpoint_not_found';
    }
    return {
      type: 'not_found_error',
      code: errorCode,
      category: ERROR_CATEGORIES.MODEL_RESOURCE,
      message,
    };
  }

  // 6. HTTP 451 - Content policy legal block
  if (statusCode === 451) {
    return {
      type: 'content_policy_violation',
      code: 'content_unavailable_legal',
      category: ERROR_CATEGORIES.CONTENT_POLICY,
      message,
    };
  }

  // 7. HTTP 413 - Payload too large
  if (statusCode === 413) {
    return {
      type: 'invalid_request_error',
      code: 'request_too_large',
      category: ERROR_CATEGORIES.VALIDATION,
      message,
    };
  }

  // 8. HTTP 422 - Unprocessable Entity
  if (statusCode === 422) {
    return {
      type: 'invalid_request_error',
      code: 'unprocessable_entity',
      category: ERROR_CATEGORIES.VALIDATION,
      message,
    };
  }

  // 9. HTTP 400 - Validation or Content Filter or Unsupported Feature
  if (statusCode === 400) {
    // Content filters
    if (msgLower.includes('content filter') || msgLower.includes('safety') || msgLower.includes('policy') || codeLower === 'content_filter') {
      return {
        type: 'content_policy_violation',
        code: 'content_filter',
        category: ERROR_CATEGORIES.CONTENT_POLICY,
        message,
      };
    }
    if (msgLower.includes('moderation') || codeLower === 'moderation_flagged') {
      return {
        type: 'content_policy_violation',
        code: 'moderation_flagged',
        category: ERROR_CATEGORIES.CONTENT_POLICY,
        message,
      };
    }

    // Unsupported features
    if (msgLower.includes('feature not supported') || msgLower.includes('unsupported feature') || codeLower === 'unsupported_feature') {
      return {
        type: 'invalid_request_error',
        code: 'unsupported_feature',
        category: ERROR_CATEGORIES.MODEL_RESOURCE,
        message,
      };
    }

    // Specific request validation failures
    let errorCode = 'invalid_parameter_value';
    if (msgLower.includes('context length') || msgLower.includes('context window') || msgLower.includes('max_tokens exceeds') || codeLower === 'context_length_exceeded') {
      errorCode = 'context_length_exceeded';
    } else if ((msgLower.includes('max_tokens') && (msgLower.includes('too large') || msgLower.includes('exceeds'))) || codeLower === 'max_tokens_too_large') {
      errorCode = 'max_tokens_too_large';
    } else if (msgLower.includes('role') || codeLower === 'invalid_message_role') {
      errorCode = 'invalid_message_role';
    } else if (msgLower.includes('tool') || msgLower.includes('function') || codeLower === 'invalid_tool_definition') {
      errorCode = 'invalid_tool_definition';
    } else if (msgLower.includes('conflict') || msgLower.includes('incompatible') || codeLower === 'incompatible_params') {
      errorCode = 'incompatible_params';
    } else if (msgLower.includes('missing') || msgLower.includes('required') || codeLower === 'missing_required_param') {
      errorCode = 'missing_required_param';
    } else if (msgLower.includes('type') || codeLower === 'invalid_type') {
      errorCode = 'invalid_type';
    }

    return {
      type: 'invalid_request_error',
      code: errorCode,
      category: ERROR_CATEGORIES.VALIDATION,
      message,
    };
  }

  // 10. HTTP 503 - Engine Overloaded vs Service Unavailable
  if (statusCode === 503) {
    if (msgLower.includes('overloaded') || msgLower.includes('capacity') || codeLower === 'engine_overloaded') {
      return {
        type: 'overloaded_error',
        code: 'engine_overloaded',
        category: ERROR_CATEGORIES.MODEL_RESOURCE,
        message,
      };
    }
    return {
      type: 'api_error',
      code: 'service_unavailable',
      category: ERROR_CATEGORIES.SERVER,
      message,
    };
  }

  // 11. HTTP 504 - Gateway Timeout
  if (statusCode === 504) {
    return {
      type: 'api_error',
      code: 'gateway_timeout',
      category: ERROR_CATEGORIES.SERVER,
      message,
    };
  }

  // 12. HTTP 502 - Bad Gateway
  if (statusCode === 502) {
    return {
      type: 'api_error',
      code: 'bad_gateway',
      category: ERROR_CATEGORIES.SERVER,
      message,
    };
  }

  // Default server error for other 5xx
  if (statusCode >= 500) {
    return {
      type: 'api_error',
      code: 'internal_server_error',
      category: ERROR_CATEGORIES.SERVER,
      message,
    };
  }

  // Generic fallback error
  return {
    type: type || 'api_error',
    code: code || 'upstream_error',
    category: ERROR_CATEGORIES.SERVER,
    message,
  };
}

/**
 * Determines if an error is retryable.
 * Requires structured category and code from the classifier.
 */
export function isRetryable(category, code) {
  if (!category || !code) {
    return false;
  }

  if (category === ERROR_CATEGORIES.VALIDATION || category === ERROR_CATEGORIES.CONTENT_POLICY) {
    return false;
  }
  if (category === ERROR_CATEGORIES.MODEL_RESOURCE) {
    return code === 'engine_overloaded';
  }
  return true;
}

/**
 * Determines if an error should trigger key cooldown.
 * Requires structured category and code from the classifier.
 */
export function shouldCooldownKey(category, code) {
  if (!category || !code) {
    return false;
  }

  // Key configuration/auth issues
  if (category === ERROR_CATEGORIES.AUTH) {
    return true;
  }
  // Billing quota issues (exhausted keys)
  if (category === ERROR_CATEGORIES.BILLING) {
    return true;
  }
  // Rate limiting issues
  if (category === ERROR_CATEGORIES.RATE_LIMIT) {
    return true;
  }
  // Engine overloaded / server down
  if (category === ERROR_CATEGORIES.SERVER || (category === ERROR_CATEGORIES.MODEL_RESOURCE && code === 'engine_overloaded')) {
    return true;
  }
  return false;
}

/**
 * Maps upstream status code and category/code to the status code we return to the client.
 */
export function getClientHttpStatus(upstreamStatus, category, code) {
  if (code === 'forbidden') {
    return 403;
  }
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
    return 402;
  }
  if (code === 'invalid_api_key' || code === 'no_api_key') {
    return 401;
  }

  // fallback for auth & billing category
  if (category === ERROR_CATEGORIES.AUTH) {
    if (upstreamStatus === 402) {
      return 402;
    }
    if (upstreamStatus === 403) {
      return 403;
    }
    return 401;
  }

  if (category === ERROR_CATEGORIES.SERVER && code === 'internal_server_error') {
    // "If persists, return 502 (bad gateway) to client."
    return 502;
  }

  if (upstreamStatus === 500) {
    return 502;
  }

  return upstreamStatus || 502;
}
