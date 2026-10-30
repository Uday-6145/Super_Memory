import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findMatchingWorkflow } from '../../src/discovery/lookup.js';
import { createTaskIntent } from '../../src/discovery/task-intent.js';

/**
 * Workflow Retrieval Reliability Evaluation
 *
 * Matrix over the conservative matcher in src/discovery/lookup.js, modeled on
 * the real promoted workflow `search_for_the_requested_item_and_add_it`
 * (schemaVersion 1.1.0, origin http://127.0.0.1:8080, startPath /store,
 * input search_item, criteria finalPath /cart + textPresent {input}).
 *
 * The matcher requires, in order: enabled + verified + active version,
 * exact origin, exact startPath, input compatibility (required supplied,
 * nothing undeclared), success-criteria compatibility (structural binding
 * first, resolved literals second), and >= 2 shared meaningful objective
 * tokens. More than one survivor is ambiguity, never a guess.
 */

const ORIGIN = 'http://127.0.0.1:8080';
const START_PATH = '/store';

function makeRepository(entries) {
  const versions = new Map(entries.map(([manifest, version]) => [manifest.id, version]));
  return {
    async list() {
      return entries.map(([manifest]) => manifest);
    },
    async getVersion(workflowId) {
      if (!versions.has(workflowId)) throw new Error(`Unknown workflow ${workflowId}`);
      return versions.get(workflowId);
    },
  };
}

function promotedManifest(overrides = {}) {
  return {
    id: 'search_for_the_requested_item_and_add_it',
    name: 'Discovered: Search for the requested item and add it to the cart',
    description: 'Discovered: Search for the requested item and add it to the cart',
    enabled: true,
    activeVersion: 1,
    ...overrides,
  };
}

function promotedVersion(overrides = {}) {
  return {
    schemaVersion: '1.1.0',
    status: 'verified',
    target: { origin: ORIGIN, startPath: START_PATH },
    inputs: [{ name: 'search_item', type: 'string', label: 'Search Product', required: true }],
    successCriteria: { finalPath: '/cart', textPresent: { input: 'search_item' } },
    ...overrides,
  };
}

function makeIntent({
  objective = 'Search for the requested item and add it to the cart',
  product = 'Paneer Toast',
  parameters,
  successConditions,
  targetOrigin = ORIGIN,
  startPath = START_PATH,
} = {}) {
  return createTaskIntent({
    taskId: `task_eval_${objective.length}_${product.length}`,
    objective,
    targetOrigin,
    startPath,
    parameters: parameters ?? [{ name: 'search_item', value: product }],
    successConditions: successConditions ?? [
      { type: 'finalPath', expected: '/cart' },
      { type: 'textPresent', input: 'search_item' },
    ],
  });
}

function promotedRepo(manifestOverrides, versionOverrides) {
  return makeRepository([[promotedManifest(manifestOverrides), promotedVersion(versionOverrides)]]);
}

describe('Workflow Retrieval Evaluation — positive matches', () => {
  it('S1/S4: same task and binding matches for a different runtime product', async () => {
    for (const product of ['Paneer Toast', 'Fresh Paneer Pizza']) {
      const result = await findMatchingWorkflow(promotedRepo(), makeIntent({ product }));
      assert.equal(result.match, true, product);
      assert.equal(result.workflowId, 'search_for_the_requested_item_and_add_it');
      assert.equal(result.version, 1);
    }
  });

  it('S3: equivalent wording sharing >= 2 meaningful tokens matches', async () => {
    const result = await findMatchingWorkflow(
      promotedRepo(),
      makeIntent({ objective: 'Put the requested item into the cart' })
    );
    assert.equal(result.match, true);
  });
});

describe('Workflow Retrieval Evaluation — characterized false negative', () => {
  it('S2: synonymous wording sharing only one meaningful token does not match (conservative)', async () => {
    // "Find the product and put it in my cart" shares only "cart" with the
    // saved metadata tokens {search, requested, item, cart}. The >= 2 token
    // rule rejects it: a false negative by design. The consequence is an
    // unnecessary discovery session (model calls, possible duplicate
    // workflow), never a wrong-workflow execution.
    const result = await findMatchingWorkflow(
      promotedRepo(),
      makeIntent({ objective: 'Find the product and put it in my cart' })
    );
    assert.equal(result.match, false);
    assert.equal(result.ambiguous, undefined);
  });
});

