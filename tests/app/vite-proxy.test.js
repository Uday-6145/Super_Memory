import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createAppServer } from '../../src/app/server.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

describe('Vite development proxy (M3.1 fix)', () => {
  let root;
  let home;
  let workflows;
  let lockDir;
  let app;
  let vite;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-app-vite-'));
    home = path.join(root, 'home');
    workflows = path.join(home, 'workflows');
    lockDir = path.join(root, 'locks');
    await fs.mkdir(workflows, { recursive: true });
    vite = null;
    app = await createAppServer({ home, workflowsDir: workflows, port: 0, lockDir, devOrigin: 'http://127.0.0.1:5199' });
  });

  afterEach(async () => {
    if (vite) {
      vite.kill('SIGKILL');
      await new Promise((resolve) => vite.on('exit', resolve)).catch(() => {});
      vite = null;
    }
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  async function startVite() {
    vite = spawn(process.execPath, [VITE_BIN, '--config', path.join(REPO_ROOT, 'web', 'vite.config.js'), '--port', '5199', '--strictPort'], {
      cwd: REPO_ROOT,
      env: { ...process.env, SM_APP_BACKEND: app.url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Wait for the dev server to answer (any status).
    for (let i = 0; i < 200; i += 1) {
      try {
        await fetch('http://127.0.0.1:5199/api/health');
        return;
      } catch {
        await sleep(50);
      }
    }
    throw new Error('Vite dev server did not come up');
  }

  it('proxied requests reach the backend with an accepted Host and origin', async () => {
    await startVite();

    // Health through the proxy: proves Host validation passes transparently.
    const health = await fetch('http://127.0.0.1:5199/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    // Pairing through the proxy with the exact development origin proves
    // the browser Origin is preserved end to end (not rewritten).
    const pair = await fetch('http://127.0.0.1:5199/api/auth/pair', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5199',
      },
      body: JSON.stringify({ code: app.pairingCodeForDisplay() }),
    });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get('set-cookie').split(';')[0];

    const list = await fetch('http://127.0.0.1:5199/api/workflows', { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).workflows, []);
  }, { timeout: 120000 });

  it('proxied pairing from a foreign origin is still rejected', async () => {
    await startVite();
    const pair = await fetch('http://127.0.0.1:5199/api/auth/pair', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ code: app.pairingCodeForDisplay() }),
    });
    assert.equal(pair.status, 403);
  }, { timeout: 120000 });
});
