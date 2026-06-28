/**
 * Parses a ReadableStream or Node.js async iterable yielding binary chunks
 * into Server-Sent Events (SSE) containing { event, data } structures.
 *
 * @param {ReadableStream|AsyncIterable} responseBody - The raw network stream body from fetch.
 * @param {AbortSignal} [signal] - Enables deterministic cancellation to prevent memory leaks.
 * @returns {AsyncGenerator<{event: string|null, data: string}>}
 */
export async function* parseSSEStream(responseBody, signal) {
  if (!responseBody) return;

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const processChunk = function* processChunk(chunk) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      if (!part.trim()) continue;

      const lines = part.split('\n');
      let event = null;
      let data = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          event = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          const dataVal = line.substring(5).trim();
          data = data ? `${data}\n${dataVal}` : dataVal;
        }
      }

      if (data) {
        yield { event, data };
      }
    }
  };

  if (typeof responseBody[Symbol.asyncIterator] === 'function') {
    for await (const chunk of responseBody) {
      if (signal?.aborted) {
        throw new Error('Stream aborted');
      }
      yield* processChunk(chunk);
    }
  } else if (typeof responseBody.getReader === 'function') {
    const reader = responseBody.getReader();
    try {
      while (true) {
        if (signal?.aborted) {
          throw new Error('Stream aborted');
        }
        const { done, value } = await reader.read();
        if (done) break;
        yield* processChunk(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  if (buffer.trim()) {
    const lines = buffer.split('\n');
    let event = null;
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        const dataVal = line.substring(5).trim();
        data = data ? `${data}\n${dataVal}` : dataVal;
      }
    }
    if (data) {
      yield { event, data };
    }
  }
}

export function parseSSEEventData(data) {
  if (data === '[DONE]') {
    return null;
  }
  try {
    return JSON.parse(data);
  } catch (_err) {
    return null;
  }
}
