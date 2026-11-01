import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import {
  acquireRepositoryLocks,
  canonicalResourceDir,
  RepositoryLockError,
} from '../../src/config/repository-lock.js';

const LOCK_MOD_URL = pathToFileURL(path.resolve(import.meta.dirname, '..', '..', 'src', 'config', 'repository-lock.js')).href;

/**
 * Deterministic child-process drivers for stale-reclamation races.
 *
 * Each child prints a single terminal line:
 *   <ROLE>-ACQUIRED   lock held (then waits for GO-RELEASE, releases, exits 0)
 *   <ROLE>-LOCKED     acquisition correctly refused
 *   <ROLE>-RELEASED   holder released after GO-RELEASE
 *
 * Child A additionally parks inside the test-only `afterStaleInspect` seam
 * until the parent writes the GO file, so the classic interleaving —
 * "read stale record, competitor reclaims, then act" — is reproduced
 * exactly instead of being left to scheduling luck.
 */

const CHILD_SOURCE = `
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
const { acquireRepositoryLocks } = await import(process.env.SM_LOCKMOD);
const role = process.env.SM_ROLE;
async function poll(file) {
  for (let i = 0; i < 600; i += 1) {
    try { await fs.access(file); return; } catch { await sleep(25); }
  }
  throw new Error('timed out waiting for ' + file);
}
const common = {
  home: process.env.SM_RES,
  workflowsDir: process.env.SM_RES,
  lockDir: process.env.SM_LOCKDIR,
  displayName: 'child-' + role,
};
try {
  const hooks = role === 'A'
    ? { afterStaleInspect: async () => {
        await fs.writeFile(process.env.SM_READY, 'ready');
        await poll(process.env.SM_GO);
      } }
    : undefined;
  const handle = await acquireRepositoryLocks({ ...common, testHooks: hooks });
  console.log(role + '-ACQUIRED');
  await fs.writeFile(process.env.SM_HELD, 'held');
  await poll(process.env.SM_GO_RELEASE);
  await handle.release();
  console.log(role + '-RELEASED');
} catch (err) {
  console.log(role + '-' + (err.code || err.name));
}
`;

function runChild(root, label, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return {
    child,
    label,
    async waitForLine(prefix = '') {
      for (let i = 0; i < 400; i += 1) {
        const line = stdout.split('\n').find((l) => l.trim() !== '' && l.trim().startsWith(prefix));
        if (line) return line.trim();
        if (child.exitCode !== null) break;
        await sleep(25);
      }
      throw new Error(`${label} produced no "${prefix}" output. stdout: ${stdout} stderr: ${stderr}`);
    },
    async waitExit() {
      if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
      return new Promise((resolve) => {
        child.on('exit', (code) => resolve(code));
      });
    },
  };
}

