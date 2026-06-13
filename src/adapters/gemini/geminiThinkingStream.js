/* eslint-disable no-restricted-syntax */
import { parseSSEStream, parseSSEEventData } from '../../streaming/sseParser.js';
import { throwIfStreamErrorPayload } from '../../common/upstreamErrors.js';
import { getThinkingLevel } from './geminiFormatter.js';
import { mapUsage } from '../shared/openaiResponse.js';
import { ThinkingBuffer } from '../../streaming/thinkingBuffer.js';

/**
 * Executes a streaming completion for Gemini models with thinking/reasoning enabled.
 * Uses the OpenAI-compatible endpoint with thinking configuration.
 */
export async function* executeThinkingStream(req, apiKey, signal, requestLog, adapter) {
  const url = adapter.baseUrl
    ? `${adapter.baseUrl.replace(/\/$/, '')}/chat/completions`
    : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const payload = {
    model: req.actualModelId || req.model,
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: true },
    extra_body: {
      google: {
        thinking_config: {
          thinking_level: getThinkingLevel(req),
          include_thoughts: true,
        },
      },
    },
  };
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;

  const { response, fetchSignal, cleanup } = await adapter.performFetch(
    url,
    headers,
    payload,
    signal,
    requestLog,
    adapter.timeoutMs,
  );

  const chunkId = `waypoint-chunk-${Date.now()}`;
  const stream = parseSSEStream(response.body, fetchSignal);
  const thinkingBuffer = new ThinkingBuffer();

  let eventCount = 0;
  let lastFinishReason = null;
  let responseId = null;
  let responseModel = null;
  let accumulatedContent = '';
  let accumulatedReasoningContent = '';
  let finalUsage = null;

  try {
    for await (const sseEvent of stream) {
      if (fetchSignal?.aborted) throw new Error('Stream aborted');

      const parsedData = parseSSEEventData(sseEvent.data);
      if (!parsedData) continue;

      if (requestLog && typeof requestLog.appendStreamEvent === 'function') {
        requestLog.appendStreamEvent('provider', parsedData);
      }
      eventCount += 1;

      throwIfStreamErrorPayload(parsedData, 'gemini');

      if (parsedData.id) responseId = parsedData.id;
      if (parsedData.model) responseModel = parsedData.model;
      if (parsedData.usage) finalUsage = parsedData.usage;

      const choices = parsedData.choices || [];
      if (choices.length === 0) {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [],
          usage: mapUsage(parsedData.usage),
        };
        continue;
      }

      const c = choices[0];
      if (c.delta?.content) accumulatedContent += c.delta.content;
      if (c.delta?.reasoning_content) accumulatedReasoningContent += c.delta.reasoning_content;
      if (c.finish_reason) lastFinishReason = c.finish_reason;

      const deltasToYield = [];
      if (c.delta?.reasoning_content) {
        deltasToYield.push({ reasoning_content: c.delta.reasoning_content, content: null });
      }

      if (c.delta?.content) {
        const resultDeltas = thinkingBuffer.process(c.delta.content, false);
        for (const d of resultDeltas) {
          deltasToYield.push({
            reasoning_content: d.type === 'thinking' ? d.content : null,
            content: d.type === 'text' ? d.content : null,
          });
        }
      }

      for (const delta of deltasToYield) {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [{
            index: c.index ?? 0,
            delta,
            finish_reason: c.finish_reason ?? null,
          }],
          usage: mapUsage(parsedData.usage),
        };
      }

      if (deltasToYield.length === 0) {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [{
            index: c.index ?? 0,
            delta: { content: null, reasoning_content: null },
            finish_reason: c.finish_reason ?? null,
          }],
          usage: mapUsage(parsedData.usage),
        };
      }
    }

    const finalDeltas = thinkingBuffer.process('', true);
    for (const d of finalDeltas) {
      yield {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            reasoning_content: d.type === 'thinking' ? d.content : null,
            content: d.type === 'text' ? d.content : null,
          },
          finish_reason: null,
        }],
      };
    }
  } finally {
    cleanup();
    if (requestLog && typeof requestLog.logProviderStreamSummary === 'function') {
      const summary = {
        id: responseId || chunkId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: responseModel || req.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: accumulatedContent,
            reasoning_content: accumulatedReasoningContent || null,
          },
          finish_reason: lastFinishReason || 'stop',
        }],
      };
      if (finalUsage) {
        summary.usage = mapUsage(finalUsage);
      }
      requestLog.logProviderStreamSummary({
        _format: 'sse-json',
        _eventCount: eventCount,
        summary,
      });
    }
  }
}
