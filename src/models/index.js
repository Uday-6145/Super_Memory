/**
 * Super Memory — Model Provider Module Entrypoint
 */

import { BasetenProvider } from './baseten.js';
import { MetaProvider } from './meta.js';
import { ProviderError } from './errors.js';

export * from './errors.js';
export * from './base.js';
export * from './baseten.js';
export * from './meta.js';

/**
 * Factory function to create a configured model provider instance.
 *
 * @param {'baseten' | 'meta' | string} provider - Provider name.
 * @param {object} [options] - Provider configuration overrides.
 * @returns {BasetenProvider | MetaProvider} Configured provider instance.
 */
export function createModelProvider(provider, options = {}) {
  const normalized = String(provider).toLowerCase().trim();
  switch (normalized) {
    case 'baseten':
      return new BasetenProvider(options);
    case 'meta':
      return new MetaProvider(options);
    default:
      throw new ProviderError(
        `Unknown model provider: "${provider}". Supported providers: "baseten", "meta".`,
        { code: 'UNKNOWN_PROVIDER' }
      );
  }
}
