/**
 * Super Memory — Base Model Provider
 *
 * Implements the core completion contract and OpenAI-compatible Chat Completions
 * transport shared across providers (such as Baseten and Meta), with safe error
 * normalization, secret masking, and dependency-injectable fetch.
 */

import {
  ProviderError,
  MissingApiKeyError,
  ApiError,
  TimeoutError,
  NetworkError,
  MalformedResponseError,
} from './errors.js';

/**
 * @typedef {Object} Message
 * @property {'system' | 'user' | 'assistant' | 'tool'} role - Role of the message author.
 * @property {string | Array<{type: string, text?: string}>} content - Message text or content blocks.
 */

/**
 * @typedef {Object} CompletionOptions
 * @property {Message[]} messages - Sequence of conversation messages.
 * @property {number} [maxTokens] - Maximum tokens to generate.
 * @property {number} [timeoutMs] - Request timeout in milliseconds (overrides default).
 * @property {AbortSignal} [signal] - Optional caller-supplied abort signal.
 */

/**
 * @typedef {Object} TokenUsage
 * @property {number | null} inputTokens - Number of input/prompt tokens.
 * @property {number | null} outputTokens - Number of generated output tokens.
 * @property {number | null} totalTokens - Total tokens accounted for the request.
 */

/**
 * @typedef {Object} CompletionResult
 * @property {string} text - Generated text response.
 * @property {string} provider - Provider identifier (e.g. 'baseten', 'meta').
 * @property {string} model - Effective model identifier used for completion.
 * @property {string | null} finishReason - Normalized completion finish reason.
 * @property {boolean} isTruncated - True if output was truncated due to token limit.
 * @property {TokenUsage | null} usage - Token metrics, or null if not provided.
 */

/**
 * Safely extracts textual content from either string or array-of-parts structures.
 *
 * @param {unknown} content - Raw content from message payload.
 * @returns {string} Flattened text content.
 */
export function extractTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Base Model Provider providing standard chat-completion transport and normalization.
 */
export class BaseModelProvider {
  /**
   * @param {object} config
   * @param {string} config.provider - Provider name identifier.
   * @param {string} [config.apiKey] - Explicit API key (defaults to envVarName).
   * @param {string} config.envVarName - Name of environment variable holding API key.
   * @param {string} config.baseUrl - Base API URL.
   * @param {string} config.defaultModel - Default model ID.
   * @param {string} [config.modelId] - Specific model ID to use.
   * @param {number} [config.defaultTimeoutMs=30000] - Request timeout in ms.
   * @param {typeof fetch} [config.fetch] - Injected fetch implementation for testing.
   */
  constructor({
    provider,
    apiKey,
    envVarName,
    baseUrl,
    defaultModel,
    modelId,
    defaultTimeoutMs = 30000,
    fetch: injectedFetch,
  }) {
    this.provider = provider;
    this.envVarName = envVarName;
    this.apiKey = apiKey ?? (typeof process !== 'undefined' ? process.env[envVarName] : undefined);
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.modelId = modelId || defaultModel;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.fetch = injectedFetch || globalThis.fetch;
  }

  /**
   * Executes a text completion against the provider's chat completions endpoint.
   *
   * @param {CompletionOptions} options
   * @returns {Promise<CompletionResult>}
   */
  async complete({ messages, maxTokens, timeoutMs, signal: callerSignal } = {}) {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim() === '') {
      throw new MissingApiKeyError(this.provider, this.envVarName);
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ProviderError('messages must be a non-empty array of message objects.', {
        code: 'INVALID_INPUT',
        provider: this.provider,
      });
    }

    const endpoint = `${this.baseUrl}/chat/completions`;
    const timeout = typeof timeoutMs === 'number' ? timeoutMs : this.defaultTimeoutMs;

    const controller = new AbortController();
    let timedOut = false;
    let timeoutId = null;

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`Timeout after ${timeout}ms`));
      }, timeout);
    }

    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const requestBody = {
      model: this.modelId,
      messages,
      ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
    };

    let response;
    try {
      response = await this.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey.trim()}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);

      if (timedOut || err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT') {
        throw new TimeoutError(this.provider, timeout, err);
      }
      throw new NetworkError(this.provider, err?.message || 'Failed to complete network request', err);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }

    if (!response.ok) {
      let errorDetail = '';
      try {
        const errJson = await response.json();
        errorDetail = errJson?.error?.message || errJson?.message || '';
      } catch {
        try {
          errorDetail = await response.text();
        } catch {
          errorDetail = '';
        }
      }

      throw new ApiError(
        `API request to ${this.provider} failed with status HTTP ${response.status} (${response.statusText})${errorDetail ? `: ${errorDetail}` : ''}`,
        {
          provider: this.provider,
          statusCode: response.status,
          statusText: response.statusText,
          responseBody: errorDetail,
        }
      );
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new MalformedResponseError(
        this.provider,
        `Invalid JSON returned by provider: ${err?.message || 'Parse error'}`,
        err
      );
    }

    if (!data || typeof data !== 'object' || !Array.isArray(data.choices) || data.choices.length === 0) {
      throw new MalformedResponseError(
        this.provider,
        'Invalid response structure: missing or empty "choices" array.'
      );
    }

    const choice = data.choices[0];
    if (!choice || typeof choice !== 'object' || !choice.message || typeof choice.message !== 'object') {
      throw new MalformedResponseError(
        this.provider,
        'Invalid response structure: missing choice message object.'
      );
    }

    const rawContent = choice.message.content;
    const text = extractTextContent(rawContent);
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
    const isTruncated = finishReason === 'length';

    let usage = null;
    if (data.usage && typeof data.usage === 'object') {
      usage = {
        inputTokens: typeof data.usage.prompt_tokens === 'number' ? data.usage.prompt_tokens : null,
        outputTokens: typeof data.usage.completion_tokens === 'number' ? data.usage.completion_tokens : null,
        totalTokens: typeof data.usage.total_tokens === 'number' ? data.usage.total_tokens : null,
      };
    }

    return {
      text,
      provider: this.provider,
      model: typeof data.model === 'string' && data.model ? data.model : this.modelId,
      finishReason,
      isTruncated,
      usage,
    };
  }
}