describe('Workflow Retrieval Evaluation — negative matches', () => {
  it('S5a: comparing prices on the same site does not match', async () => {
    const result = await findMatchingWorkflow(
      promotedRepo(),
      makeIntent({
        objective: 'Compare prices for products',
        successConditions: [
          { type: 'finalPath', expected: '/compare' },
          { type: 'textPresent', input: 'search_item' },
        ],
      })
    );
    assert.equal(result.match, false);
  });

  it('S5b: wishlist task does not match, even with token-rich wording, because outcomes differ', async () => {
    const result = await findMatchingWorkflow(
      promotedRepo(),
      makeIntent({
        objective: 'Search for the requested item and add it to my wishlist',
        successConditions: [
          { type: 'finalPath', expected: '/wishlist' },
          { type: 'textPresent', input: 'search_item' },
        ],
      })
    );
    assert.equal(result.match, false);
  });

  it('S6: same task on a different origin does not match', async () => {
    const result = await findMatchingWorkflow(
      promotedRepo(),
      makeIntent({ targetOrigin: 'http://127.0.0.1:9090' })
    );
    assert.equal(result.match, false);
  });

  it('S7: same task with an incompatible start path does not match', async () => {
    const result = await findMatchingWorkflow(promotedRepo(), makeIntent({ startPath: '/catalog' }));
    assert.equal(result.match, false);
  });

  it('S8: literal Paneer Toast criterion does not match a Fresh Paneer Pizza request', async () => {
    const repo = promotedRepo(null, {
      schemaVersion: '1.0.0',
      successCriteria: { finalPath: '/cart', textPresent: 'Paneer Toast' },
    });
    const result = await findMatchingWorkflow(repo, makeIntent({ product: 'Fresh Paneer Pizza' }));
    assert.equal(result.match, false);
  });

  it('S9a: an unrelated parameter instead of the declared input does not match', async () => {
    // Literal conditions keep the intent itself valid; the saved workflow's
    // required search_item input is unsupplied and gift_note is undeclared.
    const result = await findMatchingWorkflow(
      promotedRepo(),
      makeIntent({
        parameters: [{ name: 'gift_note', value: 'Paneer Toast' }],
        successConditions: [
          { type: 'finalPath', expected: '/cart' },
          { type: 'textPresent', expected: 'Paneer Toast' },
        ],
      })
    );
    assert.equal(result.match, false);
  });

  it('S9b: an extra undeclared parameter alongside the declared input does not match', async () => {
    const result = await findMatchingWorkflow(
      promotedRepo(),
      makeIntent({
        parameters: [
          { name: 'search_item', value: 'Paneer Toast' },
          { name: 'coupon_code', value: 'SAVE10' },
        ],
      })
    );
    assert.equal(result.match, false);
  });
});

describe('Workflow Retrieval Evaluation — ambiguity and selection', () => {
  it('S10: two similar verified workflows produce ambiguity, not a guess', async () => {
    const second = promotedManifest({
      id: 'search_requested_item_add_v2',
      name: 'Search requested item and add it (v2)',
      description: 'Search for the requested item and add it to the cart',
    });
    const repo = makeRepository([
      [promotedManifest(), promotedVersion()],
      [second, promotedVersion()],
    ]);
    const result = await findMatchingWorkflow(repo, makeIntent());
    assert.equal(result.match, false);
    assert.equal(result.ambiguous, true);
    assert.deepEqual(
      result.candidates.map((c) => c.workflowId).sort(),
      ['search_for_the_requested_item_and_add_it', 'search_requested_item_add_v2']
    );
  });

  it('S11: a disabled workflow never matches', async () => {
    const result = await findMatchingWorkflow(promotedRepo({ enabled: false }), makeIntent());
    assert.equal(result.match, false);
  });

  it('S12a: with two token-matching candidates, the outcome-compatible one is selected', async () => {
    const checkout = promotedManifest({
      id: 'search_item_checkout_flow',
      name: 'Search requested item and complete checkout',
      description: 'Search for the requested item and add it, then complete checkout',
    });
    const checkoutVersion = promotedVersion({
      successCriteria: { finalPath: '/checkout', textPresent: 'Order Confirmed' },
    });
    const repo = makeRepository([
      [promotedManifest(), promotedVersion()],
      [checkout, checkoutVersion],
    ]);
    const result = await findMatchingWorkflow(repo, makeIntent());
    assert.equal(result.match, true);
    assert.equal(result.workflowId, 'search_for_the_requested_item_and_add_it');
    assert.equal(result.ambiguous, undefined);
  });

  it('S12b: with two token-matching candidates, the parameter-binding-compatible one is selected', async () => {
    const otherBinding = promotedManifest({
      id: 'find_product_add_cart',
      name: 'Find product and add to cart',
      description: 'Search for the requested item and add it to the cart',
    });
    const otherVersion = promotedVersion({
      inputs: [{ name: 'product_name', type: 'string', label: 'Product', required: true }],
      successCriteria: { finalPath: '/cart', textPresent: { input: 'product_name' } },
    });
    const repo = makeRepository([
      [promotedManifest(), promotedVersion()],
      [otherBinding, otherVersion],
    ]);
    const result = await findMatchingWorkflow(repo, makeIntent());
    assert.equal(result.match, true);
    assert.equal(result.workflowId, 'search_for_the_requested_item_and_add_it');
  });
});

describe('Workflow Retrieval Evaluation — characterized limitation', () => {
  it('declared success conditions are trusted: token-rich wording with cart conditions matches', async () => {
    // The matcher compares declared intent conditions, not objective
    // semantics. If an intent declares cart outcomes while its objective
    // says "wishlist", lookup cannot detect the contradiction. Playback
    // would still verify only the declared cart criteria. Intent authors
    // (including the NL parser) must keep conditions faithful to the task;
    // semantic entailment checking is out of scope for this matcher.
    const result = await findMatchingWorkflow(
      promotedRepo(),
      makeIntent({ objective: 'Search for the requested item and add it to my wishlist' })
    );
    assert.equal(result.match, true);
  });
});
