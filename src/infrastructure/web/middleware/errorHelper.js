import { buildClientErrorEnvelope } from '../../../domain/errors/envelope.js';
import { statusToErrorType } from '../../../domain/errors/httpErrorTypes.js';
import { resolveIngressFormat } from './ingressFormat.js';

/**
 * Shared utility to build and send a standardized HTTP error response.
 *
 * @param {Object} res - Express response object.
 * @param {Object} req - Express request object.
 * @param {number} status - HTTP status code.
 * @param {string} code - Application-specific error code.
 * @param {string} message - Error message.
 * @param {string} [errorType] - Optional override error type.
 * @returns {Object} Express response.
 */
export const sendHttpError = (res, req, status, code, message, errorType = null, details = null) => {
  const resolvedErrorType = errorType || statusToErrorType(status);
  const envelope = buildClientErrorEnvelope({
    code,
    message,
    errorType: resolvedErrorType,
    details,
  }, resolveIngressFormat(req));

  return res.status(status).json(envelope);
};
