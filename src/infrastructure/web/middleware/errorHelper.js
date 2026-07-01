/**
 * @fileoverview Shared helper for emitting a protocol-correct HTTP error
 * envelope from middleware (auth, rate limit, validation).
 *
 * Centralizing this keeps the error shape consistent: every gateway-issued
 * error follows the same envelope as controller-issued errors, projected
 * into the client's ingress protocol.
 */

import { buildClientErrorEnvelope } from '../../../domain/errors/envelope.js';
import { statusToErrorType } from '../../../domain/errors/httpErrorTypes.js';
import { resolveIngressFormat } from './common.js';

/**
 * Sends a standardized HTTP error response, shaped according to the
 * client's ingress protocol (OpenAI or Anthropic).
 *
 * The function:
 * 1. Resolves the canonical error `type` (e.g. `'rate_limit_error'` for a
 *    429) from the HTTP status code via `statusToErrorType`, unless the
 *    caller passed an explicit override.
 * 2. Builds the client envelope via `buildClientErrorEnvelope` with the
 *    target format derived from the request URL.
 * 3. Writes the response with the supplied status code and JSON body.
 *
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').Request} req - Express request object.
 * @param {number} status - HTTP status code to send.
 * @param {string} code - Application-specific error code (e.g. `'unauthorized'`).
 * @param {string} message - Human-readable error message.
 * @param {string} [errorType] - Optional override for the resolved error type.
 *   When omitted, `statusToErrorType(status)` decides.
 * @param {Object} [details] - Optional structured details bag surfaced under
 *   `error.details` in the OpenAI envelope.
 * @returns {import('express').Response} The Express response (for chaining).
 */
export const sendHttpError = (res, req, status, code, message, errorType = null, details = null) => {
  const resolvedErrorType = errorType || statusToErrorType(status);
  const envelope = buildClientErrorEnvelope({
    errorCode: code,
    message,
    errorType: resolvedErrorType,
    details,
  }, resolveIngressFormat(req));

  return res.status(status).json(envelope);
};