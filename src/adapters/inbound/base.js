/**
 * @fileoverview Base class for all protocol controllers.
 * Provides shared logic for request lifecycle management, logging, and error handling.
 */

import { getAppLogger } from '../../infrastructure/logging/logger.js';
import { createRequestLog } from '../../infrastructure/logging/requestLogger.js';
import { resolveModel } from '../../domain/routing/router.js';
import { transformRequest } from '../../domain/routing/transformer.js';
import { FORMATS, translateError } from '../transforms/index.js';
import { buildClientErrorEnvelope } from '../../domain/errors/envelope.js';
import { statusToErrorType } from '../../domain/errors/httpErrorTypes.js';
import { normalizeUpstreamError, UpstreamError } from '../../domain/errors/upstream.js';
import { buildUpstreamErrorLogFields } from '../../infrastructure/logging/upstreamErrorLogMeta.js';

/**
 * Base class for all protocol controllers.
 *
 * Provides shared logic for request lifecycle management, logging, and
 * error handling across the OpenAI and Anthropic ingress controllers.
 *
 * Subclasses supply protocol-specific bits (request body translation,
 * response translation, stream handling) via `executeRequest`'s `options`
 * bag. Everything else — request log creation, error envelope shaping,
 * dry-run handling, and SSE error emission — lives here.
 */

/**
 * @class
 * @classdesc Shared base class for ingress controllers.
 */
export class BaseController {
  /**
   * @param {import('../../application/orchestrator.js').UnifiedOrchestrator} orchestrator -
   *   The shared orchestrator.
   * @param {string} protocolName - The protocol name (used as logger category and
   *   default target format).
   */
  constructor(orchestrator, protocolName) {
    this.orchestrator = orchestrator;
    this.protocolName = protocolName;
    this.targetFormat = protocolName;
    this.logger = getAppLogger(protocolName);
  }

  /**
   * Standardized error response handler. Translates the upstream error into the
   * ingress protocol's native shape and writes the resulting envelope to the
   * per-request debug folder before sending it to the client.
   *
   * Status code resolution precedence:
   * 1. Explicit `statusCode` argument.
   * 2. `error.httpStatus` (set by `buildFinalError`/`buildCancelledError`).
   * 3. `error.statusCode` (set by normalized upstream errors).
   * 4. `500` (catch-all).
   *
   * Side effects: writes the error envelope to the request log via
   * `reqLog.logClientResponse` and finalizes the log file via `reqLog.finalize`.
   *
   * @async
   * @param {import('express').Response} res - Express response object.
   * @param {Object|null} reqLog - Per-request logger.
   * @param {Object} error - The error envelope to send (from buildFinalError / buildCancelledError / etc).
   * @param {number} [statusCode=null] - Optional override HTTP status.
   * @returns {Promise<import('express').Response>} Express response.
   */
  async handleError(res, reqLog, error, statusCode = null) {
    const finalStatus = statusCode
      || error?.httpStatus
      || (typeof error?.statusCode === 'number' ? error.statusCode : null)
      || 500;
    const logMeta = buildUpstreamErrorLogFields({
      message: error?.message,
      errorCode: error?.errorCode ?? error?.code,
      errorType: error?.errorType ?? error?.type,
      provider: error?.provider,
      retryAfterSeconds: error?.retryAfterSeconds,
      statusCode: finalStatus,
    });
    this.logger.debug('Handling controller error', logMeta);

    if (error?.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }

    const targetFormat = this.targetFormat;
    const errorType = error?.errorType ?? error?.type ?? statusToErrorType(finalStatus);
    const errorBody = buildClientErrorEnvelope({
      message: error?.message,
      errorCode: error?.errorCode ?? error?.code,
      errorType,
    }, targetFormat);

    if (reqLog) {
      reqLog.logClientResponse(finalStatus, errorBody);
      await reqLog.finalize();
    }

    return res.status(finalStatus).json(errorBody);
  }

  /**
   * Emits a translated SSE error envelope before closing the stream.
   *
   * Normalizes the supplied error (which may be a raw `UpstreamError` or
   * any thrown value), translates it from the upstream's protocol shape
   * to the ingress protocol shape via `translateError`, builds the
   * client-facing envelope, and writes one or more SSE frames to the
   * response. The frame text is also appended to the request log so
   * post-mortem analysis can replay exactly what reached the client.
   *
   * @param {import('express').Response} res - Express response.
   * @param {Object} reqLog - Per-request logger.
   * @param {any} err - The caught stream error.
   * @param {Function} formatSseError - Provider-specific SSE formatter
   *   (e.g. `formatOpenAiSseError` or `formatAnthropicSseError`).
   * @param {string} upstreamFormat - Upstream provider format (FORMATS.OPENAI / ANTHROPIC / GEMINI).
   * @param {string} ingressFormat - Ingress protocol format (FORMATS.OPENAI / ANTHROPIC).
   * @param {number} chunkCount - Number of chunks yielded before the error.
   * @returns {void}
   */
  emitStreamError(res, reqLog, err, formatSseError, upstreamFormat, ingressFormat, chunkCount) {
    const providerFallback = upstreamFormat === FORMATS.GEMINI ? 'gemini'
      : upstreamFormat === FORMATS.ANTHROPIC ? 'anthropic'
      : 'openai';
    const normalized = err instanceof UpstreamError
      ? {
        message: err.message,
        statusCode: err.statusCode,
        errorCode: err.errorCode,
        errorType: err.errorType,
        retryAfterSeconds: err.retryAfterSeconds,
        provider: err.provider && err.provider !== 'unknown' ? err.provider : providerFallback,
        upstreamBody: err.upstreamBody ?? null,
      }
      : normalizeUpstreamError(err, providerFallback);

    const translated = translateError(upstreamFormat, ingressFormat, normalized);
    const targetFormat = ingressFormat;
    const errorType = translated.type || statusToErrorType(normalized.statusCode);
    const envelope = buildClientErrorEnvelope({
      message: translated.message,
      errorCode: translated.code,
      errorType,
    }, targetFormat);

    if (translated.retryAfterSeconds !== undefined && !res.headersSent) {
      res.setHeader('Retry-After', String(translated.retryAfterSeconds));
    }

    const sseData = formatSseError(envelope);
    reqLog.appendStreamEvent('client', sseData);
    res.write(sseData);

    this.logger.debug('SSE stream error emitted to client', {
      chunkCount,
      ...buildUpstreamErrorLogFields(normalized),
    });
    reqLog.logClientResponse(200, {
      _streamed: true,
      _aborted: true,
      _eventCount: chunkCount,
      error: envelope.error,
    });
  }

