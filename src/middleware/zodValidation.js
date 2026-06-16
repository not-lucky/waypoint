import { z } from 'zod';
import { getAppLogger } from '../logging/logger.js';

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
const toolFunctionSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function').optional(),
  function: toolFunctionSchema,
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }).passthrough(),
}).passthrough();

const textContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough();

const imageContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
  }).passthrough(),
}).passthrough();

const contentPartSchema = z.union([textContentPartSchema, imageContentPartSchema]);

const stringOrContentParts = z.union([
  z.string(),
  z.array(contentPartSchema).min(1),
]);

const instructionMessageSchema = z.object({
  role: z.enum(['system', 'developer'], {
    message: "Role must be 'system' or 'developer'",
  }),
  content: stringOrContentParts,
}).passthrough();

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: stringOrContentParts,
}).passthrough();

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([z.string(), z.null(), z.array(contentPartSchema)]).optional(),
  tool_calls: z.array(toolCallSchema).optional(),
}).passthrough();

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  tool_call_id: z.string(),
  content: z.string({
    required_error: 'Content is required',
    invalid_type_error: 'Content must be a string',
  }),
}).passthrough();

const messageSchema = z.union([
  instructionMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);

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
 *
 * @type {z.ZodObject}
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
  max_completion_tokens: z.number({
    invalid_type_error: 'max_completion_tokens must be a number',
  }).int({ message: 'max_completion_tokens must be an integer' })
    .positive({ message: 'max_completion_tokens must be positive' })
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
  tools: z.array(toolDefinitionSchema, {
    invalid_type_error: 'tools must be an array',
  }).optional(),
  tool_choice: z.union([
    z.literal('auto'),
    z.literal('none'),
    z.literal('required'),
    z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string() }),
    }),
  ], {
    invalid_type_error: 'tool_choice must be auto, none, required, or a function object',
  }).optional(),
}).passthrough();

const anthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()).optional(),
}).passthrough();

const anthropicContentBlockSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    source: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]),
  }),
  z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
  }).passthrough(),
]);

const anthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([
    z.string(),
    z.array(anthropicContentBlockSchema).min(1),
  ]),
}).passthrough();

/**
 * Zod schema for validating Anthropic Messages API request bodies.
 *
 * @type {z.ZodObject}
 */
export const anthropicMessagesSchema = z.object({
  model: z.string({
    required_error: 'model is required and must be a string',
    invalid_type_error: 'model must be a string',
  }),
  max_tokens: z.number({
    invalid_type_error: 'max_tokens must be a number',
  }).int({ message: 'max_tokens must be an integer' })
    .positive({ message: 'max_tokens must be positive' })
    .optional(),
  messages: z.array(anthropicMessageSchema, {
    required_error: 'messages is required',
    invalid_type_error: 'messages must be an array',
  }).min(1, { message: 'messages array must contain at least 1 message' }),
  system: z.union([
    z.string(),
    z.array(z.object({
      type: z.literal('text'),
      text: z.string(),
    }).passthrough()),
  ]).optional(),
  tools: z.array(anthropicToolSchema, {
    invalid_type_error: 'tools must be an array',
  }).optional(),
  tool_choice: z.union([
    z.object({ type: z.literal('auto') }),
    z.object({ type: z.literal('any') }),
    z.object({ type: z.literal('tool'), name: z.string() }),
  ]).optional(),
  temperature: z.number({
    invalid_type_error: 'temperature must be a number',
  }).min(0, { message: 'temperature must be between 0 and 1' })
    .max(1, { message: 'temperature must be between 0 and 1' })
    .optional(),
  stream: z.boolean({
    invalid_type_error: 'stream must be a boolean',
  }).optional(),
}).passthrough();

/**
 * Responds with a validation error when Zod schema validation fails.
 *
 * @param {Object} res - Express response object.
 * @param {Object} result - Zod safeParse result containing error information.
 * @returns {Object} Express response with 400 status and error details.
 */
const respondValidationError = (res, result) => {
  const issues = result.error.issues || [];
  const details = issues.map((err) => ({
    field: err.path.join('.'),
    message: err.message,
  }));

  logger.debug('Validation failed', { details });

  return res.status(400).json({
    error: {
      code: 'validationError',
      message: 'Payload validation failed',
      httpStatus: 400,
      details,
    },
  });
};

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

  const result = completionSchema.safeParse(req.body);
  if (!result.success) {
    return respondValidationError(res, result);
  }

  logger.debug('Validation passed successfully');
  return next();
};

/**
 * Express middleware to validate Anthropic Messages API request bodies.
 */
export const validateAnthropicMessagesBody = (req, res, next) => {
  logger.debug('Validating Anthropic messages request body');

  const result = anthropicMessagesSchema.safeParse(req.body);
  if (!result.success) {
    return respondValidationError(res, result);
  }

  logger.debug('Anthropic validation passed successfully');
  return next();
};
