
/**
 * Super Memory — Browser Session
 *
 * Owns an isolated browser context and page, providing bounded navigation,
 * safe structural DOM snapshotting, and accessible locator-based element actions.
 *
 * Security Controls:
 * - Rejects non-HTTP(S) schemes.
 * - Rejects URLs containing embedded credentials.
 * - Blocks loopback/localhost navigation by default (requires explicit allowLocalhost: true).
 * - Excludes password inputs, form values, cookies, and local storage from snapshots.
 * - Strips query strings and fragments from extracted snapshot links.
 *
 * NOTE: General SSRF/network-access security policy is not yet implemented.
 * This runtime is not yet safe for unrestricted model-controlled web navigation.
 */

import { NavigationError, ActionError, TimeoutError } from './errors.js';

/**
 * Checks whether a given hostname is an obvious loopback or localhost address,
 * normalizing trailing FQDN dots and IPv4-mapped IPv6 representations.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') {
    return false;
  }

  // Strip enclosing IPv6 brackets and trailing FQDN dots
  let normalized = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

  // Normalize IPv4-mapped IPv6 representations (both dotted-decimal and canonical hex)
  // to their standard IPv4 dotted-decimal equivalent.
  // Matches e.g. ::ffff:127.0.0.1, 0:0:0:0:0:ffff:127.0.0.1, ::ffff:7f00:1
  const ipv4MappedMatch = normalized.match(/^(?:(?:::)|(?:0{1,4}:)+)ffff:(.+)$/);
  if (ipv4MappedMatch) {
    const rest = ipv4MappedMatch[1];
    const dotMatch = rest.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (dotMatch) {
      const parts = [dotMatch[1], dotMatch[2], dotMatch[3], dotMatch[4]].map(Number);
      if (parts.every((p) => p >= 0 && p <= 255)) {
        normalized = parts.join('.');
      }
    } else {
      const hexMatch = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hexMatch) {
        const high = parseInt(hexMatch[1], 16);
        const low = parseInt(hexMatch[2], 16);
        const b0 = (high >> 8) & 0xff;
        const b1 = high & 0xff;
        const b2 = (low >> 8) & 0xff;
        const b3 = low & 0xff;
        normalized = `${b0}.${b1}.${b2}.${b3}`;
      }
    }
  }

  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.') ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '::'
  ) {
    return true;
  }
  return false;
}

/**
 * Sanitizes a URL for snapshot metadata, preserving origin and pathname only
 * while stripping sensitive query parameters and hash fragments.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function sanitizeSnapshotUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.origin && parsed.origin !== 'null') {
      return `${parsed.origin}${parsed.pathname}`;
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return rawUrl.split('?')[0].split('#')[0];
  }
}

/**
 * @typedef {Object} NavigationResult
 * @property {string} url - Final URL after navigation and redirects.
 * @property {string} title - Page title.
 * @property {number | null} status - HTTP status code, if available.
 * @property {boolean} ok - True if HTTP status is 2xx or 3xx (or non-HTTP success).
 */

/**
 * @typedef {Object} InteractiveElement
 * @property {string} tag - HTML tag name (e.g. 'button', 'a', 'input').
 * @property {string} role - ARIA role or semantic element role.
 * @property {string} name - Accessible name or visible text (truncated).
 * @property {string | null} type - Element type attribute, if applicable.
 * @property {string | null} placeholder - Placeholder text, if applicable.
 * @property {string | null} href - Sanitized target URL for anchor tags (stripped of queries/fragments).
 * @property {boolean} disabled - True if element is disabled.
 */

/**
 * @typedef {Object} BoundedSnapshot
 * @property {string} url - Sanitized page URL (origin and pathname only, excluding query strings and fragments).
 * @property {string} title - Current page title.
 * @property {string} text - Visible body text, truncated to maxTextLength.
 * @property {boolean} isTextTruncated - True if body text exceeded maxTextLength.
 * @property {InteractiveElement[]} elements - Bounded collection of visible interactive elements.
 * @property {boolean} areElementsTruncated - True if elements exceeded maxElements limit.
 */

