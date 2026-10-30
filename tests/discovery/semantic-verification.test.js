import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DiscoveryOrchestrator } from '../../src/discovery/discovery-session.js';
import { createTaskIntent } from '../../src/discovery/task-intent.js';
import { collectFailureDiagnostic } from '../../src/workflow/diagnostics.js';

const ORIGIN = 'http://127.0.0.1:8080';
const PRODUCT = 'Paneer Toast';

function makeIntent(overrides = {}) {
  return createTaskIntent({
    taskId: 'task_semantic_verification',
    objective: 'Find the requested item and add it to the cart',
    targetOrigin: ORIGIN,
    startPath: '/store',
    parameters: [
      {
        name: 'search_item',
        value: PRODUCT,
        label: 'Search Product',
        description: 'Requested product',
      },
    ],
    successConditions: [
      { type: 'finalPath', expected: '/cart' },
      { type: 'textPresent', expected: PRODUCT },
    ],
    ...overrides,
  });
}

function makeSequentialModel(decisions, requests) {
  let calls = 0;
  return {
    calls: () => calls,
    async complete({ messages }) {
      requests.push(messages);
      const decision = decisions[calls] || decisions[decisions.length - 1];
      calls += 1;
      return { text: JSON.stringify(decision), usage: { totalTokens: 10 } };
    },
  };
}

function makeStoreSession({ cartProduct = PRODUCT } = {}) {
  const calls = { navigate: [], fillByLabel: [], clickByRole: [], closed: 0 };
  let phase = 'store';

  return {
    calls,
    async navigate(url) {
      calls.navigate.push(url);
    },
    async getSnapshot() {
      if (phase === 'cart') {
        return {
          url: `${ORIGIN}/cart`,
          title: 'Shopping Cart',
          text: `Your Cart Item added to cart: ${cartProduct}`,
          elements: [
            { tag: 'a', role: 'link', name: 'Proceed to Checkout', type: '', href: '/checkout', disabled: false },
          ],
        };
      }
      return {
        url: `${ORIGIN}/store`,
        title: 'SuperStore Catalog',
        text: `SuperStore Catalog Featured product: ${PRODUCT}`,
        elements: [
          { tag: 'input', role: 'textbox', name: 'Search Product', type: 'text', disabled: false },
          { tag: 'button', role: 'button', name: 'Add to Cart', type: 'submit', disabled: false },
        ],
      };
    },
    async fillByLabel(args) {
      calls.fillByLabel.push(args);
    },
    async clickByRole(args) {
      calls.clickByRole.push(args);
      phase = 'cart';
    },
    async close() {
      calls.closed += 1;
    },
  };
}

function makeRuntime(session) {
  return {
    async createSession() {
      return session;
    },
  };
}

const PURCHASE_DECISIONS = [
  {
    action: 'fillByLabel',
    elementIndex: 0,
    label: 'Search Product',
    inputName: 'search_item',
    rationale: 'Search for the requested item',
    done: false,
  },
  {
    action: 'clickByRole',
    elementIndex: 1,
    role: 'button',
    name: 'Add to Cart',
    rationale: 'Add the requested item to the cart',
    done: false,
  },
];

