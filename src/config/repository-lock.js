/**
 * Super Memory — Exclusive Cross-Process Repository Lock
 *
 * The filesystem workflow repository serializes mutations within a single
 * process (per-workflow in-memory FIFO lock), but it cannot protect against
 * two processes — e.g. the local application server and a CLI invocation —
 * operating on the same repository at the same time.
 *
 * This module provides an exclusive, file-based lock for two resource
 * identities:
 *   1. The effective managed home (configuration, backups, audit data).
 *   2. The effective workflow repository directory (explicit
 *      --workflows-dir / WORKFLOWS_DIR may point outside the managed home).
 *
 * Both identities must be locked because either one can be mutated by an
 * operation that assumes sole ownership (backup, restore, migration,
 * promotion, discovery journals).
 *
 * Design notes:
 * - Lock files live in a dedicated lock directory (default
 *   `<tmp>/super-memory-locks/`, overridable via SUPER_MEMORY_LOCK_DIR),
 *   keyed by the SHA-1 of the canonical resource path. The lock therefore
 *   survives repository replacement (restore renames the workflows dir) and
 *   never pollutes the repository itself.
 * - Canonical identity resolves symlinks (realpath), so the same directory
 *   cannot be locked through two different path spellings.
 * - Acquisition uses atomic exclusive file creation ('wx') when the lock
 *   path is free. Stale locks (dead owner PID) are reclaimed only while
 *   holding a per-resource reclaim gate (itself a 'wx'-created record), so
 *   competing reclaimers are serialized and a reclaimer always re-verifies
 *   that the file still holds the exact record it inspected before moving
 *   anything. A record renamed aside whose nonce does not match the
 *   inspected stale record is NEVER deleted; acquisition then fails closed
 *   with actionable recovery instructions. A gate abandoned by a dead
 *   process is also never auto-removed: the reclaimer may have died
 *   mid-protocol, so the next contender fails closed too.
 * - Release verifies the owner nonce before unlinking, so a process can
 *   never remove another process's lock.
 * - No implicit reentrancy: a second acquisition from any process —
 *   including the same PID with a different nonce — fails while the lock
 *   is held by a live owner.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const LOCK_DIR_ENV_VAR = 'SUPER_MEMORY_LOCK_DIR';
export const MAX_RECLAIM_ATTEMPTS = 10;

export class RepositoryLockError extends Error {
  constructor(message, { code = 'LOCKED', lockFile = null, owner = null } = {}) {
    super(message);
    this.name = 'RepositoryLockError';
    this.code = code;
    this.lockFile = lockFile;
    this.owner = owner;
  }
}

/**
 * Directory holding lock files. Overridable for tests; never the default
 * managed home (locks must not live inside data they protect).
 */
export function getLockDir({ env = process.env } = {}) {
  const override = env?.[LOCK_DIR_ENV_VAR];
  if (typeof override === 'string' && override.trim() !== '') {
    return path.resolve(override.trim());
  }
  return path.join(os.tmpdir(), 'super-memory-locks');
}

/**
 * Canonical identity for a resource directory: absolute, symlink-resolved.
 * Missing directories resolve through the nearest existing ancestor so a
 * fresh (not yet created) home still maps to a stable identity.
 */
export async function canonicalResourceDir(dir) {
  const absolute = path.resolve(dir);
  try {
    return await fs.realpath(absolute);
  } catch {
    const parts = [];
    let cursor = absolute;
    for (;;) {
      try {
        const real = await fs.realpath(cursor);
        return parts.length > 0 ? path.join(real, ...parts.reverse()) : real;
      } catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) return absolute;
        parts.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }
}

function lockFileFor(lockDir, canonicalPath) {
  const digest = crypto.createHash('sha1').update(canonicalPath).digest('hex');
  return path.join(lockDir, `${digest}.lock`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: a live process we may not signal.
    if (err?.code === 'ESRCH') return false;
    return true;
  }
}

