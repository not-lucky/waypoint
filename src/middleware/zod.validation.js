import { z } from 'zod';

/**
 * Zod schema representing a single message within the conversation history.
 * Each message must possess a valid role and a text content string.
 */
const messageSchema = z.object({
  // Role must be one of the enum values: system, user, or assistant
  role: z.enum(['system', 'user', 'assistant'], {
    errorMap: () => ({ message: "Role must be 'system', 'user', or 'assistant'" }),
  }),
  // Content is the string payload of the message (required)
  content: z.string({
    required_error: 'Content is required',
    invalid_type_error: 'Content must be a string',
  }),
});

/**
 * Zod schema defining the core required and optional fields for a chat completion request.
 * Designed to validate incoming payloads for both OpenAI and Anthropic endpoint formats
 * without strict schema validation (unknown parameters are bypassed/passed through).
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
 * On validation failure, returns a HTTP 400 Bad Request with a NormalizedError payload
 * detailing field-level discrepancies.
 */
export const validateCompletionBody = (req, res, next) => {
  // Parse payload using safeParse to avoid throwing errors synchronously
  const result = completionSchema.safeParse(req.body);

  if (!result.success) {
    // Extract parsing issues from the ZodError instance
    const issues = result.error.issues || [];

    // Map issues into a NormalizedError response format with field-level details
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Payload validation failed',
        details: issues.map((err) => ({
          // Formats path to target field as dot-separated string (e.g. "messages.0.role")
          field: err.path.join('.'),
          message: err.message,
        })),
      },
    });
  }

  // Validation succeeded, proceed down the router chain
  return next();
};
