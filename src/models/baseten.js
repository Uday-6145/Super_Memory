/**
 * Super Memory — Baseten Model Provider Adapter
 *
 * Implements the Baseten adapter targeting OpenAI-compatible endpoints
 * (e.g. meta-models/muse-spark-open-1026).
 */

import { BaseModelProvider } from './base.js';

export const BASETEN_DEFAULT_BASE_URL = 'https://inference.baseten.co/v1';
export const BASETEN_DEFAULT_MODEL = 'meta-models/muse-spark-open-1026';

export class BasetenProvider extends BaseModelProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] - Explicit API key (defaults to BASETEN_API_KEY env).
   * @param {string} [options.baseUrl] - Base URL (defaults to BASETEN_BASE_URL or default URL).
   * @param {string} [options.modelId] - Model ID (defaults to BASETEN_MODEL_ID or default model).
   * @param {number} [options.defaultTimeoutMs] - Request timeout in ms.
   * @param {typeof fetch} [options.fetch] - Injected fetch implementation for testing.
   */
  constructor(options = {}) {
    const baseUrl =
      options.baseUrl ||
      (typeof process !== 'undefined' && process.env.BASETEN_BASE_URL) ||
      BASETEN_DEFAULT_BASE_URL;

    const modelId =
      options.modelId ||
      (typeof process !== 'undefined' && process.env.BASETEN_MODEL_ID) ||
      BASETEN_DEFAULT_MODEL;

    super({
      provider: 'baseten',
      apiKey: options.apiKey,
      envVarName: 'BASETEN_API_KEY',
      baseUrl,
      defaultModel: BASETEN_DEFAULT_MODEL,
      modelId,
      defaultTimeoutMs: options.defaultTimeoutMs,
      fetch: options.fetch,
    });
  }
}
