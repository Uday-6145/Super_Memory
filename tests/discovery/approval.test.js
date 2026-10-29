import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTaskIntent } from '../../src/discovery/task-intent.js';
import { DiscoveryOrchestrator } from '../../src/discovery/discovery-session.js';

const ORIGIN = 'http://127.0.0.1:8080';

function makeConsequentialSnapshot() {
  return {
    url: `${ORIGIN}/store`,
    title: 'SuperStore Catalog',
    text: 'Complete your purchase below.',
    elements: [
      { tag: 'button', role: 'button', name: 'Complete Order', type: 'button', disabled: false },
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
      return makeConsequentialSnapshot();
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

function makeIntent({ approvalRequired = [], forbidden = [] } = {}) {
  return createTaskIntent({
    taskId: `task_approval_${approvalRequired.length}_${forbidden.length}`,
    objective: 'Complete the test order',
    targetOrigin: ORIGIN,
    startPath: '/store',
    parameters: [{ name: 'search_item', value: 'test-item' }],
    successConditions: [{ type: 'finalPath', expected: '/receipt' }],
    approvalRequired,
    forbidden,
  });
}

function makeConsequentialModel() {
  return {
    complete: async () => ({
      text: JSON.stringify({
        action: 'clickByRole',
        elementIndex: 0,
        role: 'button',
        name: 'Complete Order',
        rationale: 'Test consequential order submission',
        done: false,
      }),
    }),
  };
}

describe('Discovery Engine — Consequential-Action Approval', () => {
  it('retains an unconditional forbidden-action block before any browser action', async () => {
    const session = makeFakeSession();
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeFakeRuntime(session),
      modelProvider: makeConsequentialModel(),
      allowLocalhost: true,
    });
    const intent = makeIntent({ forbidden: ['Complete Order'] });

    const result = await orchestrator.runDiscovery(intent);

    assert.equal(result.status, 'ABORTED_UNSAFE');
    assert.equal(session.calls.clickByRole.length, 0);
    assert.equal(result.candidate, undefined);
    assert.equal(session.calls.closed, 1);
  });

  it('requires explicit approval for a consequential action and performs no browser action by default', async () => {
    const session = makeFakeSession();
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeFakeRuntime(session),
      modelProvider: makeConsequentialModel(),
      allowLocalhost: true,
    });
    const intent = makeIntent();

    const result = await orchestrator.runDiscovery(intent);

    assert.equal(result.status, 'APPROVAL_REQUIRED');
    assert.match(result.reason, /No action was performed/);
    assert.equal(session.calls.clickByRole.length, 0);
    assert.equal(session.calls.fillByLabel.length, 0);
    assert.equal(result.candidate, undefined);
    assert.equal(session.calls.closed, 1);
  });

  it('treats declined approval as an approval-required outcome without browser action', async () => {
    const session = makeFakeSession();
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeFakeRuntime(session),
      modelProvider: makeConsequentialModel(),
      allowLocalhost: true,
      approveAction: async () => false,
    });
    const intent = makeIntent({ approvalRequired: ['Complete Order'] });

    const result = await orchestrator.runDiscovery(intent);

    assert.equal(result.status, 'APPROVAL_REQUIRED');
    assert.match(result.reason, /declined/);
    assert.equal(session.calls.clickByRole.length, 0);
    assert.equal(result.candidate, undefined);
  });

  it('executes an explicitly approved consequential action once and refuses a blind retry', async () => {
    const session = makeFakeSession();
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: makeFakeRuntime(session),
      modelProvider: makeConsequentialModel(),
      maxSteps: 5,
      maxModelCalls: 5,
      allowLocalhost: true,
      approveAction: async () => true,
    });
    const intent = makeIntent({ approvalRequired: ['Complete Order'] });

    const result = await orchestrator.runDiscovery(intent);

    assert.equal(result.status, 'ABORTED_UNVERIFIABLE');
    assert.match(result.reason, /already attempted once/);
    assert.equal(session.calls.clickByRole.length, 1);
    assert.deepEqual(session.calls.clickByRole[0], { role: 'button', name: 'Complete Order' });
    assert.equal(result.trace[0].approval.approved, true);
    assert.equal(result.candidate, undefined);
    assert.equal(session.calls.closed, 1);
  });
});
