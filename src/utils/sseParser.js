/* eslint-disable no-restricted-syntax, no-await-in-loop, no-continue */

/**
 * Parses a ReadableStream or Node.js async iterable yielding binary chunks
 * into Server-Sent Events (SSE) containing { event, data } structures.
 *
 * WHY THIS EXISTS:
 * Network streams arrive in arbitrary binary chunks dictated by MTU and network conditions,
 * completely oblivious to the logical boundaries of SSE payloads. Additionally, multibyte
 * Unicode characters (like emojis) can be split down the middle across two chunks.
 * This parser acts as a stateful buffer, ensuring we only emit fully formed logical events
 * and preventing corruption of text data.
 *
 * @param {ReadableStream|AsyncIterable} responseBody - The raw network stream body from fetch.
 * @param {AbortSignal} [signal] - Enables deterministic cancellation to prevent memory leaks.
 * @returns {AsyncGenerator<{event: string|null, data: string}>}
 */
export async function* parseSSEStream(responseBody, signal) {
  if (!responseBody) return;

  // TextDecoder maintains internal state across calls to `decode()` when `{ stream: true }`
  // is used. This state is critical for stitching together multibyte UTF-8 characters
  // that get severed at chunk boundaries.
  const decoder = new TextDecoder('utf-8');

  // `buffer` acts as our temporal memory. It accumulates text until a double newline (\n\n)
  // signifies a complete logical SSE event boundary.
  let buffer = '';

  // processChunk is extracted as a synchronous generator because it parses memory locally,
  // keeping the heavy async/await machinery relegated to the network I/O loops below.
  const processChunk = function* processChunk(chunk) {
    // Decoding stream:true prevents multibyte Unicode characters (e.g. emoji)
    // from being incorrectly parsed if split across the chunk byte boundary.
    buffer += decoder.decode(chunk, { stream: true });

    // SSE messages are delimited by double newlines.
    // Splitting by \n\n isolates potentially complete payloads from the raw buffer.
    const parts = buffer.split('\n\n');

    // The final element in `parts` is always pushed back to `buffer`.
    // Rationale: We cannot guarantee the last piece is a complete event unless it ended
    // with \n\n. If it did end with \n\n, parts.pop() correctly returns an empty string,
    // clearing the buffer for the next chunk.
    buffer = parts.pop() || '';

    for (const part of parts) {
      // Ignore empty events resulting from repeated empty lines (e.g., heartbeat keep-alives)
      // to avoid polluting the downstream consumer with blank payloads.
      if (!part.trim()) continue;

      const lines = part.split('\n');
      let event = null;
      let data = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          // SSE spec dictates an optional space after the colon. trim() normalizes this
          // to ensure robust event name extraction regardless of server formatting.
          event = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          const dataVal = line.substring(5).trim();
          // Multiline data blocks must be concatenated with newlines.
          // This reconstructs complex JSON objects or multi-line text sent across
          // multiple 'data:' lines.
          data = data ? `${data}\n${dataVal}` : dataVal;
        }
      }

      // Only yield standard SSE payloads which have a data block.
      // Events consisting solely of 'event:' or comments (lines starting with ':')
      // are ignored as they lack actionable payload for standard consumption.
      if (data) {
        yield { event, data };
      }
    }
  };

  // Polymorphic stream consumption:
  // Node.js environments (like Undici) expose streams as async iterables,
  // whereas browsers and Edge environments use the Web Streams API (getReader).
  // We check for both to ensure universal cross-runtime compatibility.
  if (typeof responseBody[Symbol.asyncIterator] === 'function') {
    // Node.js async iteration: natively handles backpressure and error propagation.
    for await (const chunk of responseBody) {
      // Proactive abort checking per chunk avoids processing trailing bytes
      // after a client disconnect, saving CPU cycles.
      if (signal?.aborted) {
        throw new Error('Stream aborted');
      }
      yield* processChunk(chunk);
    }
  } else if (typeof responseBody.getReader === 'function') {
    // Web Streams API: requires manual lock management and polling loops.
    const reader = responseBody.getReader();
    try {
      while (true) {
        if (signal?.aborted) {
          throw new Error('Stream aborted');
        }
        const { done, value } = await reader.read();
        // A done signal indicates the network socket is closed and stream is fully drained.
        if (done) break;
        yield* processChunk(value);
      }
    } finally {
      // Must explicitly release locks so the garbage collector can clean up
      // the underlying socket data buffers. Failure to release causes memory leaks
      // and blocks subsequent reads from the same stream.
      reader.releaseLock();
    }
  }

  // Handle EOF remaining buffer if the stream terminates exactly at an event boundary
  // without trailing newlines. This catches misbehaving servers that abruptly sever
  // the connection without cleanly delimiting the final event payload.
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
