/**
 * Super Memory — Local Application Server (M3.1)
 *
 * Loopback-only HTTP server exposing the read-only Workflow Query Service
 * to a local React frontend. No framework: built on `node:http`.
 *
 * Security posture:
 * - Binds 127.0.0.1 exclusively; the bind address is not configurable.
 * - Rejects unexpected Host headers (DNS-rebinding defense).
 * - Validates Origin on authentication and state-changing requests.
 * - Pairing + HttpOnly/SameSite=Strict session cookie (see ./auth.js).
 * - Holds the exclusive cross-process repository lock for the server
 *   lifetime; startup fails fast while a CLI operation owns the lock.
 * - API errors are consistent JSON without stack traces, credentials, or
 *   absolute filesystem paths. Unknown errors map to a generic message.
 *
 * The server never imports OperatorCLI. It constructs the query service
 * per request (same freshness discipline as the CLI) and owns no browser
 * or model resources in M3.1 (read-only routes only).
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FileSystemWorkflowRepository,
  WorkflowError,
  WorkflowNotFoundError,
} from '../workflow/index.js';
import { createWorkflowQueryService } from '../services/workflow-query.js';
import { acquireRepositoryLocks } from '../config/repository-lock.js';
import {
  SESSION_COOKIE,
  buildExpiredSessionCookie,
  buildSessionCookie,
  createAuthState,
  isAllowedHost,
  isAllowedOrigin,
  parseCookies,
} from './auth.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let APP_VERSION = '0.0.0';
try {
  const pkg = JSON.parse(await fs.readFile(path.join(APP_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg?.version === 'string') APP_VERSION = pkg.version;
} catch {}

const MAX_BODY_BYTES = 1024 * 1024;
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
]);

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new WorkflowError('Request body too large.');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new WorkflowError('Request body must be valid JSON.');
  }
}

function originOf(header) {
  if (typeof header !== 'string' || header === '') return null;
  try {
    const url = new URL(header);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Creates, locks, and starts the application server.
 *
 * @param {object} [options]
 * @param {string} options.home - Effective managed home directory.
 * @param {string} options.workflowsDir - Effective workflow repository directory.
 * @param {number} [options.port=0] - Port to bind (0 = ephemeral, for tests).
 * @param {string|null} [options.devOrigin] - Explicitly configured Vite dev origin (development only).
 * @param {string} [options.lockDir] - Lock-directory override (tests).
 * @param {string} [options.distDir] - Frontend build directory override (tests).
 * @returns {Promise<object>} Handle `{ url, port, pairingCodeForDisplay, auth, close }`.
 */