  /**
   * Core request execution logic shared across controllers.
   *
   * The function:
   * 1. Creates a per-request debug logger.
   * 2. Translates the ingress-protocol body to the internal hub format.
   * 3. Resolves the model via the routing layer.
   * 4. Invokes the orchestrator and routes the result to:
   *    - `handleError` on error envelopes.
   *    - `handleStream` on async iterables.
   *    - `res.json` on plain objects (with optional response translation).
   * 5. Catches thrown errors (dry-run, upstream, unexpected) and routes
   *    them through `handleError`.
   *
   * Side effects: writes the per-request debug folder via `reqLog`.
   *
   * @async
   * @param {import('express').Request} req - Express request.
   * @param {import('express').Response} res - Express response.
   * @param {Object} options - Options bag.
   * @param {string} options.protocolName - 'OpenAI' or 'Anthropic'.
   * @param {string} options.ingressFormat - FORMATS.OPENAI or FORMATS.ANTHROPIC.
   * @param {Function} [options.translateReq] - Body translation to hub format.
   * @param {Function} [options.translateRes] - Hub-to-ingress response translation.
   * @param {Function} options.handleStream - Streaming response handler.
   * @returns {Promise<import('express').Response>}
   */
  async executeRequest(req, res, options) {
    const {
      translateReq,
      translateRes,
      handleStream,
      protocolName,
      ingressFormat,
    } = options;

    const reqLog = await createRequestLog(req, this.orchestrator.config);

    let resolvedProvider = null;

    try {
      if (req.isDryRun && !this.orchestrator.config?.logging?.logRequests) {
        const error = new Error('Dry run requires request logging to be enabled');
        error.httpStatus = 502;
        error.code = 'dryRunDisabled';
        return this.handleError(res, reqLog, error);
      }

      const body = req.body || {};
      const providersConfig = this.orchestrator.config?.providers || {};

      const baseReq = translateReq ? translateReq(body) : body;
      const resolved = resolveModel(body.model, providersConfig);
      resolvedProvider = resolved?.provider || null;
      const unifiedReq = transformRequest(baseReq, resolved);
      unifiedReq.resolvedModel = resolved;

      this.logger.debug(`${protocolName} completion request received`, {
        model: body.model,
        stream: body.stream || false,
        resolvedProvider: unifiedReq.provider,
        resolvedModel: unifiedReq.modelid,
      });

      const response = await this.orchestrator.executeCompletion(unifiedReq, req, reqLog);

      if (response?.error) {
        this.logger.debug(`${protocolName} completion failed`, { error: response.error });
        return this.handleError(res, reqLog, response.error);
      }

      if (response && typeof response[Symbol.asyncIterator] === 'function') {
        return handleStream(res, response, unifiedReq, reqLog, body);
      }

      this.logger.debug(`${protocolName} non-stream response sent successfully`);
      const finalResponse = translateRes ? translateRes(response, body) : response;
      reqLog.logClientResponse(200, finalResponse);
      await reqLog.finalize();
      return res.json(finalResponse);
    } catch (err) {
      if (err.isDryRun) {
        const dryRunResponse = {
          dryRun: true,
          message: 'Dry run completed successfully. Request not sent to provider.',
          request: {
            url: err.url,
            headers: err.headers,
            body: err.payload,
          },
        };
        await reqLog.finalize();
        return res.json(dryRunResponse);
      }
      this.logger.error(`Unexpected ${protocolName} completion error:`, err);
      if (err.code && err.httpStatus) {
        return this.handleError(res, reqLog, err);
      }
      if (err instanceof UpstreamError || err.statusCode !== undefined) {
        const normalized = normalizeUpstreamError(err, resolvedProvider || ingressFormat);
        return this.handleError(res, reqLog, normalized);
      }
      return this.handleError(res, reqLog, {
        code: 'internalServerError',
        message: 'An unexpected error occurred.',
        httpStatus: 500,
      });
    }
  }
}
