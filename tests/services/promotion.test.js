import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import { OperatorCLI } from '../../src/cli/operator.js';
import { getStagedEvidencePath } from '../../src/services/execution.js';
import {
  createPromotionService,
  isExplicitlyConfirmed,
  previewPromotion,
  promote,
} from '../../src/services/promotion.js';

const ALLOWED_AUDIT_KEYS = new Set([
  'timestamp', 'type', 'workflowId', 'version', 'contentHash',
  'source', 'destination', 'imported', 'skipped', 'backupId',
]);
const SECRET = 'promotion-secret-value-abcdef123';

function sampleSteps() {
  return [
    { id: 's1', order: 1, action: 'clickByRole', description: 'Click the button', params: { role: 'button', name: 'Submit Order' } },
  ];
}

function sampleEvidence(workflowId, versionObj, overrides = {}) {
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
      stepId: s.id, action: s.action, ok: true, status: 200, durationMs: 10, verification: null,
    })),
    successCriteriaResult: {
      passed: true, finalPath: '/done', pageTitleMatched: null,
      textPresentFound: null, textAbsentFound: null, details: 'ok',
    },
    ...overrides,
  };
}

describe('Promotion Service (M2 Phase 4)', () => {
  let root;
  let auditEvents;
  let snapshots;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-promo-svc-'));
    auditEvents = [];
    snapshots = 0;
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

  async function makeDraft(repo, id = 'wf_promo') {
    await repo.createWorkflow({
      id,
      name: `Workflow ${id}`,
      description: 'desc',
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      inputs: [],
      steps: sampleSteps(),
      successCriteria: { finalPath: '/' },
    });
    return repo.getVersion(id, 1);
  }

  async function stageEvidence(repo, id, versionObj, evidence) {
    const stagedPath = getStagedEvidencePath(repo.baseDir, id, versionObj.version);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.writeFile(stagedPath, JSON.stringify(evidence ?? sampleEvidence(id, versionObj), null, 2));
    return stagedPath;
  }

  function makeService(repo, { maintenance = null, audit = null } = {}) {
    return createPromotionService({
      repository: repo,
      maintenance: maintenance ?? { snapshotBeforePromotion: async () => { snapshots++; return { backupId: 'snap-test' }; } },
      audit: audit ?? (async (event) => { auditEvents.push(event); }),
    });
  }

  it('factory requires a repository and a maintenance service, without terminal I/O', async () => {
    assert.throws(() => createPromotionService({}), /requires a repository/);
    assert.throws(() => createPromotionService(), /requires a repository/);
    const repo = await makeRepo(path.join(root, 'w'));
    assert.throws(
      () => createPromotionService({ repository: repo }),
      /requires a maintenance service/
    );
    assert.throws(
      () => createPromotionService({ repository: repo, maintenance: {} }),
      /requires a maintenance service/
    );
    const svc = makeService(repo);
    assert.equal(typeof svc.previewPromotion, 'function');
    assert.equal(typeof svc.promote, 'function');
    assert.equal(svc.stdout, undefined);
    assert.equal(svc.stderr, undefined);
    assert.equal(svc.stdin, undefined);
  });

  it('validates explicit authorization exactly', () => {
    assert.equal(isExplicitlyConfirmed(true, 'wf_x'), true);
    assert.equal(isExplicitlyConfirmed('PROMOTE wf_x', 'wf_x'), true);
    assert.equal(isExplicitlyConfirmed('  PROMOTE wf_x  ', 'wf_x'), true);
    assert.equal(isExplicitlyConfirmed(undefined, 'wf_x'), false);
    assert.equal(isExplicitlyConfirmed(null, 'wf_x'), false);
    assert.equal(isExplicitlyConfirmed(false, 'wf_x'), false);
    assert.equal(isExplicitlyConfirmed('PROMOTE wf_other', 'wf_x'), false);
    assert.equal(isExplicitlyConfirmed('promote wf_x', 'wf_x'), false);
    assert.equal(isExplicitlyConfirmed('', 'wf_x'), false);
    assert.equal(isExplicitlyConfirmed(1, 'wf_x'), false);
  });

  it('promotes a draft with valid staged evidence and cleans up', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo);
    const stagedPath = await stageEvidence(repo, 'wf_promo', versionObj);

    const svc = makeService(repo);
    const preview = await svc.previewPromotion({ workflowId: 'wf_promo' });
    assert.equal(preview.draftVersion.version, 1);
    assert.equal(preview.evidence.contentHash, calculateContentHash(versionObj));
    assert.equal(preview.confirmationPhrase, 'PROMOTE wf_promo');
    assert.equal(snapshots, 0, 'preview must have no side effects');

    const result = await svc.promote({ workflowId: 'wf_promo', confirm: 'PROMOTE wf_promo' });
    assert.equal(result.promoted, true);
    assert.equal(result.version.version, 1);
    assert.equal(result.computedHash, calculateContentHash(versionObj));
    assert.equal(snapshots, 1, 'promotion snapshots via the maintenance service');

    const manifest = await repo.getManifest('wf_promo');
    assert.equal(manifest.activeVersion, 1);
    const archived = await repo.getVerificationEvidence('wf_promo', 1);
    assert.equal(archived.runId, result.evidence.runId);

    await assert.rejects(() => fs.readFile(stagedPath, 'utf8'), 'staged evidence must be cleaned up');
    assert.equal(auditEvents.length, 1);
    assert.deepEqual(
      Object.fromEntries(Object.entries(auditEvents[0]).filter(([k]) => k !== 'timestamp')),
      { type: 'promotion', workflowId: 'wf_promo', version: 1, contentHash: result.evidence.contentHash }
    );
  });

  it('promotes with boolean confirmation and a caller-supplied evidence object', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo);
    const evidence = sampleEvidence('wf_promo', versionObj);

    const svc = makeService(repo);
    const result = await svc.promote({ workflowId: 'wf_promo', evidence, confirm: true });
    assert.equal(result.promoted, true);
    assert.equal((await repo.getManifest('wf_promo')).activeVersion, 1);
  });

  it('rejects missing, malformed, and mismatched evidence', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo, 'wf_ev');
    const svc = makeService(repo);

    await assert.rejects(
      () => svc.promote({ workflowId: 'wf_ev', confirm: true }),
      /No trial verification evidence found/
    );
    const stagedPath = getStagedEvidencePath(repo.baseDir, 'wf_ev', 1);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.writeFile(stagedPath, '{oops', 'utf8');
    await assert.rejects(
      () => svc.promote({ workflowId: 'wf_ev', confirm: true }),
      /No trial verification evidence found/
    );

    const wrongFlow = sampleEvidence('wf_other', versionObj);
    await assert.rejects(
      () => svc.promote({ workflowId: 'wf_ev', evidence: wrongFlow, confirm: true }),
      /does not match target workflow/
    );

    const wrongVersion = { ...sampleEvidence('wf_ev', versionObj), version: 999 };
    await assert.rejects(
      () => svc.promote({ workflowId: 'wf_ev', evidence: wrongVersion, confirm: true }),
      /does not match draft version/
    );

    assert.equal((await repo.getManifest('wf_ev')).activeVersion ?? null, null);
    assert.equal(auditEvents.length, 0);
    assert.equal(snapshots, 0);
  });

  it('rejects content-hash mismatch and failed step or criteria results', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo, 'wf_bad');
    const svc = makeService(repo);

    const tampered = { ...sampleEvidence('wf_bad', versionObj), contentHash: '0'.repeat(64) };
    await assert.rejects(() => svc.promote({ workflowId: 'wf_bad', evidence: tampered, confirm: true }), /[Hh]ash|match/);

    const failedStep = sampleEvidence('wf_bad', versionObj, {
      stepResults: [{ stepId: 's1', action: 'clickByRole', ok: false, status: 200, durationMs: 10, verification: null }],
    });
    // The domain binding check rejects failed steps before the service's own
    // step gate; either way promotion is refused.
    await assert.rejects(
      () => svc.promote({ workflowId: 'wf_bad', evidence: failedStep, confirm: true }),
      /failed/
    );

    const failedCriteria = sampleEvidence('wf_bad', versionObj, {
      successCriteriaResult: {
        passed: false, finalPath: null, pageTitleMatched: null,
        textPresentFound: null, textAbsentFound: null, details: 'nope',
      },
    });
    // The domain binding check rejects failed criteria before the service's
    // own criteria gate; either way promotion is refused.
    await assert.rejects(
      () => svc.promote({ workflowId: 'wf_bad', evidence: failedCriteria, confirm: true }),
      /did not pass|success criteria failed/
    );

    assert.equal((await repo.getManifest('wf_bad')).activeVersion ?? null, null);
    assert.equal(snapshots, 0);
  });

  it('refuses promotion without explicit authorization and changes nothing', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo);
    const stagedPath = await stageEvidence(repo, 'wf_promo', versionObj);

    const svc = makeService(repo);
    for (const confirm of [undefined, null, false, 'PROMOTE wf_other', '', 'yes']) {
      const result = await svc.promote({ workflowId: 'wf_promo', confirm });
      assert.deepEqual(result, { promoted: false, reason: 'cancelled' });
    }

    assert.equal((await repo.getManifest('wf_promo')).activeVersion ?? null, null);
    assert.equal(snapshots, 0, 'cancelled promotion must not snapshot');
    assert.equal(auditEvents.length, 0);
    assert.ok(await fs.readFile(stagedPath, 'utf8'), 'staged evidence must be preserved after refusal');
  });

  it('aborts before any change when the pre-promotion snapshot fails', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo);
    const stagedPath = await stageEvidence(repo, 'wf_promo', versionObj);

    const svc = makeService(repo, {
      maintenance: {
        snapshotBeforePromotion: async () => {
          throw new Error('Pre-promotion backup failed; promotion aborted: disk full');
        },
      },
    });
    await assert.rejects(
      () => svc.promote({ workflowId: 'wf_promo', confirm: true }),
      /Pre-promotion backup failed; promotion aborted: disk full/
    );

    assert.equal((await repo.getManifest('wf_promo')).activeVersion ?? null, null);
    assert.equal(auditEvents.length, 0);
    assert.ok(await fs.readFile(stagedPath, 'utf8'), 'staged evidence must survive an aborted promotion');
  });

  it('never deletes caller-owned evidence files while still cleaning internal staging', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo, 'wf_owned');
    const valid = sampleEvidence('wf_owned', versionObj);

    // Caller-owned evidence file plus a stale internal staged file.
    const ownedPath = path.join(root, 'caller-evidence.json');
    await fs.writeFile(ownedPath, JSON.stringify(valid, null, 2));
    const ownedBefore = await fs.readFile(ownedPath, 'utf8');
    const internalPath = getStagedEvidencePath(repo.baseDir, 'wf_owned', versionObj.version);
    await fs.mkdir(path.dirname(internalPath), { recursive: true });
    await fs.writeFile(internalPath, JSON.stringify(valid, null, 2));

    const svc = makeService(repo);
    const result = await svc.promote({ workflowId: 'wf_owned', evidencePath: ownedPath, confirm: true });

    assert.equal(result.promoted, true);
    assert.equal(await fs.readFile(ownedPath, 'utf8'), ownedBefore, 'caller-owned file must be unchanged');
    await assert.rejects(() => fs.readFile(internalPath, 'utf8'), 'internal staged evidence must be removed');
  });

  it('cleans internal staging on success even when evidence is supplied as an object', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo, 'wf_obj');
    const valid = sampleEvidence('wf_obj', versionObj);

    // Stale internal staged content is removed unconditionally on success.
    const internalPath = getStagedEvidencePath(repo.baseDir, 'wf_obj', versionObj.version);
    await fs.mkdir(path.dirname(internalPath), { recursive: true });
    await fs.writeFile(internalPath, '{"stale":true}', 'utf8');

    const svc = makeService(repo);
    const result = await svc.promote({ workflowId: 'wf_obj', evidence: valid, confirm: true });

    assert.equal(result.promoted, true);
    await assert.rejects(() => fs.readFile(internalPath, 'utf8'), 'internal staged evidence must be removed');
  });

  it('failed and cancelled promotions preserve every evidence file', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo, 'wf_keep');
    const valid = sampleEvidence('wf_keep', versionObj);

    const ownedPath = path.join(root, 'caller-evidence.json');
    await fs.writeFile(ownedPath, JSON.stringify({ ...valid, contentHash: 'f'.repeat(64) }));
    const ownedBefore = await fs.readFile(ownedPath, 'utf8');
    const internalPath = getStagedEvidencePath(repo.baseDir, 'wf_keep', versionObj.version);
    await fs.mkdir(path.dirname(internalPath), { recursive: true });
    await fs.writeFile(internalPath, JSON.stringify(valid, null, 2));
    const internalBefore = await fs.readFile(internalPath, 'utf8');

    const svc = makeService(repo);
    await assert.rejects(() => svc.promote({ workflowId: 'wf_keep', evidencePath: ownedPath, confirm: true }));
    assert.equal(await fs.readFile(ownedPath, 'utf8'), ownedBefore);
    assert.equal(await fs.readFile(internalPath, 'utf8'), internalBefore);

    const cancelled = await svc.promote({ workflowId: 'wf_keep', confirm: 'wrong phrase' });
    assert.deepEqual(cancelled, { promoted: false, reason: 'cancelled' });
    assert.equal(await fs.readFile(ownedPath, 'utf8'), ownedBefore, 'cancelled promotion performs no cleanup');
    assert.equal(await fs.readFile(internalPath, 'utf8'), internalBefore);
  });

  it('failed promotion preserves staged evidence for investigation', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo);
    const stagedPath = await stageEvidence(repo, 'wf_promo', versionObj);

    const svc = makeService(repo);
    const tampered = { ...sampleEvidence('wf_promo', versionObj), contentHash: 'f'.repeat(64) };
    await assert.rejects(() => svc.promote({ workflowId: 'wf_promo', evidence: tampered, confirm: true }));
    assert.ok(await fs.readFile(stagedPath, 'utf8'));
    assert.equal(snapshots, 0);
  });

  it('a throwing audit sink never breaks promotion', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo);
    await stageEvidence(repo, 'wf_promo', versionObj);

    const svc = makeService(repo, {
      audit: async () => { throw new Error('audit unavailable'); },
    });
    const result = await svc.promote({ workflowId: 'wf_promo', confirm: true });
    assert.equal(result.promoted, true);
  });

  it('never exposes raw secrets in results or audit events', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    await repo.createWorkflow({
      id: 'wf_secret',
      name: `Name ${SECRET}`,
      description: 'desc',
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      inputs: [],
      steps: [
        { id: 's1', order: 1, action: 'clickByRole', description: `Click ${SECRET}`, params: { role: 'button', name: 'Go' } },
      ],
      successCriteria: { finalPath: '/' },
    });
    const versionObj = await repo.getVersion('wf_secret', 1);
    await stageEvidence(repo, 'wf_secret', versionObj);

    const svc = makeService(repo);
    const preview = await svc.previewPromotion({ workflowId: 'wf_secret' });
    assert.ok(preview.confirmationPhrase.includes('wf_secret'));
    const result = await svc.promote({ workflowId: 'wf_secret', confirm: true });
    assert.equal(result.promoted, true);

    assert.equal(auditEvents.length, 1);
    const serialized = JSON.stringify(auditEvents);
    assert.ok(!serialized.includes(SECRET), 'audit events must not carry raw secrets');
    for (const key of Object.keys(auditEvents[0])) {
      assert.ok(
        ALLOWED_AUDIT_KEYS.has(key),
        `audit field "${key}" must be allow-listed`
      );
    }
  });

  it('stateless functions accept an explicit context', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const versionObj = await makeDraft(repo, 'wf_ctx');
    await stageEvidence(repo, 'wf_ctx', versionObj);
    const context = {
      repository: repo,
      maintenance: { snapshotBeforePromotion: async () => { snapshots++; return null; } },
      audit: async (event) => { auditEvents.push(event); },
    };
    const previewResult = await previewPromotion(context, { workflowId: 'wf_ctx' });
    assert.equal(previewResult.draftVersion.version, 1);
    const result = await promote(context, { workflowId: 'wf_ctx', confirm: 'PROMOTE wf_ctx' });
    assert.equal(result.promoted, true);
  });

  it('CLI promote round-trips through the service with identical behavior', async () => {
    const { PassThrough } = await import('node:stream');
    const stdout = new PassThrough();
    stdout.on('data', () => {});
    const stderr = new PassThrough();
    stderr.on('data', () => {});
    const cli = new OperatorCLI({
      repository: await makeRepo(path.join(root, 'w')),
      io: { stdin: new PassThrough(), stdout, stderr },
    });
    const versionObj = await makeDraft(cli.repo, 'wf_cli');
    await stageEvidence(cli.repo, 'wf_cli', versionObj);

    const cancelled = await cli.promote('wf_cli', { confirm: 'nope' });
    assert.deepEqual(cancelled, { promoted: false, reason: 'cancelled' });
    assert.equal((await cli.repo.getManifest('wf_cli')).activeVersion ?? null, null);

    const done = await cli.promote('wf_cli', { confirm: 'PROMOTE wf_cli' });
    assert.equal(done.promoted, true);
    assert.equal(done.version.version, 1);
    assert.equal((await cli.repo.getManifest('wf_cli')).activeVersion, 1);
  });
});
