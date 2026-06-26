import { getLongestPrefixSuffix } from '../stringUtils.js';

const DEFAULT_START_TAG = '<thought>';
const DEFAULT_END_TAG = '</thought>';

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
    this.startTag = options.startTag || DEFAULT_START_TAG;
    this.endTag = options.endTag || DEFAULT_END_TAG;
    this.state = options.initialState || 'text';
    this.buffer = '';
    this.bypassed = false;
  }

  /**
   * Stops tag processing and drains any buffered content as text.
   * Subsequent calls to `process()` will pass content through unchanged.
   *
   * @returns {Array<{type: 'text', content: string}>} Any buffered content as a text delta.
   */
  bypass() {
    if (this.bypassed) return [];
    this.bypassed = true;
    const deltas = [];
    if (this.buffer) {
      deltas.push({ type: 'text', content: this.buffer });
      this.buffer = '';
    }
    return deltas;
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
    if (this.bypassed) return chunk ? [{ type: 'text', content: chunk }] : [];
    this.buffer += chunk;
    const deltas = [];

    let processed = true;
    while (processed) {
      processed = false;
      if (this.bypassed) {
        if (this.buffer) {
          deltas.push({ type: 'text', content: this.buffer });
          this.buffer = '';
        }
        break;
      }

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
        if (nextState === 'text') {
          this.bypassed = true;
        }
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

/**
 * Extracts tagged reasoning blocks from a complete content string.
 *
 * @param {string|null|undefined} contentText - Full assistant content.
 * @param {string|null|undefined} reasoning - Existing reasoning content, if any.
 * @param {Object} [options] - Tag configuration.
 * @param {string} [options.startTag='<thought>'] - Opening reasoning tag.
 * @param {string} [options.endTag='</thought>'] - Closing reasoning tag.
 * @returns {{ content: string, reasoningContent: string|null }}
 */
export const extractTaggedText = (contentText, reasoning, options = {}) => {
  const contentValue = typeof contentText === 'string' ? contentText : (contentText ?? '');
  const existingReasoning = typeof reasoning === 'string' && reasoning ? reasoning : null;
  const buffer = new ThinkingBuffer(options);
  const deltas = buffer.process(contentValue, true);

  let content = '';
  let extractedReasoning = '';

  for (const delta of deltas) {
    if (delta.type === 'thinking') {
      extractedReasoning += delta.content;
    } else {
      content += delta.content;
    }
  }

  return {
    content,
    reasoningContent: existingReasoning ?? (extractedReasoning || null),
  };
};
