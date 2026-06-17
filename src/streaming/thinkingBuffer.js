import { getLongestPrefixSuffix } from '../utils/stringUtils.js';

/**
 * State machine for parsing content with embedded tags (e.g., <thought>).
 * Handles partial matches across buffer chunks.
 */
export class ThinkingBuffer {
  /**
   * @param {Object} options
   * @param {string} [options.startTag='<thought>']
   * @param {string} [options.endTag='</thought>']
   * @param {'text'|'thinking'} [options.initialState='text']
   */
  constructor(options = {}) {
    this.startTag = options.startTag || '<thought>';
    this.endTag = options.endTag || '</thought>';
    this.state = options.initialState || 'text';
    this.buffer = '';
  }

  /**
   * Processes a new chunk of content.
   *
   * @param {string} chunk - The new content chunk.
   * @param {boolean} isFinal - Whether this is the final chunk (flushes remaining buffer).
   * @returns {Array<{type: 'text'|'thinking', content: string}>} Deltas extracted from the chunk.
   */
  process(chunk, isFinal = false) {
    if (this.state !== 'text' && this.state !== 'thinking') {
      return [];
    }
    this.buffer += chunk;
    const deltas = [];

    let processed = true;
    while (processed) {
      processed = false;

      const isText = this.state === 'text';
      const targetTag = isText ? this.startTag : this.endTag;
      const nextState = isText ? 'thinking' : 'text';

      const idx = this.buffer.indexOf(targetTag);
      if (idx !== -1) {
        const before = this.buffer.slice(0, idx);
        if (before) {
          deltas.push({ type: this.state, content: before });
        }
        this.state = nextState;
        this.buffer = this.buffer.slice(idx + targetTag.length);
        processed = true;
      } else if (!isFinal) {
        const partial = getLongestPrefixSuffix(this.buffer, targetTag);
        if (partial) {
          const before = this.buffer.slice(0, -partial.length);
          if (before) {
            deltas.push({ type: this.state, content: before });
          }
          this.buffer = partial;
        } else {
          if (this.buffer) {
            deltas.push({ type: this.state, content: this.buffer });
          }
          this.buffer = '';
        }
      } else {
        if (this.buffer) {
          deltas.push({ type: this.state, content: this.buffer });
        }
        this.buffer = '';
      }
    }

    return deltas;
  }
}
