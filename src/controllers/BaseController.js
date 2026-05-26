import { getAppLogger } from '../utils/logger.js';
import { createRequestLog } from '../utils/requestLogger.js';
import { resolveModel } from '../utils/ModelRouter.js';
import { transformRequest } from '../utils/RequestTransformer.js';

/**
 * Base class for all protocol controllers.
 * Provides shared logic for request lifecycle management, logging, and error handling.
 */
export class BaseController {
  constructor(orchestrator, protocolName) {
    this.orchestrator = orchestrator;
    this.logger = getAppLogger(protocolName);
  }

  /**
   * Standardized error response handler.
   */
  async handleError(res, reqLog, error, statusCode = null) {
    const finalStatus = statusCode || error.httpStatus || 500;
    this.logger.debug('Handling controller error', { code: error.code, status: finalStatus });

    const errorBody = {
      error: {
        code: error.code || 'internalServerError',
        message: error.message || String(error),
        httpStatus: finalStatus,
        provider: error.provider,
      },
    };

    if (reqLog) {
      reqLog.logClientResponse(finalStatus, errorBody);
      await reqLog.finalize();
    }

    return res.status(finalStatus).json(errorBody);
  }

  /**
   * Core request execution logic shared across controllers.
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
      return this.handleError(res, reqLog, err);
    }
  }
}
