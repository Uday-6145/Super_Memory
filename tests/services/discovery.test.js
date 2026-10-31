import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { FileSystemWorkflowRepository, calculateContentHash } from '../../src/workflow/index.js';
import { createBrowserRuntime } from '../../src/browser/index.js';
import { createExecutionService } from '../../src/services/execution.js';
import {
  createDiscoveryService,
  discover,
  resolveEffectiveInputs,
} from '../../src/services/discovery.js';
import {
  resolveEffectiveInputs as cliResolvedEffectiveInputs,
} from '../../src/cli/operator.js';

const ORIGIN = 'http://127.0.0.1:8099';
const SECRET = 'discovery-secret-value-9f8e7d';

describe('Discovery Service (M2 Phase 6)', () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-discovery-svc-'));
  });

  afterEach(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  async function makeRepo(dir) {
    const repo = new FileSystemWorkflowRepository({ baseDir: dir });
    await repo.init();
    return repo;
  }

  function makeIntent(overrides = {}) {
    return {
      taskId: `task_${Date.now().toString(36)}`,
      objective: 'Find the requested item and add it',
      targetOrigin: ORIGIN,
      startPath: '/catalog',
      parameters: [{ name: 'item', type: 'string', label: 'Item', description: 'item name', required: true, value: 'Widget' }],
      successConditions: [{ type: 'finalPath', expected: '/done' }],
      constraints: [],
      approvalRequired: [],
      forbidden: [],
      ...overrides,
    };
  }

  function sampleEvidence(workflowId, versionObj) {
    return {
      $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
      schemaVersion: '1.0.0',
      workflowId,
      version: versionObj.version,
      contentHash: calculateContentHash(versionObj),
      runId: `run_${workflowId}_${versionObj.version}`,
      verifiedAt: new Date().toISOString(),
      environment: {
        targetOrigin: ORIGIN,
        browserEngine: 'chromium',
        playwrightVersion: '1.64.1',
        nodeVersion: process.version,
        platform: process.platform,
      },
      stepResults: (versionObj.steps || []).map((s) => ({
        stepId: s.id, action: s.action, ok: true, status: 200, durationMs: 10, verification: null,
      })),
      successCriteriaResult: {
        passed: true, finalPath: '/done', pageTitleMatched: null,
        textPresentFound: null, textAbsentFound: null, details: 'ok',
      },
    };
  }

  async function seedVerifiedWorkflow(repo, id, intent) {
    // Lookup compares the request objective against the workflow id, name,
    // and description (never a stored intent), so the seed carries the
    // objective text exactly as production candidates do.
    await repo.createWorkflow({
      id,
      name: intent.objective,
      description: `${intent.objective} workflow`,
      target: { origin: intent.targetOrigin, startPath: intent.startPath },
      inputs: (intent.parameters || []).map((p) => ({
        name: p.name, type: p.type || 'string', label: p.label || p.name,
        description: p.description || '', required: p.required !== false,
      })),
      steps: [
        { id: 's1', order: 1, action: 'navigate', description: 'Go', params: { path: intent.startPath } },
      ],
      successCriteria: { finalPath: '/done' },
    });
    const versionObj = await repo.getVersion(id, 1);
    await repo.markVerified(id, 1, sampleEvidence(id, versionObj));
  }

  function counting(thunk, calls) {
    return async (...args) => {
      calls.push(args);
      return thunk(...args);
    };
  }

  function stubSession(overrides = {}) {
    const calls = { navigate: [], getSnapshot: [], clickByRole: [], fillByLabel: [], close: 0 };
    const elements = overrides.elements || [
      { tag: 'a', role: 'link', name: 'Next', type: null, placeholder: null, label: null, href: '/next', disabled: false },
    ];
    return {
      calls,
      async navigate(url) { calls.navigate.push(url); },
      async getSnapshot() {
        calls.getSnapshot.push({});
        return {
          url: overrides.url || `${ORIGIN}/catalog`,
          title: overrides.title || 'Catalog',
          text: overrides.text || 'catalog page',
          elements,
        };
      },
      async clickByRole(target) { calls.clickByRole.push(target); },
      async fillByLabel(target) { calls.fillByLabel.push(target); },
      async close() { calls.close += 1; },
    };
  }

  function stubRuntime(session, calls = []) {
    return {
      async createSession() {
        calls.push('createSession');
        return session;
      },
    };
  }

  function mockProvider(script, seen = []) {
    let index = 0;
    return {
      provider: 'mock-test',
      modelId: 'mock-test-1',
      async complete(request) {
        seen.push(request);
        const step = script[Math.min(index++, script.length - 1)];
        if (step instanceof Error) {
          throw step;
        }
        return { text: JSON.stringify(step), usage: { totalTokens: 10 }, provider: 'mock-test', model: 'mock-test-1' };
      },
    };
  }

  it('factory requires a repository and an execution service, without terminal I/O', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const execution = { playWorkflow: async () => ({}) };
    assert.throws(() => createDiscoveryService({}), /requires a repository/);
    assert.throws(() => createDiscoveryService(), /requires a repository/);
    assert.throws(() => createDiscoveryService({ repository: repo }), /requires an execution service/);
    assert.throws(
      () => createDiscoveryService({ repository: repo, execution: {} }),
      /requires an execution service/
    );
    const svc = createDiscoveryService({ repository: repo, execution });
    assert.equal(typeof svc.discover, 'function');
    assert.equal(svc.stdout, undefined);
    assert.equal(svc.stderr, undefined);
    assert.equal(svc.stdin, undefined);
  });

  it('normalizes all four intent input forms', async () => {
    const repo = await makeRepo(path.join(root, 'w'));
    const intent = makeIntent();
    await seedVerifiedWorkflow(repo, 'wf_norm', intent);
    const calls = [];
    const execution = { playWorkflow: async (args) => { calls.push(args); return { ok: true, version: 1 }; } };
    const svc = createDiscoveryService({ repository: repo, execution });

    await svc.discover({ task: intent, inputs: { item: 'Widget' }, journalDir: null });
    assert.equal(calls.length, 1, 'object form reaches lookup replay');

    calls.length = 0;
    await svc.discover({ task: JSON.stringify(intent), inputs: { item: 'Widget' }, journalDir: null });
    assert.equal(calls.length, 1, 'JSON string form reaches lookup replay');

    await assert.rejects(
      () => svc.discover({ task: '', journalDir: null }),
      /A task objective is required/
    );
    await assert.rejects(
      () => svc.discover({ task: 'do the thing', journalDir: null }),
      /requires an explicit --origin/
    );
    await assert.rejects(
      () => svc.discover({ task: { ...intent, objective: '' }, journalDir: null }),
      /objective/
    );
  });

  it('reconciles effective inputs and rejects conflicts, extras, and non-strings', async () => {
    assert.deepEqual(
      resolveEffectiveInputs({ parameters: [{ name: 'a', value: '' }] }, { a: 'x' }),
      { a: 'x' }
    );
    assert.deepEqual(
      resolveEffectiveInputs({ parameters: [{ name: 'a', value: 'x' }] }, { a: 'x' }),
      { a: 'x' }
    );
    assert.throws(
      () => resolveEffectiveInputs({ parameters: [{ name: 'a', value: 'x' }] }, { a: 'y' }),
      /conflicts/
    );
    assert.throws(
      () => resolveEffectiveInputs({ parameters: [{ name: 'a', value: 'x' }] }, { b: 'y' }),
      /not declared/
    );
    assert.throws(
      () => resolveEffectiveInputs({ parameters: [{ name: 'a', value: 'x' }] }, { a: 5 }),
      /must be a string/
    );
    assert.equal(cliResolvedEffectiveInputs, resolveEffectiveInputs, 'CLI compatibility re-export intact');
  });

  it('does not resolve providers for lookup hits or ambiguity', async () => {
    const repo = await makeRepo(path.join(root, 'w-hit'));
    const intent = makeIntent();
    await seedVerifiedWorkflow(repo, 'wf_hit', intent);
    const playCalls = [];
    const nlCalls = [];
    const discoCalls = [];
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async (args) => { playCalls.push(args); return { ok: true, version: 1 }; } },
    });

    const hit = await svc.discover({
      task: intent,
      inputs: { item: 'Widget' },
      journalDir: null,
      getNlProvider: counting(async () => { throw new Error('must not be called'); }, nlCalls),
      getDiscoveryProvider: counting(async () => { throw new Error('must not be called'); }, discoCalls),
    });
    assert.equal(hit.action, 'reused');
    assert.equal(hit.workflowId, 'wf_hit');
    assert.equal(nlCalls.length, 0);
    assert.equal(discoCalls.length, 0);
    assert.equal(playCalls.length, 1);

    const repo2 = await makeRepo(path.join(root, 'w-amb'));
    await seedVerifiedWorkflow(repo2, 'wf_one', intent);
    await seedVerifiedWorkflow(repo2, 'wf_two', intent);
    const svc2 = createDiscoveryService({
      repository: repo2,
      execution: { playWorkflow: async () => { throw new Error('must not be called'); } },
    });
    const ambiguous = await svc2.discover({
      task: intent,
      inputs: { item: 'Widget' },
      journalDir: null,
      getNlProvider: counting(async () => { throw new Error('must not be called'); }, nlCalls),
      getDiscoveryProvider: counting(async () => { throw new Error('must not be called'); }, discoCalls),
    });
    assert.equal(ambiguous.action, 'ambiguous');
    assert.equal(ambiguous.candidates.length, 2);
    assert.ok(ambiguous.intent, 'ambiguous result carries the intent for CLI messaging');
    assert.equal(nlCalls.length, 0);
    assert.equal(discoCalls.length, 0);
  });

  it('passes reconciled inputs to replay and creates no session or journal', async () => {
    const repo = await makeRepo(path.join(root, 'w-replay'));
    const intent = makeIntent({
      parameters: [{ name: 'item', type: 'string', label: 'Item', description: 'd', required: true, value: '' }],
    });
    await seedVerifiedWorkflow(repo, 'wf_replay', { ...intent, parameters: [{ ...intent.parameters[0], value: 'Widget' }] });
    const playCalls = [];
    const sessionCalls = [];
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async (args) => { playCalls.push(args); return { ok: true, version: 1 }; } },
      browserRuntime: stubRuntime(stubSession(), sessionCalls),
    });
    const journalDir = path.join(root, 'journals');

    const outcome = await svc.discover({
      task: intent,
      inputs: { item: 'Gadget' },
      journalDir,
      getNlProvider: async () => { throw new Error('must not be called'); },
      getDiscoveryProvider: async () => { throw new Error('must not be called'); },
    });
    assert.equal(outcome.action, 'reused');
    assert.deepEqual(playCalls, [{ workflowId: 'wf_replay', inputs: { item: 'Gadget' } }]);
    assert.equal(sessionCalls.length, 0, 'no browser session for replay');
    assert.deepEqual(await fs.readdir(journalDir).catch(() => []), [], 'no journal for replay');
  });

  it('requires the discovery provider only after a lookup miss', async () => {
    const repo = await makeRepo(path.join(root, 'w-miss'));
    const session = stubSession();
    const sessionCalls = [];
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async () => { throw new Error('must not replay on miss'); } },
      browserRuntime: stubRuntime(session, sessionCalls),
    });
    const nlCalls = [];
    const discoCalls = [];
    const journalDir = path.join(root, 'journals');

    const outcome = await svc.discover({
      task: makeIntent(),
      inputs: { item: 'Widget' },
      journalDir,
      maxSteps: 0,
      getNlProvider: counting(async () => { throw new Error('must not be called'); }, nlCalls),
      getDiscoveryProvider: counting(async () => mockProvider([{ done: 'yes' }]), discoCalls),
      fixtureStarter: async () => null,
    });
    assert.equal(outcome.action, 'failed');
    assert.equal(outcome.status, 'ABORTED_BUDGET');
    assert.equal(nlCalls.length, 0, 'structured intents never need the NL provider');
    assert.equal(discoCalls.length, 1, 'discovery provider resolved exactly once after the miss');
    assert.equal(sessionCalls.length, 1, 'a session is opened for genuine discovery');

    await assert.rejects(
      () => svc.discover({ task: makeIntent(), inputs: { item: 'Widget' }, journalDir }),
      /requires a model provider with a complete\(\) method/
    );
  });

  it('resolves the NL provider for plain-text objectives; hits skip discovery', async () => {
    // Genuine NL-draft protocol: only objective/parameters/constraints/
    // successConditions/approvalRequired/forbidden; conditions carry
    // {type, expected} literals. Target and start path come from the caller.
    const nlDraft = {
      objective: 'Find the requested item and add it',
      parameters: [{ name: 'item', value: 'Widget' }],
      constraints: [],
      successConditions: [{ type: 'finalPath', expected: '/done' }],
      approvalRequired: [],
      forbidden: [],
    };
    const declaredParams = [
      { name: 'item', type: 'string', label: 'Item', description: 'd', required: true, value: '' },
    ];

    // Part A: empty repo -> NL parse succeeds, lookup misses, discovery
    // provider is resolved exactly once (maxSteps 0 keeps it model-free).
    const repoA = await makeRepo(path.join(root, 'w-nl-miss'));
    const svcA = createDiscoveryService({
      repository: repoA,
      execution: { playWorkflow: async () => { throw new Error('must not replay on miss'); } },
      browserRuntime: stubRuntime(stubSession(), []),
    });
    const nlCallsA = [];
    const discoCallsA = [];
    const seenA = [];
    const miss = await svcA.discover({
      task: 'Find the requested item and add it',
      origin: ORIGIN,
      startPath: '/catalog',
      parameters: declaredParams,
      inputs: { item: 'Widget' },
      journalDir: path.join(root, 'j-nl-miss'),
      maxSteps: 0,
      getNlProvider: counting(async () => mockProvider([nlDraft], seenA), nlCallsA),
      getDiscoveryProvider: counting(async () => mockProvider([{ done: 'yes' }]), discoCallsA),
      fixtureStarter: async () => null,
    });
    assert.equal(miss.action, 'failed');
    assert.equal(miss.status, 'ABORTED_BUDGET');
    assert.equal(nlCallsA.length, 1, 'NL provider resolved exactly once for plain text');
    assert.equal(seenA.length, 1, 'NL provider invoked exactly once');
    assert.equal(discoCallsA.length, 1, 'lookup miss resolves the discovery provider');

    // Part B: seeded repo -> NL parse succeeds, lookup hits, replay runs,
    // and the discovery provider is never resolved.
    const repoB = await makeRepo(path.join(root, 'w-nl-hit'));
    await seedVerifiedWorkflow(repoB, 'wf_nl', makeIntent());
    const playCallsB = [];
    const svcB = createDiscoveryService({
      repository: repoB,
      execution: { playWorkflow: async (args) => { playCallsB.push(args); return { ok: true, version: 1 }; } },
      browserRuntime: stubRuntime(stubSession(), []),
    });
    const nlCallsB = [];
    const discoCallsB = [];
    const hit = await svcB.discover({
      task: 'Find the requested item and add it',
      origin: ORIGIN,
      startPath: '/catalog',
      parameters: declaredParams,
      inputs: { item: 'Widget' },
      journalDir: null,
      getNlProvider: counting(async () => mockProvider([nlDraft]), nlCallsB),
      getDiscoveryProvider: counting(async () => { throw new Error('must not be called'); }, discoCallsB),
    });
    assert.equal(hit.action, 'reused');
    assert.equal(hit.workflowId, 'wf_nl');
    assert.equal(nlCallsB.length, 1);
    assert.equal(discoCallsB.length, 0, 'lookup hits never resolve the discovery provider');
    assert.deepEqual(playCallsB[0].inputs, { item: 'Widget' });
  });

  it('rejects invalid model decisions without creating a draft', async () => {
    const repo = await makeRepo(path.join(root, 'w-invalid'));
    const session = stubSession();
    const seen = [];
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async () => { throw new Error('must not be called'); } },
      browserRuntime: stubRuntime(session, []),
    });
    const journalDir = path.join(root, 'journals');

    const outcome = await svc.discover({
      task: makeIntent(),
      inputs: { item: 'Widget' },
      journalDir,
      getDiscoveryProvider: async () => mockProvider(['not-an-action', 'still-bogus'], seen),
      fixtureStarter: async () => null,
    });
    assert.equal(outcome.action, 'failed');
    assert.equal(outcome.status, 'ABORTED_AMBIGUOUS');
    assert.equal(seen.length, 2, 'bounded consecutive invalid decisions');
    assert.equal(session.calls.clickByRole.length, 0);
    assert.equal(session.calls.fillByLabel.length, 0);
  });

  it('rejects ungrounded actions without creating a draft', async () => {
    const repo = await makeRepo(path.join(root, 'w-ungrounded'));
    const session = stubSession();
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async () => { throw new Error('must not be called'); } },
      browserRuntime: stubRuntime(session, []),
    });

    const outcome = await svc.discover({
      task: makeIntent(),
      inputs: { item: 'Widget' },
      journalDir: null,
      getDiscoveryProvider: async () => mockProvider([
        { action: 'clickByRole', elementIndex: 99, role: 'button', name: 'Ghost', rationale: 'nope' },
        { action: 'clickByRole', elementIndex: 99, role: 'button', name: 'Ghost', rationale: 'nope' },
      ]),
      fixtureStarter: async () => null,
    });
    assert.equal(outcome.action, 'failed');
    assert.equal((await repo.list({})).length, 0, 'no candidate may be persisted');
    assert.equal(session.calls.clickByRole.length, 0, 'ungrounded actions never execute');
  });

  it('refuses consequential actions without approval and never retries them', async () => {
    const repo = await makeRepo(path.join(root, 'w-approval'));
    const session = stubSession({
      elements: [
        { tag: 'button', role: 'button', name: 'Complete Order', type: 'submit', placeholder: null, label: null, href: null, disabled: false },
      ],
      text: 'review your order',
    });
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async () => { throw new Error('must not be called'); } },
      browserRuntime: stubRuntime(session, []),
    });

    const outcome = await svc.discover({
      task: makeIntent(),
      inputs: { item: 'Widget' },
      journalDir: null,
      getDiscoveryProvider: async () => mockProvider([
        { action: 'clickByRole', elementIndex: 0, role: 'button', name: 'Complete Order', rationale: 'proceed' },
      ]),
      fixtureStarter: async () => null,
    });
    assert.equal(outcome.action, 'failed');
    assert.equal(outcome.status, 'APPROVAL_REQUIRED');
    assert.equal(session.calls.clickByRole.length, 0, 'unapproved consequential action performs zero browser actions');
  });

  it('enforces budgets and cancellation with journal finalization', async () => {
    const repo = await makeRepo(path.join(root, 'w-budget'));
    const session = stubSession();
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async () => { throw new Error('must not be called'); } },
      browserRuntime: stubRuntime(session, []),
    });
    const journalDir = path.join(root, 'journals-budget');

    const budgeted = await svc.discover({
      task: makeIntent(),
      inputs: { item: 'Widget' },
      journalDir,
      maxSteps: 1,
      getDiscoveryProvider: async () => mockProvider([
        { action: 'navigate', path: '/elsewhere' },
      ]),
      fixtureStarter: async () => null,
    });
    assert.equal(budgeted.action, 'failed');
    assert.equal(budgeted.status, 'ABORTED_BUDGET');
    const files = await fs.readdir(journalDir);
    assert.equal(files.length, 1, 'failed discovery finalizes its journal');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await svc.discover({
      task: makeIntent(),
      inputs: { item: 'Widget' },
      journalDir: path.join(root, 'journals-cancel'),
      signal: controller.signal,
      getDiscoveryProvider: async () => mockProvider([{ action: 'navigate', path: '/x' }]),
      fixtureStarter: async () => null,
    });
    assert.equal(cancelled.action, 'failed');
    assert.equal(cancelled.status, 'CANCELLED');
  });

  it('never leaks raw secrets into prompts, events, journals, or persisted output', async () => {
    const repo = await makeRepo(path.join(root, 'w-redact'));
    const session = stubSession({
      text: `items ${SECRET} here`,
      elements: [
        { tag: 'input', role: 'textbox', name: null, type: 'text', placeholder: null, label: 'Item', href: null, disabled: false },
        { tag: 'button', role: 'button', name: 'Nope', type: 'submit', placeholder: null, label: null, href: null, disabled: false },
      ],
    });
    const seen = [];
    const events = [];
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async () => { throw new Error('must not be called'); } },
      browserRuntime: stubRuntime(session, []),
    });
    const journalDir = path.join(root, 'journals-redact');

    const outcome = await svc.discover({
      task: makeIntent({ parameters: [{ name: 'item', type: 'string', label: 'Item', description: 'd', required: false, value: '' }] }),
      inputs: { item: SECRET },
      journalDir,
      maxSteps: 1,
      getDiscoveryProvider: async () => mockProvider([{ action: 'navigate', path: '/catalog' }], seen),
      fixtureStarter: async () => null,
      onEvent: (ev) => { events.push(ev); },
    });
    assert.equal(outcome.action, 'failed');
    assert.ok(!JSON.stringify(seen).includes(SECRET), 'model prompts must not contain raw parameter values');
    assert.ok(!JSON.stringify(events).includes(SECRET), 'progress events must not contain raw values');
    const journalFiles = await fs.readdir(journalDir);
    assert.equal(journalFiles.length, 1);
    const journalRaw = await fs.readFile(path.join(journalDir, journalFiles[0]), 'utf8');
    assert.ok(!journalRaw.includes(SECRET), 'journals must not contain raw values');
  });

  it('discovers and persists a validated draft with parameter-bound criteria', async () => {
    const repo = await makeRepo(path.join(root, 'w-success'));
    const intent = makeIntent({
      parameters: [{ name: 'item', type: 'string', label: 'Item', description: 'd', required: true, value: '' }],
      successConditions: [
        { type: 'finalPath', expected: '/basket' },
        { type: 'textPresent', input: 'item' },
      ],
    });
    const calls = { clickByRole: [], fillByLabel: [], navigate: [], close: 0 };
    const catalogSnapshot = {
      url: `${ORIGIN}/catalog`,
      title: 'Catalog',
      text: 'items here',
      elements: [
        { tag: 'input', role: 'textbox', name: null, type: 'text', placeholder: null, label: 'Item', href: null, disabled: false },
        { tag: 'button', role: 'button', name: 'Add to basket', type: 'submit', placeholder: null, label: null, href: null, disabled: false },
      ],
    };
    let current = catalogSnapshot;
    const session = {
      calls,
      async navigate(url) { calls.navigate.push(url); },
      async getSnapshot() { return current; },
      async fillByLabel(target) {
        calls.fillByLabel.push(target);
        current = { ...current, text: 'items here Widget' };
      },
      async clickByRole(target) {
        calls.clickByRole.push(target);
        current = {
          url: `${ORIGIN}/basket`,
          title: 'Basket',
          text: 'Widget',
          elements: [],
        };
      },
      async close() { calls.close += 1; },
    };
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async () => { throw new Error('must not replay on miss'); } },
      browserRuntime: stubRuntime(session, []),
    });

    const seen = [];
    const outcome = await svc.discover({
      task: intent,
      inputs: { item: 'Widget' },
      journalDir: null,
      getDiscoveryProvider: async () => {
        let n = 0;
        const provider = mockProvider([], seen);
        provider.complete = async (request) => {
          seen.push(request);
          n += 1;
          if (n === 1) {
            return { text: JSON.stringify({ action: 'fillByLabel', elementIndex: 0, label: 'Item', inputName: 'item', rationale: 'enter item' }) };
          }
          return { text: JSON.stringify({ action: 'clickByRole', elementIndex: 1, role: 'button', name: 'Add to basket', rationale: 'add', expects: { type: 'textPresent', expected: 'Widget' } }) };
        };
        return provider;
      },
      fixtureStarter: async () => null,
    });

    assert.equal(seen.length, 2, 'fill then click, then success');
    assert.equal(outcome.action, 'discovered');
    assert.equal(outcome.draft.version, 1);
    assert.equal(outcome.draft.schemaVersion, '1.1.0', 'input-bound criteria select schema 1.1.0');
    assert.equal(outcome.contentHash, calculateContentHash(outcome.draft));
    const manifest = await repo.getManifest(outcome.workflowId);
    assert.equal(manifest.draftVersion, 1);
    assert.equal(manifest.activeVersion ?? null, null, 'discovery never activates');
    assert.deepEqual(outcome.draft.inputs, [{ name: 'item', type: 'string', label: 'Item', description: 'd', required: true }]);
    assert.deepEqual(
      outcome.draft.successCriteria,
      { finalPath: '/basket', textPresent: { input: 'item' } },
      'parameter-bound criteria survive the round trip'
    );
  });

  it('fails closed on unresolved parameter references without browser or model use', async () => {
    const repo = await makeRepo(path.join(root, 'w-preflight'));
    const session = stubSession();
    const createCalls = [];
    const seen = [];
    const svc = createDiscoveryService({
      repository: repo,
      execution: { playWorkflow: async () => { throw new Error('must not be called'); } },
      browserRuntime: stubRuntime(session, createCalls),
    });

    const outcome = await svc.discover({
      task: makeIntent({
        parameters: [{ name: 'item', type: 'string', label: 'Item', description: 'd', required: true, value: '' }],
        successConditions: [
          { type: 'finalPath', expected: '/basket' },
          { type: 'textPresent', input: 'item' },
        ],
      }),
      inputs: {},
      journalDir: null,
      getDiscoveryProvider: async () => mockProvider([{ action: 'navigate', path: '/' }], seen),
      fixtureStarter: async () => { throw new Error('must not be called'); },
    });
    assert.equal(outcome.action, 'failed');
    assert.equal(outcome.status, 'ABORTED_UNVERIFIABLE');
    assert.equal(createCalls.length, 0, 'no browser session for unresolvable criteria');
    assert.equal(seen.length, 0, 'no model calls for unresolvable criteria');
  });

  describe('Discovery-to-Execution integration (real browser)', () => {
    let fixtureServer;
    let baseUrl;
    let sharedRuntime;

    before(async () => {
      fixtureServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (req.url === '/shelf') {
          res.end('<!DOCTYPE html><html><head><title>Shelf</title></head><body><h1>Shelf</h1><p>Depot shelf</p></body></html>');
        } else {
          res.end('<!DOCTYPE html><html><head><title>Shop</title></head><body><h1>Shop</h1><p>Browse the aisles</p><a href="/shelf">View shelf</a></body></html>');
        }
      });
      await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${fixtureServer.address().port}`;
      sharedRuntime = createBrowserRuntime({ headless: true });
    });

    after(async () => {
      if (sharedRuntime) {
        await sharedRuntime.close();
      }
      if (fixtureServer) {
        await new Promise((resolve) => fixtureServer.close(resolve));
      }
    });

    it('discovers a validated draft end to end and persists it', async () => {
      const repo = await makeRepo(path.join(root, 'w-e2e'));
      const execution = createExecutionService({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        headless: true,
        fixtureStarter: async () => null,
      });
      const svc = createDiscoveryService({ repository: repo, execution });
      const seen = [];

      const outcome = await svc.discover({
        task: {
          taskId: 'task_e2e_navigate',
          objective: 'Open the depot shelf',
          targetOrigin: baseUrl,
          startPath: '/',
          parameters: [],
          successConditions: [{ type: 'textPresent', expected: 'Depot shelf' }],
          constraints: [],
          approvalRequired: [],
          forbidden: [],
        },
        inputs: {},
        journalDir: null,
        allowLocalhost: true,
        getDiscoveryProvider: async () => mockProvider([
          { action: 'navigate', path: '/shelf', done: true },
        ], seen),
        fixtureStarter: async () => null,
      });

      assert.equal(seen.length, 1, 'exactly one model call for the single-step flow');
      assert.equal(outcome.action, 'discovered');
      assert.equal(outcome.draft.version, 1);
      assert.equal(outcome.draft.schemaVersion, '1.0.0', 'literal criteria keep schema 1.0.0');
      const manifest = await repo.getManifest(outcome.workflowId);
      assert.equal(manifest.draftVersion, 1);
      assert.equal(manifest.activeVersion ?? null, null);
    });
  });
});
