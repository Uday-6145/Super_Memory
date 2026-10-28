/**
 * Super Memory — Workflow Player Integration & Unit Tests
 *
 * Tests the deterministic WorkflowPlayer using local HTTP fixtures on 127.0.0.1.
 *
 * Validates:
 * - Happy path playback: navigation, fillByLabel, clickByRole, predicate verification.
 * - Precondition enforcement: missing, disabled, draft-only, unverified, corrupt workflows fail closed.
 * - Runtime input validation: missing, undeclared, non-string, or empty required inputs rejected.
 * - Origin confinement: initial navigation and step navigation reject cross-origin destinations/redirects.
 * - Step failure isolation: early termination, subsequent steps skipped, success criteria skipped.
 * - Predicate & success criteria evaluation: pageTitle, textPresent, textAbsent, finalPath.
 * - Resource cleanup: browser sessions closed on success and failure; shared runtimes preserved.
 * - Concurrency: isolated sessions executing simultaneously without cross-talk.
 * - Immutability: zero disk mutation or content hash alteration during playback.
 * - Credential hygiene: sensitive input values never leak into results or errors.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  FileSystemWorkflowRepository,
  WorkflowPlayer,
  playWorkflow,
  calculateContentHash,
  sanitizeErrorMessage,
  evaluateRefreshHeader,
  findAuditViolation,
  recordAuditCommit,
  COMMIT_AUDIT_HISTORY_LIMIT,
  isPermittedBlankUrl,
  isAuditViolation,
  WorkflowValidationError,
  WorkflowNotFoundError,
  WorkflowDisabledError,
  NoVerifiedVersionError,
  WorkflowExecutionError,
  CorruptRecordError,
} from '../../src/workflow/index.js';

import { createBrowserRuntime } from '../../src/browser/index.js';

describe('Workflow Player (Local Fixtures)', () => {
  let fixtureServer;
  let baseUrl;
  let tempBaseDir;
  let repo;
  let sharedRuntime;

  before(async () => {
    fixtureServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Store Home</title></head>
          <body>
            <h1>Store Home</h1>
            <p id="page-desc">Welcome to the automated test store.</p>
            <a href="/checkout" id="to-checkout">Go to Checkout</a>
            <button id="cart-btn" onclick="document.getElementById('cart-status').innerText = 'Cart Open';">Open Cart</button>
            <span id="cart-status">Cart Closed</span>
          </body>
          </html>
        `);
        return;
      }

      if (url.pathname === '/checkout') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Checkout Page</title></head>
          <body>
            <h1>Checkout</h1>
            <form id="checkout-form" onsubmit="event.preventDefault(); location.href = '/success';">
              <label for="coupon-code">Coupon Code</label>
              <input id="coupon-code" type="text" />

              <label for="shipping-note">Shipping Note</label>
              <input id="shipping-note" type="text" />

              <button type="submit" id="submit-btn">Place Order</button>
            </form>
          </body>
          </html>
        `);
        return;
      }

      if (url.pathname === '/success') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Order Confirmation</title></head>
          <body>
            <h1>Order Confirmed</h1>
            <p id="msg">Thank you for your order!</p>
          </body>
          </html>
        `);
        return;
      }

      if (url.pathname === '/fail-endpoint') {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Server Error</title></head><body>500 Internal Error</body></html>');
        return;
      }

      if (url.pathname === '/redirect-outside') {
        res.writeHead(302, { Location: 'http://127.0.0.2:8080/outside' });
        res.end();
        return;
      }

      if (url.pathname === '/popup-trap') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Popup Trap</title></head>
          <body>
            <h1>Popup Trap</h1>
            <a href="http://127.0.0.2:9/evil" target="_blank" id="evil-popup">Open Evil Popup</a>
            <a href="/success" target="_blank" id="same-popup">Open Same-Origin Popup</a>
          </body>
          </html>
        `);
        return;
      }

      if (url.pathname === '/delayed-trap') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Delayed Trap</title></head>
          <body>
            <h1>Delayed Trap</h1>
            <button id="timer-btn" onclick="setTimeout(() => { location.href = 'http://127.0.0.2:9/evil'; }, 300);">Start Timer</button>
          </body>
          </html>
        `);
        return;
      }

      if (url.pathname === '/redirect-file') {
        res.writeHead(302, { Location: 'file:///etc/passwd?tok=SECRET_TOKEN_ABC#frag' });
        res.end();
        return;
      }

      if (url.pathname === '/redirect-js') {
        res.writeHead(302, { Location: 'javascript:alert(document.domain)' });
        res.end();
        return;
      }

      if (url.pathname === '/refresh-same') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Refresh: '0; url=/refresh-landing' });
        res.end('<html><head><title>Refresh Same</title></head><body>Redirecting same-origin…</body></html>');
        return;
      }

      if (url.pathname === '/refresh-landing') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Refresh Landing</title></head><body>Same-origin refresh landed.</body></html>');
        return;
      }

      if (url.pathname === '/refresh-evil') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Refresh: '30; url=http://127.0.0.2:9/evil' });
        res.end('<html><head><title>Refresh Evil</title></head><body>Delayed cross-origin refresh armed.</body></html>');
        return;
      }

      if (url.pathname === '/refresh-file') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Refresh: '30; url=file:///etc/passwd?tok=SECRET_RF' });
        res.end('<html><head><title>Refresh File</title></head><body>Delayed file-scheme refresh armed.</body></html>');
        return;
      }

      if (url.pathname === '/refresh-bad') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Refresh: '5; url=http://[invalid' });
        res.end('<html><head><title>Refresh Bad</title></head><body>Malformed refresh header served.</body></html>');
        return;
      }

      if (url.pathname === '/with-tracker') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>With Tracker</title></head><body><img src="http://127.0.0.2:9/pixel?x=1" alt=""></body></html>');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('Not found');
    });

    await new Promise((resolve) => {
      fixtureServer.listen(0, '127.0.0.1', () => {
        const port = fixtureServer.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    sharedRuntime = createBrowserRuntime({ headless: true, allowLocalhost: true });
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
    tempBaseDir = path.join(os.tmpdir(), `super-memory-player-test-${randomUUID()}`);
    repo = new FileSystemWorkflowRepository({ baseDir: tempBaseDir });
    await repo.init();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  // Helper to create and verify a standard test workflow
  async function createVerifiedTestWorkflow(workflowId = 'wf_store_checkout', customSteps = null) {
    const steps = customSteps || [
      {
        id: 'step_open_cart',
        order: 1,
        description: 'Open shopping cart',
        action: 'clickByRole',
        params: {
          role: 'button',
          name: 'Open Cart',
          exact: true,
          timeoutMs: 5000,
        },
        anchor: null,
        verification: {
          type: 'textPresent',
          expected: 'Cart Open',
        },
      },
      {
        id: 'step_nav_checkout',
        order: 2,
        description: 'Navigate to checkout',
        action: 'navigate',
        params: {
          path: '/checkout',
          waitUntil: 'domcontentloaded',
          timeoutMs: 5000,
        },
        anchor: null,
        verification: {
          type: 'pageTitle',
          expected: 'Checkout Page',
        },
      },
      {
        id: 'step_fill_coupon',
        order: 3,
        description: 'Fill discount coupon',
        action: 'fillByLabel',
        params: {
          label: 'Coupon Code',
          inputName: 'coupon',
          exact: true,
          timeoutMs: 5000,
        },
        anchor: null,
        verification: null,
      },
      {
        id: 'step_submit_order',
        order: 4,
        description: 'Submit order button',
        action: 'clickByRole',
        params: {
          role: 'button',
          name: 'Place Order',
          exact: true,
          timeoutMs: 5000,
        },
        anchor: null,
        verification: null,
      },
    ];

    const params = {
      id: workflowId,
      name: 'Store Checkout',
      description: 'Checkout workflow on test store',
      target: {
        origin: baseUrl,
        startPath: '/',
      },
      inputs: [
        {
          name: 'coupon',
          type: 'string',
          label: 'Coupon Code',
          description: 'Promo code',
          required: true,
        },
        {
          name: 'note',
          type: 'string',
          label: 'Shipping Note',
          description: 'Optional note',
          required: false,
        },
      ],
      steps,
      successCriteria: {
        finalPath: '/success',
        pageTitle: 'Order Confirmation',
        textPresent: 'Thank you for your order!',
      },
    };

    const { version } = await repo.createWorkflow(params);
    const contentHash = calculateContentHash(version);

    const evidence = {
      $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
      schemaVersion: '1.0.0',
      workflowId,
      version: 1,
      contentHash,
      runId: 'run_test_init_123',
      verifiedAt: new Date().toISOString(),
      environment: {
        targetOrigin: baseUrl,
        browserEngine: 'chromium',
        playwrightVersion: '1.64.1',
        nodeVersion: 'v22.19.0',
        platform: 'darwin-arm64',
      },
      stepResults: steps.map((s) => ({
        stepId: s.id,
        action: s.action,
        ok: true,
        durationMs: 25,
        verification: s.verification ? { type: s.verification.type, passed: true } : null,
      })),
      successCriteriaResult: {
        passed: true,
        finalPath: '/success',
        textPresentFound: true,
      },
    };

    await repo.markVerified(workflowId, 1, evidence);
    return repo.getVersion(workflowId, 1);
  }

  describe('Precondition & State Validation (Fail-Closed)', () => {
    it('1. rejects playback if workflow does not exist (WorkflowNotFoundError)', async () => {
      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });
      await assert.rejects(
        async () => player.play('wf_missing', { coupon: 'SAVE10' }),
        (err) => err instanceof WorkflowNotFoundError && err.code === 'WORKFLOW_NOT_FOUND'
      );
      await player.close();
    });

    it('2. rejects playback if workflow is disabled (WorkflowDisabledError)', async () => {
      await createVerifiedTestWorkflow('wf_disabled');
      await repo.setEnabled('wf_disabled', false);

      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });
      await assert.rejects(
        async () => player.play('wf_disabled', { coupon: 'SAVE10' }),
        (err) => err instanceof WorkflowDisabledError && err.code === 'WORKFLOW_DISABLED'
      );
      await player.close();
    });

    it('3. rejects playback if workflow has no active verified version (draft-only)', async () => {
      // Create draft-only workflow without calling markVerified
      const params = {
        id: 'wf_draft_only',
        name: 'Draft Only',
        description: 'No verified version',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: [
          {
            id: 's1',
            order: 1,
            description: 'Navigate',
            action: 'navigate',
            params: { path: '/' },
            anchor: null,
            verification: null,
          },
        ],
        successCriteria: { finalPath: '/' },
      };
      await repo.createWorkflow(params);

      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });
      await assert.rejects(
        async () => player.play('wf_draft_only', { coupon: 'SAVE10' }),
        (err) => err instanceof NoVerifiedVersionError && err.code === 'NO_VERIFIED_VERSION'
      );
      await player.close();
    });

    it('4. rejects playback if manifest record is corrupt (CorruptRecordError)', async () => {
      await createVerifiedTestWorkflow('wf_corrupt_manifest');
      const manifestPath = path.join(tempBaseDir, 'wf_corrupt_manifest', 'manifest.json');
      await fs.writeFile(manifestPath, '{ malformed json...');

      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });
      await assert.rejects(
        async () => player.play('wf_corrupt_manifest', { coupon: 'SAVE10' }),
        (err) => err instanceof CorruptRecordError && err.code === 'CORRUPT_RECORD'
      );
      await player.close();
    });

    it('5. rejects playback if active version record is corrupt (CorruptRecordError)', async () => {
      await createVerifiedTestWorkflow('wf_corrupt_ver');
      const verPath = path.join(tempBaseDir, 'wf_corrupt_ver', 'versions', '1.json');
      await fs.writeFile(verPath, 'not json at all');

      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });
      await assert.rejects(
        async () => player.play('wf_corrupt_ver', { coupon: 'SAVE10' }),
        (err) => err instanceof CorruptRecordError && err.code === 'CORRUPT_RECORD'
      );
      await player.close();
    });

    it('6. rejects playback if active version file is tampered to unverified draft status', async () => {
      await createVerifiedTestWorkflow('wf_unverified_ver');
      const verPath = path.join(tempBaseDir, 'wf_unverified_ver', 'versions', '1.json');
      const versionObj = JSON.parse(await fs.readFile(verPath, 'utf8'));
      versionObj.status = 'draft';
      await fs.writeFile(verPath, JSON.stringify(versionObj, null, 2));

      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });
      await assert.rejects(
        async () => player.play('wf_unverified_ver', { coupon: 'SAVE10' }),
        (err) => err instanceof NoVerifiedVersionError && err.code === 'NO_VERIFIED_VERSION'
      );
      await player.close();
    });
  });

  describe('Runtime Input Validation', () => {
    it('7. rejects playback when a required input is missing', async () => {
      await createVerifiedTestWorkflow('wf_input_missing');
      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });

      await assert.rejects(
        async () => player.play('wf_input_missing', {}),
        (err) => err instanceof WorkflowValidationError && err.message.includes('Missing required input "coupon"')
      );
      await player.close();
    });

    it('8. rejects playback when a required input is an empty string or whitespace', async () => {
      await createVerifiedTestWorkflow('wf_input_empty');
      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });

      await assert.rejects(
        async () => player.play('wf_input_empty', { coupon: '' }),
        (err) => err instanceof WorkflowValidationError && err.message.includes('cannot be empty')
      );

      await assert.rejects(
        async () => player.play('wf_input_empty', { coupon: '   ' }),
        (err) => err instanceof WorkflowValidationError && err.message.includes('cannot be empty')
      );
      await player.close();
    });

    it('9. rejects playback when an input value is not a string', async () => {
      await createVerifiedTestWorkflow('wf_input_nonstring');
      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });

      await assert.rejects(
        async () => player.play('wf_input_nonstring', { coupon: 12345 }),
        (err) => err instanceof WorkflowValidationError && err.message.includes('must be a string')
      );
      await player.close();
    });

    it('10. rejects playback when an undeclared input key is provided', async () => {
      await createVerifiedTestWorkflow('wf_input_undeclared');
      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });

      await assert.rejects(
        async () => player.play('wf_input_undeclared', { coupon: 'SAVE10', unauthorizedField: 'bad' }),
        (err) => err instanceof WorkflowValidationError && err.message.includes('Unknown input "unauthorizedField"')
      );
      await player.close();
    });

    it('11. accepts valid optional input and permits omitting optional input', async () => {
      await createVerifiedTestWorkflow('wf_optional_input');
      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      // Run omitting optional 'note'
      const res1 = await player.play('wf_optional_input', { coupon: 'SAVE10' });
      assert.equal(res1.ok, true);
      assert.equal(res1.status, 'success');

      // Run providing optional 'note'
      const res2 = await player.play('wf_optional_input', { coupon: 'SAVE20', note: 'Leave at front door' });
      assert.equal(res2.ok, true);
      assert.equal(res2.status, 'success');
    });
  });

  describe('Deterministic Step Execution & Verification', () => {
    it('12. successfully executes all steps and returns complete execution report', async () => {
      await createVerifiedTestWorkflow('wf_happy_path');
      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_happy_path', { coupon: 'DISCOUNT2026' });

      assert.equal(result.ok, true);
      assert.equal(result.status, 'success');
      assert.equal(result.workflowId, 'wf_happy_path');
      assert.equal(result.version, 1);
      assert.ok(result.runId.startsWith('run_'));
      assert.ok(result.durationMs >= 0);
      assert.equal(result.error, null);

      // Verify all 4 step results were executed and passed
      assert.equal(result.stepResults.length, 4);
      assert.deepEqual(
        result.stepResults.map((s) => ({ stepId: s.stepId, action: s.action, ok: s.ok })),
        [
          { stepId: 'step_open_cart', action: 'clickByRole', ok: true },
          { stepId: 'step_nav_checkout', action: 'navigate', ok: true },
          { stepId: 'step_fill_coupon', action: 'fillByLabel', ok: true },
          { stepId: 'step_submit_order', action: 'clickByRole', ok: true },
        ]
      );

      // Verify step predicates
      assert.deepEqual(result.stepResults[0].verification, { type: 'textPresent', passed: true });
      assert.deepEqual(result.stepResults[1].verification, { type: 'pageTitle', passed: true });

      // Verify success criteria
      assert.equal(result.successCriteriaResult.passed, true);
      assert.equal(result.successCriteriaResult.finalPathMatched, true);
      assert.equal(result.successCriteriaResult.pageTitleMatched, true);
      assert.equal(result.successCriteriaResult.textPresentFound, true);
    });

    it('13. terminates playback early when a step action fails and skips subsequent steps', async () => {
      // Step 2 attempts to click a non-existent button
      const customSteps = [
        {
          id: 'step_initial_cart',
          order: 1,
          description: 'Open Cart',
          action: 'clickByRole',
          params: { role: 'button', name: 'Open Cart', timeoutMs: 3000 },
          anchor: null,
          verification: null,
        },
        {
          id: 'step_bad_click',
          order: 2,
          description: 'Click Non-Existent Button',
          action: 'clickByRole',
          params: { role: 'button', name: 'Non Existent Button XYZ', timeoutMs: 1000 },
          anchor: null,
          verification: null,
        },
        {
          id: 'step_should_be_skipped',
          order: 3,
          description: 'Should never run',
          action: 'navigate',
          params: { path: '/checkout' },
          anchor: null,
          verification: null,
        },
      ];

      await createVerifiedTestWorkflow('wf_early_terminate', customSteps);
      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_early_terminate', { coupon: 'ABC' });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('Non Existent Button XYZ'));

      // Exactly 2 step results: 1 passed, 2 failed; step 3 was skipped
      assert.equal(result.stepResults.length, 2);
      assert.equal(result.stepResults[0].ok, true);
      assert.equal(result.stepResults[1].ok, false);
      assert.ok(result.stepResults[1].error.includes('Non Existent Button XYZ'));

      // Success criteria skipped
      assert.equal(result.successCriteriaResult.passed, false);
      assert.ok(result.successCriteriaResult.details.includes('Skipped'));
    });

    it('14. terminates playback when an in-step verification predicate fails', async () => {
      // Step 1 expects text that will NOT be present
      const customSteps = [
        {
          id: 'step_failed_predicate',
          order: 1,
          description: 'Click cart with impossible predicate',
          action: 'clickByRole',
          params: { role: 'button', name: 'Open Cart', timeoutMs: 3000 },
          anchor: null,
          verification: {
            type: 'textPresent',
            expected: 'Impossible Text That Does Not Exist 99999',
          },
        },
        {
          id: 'step_skipped_after_predicate_fail',
          order: 2,
          description: 'Should never run',
          action: 'navigate',
          params: { path: '/checkout' },
          anchor: null,
          verification: null,
        },
      ];

      await createVerifiedTestWorkflow('wf_pred_fail', customSteps);
      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_pred_fail', { coupon: 'TEST' });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('predicate failed'));
      assert.equal(result.stepResults.length, 1);
      assert.equal(result.stepResults[0].ok, false);
      assert.equal(result.stepResults[0].verification.passed, false);
    });

    it('15. marks run as failed when success criteria are not met after step completion', async () => {
      // Steps succeed, but successCriteria requires finalPath '/impossible-path'
      const customSteps = [
        {
          id: 'step_open_cart',
          order: 1,
          description: 'Open Cart',
          action: 'clickByRole',
          params: { role: 'button', name: 'Open Cart', timeoutMs: 3000 },
          anchor: null,
          verification: null,
        },
      ];

      const params = {
        id: 'wf_criteria_fail',
        name: 'Criteria Fail Workflow',
        description: 'Tests criteria failure',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: customSteps,
        successCriteria: {
          finalPath: '/unreached-path', // Fails! Current path is '/'
        },
      };

      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      const evidence = {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId: 'wf_criteria_fail',
        version: 1,
        contentHash: hash,
        runId: 'run_init_dummy',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [{ stepId: 'step_open_cart', action: 'clickByRole', ok: true, durationMs: 10, verification: null }],
        successCriteriaResult: { passed: true },
      };
      await repo.markVerified('wf_criteria_fail', 1, evidence);

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_criteria_fail', { coupon: 'TEST' });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('success criteria were not satisfied'));
      assert.equal(result.stepResults[0].ok, true);
      assert.equal(result.successCriteriaResult.passed, false);
      assert.equal(result.successCriteriaResult.finalPathMatched, false);
    });

    it('16. throws WorkflowExecutionError when throwOnFailure is true', async () => {
      await createVerifiedTestWorkflow('wf_throw_mode', [
        {
          id: 'step_bad',
          order: 1,
          description: 'Bad action',
          action: 'clickByRole',
          params: { role: 'button', name: 'Ghost Button', timeoutMs: 500 },
          anchor: null,
          verification: null,
        },
      ]);

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      await assert.rejects(
        async () => player.play('wf_throw_mode', { coupon: 'TEST' }, { throwOnFailure: true }),
        (err) => {
          return (
            err instanceof WorkflowExecutionError &&
            err.code === 'WORKFLOW_EXECUTION_FAILED' &&
            err.runResult &&
            err.runResult.ok === false &&
            err.runResult.status === 'failed'
          );
        }
      );
    });
  });

  describe('Origin Confinement & Security', () => {
    it('17. rejects step navigation redirect that escapes declared target origin', async () => {
      const customSteps = [
        {
          id: 'step_escape_nav',
          order: 1,
          description: 'Navigate to redirect endpoint that escapes origin',
          action: 'navigate',
          params: { path: '/redirect-outside' },
          anchor: null,
          verification: null,
        },
      ];

      await createVerifiedTestWorkflow('wf_origin_escape', customSteps);
      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_origin_escape', { coupon: 'TEST' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('Cross-origin navigation rejected'));
    });

    it('18. never leaks runtime input values into results or error messages', async () => {
      const secretCoupon = 'SUPER_CONFIDENTIAL_TOKEN_XYZ_999';
      await createVerifiedTestWorkflow('wf_redaction_test');

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_redaction_test', { coupon: secretCoupon });

      // Ensure secretCoupon does not appear anywhere in the serialized result object
      const resultJson = JSON.stringify(result);
      assert.equal(
        resultJson.includes(secretCoupon),
        false,
        'Runtime input value must never appear in the execution result object'
      );
    });
  });

  describe('Popup & Delayed-Redirect Confinement (H1/H2)', () => {
    it('24. rejects a cross-origin popup opened from the target page (H1)', async () => {
      const customSteps = [
        {
          id: 'step_open_evil_popup',
          order: 1,
          description: 'Click link that opens a cross-origin popup',
          action: 'clickByRole',
          params: { role: 'link', name: 'Open Evil Popup', timeoutMs: 5000 },
          anchor: null,
          verification: null,
        },
      ];

      const params = {
        id: 'wf_popup_escape',
        name: 'Popup Escape',
        description: 'Cross-origin popup must fail the run',
        target: { origin: baseUrl, startPath: '/popup-trap' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: customSteps,
        successCriteria: { finalPath: '/popup-trap' },
      };

      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified('wf_popup_escape', 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId: 'wf_popup_escape',
        version: 1,
        contentHash: hash,
        runId: 'run_init_popup',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [{ stepId: 'step_open_evil_popup', action: 'clickByRole', ok: true, durationMs: 10, verification: null }],
        successCriteriaResult: { passed: true },
      });

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_popup_escape', { coupon: 'TEST' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('Cross-origin navigation rejected'));
    });

    it('25. still succeeds when the popup stays within the declared origin (H1 compat)', async () => {
      const customSteps = [
        {
          id: 'step_open_same_popup',
          order: 1,
          description: 'Click link that opens a same-origin popup',
          action: 'clickByRole',
          params: { role: 'link', name: 'Open Same-Origin Popup', timeoutMs: 5000 },
          anchor: null,
          verification: null,
        },
      ];

      const params = {
        id: 'wf_popup_same_origin',
        name: 'Same-Origin Popup',
        description: 'Same-origin popup must not fail the run',
        target: { origin: baseUrl, startPath: '/popup-trap' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: customSteps,
        successCriteria: { finalPath: '/popup-trap' },
      };

      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified('wf_popup_same_origin', 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId: 'wf_popup_same_origin',
        version: 1,
        contentHash: hash,
        runId: 'run_init_popup_same',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [{ stepId: 'step_open_same_popup', action: 'clickByRole', ok: true, durationMs: 10, verification: null }],
        successCriteriaResult: { passed: true },
      });

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_popup_same_origin', { coupon: 'TEST' });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'success');
    });

    it('26. rejects a client-side redirect that fires after the final step checks (H2)', async () => {
      const customSteps = [
        {
          id: 'step_nav_delayed_trap',
          order: 1,
          description: 'Navigate to delayed-redirect trap page',
          action: 'navigate',
          params: { path: '/delayed-trap' },
          anchor: null,
          verification: null,
        },
        {
          id: 'step_start_timer',
          order: 2,
          description: 'Start the delayed cross-origin redirect timer',
          action: 'clickByRole',
          params: { role: 'button', name: 'Start Timer', timeoutMs: 5000 },
          anchor: null,
          verification: null,
        },
      ];

      const params = {
        id: 'wf_delayed_escape',
        name: 'Delayed Escape',
        description: 'Delayed client-side redirect must fail the run',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: customSteps,
        successCriteria: { finalPath: '/delayed-trap' },
      };

      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified('wf_delayed_escape', 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId: 'wf_delayed_escape',
        version: 1,
        contentHash: hash,
        runId: 'run_init_delayed',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: customSteps.map((s) => ({ stepId: s.id, action: s.action, ok: true, durationMs: 10, verification: null })),
        successCriteriaResult: { passed: true },
      });

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_delayed_escape', { coupon: 'TEST' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('Cross-origin navigation rejected'));
    });
  });

  describe('Playback Integrity Revalidation (H3)', () => {
    it('27. rejects playback when verified content is tampered without updating evidence', async () => {
      await createVerifiedTestWorkflow('wf_tampered_content');
      // Schema-valid, execution-neutral tamper: step descriptions are covered
      // by the content hash (hash.js) but do not affect browser behavior.
      const verPath = path.join(tempBaseDir, 'wf_tampered_content', 'versions', '1.json');
      const versionObj = JSON.parse(await fs.readFile(verPath, 'utf8'));
      versionObj.steps[0].description = 'Tampered description not present at verification time';
      await fs.writeFile(verPath, JSON.stringify(versionObj, null, 2));

      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });
      await assert.rejects(
        async () => player.play('wf_tampered_content', { coupon: 'SAVE10' }),
        (err) => err instanceof CorruptRecordError && err.code === 'CORRUPT_RECORD'
      );
      await player.close();
    });

    it('28. rejects playback when verification evidence is missing for the active version', async () => {
      await createVerifiedTestWorkflow('wf_missing_evidence');
      const evidencePath = path.join(tempBaseDir, 'wf_missing_evidence', 'verifications', '1.evidence.json');
      await fs.unlink(evidencePath);

      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });
      await assert.rejects(
        async () => player.play('wf_missing_evidence', { coupon: 'SAVE10' }),
        (err) => err instanceof NoVerifiedVersionError && err.code === 'NO_VERIFIED_VERSION'
      );
      await player.close();
    });

    it('29. rejects playback when evidence does not match the version being played', async () => {
      await createVerifiedTestWorkflow('wf_mismatched_evidence');
      // Schema-valid evidence edit: well-formed but non-matching content hash.
      const evidencePath = path.join(tempBaseDir, 'wf_mismatched_evidence', 'verifications', '1.evidence.json');
      const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
      evidence.contentHash = '0'.repeat(64);
      await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2));

      const player = new WorkflowPlayer({ repository: repo, allowLocalhost: true });
      await assert.rejects(
        async () => player.play('wf_mismatched_evidence', { coupon: 'SAVE10' }),
        (err) => err instanceof CorruptRecordError && err.code === 'CORRUPT_RECORD'
      );
      await player.close();
    });
  });

  describe('Error Sanitization (M1/M2)', () => {
    it('30. strips query strings and fragments from http(s) URLs in errors', async () => {
      assert.equal(
        sanitizeErrorMessage('failed at https://example.com/path?token=abc#frag end'),
        'failed at https://example.com/path end'
      );
      assert.equal(sanitizeErrorMessage(null), 'Unknown execution error');
      assert.equal(sanitizeErrorMessage('plain message'), 'plain message');
    });

    it('31. strips queries/fragments from non-http schemes and redacts executable schemes', async () => {
      assert.equal(
        sanitizeErrorMessage('blocked file:///etc/passwd?tok=SECRET#frag now'),
        'blocked file:///etc/passwd now'
      );
      assert.equal(
        sanitizeErrorMessage('blocked myapp://host/path?tok=1 now'),
        'blocked myapp://host/path now'
      );
      assert.equal(
        sanitizeErrorMessage('x javascript:alert(document.cookie) y'),
        'x javascript:[REDACTED] y'
      );
      assert.equal(
        sanitizeErrorMessage('x data:text/plain;base64,SECRETDATA y'),
        'x data:[REDACTED] y'
      );
    });

    it('32. redacts supplied secret values including case and whitespace variants', async () => {
      assert.equal(
        sanitizeErrorMessage('failed TOKEN_ABC_XYZ here', ['TOKEN_ABC_XYZ']),
        'failed [REDACTED] here'
      );
      assert.equal(
        sanitizeErrorMessage('failed token_abc_xyz here', ['TOKEN_ABC_XYZ']),
        'failed [REDACTED] here'
      );
      assert.equal(
        sanitizeErrorMessage('failed padded secret here', ['  padded secret  ']),
        'failed [REDACTED] here'
      );
      // Empty or non-string secrets must not mangle the message.
      assert.equal(
        sanitizeErrorMessage('plain message', ['', '   ', null, 123]),
        'plain message'
      );
      // Unrelated text is preserved.
      assert.equal(
        sanitizeErrorMessage('button "Submit" failed', ['OTHER_SECRET']),
        'button "Submit" failed'
      );
    });

    it('33. keeps supplied input values out of failure-path error results (M1)', async () => {
      const secret = 'M1_SECRET_COUPON_ZZ9';
      const customSteps = [
        {
          id: 'step_echo_fail',
          order: 1,
          description: 'Click a control whose name echoes the secret into the error',
          action: 'clickByRole',
          params: { role: 'button', name: secret, timeoutMs: 1000 },
          anchor: null,
          verification: null,
        },
      ];

      const params = {
        id: 'wf_m1_failure_path',
        name: 'M1 Failure Path',
        description: 'Secret must not leak into failure errors',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: customSteps,
        successCriteria: { finalPath: '/' },
      };

      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified('wf_m1_failure_path', 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId: 'wf_m1_failure_path',
        version: 1,
        contentHash: hash,
        runId: 'run_init_m1',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [{ stepId: 'step_echo_fail', action: 'clickByRole', ok: true, durationMs: 10, verification: null }],
        successCriteriaResult: { passed: true },
      });

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_m1_failure_path', { coupon: secret });
      assert.equal(result.ok, false);
      const resultJson = JSON.stringify(result);
      assert.equal(resultJson.includes(secret), false, 'Input value must not appear in failure results');
      assert.equal(resultJson.includes(secret.toLowerCase()), false, 'Case variant must not appear either');
    });

    it('34. rejects file-scheme redirects without leaking their query into errors (M2)', async () => {
      const customSteps = [
        {
          id: 'step_file_redirect',
          order: 1,
          description: 'Navigate to endpoint redirecting to a file URL with secret query',
          action: 'navigate',
          params: { path: '/redirect-file' },
          anchor: null,
          verification: null,
        },
      ];

      const params = {
        id: 'wf_m2_file_redirect',
        name: 'M2 File Redirect',
        description: 'Unsafe redirect target must be rejected and redacted',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: customSteps,
        successCriteria: { finalPath: '/' },
      };

      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified('wf_m2_file_redirect', 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId: 'wf_m2_file_redirect',
        version: 1,
        contentHash: hash,
        runId: 'run_init_m2_file',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [{ stepId: 'step_file_redirect', action: 'navigate', ok: true, durationMs: 10, verification: null }],
        successCriteriaResult: { passed: true },
      });

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_m2_file_redirect', { coupon: 'TEST' });
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('Cross-origin navigation rejected'));
      assert.equal(result.error.includes('SECRET_TOKEN_ABC'), false, 'Redirect query must not leak into error');
      assert.equal(result.error.includes('?tok='), false, 'Redirect query string must be stripped');
    });

    it('35. rejects javascript-scheme redirects without echoing payload into errors (M2)', async () => {
      const customSteps = [
        {
          id: 'step_js_redirect',
          order: 1,
          description: 'Navigate to endpoint redirecting to a javascript URL',
          action: 'navigate',
          params: { path: '/redirect-js' },
          anchor: null,
          verification: null,
        },
      ];

      const params = {
        id: 'wf_m2_js_redirect',
        name: 'M2 JS Redirect',
        description: 'Executable redirect target must be rejected and redacted',
        target: { origin: baseUrl, startPath: '/' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: customSteps,
        successCriteria: { finalPath: '/' },
      };

      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified('wf_m2_js_redirect', 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId: 'wf_m2_js_redirect',
        version: 1,
        contentHash: hash,
        runId: 'run_init_m2_js',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [{ stepId: 'step_js_redirect', action: 'navigate', ok: true, durationMs: 10, verification: null }],
        successCriteriaResult: { passed: true },
      });

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_m2_js_redirect', { coupon: 'TEST' });
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('Cross-origin navigation rejected'));
      assert.equal(result.error.includes('alert(document.domain)'), false, 'Redirect payload must not leak into error');
    });
  });

  describe('Refresh-Header Redirect Policy (L5)', () => {
    async function createOneStepNavWorkflow(workflowId, stepPath, finalPath = stepPath) {
      const params = {
        id: workflowId,
        name: workflowId,
        description: `Refresh test workflow ${workflowId}`,
        target: { origin: baseUrl, startPath: '/' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: [
          {
            id: 'step_nav',
            order: 1,
            description: 'Navigate to fixture',
            action: 'navigate',
            params: { path: stepPath },
            anchor: null,
            verification: null,
          },
        ],
        successCriteria: { finalPath },
      };
      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified(workflowId, 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId,
        version: 1,
        contentHash: hash,
        runId: 'run_init_refresh',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [{ stepId: 'step_nav', action: 'navigate', ok: true, durationMs: 10, verification: null }],
        successCriteriaResult: { passed: true },
      });
    }

    function makePlayer() {
      return new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });
    }

    it('36. follows a same-origin Refresh header to its landing page', async () => {
      await createOneStepNavWorkflow('wf_refresh_same', '/refresh-same', '/refresh-landing');
      const player = makePlayer();

      const result = await player.play('wf_refresh_same', { coupon: 'TEST' });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'success');
      assert.equal(result.successCriteriaResult.finalPathMatched, true);
    });

    it('37. rejects a delayed cross-origin Refresh header before its timer fires', async () => {
      await createOneStepNavWorkflow('wf_refresh_evil', '/refresh-evil');
      const player = makePlayer();

      const result = await player.play('wf_refresh_evil', { coupon: 'TEST' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('Cross-origin navigation rejected'));
    });

    it('38. rejects an unsupported-scheme Refresh target without leaking its query', async () => {
      await createOneStepNavWorkflow('wf_refresh_file', '/refresh-file');
      const player = makePlayer();

      const result = await player.play('wf_refresh_file', { coupon: 'TEST' });
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('Cross-origin navigation rejected'));
      assert.equal(result.error.includes('SECRET_RF'), false, 'Refresh target query must not leak into error');
      assert.equal(result.error.includes('?tok='), false, 'Refresh target query string must be stripped');
    });

    it('39. fails closed on a malformed Refresh target', async () => {
      await createOneStepNavWorkflow('wf_refresh_bad', '/refresh-bad');
      const player = makePlayer();

      const result = await player.play('wf_refresh_bad', { coupon: 'TEST' });
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('Cross-origin navigation rejected'));
    });

    it('40. evaluates Refresh header values against the confinement policy', async () => {
      const base = 'http://127.0.0.1:8080/start';
      const origin = 'http://127.0.0.1:8080';

      // Delay-only values reload or are ignored by browsers: safe either way.
      assert.deepEqual(evaluateRefreshHeader('0', base, origin), { ok: true, detail: null });
      assert.deepEqual(evaluateRefreshHeader('30', base, origin), { ok: true, detail: null });
      assert.deepEqual(evaluateRefreshHeader('0; url=', base, origin), { ok: true, detail: null });

      // Same-origin http(s) targets may proceed.
      assert.deepEqual(evaluateRefreshHeader('0; url=/next', base, origin).ok, true);
      assert.deepEqual(evaluateRefreshHeader('0, url=/next', base, origin).ok, true);
      assert.deepEqual(evaluateRefreshHeader('0; URL="/quoted-path"', base, origin).ok, true);
      assert.deepEqual(evaluateRefreshHeader('0; /bare-relative', base, origin).ok, true);

      // Cross-origin, unsupported-scheme, and malformed targets fail closed.
      assert.deepEqual(evaluateRefreshHeader('30; url=http://127.0.0.2:9/evil', base, origin).ok, false);
      assert.deepEqual(evaluateRefreshHeader('30, url=http://127.0.0.2:9/evil', base, origin).ok, false);
      assert.deepEqual(evaluateRefreshHeader('0; url=file:///etc/passwd?tok=1', base, origin).ok, false);
      assert.deepEqual(evaluateRefreshHeader('0; url=javascript:alert(1)', base, origin).ok, false);
      assert.deepEqual(evaluateRefreshHeader('5; url=http://[invalid', base, origin).ok, false);

      // Blocked verdicts carry the offending target for (sanitized) reporting.
      assert.equal(
        evaluateRefreshHeader('30; url=http://127.0.0.2:9/evil', base, origin).detail,
        'http://127.0.0.2:9/evil'
      );
    });
  });

  describe('Route Interception Faults (L4)', () => {
    // Minimal session/runtime doubles that route navigations through the real
    // player route handler with scripted route.fetch/fulfill/abort outcomes.
    // No browser is launched; interception behavior is fully deterministic.
    function makeSessionDouble(targetOrigin) {
      const state = {
        currentUrl: `${targetOrigin}/`,
        routeCalls: [],
        routeAborted: false,
        sessionClosed: false,
        handler: null,
        fetchMode: 'ok',
        fulfillMode: 'ok',
        abortMode: 'ok',
      };
      const frameDouble = { page: () => pageDouble };
      const requestDouble = {
        isNavigationRequest: () => true,
        frame: () => frameDouble,
        url: () => state.currentUrl,
      };
      const routeDouble = {
        request: () => requestDouble,
        fetch: async () => {
          state.routeCalls.push('fetch');
          if (state.fetchMode === 'fail') throw new Error('simulated route.fetch failure');
          return { status: () => 200, headers: () => ({}) };
        },
        fulfill: async () => {
          state.routeCalls.push('fulfill');
          if (state.fulfillMode === 'fail') throw new Error('simulated route.fulfill failure');
        },
        abort: async () => {
          state.routeCalls.push('abort');
          state.routeAborted = true;
          if (state.abortMode === 'fail') throw new Error('simulated route.abort failure: already handled');
        },
        continue: async () => {
          state.routeCalls.push('continue');
        },
      };
      const pageDouble = {
        url: () => state.currentUrl,
        title: async () => 'Double Title',
        isClosed: () => false,
        close: async () => {},
        mainFrame: () => frameDouble,
        waitForEvent: async () => {
          throw new Error('Timeout exceeded');
        },
      };
      const sessionDouble = {
        page: pageDouble,
        context: {
          pages: () => [pageDouble],
          route: async (pattern, handler) => {
            state.handler = handler;
          },
        },
        navigate: async (url) => {
          state.currentUrl = url;
          await state.handler(routeDouble);
          if (state.routeAborted) {
            throw new Error(`Navigation failed: net::ERR_ABORTED at ${url}`);
          }
          return { url, title: 'Double Title', status: 200, ok: true };
        },
        close: async () => {
          state.sessionClosed = true;
        },
      };
      const runtimeDouble = {
        createSession: async () => sessionDouble,
        close: async () => {},
      };
      return { state, runtime: runtimeDouble };
    }

    it('41. aborts instead of continuing when route.fetch fails (L4)', async () => {
      const { state, runtime } = makeSessionDouble(baseUrl);
      state.fetchMode = 'fail';
      await createVerifiedTestWorkflow('wf_l4_fetch_fault');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_l4_fetch_fault', { coupon: 'TEST' });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('interception failed'));
      assert.ok(state.routeCalls.includes('fetch'));
      assert.ok(state.routeCalls.includes('abort'), 'failed interception must abort the request');
      assert.equal(
        state.routeCalls.includes('continue'),
        false,
        'failed interception must not fall through to an uninspected native request'
      );
      assert.equal(state.sessionClosed, true, 'session must be cleaned up after interception fault');
      await player.close();
    });

    it('42. aborts as fallback when route.fulfill fails so the route never hangs', async () => {
      const { state, runtime } = makeSessionDouble(baseUrl);
      state.fulfillMode = 'fail';
      await createVerifiedTestWorkflow('wf_l4_fulfill_fault');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_l4_fulfill_fault', { coupon: 'TEST' });

      assert.equal(result.ok, false);
      assert.ok(result.error.includes('interception failed'));
      assert.ok(state.routeCalls.includes('fulfill'));
      assert.ok(state.routeCalls.includes('abort'), 'failed fulfill must fall back to abort');
      assert.equal(
        state.routeCalls.includes('continue'),
        false,
        'failed fulfill must not fall through to an uninspected native request'
      );
      assert.equal(state.sessionClosed, true);
      await player.close();
    });

    it('43. still fails closed when abort itself reports already-handled', async () => {
      const { state, runtime } = makeSessionDouble(baseUrl);
      state.fetchMode = 'fail';
      state.abortMode = 'fail';
      await createVerifiedTestWorkflow('wf_l4_abort_fault');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_l4_abort_fault', { coupon: 'TEST' });

      assert.equal(result.ok, false);
      assert.ok(result.error.includes('interception failed'));
      assert.ok(state.routeCalls.includes('abort'), 'abort must be attempted even if it reports failure');
      assert.equal(state.sessionClosed, true);
      await player.close();
    });
  });

  describe('Commit Audit & Post-Close Reconciliation (P3)', () => {
    // Event-emitting session double: navigations fire framenavigated like a
    // real browser, and extra/teardown commits can be scripted to exercise
    // the audit and reconciliation paths deterministically.
    function makeAuditedSessionDouble(targetOrigin) {
      const state = {
        currentUrl: `${targetOrigin}/`,
        sessionClosed: false,
        extraCommits: [],
        teardownCommit: null,
        frameHandlers: [],
        pageHandlers: [],
      };
      const fireCommit = (url) => {
        const commitFrame = { page: () => pageDouble, url: () => url };
        state.currentFrame = commitFrame;
        for (const handler of state.frameHandlers) {
          handler(commitFrame);
        }
      };
      const pageDouble = {
        url: () => state.currentUrl,
        title: async () => 'Double Title',
        isClosed: () => false,
        close: async () => {},
        mainFrame: () => state.currentFrame,
        waitForEvent: async () => {
          throw new Error('Timeout exceeded');
        },
        on: (event, handler) => {
          if (event === 'framenavigated') state.frameHandlers.push(handler);
        },
        removeListener: () => {},
      };
      const sessionDouble = {
        page: pageDouble,
        context: {
          pages: () => [pageDouble],
          route: async () => {},
          on: (event, handler) => {
            if (event === 'page') state.pageHandlers.push(handler);
          },
          removeListener: () => {},
        },
        navigate: async (url) => {
          state.currentUrl = url;
          fireCommit(url);
          for (const extra of state.extraCommits) {
            fireCommit(extra);
          }
          return { url, title: 'Double Title', status: 200, ok: true };
        },
        close: async () => {
          if (state.teardownCommit) {
            fireCommit(state.teardownCommit);
          }
          state.sessionClosed = true;
        },
      };
      const runtimeDouble = {
        createSession: async () => sessionDouble,
        close: async () => {},
      };
      return { state, runtime: runtimeDouble };
    }

    async function createOneStepAuditWorkflow(workflowId, stepPath) {
      const params = {
        id: workflowId,
        name: workflowId,
        description: `Audit test workflow ${workflowId}`,
        target: { origin: baseUrl, startPath: '/' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: [
          {
            id: 'step_nav',
            order: 1,
            description: 'Navigate to fixture',
            action: 'navigate',
            params: { path: stepPath },
            anchor: null,
            verification: null,
          },
        ],
        successCriteria: { finalPath: stepPath },
      };
      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified(workflowId, 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId,
        version: 1,
        contentHash: hash,
        runId: 'run_init_audit',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [{ stepId: 'step_nav', action: 'navigate', ok: true, durationMs: 10, verification: null }],
        successCriteriaResult: { passed: true },
      });
    }

    it('44. permits same-origin and null-origin commits without flipping the verdict', async () => {
      const { state, runtime } = makeAuditedSessionDouble(baseUrl);
      state.extraCommits = ['about:blank', 'chrome-error://chromewebdata/'];
      await createOneStepAuditWorkflow('wf_audit_benign', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_audit_benign', { coupon: 'TEST' });

      assert.equal(result.ok, true);
      assert.equal(result.status, 'success');
      assert.equal(state.sessionClosed, true);
      await player.close();
    });

    it('45. flips an otherwise-successful verdict when a foreign commit is recorded', async () => {
      const { state, runtime } = makeAuditedSessionDouble(baseUrl);
      state.extraCommits = ['http://127.0.0.2:9/evil'];
      await createOneStepAuditWorkflow('wf_audit_evil', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_audit_evil', { coupon: 'TEST' });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('Post-execution audit'));
      assert.equal(state.sessionClosed, true);
      await player.close();
    });

    it('46. flips the verdict when a foreign commit lands during teardown', async () => {
      const { state, runtime } = makeAuditedSessionDouble(baseUrl);
      state.teardownCommit = 'http://127.0.0.2:9/evil';
      await createOneStepAuditWorkflow('wf_audit_teardown', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_audit_teardown', { coupon: 'TEST' });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('Post-execution audit'));
      assert.equal(state.sessionClosed, true);
      await player.close();
    });

    it('47. validates recorded commit histories against the confinement policy', async () => {
      const origin = 'http://127.0.0.1:8080';

      assert.equal(findAuditViolation([], origin), null);
      assert.equal(findAuditViolation(['http://127.0.0.1:8080/a', 'http://127.0.0.1:8080/b#c'], origin), null);
      assert.equal(findAuditViolation(['about:blank', 'http://127.0.0.1:8080/a'], origin), null);
      assert.equal(findAuditViolation(['chrome-error://chromewebdata/'], origin), null);

      assert.equal(
        findAuditViolation(['http://127.0.0.1:8080/a', 'http://127.0.0.2:9/evil'], origin),
        'http://127.0.0.2:9/evil'
      );
      assert.equal(
        findAuditViolation(['file:///etc/passwd'], origin),
        'file:///etc/passwd'
      );
      assert.equal(findAuditViolation(['::::'], origin), '::::');
      assert.equal(findAuditViolation([null], origin), '(unavailable)');
      assert.equal(findAuditViolation(null, origin), null);
    });

    it('47b. permits about:blank and fragment-only variants while rejecting query and arbitrary about: variants (Fix 2)', async () => {
      const origin = 'http://127.0.0.1:8080';

      // Unit test: isPermittedBlankUrl
      assert.equal(isPermittedBlankUrl('about:blank'), true);
      assert.equal(isPermittedBlankUrl('about:blank#'), true);
      assert.equal(isPermittedBlankUrl('about:blank#fragment'), true);
      assert.equal(isPermittedBlankUrl('about:blank#foo=bar'), true);
      assert.equal(isPermittedBlankUrl('ABOUT:BLANK'), true);
      assert.equal(isPermittedBlankUrl('ABOUT:BLANK#frag'), true);

      assert.equal(isPermittedBlankUrl('about:blank?query=1'), false);
      assert.equal(isPermittedBlankUrl('about:blank?foo#bar'), false);
      assert.equal(isPermittedBlankUrl('about:config'), false);
      assert.equal(isPermittedBlankUrl('about:srcdoc'), false);
      assert.equal(isPermittedBlankUrl('about:blank2'), false);
      assert.equal(isPermittedBlankUrl('about:blank/sub'), false);
      assert.equal(isPermittedBlankUrl('http://example.com/about:blank'), false);
      assert.equal(isPermittedBlankUrl(null), false);

      // findAuditViolation behavior
      assert.equal(findAuditViolation(['about:blank#fragment'], origin), null);
      assert.equal(findAuditViolation(['about:blank', 'about:blank#tab-1', 'http://127.0.0.1:8080/a'], origin), null);
      assert.equal(findAuditViolation(['about:blank?query=1'], origin), 'about:blank?query=1');
      assert.equal(findAuditViolation(['about:config'], origin), 'about:config');
      assert.equal(findAuditViolation(['about:srcdoc'], origin), 'about:srcdoc');
      assert.equal(findAuditViolation(['about:blank/sub'], origin), 'about:blank/sub');

      // End-to-end player playback with permitted about:blank#fragment
      const { state: permittedState, runtime: permittedRuntime } = makeAuditedSessionDouble(baseUrl);
      permittedState.extraCommits = ['about:blank#ready'];
      await createOneStepAuditWorkflow('wf_audit_blank_frag', '/checkout');
      const permittedPlayer = new WorkflowPlayer({ repository: repo, browserRuntime: permittedRuntime, allowLocalhost: true });
      const permittedResult = await permittedPlayer.play('wf_audit_blank_frag', { coupon: 'TEST' });
      assert.equal(permittedResult.ok, true);
      assert.equal(permittedResult.status, 'success');
      await permittedPlayer.close();

      // End-to-end player playback with disallowed about:config
      const { state: disallowedState, runtime: disallowedRuntime } = makeAuditedSessionDouble(baseUrl);
      disallowedState.extraCommits = ['about:config'];
      await createOneStepAuditWorkflow('wf_audit_about_disallowed', '/checkout');
      const disallowedPlayer = new WorkflowPlayer({ repository: repo, browserRuntime: disallowedRuntime, allowLocalhost: true });
      const disallowedResult = await disallowedPlayer.play('wf_audit_about_disallowed', { coupon: 'TEST' });
      assert.equal(disallowedResult.ok, false);
      assert.equal(disallowedResult.status, 'failed');
      assert.ok(disallowedResult.error.includes('Post-execution audit'));
      await disallowedPlayer.close();
    });

    it('47c. bounds audit history to limit and deduplicates consecutive entries without suppressing distinct events (Fix 1)', () => {
      // 1. Enforces size limit and records truncation indicators
      const sink = [];
      for (let i = 0; i < 1050; i++) {
        recordAuditCommit(sink, `http://127.0.0.1:8080/page#frag${i}`, 'http://127.0.0.1:8080');
      }
      assert.equal(sink.length, COMMIT_AUDIT_HISTORY_LIMIT);
      assert.equal(sink.isTruncated, true);
      assert.equal(sink.truncated, true);
      assert.equal(sink.omittedCount, 50);
      assert.equal(sink.omittedEntries, 50);
      assert.equal(sink[sink.length - 1], 'http://127.0.0.1:8080/page#frag1049');
      assert.equal(sink.includes('http://127.0.0.1:8080/page#frag0'), false);

      // 2. Deduplicates consecutive duplicates without suppressing distinct entries sharing an origin
      const dupSink = [];
      recordAuditCommit(dupSink, 'http://127.0.0.1:8080/a');
      recordAuditCommit(dupSink, 'http://127.0.0.1:8080/a'); // consecutive duplicate
      recordAuditCommit(dupSink, 'http://127.0.0.1:8080/a'); // consecutive duplicate
      recordAuditCommit(dupSink, 'http://127.0.0.1:8080/b'); // distinct entry
      recordAuditCommit(dupSink, 'http://127.0.0.1:8080/b'); // consecutive duplicate
      recordAuditCommit(dupSink, 'http://127.0.0.1:8080/a'); // distinct navigation sharing origin
      assert.deepEqual(dupSink, [
        'http://127.0.0.1:8080/a',
        'http://127.0.0.1:8080/b',
        'http://127.0.0.1:8080/a',
      ]);
    });

    it('47d. preserves detected security violations when history limit is reached without erasing unsafe findings (Fix 1)', async () => {
      // 1. Benign eviction preserves earlier security violation
      const sink = [];
      recordAuditCommit(sink, 'http://127.0.0.1:8080/init', 'http://127.0.0.1:8080');
      recordAuditCommit(sink, 'http://127.0.0.2:9/evil', 'http://127.0.0.1:8080');
      for (let i = 0; i < 1100; i++) {
        recordAuditCommit(sink, `http://127.0.0.1:8080/page#frag${i}`, 'http://127.0.0.1:8080');
      }
      assert.equal(sink.length, COMMIT_AUDIT_HISTORY_LIMIT);
      assert.equal(sink.isTruncated, true);
      assert.equal(sink.includes('http://127.0.0.2:9/evil'), true);
      assert.equal(findAuditViolation(sink, 'http://127.0.0.1:8080'), 'http://127.0.0.2:9/evil');

      // 2. All-violations flood: earliest violation is preserved in retainedViolation
      const evilSink = [];
      for (let i = 0; i < 1050; i++) {
        recordAuditCommit(evilSink, `http://127.0.0.2:9/evil_${i}`, 'http://127.0.0.1:8080');
      }
      assert.equal(evilSink.length, COMMIT_AUDIT_HISTORY_LIMIT);
      assert.equal(evilSink.isTruncated, true);
      assert.equal(evilSink.retainedViolation, 'http://127.0.0.2:9/evil_0');
      assert.equal(findAuditViolation(evilSink, 'http://127.0.0.1:8080'), 'http://127.0.0.2:9/evil_0');

      // 3. End-to-end player execution with foreign commit followed by rapid fragment changes
      const { state, runtime } = makeAuditedSessionDouble(baseUrl);
      const extraCommits = ['http://127.0.0.2:9/evil'];
      for (let i = 0; i < 1050; i++) {
        extraCommits.push(`${baseUrl}/frag#${i}`);
      }
      state.extraCommits = extraCommits;
      await createOneStepAuditWorkflow('wf_audit_overflow_evil', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });
      const result = await player.play('wf_audit_overflow_evil', { coupon: 'TEST' });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('Post-execution audit'));
      assert.ok(result.error.includes('http://127.0.0.2:9/evil'));
      await player.close();
    });
  });

  describe('Subresource Observability (Phase A)', () => {
    // Session double that fires scripted subresource requests through the real
    // player route handler after each navigation. No browser is launched.
    function makeObservabilityDouble(targetOrigin) {
      const state = {
        currentUrl: `${targetOrigin}/`,
        sessionClosed: false,
        handler: null,
        subresources: [],
        subCalls: [],
      };
      const frameDouble = { page: () => pageDouble };
      const makeRoute = ({ url, resourceType, isMain }) => {
        const calls = [];
        return {
          calls,
          request: () => ({
            isNavigationRequest: () => isMain,
            frame: () => frameDouble,
            url: () => url,
            resourceType: () => resourceType,
          }),
          fetch: async () => {
            calls.push('fetch');
            return { status: () => 200, headers: () => ({}) };
          },
          fulfill: async () => {
            calls.push('fulfill');
          },
          abort: async () => {
            calls.push('abort');
          },
          continue: async () => {
            calls.push('continue');
          },
        };
      };
      const pageDouble = {
        url: () => state.currentUrl,
        title: async () => 'Double Title',
        isClosed: () => false,
        close: async () => {},
        mainFrame: () => frameDouble,
        waitForEvent: async () => {
          throw new Error('Timeout exceeded');
        },
      };
      const sessionDouble = {
        page: pageDouble,
        context: {
          pages: () => [pageDouble],
          route: async (pattern, handler) => {
            state.handler = handler;
          },
        },
        navigate: async (url) => {
          state.currentUrl = url;
          await state.handler(makeRoute({ url, resourceType: 'document', isMain: true }));
          for (const sub of state.subresources) {
            const route = makeRoute({ url: sub.url, resourceType: sub.resourceType, isMain: false });
            state.subCalls.push({ url: sub.url, calls: route.calls });
            await state.handler(route);
          }
          return { url, title: 'Double Title', status: 200, ok: true };
        },
        close: async () => {
          state.sessionClosed = true;
        },
      };
      return { state, runtime: { createSession: async () => sessionDouble, close: async () => {} } };
    }

    async function createOneStepObserveWorkflow(workflowId, startPath, stepPath, finalPath) {
      const params = {
        id: workflowId,
        name: workflowId,
        description: `Observability test workflow ${workflowId}`,
        target: { origin: baseUrl, startPath },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: [
          {
            id: 'step_nav',
            order: 1,
            description: 'Navigate to fixture',
            action: 'navigate',
            params: { path: stepPath },
            anchor: null,
            verification: null,
          },
        ],
        successCriteria: { finalPath },
      };
      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified(workflowId, 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId,
        version: 1,
        contentHash: hash,
        runId: 'run_init_observe',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [{ stepId: 'step_nav', action: 'navigate', ok: true, durationMs: 10, verification: null }],
        successCriteriaResult: { passed: true },
      });
    }

    function findPair(report, origin, resourceType) {
      return (report.pairs || []).find((p) => p.origin === origin && p.resourceType === resourceType);
    }

    it('48. records cross-origin subresources with origin, type, and count', async () => {
      const { state, runtime } = makeObservabilityDouble(baseUrl);
      state.subresources = [
        { url: 'https://tracker.example/collect?tok=SECRET&x=1#frag', resourceType: 'script' },
        { url: 'https://tracker.example/collect?tok=SECRET&x=1#frag', resourceType: 'script' },
        { url: 'https://cdn.example/lib.js', resourceType: 'script' },
      ];
      await createOneStepObserveWorkflow('wf_observe_record', '/', '/checkout', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_observe_record', { coupon: 'TEST' });

      assert.equal(result.ok, true);
      assert.ok(result.subresourceReport, 'run result must carry a subresource report');
      // Initial navigation plus one step navigation each fire the full set.
      assert.equal(findPair(result.subresourceReport, 'https://tracker.example', 'script').count, 4);
      assert.equal(findPair(result.subresourceReport, 'https://cdn.example', 'script').count, 2);
      assert.equal(result.subresourceReport.observedEvents, 6);
      assert.equal(result.subresourceReport.omittedEvents, 0);
      const reportJson = JSON.stringify(result.subresourceReport);
      assert.equal(reportJson.includes('tok='), false);
      assert.equal(reportJson.includes('SECRET'), false);
      assert.equal(reportJson.includes('/collect'), false);
      assert.equal(reportJson.includes('#frag'), false);
      await player.close();
    });

    it('49. excludes same-origin subresources from the report', async () => {
      const { state, runtime } = makeObservabilityDouble(baseUrl);
      state.subresources = [
        { url: `${baseUrl}/app.js?build=1`, resourceType: 'script' },
        { url: 'https://tracker.example/pixel', resourceType: 'image' },
      ];
      await createOneStepObserveWorkflow('wf_observe_same', '/', '/checkout', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_observe_same', { coupon: 'TEST' });

      assert.equal(result.ok, true);
      assert.ok(result.subresourceReport, 'run result must carry a subresource report');
      assert.equal(result.subresourceReport.pairs.length, 1);
      assert.ok(findPair(result.subresourceReport, 'https://tracker.example', 'image'));
      assert.equal(result.subresourceReport.observedEvents, 2);
      await player.close();
    });

    it('50. excludes main-frame navigations from the subresource report', async () => {
      const { state, runtime } = makeObservabilityDouble(baseUrl);
      await createOneStepObserveWorkflow('wf_observe_main', '/', '/checkout', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_observe_main', { coupon: 'TEST' });

      assert.equal(result.ok, true);
      assert.ok(result.subresourceReport, 'run result must carry a subresource report');
      assert.deepEqual(result.subresourceReport.pairs, []);
      assert.equal(result.subresourceReport.observedEvents, 0);
      assert.equal(result.subresourceReport.omittedEvents, 0);
      await player.close();
    });

    it('51. strips credentials, paths, queries, and fragments from recorded origins', async () => {
      const { state, runtime } = makeObservabilityDouble(baseUrl);
      state.subresources = [
        { url: 'https://user:pass@cdn.example:8443/lib.js?tok=SECRET#frag', resourceType: 'script' },
      ];
      await createOneStepObserveWorkflow('wf_observe_sanitize', '/', '/checkout', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_observe_sanitize', { coupon: 'TEST' });

      assert.equal(result.ok, true);
      assert.ok(result.subresourceReport, 'run result must carry a subresource report');
      assert.ok(findPair(result.subresourceReport, 'https://cdn.example:8443', 'script'));
      const reportJson = JSON.stringify(result.subresourceReport);
      for (const leaked of ['user', 'pass', 'lib.js', 'tok=', 'SECRET', '#frag']) {
        assert.equal(reportJson.includes(leaked), false, `report must not contain "${leaked}"`);
      }
      await player.close();
    });

    it('52. redacts supplied input values that collide with recorded origins', async () => {
      const { state, runtime } = makeObservabilityDouble(baseUrl);
      state.subresources = [
        { url: 'https://cdn-redact.example/a.js', resourceType: 'script' },
        { url: 'https://other.example/b.js', resourceType: 'script' },
      ];
      await createOneStepObserveWorkflow('wf_observe_redact', '/', '/checkout', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_observe_redact', { coupon: 'cdn-redact.example' });

      assert.equal(result.ok, true);
      assert.ok(result.subresourceReport, 'run result must carry a subresource report');
      const reportJson = JSON.stringify(result.subresourceReport);
      assert.equal(reportJson.includes('cdn-redact.example'), false, 'colliding input value must be redacted');
      assert.ok(reportJson.includes('[REDACTED]'));
      assert.ok(findPair(result.subresourceReport, 'https://other.example', 'script'));
      await player.close();
    });

    it('53. bounds recorded pairs and reports omitted events without storing URLs', async () => {
      const { state, runtime } = makeObservabilityDouble(baseUrl);
      for (let i = 0; i < 105; i++) {
        state.subresources.push({ url: `http://host${i}.example/marker-path`, resourceType: 'fetch' });
      }
      await createOneStepObserveWorkflow('wf_observe_limit', '/', '/checkout', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_observe_limit', { coupon: 'TEST' });

      assert.equal(result.ok, true);
      assert.ok(result.subresourceReport, 'run result must carry a subresource report');
      assert.equal(result.subresourceReport.pairs.length, 100);
      assert.equal(result.subresourceReport.observedEvents, 210);
      assert.equal(result.subresourceReport.omittedEvents, 10);
      const retained = result.subresourceReport.pairs.reduce((sum, p) => sum + p.count, 0);
      assert.equal(retained + result.subresourceReport.omittedEvents, result.subresourceReport.observedEvents);
      assert.equal(JSON.stringify(result.subresourceReport).includes('marker-path'), false);
      await player.close();
    });

    it('54. leaves allow behavior unchanged: every observed subresource is continued', async () => {
      const { state, runtime } = makeObservabilityDouble(baseUrl);
      state.subresources = [
        { url: 'https://tracker.example/a.js', resourceType: 'script' },
        { url: 'https://api.example/submit', resourceType: 'fetch' },
        { url: 'https://img.example/pixel', resourceType: 'image' },
      ];
      await createOneStepObserveWorkflow('wf_observe_allow', '/', '/checkout', '/checkout');
      const player = new WorkflowPlayer({ repository: repo, browserRuntime: runtime, allowLocalhost: true });

      const result = await player.play('wf_observe_allow', { coupon: 'TEST' });

      assert.equal(result.ok, true);
      assert.equal(state.subCalls.length, 6);
      for (const entry of state.subCalls) {
        assert.deepEqual(entry.calls, ['continue'], `subresource ${entry.url} must be continued exactly once`);
      }
      await player.close();
    });

    it('55. records a real cross-origin image load end to end without failing the run', async () => {
      await createOneStepObserveWorkflow('wf_observe_live', '/with-tracker', '/', '/');
      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const result = await player.play('wf_observe_live', { coupon: 'TEST' });

      assert.equal(result.ok, true);
      assert.ok(result.subresourceReport, 'run result must carry a subresource report');
      const pair = findPair(result.subresourceReport, 'http://127.0.0.2:9', 'image');
      assert.ok(pair, 'cross-origin image request must be recorded');
      assert.ok(pair.count >= 1);
      assert.equal(JSON.stringify(result.subresourceReport).includes('?x='), false);
    });
  });

  describe('Resource Lifecycle, Concurrency & Immutability', () => {
    it('19. cleans up browser session on both success and failure', async () => {
      await createVerifiedTestWorkflow('wf_cleanup_test');
      const initialActiveCount = sharedRuntime.activeSessions.size;

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      // 1. Success run
      await player.play('wf_cleanup_test', { coupon: 'TEST' });
      assert.equal(sharedRuntime.activeSessions.size, initialActiveCount, 'Session must be closed after success');

      // 2. Failure run
      await player.play('wf_cleanup_test', { coupon: 'TEST', note: 'fail' }, { stepTimeoutMs: 1 });
      assert.equal(sharedRuntime.activeSessions.size, initialActiveCount, 'Session must be closed after failure');
    });

    it('20. preserves shared BrowserRuntime on player.close() but closes internally owned runtime', async () => {
      // 1. Shared runtime: player.close() should NOT close sharedRuntime
      const playerWithShared = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });
      await playerWithShared.close();
      assert.equal(sharedRuntime.isClosed, false, 'Shared runtime must remain open');

      // 2. Owned runtime: player.close() closes internal runtime
      const playerWithOwned = new WorkflowPlayer({
        repository: repo,
        allowLocalhost: true,
      });
      await playerWithOwned.close();
      assert.equal(playerWithOwned._isClosed, true);
    });

    it('21. executes concurrent workflow playback runs with isolated sessions', async () => {
      await createVerifiedTestWorkflow('wf_concurrent_1');
      await createVerifiedTestWorkflow('wf_concurrent_2');

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      const [res1, res2] = await Promise.all([
        player.play('wf_concurrent_1', { coupon: 'COUPON1' }),
        player.play('wf_concurrent_2', { coupon: 'COUPON2' }),
      ]);

      assert.equal(res1.ok, true);
      assert.equal(res2.ok, true);
      assert.notEqual(res1.runId, res2.runId);
      assert.equal(res1.workflowId, 'wf_concurrent_1');
      assert.equal(res2.workflowId, 'wf_concurrent_2');
    });

    it('22. guarantees workflow records and content hashes remain unchanged after playback', async () => {
      const initialVersion = await createVerifiedTestWorkflow('wf_immutability_test');
      const initialHash = calculateContentHash(initialVersion);

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      await player.play('wf_immutability_test', { coupon: 'SAVE50' });

      // Inspect persisted version record and manifest after playback
      const postVersion = await repo.getVersion('wf_immutability_test', 1);
      const postHash = calculateContentHash(postVersion);
      const postManifest = await repo.getManifest('wf_immutability_test');

      assert.equal(postHash, initialHash, 'Canonical content hash must be completely identical');
      assert.deepEqual(postVersion, initialVersion, 'Version file on disk must not have been modified');
      assert.equal(postManifest.activeVersion, 1);
      assert.equal(postManifest.draftVersion, null);
    });

    it('23. functional playWorkflow() helper executes cleanly and disposes resources', async () => {
      await createVerifiedTestWorkflow('wf_helper_test');

      const result = await playWorkflow(
        'wf_helper_test',
        { coupon: 'HELPER10' },
        { repository: repo, allowLocalhost: true }
      );

      assert.equal(result.ok, true);
      assert.equal(result.status, 'success');
      assert.equal(result.workflowId, 'wf_helper_test');
    });
  });
});
