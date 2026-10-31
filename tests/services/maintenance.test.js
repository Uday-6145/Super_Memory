import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import { OperatorCLI } from '../../src/cli/operator.js';
import {
  createMaintenanceService,
  validateBackup,
} from '../../src/services/maintenance.js';

const ORIGIN = 'http://127.0.0.1:8080';
const ALLOWED_AUDIT_KEYS = new Set([
  'timestamp', 'type', 'workflowId', 'version', 'contentHash',
  'source', 'destination', 'imported', 'skipped', 'backupId',
]);

function sampleSteps() {
  return [
    { id: 's1', order: 1, action: 'clickByRole', description: 'Click link', params: { role: 'link', name: 'Go' } },
  ];
}

function sampleEvidence(workflowId, versionObj) {
  return {
    $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
    schemaVersion: '1.0.0',
    workflowId,
    version: 1,
    contentHash: calculateContentHash(versionObj),
    runId: `run_${workflowId}_1`,
    verifiedAt: new Date().toISOString(),
    environment: {
      targetOrigin: ORIGIN,
      browserEngine: 'chromium',
      playwrightVersion: '1.64.1',
      nodeVersion: process.version,
      platform: process.platform,
    },
    stepResults: [{ stepId: 's1', action: 'clickByRole', ok: true, status: 200, durationMs: 10, verification: null }],
    successCriteriaResult: {
      passed: true, finalPath: '/done', pageTitleMatched: null,
      textPresentFound: null, textAbsentFound: null, details: 'ok',
    },
  };
}

async function createVerifiedWorkflow(repo, id) {
  const { version } = await repo.createWorkflow({
    id,
    name: `Workflow ${id}`,
    description: `Description for ${id}`,
    target: { origin: ORIGIN, startPath: '/' },
    inputs: [],
    steps: sampleSteps(),
    successCriteria: { finalPath: '/done' },
  });
  await repo.markVerified(id, 1, sampleEvidence(id, version));
}

async function makeRepo(dir) {
  const repo = new FileSystemWorkflowRepository({ baseDir: dir });
  await repo.init();
  return repo;
}