describe('Repository lock stale-reclamation race (M3.1 fix)', () => {
  let root;
  let resource;
  let lockDir;
  let lockFile;
  let markers;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-lock-race-'));
    resource = path.join(root, 'res');
    lockDir = path.join(root, 'locks');
    markers = path.join(root, 'markers');
    await fs.mkdir(resource, { recursive: true });
    await fs.mkdir(lockDir, { recursive: true });
    await fs.mkdir(markers, { recursive: true });
    const canonical = await canonicalResourceDir(resource);
    const digest = crypto.createHash('sha1').update(canonical).digest('hex');
    lockFile = path.join(lockDir, `${digest}.lock`);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function plantStaleLock() {
    const deadPid = 2147483647;
    try {
      process.kill(deadPid, 0);
      return null; // Unusable PID on this host; test cannot run.
    } catch (err) {
      if (err.code !== 'ESRCH') return null;
    }
    await fs.writeFile(
      lockFile,
      `${JSON.stringify({
        version: 1,
        pid: deadPid,
        hostname: os.hostname(),
        nonce: 'stale-original',
        startedAt: new Date().toISOString(),
        displayName: 'dead-owner',
      })}\n`,
      { flag: 'wx' }
    );
    return true;
  }

  function childEnv(role) {
    return {
      SM_LOCKMOD: LOCK_MOD_URL,
      SM_RES: resource,
      SM_LOCKDIR: lockDir,
      SM_ROLE: role,
      SM_READY: path.join(markers, `ready-${role}`),
      SM_GO: path.join(markers, 'go-A'),
      SM_HELD: path.join(markers, `held-${role}`),
      SM_GO_RELEASE: path.join(markers, 'go-release'),
    };
  }

  it('A resumes after B reclaimed: A is refused and B\'s live lock is untouched', async () => {
    if (!(await plantStaleLock())) return;

    const a = runChild(root, 'A', childEnv('A'));
    // A has inspected the stale record and is parked before acting on it.
    for (let i = 0; i < 400; i += 1) {
      try { await fs.access(path.join(markers, 'ready-A')); break; } catch { await sleep(25); }
    }

    const b = runChild(root, 'B', childEnv('B'));
    assert.equal(await b.waitForLine(), 'B-ACQUIRED');
    for (let i = 0; i < 400; i += 1) {
      try { await fs.access(path.join(markers, 'held-B')); break; } catch { await sleep(25); }
    }

    // B's lock is the live one now. Snapshot it byte for byte.
    const liveBytes = await fs.readFile(lockFile, 'utf8');
    const liveNonce = JSON.parse(liveBytes).nonce;
    assert.notEqual(liveNonce, 'stale-original');

    // Let A act on its stale inspection. Old code renamed B's live file
    // aside, deleted it on nonce mismatch, then took the lock itself.
    await fs.writeFile(path.join(markers, 'go-A'), 'go');
    assert.equal(await a.waitForLine(), 'A-LOCKED', 'A must be refused, not acquire');

    // B's lock must still be present, byte-identical, and enforceable.
    assert.equal(await fs.readFile(lockFile, 'utf8'), liveBytes);
    await assert.rejects(
      () => acquireRepositoryLocks({ home: resource, workflowsDir: resource, lockDir, displayName: 'parent' }),
      /locked by another/
    );

    await fs.writeFile(path.join(markers, 'go-release'), 'release');
    assert.equal(await b.waitForLine('B-RELEASED'), 'B-RELEASED');
    await a.waitExit();
    await b.waitExit();

    // After B releases, the resource is acquirable again.
    const handle = await acquireRepositoryLocks({ home: resource, workflowsDir: resource, lockDir, displayName: 'parent' });
    await handle.release();
    assert.deepEqual((await fs.readdir(lockDir)).filter((f) => f.endsWith('.lock')), []);
  }, { timeout: 60000 });

  it('two reclaimers race a stale lock: exactly one wins, the other is refused', async () => {
    if (!(await plantStaleLock())) return;

    // GO already exists, so child A's seam returns immediately; both
    // children genuinely race the stale reclamation.
    await fs.writeFile(path.join(markers, 'go-A'), 'go');
    const d1 = runChild(root, 'A', childEnv('A'));
    const d2 = runChild(root, 'B', childEnv('B'));
    const [l1, l2] = await Promise.all([d1.waitForLine(), d2.waitForLine()]);
    const outcomes = [l1, l2].sort();
    assert.equal(outcomes.filter((l) => l.endsWith('-ACQUIRED')).length, 1, `outcomes: ${outcomes}`);
    assert.equal(outcomes.filter((l) => l.endsWith('-LOCKED')).length, 1, `outcomes: ${outcomes}`);

    // The winner's lock is enforceable by the parent.
    await assert.rejects(
      () => acquireRepositoryLocks({ home: resource, workflowsDir: resource, lockDir, displayName: 'parent' }),
      /locked by another/
    );
    await fs.writeFile(path.join(markers, 'go-release'), 'release');
  }, { timeout: 60000 });

  it('a stale reclaim gate fails closed instead of being auto-removed', async () => {
    if (!(await plantStaleLock())) return;
    const gateFile = `${lockFile}.reclaim`;
    await fs.writeFile(
      gateFile,
      `${JSON.stringify({
        version: 1,
        pid: 2147483647,
        hostname: os.hostname(),
        nonce: 'dead-gate',
        startedAt: new Date().toISOString(),
        displayName: 'crashed-reclaimer',
      })}\n`,
      { flag: 'wx' }
    );
    const beforeLock = await fs.readFile(lockFile, 'utf8');
    const beforeGate = await fs.readFile(gateFile, 'utf8');

    await assert.rejects(
      () => acquireRepositoryLocks({ home: resource, workflowsDir: resource, lockDir, displayName: 'parent' }),
      (err) => {
        assert.ok(err instanceof RepositoryLockError);
        assert.equal(err.code, 'LOCKED');
        assert.ok(err.message.includes('.reclaim'), `message should mention the gate file: ${err.message}`);
        return true;
      }
    );
    // Nothing was displaced or deleted.
    assert.equal(await fs.readFile(lockFile, 'utf8'), beforeLock);
    assert.equal(await fs.readFile(gateFile, 'utf8'), beforeGate);
  });

  it('a record swapped in after inspection is never unlinked by the rename path', async () => {
    // In-process seam: between the stale inspection and the rename, a fresh
    // live record appears. The rename may displace it into the .record file,
    // but the displaced record must survive intact.
    const deadPid = 2147483647;
    try {
      process.kill(deadPid, 0);
      return;
    } catch (err) {
      if (err.code !== 'ESRCH') return;
    }
    await fs.writeFile(
      lockFile,
      `${JSON.stringify({ version: 1, pid: deadPid, hostname: os.hostname(), nonce: 'stale-inprocess', startedAt: 'x', displayName: 'dead' })}\n`,
      { flag: 'wx' }
    );
    const liveRecord = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      hostname: os.hostname(),
      nonce: 'live-planted',
      startedAt: new Date().toISOString(),
      displayName: 'live-owner',
    })}\n`;

    await assert.rejects(
      () => acquireRepositoryLocks({
        home: resource,
        workflowsDir: resource,
        lockDir,
        displayName: 'parent',
        testHooks: {
          beforeStaleRename: async () => {
            await fs.writeFile(lockFile, liveRecord);
          },
        },
      }),
      /locked by another|changed while reclaiming/
    );

    // Whatever path holds the live record, its bytes must survive intact.
    const files = await fs.readdir(lockDir);
    const holders = [];
    for (const file of files) {
      const full = path.join(lockDir, file);
      try {
        const raw = await fs.readFile(full, 'utf8');
        if (raw === liveRecord) holders.push(file);
      } catch {}
    }
    assert.equal(holders.length, 1, `live record must survive intact exactly once; lock dir: ${files}`);
  });
});
