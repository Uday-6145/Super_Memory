import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { FileSystemWorkflowRepository } from '../../src/workflow/repository.js';
import { OperatorCLI, deriveSecrets } from '../../src/cli/operator.js';
import { createTaskIntent } from '../../src/discovery/task-intent.js';

const SECRET = 'sk-test-SECRET-99xQv7';
const ORIGIN = 'http://127.0.0.1:8080';

function makeCaptureIO() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => { out += chunk.toString(); });
  stderr.on('data', (chunk) => { err += chunk.toString(); });
  return { io: { stdin: new PassThrough(), stdout, stderr }, text: () => ({ out, err }) };
}

describe('CLI — Secret Redaction', () => {
  let tempBaseDir;
  let repo;

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-redact-test-'));
    repo = new FileSystemWorkflowRepository({ baseDir: tempBaseDir });
  });

  after(async () => {
    await fs.rm(tempBaseDir, { recursive: true, force: true });
  });

  it('deriveSecrets collects only non-empty string values', () => {
    assert.deepEqual(
      deriveSecrets({ a: SECRET, b: '  ', c: 42, d: null }, ['extra-secret', '', 7]),
      [SECRET, 'extra-secret']
    );
    assert.deepEqual(deriveSecrets(null, undefined, {}), []);
  });

  it('inspect redacts a coincidental secret from workflow content when inputs are supplied', async () => {
    await repo.createWorkflow({
      id: 'redact_me_flow',
      name: `Redaction probe ${SECRET}`,
      description: `Handles token ${SECRET} end to end`,
      target: { origin: ORIGIN, startPath: '/store' },
      inputs: [{ name: 'search_item', type: 'string', label: 'Search', description: 'Item query', required: true }],
      steps: [
        {
          id: 's1',
          order: 1,
          action: 'navigate',
          description: `Open store ${SECRET}`,
          params: { path: '/store' },
          anchor: { role: 'link', name: 'Store', tag: 'a', type: '', placeholder: '' },
          verification: { type: 'textPresent', expected: SECRET },
        },
      ],
      successCriteria: { textPresent: SECRET },
    });

    const { io, text } = makeCaptureIO();
    const cli = new OperatorCLI({ repository: repo, io });
    await cli.inspect('redact_me_flow', { inputs: { search_item: SECRET } });

    const { out } = text();
    assert.ok(!out.includes(SECRET), 'inspect output must not contain the supplied secret');
    assert.ok(out.includes('[REDACTED]'), 'redacted output should mark redactions');
    assert.ok(out.includes('redact_me_flow'), 'workflow identity must remain visible');
  });

  it('inspect error paths do not echo input values', async () => {
    const { io } = makeCaptureIO();
    const cli = new OperatorCLI({ repository: repo, io });
    await assert.rejects(
      () => cli.inspect('no_such_workflow_xyz', { inputs: { search_item: SECRET } }),
      (err) => {
        assert.ok(!String(err.message).includes(SECRET), 'error must not echo the secret value');
        return /not found/.test(err.message);
      }
    );
  });

  it('ambiguous discover redacts parameter values out of the echoed objective', async () => {
    const activeVersion = {
      status: 'verified',
      target: { origin: ORIGIN, startPath: '/store' },
      inputs: [{ name: 'search_item', type: 'string', required: true }],
      successCriteria: { finalPath: '/receipt' },
    };
    const fakeRepo = {
      async list() {
        return [
          { id: 'order_store_receipt_a', name: 'Order store receipt A', description: 'Order from the store to receipt', enabled: true, activeVersion: 1 },
          { id: 'order_store_receipt_b', name: 'Order store receipt B', description: 'Order from the store to receipt', enabled: true, activeVersion: 1 },
        ];
      },
      async getVersion() {
        return activeVersion;
      },
    };
    const { io, text } = makeCaptureIO();
    const cli = new OperatorCLI({ repository: fakeRepo, io });
    const intent = createTaskIntent({
      taskId: 'task_redact_lookup',
      objective: `Order ${SECRET} from store to receipt`,
      targetOrigin: ORIGIN,
      startPath: '/store',
      parameters: [{ name: 'search_item', value: SECRET }],
      successConditions: [{ type: 'finalPath', expected: '/receipt' }],
    });

    const result = await cli.discover(intent, { allowLocalhost: false });

    assert.equal(result.action, 'ambiguous');
    const { err } = text();
    assert.ok(!err.includes(SECRET), 'ambiguous-lookup stderr must not contain the parameter value');
    assert.ok(err.includes('[REDACTED]'), 'redacted objective should mark the redaction');
  });
});
