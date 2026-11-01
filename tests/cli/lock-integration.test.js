import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acquireRepositoryLocks } from '../../src/config/repository-lock.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'super-memory.js');

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe('CLI repository-lock integration (M3.1)', () => {
  let root;
  let home;
  let lockDir;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-cli-lock-'));
    home = path.join(root, 'home');
    lockDir = path.join(root, 'locks');
    await fs.mkdir(path.join(home, 'workflows'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function childEnv() {
    return {
      ...process.env,
      SUPER_MEMORY_HOME: home,
      SUPER_MEMORY_LOCK_DIR: lockDir,
    };
  }

  it('blocks a CLI command while another process owns the lock', async () => {
    const holder = await acquireRepositoryLocks({
      home,
      workflowsDir: path.join(home, 'workflows'),
      displayName: 'super-memory-app',
      lockDir,
    });
    try {
      const blocked = await runCli(['list'], childEnv());
      assert.equal(blocked.code, 1);
      assert.ok(blocked.stderr.includes('locked by another'), `stderr was: ${blocked.stderr}`);
    } finally {
      await holder.release();
    }
    const allowed = await runCli(['list'], childEnv());
    assert.equal(allowed.code, 0);
    assert.ok(allowed.stdout.includes('No workflows found'));
  });

  it('help works without acquiring the lock', async () => {
    const holder = await acquireRepositoryLocks({
      home,
      workflowsDir: path.join(home, 'workflows'),
      displayName: 'super-memory-app',
      lockDir,
    });
    try {
      const help = await runCli(['--help'], childEnv());
      assert.equal(help.code, 0);
      assert.ok(help.stdout.includes('super-memory'));
    } finally {
      await holder.release();
    }
  });

  it('releases the lock after a successful command', async () => {
    const first = await runCli(['list'], childEnv());
    assert.equal(first.code, 0);
    assert.deepEqual(await fs.readdir(lockDir).catch(() => []), []);
    const second = await runCli(['integrity'], childEnv());
    assert.equal(second.code, 0);
  });

  it('releases the lock after a failing command', async () => {
    const failed = await runCli(['inspect', 'does-not-exist'], childEnv());
    assert.equal(failed.code, 1);
    assert.deepEqual(await fs.readdir(lockDir).catch(() => []), []);
  });
});
