/**
 * Super Memory — Browser Runtime Error Hierarchy
 *
 * Provides typed, sanitized errors for browser lifecycle, navigation, and element actions.
 * Never exposes credentials, secret tokens, or sensitive form values in error messages.
 */

export class BrowserError extends Error {
  /**
   * @param {string} message - Sanitized description.
   * @param {object} [options]
   * @param {string} [options.code] - Machine-readable error code.
   * @param {Error} [options.cause] - Underlying cause, if any.
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'BrowserError';
    this.code = options.code || 'BROWSER_ERROR';
  }
}

export class NavigationError extends BrowserError {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {string} [options.url]
   * @param {number} [options.statusCode]
   * @param {Error} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, { code: 'NAVIGATION_ERROR', cause: options.cause });
    this.name = 'NavigationError';
    this.url = options.url || null;
    this.statusCode = options.statusCode || null;
  }
}

export class ActionError extends BrowserError {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {string} [options.action]
   * @param {string} [options.target]
   * @param {Error} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, { code: 'ACTION_ERROR', cause: options.cause });
    this.name = 'ActionError';
    this.action = options.action || null;
    this.target = options.target || null;
  }
}

export class TimeoutError extends BrowserError {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {Error} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, { code: 'TIMEOUT_ERROR', cause: options.cause });
    this.name = 'TimeoutError';
    this.timeoutMs = options.timeoutMs || null;
  }
}
