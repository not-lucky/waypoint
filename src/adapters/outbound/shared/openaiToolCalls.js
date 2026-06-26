/**
 * Merges incremental OpenAI streaming tool_call deltas by index.
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
