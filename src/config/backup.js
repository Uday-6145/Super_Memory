/**
 * Super Memory — Repository Backup and Restore
 *
 * Backups are timestamped snapshots of a workflows repository directory,
 * stored OUTSIDE the repository itself (never recursively inside it):
 *
 *   <backups>/<backupId>/
 *   ├── workflows/     (full copy of the repository)
 *   └── backup.json    (per-version canonical content hashes)
 *
 * Backup identifiers combine a timestamp with a random suffix and are
 * claimed with exclusive directory creation, so rapid or concurrent
 * backups can never collide or overwrite an existing snapshot.
 *
 * Restore is transaction-like:
 * 1. The backup is fully hash-validated before the destination is touched.
 * 2. Replacement content is staged BESIDE the destination (same filesystem,
 *    so every rename is atomic and cross-device copies are plain copies)
 *    and hash-verified there.
 * 3. A transaction journal (.restore-transaction.json beside the
 *    destination) records each phase. The existing destination is renamed
 *    to a unique preserved name beside the destination; it is never deleted.
 * 4. The staged tree is renamed into place and verified again.
 * 5. Any failure rolls the preserved original back. If the process crashes
 *    mid-transaction, the journal lets the next backup/restore operation
 *    recover deterministically via recoverInterruptedRestore().
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { WorkflowError } from '../workflow/errors.js';
import { calculateContentHash } from '../workflow/hash.js';

function makeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function makeUniqueSuffix() {
  return randomUUID().slice(0, 8);
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathExists(target) {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

async function computeWorkflowHashes(workflowsDir) {
  const workflows = [];
  let entries = [];
  try {
    entries = await fs.readdir(workflowsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const versionsDir = path.join(workflowsDir, entry.name, 'versions');
    let files = [];
    try {
      files = (await fs.readdir(versionsDir)).filter((n) => /^\d+\.json$/.test(n));
    } catch {}
    const versions = [];
    for (const fileName of files) {
      const version = JSON.parse(await fs.readFile(path.join(versionsDir, fileName), 'utf8'));
      versions.push({ version: version.version, contentHash: calculateContentHash(version) });
    }
    workflows.push({ id: entry.name, versions });
  }
  return workflows;
}

function hashesMatchManifest(actual, expectedWorkflows) {
  const actualById = new Map(
    actual.map((w) => [w.id, new Map(w.versions.map((v) => [v.version, v.contentHash]))])
  );
  for (const expected of expectedWorkflows) {
    const versions = actualById.get(expected.id);
    if (!versions) return false;
    for (const { version, contentHash } of expected.versions) {
      if (versions.get(version) !== contentHash) return false;
    }
  }
  return true;
}

/**
 * Claims a fresh backup directory exclusively. The random suffix makes
 * collisions practically impossible; exclusive mkdir makes them harmless.
 */
async function claimBackupDir(backupRoot) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const backupId = `${makeTimestamp()}-${makeUniqueSuffix()}`;
    const backupDir = path.join(backupRoot, backupId);
    try {
      await fs.mkdir(backupDir);
      return { backupId, backupDir };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new WorkflowError('Could not allocate a unique backup directory after repeated attempts.');
}

/**
 * Creates a timestamped backup snapshot of a workflows repository.
 *
 * @param {object} params
 * @param {string} params.workflowsDir
 * @param {string} params.backupsDir
 * @returns {Promise<{ backupId: string, backupDir: string, manifest: object }>}
 */
