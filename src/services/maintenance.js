/**
 * Super Memory — Repository Maintenance Service (M2 Phase 2)
 *
 * Migration, backup, backup validation, and restore orchestration extracted
 * from the Operator CLI so a future local web application can reuse the same
 * behavior without terminal I/O:
 * - migrate: copy-only, hash-validated repository import
 * - backup: timestamped snapshot creation
 * - validate: backup integrity verification
 * - restore: transactional replacement with rollback and crash recovery
 * - snapshotBeforePromotion: managed-repository safety snapshot reused by
 *   promotion (current CLI caller) and the future Promotion Service
 *
 * Design rules for this service:
 * - Dependencies are explicit: the repository, backups directory,
 *   managed-home flag, audit sink, and home-ensuring callback are supplied
 *   by the caller. No CLI arguments, stdout/stderr, readline, process.exit,
 *   or terminal formatting lives here.
 * - Returns structured results. Progress text and exit codes stay in
 *   `src/cli/operator.js`.
 * - Reuses the existing domain modules without duplicating their logic:
 *   `src/workflow/migration.js` and `src/config/backup.js` remain the
 *   implementations of record for containment, symlink rejection, hashing,
 *   transactional restore, and crash recovery.
 * - Restore replaces the underlying repository directory, so `restoreBackup`
 *   returns a fresh repository handle bound to the (same) directory. Callers
 *   must adopt it; per-call service construction (as the CLI does) makes
 *   stale handles impossible.
 * - Audit is best-effort and privacy-safe: only allow-listed event fields
 *   are emitted, failures never break the operation they describe, and raw
 *   secrets are never accepted, returned, logged, or persisted here.
 * - No browser runtime or model provider is required or accepted.
 */

import path from 'node:path';

import {
  FileSystemWorkflowRepository,
  WorkflowError,
} from '../workflow/index.js';
import { migrateRepository as runMigration } from '../workflow/migration.js';
import {
  createRepositoryBackup,
  restoreRepositoryBackup,
  validateRepositoryBackup,
} from '../config/backup.js';

/**
 * Creates a maintenance service bound to one repository context.
 *
 * @param {object} [options]
 * @param {object} [options.repository] - Active workflow repository (required).
 * @param {string} [options.backupsDir] - Backups directory (required for
 *   backup/restore/snapshot operations; unused by migrate-only callers).
 * @param {boolean} [options.isManaged] - Whether the active repository is
 *   the managed home repository. Controls home-ensuring and default audit
 *   gating. Evaluated once per factory call; callers with a replaceable
 *   repository should construct the service per operation (as the CLI does).
 * @param {Function} [options.audit] - Optional audit sink with the CLI
 *   `_audit(event, { managedOnly })` contract. Invoked best-effort.
 * @param {Function} [options.ensureHome] - Optional `async () => void`
 *   ensuring managed-home directories exist. Invoked where the CLI invokes it.
 * @returns {{ repository: object, migrateRepository: Function, createBackup: Function, validateBackup: Function, restoreBackup: Function, snapshotBeforePromotion: Function }}
 */
export function createMaintenanceService({
  repository,
  backupsDir,
  isManaged = false,
  audit = null,
  ensureHome = null,
} = {}) {
  if (!repository) {
    throw new WorkflowError('Maintenance service requires a repository.');
  }
  const context = { repository, backupsDir, isManaged, audit, ensureHome };
  return {
    get repository() {
      return context.repository;
    },
    migrateRepository: (sourceDir) => migrateRepository(context, sourceDir),
    createBackup: () => createBackup(context),
    validateBackup: (backupDir) => validateBackup(backupDir),
    restoreBackup: (backupDir, testHooks) => restoreBackup(context, backupDir, testHooks),
    snapshotBeforePromotion: () => snapshotBeforePromotion(context),
  };
}

/**
 * Best-effort audit emission. Audit failures never break the operation they
 * describe, matching CLI `_audit` semantics.
 */
async function auditSafe(context, event, options) {
  if (typeof context.audit !== 'function') return;
  try {
    await context.audit(event, options);
  } catch {}
}

function requireBackupsDir(context, operation) {
  if (!context.backupsDir) {
    throw new WorkflowError(`Maintenance service requires a backups directory for ${operation}.`);
  }
  return context.backupsDir;
}