export class BrowserSession {
  /**
   * @param {import('playwright').BrowserContext} context
   * @param {import('playwright').Page} page
   * @param {object} [options]
   * @param {boolean} [options.allowLocalhost=false] - Whether localhost navigation is permitted.
   */
  constructor(context, page, { allowLocalhost = false } = {}) {
    this.context = context;
    this.page = page;
    this.allowLocalhost = Boolean(allowLocalhost);
    this.isClosed = false;
  }

  /**
   * Validates safety constraints and navigates to a URL.
   *
   * @param {string} url - Destination URL (must be http: or https:).
   * @param {object} [options]
   * @param {number} [options.timeoutMs=30000] - Navigation timeout in ms.
   * @param {'domcontentloaded' | 'load' | 'networkidle'} [options.waitUntil='domcontentloaded'] - Milestone event.
   * @param {boolean} [options.allowLocalhost] - Override session localhost permission.
   * @returns {Promise<NavigationResult>}
   */
  async navigate(url, { timeoutMs = 30000, waitUntil = 'domcontentloaded', allowLocalhost } = {}) {
    if (this.isClosed) {
      throw new NavigationError('Cannot navigate: browser session is already closed.');
    }

    if (!url || typeof url !== 'string') {
      throw new NavigationError('A valid URL string is required for navigation.');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      throw new NavigationError(`Invalid URL provided: "${url}"`, { url, cause: err });
    }

    // Protocol restriction
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new NavigationError(
        `Unsupported protocol: "${parsedUrl.protocol}". Only "http:" and "https:" are allowed.`,
        { url }
      );
    }

    // Embedded credentials restriction
    if (parsedUrl.username || parsedUrl.password) {
      throw new NavigationError(
        'URLs with embedded credentials (user:password@) are not allowed.',
        { url: parsedUrl.origin + parsedUrl.pathname }
      );
    }

    // Localhost / Loopback restriction
    const permitsLocalhost = typeof allowLocalhost === 'boolean' ? allowLocalhost : this.allowLocalhost;
    if (isLoopbackHostname(parsedUrl.hostname) && !permitsLocalhost) {
      throw new NavigationError(
        `Navigation to loopback/localhost destination ("${parsedUrl.hostname}") is blocked by default. Enable allowLocalhost for local test fixtures only.`,
        { url: parsedUrl.href }
      );
    }

    let response;
    try {
      response = await this.page.goto(parsedUrl.href, {
        timeout: timeoutMs,
        waitUntil,
      });
    } catch (err) {
      if (err.name === 'TimeoutError') {
        throw new TimeoutError(`Navigation timed out after ${timeoutMs}ms: ${parsedUrl.href}`, {
          timeoutMs,
          cause: err,
        });
      }
      throw new NavigationError(`Navigation failed: ${err.message}`, { url: parsedUrl.href, cause: err });
    }

    const finalUrl = this.page.url();
    const title = await this.page.title();
    const status = response ? response.status() : null;
    const ok = response ? response.ok() : true;