describe('Discovery — Local Semantic Verification', () => {
  it('satisfies textPresent from raw local evidence while the model sees only redacted text', async () => {
    const session = makeStoreSession();
    const requests = [];
    const events = [];
    const model = makeSequentialModel(PURCHASE_DECISIONS, requests);
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeRuntime(session),
      modelProvider: model,
      allowLocalhost: true,
      onEvent: (event) => events.push(event),
    });

    const result = await orchestrator.runDiscovery(makeIntent());

    assert.equal(result.status, 'SUCCESS');
    assert.ok(result.candidate);
    assert.equal(model.calls(), 2, 'success must terminate before another model decision is requested');
    assert.deepEqual(result.candidate.successCriteria, {
      finalPath: '/cart',
      textPresent: PRODUCT,
    });
    assert.equal(session.calls.fillByLabel.length, 1);
    assert.equal(session.calls.clickByRole.length, 1);

    const serializedRequests = JSON.stringify(requests);
    assert.ok(!serializedRequests.includes(PRODUCT), 'model requests must not contain the protected parameter value');
    assert.ok(serializedRequests.includes('[REDACTED]'), 'model observation should show redaction, not raw text');
    assert.ok(!JSON.stringify(result.trace).includes(PRODUCT), 'trace must not persist raw protected text');
    assert.ok(!JSON.stringify(events).includes(PRODUCT), 'events must not expose the protected value');
    assert.equal(session.calls.closed, 1);
  });

  it('requires both finalPath and item-specific textPresent to pass', () => {
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeRuntime(makeStoreSession()),
      modelProvider: { complete: async () => ({ text: '{}' }) },
      allowLocalhost: true,
    });
    const intent = makeIntent();

    assert.equal(
      orchestrator._evaluateSuccessConditions(intent, {
        url: `${ORIGIN}/cart`,
        title: 'Shopping Cart',
        text: `Your Cart Item added to cart: ${PRODUCT}`,
      }).passed,
      true
    );
    assert.equal(
      orchestrator._evaluateSuccessConditions(intent, {
        url: `${ORIGIN}/store`,
        title: 'SuperStore Catalog',
        text: `Featured product: ${PRODUCT}`,
      }).passed,
      false,
      'correct product text on the wrong path must not pass'
    );
    assert.equal(
      orchestrator._evaluateSuccessConditions(intent, {
        url: `${ORIGIN}/cart`,
        title: 'Shopping Cart',
        text: 'Your Cart',
      }).passed,
      false,
      'generic cart text must not satisfy an item-specific condition'
    );
    assert.equal(
      orchestrator._evaluateSuccessConditions(intent, {
        url: `${ORIGIN}/cart`,
        title: 'Shopping Cart',
        text: 'Your Cart Item added to cart: Paneer Bagel',
      }).passed,
      false,
      'a wrong product must not satisfy the requested product condition'
    );
  });

  it('fails closed for missing or empty raw evidence', () => {
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeRuntime(makeStoreSession()),
      modelProvider: { complete: async () => ({ text: '{}' }) },
      allowLocalhost: true,
    });
    const intent = makeIntent();

    for (const evidence of [null, undefined, {}, { url: '', title: '', text: '' }, 'not-an-observation']) {
      assert.equal(orchestrator._evaluateSuccessConditions(intent, evidence).passed, false);
    }
  });

  it('does not create a candidate for the wrong product and keeps retained journals free of protected values', async () => {
    const journalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-semantic-journal-'));
    try {
      const session = makeStoreSession({ cartProduct: 'Paneer Bagel' });
      const requests = [];
      const model = makeSequentialModel(PURCHASE_DECISIONS, requests);
      const orchestrator = new DiscoveryOrchestrator({
        browserRuntime: makeRuntime(session),
        modelProvider: model,
        allowLocalhost: true,
        maxSteps: 2,
        journalDir,
      });

      const result = await orchestrator.runDiscovery(makeIntent());

      assert.notEqual(result.status, 'SUCCESS');
      assert.equal(result.candidate, undefined);
      assert.equal(session.calls.clickByRole.length, 1);
      assert.ok(orchestrator.lastJournalPath);
      const journal = await fs.readFile(orchestrator.lastJournalPath, 'utf8');
      assert.ok(!journal.includes(PRODUCT), 'retained journal must not contain the protected parameter value');
    } finally {
      await fs.rm(journalDir, { recursive: true, force: true });
    }
  });

  it('keeps failure diagnostics free of protected values', async () => {
    const diagnostic = await collectFailureDiagnostic({
      workflowId: 'wf_semantic_probe',
      version: 1,
      error: `Failed while adding ${PRODUCT}`,
      session: {
        isClosed: false,
        page: {
          url: () => `${ORIGIN}/cart`,
          title: async () => `Shopping Cart for ${PRODUCT}`,
          isClosed: () => false,
        },
        getSnapshot: async () => ({
          url: `${ORIGIN}/cart`,
          title: `Shopping Cart for ${PRODUCT}`,
          text: `Your Cart Item added to cart: ${PRODUCT}`,
          elements: [
            { tag: 'div', role: 'text', name: PRODUCT, type: '', disabled: false },
          ],
        }),
      },
      secrets: [PRODUCT],
    });

    const serialized = JSON.stringify(diagnostic);
    assert.ok(!serialized.includes(PRODUCT), 'diagnostics must not contain the protected value');
    assert.ok(serialized.includes('[REDACTED]'));
  });

  it('verifies a parameter-bound textPresent condition locally and emits a 1.1.0 candidate with an input reference', async () => {
    const session = makeStoreSession();
    const requests = [];
    const events = [];
    const model = makeSequentialModel(PURCHASE_DECISIONS, requests);
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeRuntime(session),
      modelProvider: model,
      allowLocalhost: true,
      onEvent: (event) => events.push(event),
    });

    const intent = makeIntent({
      successConditions: [
        { type: 'finalPath', expected: '/cart' },
        { type: 'textPresent', input: 'search_item' },
      ],
    });
    const result = await orchestrator.runDiscovery(intent);

    assert.equal(result.status, 'SUCCESS');
    assert.equal(model.calls(), 2);
    assert.equal(result.candidate.schemaVersion, '1.1.0');
    assert.deepEqual(result.candidate.successCriteria, {
      finalPath: '/cart',
      textPresent: { input: 'search_item' },
    });
    assert.ok(!JSON.stringify(requests).includes(PRODUCT), 'model requests must not contain the protected value');
    assert.ok(!JSON.stringify(result.trace).includes(PRODUCT), 'trace must not contain the protected value');
    assert.ok(!JSON.stringify(events).includes(PRODUCT), 'events must not contain the protected value');
    assert.equal(session.calls.closed, 1);
  });

  it('verifies a different product with the same parameter-bound intent', async () => {
    const otherProduct = 'Fresh Paneer Pizza';
    const session = makeStoreSession({ cartProduct: otherProduct });
    const requests = [];
    const model = makeSequentialModel(PURCHASE_DECISIONS, requests);
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeRuntime(session),
      modelProvider: model,
      allowLocalhost: true,
    });

    const intent = makeIntent({
      parameters: [
        { name: 'search_item', value: otherProduct, label: 'Search Product', description: 'Requested product' },
      ],
      successConditions: [
        { type: 'finalPath', expected: '/cart' },
        { type: 'textPresent', input: 'search_item' },
      ],
    });
    const result = await orchestrator.runDiscovery(intent);

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.candidate.schemaVersion, '1.1.0');
    assert.ok(!JSON.stringify(requests).includes(otherProduct));
  });

  it('does not succeed for the wrong product under a parameter-bound condition', async () => {
    const session = makeStoreSession({ cartProduct: 'Paneer Bagel' });
    const requests = [];
    const model = makeSequentialModel(PURCHASE_DECISIONS, requests);
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeRuntime(session),
      modelProvider: model,
      allowLocalhost: true,
      maxSteps: 2,
    });

    const intent = makeIntent({
      successConditions: [
        { type: 'finalPath', expected: '/cart' },
        { type: 'textPresent', input: 'search_item' },
      ],
    });
    const result = await orchestrator.runDiscovery(intent);

    assert.notEqual(result.status, 'SUCCESS');
    assert.equal(result.candidate, undefined);
  });

  it('parameter-bound conditions fail closed without a usable parameter value', () => {
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeRuntime(makeStoreSession()),
      modelProvider: { complete: async () => ({ text: '{}' }) },
      allowLocalhost: true,
    });
    const evidence = {
      url: `${ORIGIN}/cart`,
      title: 'Shopping Cart',
      text: `Your Cart Item added to cart: ${PRODUCT}`,
    };

    const emptyValueIntent = makeIntent({
      parameters: [{ name: 'search_item', value: '', label: 'Search Product' }],
      successConditions: [
        { type: 'finalPath', expected: '/cart' },
        { type: 'textPresent', input: 'search_item' },
      ],
    });
    assert.equal(orchestrator._evaluateSuccessConditions(emptyValueIntent, evidence).passed, false);

    const undeclaredIntent = {
      ...makeIntent(),
      successConditions: [
        { type: 'finalPath', expected: '/cart' },
        { type: 'textPresent', input: 'not_a_parameter' },
      ],
    };
    assert.equal(orchestrator._evaluateSuccessConditions(undeclaredIntent, evidence).passed, false);
  });

  it('does not launch a browser when a referenced parameter has no usable value', async () => {
    let createSessionCalls = 0;
    const spyRuntime = {
      async createSession() {
        createSessionCalls += 1;
        throw new Error('browser must not launch when preflight fails');
      },
    };
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: spyRuntime,
      modelProvider: { complete: async () => ({ text: '{}' }) },
      allowLocalhost: true,
    });

    const intent = makeIntent({
      parameters: [{ name: 'search_item', value: '', label: 'Search Product' }],
      successConditions: [
        { type: 'finalPath', expected: '/cart' },
        { type: 'textPresent', input: 'search_item' },
      ],
    });
    const result = await orchestrator.runDiscovery(intent);

    assert.equal(result.status, 'ABORTED_UNVERIFIABLE');
    assert.match(result.reason, /search_item/);
    assert.equal(result.candidate, undefined);
    assert.deepEqual(result.trace, []);
    assert.equal(createSessionCalls, 0, 'discovery must not create a browser session');
  });

  it('retains loop protection when repeated navigation cannot establish success', async () => {
    const calls = { navigate: [], closed: 0 };
    const session = {
      calls,
      async navigate(url) {
        calls.navigate.push(url);
      },
      async getSnapshot() {
        return {
          url: `${ORIGIN}/store`,
          title: 'SuperStore Catalog',
          text: 'SuperStore Catalog',
          elements: [
            { tag: 'a', role: 'link', name: 'Catalog', type: '', href: '/store', disabled: false },
          ],
        };
      },
      async close() {
        calls.closed += 1;
      },
    };
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeRuntime(session),
      modelProvider: {
        complete: async () => ({
          text: JSON.stringify({
            action: 'navigate',
            path: '/store',
            rationale: 'Repeat the same navigation',
            done: false,
          }),
        }),
      },
      maxSteps: 5,
      maxModelCalls: 5,
      allowLocalhost: true,
    });

    const result = await orchestrator.runDiscovery(makeIntent());

    assert.equal(result.status, 'ABORTED_UNVERIFIABLE');
    assert.match(result.reason, /redundant action loop/);
    assert.equal(calls.navigate.length, 2, 'initial navigation plus one executed repeat attempt only');
    assert.equal(result.candidate, undefined);
    assert.equal(calls.closed, 1);
  });
});
