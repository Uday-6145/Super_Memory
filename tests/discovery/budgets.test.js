import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTaskIntent } from '../../src/discovery/task-intent.js';
import { DiscoveryOrchestrator } from '../../src/discovery/discovery-session.js';

const ORIGIN = 'http://127.0.0.1:8080';

function makeSnapshot() {
  return {
    url: `${ORIGIN}/store`,
    title: 'SuperStore Catalog',
    text: 'Add an item to the cart.',
    elements: [
      { tag: 'button', role: 'button', name: 'Add to Cart', type: 'button', disabled: false },
    ],
  };
}

function makeFakeSession() {
  const calls = { navigate: [], clickByRole: [], fillByLabel: [], closed: 0 };
  return {
    calls,
    async navigate(url) {
      calls.navigate.push(url);
    },
    async getSnapshot() {
      return makeSnapshot();
    },
    async clickByRole(args) {
      calls.clickByRole.push(args);
    },
    async fillByLabel(args) {
      calls.fillByLabel.push(args);
    },
    async close() {
      calls.closed += 1;
    },
  };
}

function makeFakeRuntime(session) {
  return {
    async createSession() {
      return session;
    },
  };
}

function makeIntent() {
  return createTaskIntent({
    taskId: 'task_budget_boundary',
    objective: 'Add an item to the cart',
    targetOrigin: ORIGIN,
    startPath: '/store',
    parameters: [{ name: 'search_item', value: 'test-item' }],
    successConditions: [{ type: 'finalPath', expected: '/receipt' }],
  });
}

function makeModel(usages) {
  let calls = 0;
  return {
    calls: () => calls,
    complete: async () => {
      const usage = usages[calls];
      calls += 1;
      const response = {
        text: JSON.stringify({
          action: 'clickByRole',
          elementIndex: 0,
          role: 'button',
          name: 'Add to Cart',
          rationale: 'Boundary test action',
          done: false,
        }),
      };
      if (usage !== undefined) {
        response.usage = usage;
      }
      return response;
    },
  };
}

describe('Discovery Engine — Resource Budgets and Cancellation', () => {
  it('aborts exactly when cumulative tokens reach the configured maximum', async () => {
    const session = makeFakeSession();
    const model = makeModel([{ totalTokens: 1000 }, { totalTokens: 2000 }]);
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeFakeRuntime(session),
      modelProvider: model,
      maxTotalTokens: 3000,
      allowLocalhost: true,
    });

    const result = await orchestrator.runDiscovery(makeIntent());

    assert.equal(result.status, 'ABORTED_BUDGET');
    assert.match(result.reason, /cumulative model tokens/);
    assert.equal(model.calls(), 2);
    assert.equal(session.calls.clickByRole.length, 1);
    assert.equal(result.candidate, undefined);
    assert.equal(session.calls.closed, 1);
  });

  it('uses a conservative token estimate when provider usage is missing', async () => {
    const session = makeFakeSession();
    const model = makeModel([undefined]);
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeFakeRuntime(session),
      modelProvider: model,
      maxTotalTokens: 2048,
      allowLocalhost: true,
    });

    const result = await orchestrator.runDiscovery(makeIntent());

    assert.equal(result.status, 'ABORTED_BUDGET');
    assert.equal(model.calls(), 1);
    assert.equal(session.calls.clickByRole.length, 0);
    assert.equal(result.candidate, undefined);
  });

  it('aborts exactly at the wall-clock boundary before further model work', async () => {
    const session = makeFakeSession();
    const model = makeModel([{ totalTokens: 10 }]);
    const times = [0, 100];
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeFakeRuntime(session),
      modelProvider: model,
      maxWallClockMs: 100,
      now: () => (times.length > 0 ? times.shift() : 100),
      allowLocalhost: true,
    });

    const result = await orchestrator.runDiscovery(makeIntent());

    assert.equal(result.status, 'ABORTED_BUDGET');
    assert.match(result.reason, /wall-clock/);
    assert.equal(model.calls(), 0);
    assert.equal(session.calls.clickByRole.length, 0);
    assert.equal(session.calls.closed, 1);
  });

  it('honours caller cancellation and closes the browser session', async () => {
    const session = makeFakeSession();
    const controller = new AbortController();
    const baseModel = makeModel([{ totalTokens: 10 }, { totalTokens: 10 }]);
    const model = {
      complete: async (args) => {
        const response = await baseModel.complete(args);
        controller.abort();
        return response;
      },
    };
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeFakeRuntime(session),
      modelProvider: model,
      allowLocalhost: true,
    });

    const result = await orchestrator.runDiscovery(makeIntent(), { signal: controller.signal });

    assert.equal(result.status, 'CANCELLED');
    assert.equal(result.candidate, undefined);
    assert.equal(session.calls.closed, 1);
  });
});
