/**
 * Super Memory — Model Provider Module Entrypoint
 */

import { BasetenProvider } from './baseten.js';
import { MetaProvider } from './meta.js';
import { ModalProvider } from './modal.js';
import { FireworksProvider } from './fireworks.js';
import { ProviderError } from './errors.js';

export * from './errors.js';
export * from './base.js';
export * from './baseten.js';
export * from './meta.js';
export * from './modal.js';
export * from './fireworks.js';

/**
 * Factory function to create a configured model provider instance.
 *
 * @param {'baseten' | 'meta' | 'modal' | 'fireworks' | string} provider - Provider name.
 * @param {object} [options] - Provider configuration overrides.
 * @returns {BasetenProvider | MetaProvider | ModalProvider | FireworksProvider} Configured provider instance.
 */
export function createModelProvider(provider, options = {}) {
  const normalized = String(provider).toLowerCase().trim();
  switch (normalized) {
    case 'baseten':
      return new BasetenProvider(options);
    case 'meta':
      return new MetaProvider(options);
    case 'modal':
      return new ModalProvider(options);
    case 'fireworks':
      return new FireworksProvider(options);
    default:
      throw new ProviderError(
        `Unknown model provider: "${provider}". Supported providers: "baseten", "meta", "modal", "fireworks".`,
        { code: 'UNKNOWN_PROVIDER' }
      );
  }
}

/**
 * Resolves the primary Meta model provider for recovery reasoning following strategic order:
 * 1. Direct Meta Model API (META_API_KEY or MODEL_API_KEY)
 * 2. Meta model via Baseten (BASETEN_API_KEY with meta-models/muse-spark-open-1026)
 *
 * @param {object} [options] - Configuration overrides.
 * @returns {MetaProvider | BasetenProvider} Configured provider instance.
 */
export function getPreferredRecoveryProvider(options = {}) {
  const metaKey =
    options.apiKey ||
    (typeof process !== 'undefined' && (process.env.META_API_KEY || process.env.MODEL_API_KEY));

  if (metaKey && typeof metaKey === 'string' && metaKey.trim() !== '') {
    return createModelProvider('meta', options);
  }

  const basetenKey =
    options.apiKey ||
    (typeof process !== 'undefined' && process.env.BASETEN_API_KEY);

  if (basetenKey && typeof basetenKey === 'string' && basetenKey.trim() !== '') {
    return createModelProvider('baseten', {
      modelId: options.modelId || (typeof process !== 'undefined' && process.env.BASETEN_MODEL_ID) || 'meta-models/muse-spark-open-1026',
      ...options,
    });
  }

  throw new ProviderError(
    'No Meta reasoning route available. Configure META_API_KEY (or MODEL_API_KEY) for Meta Model API, or BASETEN_API_KEY for Meta model via Baseten.',
    { code: 'NO_RECOVERY_PROVIDER' }
  );
}