export async function createRepositoryBackup({ workflowsDir, backupsDir }) {
  const source = path.resolve(workflowsDir);
  const backupRoot = path.resolve(backupsDir);
  if (isInside(source, backupRoot) || isInside(backupRoot, source)) {
    throw new WorkflowError('Backups must live outside the workflows repository (recursive backup protection).');
  }

  // A previous restore may have crashed mid-transaction; recover it before
  // snapshotting so a backup never captures a half-restored repository.
  await recoverInterruptedRestore({ workflowsDir: source, backupsDir: backupRoot });

  const workflows = await computeWorkflowHashes(source);

  await fs.mkdir(backupRoot, { recursive: true });
  const { backupId, backupDir } = await claimBackupDir(backupRoot);
  try {
    await fs.cp(source, path.join(backupDir, 'workflows'), { recursive: true });
    const manifest = {
      backupId,
      createdAt: new Date().toISOString(),
      sourceWorkflowsDir: source,
      workflows,
    };
    await fs.writeFile(path.join(backupDir, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { backupId, backupDir, manifest };
  } catch (err) {
    // Only ever removes the directory this call claimed exclusively.
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Validates a backup: metadata parses and every stored version's canonical
 * hash matches the recorded hash. Throws WorkflowError on any corruption.
 *
 * @param {string} backupDir
 * @returns {Promise<object>} The backup manifest
 */
export async function validateRepositoryBackup(backupDir) {
  const resolved = path.resolve(backupDir);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(resolved, 'backup.json'), 'utf8'));
  } catch (err) {
    throw new WorkflowError(`Backup at "${resolved}" is corrupt: backup.json is missing or invalid (${err.message}).`);
  }
  if (!manifest || !Array.isArray(manifest.workflows)) {
    throw new WorkflowError(`Backup at "${resolved}" is corrupt: backup.json has no workflow inventory.`);
  }

  let actual;
  try {
    actual = await computeWorkflowHashes(path.join(resolved, 'workflows'));
  } catch (err) {
    throw new WorkflowError(`Backup at "${resolved}" is corrupt: snapshot contents are unreadable or invalid (${err.message}).`);
  }
  if (!hashesMatchManifest(actual, manifest.workflows)) {
    throw new WorkflowError(`Backup at "${resolved}" is corrupt: snapshot content hashes do not match the backup record.`);
  }
  return manifest;
}

const TRANSACTION_FILE = '.restore-transaction.json';

function transactionPathFor(destination) {
  return path.join(path.dirname(destination), TRANSACTION_FILE);
}

async function writeTransaction(destination, record) {
  const filePath = transactionPathFor(destination);
  const tmpPath = `${filePath}.tmp-${makeUniqueSuffix()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function readTransaction(destination) {
  try {
    return JSON.parse(await fs.readFile(transactionPathFor(destination), 'utf8'));
  } catch {
    return null;
  }
}

async function clearTransaction(destination) {
  await fs.rm(transactionPathFor(destination), { force: true }).catch(() => {});
}

function simulatedCrash(phase) {
  const err = new WorkflowError(`Simulated crash during restore phase "${phase}".`);
  err.code = 'SIMULATED_CRASH';
  return err;
}

/**
 * Recovers a restore transaction interrupted by a crash. Safe to call at
 * any time; a no-op when no transaction is in flight.
 *
 * @param {object} params
 * @param {string} params.workflowsDir - The restore destination
 * @param {string} [params.backupsDir] - Accepted for call-site symmetry
 * @returns {Promise<{ recovered: boolean, action?: string }>}
 */
async function verifyTreeMatches(dir, expectedWorkflows) {
  if (!Array.isArray(expectedWorkflows)) return false;
  try {
    const actual = await computeWorkflowHashes(dir);
    return hashesMatchManifest(actual, expectedWorkflows);
  } catch {
    return false;
  }
}

async function loadBackupWorkflows(backupDir) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(path.resolve(backupDir), 'backup.json'), 'utf8'));
    return Array.isArray(manifest.workflows) ? manifest.workflows : null;
  } catch {
    return null;
  }
}

function ambiguousState(destination, detail) {
  return new WorkflowError(
    `Interrupted restore at "${destination}" is in an ambiguous filesystem state (${detail}). ` +
      'Nothing was deleted. The transaction journal was retained; inspect the destination, staging, and .pre-restore-* trees and intervene manually.'
  );
}

/**
 * Recovers a restore transaction interrupted by a crash.
 *
 * Recovery is filesystem-aware: the journal phase alone never proves a
 * rename did or did not occur. Ambiguous states (both destination and
 * preserved tree present unexpectedly, or neither) fail closed with the
 * journal retained and nothing deleted.
 *
 * @param {object} params
 * @param {string} params.workflowsDir - The restore destination
 * @returns {Promise<{ recovered: boolean, action?: string }>}
 */
export async function recoverInterruptedRestore({ workflowsDir }) {
  const destination = path.resolve(workflowsDir);
  const record = await readTransaction(destination);
  if (!record) {
    return { recovered: false };
  }

  const { phase, stagingDir, preservedPath, backupDir, originalWorkflows } = record;
  const destinationExists = await pathExists(destination);
  const preservedExists = preservedPath ? await pathExists(preservedPath) : false;
  const backupWorkflows = backupDir ? await loadBackupWorkflows(backupDir) : null;

  const cleanupStaging = async () => {
    if (stagingDir && (await pathExists(stagingDir))) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  };
  const finish = async (action) => {
    await cleanupStaging();
    await clearTransaction(destination);
    return { recovered: true, action };
  };
  const quarantineAndRestoreOriginal = async () => {
    if (destinationExists) {
      const failedPath = path.join(path.dirname(destination), `.failed-restore-${makeTimestamp()}-${makeUniqueSuffix()}`);
      await fs.rename(destination, failedPath);
    }
    await fs.rename(preservedPath, destination);
    if (Array.isArray(originalWorkflows) && !(await verifyTreeMatches(destination, originalWorkflows))) {
      throw ambiguousState(destination, 'restored original failed hash verification');
    }
    return finish('rolled-back');
  };

  if (phase === 'staged') {
    if (!preservedPath) {
      // Journal predates preservation planning: the original was never
      // scheduled to move. A missing destination here is not explainable.
      if (!destinationExists) {
        throw ambiguousState(destination, 'destination is missing with no preservation path recorded');
      }
      return finish('cleaned-staging');
    }
    // Case A: the preservation rename never happened.
    if (destinationExists && !preservedExists) {
      return finish('cleaned-staging');
    }
    // Case B: the destination was preserved but the journal was never
    // updated. Restore the original and verify it before cleaning up.
    if (!destinationExists && preservedExists) {
      await fs.rename(preservedPath, destination);
      if (Array.isArray(originalWorkflows) && !(await verifyTreeMatches(destination, originalWorkflows))) {
        throw ambiguousState(destination, 'restored original failed hash verification');
      }
      return finish('restored-original');
    }
    // Case C: both or neither — ambiguous; delete nothing, keep the journal.
    throw ambiguousState(
      destination,
      `destination ${destinationExists ? 'exists' : 'missing'}, preserved ${preservedExists ? 'exists' : 'missing'} in phase "staged"`
    );
  }

  if (phase === 'preserved') {
    if (!destinationExists && preservedExists) {
      await fs.rename(preservedPath, destination);
      if (Array.isArray(originalWorkflows) && !(await verifyTreeMatches(destination, originalWorkflows))) {
        throw ambiguousState(destination, 'restored original failed hash verification');
      }
      return finish('restored-original');
    }
    if (destinationExists && preservedExists) {
      // The swap rename happened but the journal was never updated (or the
      // swap completed). Never claim completion without verification.
      if (backupWorkflows && (await verifyTreeMatches(destination, backupWorkflows))) {
        return finish('completed-verified');
      }
      return quarantineAndRestoreOriginal();
    }
    if (destinationExists && !preservedExists) {
      // Consistent with a rollback that already restored the original, or a
      // completed swap whose preserved tree was relocated by the operator.
      if (backupWorkflows && (await verifyTreeMatches(destination, backupWorkflows))) {
        return finish('completed-verified');
      }
      if (Array.isArray(originalWorkflows) && (await verifyTreeMatches(destination, originalWorkflows))) {
        return finish('already-consistent');
      }
      throw ambiguousState(destination, 'destination matches neither the backup inventory nor the recorded original');
    }
    throw ambiguousState(destination, 'destination and preserved original are both missing in phase "preserved"');
  }

  if (phase === 'swapped') {
    if (destinationExists && backupWorkflows && (await verifyTreeMatches(destination, backupWorkflows))) {
      return finish('completed-verified');
    }
    if (destinationExists && preservedExists) {
      return quarantineAndRestoreOriginal();
    }
    if (!destinationExists && preservedExists) {
      await fs.rename(preservedPath, destination);
      return finish('restored-original');
    }
    if (destinationExists && !preservedExists) {
      throw ambiguousState(destination, 'swapped destination is invalid and no preserved original remains');
    }
    throw ambiguousState(destination, 'destination and preserved original are both missing in phase "swapped"');
  }

  if (phase === 'verified') {
    return finish('already-consistent');
  }

  throw ambiguousState(destination, `unknown transaction phase "${phase}"`);
}

/**
 * Restores a workflows repository from a validated backup using the
 * transaction protocol described in the module header.
 *
 * @param {object} params
 * @param {string} params.backupDir
 * @param {string} params.workflowsDir - Destination repository to replace
 * @param {string} params.backupsDir
 * @param {object} [params.hooks] - Test hooks invoked at phase boundaries
 * @param {string} [params.simulateCrashAt] - Test-only crash points: 'afterStaged', 'afterPreservationRename' (dest moved, journal still 'staged'), 'afterPreserved', 'afterSwapRename' (staged tree in place, journal still 'preserved'), 'afterSwap'
 * @param {Function} [params.rename] - Test-only rename override (EXDEV simulation)
 * @returns {Promise<{ backupId: string, preservedSnapshot: string | null }>}
 */
export async function restoreRepositoryBackup({ backupDir, workflowsDir, backupsDir, hooks = {}, simulateCrashAt, rename }) {
  const destination = path.resolve(workflowsDir);
  const backupRoot = path.resolve(backupsDir);
  const resolvedBackup = path.resolve(backupDir);
  if (isInside(destination, backupRoot) || isInside(backupRoot, destination)) {
    throw new WorkflowError('Backups must live outside the workflows repository (recursive backup protection).');
  }
  const renameOp = typeof rename === 'function' ? rename : fs.rename;

  // Recover any previously interrupted transaction before starting a new one.
  await recoverInterruptedRestore({ workflowsDir: destination, backupsDir: backupRoot });

  // 1. Validate the entire backup before touching the destination.
  const manifest = await validateRepositoryBackup(resolvedBackup);

  // 2. Stage beside the destination (same filesystem: copies are copies,
  //    renames are atomic) and verify every staged hash.
  const parentDir = path.dirname(destination);
  const stagingDir = path.join(parentDir, `.restore-staging-${makeUniqueSuffix()}`);
  await fs.mkdir(parentDir, { recursive: true });
  try {
    await fs.cp(path.join(resolvedBackup, 'workflows'), stagingDir, { recursive: true });
    const staged = await computeWorkflowHashes(stagingDir);
    if (!hashesMatchManifest(staged, manifest.workflows)) {
      throw new WorkflowError('Staged restore copy failed hash verification; destination left unchanged.');
    }
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // The intended preservation path and the original repository's hash
  // inventory are journaled BEFORE any rename, so recovery can resolve the
  // exact filesystem state even if the process dies immediately after a
  // rename but before the next phase update.
  const preservedPath = path.join(parentDir, `.pre-restore-${makeTimestamp()}-${makeUniqueSuffix()}`);
  const originalWorkflows = (await pathExists(destination)) ? await computeWorkflowHashes(destination) : [];
  let phase = 'staged';
  let preservedSnapshot = null;

  const checkpoint = async (nextPhase) => {
    phase = nextPhase;
    await writeTransaction(destination, {
      transactionId: makeUniqueSuffix(),
      phase,
      destination,
      stagingDir,
      preservedPath,
      originalWorkflows,
      backupDir: resolvedBackup,
      backupId: manifest.backupId,
      updatedAt: new Date().toISOString(),
    });
  };

  try {
    await checkpoint('staged');
    if (simulateCrashAt === 'afterStaged') throw simulatedCrash('afterStaged');
    await hooks.afterStaged?.();

    // 3. Preserve the existing destination under the journaled preservation
    //    path (same filesystem, atomic rename). The journal already records
    //    the intended path; verify that record before moving anything.
    if (await pathExists(destination)) {
      const recorded = await readTransaction(destination);
      if (!recorded || recorded.preservedPath !== preservedPath || recorded.phase !== 'staged') {
        throw new WorkflowError(
          'Restore journal could not be verified before the preservation rename; destination left unchanged.'
        );
      }
      await renameOp(destination, preservedPath);
      preservedSnapshot = preservedPath;
      if (simulateCrashAt === 'afterPreservationRename') throw simulatedCrash('afterPreservationRename');
      await checkpoint('preserved');
    }
    if (simulateCrashAt === 'afterPreserved') throw simulatedCrash('afterPreserved');
    await hooks.afterPreserved?.();

    // 4. Swap the staged repository into place.
    await hooks.beforeSwap?.();
    await renameOp(stagingDir, destination);
    if (simulateCrashAt === 'afterSwapRename') throw simulatedCrash('afterSwapRename');
    await checkpoint('swapped');
    if (simulateCrashAt === 'afterSwap') throw simulatedCrash('afterSwap');
    await hooks.afterSwap?.();

    // 5. Verify the swapped destination before finalizing.
    const actual = await computeWorkflowHashes(destination);
    if (!hashesMatchManifest(actual, manifest.workflows)) {
      throw new WorkflowError('Restored repository failed post-swap hash verification.');
    }

    await checkpoint('verified');
    await clearTransaction(destination);
    return { backupId: manifest.backupId, preservedSnapshot };
  } catch (err) {
    if (err && err.code === 'SIMULATED_CRASH') {
      // Emulate process death: leave journal, staging, preserved original,
      // and destination exactly as they are for recovery to resolve.
      throw err;
    }

    // Roll back: the preserved original (never deleted) returns to place.
    try {
      if (phase === 'swapped' && (await pathExists(destination))) {
        const failedPath = path.join(parentDir, `.failed-restore-${makeTimestamp()}-${makeUniqueSuffix()}`);
        await renameOp(destination, failedPath);
      }
      if (preservedSnapshot && (await pathExists(preservedSnapshot)) && !(await pathExists(destination))) {
        await renameOp(preservedSnapshot, destination);
      }
      if (await pathExists(stagingDir)) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }
      await clearTransaction(destination);
    } catch (rollbackErr) {
      throw new WorkflowError(
        `Restore failed (${err.message}) and rollback could not complete (${rollbackErr.message}). ` +
          `Recovery data is preserved beside the destination; run another backup or restore operation to trigger recovery.`
      );
    }
    throw err;
  }
}
