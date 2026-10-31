import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import { createBrowserRuntime } from '../../src/browser/index.js';
import {
  createExecutionService,
  playWorkflow,
  trialDraft,
  getStagedEvidencePath,
  loadInputs,
  ensureLocalFixtureIfTargeted,
} from '../../src/services/execution.js';
import {
  getStagedEvidencePath as cliStagedPath,
  loadInputs as cliLoadInputs,
} from '../../src/cli/operator.js';

function fixturePage(title, heading, body) {
  return `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>
  <h1>${heading}</h1>
  <p>${body}</p>
</body>
</html>`;
}

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
      targetOrigin: versionObj.target.origin,
      browserEngine: 'chromium',
      playwrightVersion: '1.64.1',
      nodeVersion: process.version,
      platform: process.platform,
    },
    stepResults: (versionObj.steps || []).map((s) => ({
      stepId: s.id, action: s.action, ok: true, status: 200, durationMs: 10, verification: null,
    })),
    successCriteriaResult: {
      passed: true, finalPath: null, pageTitleMatched: null,
      textPresentFound: null, textAbsentFound: null, details: 'ok',
    },
  };
}

describe('Workflow Execution Service (M2 Phase 3)', () => {
  let root;
  let fixtureServer;
  let baseUrl;
  let sharedRuntime;

  before(async () => {
    fixtureServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/start' || url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fixturePage('Start Page', 'Welcome', 'Apple harvest festival'));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${fixtureServer.address().port}`;
    sharedRuntime = createBrowserRuntime({ headless: true });
  });

  after(async () => {
    if (sharedRuntime) {
      await sharedRuntime.close();
    }
    if (fixtureServer) {
      await new Promise((resolve) => fixtureServer.close(resolve));
    }
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-exec-svc-'));
  });

  afterEach(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  async function makeRepo(dir) {
    const repo = new FileSystemWorkflowRepository({ baseDir: dir });
    await repo.init();
    return repo;
  }

  function navWorkflow(overrides = {}) {
    return {
      target: { origin: baseUrl, startPath: '/start' },
      inputs: [],
      steps: [
        { id: 's1', order: 1, action: 'navigate', description: 'Open start', params: { path: '/start' } },
      ],
      successCriteria: { finalPath: '/start', textPresent: 'Apple harvest festival' },
      ...overrides,
    };
  }

  function makeService(repo, options = {}) {
    return createExecutionService({
      repository: repo,
      browserRuntime: sharedRuntime,
      allowLocalhost: true,
      headless: true,
      fixtureStarter: async () => null,
      ...options,
    });
  }

  it('factory requires a repository and exposes bound methods without terminal I/O', async () => {
    assert.throws(() => createExecutionService({}), /requires a repository/);
    assert.throws(() => createExecutionService(), /requires a repository/);
    const repo = await makeRepo(path.join(root, 'w'));
    const svc = makeService(repo);
    for (const method of ['playWorkflow', 'trialDraft']) {
      assert.equal(typeof svc[method], 'function');
    }
    assert.equal(svc.stdout, undefined);
    assert.equal(svc.stderr, undefined);
    assert.equal(svc.stdin, undefined);
  });

  it('plays back a verified workflow successfully', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({ id: 'wf_play', name: 'Play', description: 'd', ...navWorkflow() });
    const created = await repo.getVersion('wf_play', 1);
    await repo.markVerified('wf_play', 1, sampleEvidence('wf_play', created));

    const svc = makeService(repo);
    const result = await svc.playWorkflow({ workflowId: 'wf_play', inputs: {} });

    assert.equal(result.ok, true);
    assert.equal(result.version, 1);
    assert.ok(result.durationMs >= 0);
  });

  it('reports failed playback without throwing', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({
      id: 'wf_fail', name: 'Fail', description: 'd',
      ...navWorkflow({ successCriteria: { finalPath: '/start', textPresent: 'Text that never appears' } }),
    });
    const created = await repo.getVersion('wf_fail', 1);
    await repo.markVerified('wf_fail', 1, sampleEvidence('wf_fail', created));

    const svc = makeService(repo);
    const result = await svc.playWorkflow({ workflowId: 'wf_fail', inputs: {} });

    assert.equal(result.ok, false);
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  });

  it('trials a draft successfully and stages hash-bound evidence', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const { version } = await repo.createWorkflow({ id: 'wf_trial', name: 'Trial', description: 'd', ...navWorkflow() });

    const svc = makeService(repo);
    const outcome = await svc.trialDraft({ workflowId: 'wf_trial', inputs: {} });

    assert.equal(outcome.success, true);
    assert.equal(outcome.trialResult.candidatePromotionReady, true);
    assert.ok(outcome.evidencePath);

    const stored = JSON.parse(await fs.readFile(outcome.evidencePath, 'utf8'));
    assert.equal(stored.workflowId, 'wf_trial');
    assert.equal(stored.version, version.version);
    assert.equal(stored.contentHash, calculateContentHash(version));

    const manifest = await repo.getManifest('wf_trial');
    assert.equal(manifest.activeVersion, null, 'trial must never promote');
  });

  it('fails a trial cleanly and removes stale staged evidence', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({
      id: 'wf_badtrial', name: 'Bad trial', description: 'd',
      ...navWorkflow({ successCriteria: { finalPath: '/start', textPresent: 'Text that never appears' } }),
    });

    // Plant a stale staged file the failed trial must remove.
    const stagedPath = getStagedEvidencePath(repo.baseDir, 'wf_badtrial', 1);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.writeFile(stagedPath, '{"stale":true}', 'utf8');

    const svc = makeService(repo);
    const outcome = await svc.trialDraft({ workflowId: 'wf_badtrial', inputs: {} });

    assert.equal(outcome.success, false);
    assert.equal(outcome.trialResult.candidatePromotionReady, false);
    assert.equal(outcome.evidencePath, undefined);
    await assert.rejects(() => fs.readFile(stagedPath, 'utf8'), 'stale staged evidence must be removed');
  });

  it('never deletes a caller-owned evidence file on failed trial', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({
      id: 'wf_owned', name: 'Owned', description: 'd',
      ...navWorkflow({ successCriteria: { finalPath: '/start', textPresent: 'Text that never appears' } }),
    });

    const ownedPath = path.join(root, 'my-evidence.json');
    await fs.writeFile(ownedPath, '{"mine":true}', 'utf8');

    const svc = makeService(repo);
    const outcome = await svc.trialDraft({ workflowId: 'wf_owned', inputs: {}, evidenceOut: ownedPath });

    assert.equal(outcome.success, false);
    assert.equal(JSON.parse(await fs.readFile(ownedPath, 'utf8')).mine, true);
  });

  it('reuses an injected shared runtime across calls without closing it', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({ id: 'wf_shared', name: 'Shared', description: 'd', ...navWorkflow() });
    const created = await repo.getVersion('wf_shared', 1);
    await repo.markVerified('wf_shared', 1, sampleEvidence('wf_shared', created));

    const svc = makeService(repo, { browserRuntime: sharedRuntime });
    const first = await svc.playWorkflow({ workflowId: 'wf_shared', inputs: {} });
    const second = await svc.playWorkflow({ workflowId: 'wf_shared', inputs: {} });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true, 'shared runtime must survive service calls');
  });

  it('provisions and closes an owned runtime when none is injected', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({ id: 'wf_owned_rt', name: 'Owned', description: 'd', ...navWorkflow() });
    const created = await repo.getVersion('wf_owned_rt', 1);
    await repo.markVerified('wf_owned_rt', 1, sampleEvidence('wf_owned_rt', created));

    const svc = createExecutionService({
      repository: repo,
      browserRuntime: null,
      allowLocalhost: true,
      headless: true,
      fixtureStarter: async () => null,
    });
    const first = await svc.playWorkflow({ workflowId: 'wf_owned_rt', inputs: {} });
    const second = await svc.playWorkflow({ workflowId: 'wf_owned_rt', inputs: {} });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
  });

  it('validates runtime inputs before launching the browser', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({
      id: 'wf_inputs', name: 'Inputs', description: 'd',
      ...navWorkflow({
        inputs: [{ name: 'fruit', type: 'string', label: 'Fruit', description: 'fruit', required: true }],
      }),
    });

    const svc = makeService(repo);
    await assert.rejects(
      () => svc.trialDraft({ workflowId: 'wf_inputs', inputs: {} }),
      /fruit/
    );
  });

  it('binds parameter-bound success criteria to the supplied runtime value', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({
      id: 'wf_bound', name: 'Bound', description: 'd',
      schemaVersion: '1.1.0',
      ...navWorkflow({
        inputs: [{ name: 'fruit', type: 'string', label: 'Fruit', description: 'fruit', required: true }],
        successCriteria: { finalPath: '/start', textPresent: { input: 'fruit' } },
      }),
    });

    const svc = makeService(repo);
    const matching = await svc.trialDraft({ workflowId: 'wf_bound', inputs: { fruit: 'Apple harvest festival' } });
    assert.equal(matching.success, true);

    const mismatched = await svc.trialDraft({ workflowId: 'wf_bound', inputs: { fruit: 'Orange' } });
    assert.equal(mismatched.success, false);
  });

  it('invokes the injected fixture starter for localhost targets', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({ id: 'wf_fixture', name: 'Fixture', description: 'd', ...navWorkflow() });
    const created = await repo.getVersion('wf_fixture', 1);
    await repo.markVerified('wf_fixture', 1, sampleEvidence('wf_fixture', created));

    const seen = [];
    const svc = makeService(repo, {
      fixtureStarter: async (origin) => { seen.push(origin); return null; },
    });
    const result = await svc.playWorkflow({ workflowId: 'wf_fixture', inputs: {} });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [baseUrl]);

    const denied = makeService(repo, {
      allowLocalhost: false,
      fixtureStarter: async (origin) => { seen.push(origin); return null; },
    });
    // Denied localhost fails closed as a failed run (not a throw) and never
    // reaches fixture startup.
    const blocked = await denied.playWorkflow({ workflowId: 'wf_fixture', inputs: {} });
    assert.equal(blocked.ok, false);
    assert.equal(seen.length, 1);
  });

  it('trial rejects missing workflows, missing drafts, and missing IDs', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const svc = makeService(repo);
    await assert.rejects(() => svc.trialDraft({ workflowId: '' }), /Missing workflow ID for trial command/);
    await assert.rejects(() => svc.trialDraft({ workflowId: 'nope' }), /not found in repository/);
    await repo.createWorkflow({ id: 'wf_nodraft', name: 'N', description: 'd', ...navWorkflow() });
    const created = await repo.getVersion('wf_nodraft', 1);
    await repo.markVerified('wf_nodraft', 1, sampleEvidence('wf_nodraft', created));
    await assert.rejects(() => svc.trialDraft({ workflowId: 'wf_nodraft', inputs: {} }), /no draft version/);
  });

  it('moved CLI helpers remain import-compatible', async () => {
    assert.equal(cliStagedPath, getStagedEvidencePath);
    assert.equal(cliLoadInputs, loadInputs);
    assert.equal(typeof ensureLocalFixtureIfTargeted, 'function');
    assert.equal(await ensureLocalFixtureIfTargeted(null), null);
    assert.deepEqual(await loadInputs(null), {});
  });
});