/**
 * Imports workflows from a source repository into the active repository.
 * Copy-only, hash-validated, never overwrites; safe to repeat.
 *
 * @param {object} context - Service context (see factory).
 * @param {string} sourceDir
 * @returns {Promise<{ imported: object[], skipped: object[] }>}
 */
export async function migrateRepository(context, sourceDir) {
  if (!sourceDir) {
    throw new WorkflowError('migrate requires --from <source-repository>.');
  }
  if (context.isManaged && typeof context.ensureHome === 'function') {
    await context.ensureHome();
  }
  const report = await runMigration({ sourceDir, destinationDir: context.repository.baseDir });
  for (const item of report.imported) {
    await auditSafe(context, {
      type: 'import',
      workflowId: item.workflowId,
      version: item.versions[item.versions.length - 1],
      contentHash: item.contentHashes[item.versions[item.versions.length - 1]],
      source: path.resolve(sourceDir),
      imported: item.versions.length,
    });
  }
  return report;
}

/**
 * Creates a timestamped backup snapshot of the active repository.
 *
 * @param {object} context - Service context (see factory).
 * @returns {Promise<{ backupId: string, backupDir: string, manifest: object }>}
 */
export async function createBackup(context) {
  const backupsDir = requireBackupsDir(context, 'backup');
  if (typeof context.ensureHome === 'function') {
    await context.ensureHome();
  }
  const result = await createRepositoryBackup({
    workflowsDir: context.repository.baseDir,
    backupsDir,
  });
  await auditSafe(
    context,
    { type: 'backup', backupId: result.backupId, destination: result.backupDir },
    { managedOnly: false }
  );
  return result;
}

/**
 * Validates a backup snapshot without touching any repository.
 *
 * @param {string} backupDir
 * @returns {Promise<object>} The backup manifest. Throws on any corruption.
 */
export async function validateBackup(backupDir) {
  return validateRepositoryBackup(backupDir);
}

/**
 * Restores the active repository from a validated backup snapshot.
 * Transactional with rollback and crash recovery (see `src/config/backup.js`).
 * Returns a fresh repository handle that the caller must adopt.
 *
 * @param {object} context - Service context (see factory). `context.repository`
 *   is replaced with the fresh handle before returning.
 * @param {string} backupDir
 * @param {object} [testHooks] - Test-only passthrough (`hooks`,
 *   `simulateCrashAt`, `rename`) for crash-recovery tests.
 * @returns {Promise<{ backupId: string, preservedSnapshot: string|null, repository: object }>}
 */
export async function restoreBackup(context, backupDir, testHooks = {}) {
  if (!backupDir) {
    throw new WorkflowError('restore requires --from <backup-directory>.');
  }
  const backupsDir = requireBackupsDir(context, 'restore');
  if (typeof context.ensureHome === 'function') {
    await context.ensureHome();
  }
  const result = await restoreRepositoryBackup({
    backupDir,
    workflowsDir: context.repository.baseDir,
    backupsDir,
    hooks: testHooks.hooks,
    simulateCrashAt: testHooks.simulateCrashAt,
    rename: testHooks.rename,
  });
  await auditSafe(
    context,
    { type: 'restore', backupId: result.backupId, source: path.resolve(backupDir) },
    { managedOnly: false }
  );
  // The replaced directory must be re-read through a fresh handle; the old
  // object may retain stale in-memory state.
  const fresh = new FileSystemWorkflowRepository({ baseDir: context.repository.baseDir });
  context.repository = fresh;
  return { backupId: result.backupId, preservedSnapshot: result.preservedSnapshot, repository: fresh };
}

/**
 * Safety snapshot for managed repositories before promotion. No-op for
 * non-managed repositories. Failure aborts the caller (promotion) before
 * anything changes, with the exact historical error message.
 *
 * @param {object} context - Service context (see factory).
 * @returns {Promise<object|null>} The backup result, or null when no snapshot
 *   was needed.
 */
export async function snapshotBeforePromotion(context) {
  if (!context.isManaged) {
    return null;
  }
  const backupsDir = requireBackupsDir(context, 'promotion snapshot');
  try {
    return await createRepositoryBackup({
      workflowsDir: context.repository.baseDir,
      backupsDir,
    });
  } catch (err) {
    throw new WorkflowError(`Pre-promotion backup failed; promotion aborted: ${err.message}`);
  }
}
