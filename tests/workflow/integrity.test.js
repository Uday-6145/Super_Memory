import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import { scanRepositoryIntegrity } from '../../src/workflow/integrity.js';

async function hashTree(dir) {
  const hashes = {};
  async function walk(current, relative) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else hashes[rel] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  }
  await walk(dir, '');
  return hashes;
}

function sampleEvidence(versionObj) {
  return {
    $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
    schemaVersion: '1.0.0',
    workflowId: versionObj.workflowId,
    version: versionObj.version,
    contentHash: calculateContentHash(versionObj),
    runId: 'run_20261027_164500_abc123',
    verifiedAt: '2026-10-27T16:45:00.000Z',
    environment: {
      targetOrigin: 'http://127.0.0.1:8080',
      browserEngine: 'chromium',
      playwrightVersion: '1.64.1',
      nodeVersion: 'v22.19.0',
      platform: 'darwin-arm64',
    },
    stepResults: [{ stepId: 'step_1', action: 'navigate', ok: true, durationMs: 10, verification: null }],
    successCriteriaResult: {
      passed: true,
      finalPath: '/',
      pageTitleMatched: null,
      textPresentFound: null,
      textAbsentFound: null,
      details: 'All declared success conditions satisfied.',
    },
  };
}

describe('Repository integrity scan (read-only)', () => {
  let root;
  let repoDir;
  let repo;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-integrity-'));
    repoDir = path.join(root, 'workflows');
    repo = new FileSystemWorkflowRepository({ baseDir: repoDir });
    await repo.init();
    const { version } = await repo.createWorkflow({
      id: 'wf_scan',
      name: 'Scan target',
      description: 'Healthy workflow',
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      inputs: [],
      steps: [
        { id: 'step_1', order: 1, description: 'Navigate', action: 'navigate', params: { path: '/' }, anchor: null, verification: null },
      ],
      successCriteria: { finalPath: '/' },
    });
    await repo.markVerified('wf_scan', 1, sampleEvidence(version));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('passes a healthy repository and modifies nothing', async () => {
    const before = await hashTree(repoDir);
    const report = await scanRepositoryIntegrity(repoDir);
    assert.equal(report.ok, true);
    assert.equal(report.totals.workflows, 1);
    assert.equal(report.totals.issues, 0);
    assert.deepEqual(await hashTree(repoDir), before, 'scan must be read-only');
  });

  it('detects tampered version content via evidence hash mismatch', async () => {
    const versionPath = path.join(repoDir, 'wf_scan', 'versions', '1.json');
    const version = JSON.parse(await fs.readFile(versionPath, 'utf8'));
    version.steps[0].description = 'Tampered after verification';
    await fs.writeFile(versionPath, JSON.stringify(version, null, 2));

    const report = await scanRepositoryIntegrity(repoDir);
    assert.equal(report.ok, false);
    assert.ok(report.workflows[0].issues.some((i) => i.code === 'EVIDENCE_MISMATCH'));
  });

  it('detects a missing active version file', async () => {
    await fs.rm(path.join(repoDir, 'wf_scan', 'versions', '1.json'));
    const report = await scanRepositoryIntegrity(repoDir);
    assert.equal(report.ok, false);
    assert.ok(report.workflows[0].issues.some((i) => i.code === 'POINTER_MISSING'));
  });

  it('detects missing evidence for a verified version', async () => {
    await fs.rm(path.join(repoDir, 'wf_scan', 'verifications', '1.evidence.json'));
    const report = await scanRepositoryIntegrity(repoDir);
    assert.equal(report.ok, false);
    assert.ok(report.workflows[0].issues.some((i) => i.code === 'EVIDENCE_MISSING'));
  });

  it('treats a missing repository directory as an empty scan', async () => {
    const report = await scanRepositoryIntegrity(path.join(root, 'does-not-exist'));
    assert.equal(report.ok, true);
    assert.equal(report.totals.workflows, 0);
  });

  it('promotion archives evidence into the workflow verifications directory', async () => {
    // beforeEach already promoted via markVerified; assert the archived file
    // exists and matches the evidence bound to the version hash.
    const archived = JSON.parse(
      await fs.readFile(path.join(repoDir, 'wf_scan', 'verifications', '1.evidence.json'), 'utf8')
    );
    const version = await repo.getVersion('wf_scan', 1);
    assert.equal(archived.contentHash, calculateContentHash(version));
    assert.equal(archived.workflowId, 'wf_scan');
  });
});
