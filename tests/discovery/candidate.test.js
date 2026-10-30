import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateWorkflowIdSlug,
  buildCandidateFromTrace,
  CandidateConversionError,
} from '../../src/discovery/candidate.js';
import { createTaskIntent } from '../../src/discovery/task-intent.js';
import { validateWorkflowVersion, validateWorkflowId } from '../../src/workflow/schema.js';
import { calculateContentHash } from '../../src/workflow/hash.js';

describe('Discovery Engine — Candidate Conversion', () => {
  it('generateWorkflowIdSlug produces clean slugs matching schema regex', () => {
    const slug1 = generateWorkflowIdSlug('Search for Pizza and Checkout!', 't_1');
    assert.equal(slug1, 'search_for_pizza_and_checkout');
    assert.doesNotThrow(() => validateWorkflowId(slug1));

    const slug2 = generateWorkflowIdSlug('$$$!!!', 'my_custom_task');
    assert.equal(slug2, 'wf_my_custom_task');
    assert.doesNotThrow(() => validateWorkflowId(slug2));
  });

  it('buildCandidateFromTrace converts successful trace entries into valid WorkflowVersion draft', () => {
    const intent = createTaskIntent({
      taskId: 't_demo_01',
      objective: 'Search for paneer and checkout',
      targetOrigin: 'http://127.0.0.1:8080',
      startPath: '/store',
      parameters: [
        { name: 'query', value: 'paneer', label: 'Search Item', description: 'Search term' },
      ],
      successConditions: [{ type: 'finalPath', expected: '/complete' }],
    });

    const trace = [
      {
        stepIndex: 0,
        decision: {
          action: 'fillByLabel',
          label: 'Search Item',
          inputName: 'query',
          rationale: 'Fill search box',
        },
        observedElement: {
          role: 'textbox',
          name: 'Search Item',
          tag: 'input',
          type: 'text',
          placeholder: 'Search...',
        },
        result: { ok: true, status: 200, durationMs: 40 },
      },
      {
        stepIndex: 1,
        decision: {
          action: 'clickByRole',
          role: 'button',
          name: 'Submit Order',
          rationale: 'Click submit button',
          expects: { type: 'textPresent', expected: 'Order Placed' },
        },
        observedElement: {
          role: 'button',
          name: 'Submit Order',
          tag: 'button',
          type: 'submit',
        },
        result: { ok: true, status: 200, durationMs: 65 },
      },
    ];

    const { candidate, contentHash } = buildCandidateFromTrace({
      trace,
      intent,
      finalObservation: { url: 'http://127.0.0.1:8080/complete', text: 'Order Placed' },
    });

    // Invariant assertions
    assert.equal(candidate.version, 1);
    assert.equal(candidate.status, 'draft');
    assert.equal(candidate.parentVersion, null);
    assert.equal(candidate.steps.length, 2);
    assert.equal(candidate.steps[0].order, 1);
    assert.equal(candidate.steps[1].order, 2);
    assert.equal(candidate.steps[0].action, 'fillByLabel');
    assert.equal(candidate.steps[0].params.inputName, 'query');
    assert.equal(candidate.steps[1].action, 'clickByRole');
    assert.equal(candidate.steps[1].params.name, 'Submit Order');
    assert.deepEqual(candidate.steps[1].verification, { type: 'textPresent', expected: 'Order Placed' });
    assert.equal(candidate.successCriteria.finalPath, '/complete');

    // Strict schema & hash validation
    assert.doesNotThrow(() => validateWorkflowVersion(candidate));
    const recomputedHash = calculateContentHash(candidate);
    assert.equal(contentHash, recomputedHash);
  });

  it('buildCandidateFromTrace emits input references and schemaVersion 1.1.0 for parameter-bound conditions', () => {
    const intent = createTaskIntent({
      taskId: 't_demo_param',
      objective: 'Search for the requested item and add it',
      targetOrigin: 'http://127.0.0.1:8080',
      startPath: '/store',
      parameters: [
        { name: 'search_item', value: 'Paneer Toast', label: 'Search Product', description: 'Requested product' },
      ],
      successConditions: [
        { type: 'finalPath', expected: '/cart' },
        { type: 'textPresent', input: 'search_item' },
      ],
    });

    const trace = [
      {
        stepIndex: 0,
        decision: {
          action: 'fillByLabel',
          label: 'Search Product',
          inputName: 'search_item',
          rationale: 'Fill search box',
        },
        observedElement: {
          role: 'textbox',
          name: 'Search Product',
          tag: 'input',
          type: 'text',
          placeholder: 'Search...',
        },
        result: { ok: true, status: 200, durationMs: 40 },
      },
    ];

    const { candidate, contentHash } = buildCandidateFromTrace({
      trace,
      intent,
      finalObservation: { url: 'http://127.0.0.1:8080/cart', text: 'Cart Paneer Toast' },
    });

    assert.equal(candidate.schemaVersion, '1.1.0');
    assert.deepEqual(candidate.successCriteria, {
      finalPath: '/cart',
      textPresent: { input: 'search_item' },
    });
    assert.doesNotThrow(() => validateWorkflowVersion(candidate));
    assert.equal(calculateContentHash(candidate), contentHash);
    // The runtime product value is never baked into the reusable definition.
    assert.ok(!JSON.stringify(candidate).includes('Paneer Toast'));
  });

  it('buildCandidateFromTrace keeps purely literal candidates at schemaVersion 1.0.0', () => {
    const intent = createTaskIntent({
      taskId: 't_demo_literal',
      objective: 'Search for paneer and checkout',
      targetOrigin: 'http://127.0.0.1:8080',
      startPath: '/store',
      parameters: [{ name: 'query', value: 'paneer', label: 'Search Item' }],
      successConditions: [{ type: 'finalPath', expected: '/complete' }],
    });
    const trace = [
      {
        stepIndex: 0,
        decision: { action: 'fillByLabel', label: 'Search Item', inputName: 'query', rationale: 'Fill search box' },
        observedElement: { role: 'textbox', name: 'Search Item', tag: 'input', type: 'text' },
        result: { ok: true, status: 200, durationMs: 40 },
      },
    ];
    const { candidate } = buildCandidateFromTrace({
      trace,
      intent,
      finalObservation: { url: 'http://127.0.0.1:8080/complete', text: 'Done' },
    });
    assert.equal(candidate.schemaVersion, '1.0.0');
  });

  it('buildCandidateFromTrace rejects empty trace', () => {
    const intent = createTaskIntent({
      objective: 'Test',
      targetOrigin: 'http://127.0.0.1:8080',
      successConditions: [{ type: 'finalPath', expected: '/' }],
    });

    assert.throws(
      () => buildCandidateFromTrace({ trace: [], intent }),
      (err) => err instanceof CandidateConversionError
    );
  });
});

