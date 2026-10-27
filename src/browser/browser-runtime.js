/**
 * Super Memory — Browser Runtime
 *
 * Manages the Playwright Chromium browser process lifecycle and provisions
 * isolated BrowserSession instances without persisting data or profile state.
 */

import { chromium } from 'playwright';
import { BrowserSession } from './browser-session.js';
import { BrowserError } from './errors.js';

export class BrowserRuntime {
  /**
   * @param {object} [options]
   * @param {boolean} [options.headless=true] - Run browser in headless mode.
   * @param {boolean} [options.allowLocalhost=false] - Default permission for loopback/localhost navigation.
   * @param {object} [options.launchOptions={}] - Additional Playwright launch options.
   */
  constructor({ headless = true, allowLocalhost = false, launchOptions = {} } = {}) {
    this.headless = headless;
    this.allowLocalhost = Boolean(allowLocalhost);
    this.launchOptions = launchOptions;
    this.browser = null;
    this.activeSessions = new Set();
    this.isClosed = false;
  }

  /**
   * Launches the managed Chromium browser process if not already running.
   *
   * @returns {Promise<import('playwright').Browser>}
   */
  async launch() {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    try {
      this.browser = await chromium.launch({
        headless: this.headless,
        ...this.launchOptions,
      });
      this.isClosed = false;
      return this.browser;
    } catch (err) {
      if (err.message && (err.message.includes('Executable doesn\'t exist') || err.message.includes('playwright install'))) {
        throw new BrowserError(
          'Chromium browser binary not found. Please install it by running: "npx playwright install chromium"',
          { cause: err }
        );
      }
      throw new BrowserError(`Failed to launch browser: ${err.message}`, { cause: err });
    }
  }

  /**
   * Creates a new, isolated browser session with its own BrowserContext.
   *
   * Guarantees:
   * - Does not persist session state to disk.
   * - Does not read or share cookies with the host system or other sessions.
   * - Provides fresh context for every session.
   *
   * @param {object} [contextOptions] - Playwright BrowserContext options.
   * @param {boolean} [contextOptions.allowLocalhost] - Session-specific localhost permission.
   * @returns {Promise<BrowserSession>}
   */
  async createSession(contextOptions = {}) {
    if (this.isClosed) {
      throw new BrowserError('Cannot create session: BrowserRuntime is closed.');
    }

    const browser = await this.launch();

    let context;
    try {
      context = await browser.newContext({
        userAgent: 'SuperMemory-Agent/0.1 (+https://github.com/super-memory)',
        viewport: { width: 1280, height: 800 },
        ...contextOptions,
      });
    } catch (err) {
      throw new BrowserError(`Failed to create browser context: ${err.message}`, { cause: err });
    }

    let page;
    try {
      page = await context.newPage();
    } catch (err) {
      await context.close().catch(() => {});
      throw new BrowserError(`Failed to open page in new context: ${err.message}`, { cause: err });
    }

    const permitsLocalhost =
      typeof contextOptions.allowLocalhost === 'boolean'
        ? contextOptions.allowLocalhost
        : this.allowLocalhost;

    const session = new BrowserSession(context, page, { allowLocalhost: permitsLocalhost });
    this.activeSessions.add(session);

    // Intercept close to keep tracking set updated
    const originalClose = session.close.bind(session);
    session.close = async () => {
      this.activeSessions.delete(session);
      await originalClose();
    };

    return session;
  }

  /**
   * Closes a specific active session.
   *
   * @param {BrowserSession} session
   */
  async closeSession(session) {
    if (session) {
      this.activeSessions.delete(session);
      await session.close().catch(() => {});
    }
  }

  /**
   * Closes all active sessions and the underlying browser process.
   * Safe to call repeatedly.
   */
  async close() {
    if (this.isClosed && !this.browser) return;
    this.isClosed = true;

    // Close all open sessions
    const sessions = Array.from(this.activeSessions);
    this.activeSessions.clear();
    await Promise.allSettled(sessions.map((s) => s.close()));

    // Close underlying browser process
    if (this.browser) {
      try {
        if (this.browser.isConnected()) {
          await this.browser.close();
        }
      } catch {
        // Safe idempotent cleanup
      } finally {
        this.browser = null;
      }
    }
  }
}

/**
 * Factory to create a BrowserRuntime instance.
 *
 * @param {object} [options]
 * @returns {BrowserRuntime}
 */
export function createBrowserRuntime(options = {}) {
  return new BrowserRuntime(options);
}
