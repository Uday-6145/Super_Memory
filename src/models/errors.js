/**
 * Super Memory — Model Provider Error Hierarchy
 *
 * Normalizes errors across model providers (missing keys, HTTP failures, timeouts,
 * network transport issues, and malformed responses) while ensuring sensitive
 * credentials and headers are never leaked in error messages.
 */

/**
 * Base class for all model provider errors.
 */
export class ProviderError extends Error {
  /**
   * @param {string} message - Human-readable error description (sanitized).
   * @param {object} [options]
   * @param {string} [options.code] - Machine-readable error code.
   * @param {string} [options.provider] - Provider identifier (e.g. 'baseten', 'meta').
   * @param {Error} [options.cause] - Underlying cause, if any.
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.code = options.code || 'PROVIDER_ERROR';
    this.provider = options.provider || null;
  }
}

/**
 * Thrown when an API key is missing or blank.
 */
export class MissingApiKeyError extends ProviderError {
  /**
   * @param {string} provider - Provider identifier.
   * @param {string} envVarName - Name of the missing environment variable.
   */
  constructor(provider, envVarName) {
    super(`Missing API key for provider "${provider}". Please configure ${envVarName}.`, {
      code: 'MISSING_API_KEY',
      provider,
    });
    this.name = 'MissingApiKeyError';
    this.envVarName = envVarName;
  }
}

/**
 * Thrown when an upstream provider returns a non-2xx HTTP status.
 */
export class ApiError extends ProviderError {
  /**
   * @param {string} message - Sanitized error message.
   * @param {object} options
   * @param {string} options.provider
   * @param {number} options.statusCode
   * @param {string} [options.statusText]
   * @param {string} [options.responseBody]
   * @param {Error} [options.cause]
   */
  constructor(message, options) {
    super(message, {
      code: 'API_ERROR',
      provider: options.provider,
      cause: options.cause,
    });
    this.name = 'ApiError';
    this.statusCode = options.statusCode;
    this.statusText = options.statusText || '';
    this.responseBody = options.responseBody || '';
  }
}

/**
 * Thrown when an API request times out.
 */
export class TimeoutError extends ProviderError {
  /**
   * @param {string} provider
   * @param {number} timeoutMs
   * @param {Error} [cause]
   */
  constructor(provider, timeoutMs, cause) {
    super(`Request to provider "${provider}" timed out after ${timeoutMs}ms.`, {
      code: 'TIMEOUT_ERROR',
      provider,
      cause,
    });
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a network transport failure occurs (e.g. DNS failure, connection reset, offline).
 */
export class NetworkError extends ProviderError {
  /**
   * @param {string} provider
   * @param {string} message
   * @param {Error} [cause]
   */
  constructor(provider, message, cause) {
    super(`Network connection to provider "${provider}" failed: ${message}`, {
      code: 'NETWORK_ERROR',
      provider,
      cause,
    });
    this.name = 'NetworkError';
  }
}

/**
 * Thrown when the provider returns invalid JSON or an unexpected response shape.
 */
export class MalformedResponseError extends ProviderError {
  /**
   * @param {string} provider
   * @param {string} message
   * @param {Error} [cause]
   */
  constructor(provider, message, cause) {
    super(`Malformed response from provider "${provider}": ${message}`, {
      code: 'MALFORMED_RESPONSE',
      provider,
      cause,
    });
    this.name = 'MalformedResponseError';
  }
}
