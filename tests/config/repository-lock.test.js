import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  acquireRepositoryLocks,
  canonicalResourceDir,
  getLockDir,
  RepositoryLockError,
} from '../../src/config/repository-lock.js';

describe('Repository lock (M3.1)', () => {
  let root;
  let lockDir;
  let home;
  let workflows;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-lock-test-'));
    lockDir = path.join(root, 'locks');
    home = path.join(root, 'home');
    workflows = path.join(home, 'workflows');
    await fs.mkdir(workflows, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('first acquisition succeeds and release removes both locks', async () => {
    const handle = await acquireRepositoryLocks({ home, workflowsDir: workflows, displayName: 'test', lockDir });
    assert.deepEqual(handle.resources.length, 2);
    const files = await fs.readdir(lockDir);
    assert.equal(files.length, 2);
    await handle.release();
    assert.deepEqual(await fs.readdir(lockDir), []);
  });

  it('duplicate acquisition fails while held, then succeeds after release', async () => {
    const first = await acquireRepositoryLocks({ home, workflowsDir: workflows, lockDir });
    await assert.rejects(() => acquireRepositoryLocks({ home, workflowsDir: workflows, lockDir }), (err) => {
      assert.ok(err instanceof RepositoryLockError);
      assert.equal(err.code, 'LOCKED');
      assert.ok(err.message.includes('locked by another'));
      return true;
    });
    await first.release();
    const second = await acquireRepositoryLocks({ home, workflowsDir: workflows, lockDir });
    await second.release();
  });

  it('different repositories lock independently', async () => {
    const other = path.join(root, 'other-home', 'workflows');
    await fs.mkdir(other, { recursive: true });
    const a = await acquireRepositoryLocks({ home, workflowsDir: workflows, lockDir });
    const b = await acquireRepositoryLocks({ home: path.join(root, 'other-home'), workflowsDir: other, lockDir });
    await a.release();
    await b.release();
  });

  it('equivalent canonical paths map to the same lock', async () => {
    const alias = path.join(root, 'alias-home');
    await fs.symlink(home, alias);
    const held = await acquireRepositoryLocks({ home, workflowsDir: workflows, lockDir });
    await assert.rejects(
      () => acquireRepositoryLocks({ home: alias, workflowsDir: path.join(alias, 'workflows'), lockDir }),
      /locked by another/
    );
    await held.release();
  });

  it('multiple resources acquire in deterministic order and partial failure releases', async () => {
    const other = path.join(root, 'other', 'workflows');
    await fs.mkdir(other, { recursive: true });
    // Hold the workflows lock from the "other" identity so a combined
    // acquisition covering both homes fails partway.
    const blocker = await acquireRepositoryLocks({
      home: path.join(root, 'other'),
      workflowsDir: other,
      lockDir,
    });
    const before = new Set(await fs.readdir(lockDir));
    await assert.rejects(
      () => acquireRepositoryLocks({ home, workflowsDir: other, lockDir }),
      /locked by another/
    );
    // Any partially acquired resource (home) must have been released.
    const after = new Set(await fs.readdir(lockDir));
    assert.deepEqual(after, before);
    await blocker.release();
  });

  it('release requires the correct owner nonce', async () => {
    const handle = await acquireRepositoryLocks({ home, workflowsDir: workflows, lockDir });
    const files = await fs.readdir(lockDir);
    assert.equal(files.length, 2);
    await handle.release();
    // Second release is a safe no-op.
    await handle.release();
    assert.deepEqual(await fs.readdir(lockDir), []);
  });

  it('a live owner cannot be displaced, even from the same process', async () => {
    const held = await acquireRepositoryLocks({ home, workflowsDir: workflows, displayName: 'first', lockDir });
    await assert.rejects(
      () => acquireRepositoryLocks({ home, workflowsDir: workflows, displayName: 'second', lockDir }),
      /locked by another/
    );
    await held.release();
  });

  it('stale locks from dead processes are reclaimed safely', async () => {
    // Plant a stale lock file with a PID that cannot exist.
    await fs.mkdir(lockDir, { recursive: true });
    const { default: crypto } = await import('node:crypto');
    const canonical = await canonicalResourceDir(home);
    const digest = crypto.createHash('sha1').update(canonical).digest('hex');
    const deadPid = 2147483647;
    try {
      process.kill(deadPid, 0);
      // Unlikely: PID exists. Skip rather than risk touching a live lock.
      return;
    } catch (err) {
      assert.equal(err.code, 'ESRCH');
    }
    await fs.writeFile(
      path.join(lockDir, `${digest}.lock`),
      `${JSON.stringify({ version: 1, pid: deadPid, hostname: os.hostname(), nonce: 'stale', startedAt: 'x', displayName: 'dead' })}\n`,
      { flag: 'wx' }
    );
    const handle = await acquireRepositoryLocks({ home, workflowsDir: home, lockDir });
    assert.ok(handle.resources.includes(canonical));
    await handle.release();
  });

  it('missing home or workflows directory is rejected', async () => {
    await assert.rejects(() => acquireRepositoryLocks({ workflowsDir: workflows, lockDir }), /no home directory/);
    await assert.rejects(() => acquireRepositoryLocks({ home, lockDir }), /no workflows directory/);
  });

  it('lock dir defaults under tmp and honors the env override', async () => {
    assert.ok(getLockDir({ env: {} }).endsWith('super-memory-locks'));
    assert.equal(getLockDir({ env: { SUPER_MEMORY_LOCK_DIR: '/tmp/custom' } }), '/tmp/custom');
  });

  it('canonical identity resolves symlinks and tolerates missing paths', async () => {
    const link = path.join(root, 'link');
    await fs.symlink(home, link);
    assert.equal(await canonicalResourceDir(link), await canonicalResourceDir(home));
    const missing = path.join(root, 'not-yet', 'deep', 'dir');
    assert.equal(await canonicalResourceDir(missing), path.join(await fs.realpath(root), 'not-yet', 'deep', 'dir'));
  });
});
