/**
 * Super Memory — Operator CLI Tests
 *
 * Validates Phase 3D Operator CLI capabilities:
 * - Workflow listing and state inspection
 * - Secret-safe, read-only proposed repair diffs
 * - Rejection of missing, invalid, or stale drafts
 * - Real browser trial execution with input validation
 * - Promotion gating: genuine evidence checking, hash validation, and explicit confirmation
 * - Rejection of changed draft content between trial and promotion
 * - Preservation of active versions and disabled states
 * - CLI argument handling and error reporting
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';

import {
  FileSystemWorkflowRepository,
  WorkflowPlayer,
  calculateContentHash,
} from '../../src/workflow/index.js';

import {
  OperatorCLI,
  loadInputs,
  renderDiff,
  formatTable,
  getStagedEvidencePath,
  runCli,
} from '../../src/cli/operator.js';

import { createBrowserRuntime } from '../../src/browser/index.js';

describe('Operator CLI (Phase 3D)', () => {
  let fixtureServer;
  let baseUrl;
  let tempBaseDir;
  let repo;
  let sharedRuntime;

  let currentButtonName = 'Submit Order';

  before(async () => {
    // Local HTTP server simulating web applications under repair
    fixtureServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Test Store</title></head>
<body>
  <h1>Test Store</h1>
  <a href="/checkout">Go to Checkout</a>
</body>
</html>`);
        return;
      }

      if (url.pathname === '/checkout') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Checkout Page</title></head>
<body>
  <h1>Checkout</h1>
  <form action="/complete" method="POST">
    <label for="coupon-input">Discount Code</label>
    <input id="coupon-input" name="coupon" type="text" />
    <button type="submit" id="btn-order">${currentButtonName}</button>
  </form>
</body>
</html>`);
        return;
      }

      if (url.pathname === '/complete') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Order Confirmed</title></head>
<body>
  <h1>Order Complete</h1>
  <p>Thank you for your order!</p>
</body>
</html>`);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    const port = fixtureServer.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

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

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'super-memory-cli-test-'));
    repo = new FileSystemWorkflowRepository({ baseDir: tempBaseDir });
    await repo.init();
    currentButtonName = 'Submit Order';
  });

  afterEach(async () => {
    if (tempBaseDir) {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  function createCaptureIO() {
    let stdoutData = '';
    let stderrData = '';
    const stdout = new PassThrough();
    stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });
    const stderr = new PassThrough();
    stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    return {
      stdin: new PassThrough(),
      stdout,
      stderr,
      getStdout: () => stdoutData,
      getStderr: () => stderrData,
    };
  }

  async function createVerifiedWorkflow(repository, {
    id,
    name = 'Test Workflow',
    description = 'Test Description',
    target,
    inputs = [],
    steps,
    successCriteria = { finalPath: '/complete' },
  }) {
    const normalizedSteps = steps.map((s) => ({
      description: s.description || 'Step action',
      ...s,
    }));

    const { version } = await repository.createWorkflow({
      id,
      name,
      description,
      target,
      inputs,
      steps: normalizedSteps,
      successCriteria,
    });

    const contentHash = calculateContentHash(version);
    const evidence = {
      $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
      schemaVersion: '1.0.0',
      workflowId: id,
      version: 1,
      contentHash,
      runId: 'run_init_test_1',
      verifiedAt: new Date().toISOString(),
      environment: {
        targetOrigin: target.origin,
        browserEngine: 'chromium',
        playwrightVersion: '1.64.1',
        nodeVersion: process.version,
        platform: process.platform,
      },
      stepResults: normalizedSteps.map((s) => ({
        stepId: s.id,
        action: s.action,
        ok: true,
        status: 200,
        durationMs: 50,
        verification: null,
      })),
      successCriteriaResult: {
        passed: true,
        finalPath: successCriteria.finalPath || null,
        pageTitleMatched: null,
        textPresentFound: null,
        textAbsentFound: null,
        details: 'Initial verification passed.',
      },
    };

    await repository.markVerified(id, 1, evidence);
    return { id, version, evidence };
  }

  // =========================================================================
  // 1. Table Formatting & Inputs Loading
  // =========================================================================
  describe('Utilities: formatTable & loadInputs', () => {
    it('formatTable aligns columns with headers and padding', () => {
      const headers = ['ID', 'STATUS', 'NAME'];
      const rows = [
        ['wf_1', 'enabled', 'Checkout'],
        ['wf_longer_id', 'disabled', 'Login Flow'],
      ];
      const table = formatTable(headers, rows);
      assert.ok(table.includes('ID'));
      assert.ok(table.includes('STATUS'));
      assert.ok(table.includes('wf_longer_id'));
      assert.ok(table.includes('Login Flow'));
    });

    it('loadInputs safely parses valid JSON mapping string values', async () => {
      const inputsPath = path.join(tempBaseDir, 'test-inputs.json');
      await fs.writeFile(inputsPath, JSON.stringify({ coupon: 'DISCOUNT20', note: 'fast' }), 'utf8');

      const loaded = await loadInputs(inputsPath);
      assert.deepEqual(loaded, { coupon: 'DISCOUNT20', note: 'fast' });
    });

    it('loadInputs returns empty object when path is empty or undefined', async () => {
      assert.deepEqual(await loadInputs(null), {});
      assert.deepEqual(await loadInputs(''), {});
    });

    it('loadInputs rejects missing file with clean error', async () => {
      await assert.rejects(
        () => loadInputs(path.join(tempBaseDir, 'missing.json')),
        /Inputs file not found/
      );
    });

    it('loadInputs rejects malformed JSON without printing raw contents', async () => {
      const inputsPath = path.join(tempBaseDir, 'corrupt.json');
      await fs.writeFile(inputsPath, '{"broken": [', 'utf8');

      await assert.rejects(
        () => loadInputs(inputsPath),
        /Invalid JSON in inputs file/
      );
    });

    it('loadInputs rejects non-object root or non-string values', async () => {
      const inputsPath1 = path.join(tempBaseDir, 'array.json');
      await fs.writeFile(inputsPath1, '["item"]', 'utf8');
      await assert.rejects(() => loadInputs(inputsPath1), /must contain a JSON object/);

      const inputsPath2 = path.join(tempBaseDir, 'numeric.json');
      await fs.writeFile(inputsPath2, JSON.stringify({ count: 42 }), 'utf8');
      await assert.rejects(() => loadInputs(inputsPath2), /must be a string value/);
    });
  });

  // =========================================================================
  // 2. Capability A: List Workflows
  // =========================================================================
  describe('Capability A: List Workflows', () => {
    it('lists workflows showing ID, enabled status, active version, draft status, and name', async () => {
      // 1. Create verified workflow with draft
      await createVerifiedWorkflow(repo, {
        id: 'wf_checkout',
        name: 'Checkout Flow',
        description: 'Complete store purchase',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Discount Code', description: 'Coupon', required: false }],
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_checkout', {
        changeSummary: 'Change button selector to Complete Order',
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click updated button',
            params: { role: 'button', name: 'Complete Order' },
          },
        ],
      });

      // 2. Create disabled workflow without draft
      await createVerifiedWorkflow(repo, {
        id: 'wf_login',
        name: 'Login Flow',
        description: 'Authenticate user',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [],
        steps: [
          {
            id: 'step_link',
            order: 1,
            action: 'clickByRole',
            description: 'Click link',
            params: { role: 'link', name: 'Go to Checkout' },
          },
        ],
        successCriteria: { finalPath: '/checkout' },
      });
      await repo.setEnabled('wf_login', false);

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      const list = await cli.list();

      assert.equal(list.length, 2);
      const out = io.getStdout();
      assert.ok(out.includes('wf_checkout'));
      assert.ok(out.includes('enabled'));
      assert.ok(out.includes('v1'));
      assert.ok(out.includes('v2 (draft)'));
      assert.ok(out.includes('Checkout Flow'));

      assert.ok(out.includes('wf_login'));
      assert.ok(out.includes('disabled'));
      assert.ok(out.includes('none'));
    });

    it('list respects enabledOnly filter', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_active',
        name: 'Active Flow',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click link', params: { role: 'link', name: 'Go to Checkout' } }],
        successCriteria: { finalPath: '/checkout' },
      });
      await createVerifiedWorkflow(repo, {
        id: 'wf_disabled',
        name: 'Disabled Flow',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click link', params: { role: 'link', name: 'Go to Checkout' } }],
        successCriteria: { finalPath: '/checkout' },
      });
      await repo.setEnabled('wf_disabled', false);

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      const list = await cli.list({ enabledOnly: true });

      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'wf_active');
      const out = io.getStdout();
      assert.ok(out.includes('wf_active'));
      assert.ok(!out.includes('wf_disabled'));
    });

    it('list handles corrupt manifests without throwing', async () => {
      const corruptDir = path.join(tempBaseDir, 'wf_corrupt');
      await fs.mkdir(corruptDir, { recursive: true });
      await fs.writeFile(path.join(corruptDir, 'manifest.json'), '{invalid json', 'utf8');

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      const list = await cli.list();

      assert.equal(list.length, 1);
      assert.equal(list[0].corrupt, true);
      const out = io.getStdout();
      assert.ok(out.includes('CORRUPT'));
    });

    it('list informs operator when repository has no workflows', async () => {
      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      const list = await cli.list();

      assert.equal(list.length, 0);
      assert.ok(io.getStdout().includes('No workflows found'));
    });
  });

  // =========================================================================
  // 3. Capability B: Inspect a Workflow
  // =========================================================================
  describe('Capability B: Inspect a Workflow', () => {
    it('inspect displays active version, draft version, and verification evidence', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_inspect_test',
        name: 'Inspect Workflow',
        description: 'Verifies inspection formatting',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Discount Code', required: false, description: 'Optional coupon' }],
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click Submit',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_inspect_test', {
        changeSummary: 'Change button selector to Complete Order',
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click Complete',
            params: { role: 'button', name: 'Complete Order' },
          },
        ],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      await cli.inspect('wf_inspect_test');

      const out = io.getStdout();
      assert.ok(out.includes('WORKFLOW: wf_inspect_test'));
      assert.ok(out.includes('Inspect Workflow'));
      assert.ok(out.includes('ENABLED'));
      assert.ok(out.includes('[Active Version: v1 (verified)]'));
      assert.ok(out.includes('Submit Order'));
      assert.ok(out.includes('[Draft Version: v2 (unapproved draft)] <-- PENDING OPERATOR REVIEW'));
      assert.ok(out.includes('Complete Order'));
      assert.ok(out.includes('coupon (string, optional): Optional coupon'));
      assert.ok(out.includes('Verification Evidence:'));
      assert.ok(out.includes('Playwright:'));
    });

    it('inspect rejects nonexistent workflow ID', async () => {
      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      await assert.rejects(
        () => cli.inspect('nonexistent_wf'),
        /Workflow "nonexistent_wf" not found/
      );
    });

    it('inspect handles draft-only workflows without active versions', async () => {
      await repo.createWorkflow({
        id: 'wf_draft_only',
        name: 'Draft Only',
        description: 'Workflow with only draft',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click link', params: { role: 'link', name: 'Go to Checkout' } }],
        successCriteria: { finalPath: '/checkout' },
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      await cli.inspect('wf_draft_only');

      const out = io.getStdout();
      assert.ok(out.includes('[Active Version: None (Draft-only workflow)]'));
      assert.ok(out.includes('[Draft Version: v1 (unapproved draft)]'));
    });
  });

  // =========================================================================
  // 4. Capability C: Review Proposed Repair Diff
  // =========================================================================
  describe('Capability C: Review Proposed Repair Diff', () => {
    it('review renders a readable diff identifying step modifications', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_review_diff',
        name: 'Review Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click Submit',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_review_diff', {
        changeSummary: 'Update button name from Submit Order to Complete Order',
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click Complete',
            params: { role: 'button', name: 'Complete Order' },
          },
        ],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      const res = await cli.review('wf_review_diff');

      assert.ok(res);
      const out = io.getStdout();
      assert.ok(out.includes('REPAIR PROPOSAL REVIEW: wf_review_diff'));
      assert.ok(out.includes('Draft Version:   v2'));
      assert.ok(out.includes('Parent Version:  v1'));
      assert.ok(out.includes('Update button name from Submit Order to Complete Order'));
      assert.ok(out.includes('[Modified]  Step 1 (step_order):'));
      assert.ok(out.includes('- target: {"role":"button","name":"Submit Order"}'));
      assert.ok(out.includes('+ target: {"role":"button","name":"Complete Order"}'));
      assert.ok(out.includes('UNAPPROVED DRAFT (Untrusted until trialed and explicitly promoted)'));
    });

    it('review is strictly read-only and never overwrites drafts or modifies disk', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_readonly_check',
        name: 'Readonly Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Submit Order' } }],
        successCriteria: { finalPath: '/complete' },
      });

      const draft = await repo.createDraftVersion('wf_readonly_check', {
        changeSummary: 'Draft 2',
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Complete Order' } }],
      });

      const hashBefore = calculateContentHash(draft);

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      await cli.review('wf_readonly_check');

      const draftAfter = await repo.getVersion('wf_readonly_check', 2);
      const hashAfter = calculateContentHash(draftAfter);

      assert.equal(hashBefore, hashAfter);
    });

    it('review redacts secrets embedded in descriptions and parameters', () => {
      const secret = 'sk_live_secretkey123456';
      const activeVer = {
        schemaVersion: '1.0.0',
        version: 1,
        workflowId: 'wf_secret_diff',
        target: { origin: 'https://example.com', startPath: '/' },
        inputs: [],
        steps: [
          {
            id: 'step_1',
            order: 1,
            action: 'fillByLabel',
            description: `Enter key ${secret}`,
            params: { label: `API Key ${secret}`, inputName: 'apiKey' },
          },
        ],
      };
      const draftVer = {
        schemaVersion: '1.0.0',
        version: 2,
        parentVersion: 1,
        workflowId: 'wf_secret_diff',
        changeSummary: `Fixed entry for ${secret}`,
        target: { origin: 'https://example.com', startPath: '/' },
        inputs: [],
        steps: [
          {
            id: 'step_1',
            order: 1,
            action: 'fillByLabel',
            description: `Enter key updated ${secret}`,
            params: { label: `Updated Key ${secret}`, inputName: 'apiKey' },
          },
        ],
      };

      const diff = renderDiff(activeVer, draftVer, { secrets: [secret] });
      assert.ok(!diff.includes(secret));
      assert.ok(diff.includes('[REDACTED]'));
    });

    it('Fix 2 regression: renderDiff redacts secrets across added steps, verifications, targets, inputs, and criteria', () => {
      const secret = 'sk_live_secretkey123456';
      const activeVer = {
        schemaVersion: '1.0.0',
        version: 1,
        workflowId: 'wf_secret_diff_all',
        target: { origin: 'https://example.com', startPath: `/login/${secret}` },
        inputs: [{ name: 'token', type: 'string', label: `Token ${secret}`, description: `Secret info ${secret}`, required: true }],
        steps: [
          {
            id: `step_${secret}`,
            order: 1,
            action: 'fillByLabel',
            description: `Enter key ${secret}`,
            params: { label: `API Key ${secret}`, inputName: 'token' },
            verification: { type: 'elementPresent', role: 'button', name: `Verify ${secret}` },
          },
        ],
        successCriteria: { finalPath: `/done/${secret}` },
      };

      const draftVer = {
        schemaVersion: '1.0.0',
        version: 2,
        parentVersion: 1,
        workflowId: 'wf_secret_diff_all',
        changeSummary: `Fixed entry for ${secret}`,
        target: { origin: `https://example-${secret}.com`, startPath: `/login/updated/${secret}` },
        inputs: [{ name: 'token', type: 'string', label: `Updated Token ${secret}`, description: `Updated info ${secret}`, required: true }],
        steps: [
          {
            id: `step_${secret}`,
            order: 1,
            action: 'fillByLabel',
            description: `Enter key updated ${secret}`,
            params: { label: `Updated Key ${secret}`, inputName: 'token' },
            verification: { type: 'elementPresent', role: 'button', name: `Updated Verify ${secret}` },
          },
          {
            id: `added_step_${secret}`,
            order: 2,
            action: 'clickByRole',
            description: `Click added ${secret}`,
            params: { role: 'button', name: `Added Button ${secret}` },
            verification: { type: 'elementPresent', role: 'status', name: `Status ${secret}` },
          },
        ],
        successCriteria: { finalPath: `/done/updated/${secret}` },
      };

      const diff = renderDiff(activeVer, draftVer, { secrets: [secret] });

      assert.ok(!diff.includes(secret), 'Rendered diff must never contain raw secret text');
      assert.ok(diff.includes('[REDACTED]'), 'Rendered diff must include [REDACTED] tokens');
    });

    it('review informs operator when workflow has no pending draft', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_no_draft',
        name: 'No Draft',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click link', params: { role: 'link', name: 'Go to Checkout' } }],
        successCriteria: { finalPath: '/checkout' },
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      const res = await cli.review('wf_no_draft');

      assert.equal(res, null);
      assert.ok(io.getStdout().includes('has no pending draft repair'));
    });
  });

  // =========================================================================
  // 5. Capability D: Trial a Draft
  // =========================================================================
  describe('Capability D: Trial a Draft Execution', () => {
    it('executes real browser trial successfully on draft version and stages evidence', async () => {
      currentButtonName = 'Complete Order';

      await createVerifiedWorkflow(repo, {
        id: 'wf_trial_success',
        name: 'Trial Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Discount Code', required: false, description: 'Coupon' }],
        steps: [
          {
            id: 'step_fill',
            order: 1,
            action: 'fillByLabel',
            description: 'Enter coupon',
            params: { label: 'Discount Code', inputName: 'coupon' },
          },
          {
            id: 'step_order',
            order: 2,
            action: 'clickByRole',
            description: 'Click Submit',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_trial_success', {
        changeSummary: 'Update button to Complete Order',
        steps: [
          {
            id: 'step_fill',
            order: 1,
            action: 'fillByLabel',
            description: 'Enter coupon',
            params: { label: 'Discount Code', inputName: 'coupon' },
          },
          {
            id: 'step_order',
            order: 2,
            action: 'clickByRole',
            description: 'Click Complete',
            params: { role: 'button', name: 'Complete Order' },
          },
        ],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        io,
      });

      const trialRes = await cli.trial('wf_trial_success', {
        inputs: { coupon: 'PROMO10' },
      });

      assert.equal(trialRes.success, true);
      assert.equal(trialRes.trialResult.candidatePromotionReady, true);
      assert.ok(trialRes.evidencePath);

      // Verify staged evidence exists and is valid
      const evidenceRaw = await fs.readFile(trialRes.evidencePath, 'utf8');
      const evidence = JSON.parse(evidenceRaw);
      assert.equal(evidence.workflowId, 'wf_trial_success');
      assert.equal(evidence.version, 2);
      assert.equal(evidence.successCriteriaResult.passed, true);

      // CRITICAL INVARIANT: Successful trial does NOT automatically promote!
      const manifest = await repo.getManifest('wf_trial_success');
      assert.equal(manifest.activeVersion, 1);
      assert.equal(manifest.draftVersion, 2);

      const out = io.getStdout();
      assert.ok(out.includes('TRIAL VERDICT: PASSED'));
      assert.ok(out.includes('This draft has NOT been promoted'));
    });

    it('identifies trial failure and prevents invalid evidence generation', async () => {
      currentButtonName = 'Complete Order';

      await createVerifiedWorkflow(repo, {
        id: 'wf_trial_fail',
        name: 'Trial Fail Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_trial_fail', {
        changeSummary: 'Faulty proposal targeting Nonexistent Button',
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click faulty button',
            params: { role: 'button', name: 'Nonexistent Button' },
          },
        ],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        io,
      });

      const trialRes = await cli.trial('wf_trial_fail', { inputs: {} });

      assert.equal(trialRes.success, false);
      assert.equal(trialRes.trialResult.candidatePromotionReady, false);

      // Invariant: Staged evidence does NOT exist for failed trials
      const stagedPath = getStagedEvidencePath(repo.baseDir, 'wf_trial_fail', 2);
      await assert.rejects(() => fs.access(stagedPath));

      const out = io.getStdout();
      assert.ok(out.includes('TRIAL VERDICT: FAILED'));
      assert.ok(out.includes('Failed trials cannot produce valid promotion evidence'));
    });

    it('Fix 1 regression: never unlinks or deletes a caller-owned custom evidence file on failed trial', async () => {
      currentButtonName = 'Complete Order';

      await createVerifiedWorkflow(repo, {
        id: 'wf_custom_evidence_keep',
        name: 'Custom Evidence Keep Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_custom_evidence_keep', {
        changeSummary: 'Faulty proposal targeting Nonexistent Button',
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click faulty button',
            params: { role: 'button', name: 'Nonexistent Button' },
          },
        ],
      });

      // Create an existing, important custom file that caller specifies as evidenceOut
      const importantCustomFilePath = path.join(tempBaseDir, 'important-audit-report.json');
      const originalContent = JSON.stringify({ auditStatus: 'APPROVED_PRESERVE_ME', importantData: 12345 });
      await fs.writeFile(importantCustomFilePath, originalContent, 'utf8');

      const io = createCaptureIO();
      const cli = new OperatorCLI({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        io,
      });

      const trialRes = await cli.trial('wf_custom_evidence_keep', {
        inputs: {},
        evidenceOut: importantCustomFilePath,
      });

      // Trial must report failed, not success
      assert.equal(trialRes.success, false);
      assert.equal(trialRes.trialResult.candidatePromotionReady, false);

      // Verify that the custom output file was NOT deleted or corrupted
      const fileAfter = await fs.readFile(importantCustomFilePath, 'utf8');
      assert.equal(fileAfter, originalContent);
    });

    it('rejects trial when workflow has no draft version', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_no_draft_trial',
        name: 'No Draft Trial',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click link', params: { role: 'link', name: 'Go to Checkout' } }],
        successCriteria: { finalPath: '/checkout' },
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      await assert.rejects(
        () => cli.trial('wf_no_draft_trial', { inputs: {} }),
        /has no draft version for verification/
      );
    });

    it('rejects trial when required inputs are missing without leaking values', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_req_inputs',
        name: 'Required Inputs',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [{ name: 'secretKey', type: 'string', label: 'Secret Key', required: true, description: 'Secret' }],
        steps: [
          {
            id: 's1',
            order: 1,
            action: 'fillByLabel',
            description: 'Enter secret key',
            params: { label: 'Discount Code', inputName: 'secretKey' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_req_inputs', {
        changeSummary: 'Draft with required input',
        steps: [
          {
            id: 's1',
            order: 1,
            action: 'fillByLabel',
            description: 'Enter secret key',
            params: { label: 'Discount Code', inputName: 'secretKey' },
          },
        ],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      await assert.rejects(
        () => cli.trial('wf_req_inputs', { inputs: {} }),
        /Missing required input "secretKey"/
      );
    });
  });

  // =========================================================================
  // 6. Capability E: Explicitly Promote a Verified Draft
  // =========================================================================
  describe('Capability E: Explicit Promotion Gating & Invariants', () => {
    it('promotes draft when genuine evidence matches and operator explicitly confirms', async () => {
      currentButtonName = 'Complete Order';

      await createVerifiedWorkflow(repo, {
        id: 'wf_promote_success',
        name: 'Promote Success Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_promote_success', {
        changeSummary: 'Updated to Complete Order',
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Complete Order' },
          },
        ],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        io,
      });

      // 1. Run trial to produce genuine evidence
      const trial = await cli.trial('wf_promote_success');
      assert.equal(trial.success, true);

      // 2. Promote with explicit confirmation
      const promoteRes = await cli.promote('wf_promote_success', {
        confirm: 'PROMOTE wf_promote_success',
      });

      assert.equal(promoteRes.promoted, true);
      assert.equal(promoteRes.manifest.activeVersion, 2);
      assert.equal(promoteRes.manifest.draftVersion, null);

      // 3. Staged evidence was cleaned up after successful promotion
      const stagedPath = getStagedEvidencePath(repo.baseDir, 'wf_promote_success', 2);
      await assert.rejects(() => fs.access(stagedPath));

      // 4. Invariant: Ordinary playback now executes promoted version 2!
      const playRes = await cli.play('wf_promote_success');
      assert.equal(playRes.ok, true);
      assert.equal(playRes.version, 2);
    });

    it('refuses promotion when operator cancels confirmation', async () => {
      currentButtonName = 'Complete Order';

      await createVerifiedWorkflow(repo, {
        id: 'wf_promote_cancel',
        name: 'Promote Cancel Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Submit Order' } }],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_promote_cancel', {
        changeSummary: 'Draft 2',
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Complete Order' } }],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        io,
      });

      await cli.trial('wf_promote_cancel');

      // Operator inputs incorrect confirmation phrase
      const promoteRes = await cli.promote('wf_promote_cancel', {
        confirm: 'wrong confirmation phrase',
      });

      assert.equal(promoteRes.promoted, false);
      assert.equal(promoteRes.reason, 'cancelled');

      // Active version remains v1, draft remains v2
      const manifest = await repo.getManifest('wf_promote_cancel');
      assert.equal(manifest.activeVersion, 1);
      assert.equal(manifest.draftVersion, 2);
    });

    it('refuses promotion if trial evidence is missing', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_no_evidence',
        name: 'No Evidence Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Submit Order' } }],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_no_evidence', {
        changeSummary: 'Untrialed draft',
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Complete Order' } }],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });

      await assert.rejects(
        () => cli.promote('wf_no_evidence', { confirm: 'PROMOTE wf_no_evidence' }),
        /No trial verification evidence found/
      );
    });

    it('refuses promotion if draft content was modified after trial execution', async () => {
      currentButtonName = 'Complete Order';

      await createVerifiedWorkflow(repo, {
        id: 'wf_tampered_draft',
        name: 'Tampered Draft Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Submit Order' } }],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_tampered_draft', {
        changeSummary: 'Draft 2',
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Complete Order' } }],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        io,
      });

      // Trial valid draft v2
      await cli.trial('wf_tampered_draft');

      // Now tamper with the draft version on disk to change its content hash!
      const draftPath = path.join(tempBaseDir, 'wf_tampered_draft', 'versions', '2.json');
      const draftObj = JSON.parse(await fs.readFile(draftPath, 'utf8'));
      draftObj.steps[0].params.name = 'Tampered Button Name';
      await fs.writeFile(draftPath, JSON.stringify(draftObj, null, 2), 'utf8');

      // Attempting to promote with the stale evidence must be strictly rejected
      await assert.rejects(
        () => cli.promote('wf_tampered_draft', { confirm: 'PROMOTE wf_tampered_draft' }),
        /does not match computed workflow hash|content hash/i
      );

      // Invariant: Active version remains unchanged
      const manifest = await repo.getManifest('wf_tampered_draft');
      assert.equal(manifest.activeVersion, 1);
      assert.equal(manifest.draftVersion, 2);
    });

    it('refuses promotion if evidence reports failed steps or criteria', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_failed_evidence',
        name: 'Failed Evidence Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Submit Order' } }],
        successCriteria: { finalPath: '/complete' },
      });

      const draft = await repo.createDraftVersion('wf_failed_evidence', {
        changeSummary: 'Draft 2',
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Complete Order' } }],
      });

      const hash = calculateContentHash(draft);

      // Construct evidence with a failed step
      const badEvidence = {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId: 'wf_failed_evidence',
        version: 2,
        contentHash: hash,
        runId: 'bad_run_1',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: process.version,
          platform: process.platform,
        },
        stepResults: [
          {
            stepId: 's1',
            action: 'clickByRole',
            ok: false,
            status: null,
            durationMs: 100,
            verification: null,
          },
        ],
        successCriteriaResult: {
          passed: false,
          finalPath: null,
          pageTitleMatched: null,
          textPresentFound: null,
          textAbsentFound: null,
          details: 'Step failed',
        },
      };

      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });

      await assert.rejects(
        () => cli.promote('wf_failed_evidence', { evidence: badEvidence, confirm: 'PROMOTE wf_failed_evidence' }),
        /execution failed|success criteria failed|failed during trial/i
      );
    });

    it('promotion preserves disabled state without silently enabling workflow', async () => {
      currentButtonName = 'Complete Order';

      await createVerifiedWorkflow(repo, {
        id: 'wf_disabled_promote',
        name: 'Disabled Promote Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Submit Order' } }],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_disabled_promote', {
        changeSummary: 'Draft 2',
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click button', params: { role: 'button', name: 'Complete Order' } }],
      });

      // Explicitly disable the workflow
      await repo.setEnabled('wf_disabled_promote', false);

      const io = createCaptureIO();
      const cli = new OperatorCLI({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        io,
      });

      await cli.trial('wf_disabled_promote');
      const res = await cli.promote('wf_disabled_promote', { confirm: 'PROMOTE wf_disabled_promote' });

      assert.equal(res.promoted, true);
      // Invariant: Workflow MUST remain disabled!
      assert.equal(res.manifest.enabled, false);
      const manifest = await repo.getManifest('wf_disabled_promote');
      assert.equal(manifest.enabled, false);
      assert.equal(manifest.activeVersion, 2);
    });

    it('Fix 2 regression: promote redacts secrets in pre-promotion change summary', async () => {
      currentButtonName = 'Complete Order';
      const secret = 'sk_live_supersecret_promo_123';

      await createVerifiedWorkflow(repo, {
        id: 'wf_promote_redact_summary',
        name: 'Promote Redact Summary Test',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      await repo.createDraftVersion('wf_promote_redact_summary', {
        changeSummary: `Updated selector to Complete Order with secret ${secret}`,
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Complete Order' },
          },
        ],
      });

      const io = createCaptureIO();
      const cli = new OperatorCLI({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
        io,
      });

      await cli.trial('wf_promote_redact_summary');

      // Operator promotes with secrets passed
      const promoteRes = await cli.promote('wf_promote_redact_summary', {
        confirm: 'PROMOTE wf_promote_redact_summary',
        secrets: [secret],
      });

      assert.equal(promoteRes.promoted, true);
      const out = io.getStdout();
      assert.ok(!out.includes(secret), 'Pre-promotion summary must not display raw secret');
      assert.ok(out.includes('[REDACTED]'), 'Pre-promotion summary must display [REDACTED]');
    });
  });

  // =========================================================================
  // 7. CLI Command Router & Argument Handling
  // =========================================================================
  describe('CLI Command Router & Argument Handling', () => {
    it('returns exit code 0 on --help', async () => {
      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      const code = await cli.run(['--help']);
      assert.equal(code, 0);
      assert.ok(io.getStdout().includes('Super Memory — Operator CLI'));
    });

    it('returns exit code 1 on unknown command', async () => {
      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      const code = await cli.run(['unknown-command']);
      assert.equal(code, 1);
      assert.ok(io.getStderr().includes('Unknown command "unknown-command"'));
    });

    it('returns exit code 1 when required workflowId is missing', async () => {
      const io = createCaptureIO();
      const cli = new OperatorCLI({ repository: repo, io });
      const code = await cli.run(['inspect']);
      assert.equal(code, 1);
      assert.ok(io.getStderr().includes('Missing required argument <workflowId>'));
    });

    it('runs end-to-end via runCli()', async () => {
      await createVerifiedWorkflow(repo, {
        id: 'wf_runcli',
        name: 'RunCli Test',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [],
        steps: [{ id: 's1', order: 1, action: 'clickByRole', description: 'Click link', params: { role: 'link', name: 'Go to Checkout' } }],
        successCriteria: { finalPath: '/checkout' },
      });

      const io = createCaptureIO();
      const exitCode = await runCli(['inspect', 'wf_runcli', '--workflows-dir', tempBaseDir], io);
      assert.equal(exitCode, 0);
      assert.ok(io.getStdout().includes('WORKFLOW: wf_runcli'));
    });
  });

  // =========================================================================
  // 8. End-to-End Recovery Flow Scenario (Phase 3D Golden Path)
  // =========================================================================
  describe('End-to-End Operator Recovery Flow Scenario', () => {
    it('executes full operator recovery: broken active v1 -> diagnosis & Meta proposal -> review diff -> trial v2 -> explicit promotion -> verified playback', async () => {
      // 1. Initial application displays "Complete Order" instead of "Submit Order"
      currentButtonName = 'Complete Order';

      // 2. Active workflow v1 has outdated selector "Submit Order"
      await createVerifiedWorkflow(repo, {
        id: 'wf_demo_lifecycle',
        name: 'Demo Lifecycle Flow',
        description: 'Complete purchase flow',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Discount Code', required: false, description: 'Coupon' }],
        steps: [
          {
            id: 'step_order',
            order: 1,
            action: 'clickByRole',
            description: 'Click Submit Order button',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/complete' },
      });

      const mockProvider = {
        providerName: 'meta',
        modelName: 'muse-spark-1.3',
        async complete() {
          return {
            text: JSON.stringify({
              workflowId: 'wf_demo_lifecycle',
              targetVersion: 1,
              stepId: 'step_order',
              suspectedCause: 'Button text changed from Submit Order to Complete Order',
              evidence: 'DOM snapshot shows button with accessible name Complete Order',
              expectedOutcome: 'Clicking Complete Order will submit form to /complete',
              uncertainty: 'None; button accessible name matches DOM snapshot exactly',
              proposedChange: {
                action: 'clickByRole',
                description: 'Click Complete Order button',
                params: { role: 'button', name: 'Complete Order' },
              },
            }),
            provider: 'meta',
            model: 'muse-spark-1.3',
            finishReason: 'stop',
            isTruncated: false,
            usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
          };
        },
      };

      const io = createCaptureIO();
      const cli = new OperatorCLI({
        repository: repo,
        browserRuntime: sharedRuntime,
        modelProvider: mockProvider,
        allowLocalhost: true,
        io,
      });

      // Step A: Active version fails normal playback
      const playBefore = await cli.play('wf_demo_lifecycle', { inputs: { coupon: 'PROMO10' } });
      assert.equal(playBefore.ok, false);
      assert.equal(playBefore.version, 1);

      // Step B: Repair detects failure, queries Meta model, and generates unapproved draft v2
      const repairRes = await cli.repair('wf_demo_lifecycle', {
        inputs: { coupon: 'PROMO10' },
        provider: mockProvider,
      });
      assert.equal(repairRes.repaired, true);
      assert.equal(repairRes.draft.version, 2);

      // Verify draft status: active remains 1, draft is 2
      const manifestMid = await repo.getManifest('wf_demo_lifecycle');
      assert.equal(manifestMid.activeVersion, 1);
      assert.equal(manifestMid.draftVersion, 2);

      // Step C: Operator reviews proposed repair diff (read-only)
      const reviewRes = await cli.review('wf_demo_lifecycle');
      assert.ok(reviewRes);
      assert.ok(reviewRes.diff.includes('Submit Order'));
      assert.ok(reviewRes.diff.includes('Complete Order'));

      // Step D: Normal playback STILL runs active v1 and still fails (draft isolation invariant!)
      const playMid = await cli.play('wf_demo_lifecycle', { inputs: { coupon: 'PROMO10' } });
      assert.equal(playMid.ok, false);
      assert.equal(playMid.version, 1);

      // Step E: Operator trials draft v2 using real browser execution
      const trialRes = await cli.trial('wf_demo_lifecycle', { inputs: { coupon: 'PROMO10' } });
      assert.equal(trialRes.success, true);
      assert.equal(trialRes.trialResult.candidatePromotionReady, true);

      // Verify trial does NOT automatically promote
      const manifestAfterTrial = await repo.getManifest('wf_demo_lifecycle');
      assert.equal(manifestAfterTrial.activeVersion, 1);
      assert.equal(manifestAfterTrial.draftVersion, 2);

      // Step F: Operator explicitly promotes verified draft
      const promoteRes = await cli.promote('wf_demo_lifecycle', {
        confirm: 'PROMOTE wf_demo_lifecycle',
      });
      assert.equal(promoteRes.promoted, true);
      assert.equal(promoteRes.manifest.activeVersion, 2);
      assert.equal(promoteRes.manifest.draftVersion, null);

      // Step G: Normal playback now runs promoted active v2 and SUCCEEDS!
      const playAfter = await cli.play('wf_demo_lifecycle', { inputs: { coupon: 'PROMO10' } });
      assert.equal(playAfter.ok, true);
      assert.equal(playAfter.version, 2);
    });

    it('executes standalone demo-recovery.js script in offline mode cleanly', async () => {
      const { runDemonstration } = await import('../../scripts/demo-recovery.js');
      const exitCode = await runDemonstration(['--offline']);
      assert.equal(exitCode, 0);
    });
  });
});
