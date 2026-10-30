import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import { migrateRepository } from '../../src/workflow/migration.js';

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
    stepResults: [
      { stepId: 'step_1', action: 'navigate', ok: true, durationMs: 10, verification: null },
    ],
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

async function createVerifiedWorkflow(repo, id, description = 'Navigate home') {
  const { version } = await repo.createWorkflow({
    id,
    name: `Workflow ${id}`,
    description,
    target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
    inputs: [],
    steps: [
      {
        id: 'step_1',
        order: 1,
        description,
        action: 'navigate',
        params: { path: '/' },
        anchor: null,
        verification: null,
      },
    ],
    successCriteria: { finalPath: '/' },
  });
  await repo.markVerified(id, 1, sampleEvidence(version));
  return version;
}

describe('Repository migration / import', () => {
  let root;
  let sourceDir;
  let destDir;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-migrate-'));
    sourceDir = path.join(root, 'source');
    destDir = path.join(root, 'dest');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeSourceRepo() {
    const repo = new FileSystemWorkflowRepository({ baseDir: sourceDir });
    await repo.init();
    return repo;
  }

  it('imports a verified workflow with evidence preserved and source untouched', async () => {
    const sourceRepo = await makeSourceRepo();
    await createVerifiedWorkflow(sourceRepo, 'wf_alpha');
    const sourceBefore = await hashTree(sourceDir);
    const sourceEvidence = await fs.readFile(
      path.join(sourceDir, 'wf_alpha', 'verifications', '1.evidence.json'),
      'utf8'
    );

    const report = await migrateRepository({ sourceDir, destinationDir: destDir });

    assert.equal(report.imported.length, 1);
    assert.equal(report.imported[0].workflowId, 'wf_alpha');
    assert.deepEqual(report.skipped, []);

    const destEvidence = await fs.readFile(
      path.join(destDir, 'wf_alpha', 'verifications', '1.evidence.json'),
      'utf8'
    );
    assert.equal(destEvidence, sourceEvidence, 'verification evidence must be preserved verbatim');

    const destRepo = new FileSystemWorkflowRepository({ baseDir: destDir });
    const manifest = await destRepo.getManifest('wf_alpha');
    assert.equal(manifest.activeVersion, 1);

    assert.deepEqual(await hashTree(sourceDir), sourceBefore, 'source repository must not change');
  });

  it('is safe to repeat: a second import skips the identical workflow', async () => {
    const sourceRepo = await makeSourceRepo();
    await createVerifiedWorkflow(sourceRepo, 'wf_alpha');

    await migrateRepository({ sourceDir, destinationDir: destDir });
    const second = await migrateRepository({ sourceDir, destinationDir: destDir });

    assert.deepEqual(second.imported, []);
    assert.equal(second.skipped.length, 1);
    assert.match(second.skipped[0].reason, /Already imported identically/);
  });

  it('refuses to overwrite a destination version with different content', async () => {
    const sourceRepo = await makeSourceRepo();
    await createVerifiedWorkflow(sourceRepo, 'wf_alpha', 'Source description');

    const destRepo = new FileSystemWorkflowRepository({ baseDir: destDir });
    await destRepo.init();
    await createVerifiedWorkflow(destRepo, 'wf_alpha', 'Different destination description');
    const destBefore = await hashTree(destDir);

    const report = await migrateRepository({ sourceDir, destinationDir: destDir });

    assert.deepEqual(report.imported, []);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /different content|Refusing to overwrite/);
    assert.deepEqual(await hashTree(destDir), destBefore, 'destination must not change on collision');
  });

  it('rejects a source workflow whose evidence hash does not match its version', async () => {
    const sourceRepo = await makeSourceRepo();
    await createVerifiedWorkflow(sourceRepo, 'wf_alpha');

    const evidencePath = path.join(sourceDir, 'wf_alpha', 'verifications', '1.evidence.json');
    const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
    evidence.contentHash = 'f'.repeat(64);
    await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2));

    const report = await migrateRepository({ sourceDir, destinationDir: destDir });

    assert.deepEqual(report.imported, []);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /Source validation failed/);
    await assert.rejects(() => fs.stat(path.join(destDir, 'wf_alpha')), /ENOENT/);
  });

  it('rejects a verified source version with missing evidence', async () => {
    const sourceRepo = await makeSourceRepo();
    await createVerifiedWorkflow(sourceRepo, 'wf_alpha');
    await fs.rm(path.join(sourceDir, 'wf_alpha', 'verifications', '1.evidence.json'));

    const report = await migrateRepository({ sourceDir, destinationDir: destDir });
    assert.deepEqual(report.imported, []);
    assert.match(report.skipped[0].reason, /missing its verification evidence/);
  });

  it('rejects a destination nested inside the source', async () => {
    const sourceRepo = await makeSourceRepo();
    await createVerifiedWorkflow(sourceRepo, 'wf_alpha');
    const nestedDest = path.join(sourceDir, 'nested-dest');
    await assert.rejects(
      () => migrateRepository({ sourceDir, destinationDir: nestedDest }),
      /independent directories/
    );
    await assert.rejects(() => fs.stat(nestedDest), /ENOENT/, 'no copying may start');
  });

  it('rejects a source nested inside the destination', async () => {
    const sourceRepo = await makeSourceRepo();
    await createVerifiedWorkflow(sourceRepo, 'wf_alpha');
    await assert.rejects(
      () => migrateRepository({ sourceDir, destinationDir: root }),
      /independent directories/
    );
  });

  it('rejects overlap hidden behind a symlinked parent path', async () => {
    const sourceRepo = await makeSourceRepo();
    await createVerifiedWorkflow(sourceRepo, 'wf_alpha');
    const linkPath = path.join(root, 'link');
    await fs.symlink(root, linkPath, 'dir');
    await assert.rejects(
      () =>
        migrateRepository({
          sourceDir: path.join(linkPath, 'source'),
          destinationDir: path.join(sourceDir, 'inner-dest'),
        }),
      /independent directories/
    );
  });

  it('rejects workflows containing symlinks and never follows them', async (t) => {
    const cases = [
      ['internal file symlink', async (wfDir) => {
        await fs.symlink(path.join('..', 'versions', '1.json'), path.join(wfDir, 'versions', 'alias.json'));
      }],
      ['external file symlink', async (wfDir) => {
        const outside = path.join(root, 'outside-secret.txt');
        await fs.writeFile(outside, 'outside-data');
        await fs.symlink(outside, path.join(wfDir, 'versions', 'evil.json'));
      }],
      ['dangling symlink', async (wfDir) => {
        await fs.symlink(path.join(wfDir, 'versions', 'does-not-exist.json'), path.join(wfDir, 'versions', 'dangling.json'));
      }],
      ['symlinked directory', async (wfDir) => {
        await fs.symlink(path.join(wfDir, 'versions'), path.join(wfDir, 'versions-link'), 'dir');
      }],
      ['symlinked workflow directory', async (wfDir) => {
        await fs.rename(wfDir, `${wfDir}-real`);
        await fs.symlink(`${wfDir}-real`, wfDir, 'dir');
      }],
    ];

    for (const [name, plant] of cases) {
      await t.test(name, async () => {
        const caseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-migrate-link-'));
        try {
          const src = path.join(caseRoot, 'source');
          const dst = path.join(caseRoot, 'dest');
          const repo = new FileSystemWorkflowRepository({ baseDir: src });
          await repo.init();
          await createVerifiedWorkflow(repo, 'wf_link');
          await plant(path.join(src, 'wf_link'));

          const report = await migrateRepository({ sourceDir: src, destinationDir: dst });
          assert.deepEqual(report.imported, []);
          assert.ok(
            report.skipped.some((s) => /symbolic link/.test(s.reason)),
            `expected a symlink rejection, got: ${JSON.stringify(report.skipped)}`
          );
          await assert.rejects(() => fs.stat(path.join(dst, 'wf_link')), /ENOENT/);
        } finally {
          await fs.rm(caseRoot, { recursive: true, force: true });
        }
      });
    }

    const outside = path.join(root, 'outside-secret.txt');
    if (await fs.stat(outside).catch(() => null)) {
      assert.equal(await fs.readFile(outside, 'utf8'), 'outside-data', 'external target must be untouched');
    }
  });

  it('imports draft-only workflows without requiring evidence', async () => {
    const sourceRepo = await makeSourceRepo();
    await sourceRepo.createWorkflow({
      id: 'wf_draft',
      name: 'Draft only',
      description: 'Unverified draft',
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      inputs: [],
      steps: [
        { id: 'step_1', order: 1, description: 'Navigate', action: 'navigate', params: { path: '/' }, anchor: null, verification: null },
      ],
      successCriteria: { finalPath: '/' },
    });

    const report = await migrateRepository({ sourceDir, destinationDir: destDir });
    assert.equal(report.imported.length, 1);
    assert.equal(report.imported[0].workflowId, 'wf_draft');
  });
});
