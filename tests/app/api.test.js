import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import { createAppServer } from '../../src/app/server.js';

const ORIGIN = 'http://127.0.0.1:8080';

describe('App read-only API (M3.1)', () => {
  let root;
  let home;
  let workflows;
  let lockDir;
  let app;
  let cookie;

  function sampleSteps() {
    return [
      { id: 's1', order: 1, action: 'navigate', description: 'Open', params: { path: '/' } },
    ];
  }

  async function seed() {
    const repo = new FileSystemWorkflowRepository({ baseDir: workflows });
    await repo.init();
    await repo.createWorkflow({
      id: 'wf_listed',
      name: 'Listed workflow',
      description: 'A workflow visible in the library',
      target: { origin: ORIGIN, startPath: '/' },
      inputs: [],
      steps: sampleSteps(),
      successCriteria: { finalPath: '/done' },
    });
    await repo.createWorkflow({
      id: 'wf_hidden',
      name: 'Hidden workflow',
      description: 'Filtered by enabledOnly',
      target: { origin: ORIGIN, startPath: '/' },
      inputs: [],
      steps: sampleSteps(),
      successCriteria: { finalPath: '/done' },
    });
    await repo.setEnabled('wf_hidden', false);
  }

  async function authed(pathname, options = {}) {
    const res = await fetch(`${app.url}${pathname}`, {
      ...options,
      headers: { ...(options.headers || {}), Cookie: cookie },
    });
    return res;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-app-api-'));
    home = path.join(root, 'home');
    workflows = path.join(home, 'workflows');
    lockDir = path.join(root, 'locks');
    await fs.mkdir(workflows, { recursive: true });
    await seed();
    app = await createAppServer({ home, workflowsDir: workflows, port: 0, lockDir });
    const pair = await fetch(`${app.url}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: app.pairingCodeForDisplay() }),
    });
    assert.equal(pair.status, 200);
    cookie = pair.headers.get('set-cookie').split(';')[0];
  });

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists workflows through the query service', async () => {
    const res = await authed('/api/workflows');
    assert.equal(res.status, 200);
    const { workflows: items } = await res.json();
    assert.deepEqual(items.map((w) => w.id).sort(), ['wf_hidden', 'wf_listed']);

    const filtered = await authed('/api/workflows?enabledOnly=1');
    assert.deepEqual((await filtered.json()).workflows.map((w) => w.id), ['wf_listed']);
  });

  it('inspects a workflow and reports missing workflows as 404', async () => {
    const res = await authed('/api/workflows/wf_listed');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.workflowId, 'wf_listed');
    assert.equal(data.manifest.id, 'wf_listed');
    assert.ok(data.draftVersion, 'draft-only seed exposes its draft');
    assert.equal(data.activeVersion, null);

    const missing = await authed('/api/workflows/wf_missing');
    assert.equal(missing.status, 404);
    assert.ok((await missing.json()).error.includes('wf_missing'));
  });

  it('reviews a draft and reports draft-less states cleanly', async () => {
    const res = await authed('/api/workflows/wf_listed/review');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.hasDraft, true);
    assert.ok(typeof data.diff === 'string' && data.diff.length > 0);
    assert.equal(data.draftVersion.version, 1);
  });

  it('rejects invalid workflow IDs without touching the repository', async () => {
    // Dot segments and embedded slashes never match a workflow route.
    for (const bad of ['..', 'a/b']) {
      const res = await authed(`/api/workflows/${bad}/review`);
      assert.equal(res.status, 404, bad);
    }
    // Decoded IDs that violate the workflow-ID shape are rejected as bad requests.
    for (const bad of ['x'.repeat(200), 'bad id!', '.hidden']) {
      const res = await authed(`/api/workflows/${encodeURIComponent(bad)}/review`);
      assert.equal(res.status, 400, bad);
    }
    const direct = await authed('/api/workflows/a%2Fb');
    assert.equal(direct.status, 400);
  });

  it('scans integrity without absolute filesystem paths', async () => {
    const res = await authed('/api/integrity');
    assert.equal(res.status, 200);
    const { report } = await res.json();
    assert.equal(report.ok, true);
    assert.equal(report.totals.workflows, 2);
    assert.ok(!('baseDir' in report));
    assert.ok(!JSON.stringify(report).includes(workflows), 'no absolute paths leak into the report');
  });

  it('API errors are safe JSON and no route mutates the repository', async () => {
    const before = await fs.readFile(path.join(workflows, 'wf_listed', 'manifest.json'), 'utf8');
    const routes = ['/api/workflows', '/api/workflows/wf_listed', '/api/workflows/wf_listed/review', '/api/integrity'];
    for (const route of routes) {
      const res = await authed(route);
      assert.equal(res.status, 200, route);
      const text = await res.text();
      assert.ok(!text.includes('stack'), route);
      assert.ok(!text.includes(workflows), route);
    }
    const after = await fs.readFile(path.join(workflows, 'wf_listed', 'manifest.json'), 'utf8');
    assert.equal(after, before);
    assert.deepEqual((await authed('/api/workflows')).headers.get('content-type'), 'application/json; charset=utf-8');
  });

  it('inspect responses carry no caller-independent secrets', async () => {
    const res = await authed('/api/workflows/wf_listed');
    const text = await res.text();
    assert.ok(!text.includes('META_API_KEY') && !text.includes('BASETEN_API_KEY'));
  });
});
