import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createAppServer } from '../../src/app/server.js';
import { acquireRepositoryLocks } from '../../src/config/repository-lock.js';

describe('App server (M3.1)', () => {
  let root;
  let home;
  let workflows;
  let lockDir;
  let app;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-app-server-'));
    home = path.join(root, 'home');
    workflows = path.join(home, 'workflows');
    lockDir = path.join(root, 'locks');
    await fs.mkdir(workflows, { recursive: true });
    app = null;
  });

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  async function start(extra = {}) {
    app = await createAppServer({ home, workflowsDir: workflows, port: 0, lockDir, ...extra });
    return app;
  }

  function rawRequest(options, body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it('binds loopback only and serves a minimal health payload', async () => {
    const server = await start();
    assert.ok(server.url.startsWith('http://127.0.0.1:'));
    const res = await fetch(`${server.url}/api/health`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.deepEqual(Object.keys(payload).sort(), ['status', 'version']);
    assert.equal(payload.status, 'ok');
    assert.ok(!JSON.stringify(payload).includes(root));
  });

  it('rejects unexpected Host headers', async () => {
    const server = await start();
    const res = await rawRequest({
      host: '127.0.0.1',
      port: server.port,
      path: '/api/health',
      method: 'GET',
      headers: { Host: 'evil.example' },
    });
    assert.equal(res.status, 403);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const server = await start();
    const pair = await fetch(`${server.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: server.pairingCodeForDisplay() }),
    });
    const cookie = pair.headers.get('set-cookie').split(';')[0];
    const res = await fetch(`${server.url}/api/nope`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.ok(typeof payload.error === 'string');
    assert.ok(!('stack' in payload));
  });

  it('unauthenticated API calls fail without leaking internals', async () => {
    const server = await start();
    for (const route of ['/api/workflows', '/api/workflows/x', '/api/workflows/x/review', '/api/integrity']) {
      const res = await fetch(`${server.url}${route}`);
      assert.equal(res.status, 401, route);
      const payload = await res.json();
      assert.ok(payload.error.includes('Pair'));
    }
  });

  it('pairing requires the code and sets a safe session cookie', async () => {
    const server = await start();
    const bad = await fetch(`${server.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'AAAA-AAAA-AAAA' }),
    });
    assert.equal(bad.status, 401);

    const code = server.pairingCodeForDisplay();
    assert.ok(code);
    const good = await fetch(`${server.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    assert.equal(good.status, 200);
    const setCookie = good.headers.get('set-cookie') || '';
    assert.ok(setCookie.startsWith('sm_session='), setCookie);
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Strict'));
    const body = await good.text();
    assert.ok(!body.includes(setCookie.split(';')[0].split('=')[1]), 'session id must not appear in JSON');
    return setCookie.split(';')[0];
  });

  it('authenticated calls succeed; logout and restart invalidate sessions', async () => {
    const server = await start();
    const pair = await fetch(`${server.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: server.pairingCodeForDisplay() }),
    });
    const cookie = pair.headers.get('set-cookie').split(';')[0];

    const authed = await fetch(`${server.url}/api/workflows`, { headers: { Cookie: cookie } });
    assert.equal(authed.status, 200);

    const status = await fetch(`${server.url}/api/auth/status`, { headers: { Cookie: cookie } });
    assert.deepEqual(await status.json(), { paired: true });
    const anon = await fetch(`${server.url}/api/auth/status`);
    assert.deepEqual(await anon.json(), { paired: false });

    const logout = await fetch(`${server.url}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logout.status, 200);
    const after = await fetch(`${server.url}/api/workflows`, { headers: { Cookie: cookie } });
    assert.equal(after.status, 401);

    // Restart invalidates every session issued by the previous process.
    await app.close();
    app = null;
    const server2 = await start();
    const stale = await fetch(`${server2.url}/api/workflows`, { headers: { Cookie: cookie } });
    assert.equal(stale.status, 401);
    assert.ok(server2.pairingCodeForDisplay(), 'a fresh pairing code exists after restart');
  });

  it('rejects pairing from unexpected origins', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ code: server.pairingCodeForDisplay() }),
    });
    assert.equal(res.status, 403);
    assert.ok(server.pairingCodeForDisplay(), 'code is not consumed by rejected origins');
  });

  it('fails to start while another process owns the lock', async () => {
    const holder = await acquireRepositoryLocks({
      home,
      workflowsDir: workflows,
      displayName: 'super-memory-cli',
      lockDir,
    });
    try {
      await assert.rejects(() => createAppServer({ home, workflowsDir: workflows, port: 0, lockDir }), /locked by another/);
    } finally {
      await holder.release();
    }
    await start();
  });

  it('blocks a second server on the same resources and releases on close', async () => {
    await start();
    await assert.rejects(
      () => createAppServer({ home, workflowsDir: workflows, port: 0, lockDir }),
      /locked by another/
    );
    await app.close();
    app = null;
    // After shutdown the locks are free and the lock dir is clean.
    await start();
  });

  it('startup failure on an occupied port releases the locks', async () => {
    // Occupy the port with an unrelated server so the app fails at listen,
    // after it has already acquired the repository locks.
    const squatter = http.createServer((req, res) => res.end('busy'));
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const fixedPort = squatter.address().port;
    try {
      await assert.rejects(
        () => createAppServer({ home, workflowsDir: workflows, port: fixedPort, lockDir }),
        /EADDRINUSE/
      );
      assert.deepEqual(await fs.readdir(lockDir).catch(() => []), [], 'locks released after listen failure');
      // The port occupant is unrelated: the repository is free to lock again.
      await start({ port: 0 });
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('does not depend on OperatorCLI', async () => {
    for (const file of ['server.js', 'auth.js']) {
      const source = await fs.readFile(path.join(import.meta.dirname, '..', '..', 'src', 'app', file), 'utf8');
      assert.ok(!source.includes('cli/operator'), `${file} must not import OperatorCLI`);
    }
  });
});
