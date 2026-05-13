import { z } from 'zod';
import { getAppLogger } from '../utils/logger.js';

const logger = getAppLogger('validation');

/**
 * Zod schema representing a single message within the conversation history.
 *
 * WHAT: Defines the required structure for a chat message, including role and string content.
 * WHY: We enforce structured typing at the ingress layer to catch malformed client requests
 * immediately. This isolates failures to the client boundary, preventing unexpected token
 * consumption, obscure adapter-level parsing crashes, or unpredictable provider-side behavior
 * downstream.
 */
const messageSchema = z.object({
  /**
   * WHAT: Validates the 'role' property against an explicit set of allowed senders.
   * WHY: Providers like OpenAI and Anthropic have strict requirements for message roles.
   * If an unknown role bypasses ingress, adapters might drop the message or the provider API
   * might return a cryptic HTTP 400. Failing fast here keeps adapter logic clean and predictable.
   */
  role: z.enum(['system', 'user', 'assistant'], {
    message: "Role must be 'system', 'user', or 'assistant'",
  }),
  /**
   * WHAT: Enforces that message payload is a string.
   * WHY: We strictly enforce string content to prevent nested object injection that could
   * crash downstream text-only tokenizers or serialization logic. While some providers support
   * multimodal objects, this tier requires a unified string abstraction for safety.
   */
  content: z.string({
    required_error: 'Content is required',
    invalid_type_error: 'Content must be a string',
  }),
});

/**
 * Zod schema defining the core required and optional fields for a chat completion request.
 *
 * WHAT: Validates incoming completion payloads (e.g., model, messages, temperature) while
 * explicitly allowing unknown properties.
 * WHY: This defines the architectural boundary between the client and the orchestrator.
 * We validate only the critical routing and request construction fields. By allowing unknown
 * parameters to pass through, clients can send provider-specific features (like `logit_bias`
 * or `top_p`) without Waypoint needing to hardcode every proprietary parameter. This
 * "open-closed" approach guarantees long-term gateway extensibility.
 */
export const completionSchema = z.object({
  /**
   * WHAT: Requires the 'model' identifier string.
   * WHY: The orchestrator fundamentally relies on this model identifier to route the request
   * to the correct provider adapter and to calculate rate limits or billing. Missing this
   * would trigger a fatal routing failure deep in the application.
   */
  model: z.string({
    required_error: 'model is required and must be a string',
    invalid_type_error: 'model must be a string',
  }),
  /**
   * WHAT: Requires a non-empty array of valid `messageSchema` objects.
   * WHY: An empty array provides zero context to the LLM and results in provider-side rejections.
   * Validating this deeply prevents "garbage in, garbage out" scenarios, ensuring we do not
   * consume API rate-limit quotas on payloads that are structurally doomed to fail.
   */
  messages: z.array(messageSchema, {
    required_error: 'messages is required',
    invalid_type_error: 'messages must be an array',
  }).min(1, { message: 'messages array must contain at least 1 message' }),
  /**
   * WHAT: Bounds the optional 'temperature' parameter to a [0.0, 2.0] float range.
   * WHY: The 0-2 range is an industry standard across major providers (OpenAI, Anthropic).
   * Restricting outliers prevents completely unpredictable generation (values > 2) or negative
   * bounds before they reach the provider, normalizing behavior across models.
   */
  temperature: z.number({
    invalid_type_error: 'temperature must be a number',
  }).min(0, { message: 'temperature must be between 0 and 2' })
    .max(2, { message: 'temperature must be between 0 and 2' })
    .optional(),
  /**
   * WHAT: Enforces 'max_tokens' as an optional positive integer.
   * WHY: Float values or negative limits will cause downstream JSON serialization errors or
   * API rejections. Enforcing strict integers enables the orchestrator to reliably project
   * worst-case billing and token usage limits without needing constant type casting.
   */
  max_tokens: z.number({
    invalid_type_error: 'max_tokens must be a number',
  }).int({ message: 'max_tokens must be an integer' })
    .positive({ message: 'max_tokens must be positive' })
    .optional(),
  /**
   * WHAT: Boolean flag to request Server-Sent Events (SSE) streaming.
   * WHY: This boolean dictates the connection lifecycle and the adapter's response strategy
   * (streaming chunks vs monolithic JSON). Validating it strictly as a boolean avoids edge
   * cases where truthy values (e.g., "true", 1) cause unpredictable routing branches.
   */
  stream: z.boolean({
    invalid_type_error: 'stream must be a boolean',
  }).optional(),
});

/**
 * Express middleware to validate request body payloads against `completionSchema`.
 *
 * WHAT: Intercepts completion requests, validates the JSON body, and either passes control
 * or returns a 400 Bad Request.
 * WHY: Express routing should purely focus on business logic. Extracting validation into
 * middleware ensures the orchestrator and adapters never handle unvetted data, completely
 * removing defensive programming overhead downstream.
 */
export const validateCompletionBody = (req, res, next) => {
  logger.debug('Validating completion request body');

  // WHAT: Parse the body securely using Zod's `safeParse`.
  // WHY: Synchronous `try/catch` around `parse()` introduces overhead and the risk of
  // unhandled exceptions leaking internal stack traces. `safeParse` provides a functional
  // Either-like result object that guarantees predictable control flow when processing
  // invalid data.
  const result = completionSchema.safeParse(req.body);

  if (!result.success) {
    // WHAT: Transform deeply nested Zod issues into flat, dot-notated field error paths.
    // WHY: Zod's native error format is verbose and leaks schema implementation details.
    // Mapping `err.path` (e.g., ['messages', 0, 'role']) to a standard string (`messages.0.role`)
    // provides frontend clients with an intuitive, programmatic way to highlight form errors.
    const issues = result.error.issues || [];
    const details = issues.map((err) => ({
      field: err.path.join('.'),
      message: err.message,
    }));

    logger.debug('Validation failed', { details });

    // WHAT: Return a 400 response containing a unified NormalizedError payload.
    // WHY: Halting execution here saves internal compute resources and prevents wasting
    // provider rate limits on malformed queries. Standardizing the error schema across all
    // endpoints drastically reduces client integration friction and debugging time.
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Payload validation failed',
        details,
      },
    });
  }

  // WHAT: Pass control to the next middleware or route handler.
  // WHY: Completes the middleware lifecycle. Calling `next()` only on success provides
  // an ironclad guarantee to subsequent layers that `req.body` exactly matches the schema.
  logger.debug('Validation passed successfully');
  return next();
};
