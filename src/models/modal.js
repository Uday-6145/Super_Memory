/**
 * Super Memory — Modal Model Provider Adapter
 *
 * Implements the Modal model API adapter targeting OpenAI-compatible endpoints
 * (configurable via MODAL_BASE_URL and MODAL_API_KEY).
 */

import { BaseModelProvider } from './base.js';

export const MODAL_DEFAULT_BASE_URL = 'https://api.modal.com/v1';
export const MODAL_DEFAULT_MODEL = 'meta-llama/llama-3.1-70b-instruct';

export class ModalProvider extends BaseModelProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] - Explicit API key (defaults to MODAL_API_KEY env).
   * @param {string} [options.baseUrl] - Base URL (defaults to MODAL_BASE_URL or default URL).
   * @param {string} [options.modelId] - Model ID (defaults to MODAL_MODEL_ID or default model).
   * @param {number} [options.defaultTimeoutMs] - Request timeout in ms.
   * @param {typeof fetch} [options.fetch] - Injected fetch implementation for testing.
   */
  constructor(options = {}) {
    const baseUrl =
      options.baseUrl ||
      (typeof process !== 'undefined' && process.env.MODAL_BASE_URL) ||
      MODAL_DEFAULT_BASE_URL;

    const modelId =
      options.modelId ||
      (typeof process !== 'undefined' && process.env.MODAL_MODEL_ID) ||
      MODAL_DEFAULT_MODEL;

    super({
      provider: 'modal',
      apiKey: options.apiKey,
      envVarName: 'MODAL_API_KEY',
      baseUrl,
      defaultModel: MODAL_DEFAULT_MODEL,
      modelId,
      defaultTimeoutMs: options.defaultTimeoutMs,
      fetch: options.fetch,
    });
  }
}

