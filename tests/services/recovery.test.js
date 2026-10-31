import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import { createBrowserRuntime } from '../../src/browser/index.js';
import { createExecutionService } from '../../src/services/execution.js';
import {
  createRecoveryService,
  diagnoseFailure,
  proposeRepair,
} from '../../src/services/recovery.js';

const ORIGIN = 'http://127.0.0.1:8080';
const SECRET = 'recovery-service-secret-7f3a9c2e';

function sampleSteps() {
  return [
    {
      id: 's1', order: 1, action: 'clickByRole', description: 'Click the button',
      params: { role: 'button', name: 'Find books' },
    },
  ];
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
      targetOrigin: ORIGIN,
      browserEngine: 'chromium',
      playwrightVersion: '1.64.1',
      nodeVersion: process.version,
      platform: process.platform,
    },
    stepResults: (versionObj.steps || []).map((s) => ({
      stepId: s.id, action: s.action, ok: true, status: 200, durationMs: 10, verification: null,
    })),
    successCriteriaResult: {
      passed: true, finalPath: '/catalog', pageTitleMatched: null,
      textPresentFound: null, textAbsentFound: null, details: 'ok',
    },
  };
}

describe('Recovery Service (M2 Phase 5)', () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-recovery-svc-'));
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

  async function makeActiveWorkflow(repo, id = 'wf_rec', overrides = {}) {
    await repo.createWorkflow({
      id,
      name: `Workflow ${id}`,
      description: 'desc',
      target: { origin: ORIGIN, startPath: '/catalog' },
      inputs: [],
      steps: sampleSteps(),
      successCriteria: { finalPath: '/catalog' },
      ...overrides,
    });
    const preVerify = await repo.getVersion(id, 1);
    await repo.markVerified(id, 1, sampleEvidence(id, preVerify));
    return repo.getVersion(id, 1);
  }

  function makeProposal(workflowId, version, stepId, proposedChange, extra = {}) {
    return {
      workflowId,
      targetVersion: version,
      stepId,
      suspectedCause: 'The button was renamed in the latest site update.',
      evidence: 'Diagnostic shows ELEMENT_NOT_FOUND and the snapshot lists the renamed button.',
      expectedOutcome: 'Clicking the renamed button advances to the expected page.',
      uncertainty: 'None; exact role and name observed.',
      proposedChange,
      ...extra,
    };
  }

  function groundedDiagnostic(workflowId, activeVersion, elementName = 'Search catalog') {
    return {
      workflowId,
      version: activeVersion.version,
      category: 'ELEMENT_NOT_FOUND',
      error: 'waiting for locator failed',
      failedStep: {
        id: 's1', order: 1, action: 'clickByRole', description: 'Click the button',
        expected: { role: 'button', name: 'Find books', exact: false },
        verification: null,
      },
      page: {
        url: `${ORIGIN}/catalog`,
        title: 'Catalog',
        snapshot: {
          url: `${ORIGIN}/catalog`,
          title: 'Catalog',
          text: 'books',
          isTextTruncated: false,
          elements: [
            { tag: 'button', role: 'button', name: elementName, type: 'button', placeholder: null, label: null, href: null, disabled: false },
          ],
          areElementsTruncated: false,
        },
      },
      successCriteriaMismatch: null,
      timestamp: new Date().toISOString(),
    };
  }

  function mockProviderFor(proposal) {
    return {
      complete: async () => ({
        text: JSON.stringify(proposal),
        usage: { totalTokens: 5 },
        provider: 'mock',
        model: 'mock-1',
      }),
    };
  }

  function fakeExecution(runResult, calls = []) {
    return {
      async playWorkflow({ workflowId, inputs }) {
        calls.push({ workflowId, inputs });
        return runResult;
      },
    };
  }

  it('factory requires a repository and an execution service, without terminal I/O', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const execution = fakeExecution({ ok: true });
    assert.throws(() => createRecoveryService({}), /requires a repository/);
    assert.throws(() => createRecoveryService(), /requires a repository/);
    assert.throws(() => createRecoveryService({ repository: repo }), /requires an execution service/);
    assert.throws(
      () => createRecoveryService({ repository: repo, execution: {} }),
      /requires an execution service/
    );
    const svc = createRecoveryService({ repository: repo, execution });
    assert.equal(typeof svc.diagnoseFailure, 'function');
    assert.equal(typeof svc.proposeRepair, 'function');
    assert.equal(svc.stdout, undefined);
    assert.equal(svc.stderr, undefined);
    assert.equal(svc.stdin, undefined);
  });

  it('diagnose returns repairNeeded false without a model call when playback passes', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await makeActiveWorkflow(repo);
    const calls = [];
    const svc = createRecoveryService({ repository: repo, execution: fakeExecution({ ok: true, version: 1 }, calls) });

    const result = await svc.diagnoseFailure({ workflowId: 'wf_rec', inputs: {} });
    assert.deepEqual(result, {
      repairNeeded: false,
      reason: 'active_passed',
      runResult: { ok: true, version: 1 },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { workflowId: 'wf_rec', inputs: {} });
  });

  it('diagnose returns the attached diagnostic on failure without calling any model', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const activeVersion = await makeActiveWorkflow(repo);
    let modelCalls = 0;
    const attached = groundedDiagnostic('wf_rec', activeVersion);
    const svc = createRecoveryService({
      repository: repo,
      execution: fakeExecution({ ok: false, version: 1, failedStepId: 's1', error: 'boom', diagnostic: attached }),
    });

    const result = await svc.diagnoseFailure({
      workflowId: 'wf_rec',
      inputs: {},
      provider: { complete: async () => { modelCalls++; throw new Error('must not be called'); } },
    });
    assert.equal(result.repairNeeded, true);
    assert.equal(result.diagnostic, attached);
    assert.equal(result.activeVersion.version, 1);
    assert.equal(modelCalls, 0);
  });

  it('diagnose falls back to a redacted local diagnostic when none is attached', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await makeActiveWorkflow(repo, 'wf_fb', {
      steps: [{
        id: 's1', order: 1, action: 'clickByRole', description: `Open ${SECRET} vault`,
        params: { role: 'button', name: 'Find books' },
      }],
    });
    const svc = createRecoveryService({
      repository: repo,
      execution: fakeExecution({ ok: false, version: 1, failedStepId: 's1', error: `waiting for ${SECRET} locator` }),
    });

    const result = await svc.diagnoseFailure({ workflowId: 'wf_fb', inputs: {}, secrets: [SECRET] });
    assert.equal(result.repairNeeded, true);
    assert.equal(result.diagnostic.category, 'ELEMENT_NOT_FOUND');
    const serialized = JSON.stringify(result.diagnostic);
    assert.ok(!serialized.includes(SECRET), 'fallback diagnostic must redact supplied secrets');
    assert.ok(serialized.includes('[REDACTED]'));
  });

  it('proposeRepair creates a draft from a grounded proposal and preserves the rest', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const activeVersion = await makeActiveWorkflow(repo, 'wf_fix', {
      schemaVersion: '1.1.0',
      inputs: [{ name: 'book_title', type: 'string', label: 'Book title', description: 'd', required: true }],
      successCriteria: { finalPath: '/basket', textPresent: { input: 'book_title' } },
      target: { origin: ORIGIN, startPath: '/catalog' },
    });
    const before = JSON.parse(JSON.stringify(activeVersion));
    const attached = groundedDiagnostic('wf_fix', activeVersion);
    const proposal = makeProposal('wf_fix', 1, 's1', {
      action: 'clickByRole', params: { role: 'button', name: 'Search catalog' },
    });
    const svc = createRecoveryService({
      repository: repo,
      execution: fakeExecution({ ok: false, version: 1, failedStepId: 's1', error: 'waiting', diagnostic: attached }),
    });

    const outcome = await svc.proposeRepair({
      workflowId: 'wf_fix',
      inputs: { book_title: 'Dune' },
      provider: mockProviderFor(proposal),
    });

    assert.equal(outcome.repaired, true);
    assert.equal(outcome.draft.version, 2);
    assert.equal(outcome.proposal.proposedChange.params.name, 'Search catalog');

    const manifest = await repo.getManifest('wf_fix');
    assert.equal(manifest.activeVersion, 1);
    assert.equal(manifest.draftVersion, 2);
    const current = await repo.getVersion('wf_fix', 1);
    assert.deepEqual(current, before, 'active version must be untouched');
    assert.deepEqual(outcome.draft.inputs, before.inputs);
    assert.deepEqual(outcome.draft.target, before.target);
    assert.deepEqual(outcome.draft.successCriteria, before.successCriteria);
    assert.equal(outcome.draft.steps[0].params.name, 'Search catalog');
  });

  it('rejects invalid, smuggled, password-anchored, and origin-changing proposals', async () => {
    const cases = [
      ['bad action', { action: 'runScript', params: {} }, /Unsupported action/],
      ['smuggled value', { action: 'fillByLabel', params: { label: 'Book title', inputName: 'book_title', value: 'x' } }, /must not contain a "value"/],
      ['password anchor', { action: 'clickByRole', params: { role: 'button', name: 'Search catalog' }, anchor: { type: 'password' } }, /password/],
      ['origin change', { action: 'navigate', params: { path: '/other' }, target: { origin: 'http://evil.example' } }, /cannot modify the workflow target origin/],
    ];
    for (const [label, proposedChange, pattern] of cases) {
      const repo = await makeRepo(path.join(root, `w-${label.replace(/\s/g, '-')}`));
      const activeVersion = await makeActiveWorkflow(repo, 'wf_bad', {
        inputs: [{ name: 'book_title', type: 'string', label: 'Book title', description: 'd', required: false }],
      });
      const svc = createRecoveryService({
        repository: repo,
        execution: fakeExecution({ ok: false, version: 1, failedStepId: 's1', error: 'waiting', diagnostic: groundedDiagnostic('wf_bad', activeVersion) }),
      });
      const proposal = makeProposal('wf_bad', 1, 's1', proposedChange);
      await assert.rejects(
        () => svc.proposeRepair({ workflowId: 'wf_bad', inputs: {}, provider: mockProviderFor(proposal) }),
        pattern,
        label
      );
      assert.equal((await repo.getManifest('wf_bad')).draftVersion ?? null, null, `${label}: no draft may exist`);
    }
  });

  it('rejects ungrounded proposals and creates no draft', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const activeVersion = await makeActiveWorkflow(repo);
    const svc = createRecoveryService({
      repository: repo,
      execution: fakeExecution({ ok: false, version: 1, failedStepId: 's1', error: 'waiting', diagnostic: groundedDiagnostic('wf_rec', activeVersion) }),
    });
    const proposal = makeProposal('wf_rec', 1, 's1', {
      action: 'clickByRole', params: { role: 'button', name: 'Ghost Button' },
    });
    await assert.rejects(
      () => svc.proposeRepair({ workflowId: 'wf_rec', inputs: {}, provider: mockProviderFor(proposal) }),
      /was not observed/
    );
    assert.equal((await repo.getManifest('wf_rec')).draftVersion ?? null, null);
  });

  it('preserves missing-workflow, missing-active, and invalid-input behavior', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const calls = [];
    const svc = createRecoveryService({ repository: repo, execution: fakeExecution({ ok: false }, calls) });

    await assert.rejects(() => svc.diagnoseFailure({ workflowId: '' }), /Missing workflow ID for repair command/);
    await assert.rejects(() => svc.diagnoseFailure({ workflowId: 'nope', inputs: {} }), /not found/);
    assert.equal(calls.length, 0, 'no playback for unknown workflows');

    await repo.createWorkflow({
      id: 'wf_draftonly', name: 'Draft only', description: 'd',
      target: { origin: ORIGIN, startPath: '/' }, inputs: [], steps: sampleSteps(),
      successCriteria: { finalPath: '/' },
    });
    await assert.rejects(
      () => svc.diagnoseFailure({ workflowId: 'wf_draftonly', inputs: {} }),
      /has no active verified version/
    );
    assert.equal(calls.length, 0, 'no playback without an active version');
  });

  it('propagates player input validation without model calls or drafts', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await makeActiveWorkflow(repo, 'wf_req', {
      inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', description: 'd', required: true }],
    });
    let modelCalls = 0;
    const execution = createExecutionService({
      repository: repo,
      browserRuntime: null,
      allowLocalhost: true,
      headless: true,
      fixtureStarter: async () => null,
    });
    const svc = createRecoveryService({ repository: repo, execution });
    await assert.rejects(
      () => svc.proposeRepair({
        workflowId: 'wf_req',
        inputs: {},
        provider: { complete: async () => { modelCalls++; throw new Error('must not be called'); } },
      }),
      /coupon/
    );
    assert.equal(modelCalls, 0);
    assert.equal((await repo.getManifest('wf_req')).draftVersion ?? null, null);
  });

  it('keeps secrets out of persisted draft summaries', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const activeVersion = await makeActiveWorkflow(repo, 'wf_sec');
    // Attached diagnostic (already sanitized upstream, as the player does);
    // the secret reaches the draft only through the model's summary text.
    const svc = createRecoveryService({
      repository: repo,
      execution: fakeExecution({ ok: false, version: 1, failedStepId: 's1', error: 'waiting for locator', diagnostic: groundedDiagnostic('wf_sec', activeVersion) }),
    });
    const proposal = makeProposal('wf_sec', 1, 's1', {
      action: 'clickByRole', params: { role: 'button', name: 'Search catalog' },
    });
    proposal.suspectedCause = `The ${SECRET} control moved.`;

    const outcome = await svc.proposeRepair({
      workflowId: 'wf_sec', inputs: {}, provider: mockProviderFor(proposal), secrets: [SECRET],
    });
    assert.equal(outcome.repaired, true);
    assert.ok(!JSON.stringify(outcome.draft).includes(SECRET), 'persisted draft content must not carry raw secrets');
    assert.ok(outcome.draft.changeSummary.includes('[REDACTED]'));
    assert.equal(outcome.secrets, undefined);
    // The model's own proposal object passes through untouched (as in the
    // CLI); display layers redact it. The service never logs or persists it.
    const stored = await repo.getVersion('wf_sec', 2);
    assert.ok(!JSON.stringify(stored).includes(SECRET));
  });

  it('delegates playback through the injected execution service exactly once', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await makeActiveWorkflow(repo);
    const calls = [];
    const svc = createRecoveryService({
      repository: repo,
      execution: fakeExecution({ ok: true, version: 1 }, calls),
    });
    await svc.proposeRepair({ workflowId: 'wf_rec', inputs: { a: 'b' }, provider: mockProviderFor(makeProposal('wf_rec', 1, 's1', { action: 'navigate', params: { path: '/' } })) });
    assert.deepEqual(calls, [{ workflowId: 'wf_rec', inputs: { a: 'b' } }]);
  });

  it('creates no trial evidence and never promotes', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const activeVersion = await makeActiveWorkflow(repo);
    const svc = createRecoveryService({
      repository: repo,
      execution: fakeExecution({ ok: false, version: 1, failedStepId: 's1', error: 'waiting', diagnostic: groundedDiagnostic('wf_rec', activeVersion) }),
    });
    const proposal = makeProposal('wf_rec', 1, 's1', {
      action: 'clickByRole', params: { role: 'button', name: 'Search catalog' },
    });
    const outcome = await svc.proposeRepair({ workflowId: 'wf_rec', inputs: {}, provider: mockProviderFor(proposal) });
    assert.equal(outcome.repaired, true);

    const manifest = await repo.getManifest('wf_rec');
    assert.equal(manifest.activeVersion, 1);
    assert.equal(manifest.draftVersion, 2);
    assert.equal(await repo.getVerificationEvidence('wf_rec', 2).catch(() => null), null);
    const staging = path.join(repo.baseDir, '.staging');
    const entries = await fs.readdir(staging).catch(() => []);
    assert.deepEqual(entries, [], 'no staged evidence may be produced by recovery');
  });

  it('stateless functions accept an explicit context', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await makeActiveWorkflow(repo);
    const context = {
      repository: repo,
      execution: fakeExecution({ ok: true, version: 1 }),
    };
    const result = await diagnoseFailure(context, { workflowId: 'wf_rec', inputs: {} });
    assert.equal(result.repairNeeded, false);
    const second = await proposeRepair(context, { workflowId: 'wf_rec', inputs: {}, provider: null });
    assert.deepEqual(second, { repaired: false, reason: 'active_passed', runResult: { ok: true, version: 1 } });
  });

  describe('Recovery-to-Execution integration (real browser)', () => {
    let fixtureServer;
    let baseUrl;
    let sharedRuntime;

    before(async () => {
      fixtureServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Go</title></head><body><h1>Go Page</h1></body></html>');
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

    async function makeNavWorkflow(repo, id, textPresent) {
      await repo.createWorkflow({
        id,
        name: id,
        description: 'd',
        target: { origin: baseUrl, startPath: '/go' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'navigate', description: 'Go', params: { path: '/go' } }],
        successCriteria: { finalPath: '/go', textPresent },
      });
      const versionObj = await repo.getVersion(id, 1);
      await repo.markVerified(id, 1, sampleEvidence(id, { ...versionObj, target: { origin: baseUrl, startPath: '/go' } }));
    }

    it('diagnoses a genuinely failing workflow through the real execution service', async () => {
      const repo = await makeRepo(path.join(root, 'w-int-fail'));
      await makeNavWorkflow(repo, 'wf_int_fail', 'Text that never appears');
      const execution = createExecutionService({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        headless: true,
        fixtureStarter: async () => null,
      });
      const svc = createRecoveryService({ repository: repo, execution });
      const result = await svc.diagnoseFailure({ workflowId: 'wf_int_fail', inputs: {} });
      assert.equal(result.repairNeeded, true);
      assert.equal(result.runResult.ok, false);
      assert.ok(result.diagnostic && typeof result.diagnostic.category === 'string');
    });

    it('returns repairNeeded false for a genuinely passing workflow', async () => {
      const repo = await makeRepo(path.join(root, 'w-int-pass'));
      await makeNavWorkflow(repo, 'wf_int_pass', 'Go Page');
      const execution = createExecutionService({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        headless: true,
        fixtureStarter: async () => null,
      });
      const svc = createRecoveryService({ repository: repo, execution });
      const result = await svc.diagnoseFailure({ workflowId: 'wf_int_pass', inputs: {} });
      assert.equal(result.repairNeeded, false);
      assert.equal(result.reason, 'active_passed');
    });
  });
});
