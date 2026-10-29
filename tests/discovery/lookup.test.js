import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { findMatchingWorkflow } from '../../src/discovery/lookup.js';
import { createTaskIntent } from '../../src/discovery/task-intent.js';
import { OperatorCLI } from '../../src/cli/operator.js';

const ORIGIN = 'http://127.0.0.1:8080';
const START_PATH = '/store';

function makeIntent(objective, expectedPath = '/receipt') {
  return createTaskIntent({
    taskId: `task_${objective.length}_${expectedPath.replace('/', '')}`,
    objective,
    targetOrigin: ORIGIN,
    startPath: START_PATH,
    parameters: [{ name: 'search_item', value: 'paneer pizza' }],
    successConditions: [{ type: 'finalPath', expected: expectedPath }],
  });
}

function makeActiveVersion({ successPath = '/receipt', inputs = [{ name: 'search_item', required: true }] } = {}) {
  return {
    status: 'verified',
    target: { origin: ORIGIN, startPath: START_PATH },
    inputs,
    successCriteria: { finalPath: successPath },
  };
}

function makeRepository(entries) {
  const versions = new Map(entries.map(([manifest, version]) => [manifest.id, version]));
  return {
    async list() {
      return entries.map(([manifest]) => manifest);
    },
    async getVersion(workflowId) {
      if (!versions.has(workflowId)) {
        throw new Error(`Unknown workflow ${workflowId}`);
      }
      return versions.get(workflowId);
    },
  };
}

function makeManifest(id, name, description) {
  return { id, name, description, enabled: true, activeVersion: 1 };
}

function makeQuietIO() {
  return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
}

describe('Discovery Engine — Conservative Workflow Lookup', () => {
  it('matches a genuine reusable workflow with shared objective, inputs, path, and outcome', async () => {
    const manifest = makeManifest(
      'order_store_receipt_flow',
      'Order store receipt flow',
      'Order items from the store through to receipt'
    );
    const repository = makeRepository([[manifest, makeActiveVersion()]]);
    const intent = makeIntent('Order paneer from store to receipt');

    const result = await findMatchingWorkflow(repository, intent);

    assert.equal(result.match, true);
    assert.equal(result.workflowId, 'order_store_receipt_flow');
    assert.equal(result.version, 1);
  });

  it('rejects a candidate selected only by one common word', async () => {
    const manifest = makeManifest(
      'order_refund_status',
      'Order refund status',
      'Check the status of an existing order refund'
    );
    const repository = makeRepository([[manifest, makeActiveVersion()]]);
    const intent = makeIntent('Order paneer pizza');

    const result = await findMatchingWorkflow(repository, intent);

    assert.equal(result.match, false);
    assert.equal(result.ambiguous, undefined);
  });

  it('rejects different objectives on the same origin, path, inputs, and outcome', async () => {
    const manifest = makeManifest(
      'cancel_subscription_immediately',
      'Cancel subscription immediately',
      'Stop recurring billing for the current account'
    );
    const repository = makeRepository([[manifest, makeActiveVersion()]]);
    const intent = makeIntent('Order paneer from store to receipt');

    const result = await findMatchingWorkflow(repository, intent);

    assert.equal(result.match, false);
  });

  it('rejects compatible metadata with an incompatible requested outcome', async () => {
    const manifest = makeManifest(
      'order_store_receipt_flow',
      'Order store receipt flow',
      'Order items from the store through to receipt'
    );
    const repository = makeRepository([[manifest, makeActiveVersion({ successPath: '/success' })]]);
    const intent = makeIntent('Order paneer from store to receipt', '/receipt');

    const result = await findMatchingWorkflow(repository, intent);

    assert.equal(result.match, false);
  });

  it('returns ambiguity rather than choosing the first of several strong candidates', async () => {
    const first = makeManifest(
      'order_store_receipt_flow_a',
      'Order store receipt flow A',
      'Order items from the store through to receipt'
    );
    const second = makeManifest(
      'order_store_receipt_flow_b',
      'Order store receipt flow B',
      'Order items from the store through to receipt'
    );
    const repository = makeRepository([
      [first, makeActiveVersion()],
      [second, makeActiveVersion()],
    ]);
    const intent = makeIntent('Order paneer from store to receipt');

    const result = await findMatchingWorkflow(repository, intent);

    assert.equal(result.match, false);
    assert.equal(result.ambiguous, true);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.workflowId).sort(),
      ['order_store_receipt_flow_a', 'order_store_receipt_flow_b']
    );
  });

  it('does not execute playback for an ambiguous lookup result', async () => {
    const first = makeManifest(
      'order_store_receipt_flow_a',
      'Order store receipt flow A',
      'Order items from the store through to receipt'
    );
    const second = makeManifest(
      'order_store_receipt_flow_b',
      'Order store receipt flow B',
      'Order items from the store through to receipt'
    );
    const repository = makeRepository([
      [first, makeActiveVersion()],
      [second, makeActiveVersion()],
    ]);
    const cli = new OperatorCLI({ repository, io: makeQuietIO() });
    const intent = makeIntent('Order paneer from store to receipt');

    const result = await cli.discover(intent, { allowLocalhost: false });

    assert.equal(result.action, 'ambiguous');
    assert.equal(result.candidates.length, 2);
  });
});
