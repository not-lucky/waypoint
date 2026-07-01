/**
 * Merges progressive, incremental OpenAI streaming tool_call deltas by choice index.
 *
 * This function appends new tool call fields (id, type) and concatenates name and JSON
 * arguments substrings for functions as they arrive over the stream.
 *
 * @param {Array<Object>|null|undefined} existing - The current accumulated tool calls.
 * @param {Array<Object>|null|undefined} incoming - The new tool call deltas to merge.
 * @returns {Array<Object>} The updated array of aggregated tool calls.
 */
export function mergeToolCallDeltas(existing, incoming) {
  if (!incoming?.length) return existing;

  const merged = [...(existing || [])];
  for (const call of incoming) {
    const index = call.index ?? 0;
    if (!merged[index]) {
      merged[index] = {
        index,
        id: call.id,
        type: call.type || 'function',
        function: { name: '', arguments: '' },
      };
    }

    const target = merged[index];
    if (call.id) target.id = call.id;
    if (call.type) target.type = call.type;
    if (call.function?.name) target.function.name += call.function.name;
    if (call.function?.arguments) target.function.arguments += call.function.arguments;
  }

  return merged;
}
