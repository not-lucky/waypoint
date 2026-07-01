/**
 * @fileoverview Zod-based request validation for the OpenAI and Anthropic
 * ingress payloads.
 *
 * Defines the request-body schemas, the Express middleware that consumes
 * them, and the helper that maps a Zod failure back to the standard
 * client-facing error envelope.
 */

import { z } from 'zod';
import { getAppLogger } from '../../logging/logger.js';
import { sendHttpError } from './errorHelper.js';

/**
 * Module-level logger for the validation middleware.
 * @type {Object}
 */
const logger = getAppLogger('validation');

/**
 * Zod schema for a single OpenAI-style function tool call.
 *
 * `arguments` is intentionally typed as `string` (rather than `object`)
 * because OpenAI's protocol streams arguments as an incrementally
 * concatenated JSON string that is only parseable when complete.
 */
const toolFunctionSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

/**
 * Zod schema for the `tool_calls` array element shape.
 */
const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function').optional(),
  function: toolFunctionSchema,
});

/**
 * Zod schema for a single tool definition in the `tools` array.
 *
 * Uses `.passthrough()` so future OpenAI additions (e.g. `strict`,
 * `description` extensions) don't require a code change.
 */
const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }).passthrough(),
}).passthrough();

/**
 * Schema for a `text` content part used inside multi-part message content.
 */
const textContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough();

/**
 * Schema for an `image_url` content part. Only the URL itself is required;
 * any detail/format hints pass through.
 */
const imageContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
  }).passthrough(),
}).passthrough();

/**
 * Discriminated union for any content part currently supported by the gateway.
 */
const contentPartSchema = z.union([textContentPartSchema, imageContentPartSchema]);

/**
 * Either a plain string or an array of `contentPartSchema` (at least one
 * part). Empty arrays are rejected because they would be ambiguous to
 * downstream translators.
 */
const stringOrContentParts = z.union([
  z.string(),
  z.array(contentPartSchema).min(1),
]);

/**
 * Schema for system/developer (instructional) messages.
 */
const instructionMessageSchema = z.object({
  role: z.enum(['system', 'developer'], {
    message: "Role must be 'system' or 'developer'",
  }),
  content: stringOrContentParts,
}).passthrough();

/**
 * Schema for user-authored messages.
 */
const userMessageSchema = z.object({
  role: z.literal('user'),
  content: stringOrContentParts,
}).passthrough();

/**
 * Schema for assistant messages, including optional tool calls.
 *
 * `content` may be a string, null (when the message contains tool calls
 * only), or an array of content parts.
 */
const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([z.string(), z.null(), z.array(contentPartSchema)]).optional(),
  tool_calls: z.array(toolCallSchema).optional(),
}).passthrough();

/**
 * Schema for `role: 'tool'` messages that respond to a prior tool call.
 */
const toolMessageSchema = z.object({
  role: z.literal('tool'),
  tool_call_id: z.string(),
  content: z.string({
    required_error: 'Content is required',
    invalid_type_error: 'Content must be a string',
  }),
}).passthrough();

/**
 * Discriminated union of every supported message shape.
 */
const messageSchema = z.union([
  instructionMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);

/**
 * Zod schema for OpenAI-compatible `/chat/completions` request bodies.
 *
 * Uses `.passthrough()` at the top level so unrecognized client keys
 * (e.g. provider-specific routing hints from OpenRouter) flow through to
 * the routing layer, which decides via `allowedExtraBody` whether they are
 * forwarded to the upstream provider.
 *
 * @type {z.ZodObject}
 */
export const completionSchema = z.object({
  model: z.string({
    required_error: 'model is required and must be a string',
    invalid_type_error: 'model must be a string',
  }),
  messages: z.array(messageSchema, {
    required_error: 'messages is required',
    invalid_type_error: 'messages must be an array',
  }).min(1, { message: 'messages array must contain at least 1 message' }),
  temperature: z.number({
    invalid_type_error: 'temperature must be a number',
  }).min(0, { message: 'temperature must be between 0 and 2' })
    .max(2, { message: 'temperature must be between 0 and 2' })
    .optional(),
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
  extraBody: z.record(z.unknown()).optional(),
}).passthrough();

/**
 * Zod schema for a single Anthropic tool definition.
 */
const anthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()).optional(),
}).passthrough();

/**
 * Zod schema for a single content block in an Anthropic message.
 *
 * Covers the documented block types: text, image, tool_use, tool_result,
 * and thinking. `image` source is `.passthrough()`'d so we don't bind
 * too tightly to Anthropic's image-source sub-shape.
 */
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

/**
 * Zod schema for a single Anthropic Messages API message.
 */
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
 * Mirrors `completionSchema` for cross-protocol parity. The schema is
 * deliberately permissive (`.passthrough()`) for the top-level body so that
 * unknown keys are still handed to the routing transformer for filtering.
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
  // Explicitly validate extraBody as a plain object mapping string keys to unknown values.
  // This provides validation parity with completionSchema and prevents invalid shapes
  // (like a string or array) from bypassing validation via the .passthrough() directive.
  extraBody: z.record(z.unknown()).optional(),
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
 * Translates a Zod failure into the standardized HTTP error envelope and
 * sends it on the supplied response.
 *
 * The Zod `issues` array is flattened into a `details` array of
 * `{ field, message }` pairs so clients can render per-field errors
 * without re-parsing the structured Zod output.
 *
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').Request} req - Express request object.
 * @param {{ success: false, error: z.ZodError }} result - Failed safeParse result.
 * @returns {import('express').Response} The 400 response.
 */
const respondValidationError = (res, req, result) => {
  const issues = result.error.issues;
  const details = issues.map((err) => ({
    field: err.path.join('.'),
    message: err.message,
  }));
  const message = details.length
    ? `Payload validation failed: ${details.map((d) => `${d.field}: ${d.message}`).join(', ')}`
    : 'Payload validation failed';

  logger.debug('Validation failed', { details });

  return sendHttpError(res, req, 400, 'validationError', message, null, details);
};

/**
 * Express middleware that validates a request body against `completionSchema`.
 *
 * On success, calls `next()` and leaves `req.body` untouched. On failure,
 * sends a 400 with the validation error envelope and DOES NOT call `next()`.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void | import('express').Response}
 */
export const validateCompletionBody = (req, res, next) => {
  logger.debug('Validating completion request body');

  const result = completionSchema.safeParse(req.body);
  if (!result.success) {
    return respondValidationError(res, req, result);
  }

  logger.debug('Validation passed successfully');
  return next();
};

/**
 * Express middleware that validates a request body against
 * `anthropicMessagesSchema`. Behaves identically to `validateCompletionBody`
 * but with the Anthropic-shaped schema.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void | import('express').Response}
 */
export const validateAnthropicMessagesBody = (req, res, next) => {
  logger.debug('Validating Anthropic messages request body');

  const result = anthropicMessagesSchema.safeParse(req.body);
  if (!result.success) {
    return respondValidationError(res, req, result);
  }

  logger.debug('Anthropic validation passed successfully');
  return next();
};