describe('Repository Maintenance Service (M2 Phase 2)', () => {
  let root;
  let auditEvents;
  let auditOptions;
  let ensureHomeCalls;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-maint-svc-'));
    auditEvents = [];
    auditOptions = [];
    ensureHomeCalls = 0;
  });

  afterEach(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  function makeService({ repository, backupsDir, isManaged = false, audit, ensureHome } = {}) {
    return createMaintenanceService({
      repository,
      backupsDir: backupsDir ?? path.join(root, 'backups'),
      isManaged,
      audit: audit ?? (async (event, options) => {
        auditEvents.push(event);
        auditOptions.push(options || {});
      }),
      ensureHome: ensureHome ?? (async () => { ensureHomeCalls++; }),
    });
  }

  it('factory requires a repository and exposes bound methods without terminal I/O', async () => {
    assert.throws(() => createMaintenanceService({}), /requires a repository/);
    assert.throws(() => createMaintenanceService(), /requires a repository/);
    const repo = await makeRepo(path.join(root, 'w'));
    const svc = makeService({ repository: repo });
    for (const method of ['migrateRepository', 'createBackup', 'validateBackup', 'restoreBackup', 'snapshotBeforePromotion']) {
      assert.equal(typeof svc[method], 'function');
    }
    assert.equal(svc.stdout, undefined);
    assert.equal(svc.stderr, undefined);
    assert.equal(svc.stdin, undefined);
  });

  it('migrates a verified workflow copy-only and audits the import', async () => {
    const sourceDir = path.join(root, 'source');
    const destDir = path.join(root, 'dest');
    const sourceRepo = await makeRepo(sourceDir);
    await createVerifiedWorkflow(sourceRepo, 'wf_alpha');
    const destRepo = await makeRepo(destDir);

    const svc = makeService({ repository: destRepo, isManaged: true });
    const report = await svc.migrateRepository(sourceDir);

    assert.equal(report.imported.length, 1);
    assert.equal(report.imported[0].workflowId, 'wf_alpha');
    assert.deepEqual(report.skipped, []);
    assert.equal(ensureHomeCalls, 1);

    const manifest = await destRepo.getManifest('wf_alpha');
    assert.equal(manifest.activeVersion, 1);
    const evidence = await destRepo.getVerificationEvidence('wf_alpha', 1);
    assert.equal(evidence.workflowId, 'wf_alpha');

    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].type, 'import');
    assert.equal(auditEvents[0].workflowId, 'wf_alpha');
    for (const key of Object.keys(auditEvents[0])) {
      assert.ok(ALLOWED_AUDIT_KEYS.has(key), `audit field "${key}" must be allow-listed`);
    }
    // Default audit gating matches the CLI: managed-only unless specified.
    assert.deepEqual(auditOptions[0], {});
  });

  it('rejects invalid migration sources without touching the destination', async () => {
    const destDir = path.join(root, 'dest');
    const destRepo = await makeRepo(destDir);
    const svc = makeService({ repository: destRepo });

    await assert.rejects(() => svc.migrateRepository(''), /migrate requires --from/);
    // A nonexistent source passes through domain behavior: empty report, no throw.
    const missing = await svc.migrateRepository(path.join(root, 'does-not-exist'));
    assert.deepEqual(missing.imported, []);
    assert.deepEqual(missing.skipped, []);
    // Containment: a destination nested inside the source is rejected
    // before any copying begins.
    const outer = path.join(root, 'outer');
    await makeRepo(outer);
    const nestedRepo = await makeRepo(path.join(outer, 'nested'));
    const nestedSvc = makeService({ repository: nestedRepo });
    await assert.rejects(
      () => nestedSvc.migrateRepository(outer),
      /neither may contain the other/
    );
  });

  it('creates a backup and validates it through the service', async () => {
    const workflowsDir = path.join(root, 'w');
    const repo = await makeRepo(workflowsDir);
    await createVerifiedWorkflow(repo, 'wf_one');

    const svc = makeService({ repository: repo });
    const result = await svc.createBackup();

    assert.ok(result.backupId);
    assert.ok(result.backupDir);
    assert.ok(result.manifest);
    assert.equal(ensureHomeCalls, 1);

    const manifest = await svc.validateBackup(result.backupDir);
    assert.equal(manifest.backupId, result.backupId);

    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].type, 'backup');
    assert.equal(auditEvents[0].backupId, result.backupId);
    // Backup/restore audits always fire, even for non-managed repositories.
    assert.deepEqual(auditOptions[0], { managedOnly: false });
  });

  it('backup validation rejects corrupt snapshots', async () => {
    const workflowsDir = path.join(root, 'w');
    const repo = await makeRepo(workflowsDir);
    await createVerifiedWorkflow(repo, 'wf_one');
    const svc = makeService({ repository: repo });
    const { backupDir } = await svc.createBackup();

    await fs.writeFile(path.join(backupDir, 'backup.json'), '{corrupt', 'utf8');
    await assert.rejects(() => validateBackup(backupDir), /corrupt/);
  });

  it('restores a backup, preserves the previous repository, and returns a working handle', async () => {
    const workflowsDir = path.join(root, 'w');
    const repo = await makeRepo(workflowsDir);
    await createVerifiedWorkflow(repo, 'wf_keep');

    const svc = makeService({ repository: repo });
    const { backupDir, backupId } = await svc.createBackup();
    await createVerifiedWorkflow(repo, 'wf_divergent');

    const result = await svc.restoreBackup(backupDir);

    assert.equal(result.backupId, backupId);
    assert.ok(result.preservedSnapshot, 'previous repository must be preserved');
    assert.notEqual(result.repository, repo, 'restore must return a fresh repository handle');
    assert.equal(result.repository.baseDir, workflowsDir);

    // Fresh handle reads the restored content.
    assert.ok(await result.repository.getManifest('wf_keep'));
    assert.equal(await result.repository.getManifest('wf_divergent'), null);
    // Service context now points at the fresh handle.
    assert.equal(svc.repository, result.repository);

    const restoreAudit = auditEvents.find((e) => e.type === 'restore');
    assert.ok(restoreAudit);
    assert.equal(restoreAudit.backupId, backupId);
    for (const key of Object.keys(restoreAudit)) {
      assert.ok(ALLOWED_AUDIT_KEYS.has(key), `audit field "${key}" must be allow-listed`);
    }
  });

  it('failed restore leaves the destination untouched', async () => {
    const workflowsDir = path.join(root, 'w');
    const repo = await makeRepo(workflowsDir);
    await createVerifiedWorkflow(repo, 'wf_keep');

    const svc = makeService({ repository: repo });
    const { backupDir } = await svc.createBackup();
    // Corrupt the staged snapshot contents so hash verification fails.
    const versionFile = path.join(backupDir, 'workflows', 'wf_keep', 'versions', '1.json');
    const parsed = JSON.parse(await fs.readFile(versionFile, 'utf8'));
    parsed.steps[0].params.name = 'Tampered';
    await fs.writeFile(versionFile, JSON.stringify(parsed, null, 2));

    await assert.rejects(() => svc.restoreBackup(backupDir), /corrupt|hash|verif/i);
    assert.ok(await repo.getManifest('wf_keep'), 'destination must be unchanged after failed restore');
  });

  it('recovers through the service after a simulated crash mid-restore', async () => {
    const workflowsDir = path.join(root, 'w');
    const repo = await makeRepo(workflowsDir);
    await createVerifiedWorkflow(repo, 'wf_keep');

    const svc = makeService({ repository: repo });
    const { backupDir, backupId } = await svc.createBackup();
    await createVerifiedWorkflow(repo, 'wf_divergent');

    await assert.rejects(
      () => svc.restoreBackup(backupDir, { simulateCrashAt: 'afterSwap' }),
      (err) => err && err.code === 'SIMULATED_CRASH'
    );

    const result = await svc.restoreBackup(backupDir);
    assert.equal(result.backupId, backupId);
    assert.ok(await result.repository.getManifest('wf_keep'));
    assert.equal(await result.repository.getManifest('wf_divergent'), null);
  });

  it('snapshotBeforePromotion is a no-op off-managed and snapshots on-managed', async () => {
    const workflowsDir = path.join(root, 'w');
    const repo = await makeRepo(workflowsDir);
    await createVerifiedWorkflow(repo, 'wf_one');

    const plain = makeService({ repository: repo, isManaged: false });
    assert.equal(await plain.snapshotBeforePromotion(), null);
    assert.equal(ensureHomeCalls, 0);

    const managed = makeService({ repository: repo, isManaged: true });
    const snap = await managed.snapshotBeforePromotion();
    assert.ok(snap.backupId);
  });

  it('snapshot failure aborts with the historical promotion error', async () => {
    const workflowsDir = path.join(root, 'w');
    const repo = await makeRepo(workflowsDir);
    await createVerifiedWorkflow(repo, 'wf_one');

    // Backups nested inside the repository trip recursive-backup protection.
    const svc = makeService({
      repository: repo,
      isManaged: true,
      backupsDir: path.join(workflowsDir, 'backups'),
    });
    await assert.rejects(
      () => svc.snapshotBeforePromotion(),
      /Pre-promotion backup failed; promotion aborted:/
    );
  });

  it('a throwing audit sink never breaks maintenance operations', async () => {
    const workflowsDir = path.join(root, 'w');
    const repo = await makeRepo(workflowsDir);
    await createVerifiedWorkflow(repo, 'wf_one');

    const svc = makeService({
      repository: repo,
      audit: async () => { throw new Error('audit unavailable'); },
    });
    const result = await svc.createBackup();
    assert.ok(result.backupId);
  });

  it('maintenance operations never expose secrets in results or audit events', async () => {
    const secret = 'svc-maintenance-secret-9f8e7d6c5b';
    const sourceDir = path.join(root, 'source');
    const sourceRepo = await makeRepo(sourceDir);
    await sourceRepo.createWorkflow({
      id: 'wf_secret',
      name: `Name ${secret}`,
      description: 'desc',
      target: { origin: ORIGIN, startPath: '/' },
      inputs: [{ name: 'token', type: 'string', label: 'Token', description: 'API token', required: false }],
      steps: sampleSteps(),
      successCriteria: { finalPath: '/' },
    });
    const destRepo = await makeRepo(path.join(root, 'dest'));

    const svc = makeService({ repository: destRepo });
    const report = await svc.migrateRepository(sourceDir);
    assert.equal(report.imported.length, 1);

    const serialized = JSON.stringify({ report, auditEvents });
    assert.ok(!serialized.includes(secret), 'import report and audit events must not carry raw secrets');
    for (const event of auditEvents) {
      for (const key of Object.keys(event)) {
        assert.ok(ALLOWED_AUDIT_KEYS.has(key), `audit field "${key}" must be allow-listed`);
      }
    }
  });

  it('CLI backup/restore round-trip adopts the fresh repository handle', async () => {
    const homeDir = path.join(root, 'home');
    const stdout = new PassThrough();
    stdout.on('data', () => {});
    const stderr = new PassThrough();
    stderr.on('data', () => {});
    const cli = new OperatorCLI({
      homeDir,
      io: { stdin: new PassThrough(), stdout, stderr },
    });
    await cli.repo.init();
    const { version } = await cli.repo.createWorkflow({
      id: 'wf_cli',
      name: 'CLI workflow',
      description: 'desc',
      target: { origin: ORIGIN, startPath: '/' },
      inputs: [],
      steps: sampleSteps(),
      successCriteria: { finalPath: '/' },
    });
    await cli.repo.markVerified('wf_cli', 1, sampleEvidence('wf_cli', version));

    const created = await cli.createBackup();
    assert.ok(created.backupId);

    await cli.repo.createWorkflow({
      id: 'wf_extra',
      name: 'Extra',
      description: 'desc',
      target: { origin: ORIGIN, startPath: '/' },
      inputs: [],
      steps: sampleSteps(),
      successCriteria: { finalPath: '/' },
    });

    const repoBefore = cli.repo;
    const restored = await cli.restoreBackup(created.backupDir);
    assert.equal(restored.backupId, created.backupId);
    assert.ok(restored.preservedSnapshot);
    assert.notEqual(cli.repo, repoBefore, 'CLI must adopt the fresh repository handle');
    assert.ok(await cli.repo.getManifest('wf_cli'));
    assert.equal(await cli.repo.getManifest('wf_extra'), null);
  });
});
