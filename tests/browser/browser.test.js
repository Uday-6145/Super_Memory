/**
 * Super Memory — Browser Runtime Integration Tests
 *
 * Tests Chromium lifecycle, isolated sessions, navigation safety, bounded snapshots,
 * and accessible locator interactions (clickByRole, fillByLabel) exclusively using
 * localhost HTTP fixtures.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createBrowserRuntime,
  sanitizeSnapshotUrl,
  NavigationError,
  ActionError,
  TimeoutError,
} from '../../src/browser/index.js';

describe('Browser Runtime Integration Tests (Local Fixtures)', () => {
  let fixtureServer;
  let baseUrl;
  let browserRuntime;

  // Local HTTP Fixture Server (Zero external network dependencies)
  before(async () => {
    fixtureServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Super Memory Test Home</title></head>
          <body>
            <h1>Welcome to Super Memory</h1>
            <p id="counter">Clicks: 0</p>
            <button id="increment-btn" onclick="let c = document.getElementById('counter'); c.innerText = 'Clicks: ' + (parseInt(c.innerText.split(': ')[1]) + 1);">Click Me</button>
            <a href="/about?auth_token=super_secret_param#section" id="about-link">About Page</a>
            <form id="test-form" onsubmit="event.preventDefault(); document.getElementById('feedback').innerText = 'Submitted: ' + document.getElementById('query-input').value;">
              <label for="query-input">Search Workflows</label>
              <input type="text" id="query-input" placeholder="Search workflows..." />

              <label for="secret-input">Secret Key</label>
              <input type="password" id="secret-input" value="SuperSecretPasswordValue" placeholder="Hidden password" />

              <button type="submit">Run Search</button>
            </form>
            <p id="feedback"></p>
          </body>
          </html>
        `);
        return;
      }

      if (url.pathname === '/about') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>About Super Memory</title></head>
          <body>
            <h1>About Super Memory</h1>
            <p>Verified workflow memory engine.</p>
          </body>
          </html>
        `);
        return;
      }

      if (url.pathname === '/cookie-set') {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': 'session_token=super_secret_cookie_xyz; Path=/',
        });
        res.end('<html><head><title>Cookie Set</title></head><body>Cookie Assigned</body></html>');
        return;
      }

      if (url.pathname === '/cookie-check') {
        const cookie = req.headers.cookie || '';
        const hasSessionCookie = cookie.includes('session_token=');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>Cookie Check</title></head><body>Has Cookie: ${hasSessionCookie}</body></html>`);
        return;
      }

      if (url.pathname === '/slow') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><head><title>Slow Response</title></head><body>Done</body></html>');
          }
        }, 1500);
        return;
      }

      if (url.pathname === '/404') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Not Found</title></head><body>Custom 404 Page</body></html>');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise((resolve) => {
      fixtureServer.listen(0, '127.0.0.1', () => {
        const port = fixtureServer.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    browserRuntime = createBrowserRuntime({ headless: true, allowLocalhost: true });
  });

  after(async () => {
    if (browserRuntime) {
      await browserRuntime.close();
    }
    if (fixtureServer) {
      await new Promise((resolve) => fixtureServer.close(resolve));
    }
  });

  // 1. Chromium launches and closes successfully
  it('1. launches and closes Chromium browser process cleanly', async () => {
    const runtime = createBrowserRuntime({ headless: true });
    const browser = await runtime.launch();
    assert(browser.isConnected(), 'Browser process must be connected upon launch');

    await runtime.close();
    assert.equal(runtime.browser, null, 'Browser reference must be null after close');

    // Repeated close should be safe and idempotent
    await runtime.close();
  });

  // 2. A browser session can be created and closed
  it('2. creates and closes an isolated browser session', async () => {
    const session = await browserRuntime.createSession();
    assert(session.page, 'Session must have an active page');
    assert.equal(session.isClosed, false);

    await session.close();
    assert.equal(session.isClosed, true);

    // Repeated close must not throw
    await session.close();
  });

  // 3. Navigation to local fixture succeeds only when test-only localhost option is enabled
  it('3. blocks loopback/localhost by default and allows navigation only when allowLocalhost is set', async () => {
    // Default session: allowLocalhost = false
    const restrictedRuntime = createBrowserRuntime({ headless: true, allowLocalhost: false });
    const restrictedSession = await restrictedRuntime.createSession();

    try {
      await assert.rejects(
        () => restrictedSession.navigate(`${baseUrl}/`),
        (err) => err instanceof NavigationError && err.message.includes('blocked by default')
      );
    } finally {
      await restrictedSession.close();
      await restrictedRuntime.close();
    }

    // Permitted session: allowLocalhost = true
    const permittedSession = await browserRuntime.createSession({ allowLocalhost: true });
    try {
      const navResult = await permittedSession.navigate(`${baseUrl}/`);
      assert.equal(navResult.url, `${baseUrl}/`);
      assert.equal(navResult.status, 200);
      assert.equal(navResult.ok, true);
    } finally {
      await permittedSession.close();
    }
  });

  // 4. Unsupported URL schemes and embedded URL credentials are rejected
  it('4. rejects unsupported schemes (ftp:, javascript:) and embedded credentials', async () => {
    const session = await browserRuntime.createSession();
    try {
      // Unsupported ftp:
      await assert.rejects(
        () => session.navigate('ftp://example.com/test'),
        (err) => err instanceof NavigationError && err.message.includes('Unsupported protocol')
      );

      // Unsupported javascript:
      await assert.rejects(
        () => session.navigate('javascript:alert(1)'),
        (err) => err instanceof NavigationError && err.message.includes('Unsupported protocol')
      );

      // Malformed URL
      await assert.rejects(
        () => session.navigate('not-a-valid-url'),
        (err) => err instanceof NavigationError && err.message.includes('Invalid URL')
      );

      // Embedded credentials (user:password@)
      await assert.rejects(
        () => session.navigate('http://user:secretpass@example.com/'),
        (err) => err instanceof NavigationError && err.message.includes('embedded credentials')
      );
    } finally {
      await session.close();
    }
  });

  // 5. Snapshot output includes expected title and interactive element metadata
  it('5. produces structured snapshot with page title and interactive element metadata', async () => {
    const session = await browserRuntime.createSession();
    try {
      await session.navigate(`${baseUrl}/`);
      const snapshot = await session.getSnapshot();

      assert.equal(snapshot.title, 'Super Memory Test Home');
      assert.equal(snapshot.url, `${baseUrl}/`);
      assert(snapshot.text.includes('Welcome to Super Memory'));
      assert(Array.isArray(snapshot.elements));
      assert(snapshot.elements.length > 0);

      const buttonEl = snapshot.elements.find((el) => el.name === 'Click Me');
      assert(buttonEl, 'Must detect Click Me button');
      assert.equal(buttonEl.tag, 'button');
      assert.equal(buttonEl.role, 'button');
    } finally {
      await session.close();
    }
  });

  // 6. Snapshot limits are respected and truncation is indicated
  it('6. respects maxTextLength and maxElements limits with truncation indicators', async () => {
    const session = await browserRuntime.createSession();
    try {
      await session.navigate(`${baseUrl}/`);
      const snapshot = await session.getSnapshot({ maxTextLength: 25, maxElements: 2 });

      assert(snapshot.text.length <= 25, 'Text must be capped at maxTextLength');
      assert.equal(snapshot.isTextTruncated, true, 'isTextTruncated must be true');
      assert.equal(snapshot.elements.length, 2, 'Elements array must be capped at maxElements');
      assert.equal(snapshot.areElementsTruncated, true, 'areElementsTruncated must be true');
    } finally {
      await session.close();
    }
  });

  // 7. A labelled form field can be filled
  it('7. fills an editable input located by accessible label using fillByLabel', async () => {
    const session = await browserRuntime.createSession();
    try {
      await session.navigate(`${baseUrl}/`);

      const fillRes = await session.fillByLabel({
        label: 'Search Workflows',
        value: 'automated browser workflows',
      });
      assert.equal(fillRes.ok, true);
      assert.equal(fillRes.action, 'fillByLabel');

      // Submit form and verify output in page
      await session.clickByRole({ role: 'button', name: 'Run Search' });
      const feedback = await session.page.locator('#feedback').innerText();
      assert.equal(feedback, 'Submitted: automated browser workflows');
    } finally {
      await session.close();
    }
  });

  // 8. A button can be clicked using accessible role and name
  it('8. clicks a button by role and accessible name using clickByRole', async () => {
    const session = await browserRuntime.createSession();
    try {
      await session.navigate(`${baseUrl}/`);

      assert.equal(await session.page.locator('#counter').innerText(), 'Clicks: 0');

      const clickRes = await session.clickByRole({ role: 'button', name: 'Click Me' });
      assert.equal(clickRes.ok, true);
      assert.equal(clickRes.action, 'clickByRole');

      assert.equal(await session.page.locator('#counter').innerText(), 'Clicks: 1');
    } finally {
      await session.close();
    }
  });

  // 9. Invalid locator arguments and missing elements produce useful errors
  it('9. produces sanitized ActionError and TimeoutError on invalid arguments or missing targets', async () => {
    const session = await browserRuntime.createSession();
    try {
      await session.navigate(`${baseUrl}/`);

      // Missing role
      await assert.rejects(
        () => session.clickByRole({ role: '' }),
        (err) => err instanceof ActionError && err.code === 'ACTION_ERROR'
      );

      // Missing label
      await assert.rejects(
        () => session.fillByLabel({ label: '', value: 'test' }),
        (err) => err instanceof ActionError && err.code === 'ACTION_ERROR'
      );

      // Non-existent button timeout
      await assert.rejects(
        () => session.clickByRole({ role: 'button', name: 'Non Existent Button', timeoutMs: 150 }),
        (err) => err instanceof TimeoutError && err.code === 'TIMEOUT_ERROR'
      );
    } finally {
      await session.close();
    }
  });

  // 10. Timeouts and browser shutdown are handled safely
  it('10. handles navigation timeouts and clean shutdown gracefully', async () => {
    const session = await browserRuntime.createSession();
    try {
      await assert.rejects(
        () => session.navigate(`${baseUrl}/slow`, { timeoutMs: 100 }),
        (err) => err instanceof TimeoutError && err.code === 'TIMEOUT_ERROR'
      );
    } finally {
      await session.close();
    }
  });

  // 11. Sensitive input values are not included in snapshots and link queries are stripped
  it('11. excludes password values, input values, and query tokens from snapshots', async () => {
    const session = await browserRuntime.createSession();
    try {
      await session.navigate(`${baseUrl}/`);
      const snapshot = await session.getSnapshot();

      // Password input values must never be captured
      const passwordEl = snapshot.elements.find((el) => el.type === 'password');
      assert.equal(passwordEl, undefined, 'Password inputs must be completely excluded from interactive snapshot');

      // None of the elements should contain a .value field
      for (const el of snapshot.elements) {
        assert.equal(el.value, undefined, 'Element snapshots must never contain a value property');
      }

      // Check anchor tag href: query string auth_token must be stripped
      const aboutLink = snapshot.elements.find((el) => el.tag === 'a' && el.name === 'About Page');
      assert(aboutLink, 'About Page link must be captured');
      assert(aboutLink.href, 'Link must have sanitized href');
      assert(!aboutLink.href.includes('auth_token'), 'Query strings must be stripped from snapshot hrefs');
      assert(!aboutLink.href.includes('super_secret_param'), 'Sensitive query parameters must be stripped');
    } finally {
      await session.close();
    }
  });

  // 12. Multiple browser sessions remain isolated
  it('12. ensures multiple browser sessions have strictly isolated contexts and cookies', async () => {
    const sessionA = await browserRuntime.createSession();
    const sessionB = await browserRuntime.createSession();

    try {
      // Session A sets cookie
      await sessionA.navigate(`${baseUrl}/cookie-set`);
      await sessionA.navigate(`${baseUrl}/cookie-check`);
      const textA = await sessionA.page.locator('body').innerText();
      assert(textA.includes('Has Cookie: true'), 'Session A should retain its own cookie');

      // Session B visits cookie check in fresh isolated context
      await sessionB.navigate(`${baseUrl}/cookie-check`);
      const textB = await sessionB.page.locator('body').innerText();
      assert(textB.includes('Has Cookie: false'), 'Session B must NOT share cookies with Session A');
    } finally {
      await sessionA.close();
      await sessionB.close();
    }
  });

  // 13. Sanitizes page URL in snapshot metadata by stripping query parameters and fragments
  it('13. sanitizes snapshot URL metadata by stripping query parameters and fragments while retaining actual page navigation', async () => {
    const session = await browserRuntime.createSession();
    try {
      const targetUrl = `${baseUrl}/about?auth_token=super_secret_session_token_123&user_id=42#contact-section`;
      const navResult = await session.navigate(targetUrl);

      // Verify browser navigation reached destination with status and title intact
      assert.equal(navResult.status, 200);
      assert.equal(navResult.ok, true);
      assert.equal(navResult.title, 'About Super Memory');

      // Verify actual browser URL retained the full original destination (including query & fragment)
      assert.equal(session.page.url(), targetUrl, 'Browser page URL must retain the full navigated URL');
      assert.equal(navResult.url, targetUrl, 'Navigation result URL must retain the full navigated URL');

      // Take snapshot and verify URL metadata is sanitized to origin and pathname only
      const snapshot = await session.getSnapshot();

      // Must contain origin and pathname only
      assert.equal(snapshot.url, `${baseUrl}/about`);

      // Must not leak query parameters, sensitive tokens, or fragments
      assert(!snapshot.url.includes('?'), 'Snapshot URL must not contain query parameters');
      assert(!snapshot.url.includes('#'), 'Snapshot URL must not contain URL fragments');
      assert(!snapshot.url.includes('auth_token'), 'Snapshot URL must not leak auth_token parameter');
      assert(!snapshot.url.includes('super_secret_session_token_123'), 'Snapshot URL must not leak secret token value');
      assert(!snapshot.url.includes('contact-section'), 'Snapshot URL must not leak fragment identifier');
    } finally {
      await session.close();
    }
  });

  // 14. sanitizeSnapshotUrl utility helper unit test
  it('14. sanitizeSnapshotUrl removes query parameters, fragments, and credentials correctly', () => {
    assert.equal(
      sanitizeSnapshotUrl('http://127.0.0.1:8080/dashboard?token=xyz123#overview'),
      'http://127.0.0.1:8080/dashboard'
    );
    assert.equal(
      sanitizeSnapshotUrl('http://user:pass@127.0.0.1:8080/settings?key=val#hash'),
      'http://127.0.0.1:8080/settings'
    );
    assert.equal(sanitizeSnapshotUrl('about:blank'), 'about:blank');
    assert.equal(sanitizeSnapshotUrl('about:blank?query=1#frag'), 'about:blank');
    assert.equal(sanitizeSnapshotUrl(''), '');
  });
});