export async function createAppServer({
  home,
  workflowsDir,
  port = 0,
  devOrigin = null,
  lockDir,
  distDir,
} = {}) {
  const locks = await acquireRepositoryLocks({
    home,
    workflowsDir,
    displayName: 'super-memory-app',
    lockDir,
  });

  const auth = createAuthState();
  const dist = distDir || path.join(APP_ROOT, 'web', 'dist');

  let distAvailable = false;
  try {
    const indexHtml = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
    distAvailable = indexHtml.length > 0;
  } catch {
    distAvailable = false;
  }

  const queryService = () => createWorkflowQueryService({
    repository: new FileSystemWorkflowRepository({ baseDir: workflowsDir }),
  });

  let actualPort = 0;
  const allowedOriginsFor = () => {
    const origins = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
    if (typeof devOrigin === 'string' && devOrigin.trim() !== '') {
      origins.push(devOrigin.trim().replace(/\/$/, ''));
    }
    return origins;
  };

  function checkOrigin(req) {
    const allowed = allowedOriginsFor();
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
      return isAllowedOrigin(origin, allowed);
    }
    const refererOrigin = originOf(req.headers.referer);
    if (refererOrigin !== null) {
      return isAllowedOrigin(refererOrigin, allowed);
    }
    return true; // Non-browser client (curl/tests): Host check still applies.
  }

  function sessionOf(req) {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;

      if (!isAllowedHost(req.headers.host, actualPort)) {
        sendJson(res, 403, { error: 'Unexpected Host header.' });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { status: 'ok', version: APP_VERSION });
        return;
      }

      if (pathname === '/api/auth/pair' && req.method === 'POST') {
        if (!checkOrigin(req)) {
          sendJson(res, 403, { error: 'Unexpected request origin.' });
          return;
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: err.message });
          return;
        }
        const result = auth.pair(body?.code);
        if (!result.ok) {
          sendJson(res, result.rateLimited ? 429 : 401, { error: result.error });
          return;
        }
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': buildSessionCookie(result.sessionId) });
        return;
      }

      if (pathname === '/api/auth/status' && req.method === 'GET') {
        sendJson(res, 200, { paired: auth.validateSession(sessionOf(req)) });
        return;
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        if (!checkOrigin(req)) {
          sendJson(res, 403, { error: 'Unexpected request origin.' });
          return;
        }
        auth.destroySession(sessionOf(req));
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': buildExpiredSessionCookie() });
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (!auth.validateSession(sessionOf(req))) {
          sendJson(res, 401, { error: 'Authentication required. Pair this browser first.' });
          return;
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed.' });
          return;
        }
        if (!checkOrigin(req)) {
          sendJson(res, 403, { error: 'Unexpected request origin.' });
          return;
        }
        await handleApi(req, res, url, queryService());
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, pathname, dist, distAvailable);
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed.' });
    } catch (err) {
      // Known domain errors below map explicitly; anything else is generic.
      // eslint-disable-next-line no-console
      console.error(`[app] request failed: ${err?.code || err?.name || 'Error'}`);
      sendJson(res, 500, { error: 'Internal server error.' });
    }
  }

  async function handleApi(req, res, url, service) {
    const pathname = url.pathname;
    try {
      if (pathname === '/api/workflows') {
        const enabledOnly = url.searchParams.get('enabledOnly');
        const workflows = await service.listWorkflows({ enabledOnly: enabledOnly === '1' || enabledOnly === 'true' });
        sendJson(res, 200, { workflows });
        return;
      }
      if (pathname === '/api/integrity') {
        const report = await service.scanIntegrity();
        // Omit the absolute repository path: it identifies the server
        // filesystem without helping the UI render the report.
        const { baseDir: _omitted, ...publicReport } = report;
        sendJson(res, 200, { report: publicReport });
        return;
      }
      const reviewMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/review$/);
      if (reviewMatch) {
        const workflowId = decodeURIComponent(reviewMatch[1]);
        if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
          sendJson(res, 400, { error: 'Invalid workflow ID.' });
          return;
        }
        const result = await service.reviewDraft(workflowId, { secrets: [] });
        if (!result) {
          sendJson(res, 200, { workflowId, hasDraft: false });
          return;
        }
        sendJson(res, 200, {
          workflowId,
          hasDraft: true,
          activeVersion: result.activeVersion,
          draftVersion: result.draftVersion,
          diff: result.diff,
        });
        return;
      }
      const inspectMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/);
      if (inspectMatch) {
        const workflowId = decodeURIComponent(inspectMatch[1]);
        if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
          sendJson(res, 400, { error: 'Invalid workflow ID.' });
          return;
        }
        const data = await service.inspectWorkflow(workflowId);
        sendJson(res, 200, { workflowId, ...data });
        return;
      }
      sendJson(res, 404, { error: 'Unknown API route.' });
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      if (err instanceof WorkflowError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      throw err;
    }
  }

  async function serveStatic(req, res, pathname, distRoot, available) {
    if (!available) {
      sendJson(res, 503, { error: 'Frontend is not built yet. Run the web build, then restart the server.' });
      return;
    }
    let relative = decodeURIComponent(pathname);
    if (relative === '/') relative = '/index.html';
    const resolved = path.resolve(distRoot, `.${relative}`);
    if (!resolved.startsWith(`${distRoot}${path.sep}`) && resolved !== distRoot) {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    if (path.basename(resolved).startsWith('.')) {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    let body;
    try {
      body = await fs.readFile(resolved);
    } catch {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    const type = STATIC_TYPES.get(path.extname(resolved).toLowerCase());
    if (!type) {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    if (req.method !== 'HEAD') res.end(body);
    else res.end();
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await locks.release().catch(() => {});
    throw err;
  }
  actualPort = server.address().port;

  let closed = false;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    auth,
    pairingCodeForDisplay: () => auth.pairingCodeForDisplay(),
    async close() {
      if (closed) return;
      closed = true;
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(() => resolve()));
      await locks.release();
    },
  };
}
