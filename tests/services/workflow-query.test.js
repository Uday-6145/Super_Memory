import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSystemWorkflowRepository } from '../../src/workflow/repository.js';
import { calculateContentHash } from '../../src/workflow/index.js';
import {
  createWorkflowQueryService,
  inspectWorkflow,
  listWorkflows,
  reviewDraft,
  scanIntegrity,
} from '../../src/services/workflow-query.js';
import { renderDiff as cliRenderDiff } from '../../src/cli/operator.js';
import { renderDiff as serviceRenderDiff } from '../../src/services/workflow-query.js';

const ORIGIN = 'http://127.0.0.1:8080';
const SECRET = 'svc-secret-value-abc123';

describe('Workflow Query Service (M2 Phase 1)', () => {
  let tempBaseDir;
  let repo;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-query-svc-'));
    repo = new FileSystemWorkflowRepository({ baseDir: tempBaseDir });
    await repo.init();
  });

  afterEach(async () => {
    if (tempBaseDir) {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  async function createVerifiedWorkflow({
    id,
    name = 'Service Workflow',
    target = { origin: ORIGIN, startPath: '/' },
    inputs = [],
    steps = [
      { id: 's1', order: 1, action: 'clickByRole', description: 'Click link', params: { role: 'link', name: 'Go' } },
    ],
    successCriteria = { finalPath: '/done' },
  }) {
    const { version } = await repo.createWorkflow({ id, name, description: `${name} description`, target, inputs, steps, successCriteria });
    const contentHash = calculateContentHash(version);
    const evidence = {
      $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
      schemaVersion: '1.0.0',
      workflowId: id,
      version: 1,
      contentHash,
      runId: `run_${id}_1`,
      verifiedAt: new Date().toISOString(),
      environment: {
        targetOrigin: target.origin,
        browserEngine: 'chromium',
        playwrightVersion: '1.64.1',
        nodeVersion: process.version,
        platform: process.platform,
      },
      stepResults: steps.map((s) => ({ stepId: s.id, action: s.action, ok: true, status: 200, durationMs: 10, verification: null })),
      successCriteriaResult: { passed: true, finalPath: successCriteria.finalPath || null, pageTitleMatched: null, textPresentFound: null, textAbsentFound: null, details: 'ok' },
    };
    await repo.markVerified(id, 1, evidence);
    return { version, evidence };
  }

  it('factory requires a repository and exposes bound methods without terminal I/O', async () => {
    assert.throws(() => createWorkflowQueryService({}), /requires a repository/);
    assert.throws(() => createWorkflowQueryService(), /requires a repository/);
    const svc = createWorkflowQueryService({ repository: repo });
    assert.equal(svc.repository, repo);
    assert.equal(typeof svc.listWorkflows, 'function');
    assert.equal(typeof svc.inspectWorkflow, 'function');
    assert.equal(typeof svc.reviewDraft, 'function');
    assert.equal(typeof svc.scanIntegrity, 'function');
    assert.equal(svc.stdout, undefined);
    assert.equal(svc.stderr, undefined);
    assert.equal(svc.stdin, undefined);
  });

  it('lists workflows and respects the enabledOnly filter', async () => {
    await createVerifiedWorkflow({ id: 'wf_on' });
    await createVerifiedWorkflow({ id: 'wf_off' });
    await repo.setEnabled('wf_off', false);

    const all = await listWorkflows(repo, {});
    assert.equal(all.length, 2);

    const enabled = await listWorkflows(repo, { enabledOnly: true });
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].id, 'wf_on');

    const svc = createWorkflowQueryService({ repository: repo });
    assert.deepEqual(await svc.listWorkflows({ enabledOnly: true }), enabled);
  });

  it('lists an empty repository without throwing', async () => {
    assert.deepEqual(await listWorkflows(repo, {}), []);
  });

  it('inspects an existing workflow with active version, hashes, and evidence', async () => {
    await createVerifiedWorkflow({ id: 'wf_inspect' });
    await repo.createDraftVersion('wf_inspect', {
      changeSummary: 'Tweak a label',
      steps: [
        { id: 's1', order: 1, action: 'clickByRole', description: 'Click link', params: { role: 'link', name: 'Go now' } },
      ],
    });

    const data = await inspectWorkflow(repo, 'wf_inspect');
    assert.equal(data.manifest.id, 'wf_inspect');
    assert.equal(data.activeVersion.version, 1);
    assert.equal(data.draftVersion.version, 2);
    assert.ok(typeof data.activeHash === 'string' && data.activeHash.length > 0);
    assert.ok(typeof data.draftHash === 'string' && data.draftHash.length > 0);
    assert.equal(data.activeEvidence.workflowId, 'wf_inspect');
    assert.equal(data.referenceVersion.version, 1);
    assert.equal(data.secrets, undefined);
  });

  it('inspects a draft-only workflow without an active version', async () => {
    await repo.createWorkflow({
      id: 'wf_draft_only',
      name: 'Draft Only',
      description: 'draft',
      target: { origin: ORIGIN, startPath: '/' },
      inputs: [],
      steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'x', params: { role: 'link', name: 'Go' } }],
      successCriteria: { finalPath: '/' },
    });
    const data = await inspectWorkflow(repo, 'wf_draft_only');
    assert.equal(data.activeVersion, null);
    assert.equal(data.activeHash, null);
    assert.equal(data.activeEvidence, null);
    assert.equal(data.draftVersion.version, 1);
    assert.equal(data.referenceVersion.version, 1);
  });

  it('inspect rejects missing workflow IDs with the CLI-compatible error', async () => {
    await assert.rejects(() => inspectWorkflow(repo, ''), /Missing workflow ID for inspect command/);
    await assert.rejects(() => inspectWorkflow(repo, 'nope'), /Workflow "nope" not found in repository/);
  });

  it('review returns a redacted diff identical to the CLI renderer', async () => {
    await createVerifiedWorkflow({
      id: 'wf_review',
      steps: [{ id: 's1', order: 1, action: 'clickByRole', description: `Open ${SECRET}`, params: { role: 'button', name: 'Submit' } }],
      successCriteria: { finalPath: '/done' },
    });
    await repo.createDraftVersion('wf_review', {
      changeSummary: `Fix ${SECRET} handling`,
      steps: [{ id: 's1', order: 1, action: 'clickByRole', description: `Open updated ${SECRET}`, params: { role: 'button', name: 'Complete' } }],
    });

    const result = await reviewDraft(repo, 'wf_review', { secrets: [SECRET] });
    assert.ok(result);
    assert.equal(result.activeVersion.version, 1);
    assert.equal(result.draftVersion.version, 2);
    assert.ok(!result.diff.includes(SECRET), 'service diff must not contain the supplied secret');
    assert.ok(result.diff.includes('[REDACTED]'));
    assert.ok(result.diff.includes('UNAPPROVED DRAFT'));
    assert.equal(result.secrets, undefined);
    assert.equal(serviceRenderDiff, cliRenderDiff);
  });

  it('review returns null when no draft exists and rejects unknown workflows', async () => {
    await createVerifiedWorkflow({ id: 'wf_nodraft' });
    assert.equal(await reviewDraft(repo, 'wf_nodraft'), null);
    await assert.rejects(() => reviewDraft(repo, ''), /Missing workflow ID for review command/);
    await assert.rejects(() => reviewDraft(repo, 'missing'), /not found in repository/);
  });

  it('integrity scan reports a healthy repository and matches the CLI path', async () => {
    await createVerifiedWorkflow({ id: 'wf_healthy' });
    const report = await scanIntegrity(repo);
    assert.equal(report.ok, true);
    assert.equal(report.totals.workflows, 1);

    const svc = createWorkflowQueryService({ repository: repo });
    assert.deepEqual(await svc.scanIntegrity(), report);
  });
});
