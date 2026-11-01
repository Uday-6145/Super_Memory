import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemWorkflowRepository } from '../../src/workflow/index.js';
import { createAppServer } from '../../src/app/server.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function npm(args) {
  return new Promise((resolve, reject) => {
    execFile('npm', args, { cwd: REPO_ROOT }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`npm ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

describe('App frontend build and smoke (M3.1)', () => {
  let root;
  let home;
  let workflows;
  let lockDir;
  let app;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-app-frontend-'));
    home = path.join(root, 'home');
    workflows = path.join(home, 'workflows');
    lockDir = path.join(root, 'locks');
    await fs.mkdir(workflows, { recursive: true });
  });

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds the production bundle and serves the paired UI end to end', async () => {
    await npm(['run', 'web:build']);

    const indexHtml = await fs.readFile(path.join(REPO_ROOT, 'web', 'dist', 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('<div id="root">'), 'bundle mounts the React root');
    assert.ok(indexHtml.includes('/assets/'), 'bundle references hashed assets');
    const assets = await fs.readdir(path.join(REPO_ROOT, 'web', 'dist', 'assets'));
    assert.ok(assets.some((f) => f.endsWith('.js')), 'a JS bundle is emitted');
    assert.ok(assets.some((f) => f.endsWith('.css')), 'a CSS bundle is emitted');

    const repo = new FileSystemWorkflowRepository({ baseDir: workflows });
    await repo.init();
    await repo.createWorkflow({
      id: 'wf_smoke',
      name: 'Smoke workflow',
      description: 'Visible in the browser UI',
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      inputs: [],
      steps: [{ id: 's1', order: 1, action: 'navigate', description: 'Open', params: { path: '/' } }],
      successCriteria: { finalPath: '/done' },
    });

    app = await createAppServer({ home, workflowsDir: workflows, port: 0, lockDir });

    const page = await fetch(`${app.url}/`);
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-type').includes('text/html'));
    assert.ok((await page.text()).includes('<div id="root">'));

    const pair = await fetch(`${app.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: app.pairingCodeForDisplay() }),
    });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get('set-cookie').split(';')[0];

    const list = await fetch(`${app.url}/api/workflows`, { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    const { workflows: items } = await list.json();
    assert.deepEqual(items.map((w) => w.id), ['wf_smoke']);
  }, { timeout: 120000 });
});
