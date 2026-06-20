/**
 * @fileoverview Base class for all protocol controllers.
 * Provides shared logic for request lifecycle management, logging, and error handling.
 */

import { getAppLogger } from '../logging/logger.js';
import { createRequestLog } from '../logging/requestLogger.js';
import { resolveModel } from '../domain/modelRouter.js';
import { transformRequest } from '../domain/requestTransformer.js';
import { FORMATS, translateError } from '../transforms/index.js';
import { buildClientErrorEnvelope } from '../errors/envelope.js';
import { normalizeUpstreamError, UpstreamError } from '../errors/upstream.js';
import { buildUpstreamErrorLogFields } from '../logging/upstreamErrorLogMeta.js';

export class BaseController {
  constructor(orchestrator, protocolName) {
    this.orchestrator = orchestrator;
    this.logger = getAppLogger(protocolName);
  }

  /**
   * Standardized error response handler. Translates the upstream error into the
   * ingress protocol's native shape and writes the resulting envelope to the
   * per-request debug folder before sending it to the client.
   *
   * @param {Object} res - Express response object.
   * @param {Object} reqLog - Per-request logger.
   * @param {Object} error - The error envelope to send (from buildFinalError / buildCancelledError / etc).
   * @param {number} [statusCode=null] - Optional override HTTP status.
   * @returns {Object} Express response.
   */
  async handleError(res, reqLog, error, statusCode = null) {
    const finalStatus = statusCode || error?.httpStatus || 500;
    const logMeta = buildUpstreamErrorLogFields({
      message: error?.message,
      errorCode: error?.code,
      errorType: error?.type,
      provider: error?.provider,
      retryAfterSeconds: error?.retryAfterSeconds,
      statusCode: finalStatus,
    });
    this.logger.debug('Handling controller error', logMeta);

    if (error?.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }

    // Pass-through envelope — controller sets a single shape and translateError
    // is responsible for the protocol-specific projection at the SSE boundary.
    const errorBody = buildClientErrorEnvelope({
      statusCode: finalStatus,
      message: error?.message,
      errorCode: error?.code,
      errorType: error?.type,
      provider: error?.provider,
      retryAfterSeconds: error?.retryAfterSeconds,
      upstreamBody: error?.upstreamBody,
    });

    if (reqLog) {
      reqLog.logClientResponse(finalStatus, errorBody);
      await reqLog.finalize();
    }

    return res.status(finalStatus).json(errorBody);
  }

  /**
   * Emits a translated SSE error envelope before closing the stream.
   *
   * @param {Object} res
   * @param {Object} reqLog
   * @param {any} err
   * @param {Function} formatSseError - Provider-specific SSE formatter.
   * @param {string} upstreamFormat - Upstream provider format (FORMATS.OPENAI / ANTHROPIC / GEMINI).
   * @param {string} ingressFormat - Ingress protocol format (FORMATS.OPENAI / ANTHROPIC).
   * @param {number} chunkCount
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
    const envelope = buildClientErrorEnvelope({
      statusCode: translated.statusCode,
      message: translated.message,
      errorCode: translated.code,
      errorType: translated.type,
      provider: translated.provider,
      retryAfterSeconds: translated.retryAfterSeconds,
      upstreamBody: translated.upstreamBody,
    });

    if (envelope.error.retryAfterSeconds !== undefined && !res.headersSent) {
      res.setHeader('Retry-After', String(envelope.error.retryAfterSeconds));
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
   * @param {Object} req - Express request.
   * @param {Object} res - Express response.
   * @param {Object} options
   * @param {string} options.protocolName - 'OpenAI' or 'Anthropic'.
   * @param {string} options.ingressFormat - FORMATS.OPENAI or FORMATS.ANTHROPIC.
   * @param {Function} [options.translateReq]
   * @param {Function} [options.translateRes]
   * @param {Function} options.handleStream
   * @returns {Promise<Object>}
   */
  async executeRequest(req, res, options) {
    const {
      translateReq,
      translateRes,
      handleStream,
      protocolName,
      ingressFormat,
    } = options;

    const reqLog = createRequestLog(req, this.orchestrator.config);

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
      const unifiedReq = transformRequest(baseReq, resolved);
      unifiedReq.resolvedModel = resolved;

      this.logger.debug(`${protocolName} completion request received`, {
        model: body.model,
        stream: body.stream || false,
        resolvedProvider: unifiedReq.provider,
        resolvedModel: unifiedReq.actualModelId,
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
      if (err instanceof UpstreamError) {
        const normalized = normalizeUpstreamError(err, ingressFormat === FORMATS.ANTHROPIC ? 'anthropic' : 'openai');
        return this.handleError(res, reqLog, normalized);
      }
      if (err.statusCode !== undefined) {
        const normalized = normalizeUpstreamError(err, ingressFormat === FORMATS.ANTHROPIC ? 'anthropic' : 'openai');
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
