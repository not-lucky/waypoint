import { getAppLogger } from '../logging/logger.js';
import { createRequestLog } from '../logging/requestLogger.js';
import { resolveModel } from '../domain/modelRouter.js';
import { transformRequest } from '../domain/requestTransformer.js';
import {
  buildClientErrorEnvelope,
  normalizeStreamFailure,
  normalizeUpstreamError,
  UpstreamError,
} from '../common/upstreamErrors.js';
import { buildUpstreamErrorLogFields } from '../logging/upstreamErrorLogMeta.js';

/**
 * Base class for all protocol controllers.
 * Provides shared logic for request lifecycle management, logging, and error handling.
 */
export class BaseController {
  /**
   * Creates a new BaseController instance.
   *
   * @param {Object} orchestrator - The orchestrator instance for request execution.
   * @param {string} protocolName - The name of the protocol (e.g., 'openai', 'anthropic').
   */
  constructor(orchestrator, protocolName) {
    this.orchestrator = orchestrator;
    this.logger = getAppLogger(protocolName);
  }

  /**
   * Standardized error response handler.
   *
   * @param {Object} res - Express response object.
   * @param {Object} reqLog - Request logger instance.
   * @param {Object} error - Error object with code, message, and optional httpStatus.
   * @param {number} [statusCode=null] - Optional override HTTP status code.
   * @returns {Object} Express response with error JSON body.
   */
  async handleError(res, reqLog, error, statusCode = null) {
    const finalStatus = statusCode || error.httpStatus || 500;
    const logMeta = error.category
      ? buildUpstreamErrorLogFields(
        { ...error, httpStatus: finalStatus },
        { errorSource: error.errorSource || 'upstream' },
      )
      : {
        error_code: error.code,
        client_http_status: finalStatus,
        error_source: error.errorSource || 'gateway',
      };
    this.logger.debug('Handling controller error', logMeta);

    if (error.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }

    const errorBody = buildClientErrorEnvelope(
      {
        code: error.code || 'internalServerError',
        type: error.type,
        message: error.message || String(error),
        provider: error.provider,
        retryAfterSeconds: error.retryAfterSeconds,
      },
      finalStatus,
    );

    if (reqLog) {
      reqLog.logClientResponse(finalStatus, errorBody);
      await reqLog.finalize();
    }

    return res.status(finalStatus).json(errorBody);
  }

  /**
   * Emits a v1 error envelope over an active SSE stream before closing.
   *
   * @param {Object} res - Express response object.
   * @param {Object} reqLog - Request logger instance.
   * @param {any} err - Caught stream error.
   * @param {Function} formatSseError - Provider-specific SSE formatter.
   * @param {string} provider - Provider name fallback.
   * @param {number} chunkCount - Chunks already sent to the client.
   */
  emitStreamError(res, reqLog, err, formatSseError, provider, chunkCount) {
    const envelope = BaseController.normalizeStreamFailureForClient(err, provider);
    const normalized = normalizeUpstreamError(err, err?.provider || provider);
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
   * @param {any} err - Caught stream error.
   * @param {string} provider - Provider name fallback.
   * @returns {{ error: Object }}
   */
  static normalizeStreamFailureForClient(err, provider) {
    return normalizeStreamFailure(err, err?.provider || provider);
  }

  /**
   * Core request execution logic shared across controllers.
   *
   * @param {Object} req - Express request object.
   * @param {Object} res - Express response object.
   * @param {Object} options - Execution options.
   * @param {Function} [options.translateReq] - Optional function to translate request format.
   * @param {Function} [options.translateRes] - Optional function to translate response format.
   * @param {Function} options.handleStream - Function to handle streaming responses.
   * @param {string} options.protocolName - Name of the protocol for logging.
   * @returns {Promise<Object>} Express response or stream.
   */
  async executeRequest(req, res, options) {
    const {
      translateReq,
      translateRes,
      handleStream,
      protocolName,
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

      // Normalize request
      const baseReq = translateReq ? translateReq(body) : body;

      // Resolve and transform
      const resolved = resolveModel(body.model, providersConfig);
      const unifiedReq = transformRequest(baseReq, resolved);

      this.logger.debug(`${protocolName} completion request received`, {
        model: body.model,
        stream: body.stream || false,
        resolvedProvider: unifiedReq.provider,
        resolvedModel: unifiedReq.actualModelId,
      });

      const response = await this.orchestrator.executeCompletion(unifiedReq, req, reqLog);

      // Handle orchestrator-level errors
      if (response?.error) {
        this.logger.debug(`${protocolName} completion failed`, { error: response.error });
        return this.handleError(res, reqLog, response.error);
      }

      // Handle streaming
      if (response && typeof response[Symbol.asyncIterator] === 'function') {
        return handleStream(res, response, unifiedReq, reqLog, body);
      }

      // Handle synchronous response
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
        const normalized = normalizeUpstreamError(err, protocolName.toLowerCase());
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