function describeOwner(owner) {
  if (!owner || typeof owner !== 'object') return 'unknown owner';
  const bits = [];
  if (owner.displayName) bits.push(String(owner.displayName));
  if (Number.isInteger(owner.pid)) bits.push(`pid ${owner.pid}`);
  if (owner.hostname) bits.push(`host ${owner.hostname}`);
  if (owner.startedAt) bits.push(`since ${owner.startedAt}`);
  return bits.length > 0 ? bits.join(', ') : 'unknown owner';
}

function recoveryInstructions(lockFile, owner) {
  return (
    `Repository resources are locked by another Super Memory process (${describeOwner(owner)}). ` +
    `Wait for that process to finish, then retry. ` +
    `If that process is definitely no longer running, verify with your process list ` +
    `and remove only the stale lock file "${lockFile}", then retry. ` +
    `Never remove a lock file while its owner process may still be running.`
  );
}

function buildRecord(displayName) {
  return {
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    nonce: crypto.randomBytes(16).toString('hex'),
    startedAt: new Date().toISOString(),
    displayName,
  };
}

async function readRecord(lockFile) {
  try {
    const raw = await fs.readFile(lockFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * True when a lock record is safe to reclaim: its owner is on this host
 * and verifiably dead. Cross-host, unreadable, same-process, or live
 * records are never reclaimable.
 */
function isReclaimableStale(record) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.hostname === 'string' && record.hostname !== os.hostname()) return false;
  if (Number.isInteger(record.pid) && record.pid === process.pid) return false;
  return Number.isInteger(record.pid) && !isProcessAlive(record.pid);
}

function gateFailureMessage(lockFile, gateFile, gateOwner, { interrupted } = {}) {
  const who = gateOwner ? ` (${describeOwner(gateOwner)})` : '';
  const action = interrupted
    ? `A previous stale-lock recovery for this resource appears to have been interrupted before it finished. ` +
      `The lock state may be halfway through reclamation, so it is never reclaimed automatically. ` +
      `Inspect "${lockFile}" and the recovery gate "${gateFile}", confirm no Super Memory process is ` +
      `holding the repository, then remove the stale gate file${gateOwner ? '' : ' (unreadable record)'} and retry.`
    : `Stale-lock recovery for this resource is already in progress by another process${who}. ` +
      `Wait for it to finish, then retry. If that process is definitely no longer running, ` +
      `inspect "${lockFile}" and the recovery gate "${gateFile}", then remove only the stale gate file and retry.`;
  return action;
}

/**
 * Takes the per-resource reclaim gate: a short-lived exclusive record
 * (`<lock>.reclaim`) serializing stale-lock reclamation. Never steals a
 * live or unverifiable gate; an abandoned gate fails closed.
 *
 * @returns {Promise<{ gateFile: string, record: object }>}
 */
async function acquireReclaimGate(lockFile, displayName) {
  const gateFile = `${lockFile}.reclaim`;
  const record = buildRecord(displayName);
  try {
    await fs.writeFile(gateFile, `${JSON.stringify({ ...record, gate: true })}\n`, { encoding: 'utf8', flag: 'wx' });
    return { gateFile, record };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  const owner = await readRecord(gateFile);
  if (!owner) {
    throw new RepositoryLockError(gateFailureMessage(lockFile, gateFile, null, { interrupted: false }), {
      code: 'LOCKED',
      lockFile: gateFile,
      owner: null,
    });
  }
  if (isReclaimableStale(owner)) {
    // The gate owner's process is dead, but the previous reclaimer may
    // have died between inspecting, renaming, and re-creating the lock;
    // that halfway state must never be "helpfully" continued.
    throw new RepositoryLockError(gateFailureMessage(lockFile, gateFile, owner, { interrupted: true }), {
      code: 'LOCKED',
      lockFile: gateFile,
      owner,
    });
  }
  throw new RepositoryLockError(gateFailureMessage(lockFile, gateFile, owner, { interrupted: false }), {
    code: 'LOCKED',
    lockFile: gateFile,
    owner,
  });
}

/**
 * Reclaims a stale lock while holding the reclaim gate.
 *
 * Under the gate, the lock file is re-read and must still hold the exact
 * inspected record (same nonce, still dead) before anything moves. The
 * stale file is then renamed aside and its identity verified before the
 * new lock is created exclusively. A renamed record whose nonce differs
 * from the inspected record is never deleted — it may be a live lock
 * displaced by this rename (reachable only if a participant ignored the
 * gate) — and acquisition fails closed with manual recovery instructions.
 *
 * @returns {Promise<object|null>} The acquired lock handle, or null when
 *   the lock state changed under the gate and the caller should re-evaluate.
 */
async function reclaimStaleLock(lockFile, staleRecord, mine, testHooks) {
  const gate = await acquireReclaimGate(lockFile, mine.displayName);
  try {
    const current = await readRecord(lockFile);
    if (!current || current.nonce !== staleRecord.nonce || !isReclaimableStale(current)) {
      // Changed since the unlocked inspection (e.g. a competitor finished
      // reclaiming and now holds a live lock). Touch nothing.
      return null;
    }

    const aside = `${lockFile}.stale.${mine.nonce}`;
    const recordPath = `${aside}.record`;
    try {
      await fs.writeFile(aside, `${JSON.stringify({ ...mine, reclaims: staleRecord.nonce || null })}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch {
      return null; // Nonce collision on our own marker; re-evaluate.
    }

    if (testHooks?.beforeStaleRename) await testHooks.beforeStaleRename(lockFile, current);
    try {
      await fs.rename(lockFile, recordPath);
    } catch (err) {
      await fs.unlink(aside).catch(() => {});
      if (err?.code === 'ENOENT') return null; // Vanished mid-protocol; re-evaluate.
      throw err;
    }

    const moved = await readRecord(recordPath);
    if (!moved || moved.nonce !== staleRecord.nonce) {
      // NEVER delete the renamed record: it may be a live process's lock
      // displaced by our rename. Park it and fail closed with the exact
      // paths an operator needs to restore it manually.
      const ownerNote = moved ? ` It currently holds a record for (${describeOwner(moved)}).` : '';
      throw new RepositoryLockError(
        `Lock state changed while reclaiming "${lockFile}": the renamed record does not match the ` +
          `stale record that was inspected, so nothing was removed.${ownerNote} ` +
          `The renamed record was left untouched at "${recordPath}". If that record belongs to a ` +
          `process that is no longer running, you may restore it by renaming it back onto ` +
          `"${lockFile}" and retrying. Never delete a lock record whose owner may still be running.`,
        { code: 'LOCKED', lockFile, owner: moved }
      );
    }

    // Stale record confirmed aside; claim the lock exclusively. A normal
    // acquirer may have slipped into the free path in the rename window —
    // that is safe: 'wx' fails and the caller re-evaluates.
    try {
      await fs.writeFile(lockFile, `${JSON.stringify(mine)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      await fs.unlink(aside).catch(() => {});
      if (err?.code === 'EEXIST') return null;
      throw err;
    }
    await fs.unlink(recordPath).catch(() => {});
    await fs.unlink(aside).catch(() => {});
    return { lockFile, record: mine };
  } finally {
    // Gate release is nonce-verified; a failure means someone tampered
    // with the gate, in which case removing it would be the unsafe act.
    await releaseOne(gate.gateFile, gate.record.nonce).catch(() => {});
  }
}

/**
 * Acquires the exclusive lock for one canonical resource path.
 *
 * @returns {Promise<object>} The owner record written to the lock file.
 * @throws {RepositoryLockError} When the resource is locked or ownership is ambiguous.
 */
async function acquireOne(lockDir, canonicalPath, displayName, testHooks) {
  const lockFile = lockFileFor(lockDir, canonicalPath);
  await fs.mkdir(lockDir, { recursive: true });
  const mine = buildRecord(displayName);
  const payload = `${JSON.stringify(mine)}\n`;

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      await fs.writeFile(lockFile, payload, { encoding: 'utf8', flag: 'wx' });
      return { lockFile, record: mine };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const existing = await readRecord(lockFile);
    if (!existing) {
      // Unreadable record: ownership is ambiguous. Never steal it.
      throw new RepositoryLockError(recoveryInstructions(lockFile, null), {
        code: 'LOCKED',
        lockFile,
        owner: null,
      });
    }

    const crossHost = typeof existing.hostname === 'string' && existing.hostname !== os.hostname();
    const sameProcess = Number.isInteger(existing.pid) && existing.pid === process.pid;
    const alive = !crossHost && isProcessAlive(existing.pid);

    if (alive || crossHost || sameProcess) {
      // Live owner (possibly ourselves under a different nonce: no
      // implicit reentrancy), or an owner on another host whose liveness
      // we cannot verify. Fail closed in all cases.
      throw new RepositoryLockError(recoveryInstructions(lockFile, existing), {
        code: 'LOCKED',
        lockFile,
        owner: existing,
      });
    }

    if (testHooks?.afterStaleInspect) await testHooks.afterStaleInspect(lockFile, existing);

    // Stale lock (dead PID on this host). Reclamation is the only step
    // allowed to move or remove an existing lock file, and it runs only
    // while holding the per-resource reclaim gate (see reclaimStaleLock).
    // When the gate reports the state changed mid-protocol, re-evaluate
    // from scratch within the attempt budget.
    const reclaimed = await reclaimStaleLock(lockFile, existing, mine, testHooks);
    if (reclaimed) {
      return reclaimed;
    }
  }

  throw new RepositoryLockError(
    `Could not acquire the repository lock for "${canonicalPath}" after ${MAX_RECLAIM_ATTEMPTS} attempts. ` +
      `Another process may be racing for the same lock. Wait briefly and retry.`,
    { code: 'LOCKED', lockFile: lockFileFor(lockDir, canonicalPath) }
  );
}

/**
 * Releases one lock file, but only when it still holds our owner nonce.
 * Missing files are treated as already released. Foreign or unreadable
 * lock files are never removed.
 */
async function releaseOne(lockFile, nonce) {
  let raw;
  try {
    raw = await fs.readFile(lockFile, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch {
    record = null;
  }
  if (!record || record.nonce !== nonce) {
    throw new RepositoryLockError(
      `Refusing to release "${lockFile}": it is not owned by this process.`,
      { code: 'NOT_OWNER', lockFile, owner: record }
    );
  }
  await fs.unlink(lockFile);
  return true;
}

/**
 * Acquires exclusive locks for the effective managed home and the effective
 * workflow repository directory, in deterministic (sorted) order. Partial
 * acquisitions are released if any lock fails.
 *
 * @param {object} [options]
 * @param {string} options.home - Effective managed home directory.
 * @param {string} options.workflowsDir - Effective workflow repository directory.
 * @param {string} [options.displayName] - Owner label recorded in the lock.
 * @param {string} [options.lockDir] - Override for the lock directory.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.testHooks] - Test-only synchronization seams
 *   (`afterStaleInspect`, `beforeStaleRename`). Never supplied in production.
 * @returns {Promise<object>} Handle with `{ resources, release() }`.
 */
export async function acquireRepositoryLocks({ home, workflowsDir, displayName = 'super-memory', lockDir, env = process.env, testHooks = undefined } = {}) {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new RepositoryLockError('Cannot lock repository resources: no home directory resolved.', { code: 'INVALID' });
  }
  if (typeof workflowsDir !== 'string' || workflowsDir.trim() === '') {
    throw new RepositoryLockError('Cannot lock repository resources: no workflows directory resolved.', { code: 'INVALID' });
  }
  const dir = lockDir || getLockDir({ env });
  const canonicals = [...new Set([await canonicalResourceDir(home), await canonicalResourceDir(workflowsDir)])].sort();
  const acquired = [];
  try {
    for (const canonical of canonicals) {
      acquired.push(await acquireOne(dir, canonical, displayName, testHooks));
    }
  } catch (err) {
    for (const item of acquired.reverse()) {
      await releaseOne(item.lockFile, item.record.nonce).catch(() => {});
    }
    throw err;
  }
  const nonces = new Map(acquired.map((item) => [item.lockFile, item.record.nonce]));
  let released = false;
  return {
    resources: canonicals,
    lockDir: dir,
    async release() {
      if (released) return;
      released = true;
      for (const item of acquired.reverse()) {
        await releaseOne(item.lockFile, nonces.get(item.lockFile));
      }
    },
  };
}
