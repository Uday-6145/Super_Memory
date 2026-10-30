import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import {
  createRepositoryBackup,
  restoreRepositoryBackup,
  recoverInterruptedRestore,
} from '../../src/config/backup.js';

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

async function createVerified(repo, id) {
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
  await repo.markVerified(id, 1, sampleEvidence(version));
  return version;
}

describe('Transactional restore with crash recovery', () => {
  let root;
  let workflowsDir;
  let backupsDir;
  let backupDir;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-restore-'));
    workflowsDir = path.join(root, 'home', 'workflows');
    backupsDir = path.join(root, 'home', 'backups');

    const repo = new FileSystemWorkflowRepository({ baseDir: workflowsDir });
    await repo.init();
    await createVerified(repo, 'wf_one');
    ({ backupDir } = await createRepositoryBackup({ workflowsDir, backupsDir }));
    // Diverge: the live repository gains a second workflow after the backup.
    await createVerified(repo, 'wf_two');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function liveRepo() {
    return new FileSystemWorkflowRepository({ baseDir: workflowsDir });
  }

  async function siblingNames(prefix) {
    const entries = await fs.readdir(path.dirname(workflowsDir));
    return entries.filter((name) => name.startsWith(prefix));
  }

  it('failure before moving the original leaves the destination intact', async () => {
    await assert.rejects(
      () =>
        restoreRepositoryBackup({
          backupDir,
          workflowsDir,
          backupsDir,
          hooks: { afterStaged: async () => { throw new Error('injected failure after staging'); } },
        }),
      /injected failure after staging/
    );
    assert.ok(await (await liveRepo()).getManifest('wf_two'));
    assert.deepEqual(await siblingNames('.pre-restore-'), []);
    assert.deepEqual(await siblingNames('.restore-transaction'), []);
  });

  it('failure after moving the original rolls the original back', async () => {
    await assert.rejects(
      () =>
        restoreRepositoryBackup({
          backupDir,
          workflowsDir,
          backupsDir,
          hooks: { afterPreserved: async () => { throw new Error('injected failure after preserve'); } },
        }),
      /injected failure after preserve/
    );
    const repo = await liveRepo();
    assert.ok(await repo.getManifest('wf_one'));
    assert.ok(await repo.getManifest('wf_two'), 'original destination must be restored');
    assert.deepEqual(await siblingNames('.restore-transaction'), []);
  });

  it('failure during the final swap leaves the destination intact', async () => {
    await assert.rejects(
      () =>
        restoreRepositoryBackup({
          backupDir,
          workflowsDir,
          backupsDir,
          hooks: { beforeSwap: async () => { throw new Error('injected swap failure'); } },
        }),
      /injected swap failure/
    );
    assert.ok(await (await liveRepo()).getManifest('wf_two'));
  });

  it('post-swap verification failure rolls back to the original repository', async () => {
    await assert.rejects(
      () =>
        restoreRepositoryBackup({
          backupDir,
          workflowsDir,
          backupsDir,
          hooks: {
            afterSwap: async () => {
              const file = path.join(workflowsDir, 'wf_one', 'versions', '1.json');
              const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
              parsed.steps[0].description = 'Tampered after swap';
              await fs.writeFile(file, JSON.stringify(parsed, null, 2));
            },
          },
        }),
      /post-swap hash verification/
    );
    const repo = await liveRepo();
    assert.ok(await repo.getManifest('wf_two'), 'original repository must be back in place');
    assert.equal((await repo.getVersion('wf_one', 1)).steps[0].description, 'Navigate');
    assert.equal((await siblingNames('.failed-restore-')).length, 1, 'bad tree preserved for diagnosis');
  });

  it('recovers the original after a crash following preservation', async () => {
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, simulateCrashAt: 'afterPreserved' }),
      (err) => err.code === 'SIMULATED_CRASH'
    );
    // Mid-crash state: destination is missing, original is preserved.
    await assert.rejects(() => fs.stat(workflowsDir), /ENOENT/);
    assert.equal((await siblingNames('.pre-restore-')).length, 1);
    assert.equal((await siblingNames('.restore-transaction')).length, 1);

    const recovery = await recoverInterruptedRestore({ workflowsDir, backupsDir });
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.action, 'restored-original');
    const repo = await liveRepo();
    assert.ok(await repo.getManifest('wf_two'));
  });

  it('completes a verified swap after a crash following the swap', async () => {
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, simulateCrashAt: 'afterSwap' }),
      (err) => err.code === 'SIMULATED_CRASH'
    );
    const recovery = await recoverInterruptedRestore({ workflowsDir, backupsDir });
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.action, 'completed-verified');
    const repo = await liveRepo();
    assert.ok(await repo.getManifest('wf_one'));
    assert.equal(await repo.getManifest('wf_two'), null, 'restored (backup) state is active');
    assert.equal((await siblingNames('.pre-restore-')).length, 1, 'original remains preserved');
  });

  it('rolls back after a crash when the swapped tree was tampered with', async () => {
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, simulateCrashAt: 'afterSwap' }),
      (err) => err.code === 'SIMULATED_CRASH'
    );
    const file = path.join(workflowsDir, 'wf_one', 'versions', '1.json');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    parsed.steps[0].description = 'Tampered while crashed';
    await fs.writeFile(file, JSON.stringify(parsed, null, 2));

    const recovery = await recoverInterruptedRestore({ workflowsDir, backupsDir });
    assert.equal(recovery.action, 'rolled-back');
    const repo = await liveRepo();
    assert.ok(await repo.getManifest('wf_two'), 'original repository must be back');
    assert.equal((await repo.getVersion('wf_one', 1)).steps[0].description, 'Navigate');
  });

  it('crash after the preservation rename (journal still staged) recovers the original', async () => {
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, simulateCrashAt: 'afterPreservationRename' }),
      (err) => err.code === 'SIMULATED_CRASH'
    );
    // Exact mid-crash state: destination moved, journal not yet updated.
    await assert.rejects(() => fs.stat(workflowsDir), /ENOENT/);
    const preserved = await siblingNames('.pre-restore-');
    assert.equal(preserved.length, 1);
    const journal = JSON.parse(
      await fs.readFile(path.join(path.dirname(workflowsDir), '.restore-transaction.json'), 'utf8')
    );
    assert.equal(journal.phase, 'staged');
    assert.ok(journal.preservedPath.endsWith(preserved[0]));

    const recovery = await recoverInterruptedRestore({ workflowsDir, backupsDir });
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.action, 'restored-original');

    const repo = await liveRepo();
    assert.ok(await repo.getManifest('wf_two'), 'original repository restored');
    assert.equal((await repo.getVersion('wf_one', 1)).steps[0].description, 'Navigate');
    assert.deepEqual(await siblingNames('.restore-transaction'), []);
    assert.deepEqual(await siblingNames('.restore-staging-'), []);

    // Repeated recovery is idempotent.
    assert.deepEqual(await recoverInterruptedRestore({ workflowsDir, backupsDir }), { recovered: false });
  });

  it('crash after journaling the preservation path but before the rename keeps the original in place', async () => {
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, simulateCrashAt: 'afterStaged' }),
      (err) => err.code === 'SIMULATED_CRASH'
    );
    assert.ok(await (await liveRepo()).getManifest('wf_two'));
    assert.deepEqual(await siblingNames('.pre-restore-'), []);

    const recovery = await recoverInterruptedRestore({ workflowsDir, backupsDir });
    assert.equal(recovery.action, 'cleaned-staging');
    assert.ok(await (await liveRepo()).getManifest('wf_two'));
  });

  it('ambiguous state (both destination and preserved exist) fails closed and deletes nothing', async () => {
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, simulateCrashAt: 'afterPreservationRename' }),
      (err) => err.code === 'SIMULATED_CRASH'
    );
    const [preservedName] = await siblingNames('.pre-restore-');
    const preservedPath = path.join(path.dirname(workflowsDir), preservedName);
    await fs.cp(preservedPath, workflowsDir, { recursive: true });

    await assert.rejects(() => recoverInterruptedRestore({ workflowsDir, backupsDir }), /ambiguous filesystem state/);
    // Journal retained, both trees untouched.
    assert.equal((await siblingNames('.restore-transaction')).length, 1);
    assert.ok(await fs.stat(preservedPath));
    assert.ok(await (await liveRepo()).getManifest('wf_two'));
  });

  it('ambiguous state (neither destination nor preserved exists) fails closed', async () => {
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, simulateCrashAt: 'afterPreservationRename' }),
      (err) => err.code === 'SIMULATED_CRASH'
    );
    const [preservedName] = await siblingNames('.pre-restore-');
    await fs.rename(path.join(path.dirname(workflowsDir), preservedName), path.join(root, 'moved-away'));

    await assert.rejects(() => recoverInterruptedRestore({ workflowsDir, backupsDir }), /ambiguous filesystem state/);
    assert.equal((await siblingNames('.restore-transaction')).length, 1, 'journal retained for operator intervention');
    // The only copy still exists where the operator moved it; recovery deleted nothing.
    assert.ok(await fs.stat(path.join(root, 'moved-away', 'wf_one', 'versions', '1.json')));
  });

  it('crash after the swap rename (journal still preserved) verifies before completing', async () => {
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, simulateCrashAt: 'afterSwapRename' }),
      (err) => err.code === 'SIMULATED_CRASH'
    );
    const journal = JSON.parse(
      await fs.readFile(path.join(path.dirname(workflowsDir), '.restore-transaction.json'), 'utf8')
    );
    assert.equal(journal.phase, 'preserved');

    const recovery = await recoverInterruptedRestore({ workflowsDir, backupsDir });
    assert.equal(recovery.action, 'completed-verified');
    const repo = await liveRepo();
    assert.ok(await repo.getManifest('wf_one'));
    assert.equal(await repo.getManifest('wf_two'), null, 'verified backup state is active');
    assert.equal((await siblingNames('.pre-restore-')).length, 1, 'preserved original retained');
  });

  it('crash after the swap rename with a tampered destination rolls back to the original', async () => {
    await assert.rejects(
      () => restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, simulateCrashAt: 'afterSwapRename' }),
      (err) => err.code === 'SIMULATED_CRASH'
    );
    const file = path.join(workflowsDir, 'wf_one', 'versions', '1.json');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    parsed.steps[0].description = 'Tampered in swap window';
    await fs.writeFile(file, JSON.stringify(parsed, null, 2));

    const recovery = await recoverInterruptedRestore({ workflowsDir, backupsDir });
    assert.equal(recovery.action, 'rolled-back');
    const repo = await liveRepo();
    assert.ok(await repo.getManifest('wf_two'), 'valid preserved original restored');
    assert.equal((await repo.getVersion('wf_one', 1)).steps[0].description, 'Navigate');
    assert.equal((await siblingNames('.failed-restore-')).length, 1);
  });

  it('never performs a cross-filesystem rename (EXDEV-safe by adjacency)', async () => {
    // Injected rename that fails with EXDEV whenever the two paths are not
    // in the same directory: restore must still succeed, proving every
    // destination-side rename is adjacent (same filesystem).
    const sameDirRename = async (from, to) => {
      if (path.dirname(path.resolve(from)) !== path.dirname(path.resolve(to))) {
        const err = new Error('EXDEV: cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      }
      return fs.rename(from, to);
    };

    const result = await restoreRepositoryBackup({
      backupDir,
      workflowsDir,
      backupsDir,
      rename: sameDirRename,
    });
    assert.ok(result.backupId);
    const repo = await liveRepo();
    assert.ok(await repo.getManifest('wf_one'));
    assert.equal(await repo.getManifest('wf_two'), null);
  });
});

describe('Backup identifier uniqueness', () => {
  it('rapid sequential and concurrent backups never collide or overwrite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-backup-ids-'));
    try {
      const workflowsDir = path.join(root, 'workflows');
      const backupsDir = path.join(root, 'backups');
      const repo = new FileSystemWorkflowRepository({ baseDir: workflowsDir });
      await repo.init();
      await createVerified(repo, 'wf_ids');

      const sequential = [];
      for (let i = 0; i < 15; i++) {
        sequential.push(await createRepositoryBackup({ workflowsDir, backupsDir }));
      }
      const concurrent = await Promise.all(
        Array.from({ length: 10 }, () => createRepositoryBackup({ workflowsDir, backupsDir }))
      );

      const ids = [...sequential, ...concurrent].map((b) => b.backupId);
      assert.equal(new Set(ids).size, ids.length, 'every backup id must be unique');
      for (const backup of [...sequential, ...concurrent]) {
        assert.ok(await fs.stat(path.join(backup.backupDir, 'backup.json')));
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