    return {
      url: finalUrl,
      title,
      status,
      ok,
    };
  }

  /**
   * Captures a bounded, structured snapshot of the current page.
   *
   * Security Guarantees:
   * - Excludes scripts, styles, hidden inputs, password inputs, password values,
   *   cookies, local storage, and user input values.
   * - Strips query strings and fragments from the page URL and anchor link targets.
   * - Bounded text and element caps prevent unbounded memory expansion.
   *
   * @param {object} [options]
   * @param {number} [options.maxTextLength=4000] - Max characters of visible body text.
   * @param {number} [options.maxElements=50] - Max interactive elements returned.
   * @returns {Promise<BoundedSnapshot>}
   */
  async getSnapshot({ maxTextLength = 4000, maxElements = 50 } = {}) {
    if (this.isClosed) {
      throw new NavigationError('Cannot take snapshot: browser session is already closed.');
    }

    const rawUrl = this.page.url();
    const url = sanitizeSnapshotUrl(rawUrl);
    const title = await this.page.title();

    // Extract visible body text cleanly, avoiding scripts and style contents
    let rawText = '';
    try {
      rawText = await this.page.locator('body').innerText({ timeout: 5000 });
    } catch {
      rawText = '';
    }

    const normalizedText = rawText.replace(/\s+/g, ' ').trim();
    const text = normalizedText.slice(0, maxTextLength);
    const isTextTruncated = normalizedText.length > maxTextLength;

    // Extract visible interactive elements excluding passwords, hidden fields, and sensitive data
    const rawElements = await this.page.$$eval(
      'button, a[href], input:not([type="hidden"]):not([type="password"]), select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"]',
      (nodes) => {
        return nodes
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none'
            );
          })
          .map((el) => {
            const tag = el.tagName.toLowerCase();
            const role =
              el.getAttribute('role') ||
              (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag);

            const ariaLabel = el.getAttribute('aria-label') || '';
            const ariaPlaceholder = el.getAttribute('placeholder') || null;
            const textContent = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            const name = (ariaLabel || textContent || el.getAttribute('title') || '').slice(0, 100);
            const type = el.getAttribute('type') || (tag === 'input' ? 'text' : null);

            // Strip query strings and hash fragments from hrefs to avoid leaking tokens/parameters
            let href = null;
            if (tag === 'a' && el.getAttribute('href')) {
              try {
                const parsed = new URL(el.getAttribute('href'), window.location.href);
                href = `${parsed.origin}${parsed.pathname}`;
              } catch {
                href = (el.getAttribute('href') || '').split('?')[0].split('#')[0];
              }
            }

            const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');

            // Associated <label> text (el.labels covers label[for] and wrapping
            // labels), falling back to aria-label. This is what getByLabel
            // matches against, so repair grounding can verify labels exactly.
            let label = '';
            try {
              if (el.labels && el.labels.length > 0) {
                label = (el.labels[0].innerText || el.labels[0].textContent || '')
                  .trim()
                  .replace(/\s+/g, ' ');
              }
            } catch {}
            if (!label) {
              label = ariaLabel;
            }

            // NOTE: Never extract el.value! Input values are strictly excluded.
            return {
              tag,
              role,
              name,
              type,
              placeholder: ariaPlaceholder,
              href,
              disabled,
              label: label ? label.slice(0, 100) : null,
            };
          });
      }
    );

    const elements = rawElements.slice(0, maxElements);
    const areElementsTruncated = rawElements.length > maxElements;

    return {
      url,
      title,
      text,
      isTextTruncated,
      elements,
      areElementsTruncated,
    };
  }

  /**
   * Clicks an element located by its accessible role and name.
   *
   * @param {object} options
   * @param {string} options.role - ARIA role (e.g. 'button', 'link').
   * @param {string | RegExp} [options.name] - Accessible name or text pattern.
   * @param {boolean} [options.exact=false] - Exact matching for accessible name.
   * @param {number} [options.timeoutMs=10000] - Operation timeout in ms.
   * @returns {Promise<{ ok: boolean, action: string, role: string, name?: string | RegExp }>}
   */
  async clickByRole({ role, name, exact = false, timeoutMs = 10000 } = {}) {
    if (this.isClosed) {
      throw new ActionError('Cannot click element: browser session is closed.', {
        action: 'clickByRole',
        target: role,
      });
    }

    if (!role || typeof role !== 'string' || role.trim() === '') {
      throw new ActionError('A non-empty role string is required for clickByRole.', {
        action: 'clickByRole',
      });
    }

    const locatorOptions = { exact };
    if (name !== undefined) {
      locatorOptions.name = name;
    }

    try {
      const locator = this.page.getByRole(role, locatorOptions).first();
      await locator.click({ timeout: timeoutMs });
      return { ok: true, action: 'clickByRole', role, name };
    } catch (err) {
      const targetDesc = `role="${role}"${name !== undefined ? ` name="${name}"` : ''}`;
      if (err.name === 'TimeoutError') {
        throw new TimeoutError(`clickByRole timed out after ${timeoutMs}ms on ${targetDesc}.`, {
          timeoutMs,
          cause: err,
        });
      }
      throw new ActionError(`clickByRole failed on ${targetDesc}: ${err.message}`, {
        action: 'clickByRole',
        target: targetDesc,
        cause: err,
      });
    }
  }

  /**
   * Fills an editable form field located by its associated label.
   *
   * Security Guarantee: The entered value is never printed to logs or error messages.
   *
   * @param {object} options
   * @param {string | RegExp} options.label - Accessible label text.
   * @param {string} options.value - String value to fill.
   * @param {boolean} [options.exact=false] - Exact matching for label.
   * @param {number} [options.timeoutMs=10000] - Operation timeout in ms.
   * @returns {Promise<{ ok: boolean, action: string, label: string | RegExp }>}
   */
  async fillByLabel({ label, value, exact = false, timeoutMs = 10000 } = {}) {
    if (this.isClosed) {
      throw new ActionError('Cannot fill element: browser session is closed.', {
        action: 'fillByLabel',
        target: String(label),
      });
    }

    if (!label || (typeof label !== 'string' && !(label instanceof RegExp)) || String(label).trim() === '') {
      throw new ActionError('A non-empty label is required for fillByLabel.', {
        action: 'fillByLabel',
      });
    }

    if (typeof value !== 'string') {
      throw new ActionError('Value to fill must be a string.', {
        action: 'fillByLabel',
        target: String(label),
      });
    }

    try {
      const locator = this.page.getByLabel(label, { exact }).first();
      await locator.fill(value, { timeout: timeoutMs });
      // NOTE: Never log or return `value`!
      return { ok: true, action: 'fillByLabel', label };
    } catch (err) {
      const targetDesc = `label="${String(label)}"`;
      if (err.name === 'TimeoutError') {
        throw new TimeoutError(`fillByLabel timed out after ${timeoutMs}ms on ${targetDesc}.`, {
          timeoutMs,
          cause: err,
        });
      }
      throw new ActionError(`fillByLabel failed on ${targetDesc}: ${err.message}`, {
        action: 'fillByLabel',
        target: targetDesc,
        cause: err,
      });
    }
  }

  /**
   * Clicks an element using a CSS or text selector string.
   *
   * @param {string} selector - CSS or text locator selector.
   * @param {object} [options]
   * @param {number} [options.timeoutMs=10000] - Action timeout in ms.
   * @returns {Promise<{ ok: boolean, action: string, selector: string }>}
   */
  async click(selector, { timeoutMs = 10000 } = {}) {
    if (this.isClosed) {
      throw new ActionError('Cannot click element: browser session is closed.', { action: 'click', target: selector });
    }

    if (!selector || typeof selector !== 'string') {
      throw new ActionError('A valid selector string is required for click.', { action: 'click' });
    }

    try {
      await this.page.locator(selector).first().click({ timeout: timeoutMs });
      return { ok: true, action: 'click', selector };
    } catch (err) {
      if (err.name === 'TimeoutError') {
        throw new TimeoutError(`Click action timed out after ${timeoutMs}ms on "${selector}".`, {
          timeoutMs,
          cause: err,
        });
      }
      throw new ActionError(`Click action failed on "${selector}": ${err.message}`, {
        action: 'click',
        target: selector,
        cause: err,
      });
    }
  }

  /**
   * Fills an editable element using a CSS or text selector.
   *
   * @param {string} selector - CSS or text locator selector.
   * @param {string} value - Text to fill (not logged).
   * @param {object} [options]
   * @param {number} [options.timeoutMs=10000] - Action timeout in ms.
   * @returns {Promise<{ ok: boolean, action: string, selector: string }>}
   */
  async fill(selector, value, { timeoutMs = 10000 } = {}) {
    if (this.isClosed) {
      throw new ActionError('Cannot fill element: browser session is closed.', { action: 'fill', target: selector });
    }

    if (!selector || typeof selector !== 'string') {
      throw new ActionError('A valid selector string is required for fill.', { action: 'fill' });
    }

    if (typeof value !== 'string') {
      throw new ActionError('Value to fill must be a string.', { action: 'fill', target: selector });
    }

    try {
      await this.page.locator(selector).first().fill(value, { timeout: timeoutMs });
      return { ok: true, action: 'fill', selector };
    } catch (err) {
      if (err.name === 'TimeoutError') {
        throw new TimeoutError(`Fill action timed out after ${timeoutMs}ms on "${selector}".`, {
          timeoutMs,
          cause: err,
        });
      }
      throw new ActionError(`Fill action failed on "${selector}": ${err.message}`, {
        action: 'fill',
        target: selector,
        cause: err,
      });
    }
  }

  /**
   * Closes the session page and its isolated context safely and idempotently.
   */
  async close() {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => { });
      }
    } finally {
      if (this.context) {
        await this.context.close().catch(() => { });
      }
    }
  }
}
