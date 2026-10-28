/**
 * Super Memory — Meta Model Provider Adapter
 *
 * Implements the Meta Model API adapter targeting OpenAI-compatible endpoints
 * (e.g. muse-spark-1.3 or muse-wonder-1.0 via https://api.meta.ai/v1).
 */

import { BaseModelProvider } from './base.js';

export const META_DEFAULT_BASE_URL = 'https://api.meta.ai/v1';
export const META_DEFAULT_MODEL = 'muse-spark-1.3';

export class MetaProvider extends BaseModelProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] - Explicit API key (defaults to META_API_KEY or MODEL_API_KEY env).
   * @param {string} [options.baseUrl] - Base URL (defaults to META_BASE_URL or MODEL_BASE_URL).
   * @param {string} [options.modelId] - Model ID (defaults to META_MODEL_ID or MODEL_ID).
   * @param {number} [options.defaultTimeoutMs] - Request timeout in ms.
   * @param {typeof fetch} [options.fetch] - Injected fetch implementation for testing.
   */
  constructor(options = {}) {
    const baseUrl =
      options.baseUrl ||
      (typeof process !== 'undefined' && (process.env.META_BASE_URL || process.env.MODEL_BASE_URL)) ||
      META_DEFAULT_BASE_URL;

    const modelId =
      options.modelId ||
      (typeof process !== 'undefined' && (process.env.META_MODEL_ID || process.env.MODEL_ID)) ||
      META_DEFAULT_MODEL;

    const apiKey =
      options.apiKey ||
      (typeof process !== 'undefined' && (process.env.META_API_KEY || process.env.MODEL_API_KEY));

    super({
      provider: 'meta',
      apiKey,
      envVarName: 'META_API_KEY',
      baseUrl,
      defaultModel: META_DEFAULT_MODEL,
      modelId,
      defaultTimeoutMs: options.defaultTimeoutMs,
      fetch: options.fetch,
    });
  }
}
