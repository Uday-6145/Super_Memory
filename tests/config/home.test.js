import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  resolveSuperMemoryHome,
  resolveWorkflowsDir,
  ensureSuperMemoryHome,
  getHomePaths,
  detectLegacyWorkflowsDir,
} from '../../src/config/home.js';
import { OperatorCLI } from '../../src/cli/operator.js';

describe('SUPER_MEMORY_HOME resolution', () => {
  it('uses the SUPER_MEMORY_HOME override on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      assert.equal(
        resolveSuperMemoryHome({ env: { SUPER_MEMORY_HOME: '/tmp/custom-home' }, platform, homedir: '/home/tester' }),
        path.resolve('/tmp/custom-home')
      );
    }
  });

  it('resolves the macOS default', () => {
    assert.equal(
      resolveSuperMemoryHome({ env: {}, platform: 'darwin', homedir: '/Users/tester' }),
      '/Users/tester/Library/Application Support/SuperMemory'
    );
  });

  it('resolves Linux defaults with and without XDG_DATA_HOME', () => {
    assert.equal(
      resolveSuperMemoryHome({ env: { XDG_DATA_HOME: '/xdg/data' }, platform: 'linux', homedir: '/home/tester' }),
      '/xdg/data/super-memory'
    );
    assert.equal(
      resolveSuperMemoryHome({ env: {}, platform: 'linux', homedir: '/home/tester' }),
      '/home/tester/.local/share/super-memory'
    );
  });

  it('resolves the Windows default from APPDATA', () => {
    assert.equal(
      resolveSuperMemoryHome({ env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\tester' }),
      path.join('C:\\Users\\tester\\AppData\\Roaming', 'SuperMemory')
    );
  });

  it('resolveWorkflowsDir honors explicit > WORKFLOWS_DIR > managed home', () => {
    const env = { SUPER_MEMORY_HOME: '/tmp/home-x', WORKFLOWS_DIR: '/tmp/env-repo' };
    assert.equal(resolveWorkflowsDir({ explicit: '/tmp/explicit', env }).workflowsDir, '/tmp/explicit');
    assert.equal(resolveWorkflowsDir({ explicit: '/tmp/explicit', env }).source, 'explicit');
    assert.equal(resolveWorkflowsDir({ env }).workflowsDir, '/tmp/env-repo');
    assert.equal(resolveWorkflowsDir({ env }).source, 'env');
    const homeResolved = resolveWorkflowsDir({ env: { SUPER_MEMORY_HOME: '/tmp/home-x' } });
    assert.equal(homeResolved.workflowsDir, '/tmp/home-x/workflows');
    assert.equal(homeResolved.source, 'home');
  });

  it('ensureSuperMemoryHome creates the layout once and never overwrites config', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-home-'));
    try {
      const paths = await ensureSuperMemoryHome({ home });
      for (const dir of [paths.workflows, paths.backups, paths.journals]) {
        assert.equal((await fs.stat(dir)).isDirectory(), true);
      }
      await fs.writeFile(paths.config, '{"operator":"custom"}\n', 'utf8');
      await ensureSuperMemoryHome({ home });
      assert.equal(await fs.readFile(paths.config, 'utf8'), '{"operator":"custom"}\n');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('OperatorCLI defaults to the managed home repository and -w style explicit dirs win', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-home-cli-'));
    try {
      const managed = new OperatorCLI({ homeDir: home });
      assert.equal(managed.repo.baseDir, getHomePaths(home).workflows);

      const explicitDir = path.join(home, 'elsewhere');
      const explicit = new OperatorCLI({ homeDir: home, workflowsDir: explicitDir });
      assert.equal(explicit.repo.baseDir, explicitDir);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('CLI dispatch: migrate, integrity, and backup work against a temporary home', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-home-dispatch-'));
    const homeDir = path.join(root, 'home');
    const sourceDir = path.join(root, 'source');
    try {
      const { FileSystemWorkflowRepository } = await import('../../src/workflow/index.js');
      const sourceRepo = new FileSystemWorkflowRepository({ baseDir: sourceDir });
      await sourceRepo.init();
      await sourceRepo.createWorkflow({
        id: 'wf_dispatch',
        name: 'Dispatch workflow',
        description: 'Draft for dispatch test',
        target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
        inputs: [],
        steps: [
          { id: 'step_1', order: 1, description: 'Navigate', action: 'navigate', params: { path: '/' }, anchor: null, verification: null },
        ],
        successCriteria: { finalPath: '/' },
      });

      const { PassThrough } = await import('node:stream');
      const stdout = new PassThrough();
      stdout.on('data', () => {});
      const stderr = new PassThrough();
      stderr.on('data', () => {});
      const cli = new OperatorCLI({ homeDir, io: { stdin: new PassThrough(), stdout, stderr } });

      assert.equal(await cli.run(['migrate', '--from', sourceDir]), 0);
      assert.ok(await cli.repo.getManifest('wf_dispatch'));
      assert.equal(await cli.run(['integrity']), 0);
      assert.equal(await cli.run(['backup']), 0);
      const backups = await fs.readdir(path.join(homeDir, 'backups'));
      assert.equal(backups.filter((name) => !name.startsWith('.')).length, 1);
      assert.equal(await cli.run(['restore', '--from', path.join(homeDir, 'backups', backups.find((n) => !n.startsWith('.')))]), 0);
      assert.ok(await cli.repo.getManifest('wf_dispatch'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('detects a legacy ./workflows repository only when the managed home is empty', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-legacy-'));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'cwd');
    try {
      await fs.mkdir(path.join(cwd, 'workflows', 'wf_old', 'versions'), { recursive: true });

      const detected = await detectLegacyWorkflowsDir({ cwd, home });
      assert.ok(detected);
      assert.match(detected.message, /migrate --from/);
      assert.equal(detected.legacyDir, path.join(cwd, 'workflows'));

      // Once the managed repository has content, there is nothing to warn about.
      await fs.mkdir(path.join(home, 'workflows', 'wf_new'), { recursive: true });
      assert.equal(await detectLegacyWorkflowsDir({ cwd, home }), null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
