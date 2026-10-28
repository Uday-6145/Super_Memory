/**
 * Super Memory — Fireworks Model Provider Adapter
 *
 * Implements the Fireworks model API adapter targeting OpenAI-compatible endpoints
 * (https://api.fireworks.ai/inference/v1 via FIREWORKS_API_KEY).
 */

import { BaseModelProvider } from './base.js';

export const FIREWORKS_DEFAULT_BASE_URL = 'https://api.fireworks.ai/inference/v1';
export const FIREWORKS_DEFAULT_MODEL = 'accounts/fireworks/models/llama-v3p1-70b-instruct';

export class FireworksProvider extends BaseModelProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] - Explicit API key (defaults to FIREWORKS_API_KEY env).
   * @param {string} [options.baseUrl] - Base URL (defaults to FIREWORKS_BASE_URL or default URL).
   * @param {string} [options.modelId] - Model ID (defaults to FIREWORKS_MODEL_ID or default model).
   * @param {number} [options.defaultTimeoutMs] - Request timeout in ms.
   * @param {typeof fetch} [options.fetch] - Injected fetch implementation for testing.
   */
  constructor(options = {}) {
    const baseUrl =
      options.baseUrl ||
      (typeof process !== 'undefined' && process.env.FIREWORKS_BASE_URL) ||
      FIREWORKS_DEFAULT_BASE_URL;

    const modelId =
      options.modelId ||
      (typeof process !== 'undefined' && process.env.FIREWORKS_MODEL_ID) ||
      FIREWORKS_DEFAULT_MODEL;

    super({
      provider: 'fireworks',
      apiKey: options.apiKey,
      envVarName: 'FIREWORKS_API_KEY',
      baseUrl,
      defaultModel: FIREWORKS_DEFAULT_MODEL,
      modelId,
      defaultTimeoutMs: options.defaultTimeoutMs,
      fetch: options.fetch,
    });
  }
}

