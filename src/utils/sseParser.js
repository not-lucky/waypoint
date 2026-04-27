/* eslint-disable no-restricted-syntax, no-await-in-loop, no-continue */

/**
 * Parses a ReadableStream or Node.js async iterable yielding binary chunks
 * into Server-Sent Events (SSE) containing { event, data } structures.
 *
 * Handles split chunks and multibyte character buffers which naturally occur when fetching
 * over the network. Network chunks do not align with SSE event boundaries, so this state
 * machine reassembles them.
 *
 * @param {ReadableStream|AsyncIterable} responseBody - The stream body from fetch.
 * @param {AbortSignal} [signal] - Optional abort signal.
 * @returns {AsyncGenerator<{event: string|null, data: string}>}
 */
export async function* parseSSEStream(responseBody, signal) {
  if (!responseBody) return;

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const processChunk = function* processChunk(chunk) {
    // Decoding stream:true prevents multibyte Unicode characters (e.g. emoji)
    // from being incorrectly parsed if split across the chunk byte boundary.
    buffer += decoder.decode(chunk, { stream: true });

    // SSE messages are delimited by double newlines.
    const parts = buffer.split('\n\n');

    // The final split piece is usually incomplete. Keep it in the buffer for the next chunk.
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

      // Only yield standard SSE payloads which have a data block
      if (data) {
        yield { event, data };
      }
    }
  };

  // Node Fetch API vs Native Web Fetch API handling
  // Node.js often returns iterables for bodies, Web Fetch provides getReader()
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
      // Must explicitly release locks so the garbage collector can clean up
      // the underlying socket data buffers.
      reader.releaseLock();
    }
  }

  // Handle EOF remaining buffer if the stream terminates exactly at an event boundary without trailing newlines
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

export default parseSSEStream;
