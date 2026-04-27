import { z } from 'zod';
import { getAppLogger } from '../utils/logger.js';

const logger = getAppLogger('validation');

/**
 * Zod schema representing a single message within the conversation history.
 * Each message must possess a valid role and a text content string.
 *
 * We enforce structured typing at the ingress layer to catch malformed client
 * requests early, preventing unpredictable upstream provider behavior or obscure parsing errors.
 */
const messageSchema = z.object({
  // Role must be one of the enum values: system, user, or assistant.
  role: z.enum(['system', 'user', 'assistant'], {
    errorMap: () => ({ message: "Role must be 'system', 'user', or 'assistant'" }),
  }),
  // Content is the string payload of the message (required).
  content: z.string({
    required_error: 'Content is required',
    invalid_type_error: 'Content must be a string',
  }),
});

/**
 * Zod schema defining the core required and optional fields for a chat completion request.
 * Designed to validate incoming payloads for both OpenAI and Anthropic endpoint formats
 * without strict schema validation (unknown parameters are bypassed/passed through).
 *
 * We allow unknown parameters to pass through so clients can send provider-specific
 * features (like `logit_bias` or `top_p`) without Waypoint needing to hardcode
 * every possible proprietary parameter.
 */
export const completionSchema = z.object({
  // Model name/identifier (string, required)
  model: z.string({
    required_error: 'model is required and must be a string',
    invalid_type_error: 'model must be a string',
  }),
  // Messages conversation list (array of messageSchema, min length 1, required)
  messages: z.array(messageSchema, {
    required_error: 'messages is required',
    invalid_type_error: 'messages must be an array',
  }).min(1, { message: 'messages array must contain at least 1 message' }),
  // Generation temperature (number, 0-2, optional)
  temperature: z.number({
    invalid_type_error: 'temperature must be a number',
  }).min(0, { message: 'temperature must be between 0 and 2' })
    .max(2, { message: 'temperature must be between 0 and 2' })
    .optional(),
  // Max tokens to generate (positive integer, optional)
  max_tokens: z.number({
    invalid_type_error: 'max_tokens must be a number',
  }).int({ message: 'max_tokens must be an integer' })
    .positive({ message: 'max_tokens must be positive' })
    .optional(),
  // Stream completion chunk indicator (boolean, optional)
  stream: z.boolean({
    invalid_type_error: 'stream must be a boolean',
  }).optional(),
});

/**
 * Express middleware to validate request body payloads for chat completions/messages endpoints.
 * Compares incoming `req.body` against the `completionSchema`.
 *
 * By hooking into Express's middleware chain, we ensure that the business logic controllers
 * only ever receive structurally sound payloads.
 *
 * On validation failure, returns a HTTP 400 Bad Request with a NormalizedError payload
 * detailing field-level discrepancies.
 */
export const validateCompletionBody = (req, res, next) => {
  logger.debug('Validating completion request body');
  // Parse payload using safeParse to avoid throwing errors synchronously.
  // safeParse provides predictable error handling over traditional try/catch.
  const result = completionSchema.safeParse(req.body);

  if (!result.success) {
    // Extract parsing issues from the ZodError instance.
    const issues = result.error.issues || [];
    const details = issues.map((err) => ({
      // Formats path to target field as dot-separated string (e.g. "messages.0.role").
      field: err.path.join('.'),
      message: err.message,
    }));

    logger.debug('Validation failed', { details });

    // Map issues into a NormalizedError response format with field-level details
    // so clients can programmatically identify what fields they submitted incorrectly.
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Payload validation failed',
        details,
      },
    });
  }

  // Validation succeeded, proceed down the router chain.
  logger.debug('Validation passed successfully');
  return next();
};
