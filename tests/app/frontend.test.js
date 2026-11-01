import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
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

describe('App library data contracts (M3.2)', () => {
  let root;
  let home;
  let workflows;
  let lockDir;
  let app;
  let cookie;

  function sampleEvidence(workflowId, versionObj) {
    return {
      $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
      schemaVersion: '1.0.0',
      workflowId,
      version: versionObj.version,
      contentHash: calculateContentHash(versionObj),
      runId: `run_${workflowId}_${versionObj.version}`,
      verifiedAt: new Date().toISOString(),
      environment: {
        targetOrigin: 'http://127.0.0.1:8080',
        browserEngine: 'chromium',
        playwrightVersion: '1.64.1',
        nodeVersion: process.version,
        platform: process.platform,
      },
      stepResults: (versionObj.steps || []).map((s) => ({
        stepId: s.id, action: s.action, ok: true, status: 200, durationMs: 5, verification: null,
      })),
      successCriteriaResult: {
        passed: true, finalPath: '/done', pageTitleMatched: null,
        textPresentFound: null, textAbsentFound: null, details: 'seeded',
      },
    };
  }

  async function authed(pathname) {
    const res = await fetch(`${app.url}${pathname}`, { headers: { Cookie: cookie } });
    return { status: res.status, body: await res.json() };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-app-library-'));
    home = path.join(root, 'home');
    workflows = path.join(home, 'workflows');
    lockDir = path.join(root, 'locks');
    await fs.mkdir(workflows, { recursive: true });

    const repo = new FileSystemWorkflowRepository({ baseDir: workflows });
    await repo.init();

    // Draft-only workflow: never verified. Parameter-bound criteria
    // require schemaVersion 1.1.0.
    await repo.createWorkflow({
      id: 'wf_draft_only',
      name: 'Draft only',
      description: 'Awaiting its first trial',
      target: { origin: 'http://127.0.0.1:8080', startPath: '/shop' },
      inputs: [{ name: 'item', type: 'string', label: 'Item', description: 'What to buy', required: true }],
      steps: [{ id: 's1', order: 1, action: 'navigate', description: 'Open shop', params: { path: '/shop' } }],
      successCriteria: { finalPath: '/done', textPresent: { input: 'item' } },
      schemaVersion: '1.1.0',
    });

    // Verified workflow with no draft.
    await repo.createWorkflow({
      id: 'wf_verified',
      name: 'Verified only',
      description: 'Steady state',
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      inputs: [],
      steps: [{ id: 's1', order: 1, action: 'navigate', description: 'Open', params: { path: '/' } }],
      successCriteria: { finalPath: '/done' },
    });
    await repo.markVerified('wf_verified', 1, sampleEvidence('wf_verified', await repo.getVersion('wf_verified', 1)));

    // Verified workflow with a pending draft on top.
    await repo.createWorkflow({
      id: 'wf_both',
      name: 'Active plus draft',
      description: 'Has a change under review',
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      inputs: [],
      steps: [{ id: 's1', order: 1, action: 'navigate', description: 'Open', params: { path: '/' } }],
      successCriteria: { finalPath: '/done' },
    });
    await repo.markVerified('wf_both', 1, sampleEvidence('wf_both', await repo.getVersion('wf_both', 1)));
    await repo.createDraftVersion('wf_both', {
      changeSummary: 'Try the new landing path',
      steps: [
        { id: 's1', order: 1, action: 'navigate', description: 'Open', params: { path: '/' } },
        { id: 's2', order: 2, action: 'navigate', description: 'Deals', params: { path: '/deals' } },
      ],
    });

    // Corrupt entry: directory without a manifest.
    await fs.mkdir(path.join(workflows, 'wf_broken'), { recursive: true });

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

  it('lists every entry with UI-consumed fields, corrupt included', async () => {
    const { status, body } = await authed('/api/workflows');
    assert.equal(status, 200);
    const ids = body.workflows.map((w) => w.id).sort();
    assert.deepEqual(ids, ['wf_both', 'wf_broken', 'wf_draft_only', 'wf_verified']);
    const broken = body.workflows.find((w) => w.id === 'wf_broken');
    assert.equal(broken.corrupt, true);
    const both = body.workflows.find((w) => w.id === 'wf_both');
    assert.equal(both.name, 'Active plus draft');
    assert.equal(both.enabled, true);
    assert.equal(both.activeVersion, 1);
    assert.equal(both.draftVersion, 2);
  });

  it('inspects draft-only, verified, and combined workflows distinctly', async () => {
    const draftOnly = await authed('/api/workflows/wf_draft_only');
    assert.equal(draftOnly.status, 200);
    assert.equal(draftOnly.body.activeVersion, null);
    assert.equal(draftOnly.body.draftVersion.version, 1);
    assert.equal(draftOnly.body.draftVersion.inputs[0].required, true);
    assert.deepEqual(Object.keys(draftOnly.body.draftVersion.successCriteria).sort(), ['finalPath', 'textPresent']);
    assert.deepEqual(draftOnly.body.draftVersion.successCriteria.textPresent, { input: 'item' });

    const verified = await authed('/api/workflows/wf_verified');
    assert.equal(verified.status, 200);
    assert.equal(verified.body.activeVersion.version, 1);
    assert.equal(verified.body.draftVersion, null);
    assert.ok(verified.body.activeEvidence.runId.includes('wf_verified'));
    assert.ok(typeof verified.body.activeHash === 'string' && verified.body.activeHash.length > 0);

    const both = await authed('/api/workflows/wf_both');
    assert.equal(both.status, 200);
    assert.equal(both.body.activeVersion.version, 1);
    assert.equal(both.body.draftVersion.version, 2);
    assert.equal(both.body.draftVersion.parentVersion, 1);
    assert.equal(both.body.draftVersion.changeSummary, 'Try the new landing path');
    // Steps keep their stored order for the UI to render.
    assert.deepEqual(both.body.draftVersion.steps.map((s) => s.order), [1, 2]);
  });

  it('reviews initial drafts, changed drafts, and draft-less workflows', async () => {
    const initial = await authed('/api/workflows/wf_draft_only/review');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.hasDraft, true);
    assert.equal(initial.body.activeVersion, null);
    assert.ok(initial.body.diff.includes('Initial Draft'));

    const changed = await authed('/api/workflows/wf_both/review');
    assert.equal(changed.status, 200);
    assert.equal(changed.body.hasDraft, true);
    assert.equal(changed.body.activeVersion.version, 1);
    assert.equal(changed.body.draftVersion.version, 2);
    assert.ok(changed.body.diff.includes('Step Changes'));

    const none = await authed('/api/workflows/wf_verified/review');
    assert.equal(none.status, 200);
    assert.equal(none.body.hasDraft, false);
  });

  it('keeps corrupt and invalid IDs safe and secret-free', async () => {
    const broken = await authed('/api/workflows/wf_broken');
    assert.equal(broken.status, 404);
    const brokenText = JSON.stringify(broken.body);
    assert.ok(!brokenText.includes(workflows), 'no absolute paths in errors');
    assert.ok(!('stack' in broken.body));

    const bad = await authed('/api/workflows/..%2Fsecret');
    assert.equal(bad.status, 400);

    const list = await authed('/api/workflows');
    const listText = JSON.stringify(list.body);
    assert.ok(!listText.includes('META_API_KEY'));
  });
});
