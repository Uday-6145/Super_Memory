import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { OperatorCLI, resolveEffectiveInputs } from '../../src/cli/operator.js';
import { createTaskIntent } from '../../src/discovery/task-intent.js';

const ORIGIN = 'http://127.0.0.1:8080';

function makeIntent(parameters) {
  return createTaskIntent({
    taskId: 'task_effective_inputs',
    objective: 'Search for the requested item and add it',
    targetOrigin: ORIGIN,
    startPath: '/store',
    parameters,
    successConditions: [
      { type: 'finalPath', expected: '/cart' },
      { type: 'textPresent', input: 'search_item' },
    ],
  });
}

function makeQuietIO() {
  return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
}

describe('CLI — Effective Runtime Inputs (single source of truth)', () => {
  it('uses intent parameter values when no separate runtime inputs are supplied', () => {
    const intent = makeIntent([{ name: 'search_item', value: 'Paneer Toast' }]);
    assert.deepEqual(resolveEffectiveInputs(intent, {}), { search_item: 'Paneer Toast' });
  });

  it('fills an empty intent value from the runtime inputs', () => {
    const intent = makeIntent([{ name: 'search_item', value: '' }]);
    assert.deepEqual(resolveEffectiveInputs(intent, { search_item: 'Paneer Toast' }), {
      search_item: 'Paneer Toast',
    });
  });

  it('accepts identical values from both sources', () => {
    const intent = makeIntent([{ name: 'search_item', value: 'Paneer Toast' }]);
    assert.deepEqual(resolveEffectiveInputs(intent, { search_item: 'Paneer Toast' }), {
      search_item: 'Paneer Toast',
    });
  });

  it('rejects conflicting values without echoing either value', () => {
    const intent = makeIntent([{ name: 'search_item', value: 'Paneer Toast' }]);
    assert.throws(
      () => resolveEffectiveInputs(intent, { search_item: 'Fresh Paneer Pizza' }),
      (err) => {
        assert.match(err.message, /"search_item" conflicts with the task intent parameter/);
        assert.ok(!err.message.includes('Paneer Toast'));
        assert.ok(!err.message.includes('Fresh Paneer Pizza'));
        return true;
      }
    );
  });

  it('rejects runtime inputs that the intent does not declare', () => {
    const intent = makeIntent([{ name: 'search_item', value: 'Paneer Toast' }]);
    assert.throws(
      () => resolveEffectiveInputs(intent, { credit_card: '4111111111111111' }),
      (err) => {
        assert.match(err.message, /"credit_card" is not declared/);
        assert.ok(!err.message.includes('4111111111111111'));
        return true;
      }
    );
  });

  it('rejects non-string runtime input values', () => {
    const intent = makeIntent([{ name: 'search_item', value: 'Paneer Toast' }]);
    assert.throws(
      () => resolveEffectiveInputs(intent, { search_item: 42 }),
      /"search_item" must be a string value/
    );
  });

  it('discover() rejects conflicting intent and inputs-file values before any lookup or playback', async () => {
    const cli = new OperatorCLI({
      repository: {
        async list() {
          throw new Error('lookup must not run with inconsistent inputs');
        },
      },
      io: makeQuietIO(),
    });
    const intent = makeIntent([{ name: 'search_item', value: 'Paneer Toast' }]);

    await assert.rejects(
      () => cli.discover(intent, { inputs: { search_item: 'Fresh Paneer Pizza' } }),
      (err) => {
        assert.match(err.message, /"search_item" conflicts with the task intent parameter/);
        assert.ok(!err.message.includes('Fresh Paneer Pizza'));
        return true;
      }
    );
  });
});
