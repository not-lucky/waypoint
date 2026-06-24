import { z } from 'zod';
import { getAppLogger } from '../logging/logger.js';
import { buildClientErrorEnvelope } from '../errors/envelope.js';
import { resolveIngressFormat } from './ingressFormat.js';
import { statusToErrorType } from '../errors/httpErrorTypes.js';

const logger = getAppLogger('validation');

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
 * @param {Object} req - Express request object.
 * @param {Object} result - Zod safeParse result containing error information.
 * @returns {Object} Express response with 400 status and error details.
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

  return res.status(400).json(buildClientErrorEnvelope({
    code: 'validationError',
    message,
    errorType: statusToErrorType(400),
    details,
  }, resolveIngressFormat(req)));
};

/**
 * Express middleware to validate request body payloads against `completionSchema`.
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
 * Express middleware to validate Anthropic Messages API request bodies.
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
