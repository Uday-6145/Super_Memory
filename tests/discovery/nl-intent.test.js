import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNaturalLanguageTask,
  NaturalLanguageIntentError,
} from '../../src/discovery/nl-intent.js';
import { OperatorCLI } from '../../src/cli/operator.js';

const ORIGIN = 'http://127.0.0.1:8080';

function makeNlMock(draft) {
  return {
    complete: async () => ({ text: JSON.stringify(draft) }),
  };
}

describe('Discovery Engine — Constrained Natural-Language Intent', () => {
  it('parses constrained model output into validated intent with caller-supplied origin', async () => {
    const provider = makeNlMock({
      objective: 'Find paneer pizza and prepare the cart',
      parameters: [{ name: 'item_query', value: 'paneer pizza' }],
      constraints: [{ kind: 'maxPrice', value: '400', currency: 'INR' }],
      successConditions: [{ type: 'finalPath', expected: '/receipt' }],
      approvalRequired: ['place_order'],
      forbidden: ['pay'],
    });

    const intent = await parseNaturalLanguageTask({
      provider,
      request: 'Find a paneer pizza under 400 rupees and prepare the cart',
      targetOrigin: ORIGIN,
      startPath: '/store',
      fixedParameters: [{ name: 'item_query', value: 'paneer pizza' }],
      taskId: 'task_nl_valid',
    });

    assert.equal(intent.objective, 'Find paneer pizza and prepare the cart');
    assert.equal(intent.targetOrigin, ORIGIN);
    assert.equal(intent.startPath, '/store');
    assert.deepEqual(intent.parameters, [
      { name: 'item_query', value: 'paneer pizza', label: undefined, description: undefined },
    ]);
    assert.deepEqual(intent.successConditions, [{ type: 'finalPath', expected: '/receipt' }]);
  });

  it('rejects model output that invents target or identity fields', async () => {
    const provider = makeNlMock({
      objective: 'Find paneer pizza',
      targetOrigin: 'https://evil.example',
      parameters: [],
      successConditions: [{ type: 'finalPath', expected: '/receipt' }],
    });

    await assert.rejects(
      () => parseNaturalLanguageTask({
        provider,
        request: 'Find paneer pizza',
        targetOrigin: ORIGIN,
      }),
      (err) => err instanceof NaturalLanguageIntentError && /must not include "targetOrigin"/.test(err.message)
    );
  });

  it('returns an explicit ambiguity error when required details are missing', async () => {
    const provider = makeNlMock({});

    await assert.rejects(
      () => parseNaturalLanguageTask({ provider, request: 'Do the thing', targetOrigin: ORIGIN }),
      (err) => err instanceof NaturalLanguageIntentError && err.needsClarification === true
    );
  });

  it('requires an explicit origin instead of letting the model invent one', async () => {
    const provider = makeNlMock({
      objective: 'Find paneer pizza',
      parameters: [],
      successConditions: [{ type: 'finalPath', expected: '/receipt' }],
    });

    await assert.rejects(
      () => parseNaturalLanguageTask({ provider, request: 'Find paneer pizza' }),
      /explicit --origin/
    );
  });

  it('wraps provider failure with a structured-intent alternative', async () => {
    const provider = {
      complete: async () => {
        throw new Error('provider offline');
      },
    };

    await assert.rejects(
      () => parseNaturalLanguageTask({ provider, request: 'Find paneer pizza', targetOrigin: ORIGIN }),
      /Provide a structured --intent file instead/
    );
  });

  it('rejects offline mock providers for plain-language CLI discovery', async () => {
    const cli = new OperatorCLI({});
    await assert.rejects(
      () => cli.discover('Find paneer pizza', { origin: ORIGIN, provider: 'mock' }),
      /cannot interpret free text.*--intent/
    );
  });
});
