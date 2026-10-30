/**
 * Super Memory — Parameter-Bound Success Criteria Tests (schemaVersion 1.1.0)
 *
 * Verifies that a single workflow can verify different runtime products via
 * {"input": "<declared-input>"} success-criterion references, resolved locally
 * at playback time, without persisting resolved values in evidence.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  FileSystemWorkflowRepository,
  WorkflowPlayer,
  calculateContentHash,
} from '../../src/workflow/index.js';
import { createBrowserRuntime } from '../../src/browser/index.js';

const CATALOG = new Set(['Paneer Toast', 'Fresh Paneer Pizza']);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

describe('Parameter-bound success criteria (schemaVersion 1.1.0)', () => {
  let fixtureServer;
  let baseUrl;
  let tempBaseDir;
  let repo;
  let sharedRuntime;

  before(async () => {
    fixtureServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/store') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Store</title></head>
<body>
  <h1>Store</h1>
  <form method="get" action="/cart">
    <label for="search-product">Search Product</label>
    <input type="text" id="search-product" name="item" />
    <button type="submit">Add to Cart</button>
  </form>
</body>
</html>`);
        return;
      }

      if (url.pathname === '/cart') {
        const item = url.searchParams.get('item') || '';
        const body = CATALOG.has(item)
          ? `<p id="cart-item">${escapeHtml(item)}</p>`
          : '<p>Your cart is empty.</p>';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Cart</title></head>
<body>
  <h1>Cart</h1>
  ${body}
</body>
</html>`);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>');
    });

    await new Promise((resolve) => {
      fixtureServer.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${fixtureServer.address().port}`;
        resolve();
      });
    });

    sharedRuntime = createBrowserRuntime({ headless: true, allowLocalhost: true });
  });

  after(async () => {
    if (sharedRuntime) await sharedRuntime.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  });

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-param-criteria-'));
    repo = new FileSystemWorkflowRepository({ baseDir: tempBaseDir });
    await repo.init();
  });

  afterEach(async () => {
    if (tempBaseDir) await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
  });

  async function createParameterizedWorkflow(workflowId = 'wf_param_search') {
    const { version } = await repo.createWorkflow({
      id: workflowId,
      name: 'Search and add item',
      description: 'Search for the requested item and add it to the cart',
      schemaVersion: '1.1.0',
      target: { origin: baseUrl, startPath: '/store' },
      inputs: [
        { name: 'search_item', type: 'string', label: 'Search Item', description: 'Product to add', required: true },
      ],
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: 'Navigate to store',
          action: 'navigate',
          params: { path: '/store' },
          anchor: null,
          verification: null,
        },
        {
          id: 'step_2',
          order: 2,
          description: 'Fill search field',
          action: 'fillByLabel',
          params: { label: 'Search Product', inputName: 'search_item', exact: true, timeoutMs: 5000 },
          anchor: null,
          verification: null,
        },
        {
          id: 'step_3',
          order: 3,
          description: 'Add to cart',
          action: 'clickByRole',
          params: { role: 'button', name: 'Add to Cart', exact: true, timeoutMs: 5000 },
          anchor: null,
          verification: null,
        },
      ],
      successCriteria: { finalPath: '/cart', textPresent: { input: 'search_item' } },
    });
    assert.equal(version.schemaVersion, '1.1.0');
    return version;
  }

  function makePlayer() {
    return new WorkflowPlayer({ repository: repo, browserRuntime: sharedRuntime, allowLocalhost: true });
  }

  it('verifies Paneer Toast with the corresponding runtime input', async () => {
    await createParameterizedWorkflow();
    const trial = await makePlayer().playDraftForVerification('wf_param_search', { search_item: 'Paneer Toast' });
    assert.equal(trial.runResult.ok, true);
    assert.equal(trial.runResult.successCriteriaResult.passed, true);
    assert.equal(trial.runResult.successCriteriaResult.textPresentFound, true);
    assert.equal(trial.candidatePromotionReady, true);
    assert.equal(trial.evidence.successCriteriaResult.passed, true);
    // Evidence records booleans only; the resolved product is never persisted.
    assert.ok(!JSON.stringify(trial.evidence).includes('Paneer Toast'));
    assert.ok(!JSON.stringify(trial.runResult).includes('Paneer Toast'));
  });

  it('verifies Fresh Paneer Pizza with the same workflow and different input', async () => {
    await createParameterizedWorkflow();
    const trial = await makePlayer().playDraftForVerification('wf_param_search', { search_item: 'Fresh Paneer Pizza' });
    assert.equal(trial.runResult.ok, true);
    assert.equal(trial.runResult.successCriteriaResult.textPresentFound, true);
    assert.ok(!JSON.stringify(trial.evidence).includes('Fresh Paneer Pizza'));
  });

  it('fails for a wrong product even though generic Cart text is present', async () => {
    await createParameterizedWorkflow();
    const trial = await makePlayer().playDraftForVerification('wf_param_search', { search_item: 'Crispy Tofu Burger' });
    assert.equal(trial.runResult.ok, false);
    assert.equal(trial.runResult.successCriteriaResult.finalPathMatched, true);
    assert.equal(trial.runResult.successCriteriaResult.textPresentFound, false);
    assert.equal(trial.candidatePromotionReady, false);
    assert.ok(!JSON.stringify(trial.runResult).includes('Crispy Tofu Burger'));
    assert.ok(!JSON.stringify(trial.evidence).includes('Crispy Tofu Burger'));
  });

  it('fails closed when a required referenced input is missing', async () => {
    await createParameterizedWorkflow();
    await assert.rejects(
      () => makePlayer().playDraftForVerification('wf_param_search', {}),
      (err) => err.message.includes('Missing required input "search_item"')
    );
  });

  async function createOptionalRefWorkflow(workflowId = 'wf_param_optional', extraInputs = [], extraCriteria = {}) {
    await repo.createWorkflow({
      id: workflowId,
      name: 'Optional ref workflow',
      description: 'Navigate only with optional referenced criterion',
      schemaVersion: '1.1.0',
      target: { origin: baseUrl, startPath: '/store' },
      inputs: [
        { name: 'search_item', type: 'string', label: 'Search Item', required: false },
        ...extraInputs,
      ],
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: 'Navigate to store',
          action: 'navigate',
          params: { path: '/store' },
          anchor: null,
          verification: null,
        },
      ],
      successCriteria: { finalPath: '/store', textPresent: { input: 'search_item' }, ...extraCriteria },
    });
  }

  function makeSpyRuntime() {
    const calls = { createSession: 0 };
    return {
      calls,
      async createSession() {
        calls.createSession += 1;
        throw new Error('browser must not launch when preflight fails');
      },
      async close() {},
    };
  }

  function makeSpyPlayer(spyRuntime) {
    return new WorkflowPlayer({ repository: repo, browserRuntime: spyRuntime, allowLocalhost: true });
  }

  it('passes preflight when a supplied optional referenced input is usable', async () => {
    await createOptionalRefWorkflow();
    const trial = await makePlayer().playDraftForVerification('wf_param_optional', { search_item: 'Store' });
    assert.equal(trial.runResult.ok, true);
    assert.equal(trial.runResult.successCriteriaResult.textPresentFound, true);
  });

  it('fails preflight before browser launch when an optional referenced input is omitted', async () => {
    await createOptionalRefWorkflow();
    const spyRuntime = makeSpyRuntime();
    await assert.rejects(
      () => makeSpyPlayer(spyRuntime).playDraftForVerification('wf_param_optional', {}),
      (err) => {
        assert.match(err.message, /not supplied with usable values: search_item/);
        return true;
      }
    );
    assert.equal(spyRuntime.calls.createSession, 0, 'no browser session may be created');
  });

  it('fails preflight before browser launch when a referenced input is empty', async () => {
    await createOptionalRefWorkflow();
    const spyRuntime = makeSpyRuntime();
    await assert.rejects(
      () => makeSpyPlayer(spyRuntime).playDraftForVerification('wf_param_optional', { search_item: '   ' }),
      /not supplied with usable values: search_item/
    );
    assert.equal(spyRuntime.calls.createSession, 0);
  });

  it('fails preflight if any of multiple references is missing, naming inputs but never values', async () => {
    await createOptionalRefWorkflow(
      'wf_param_multi_ref',
      [{ name: 'absent_label', type: 'string', label: 'Absent Label', required: false }],
      { textAbsent: { input: 'absent_label' } }
    );
    const spyRuntime = makeSpyRuntime();
    await assert.rejects(
      () =>
        makeSpyPlayer(spyRuntime).playDraftForVerification('wf_param_multi_ref', {
          search_item: 'Sup3rSecretProductValue',
        }),
      (err) => {
        assert.match(err.message, /absent_label/);
        assert.ok(!err.message.includes('Sup3rSecretProductValue'), 'error must not contain runtime values');
        return true;
      }
    );
    assert.equal(spyRuntime.calls.createSession, 0);
  });

  it('keeps unreferenced optional inputs optional and literal 1.0.0 criteria unchanged', async () => {
    await repo.createWorkflow({
      id: 'wf_literal_compat',
      name: 'Literal compat workflow',
      description: 'Literal criteria with an unreferenced optional input',
      target: { origin: baseUrl, startPath: '/store' },
      inputs: [{ name: 'note', type: 'string', label: 'Note', required: false }],
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: 'Navigate to store',
          action: 'navigate',
          params: { path: '/store' },
          anchor: null,
          verification: null,
        },
      ],
      successCriteria: { finalPath: '/store', textPresent: 'Store' },
    });

    const trial = await makePlayer().playDraftForVerification('wf_literal_compat', {});
    assert.equal(trial.runResult.ok, true);
    assert.equal(trial.runResult.successCriteriaResult.passed, true);
  });

  it('produces distinct stable hashes for literal vs reference criteria', async () => {
    const version = await createParameterizedWorkflow();
    const hash1 = calculateContentHash(version);
    const hash2 = calculateContentHash(JSON.parse(JSON.stringify(version)));
    assert.equal(hash1, hash2);

    const literalVersion = {
      ...JSON.parse(JSON.stringify(version)),
      schemaVersion: '1.0.0',
      successCriteria: { finalPath: '/cart', textPresent: 'Paneer Toast' },
    };
    assert.notEqual(calculateContentHash(literalVersion), hash1);
  });

  it('preserves schemaVersion 1.1.0 when branching a verified parameterized workflow', async () => {
    const version = await createParameterizedWorkflow();
    const trial = await makePlayer().playDraftForVerification('wf_param_search', { search_item: 'Paneer Toast' });
    await repo.markVerified('wf_param_search', 1, trial.evidence);

    const branched = await repo.createDraftVersion('wf_param_search', { changeSummary: 'Branch parameterized draft' });
    assert.equal(branched.schemaVersion, '1.1.0');
    assert.deepEqual(branched.successCriteria.textPresent, { input: 'search_item' });

    // The promoted literal-era safeguards still hold: verified version is immutable.
    await assert.rejects(
      () => repo.updateDraftVersion('wf_param_search', 1, { changeSummary: 'tamper' }),
      (err) => err.code === 'IMMUTABLE_VERSION' || /immutable/i.test(err.message)
    );
    const onDisk = await repo.getVersion('wf_param_search', 1);
    assert.equal(onDisk.contentHash ?? calculateContentHash(onDisk), calculateContentHash(onDisk));
    assert.equal(version.workflowId, onDisk.workflowId);
  });
});
