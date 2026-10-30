import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import {
  createRepositoryBackup,
  validateRepositoryBackup,
  restoreRepositoryBackup,
} from '../../src/config/backup.js';
import { appendAuditEvent, readAuditEvents } from '../../src/config/audit.js';
import { OperatorCLI, getStagedEvidencePath } from '../../src/cli/operator.js';
import { scanRepositoryIntegrity } from '../../src/workflow/integrity.js';

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

async function createDraft(repo, id) {
  const { version } = await repo.createWorkflow({
    id,
    name: `Workflow ${id}`,
    description: `Draft ${id}`,
    target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
    inputs: [],
    steps: [
      { id: 'step_1', order: 1, description: 'Navigate', action: 'navigate', params: { path: '/' }, anchor: null, verification: null },
    ],
    successCriteria: { finalPath: '/' },
  });
  return version;
}

describe('Repository backup and restore', () => {
  let root;
  let workflowsDir;
  let backupsDir;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-backup-'));
    workflowsDir = path.join(root, 'home', 'workflows');
    backupsDir = path.join(root, 'home', 'backups');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('round-trips: backup, diverge, restore returns the original state', async () => {
    const repo = new FileSystemWorkflowRepository({ baseDir: workflowsDir });
    await repo.init();
    const version = await createDraft(repo, 'wf_one');
    await repo.markVerified('wf_one', 1, sampleEvidence(version));

    const { backupDir, backupId } = await createRepositoryBackup({ workflowsDir, backupsDir });
    assert.ok(backupId);
    assert.equal((await validateRepositoryBackup(backupDir)).backupId, backupId);
    // The backup must not contain the backups directory itself.
    await assert.rejects(() => fs.stat(path.join(backupDir, 'workflows', 'backups')), /ENOENT/);

    // Diverge the live repository.
    await createDraft(repo, 'wf_two');
    assert.ok(await repo.getManifest('wf_two'));

    const restored = await restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir });
    assert.equal(restored.backupId, backupId);
    assert.ok(restored.preservedSnapshot, 'previous repository must be preserved');

    const afterRepo = new FileSystemWorkflowRepository({ baseDir: workflowsDir });
    assert.ok(await afterRepo.getManifest('wf_one'));
    assert.equal(await afterRepo.getManifest('wf_two'), null);
    assert.equal((await scanRepositoryIntegrity(workflowsDir)).ok, true);
  });

  it('rejects a corrupt backup and leaves the destination untouched', async () => {
    const repo = new FileSystemWorkflowRepository({ baseDir: workflowsDir });
    await repo.init();
    const version = await createDraft(repo, 'wf_one');
    await repo.markVerified('wf_one', 1, sampleEvidence(version));

    const { backupDir } = await createRepositoryBackup({ workflowsDir, backupsDir });

    // Corrupt the snapshot contents (a hashed step field, so hashes diverge).
    const backedUpVersion = path.join(backupDir, 'workflows', 'wf_one', 'versions', '1.json');
    const parsed = JSON.parse(await fs.readFile(backedUpVersion, 'utf8'));
    parsed.steps[0].description = 'Corrupted in backup';
    await fs.writeFile(backedUpVersion, JSON.stringify(parsed, null, 2));

    await assert.rejects(() => validateRepositoryBackup(backupDir), /corrupt/);
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir }),
      /corrupt/
    );

    const afterRepo = new FileSystemWorkflowRepository({ baseDir: workflowsDir });
    assert.equal((await afterRepo.getVersion('wf_one', 1)).steps[0].description, 'Navigate');
  });

  it('refuses recursive backup layouts', async () => {
    await assert.rejects(
      () => createRepositoryBackup({ workflowsDir, backupsDir: path.join(workflowsDir, 'backups') }),
      /recursive backup protection/
    );
  });
});

describe('Managed promotion backup and audit trail', () => {
  let root;
  let homeDir;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-audit-'));
    homeDir = path.join(root, 'home');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeCLI() {
    const stdout = new PassThrough();
    stdout.on('data', () => {});
    const stderr = new PassThrough();
    stderr.on('data', () => {});
    return new OperatorCLI({
      homeDir,
      io: { stdin: new PassThrough(), stdout, stderr },
    });
  }

  it('promotion in the managed home creates a pre-promotion backup and a privacy-safe audit event', async () => {
    const cli = makeCLI();
    await cli.repo.init();
    const version = await createDraft(cli.repo, 'wf_managed');

    // Stage valid trial evidence the way `trial` would.
    const evidence = sampleEvidence(version);
    const stagedPath = getStagedEvidencePath(cli.repo.baseDir, 'wf_managed', 1);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.writeFile(stagedPath, JSON.stringify(evidence, null, 2));

    const result = await cli.promote('wf_managed', { confirm: 'PROMOTE wf_managed' });
    assert.equal(result.promoted, true);

    const backups = await fs.readdir(path.join(homeDir, 'backups'));
    assert.equal(backups.filter((name) => !name.startsWith('.')).length, 1, 'one pre-promotion backup snapshot');

    const events = await readAuditEvents(path.join(homeDir, 'audit.jsonl'));
    const promotion = events.find((e) => e.type === 'promotion');
    assert.ok(promotion);
    assert.equal(promotion.workflowId, 'wf_managed');
    assert.equal(promotion.version, 1);
    assert.equal(promotion.contentHash, evidence.contentHash);
  });

  it('audit events strip non-allow-listed fields (no input values or prompts)', async () => {
    const auditPath = path.join(root, 'audit.jsonl');
    await appendAuditEvent(auditPath, {
      type: 'promotion',
      workflowId: 'wf_x',
      version: 1,
      contentHash: 'a'.repeat(64),
      inputValue: 'SECRET-INPUT-VALUE',
      prompt: 'SECRET-PROMPT',
      pageText: 'SECRET-PAGE-TEXT',
    });
    const raw = await fs.readFile(auditPath, 'utf8');
    assert.ok(!raw.includes('SECRET-INPUT-VALUE'));
    assert.ok(!raw.includes('SECRET-PROMPT'));
    assert.ok(!raw.includes('SECRET-PAGE-TEXT'));
    const [event] = await readAuditEvents(auditPath);
    assert.deepEqual(Object.keys(event).sort(), ['contentHash', 'timestamp', 'type', 'version', 'workflowId']);
  });
});
