import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTaskIntent,
  createTaskIntent,
  TaskIntentError,
} from '../../src/discovery/task-intent.js';

describe('Discovery Engine — Task Intent Validation', () => {
  it('accepts a completely valid TaskIntent', () => {
    const intent = {
      taskId: 'task_checkout_01',
      objective: 'Search for paneer and complete checkout',
      targetOrigin: 'http://127.0.0.1:8080',
      startPath: '/store',
      parameters: [
        { name: 'search_query', value: 'paneer', label: 'Search Item', description: 'Item name' },
      ],
      constraints: [{ kind: 'maxPrice', value: '500' }],
      successConditions: [{ type: 'finalPath', expected: '/complete' }],
      approvalRequired: ['place_order'],
      forbidden: ['delete_account'],
    };

    assert.equal(validateTaskIntent(intent).valid, true);
  });

  it('rejects missing or non-string objective', () => {
    assert.throws(
      () =>
        validateTaskIntent({
          taskId: 't1',
          objective: '',
          targetOrigin: 'http://127.0.0.1:8080',
          startPath: '/',
          parameters: [],
          successConditions: [{ type: 'finalPath', expected: '/' }],
        }),
      (err) => err instanceof TaskIntentError && err.path === 'objective'
    );
  });

  it('rejects invalid targetOrigin with credentials, paths, or query params', () => {
    assert.throws(
      () =>
        validateTaskIntent({
          taskId: 't1',
          objective: 'Buy item',
          targetOrigin: 'http://user:pass@127.0.0.1:8080/store?promo=1',
          startPath: '/',
          parameters: [],
          successConditions: [{ type: 'finalPath', expected: '/' }],
        }),
      /targetOrigin/
    );
  });

  it('rejects invalid startPath with protocol prefixes or traversal', () => {
    assert.throws(
      () =>
        validateTaskIntent({
          taskId: 't1',
          objective: 'Buy item',
          targetOrigin: 'http://127.0.0.1:8080',
          startPath: '../secret',
          parameters: [],
          successConditions: [{ type: 'finalPath', expected: '/' }],
        }),
      /startPath/
    );
  });

  it('rejects duplicate parameter names', () => {
    assert.throws(
      () =>
        validateTaskIntent({
          taskId: 't1',
          objective: 'Buy item',
          targetOrigin: 'http://127.0.0.1:8080',
          startPath: '/',
          parameters: [
            { name: 'query', value: 'paneer' },
            { name: 'query', value: 'pizza' },
          ],
          successConditions: [{ type: 'finalPath', expected: '/' }],
        }),
      /Duplicate parameter name/
    );
  });

  it('rejects invalid successCondition types', () => {
    assert.throws(
      () =>
        validateTaskIntent({
          taskId: 't1',
          objective: 'Buy item',
          targetOrigin: 'http://127.0.0.1:8080',
          startPath: '/',
          parameters: [],
          successConditions: [{ type: 'unsupportedType', expected: 'foo' }],
        }),
      /Invalid successCondition type/
    );
  });

  it('createTaskIntent builds valid intent and generates taskId if omitted', () => {
    const intent = createTaskIntent({
      objective: 'Find paneer pizza',
      targetOrigin: 'http://127.0.0.1:8080',
      startPath: '/catalog',
      parameters: [{ name: 'item', value: 'pizza' }],
      successConditions: [{ type: 'finalPath', expected: '/cart' }],
    });

    assert.ok(intent.taskId.startsWith('task_'));
    assert.equal(intent.objective, 'Find paneer pizza');
    assert.equal(intent.targetOrigin, 'http://127.0.0.1:8080');
    assert.equal(validateTaskIntent(intent).valid, true);
  });

  it('accepts a parameter-bound success condition referencing a declared parameter', () => {
    const intent = createTaskIntent({
      objective: 'Find the requested item and add it',
      targetOrigin: 'http://127.0.0.1:8080',
      startPath: '/store',
      parameters: [{ name: 'search_item', value: 'Paneer Toast' }],
      successConditions: [
        { type: 'finalPath', expected: '/cart' },
        { type: 'textPresent', input: 'search_item' },
      ],
    });
    assert.deepEqual(intent.successConditions[1], { type: 'textPresent', input: 'search_item' });
    assert.equal(validateTaskIntent(intent).valid, true);
  });

  it('rejects a success condition referencing an undeclared parameter', () => {
    assert.throws(
      () =>
        validateTaskIntent({
          taskId: 't1',
          objective: 'Buy item',
          targetOrigin: 'http://127.0.0.1:8080',
          startPath: '/',
          parameters: [{ name: 'search_item', value: 'Paneer Toast' }],
          successConditions: [{ type: 'textPresent', input: 'other_item' }],
        }),
      (err) => err instanceof TaskIntentError && /undeclared parameter/.test(err.message)
    );
  });

  it('rejects a condition with both expected and input, or neither', () => {
    const base = {
      taskId: 't1',
      objective: 'Buy item',
      targetOrigin: 'http://127.0.0.1:8080',
      startPath: '/',
      parameters: [{ name: 'search_item', value: 'Paneer Toast' }],
    };
    assert.throws(
      () => validateTaskIntent({ ...base, successConditions: [{ type: 'textPresent', expected: 'x', input: 'search_item' }] }),
      /exactly one of "expected"/
    );
    assert.throws(
      () => validateTaskIntent({ ...base, successConditions: [{ type: 'textPresent' }] }),
      /exactly one of "expected"/
    );
  });

  it('rejects an input reference for finalPath', () => {
    assert.throws(
      () =>
        validateTaskIntent({
          taskId: 't1',
          objective: 'Buy item',
          targetOrigin: 'http://127.0.0.1:8080',
          startPath: '/',
          parameters: [{ name: 'search_item', value: '/cart' }],
          successConditions: [{ type: 'finalPath', input: 'search_item' }],
        }),
      /must use a literal "expected" path/
    );
  });
});

