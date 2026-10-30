import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DiscoveryOrchestrator } from '../../src/discovery/discovery-session.js';
import {
  DiscoverySessionJournal,
  validateJournalRecord,
  sanitizeJournalTaskId,
} from '../../src/discovery/session-journal.js';
import { createTaskIntent } from '../../src/discovery/task-intent.js';

const ORIGIN = 'http://127.0.0.1:8080';
const SECRET = 'sk-test-SECRET-77zKq2';

function makeIntent(taskId = 'task_journal_probe') {
  return createTaskIntent({
    taskId,
    objective: `Probe journal handling for ${SECRET}`,
    targetOrigin: ORIGIN,
    startPath: '/store',
    parameters: [{ name: 'search_item', value: SECRET }],
    successConditions: [{ type: 'finalPath', expected: '/receipt' }],
  });
}

function makeSnapshot(urlPath, controlName, { tag = 'button', role = 'button', type = 'button' } = {}) {
  return {
    url: `${ORIGIN}${urlPath}`,
    title: `Probe ${urlPath}`,
    text: `Sensitive page text mentioning ${SECRET} must never persist.`,
    elements: [
      { tag, role, name: controlName, type, disabled: false },
    ],
  };
}

function makeFakeSession({ afterClickUrlPath = '/cart', controlName = 'Go to cart', role = 'button', tag = 'button' } = {}) {
  const calls = { navigate: [], clickByRole: [], closed: 0 };
  return {
    calls,
    async navigate(url) {
      calls.navigate.push(url);
    },
    async getSnapshot() {
      const path = calls.clickByRole.length > 0 ? afterClickUrlPath : '/store';
      return makeSnapshot(path, controlName, { role, tag });
    },
    async clickByRole(args) {
      calls.clickByRole.push(args);
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

describe('Discovery — Crash-Safe Session Journal', () => {
  let journalDir;

  before(async () => {
    journalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-journal-test-'));
  });

  after(async () => {
    await fs.rm(journalDir, { recursive: true, force: true });
  });

  it('sanitizes task IDs for safe journal filenames', () => {
    assert.equal(sanitizeJournalTaskId('../../etc/passwd'), '_etc_passwd');
    assert.equal(sanitizeJournalTaskId('plain-task_01'), 'plain-task_01');
    assert.ok(!sanitizeJournalTaskId('../../etc/passwd').includes('/'));
  });

  it('writes checkpoints that validate and contain no secrets or page content', async () => {
    const journal = new DiscoverySessionJournal({ journalDir, taskId: 'probe_unit', secrets: [SECRET] });
    const journalPath = await journal.checkpoint({
      intent: makeIntent('probe_unit'),
      stepIndex: 1,
      modelCallCount: 1,
      totalTokensUsed: 100,
      lastObservation: makeSnapshot('/store', 'Complete Order'),
      attemptedConsequentialKeys: ['clickByRole:0:Complete Order'],
      reason: 'completed step 1',
    });

    const record = await DiscoverySessionJournal.read(journalPath);
    assert.equal(record.status, 'in-progress');
    assert.equal(record.stepIndex, 1);
    assert.equal(record.attemptedConsequentialKeyHashes.length, 1);
    assert.ok(/^[0-9a-f]{64}$/.test(record.attemptedConsequentialKeyHashes[0]));

    const raw = await fs.readFile(journalPath, 'utf8');
    assert.ok(!raw.includes(SECRET), 'journal must not persist raw runtime input values');
    assert.ok(!raw.includes('Complete Order'), 'journal must not persist control names');
    assert.ok(!raw.includes('Sensitive page text'), 'journal must not persist page text');
  });

  it('detects interrupted sessions and flags corrupt files separately', async () => {
    const subDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-journal-scan-'));
    try {
      const journal = new DiscoverySessionJournal({ journalDir: subDir, taskId: 'interrupted_probe' });
      const journalPath = await journal.checkpoint({
        intent: makeIntent('interrupted_probe'),
        stepIndex: 2,
        modelCallCount: 2,
        totalTokensUsed: 200,
        lastObservation: null,
        attemptedConsequentialKeys: [],
        reason: 'session started',
      });
      await fs.writeFile(path.join(subDir, 'discovery-truncated.json'), '{"journalVersion":');
      await fs.writeFile(path.join(subDir, 'discovery-note.tmp-123'), 'partial write bytes');

      const { incomplete, corrupt } = await DiscoverySessionJournal.listIncomplete(subDir);

      assert.equal(incomplete.length, 1);
      assert.equal(incomplete[0].taskId, 'interrupted_probe');
      assert.equal(incomplete[0].status, 'in-progress');
      assert.equal(incomplete[0].path, journalPath);
      assert.equal(corrupt.length, 1);
      assert.match(corrupt[0].error, /not valid JSON/);
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it('retains terminal journals but no longer reports them as incomplete', async () => {
    const subDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-journal-terminal-'));
    try {
      const journal = new DiscoverySessionJournal({ journalDir: subDir, taskId: 'terminal_probe' });
      await journal.checkpoint({
        intent: makeIntent('terminal_probe'),
        stepIndex: 0,
        modelCallCount: 0,
        totalTokensUsed: 0,
        lastObservation: null,
        attemptedConsequentialKeys: [],
        reason: 'session started',
      });
      await journal.finalize('ABORTED_UNVERIFIABLE', {
        intent: makeIntent('terminal_probe'),
        stepIndex: 0,
        modelCallCount: 1,
        totalTokensUsed: 50,
        lastObservation: null,
        attemptedConsequentialKeys: [],
        reason: 'terminal state ABORTED_UNVERIFIABLE',
      });

      const { incomplete, corrupt } = await DiscoverySessionJournal.listIncomplete(subDir);
      assert.equal(incomplete.length, 0);
      assert.equal(corrupt.length, 0);
      const record = await DiscoverySessionJournal.read(journal.journalPath);
      assert.equal(record.status, 'ABORTED_UNVERIFIABLE');
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it('rejects tampered journal records on read', async () => {
    const journal = new DiscoverySessionJournal({ journalDir, taskId: 'tamper_probe' });
    const journalPath = await journal.checkpoint({
      intent: makeIntent('tamper_probe'),
      stepIndex: 0,
      modelCallCount: 0,
      totalTokensUsed: 0,
      lastObservation: null,
      attemptedConsequentialKeys: [],
      reason: 'session started',
    });
    const record = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    record.stepIndex = -5;
    record.injected = true;
    await fs.writeFile(journalPath, JSON.stringify(record));

    await assert.rejects(() => DiscoverySessionJournal.read(journalPath), /unexpected keys/);
    assert.throws(() => validateJournalRecord({}), /unexpected keys/);
    assert.throws(() => validateJournalRecord(null), /non-null object/);
  });

  it('refuses automatic resumption without any browser interaction', async () => {
    const journal = new DiscoverySessionJournal({ journalDir, taskId: 'resume_probe' });
    const journalPath = await journal.checkpoint({
      intent: makeIntent('resume_probe'),
      stepIndex: 3,
      modelCallCount: 3,
      totalTokensUsed: 300,
      lastObservation: makeSnapshot('/checkout', 'Complete Order'),
      attemptedConsequentialKeys: ['clickByRole:0:Complete Order'],
      reason: 'terminal state ABORTED_UNVERIFIABLE',
    });

    await assert.rejects(
      () => DiscoverySessionJournal.refuseResume(journalPath),
      (err) => {
        assert.match(err.message, /Automatic resumption is refused/);
        assert.match(err.message, /controlled restart/);
        return true;
      }
    );
  });

  it('deletes the scratch journal when discovery succeeds', async () => {
    const session = makeFakeSession({ afterClickUrlPath: '/cart' });
    const subDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-journal-success-'));
    try {
      const orchestrator = new DiscoveryOrchestrator({
        browserRuntime: makeFakeRuntime(session),
        modelProvider: {
          complete: async () => ({
            text: JSON.stringify({
              action: 'clickByRole',
              elementIndex: 0,
              role: 'button',
              name: 'Go to cart',
              rationale: 'Advance to cart',
              done: false,
            }),
          }),
        },
        allowLocalhost: true,
        journalDir: subDir,
        approveAction: async () => true,
      });
      const intent = createTaskIntent({
        taskId: 'task_journal_success',
        objective: 'Reach the cart',
        targetOrigin: ORIGIN,
        startPath: '/store',
        parameters: [{ name: 'search_item', value: SECRET }],
        successConditions: [{ type: 'finalPath', expected: '/cart' }],
      });

      const result = await orchestrator.runDiscovery(intent);

      assert.equal(result.status, 'SUCCESS');
      assert.ok(result.candidate, 'a candidate must be produced');
      const remaining = await fs.readdir(subDir);
      assert.deepEqual(remaining.filter((name) => !name.includes('.tmp-')), [], 'successful sessions must clean up scratch journals');
      const { incomplete } = await DiscoverySessionJournal.listIncomplete(subDir);
      assert.equal(incomplete.length, 0);
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it('retains an aborted journal with attempted consequential hashes and no secrets', async () => {
    const session = makeFakeSession({ controlName: 'Complete Order' });
    const subDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-journal-abort-'));
    try {
      const orchestrator = new DiscoveryOrchestrator({
        browserRuntime: makeFakeRuntime(session),
        modelProvider: {
          complete: async () => ({
            text: JSON.stringify({
              action: 'clickByRole',
              elementIndex: 0,
              role: 'button',
              name: 'Complete Order',
              rationale: 'Test consequential attempt',
              done: false,
            }),
          }),
        },
        maxSteps: 5,
        maxModelCalls: 5,
        allowLocalhost: true,
        journalDir: subDir,
        approveAction: async () => true,
      });

      const result = await orchestrator.runDiscovery(makeIntent('task_journal_abort'));

      assert.equal(result.status, 'ABORTED_UNVERIFIABLE');
      assert.equal(session.calls.clickByRole.length, 1);
      assert.ok(orchestrator.lastJournalPath, 'orchestrator must expose the journal path');
      const record = await DiscoverySessionJournal.read(orchestrator.lastJournalPath);
      assert.equal(record.status, 'ABORTED_UNVERIFIABLE');
      assert.equal(record.attemptedConsequentialKeyHashes.length, 1);
      const raw = await fs.readFile(orchestrator.lastJournalPath, 'utf8');
      assert.ok(!raw.includes(SECRET), 'journal must not persist runtime input values');
      assert.ok(!raw.includes('Complete Order'), 'journal must not persist control names');
      assert.ok(!raw.includes('Sensitive page text'), 'journal must not persist page text');
      const { incomplete } = await DiscoverySessionJournal.listIncomplete(subDir);
      assert.equal(incomplete.length, 0, 'terminal journals are not incomplete');
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });
});
