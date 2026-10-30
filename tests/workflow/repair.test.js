/**
 * Super Memory — Workflow Repair & Failure Diagnostics Tests
 *
 * Validates Phase 3C failure detection, sanitized failure diagnostics,
 * strict repair proposal validation, safe draft version branching,
 * and end-to-end lifecycle verification against local HTTP fixtures.
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
  collectFailureDiagnostic,
  categorizeFailure,
  sanitizeSnapshot,
  sanitizeAndRedactUrl,
  redactSecrets,
  validateRepairProposal,
  applyRepairProposal,
  applyRepairToDraft,
  buildRepairPrompt,
  parseRepairResponse,
  generateRepairProposal,
  RepairProposalError,
} from '../../src/workflow/index.js';

import { createBrowserRuntime } from '../../src/browser/index.js';

describe('Workflow Failure Diagnostics & Repair Flow', () => {
  let fixtureServer;
  let baseUrl;
  let tempBaseDir;
  let repo;
  let sharedRuntime;
  let buttonLabel = 'Submit Order';

  before(async () => {
    fixtureServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Store Home</title></head>
<body>
  <h1>Welcome to Store</h1>
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
  <h1>Order Summary</h1>
  <label for="coupon-code">Coupon Code</label>
  <input type="text" id="coupon-code" name="coupon" />
  <button id="order-btn">${buttonLabel}</button>
  <a href="/">Back to Store</a>
</body>
</html>`);
        return;
      }

      if (url.pathname === '/success') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Thank You</title></head>
<body><h1>Order Confirmed</h1></body>
</html>`);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>');
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
    buttonLabel = 'Submit Order';
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-repair-test-'));
    repo = new FileSystemWorkflowRepository({ baseDir: tempBaseDir });
    await repo.init();
  });

  afterEach(async () => {
    if (tempBaseDir) {
      await fs.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // =========================================================================
  // 1. Failure Diagnostics & Categorization
  // =========================================================================
  describe('Deterministic Failure Diagnostics', () => {
    it('categorizes missing locator elements as ELEMENT_NOT_FOUND', () => {
      const category = categorizeFailure({
        error: new Error('Action failed: waiting for getByRole("button", { name: "Submit" }) timed out after 5000ms'),
        step: { action: 'clickByRole' },
        snapshot: { elements: [{ tag: 'button', role: 'button', name: 'Place Order' }] },
      });
      assert.equal(category, 'ELEMENT_NOT_FOUND');
    });

    it('categorizes navigation failures and 404 responses as NAVIGATION_ERROR', () => {
      const category = categorizeFailure({
        error: new Error('Navigation step failed with HTTP status 404.'),
        step: { action: 'navigate' },
      });
      assert.equal(category, 'NAVIGATION_ERROR');
    });

    it('categorizes predicate verification failures as VERIFICATION_FAILED', () => {
      const category = categorizeFailure({
        error: new Error('Step verification predicate failed: expected pageTitle "Welcome".'),
        step: { action: 'clickByRole', verification: { type: 'pageTitle', expected: 'Welcome' } },
        verification: { passed: false, type: 'pageTitle' },
      });
      assert.equal(category, 'VERIFICATION_FAILED');
    });

    it('action timeout with step verification defined is categorized as ELEMENT_NOT_FOUND, not VERIFICATION_FAILED', () => {
      const category = categorizeFailure({
        error: new Error('Action failed: waiting for getByRole("button", { name: "Submit" }) timed out after 5000ms'),
        step: { action: 'clickByRole', verification: { type: 'pageTitle', expected: 'Welcome' } },
        verification: null, // Verification was never reached because the action failed first
      });
      assert.equal(category, 'ELEMENT_NOT_FOUND');
    });

    it('categorizes cross-origin escapes as CONFINEMENT_VIOLATION', () => {
      const category = categorizeFailure({
        error: new Error('Cross-origin navigation rejected: destination "http://evil.com" does not match declared target origin.'),
        confinementViolation: true,
      });
      assert.equal(category, 'CONFINEMENT_VIOLATION');
    });

    it('categorizes success criteria mismatch as SUCCESS_CRITERIA_FAILED', () => {
      const category = categorizeFailure({
        error: new Error('Workflow completed all steps but success criteria were not satisfied.'),
        successCriteriaResult: { passed: false, finalPathMatched: false },
      });
      assert.equal(category, 'SUCCESS_CRITERIA_FAILED');
    });

    it('sanitizeAndRedactUrl redacts secrets embedded in URL pathnames (e.g. /promo/SAVE10/applied)', () => {
      const url = 'http://127.0.0.1:8080/promo/SAVE10/applied?utm_source=email#discount';
      const clean = sanitizeAndRedactUrl(url, ['SAVE10']);
      assert.equal(clean, 'http://127.0.0.1:8080/promo/[REDACTED]/applied');
      assert(!clean.includes('SAVE10'));
      assert(!clean.includes('utm_source'));
      assert(!clean.includes('discount'));
    });

    it('sanitizeAndRedactUrl redacts generic credential-bearing path segments and tokens', () => {
      const tokenUrl = 'http://127.0.0.1:8080/api/tokens/xyz9876543210token/status';
      assert.equal(sanitizeAndRedactUrl(tokenUrl), 'http://127.0.0.1:8080/api/tokens/[REDACTED]/status');

      const secretUrl = 'http://127.0.0.1:8080/auth/session/sess_abcdef123456';
      assert.equal(sanitizeAndRedactUrl(secretUrl), 'http://127.0.0.1:8080/auth/session/[REDACTED]');
    });

    it('sanitizes and bounds snapshot elements and redacts secrets from URL, text, and href independently', () => {
      const rawSnapshot = {
        url: 'http://127.0.0.1:8080/promo/SAVE10/applied?token=super_secret_token_123#frag',
        title: 'Checkout secret_discount',
        text: 'Welcome secret_discount user. Token: super_secret_token_123',
        elements: [
          { tag: 'input', role: 'textbox', name: 'secret_discount code', type: 'text' },
          { tag: 'input', role: 'textbox', name: 'User Password', type: 'password' },
          { tag: 'a', role: 'link', name: 'Apply Coupon', href: 'http://127.0.0.1:8080/promo/SAVE10/details?token=123' },
        ],
      };

      const sanitized = sanitizeSnapshot(rawSnapshot, ['secret_discount', 'super_secret_token_123', 'SAVE10']);
      assert.equal(sanitized.url, 'http://127.0.0.1:8080/promo/[REDACTED]/applied');
      assert.equal(sanitized.title.includes('secret_discount'), false);
      assert.equal(sanitized.text.includes('secret_discount'), false);
      assert.equal(sanitized.text.includes('super_secret_token_123'), false);
      assert.equal(sanitized.elements[0].name.includes('secret_discount'), false);
      assert.equal(sanitized.elements[1].type, '[REDACTED]');
      assert.equal(sanitized.elements[2].href, 'http://127.0.0.1:8080/promo/[REDACTED]/details');
    });

    it('collectFailureDiagnostic produces a complete sanitized record from active session', async () => {
      const session = await sharedRuntime.createSession({ allowLocalhost: true });
      try {
        await session.navigate(`${baseUrl}/checkout`);
        const diag = await collectFailureDiagnostic({
          workflowId: 'wf_diag_test',
          version: 1,
          error: 'Action failed: waiting for getByRole("button", { name: "Nonexistent" })',
          failedStep: {
            id: 'step_1',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Nonexistent', exact: true },
          },
          session,
          secrets: ['SECRET_VAL'],
        });

        assert.equal(diag.workflowId, 'wf_diag_test');
        assert.equal(diag.version, 1);
        assert.equal(diag.category, 'ELEMENT_NOT_FOUND');
        assert.equal(diag.failedStep.id, 'step_1');
        assert.equal(diag.failedStep.expected.name, 'Nonexistent');
        assert.equal(diag.page.url, `${baseUrl}/checkout`);
        assert.equal(diag.page.title, 'Checkout Page');
        assert.ok(Array.isArray(diag.page.snapshot.elements));
        assert.ok(diag.page.snapshot.elements.some((el) => el.name === 'Submit Order'));
      } finally {
        await session.close();
      }
    });

    it('redacts secret-bearing workflow step ID in diagnostic and repair prompt', async () => {
      const secret = 'sk_live_abc123xyz456';
      const secretStepId = `enter-key-${secret}`;

      const diag = await collectFailureDiagnostic({
        workflowId: 'wf_step_id_secret_test',
        version: 1,
        error: 'Action timed out waiting for input',
        failedStep: {
          id: secretStepId,
          order: 1,
          action: 'fillByLabel',
          description: 'Enter secret API key',
          expected: { label: 'API Key', inputName: 'apiKey' },
        },
        session: null,
        secrets: [secret],
      });

      // 1. Check returned diagnostic record
      assert.equal(diag.failedStep.id, 'enter-key-[REDACTED]');
      assert(!diag.failedStep.id.includes(secret));
      const serializedDiag = JSON.stringify(diag);
      assert(!serializedDiag.includes(secret));

      // 2. Check generated repair prompt
      const prompt = buildRepairPrompt(diag, {
        workflowId: 'wf_step_id_secret_test',
        version: 1,
        steps: [{ id: secretStepId, order: 1, action: 'fillByLabel' }],
      });
      const promptString = JSON.stringify(prompt);
      assert(!promptString.includes(secret));
      assert(promptString.includes('enter-key-[REDACTED]'));

      // 3. Normal step ID without secrets is preserved
      const normalDiag = await collectFailureDiagnostic({
        workflowId: 'wf_normal_step_id',
        version: 1,
        error: 'Failed to click button',
        failedStep: {
          id: 'step_click_checkout',
          order: 1,
          action: 'clickByRole',
          description: 'Click button',
          expected: { role: 'button', name: 'Checkout' },
        },
        session: null,
        secrets: [secret],
      });
      assert.equal(normalDiag.failedStep.id, 'step_click_checkout');
    });
  });

  // =========================================================================
  // 2. Repair Proposal Schema & Validation
  // =========================================================================
  describe('Repair Proposal Validation', () => {
    const dummyVersion = {
      workflowId: 'wf_repair_rules',
      version: 1,
      inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
      steps: [
        {
          id: 'step_click',
          order: 1,
          description: 'Click submit',
          action: 'clickByRole',
          params: { role: 'button', name: 'Old Submit' },
          anchor: null,
          verification: null,
        },
      ],
      target: { origin: 'http://127.0.0.1:8080', startPath: '/' },
      successCriteria: { finalPath: '/' },
    };

    it('accepts a valid repair proposal updating an accessible button name', () => {
      const proposal = {
        workflowId: 'wf_repair_rules',
        targetVersion: 1,
        stepId: 'step_click',
        suspectedCause: 'Button accessible name changed from Old Submit to Place Order.',
        evidence: 'DOM snapshot shows <button> with name "Place Order".',
        proposedChange: {
          action: 'clickByRole',
          description: 'Click Place Order button',
          params: { role: 'button', name: 'Place Order', exact: true },
        },
        expectedOutcome: 'Step succeeds by locating the renamed button.',
        uncertainty: 'None; high confidence from exact tag and role match.',
      };

      const result = validateRepairProposal(proposal, dummyVersion);
      assert.equal(result.valid, true);
    });

    it('rejects proposal targeting mismatched workflowId or version', () => {
      const proposal = {
        workflowId: 'other_wf',
        targetVersion: 1,
        stepId: 'step_click',
        suspectedCause: 'cause',
        evidence: 'evidence',
        proposedChange: { action: 'clickByRole', params: { role: 'button', name: 'New' } },
        expectedOutcome: 'outcome',
        uncertainty: 'none',
      };
      assert.throws(() => validateRepairProposal(proposal, dummyVersion), RepairProposalError);

      proposal.workflowId = 'wf_repair_rules';
      proposal.targetVersion = 99;
      assert.throws(() => validateRepairProposal(proposal, dummyVersion), RepairProposalError);
    });

    it('rejects proposal referencing a nonexistent stepId', () => {
      const proposal = {
        workflowId: 'wf_repair_rules',
        targetVersion: 1,
        stepId: 'nonexistent_step',
        suspectedCause: 'cause',
        evidence: 'evidence',
        proposedChange: { action: 'clickByRole', params: { role: 'button', name: 'New' } },
        expectedOutcome: 'outcome',
        uncertainty: 'none',
      };
      assert.throws(() => validateRepairProposal(proposal, dummyVersion), (err) => {
        assert(err instanceof RepairProposalError);
        assert(err.message.includes('nonexistent_step'));
        return true;
      });
    });

    it('rejects proposal with unsupported actions or code execution attempts', () => {
      const proposal = {
        workflowId: 'wf_repair_rules',
        targetVersion: 1,
        stepId: 'step_click',
        suspectedCause: 'cause',
        evidence: 'evidence',
        proposedChange: { action: 'evalCode', params: { code: 'alert(1)' } },
        expectedOutcome: 'outcome',
        uncertainty: 'none',
      };
      assert.throws(() => validateRepairProposal(proposal, dummyVersion), RepairProposalError);
    });

    it('rejects proposal attempting to persist a value on fillByLabel', () => {
      const proposal = {
        workflowId: 'wf_repair_rules',
        targetVersion: 1,
        stepId: 'step_click',
        suspectedCause: 'cause',
        evidence: 'evidence',
        proposedChange: {
          action: 'fillByLabel',
          params: { label: 'Coupon', inputName: 'coupon', value: 'LEAKED_SECRET' },
        },
        expectedOutcome: 'outcome',
        uncertainty: 'none',
      };
      assert.throws(() => validateRepairProposal(proposal, dummyVersion), (err) => {
        assert(err instanceof RepairProposalError);
        assert(err.message.includes('must not contain a "value" property'));
        return true;
      });
    });

    it('rejects proposal targeting password fields or modifying origin', () => {
      const proposal = {
        workflowId: 'wf_repair_rules',
        targetVersion: 1,
        stepId: 'step_click',
        suspectedCause: 'cause',
        evidence: 'evidence',
        proposedChange: {
          action: 'clickByRole',
          params: { role: 'button', name: 'Submit' },
          anchor: { type: 'password' },
        },
        expectedOutcome: 'outcome',
        uncertainty: 'none',
      };
      assert.throws(() => validateRepairProposal(proposal, dummyVersion), (err) => {
        assert(err instanceof RepairProposalError);
        assert(err.message.includes('password'));
        return true;
      });

      // Modifying target origin attempt
      proposal.proposedChange.anchor = null;
      proposal.proposedChange.target = { origin: 'http://evil.com' };
      assert.throws(() => validateRepairProposal(proposal, dummyVersion), RepairProposalError);
    });
  });

  // =========================================================================
  // 3. Model Generation & Response Parsing
  // =========================================================================
  describe('Repair Proposal Grounding Gate', () => {
    const groundedVersion = {
      workflowId: 'wf_grounding',
      version: 1,
      inputs: [{ name: 'book_title', type: 'string', label: 'Book title', required: true }],
      steps: [
        {
          id: 'step_find',
          order: 1,
          description: 'Click find',
          action: 'clickByRole',
          params: { role: 'button', name: 'Find books' },
          anchor: null,
          verification: null,
        },
      ],
      target: { origin: 'http://127.0.0.1:8081', startPath: '/catalog' },
      successCriteria: { finalPath: '/basket' },
    };

    function makeDiagnostic(elements, url = 'http://127.0.0.1:8081/catalog') {
      return {
        workflowId: 'wf_grounding',
        version: 1,
        category: 'ELEMENT_NOT_FOUND',
        error: 'clickByRole timed out',
        failedStep: { id: 'step_find', action: 'clickByRole' },
        page: {
          url,
          title: 'City Books Catalog',
          snapshot: { url, title: 'City Books Catalog', text: 'City Books Catalog', elements },
        },
      };
    }

    function makeProposal(params, action = 'clickByRole') {
      return {
        workflowId: 'wf_grounding',
        targetVersion: 1,
        stepId: 'step_find',
        suspectedCause: 'Control changed',
        evidence: 'Observed in snapshot',
        proposedChange: { action, description: 'Updated step', params },
        expectedOutcome: 'Step succeeds',
        uncertainty: 'none',
      };
    }

    const catalogElements = [
      { tag: 'input', role: 'textbox', name: '', type: 'text', label: 'Book title', disabled: false },
      { tag: 'button', role: 'button', name: 'Search catalog', type: 'submit', label: null, disabled: false },
    ];

    it('grounds a clickByRole proposal in the exact observed role and name', async () => {
      const { validateRepairProposalGrounding } = await import('../../src/workflow/repair.js');
      const proposal = makeProposal({ role: 'button', name: 'Search catalog', exact: false });
      assert.equal(
        validateRepairProposalGrounding(proposal, makeDiagnostic(catalogElements), groundedVersion).valid,
        true
      );
    });

    it('rejects an ungrounded clickByRole proposal before any draft', async () => {
      const { validateRepairProposalGrounding } = await import('../../src/workflow/repair.js');
      const proposal = makeProposal({ role: 'button', name: 'Find books', exact: false });
      assert.throws(
        () => validateRepairProposalGrounding(proposal, makeDiagnostic(catalogElements), groundedVersion),
        (err) => err instanceof RepairProposalError && /was not observed on the current page/.test(err.message)
      );
    });

    it('does not ground on a substring of an observed name or on page text', async () => {
      const { validateRepairProposalGrounding } = await import('../../src/workflow/repair.js');
      const proposal = makeProposal({ role: 'button', name: 'Search', exact: false });
      assert.throws(
        () => validateRepairProposalGrounding(proposal, makeDiagnostic(catalogElements), groundedVersion),
        RepairProposalError
      );
    });

    it('rejects a target observed only on a disabled element', async () => {
      const { validateRepairProposalGrounding } = await import('../../src/workflow/repair.js');
      const disabled = catalogElements.map((el) => ({ ...el, disabled: true }));
      const proposal = makeProposal({ role: 'button', name: 'Search catalog', exact: false });
      assert.throws(
        () => validateRepairProposalGrounding(proposal, makeDiagnostic(disabled), groundedVersion),
        RepairProposalError
      );
    });

    it('grounds a fillByLabel proposal in the exact observed label', async () => {
      const { validateRepairProposalGrounding } = await import('../../src/workflow/repair.js');
      const proposal = makeProposal({ label: 'Book title', inputName: 'book_title', exact: false }, 'fillByLabel');
      assert.equal(
        validateRepairProposalGrounding(proposal, makeDiagnostic(catalogElements), groundedVersion).valid,
        true
      );
    });

    it('rejects an unobserved fillByLabel label', async () => {
      const { validateRepairProposalGrounding } = await import('../../src/workflow/repair.js');
      const proposal = makeProposal({ label: 'Title', inputName: 'book_title', exact: false }, 'fillByLabel');
      assert.throws(
        () => validateRepairProposalGrounding(proposal, makeDiagnostic(catalogElements), groundedVersion),
        RepairProposalError
      );
    });

    it('rejects grounding against a snapshot from a different origin', async () => {
      const { validateRepairProposalGrounding } = await import('../../src/workflow/repair.js');
      const proposal = makeProposal({ role: 'button', name: 'Search catalog', exact: false });
      assert.throws(
        () =>
          validateRepairProposalGrounding(
            proposal,
            makeDiagnostic(catalogElements, 'http://127.0.0.1:9999/catalog'),
            groundedVersion
          ),
        /not on the workflow target origin/
      );
    });

    it('generateRepairProposal rejects an ungrounded model proposal end-to-end', async () => {
      const provider = {
        complete: async () => ({
          text: JSON.stringify(makeProposal({ role: 'button', name: 'Find books', exact: false })),
          usage: { totalTokens: 5 },
          provider: 'mock',
          model: 'mock-1',
        }),
      };
      await assert.rejects(
        () => generateRepairProposal(provider, makeDiagnostic(catalogElements), groundedVersion),
        (err) => err instanceof RepairProposalError && /was not observed/.test(err.message)
      );
    });
  });

  describe('Model Proposal Generation & Parsing', () => {
    it('parses JSON wrapped in markdown code blocks or with surrounding text', () => {
      const rawWithFences = '```json\n{"hello": "world"}\n```';
      assert.deepEqual(parseRepairResponse(rawWithFences), { hello: 'world' });

      const rawWithPreamble = 'Here is the proposed repair:\n{"hello": "world"}\nHope this helps!';
      assert.deepEqual(parseRepairResponse(rawWithPreamble), { hello: 'world' });

      assert.throws(() => parseRepairResponse('Not json at all'), RepairProposalError);
      assert.throws(() => parseRepairResponse(''), RepairProposalError);
    });

    it('generateRepairProposal completes prompt, parses, and validates proposal with mock provider', async () => {
      const dummyVersion = {
        workflowId: 'wf_mock_model',
        version: 1,
        inputs: [],
        steps: [
          {
            id: 'step_1',
            order: 1,
            description: 'Click button',
            action: 'clickByRole',
            params: { role: 'button', name: 'Old' },
            anchor: null,
            verification: null,
          },
        ],
      };

      const mockProvider = {
        provider: 'mock',
        modelId: 'mock-model-1',
        complete: async () => ({
          text: JSON.stringify({
            workflowId: 'wf_mock_model',
            targetVersion: 1,
            stepId: 'step_1',
            suspectedCause: 'Button renamed in updated UI',
            evidence: 'Button with name "New Label" found in snapshot',
            proposedChange: {
              action: 'clickByRole',
              description: 'Click New Label button',
              params: { role: 'button', name: 'New Label', exact: true },
            },
            expectedOutcome: 'Click will find the new button',
            uncertainty: 'Low uncertainty',
          }),
          provider: 'mock',
          model: 'mock-model-1',
          finishReason: 'stop',
          isTruncated: false,
          usage: { inputTokens: 50, outputTokens: 60, totalTokens: 110 },
        }),
      };

      const diag = {
        workflowId: 'wf_mock_model',
        version: 1,
        category: 'ELEMENT_NOT_FOUND',
        error: 'Element not found',
        failedStep: dummyVersion.steps[0],
        page: {
          url: 'http://127.0.0.1:8080/checkout',
          title: 'Test',
          snapshot: {
            url: 'http://127.0.0.1:8080/checkout',
            title: 'Test',
            text: 'Checkout',
            elements: [{ tag: 'button', role: 'button', name: 'New Label', type: 'submit', disabled: false }],
          },
        },
      };

      const result = await generateRepairProposal(mockProvider, diag, dummyVersion);
      assert.equal(result.proposal.workflowId, 'wf_mock_model');
      assert.equal(result.proposal.proposedChange.params.name, 'New Label');
      assert.equal(result.provider, 'mock');
      assert.equal(result.usage.totalTokens, 110);
    });
  });

  // =========================================================================
  // 4. End-to-End Workflow Failure, Diagnosis, Repair & Promotion Scenario
  // =========================================================================
  describe('End-to-End Workflow Repair Lifecycle Scenario', () => {
    async function createCheckoutWorkflow(workflowId, expectedButton) {
      const params = {
        id: workflowId,
        name: 'Checkout Flow',
        description: 'Navigates to checkout and clicks order button',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [{ name: 'coupon', type: 'string', label: 'Coupon', required: true }],
        steps: [
          {
            id: 'step_click_order',
            order: 1,
            description: 'Click place order button',
            action: 'clickByRole',
            params: { role: 'button', name: expectedButton, exact: true, timeoutMs: 1500 },
            anchor: null,
            verification: null,
          },
        ],
        successCriteria: { finalPath: '/checkout' },
      };

      const { version } = await repo.createWorkflow(params);
      const hash = calculateContentHash(version);
      await repo.markVerified(workflowId, 1, {
        $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
        schemaVersion: '1.0.0',
        workflowId,
        version: 1,
        contentHash: hash,
        runId: 'run_init_repair_test',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
          playwrightVersion: '1.64.1',
          nodeVersion: 'v22.19.0',
          platform: 'darwin-arm64',
        },
        stepResults: [
          { stepId: 'step_click_order', action: 'clickByRole', ok: true, durationMs: 10, verification: null },
        ],
        successCriteriaResult: { passed: true },
      });
      return version;
    }

    it('end-to-end: failure diagnosis -> repair proposal -> unapproved draft -> test fixture -> verified promotion', async () => {
      const workflowId = 'wf_e2e_repair';
      const secret = 'MY_CONFIDENTIAL_COUPON_123';

      // 1. Initial workflow expects "Submit Order". Page has "Submit Order".
      const version1 = await createCheckoutWorkflow(workflowId, 'Submit Order');

      const player = new WorkflowPlayer({
        repository: repo,
        browserRuntime: sharedRuntime,
        allowLocalhost: true,
      });

      // Initially succeeds
      const initialRun = await player.play(workflowId, { coupon: secret });
      assert.equal(initialRun.ok, true);
      assert.equal(initialRun.status, 'success');
      assert.equal(initialRun.diagnostic, null);

      // 2. Page UI changes: button renamed from "Submit Order" to "Place Order"
      buttonLabel = 'Place Order';

      // 3. Re-running active Version 1 now fails because "Submit Order" button is gone
      const failedRun = await player.play(workflowId, { coupon: secret });
      assert.equal(failedRun.ok, false);
      assert.equal(failedRun.status, 'failed');
      assert.ok(failedRun.diagnostic, 'Failure diagnostic must be collected');

      // 4. Verify diagnostic quality and secret hygiene
      const diag = failedRun.diagnostic;
      assert.equal(diag.workflowId, workflowId);
      assert.equal(diag.version, 1);
      assert.equal(diag.category, 'ELEMENT_NOT_FOUND');
      assert.equal(diag.failedStep.id, 'step_click_order');
      assert.equal(diag.failedStep.expected.name, 'Submit Order');
      assert.equal(diag.page.url, `${baseUrl}/checkout`);
      assert.equal(diag.page.title, 'Checkout Page');

      // Snapshot elements should reveal the renamed button
      assert.ok(Array.isArray(diag.page.snapshot.elements));
      const placeOrderButton = diag.page.snapshot.elements.find((el) => el.name === 'Place Order');
      assert.ok(placeOrderButton, 'Snapshot must contain the newly renamed Place Order button');

      // Secrets must never appear in diagnostic records
      const diagJson = JSON.stringify(diag);
      assert.equal(diagJson.includes(secret), false, 'Secret must not appear in diagnostic');
      assert.equal(diagJson.includes(secret.toLowerCase()), false);

      // 5. Mock model generates repair proposal based on observed "Place Order" element
      const mockModelProvider = {
        provider: 'mock-llm',
        modelId: 'mock-repair-model',
        complete: async () => ({
          text: JSON.stringify({
            workflowId,
            targetVersion: 1,
            stepId: 'step_click_order',
            suspectedCause: 'Button text was renamed from "Submit Order" to "Place Order".',
            evidence: 'Page snapshot interactive elements list includes button with name "Place Order".',
            proposedChange: {
              action: 'clickByRole',
              description: 'Click place order button',
              params: { role: 'button', name: 'Place Order', exact: true, timeoutMs: 1500 },
            },
            expectedOutcome: 'Workflow will find and click the renamed "Place Order" button.',
            uncertainty: 'None; button was uniquely matched by accessible role and visible text.',
          }),
          provider: 'mock-llm',
          model: 'mock-repair-model',
          finishReason: 'stop',
          isTruncated: false,
          usage: { inputTokens: 120, outputTokens: 85, totalTokens: 205 },
        }),
      };

      const { proposal } = await generateRepairProposal(mockModelProvider, diag, version1);
      assert.equal(proposal.proposedChange.params.name, 'Place Order');

      // 6. Apply proposal to create unapproved draft Version 2
      const draftV2 = await applyRepairToDraft(repo, proposal, {
        changeSummary: 'Update button name to Place Order from failure diagnosis',
      });

      assert.equal(draftV2.version, 2);
      assert.equal(draftV2.status, 'draft');
      assert.equal(draftV2.parentVersion, 1);
      assert.equal(draftV2.steps[0].params.name, 'Place Order');

      // 7. Verify active version remains unchanged (Version 1)
      const manifestMid = await repo.getManifest(workflowId);
      assert.equal(manifestMid.activeVersion, 1);
      assert.equal(manifestMid.draftVersion, 2);

      const v1Disk = await repo.getVersion(workflowId, 1);
      assert.equal(v1Disk.status, 'verified');
      assert.equal(v1Disk.steps[0].params.name, 'Submit Order');

      // Playing workflow by ID still executes active Version 1, which still fails!
      const stillFails = await player.play(workflowId, { coupon: secret });
      assert.equal(stillFails.ok, false);
      assert.equal(stillFails.version, 1);

      // 8. Test repaired draft (Version 2) via real browser trial execution
      const trialResult = await player.playDraftForVerification(workflowId, { coupon: secret });
      assert.equal(trialResult.runResult.ok, true);
      assert.equal(trialResult.runResult.version, 2);
      assert.equal(trialResult.candidatePromotionReady, true);
      assert.equal(trialResult.evidence.workflowId, workflowId);
      assert.equal(trialResult.evidence.version, 2);
      assert.equal(trialResult.evidence.stepResults[0].ok, true);
      assert.equal(trialResult.evidence.successCriteriaResult.passed, true);
      assert.notEqual(trialResult.evidence.environment.playwrightVersion, '1.40.0');
      assert.equal(trialResult.evidence.environment.playwrightVersion, '1.64.1');

      // Verify trial execution did NOT alter active version
      const manifestStillDraft = await repo.getManifest(workflowId);
      assert.equal(manifestStillDraft.activeVersion, 1);
      assert.equal(manifestStillDraft.draftVersion, 2);

      // 9. Promote Version 2 explicitly with genuine verification evidence
      await repo.markVerified(workflowId, 2, trialResult.evidence);

      // markVerified promotes Version 2 to active and clears draftVersion atomically
      const manifestFinal = await repo.getManifest(workflowId);
      assert.equal(manifestFinal.activeVersion, 2);
      assert.equal(manifestFinal.draftVersion, null);

      // 10. Playing workflow now runs promoted Version 2 and succeeds!
      const repairedRun = await player.play(workflowId, { coupon: secret });
      assert.equal(repairedRun.ok, true);
      assert.equal(repairedRun.version, 2);
      assert.equal(repairedRun.status, 'success');

      await player.close();
    });
  });

  // =========================================================================
  // 5. Dedicated Draft Trial Verification Tests
  // =========================================================================
  describe('Draft Verification Execution Path (playDraftForVerification)', () => {
    it('normal WorkflowPlayer.play() continues to reject draft versions', async () => {
      const workflowId = 'wf_draft_reject_test';
      await repo.createWorkflow({
        id: workflowId,
        name: 'Draft Only WF',
        description: 'Workflow with only draft',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [
          {
            id: 'step_1',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/checkout' },
      });

      const player = new WorkflowPlayer({ repository: repo, browserRuntime: sharedRuntime, allowLocalhost: true });
      await assert.rejects(
        () => player.play(workflowId),
        (err) => {
          assert.equal(err.code, 'NO_VERIFIED_VERSION');
          return true;
        }
      );
    });

    it('playDraftForVerification() rejects when workflow has no draft version', async () => {
      const workflowId = 'wf_no_draft_test';
      const { version } = await repo.createWorkflow({
        id: workflowId,
        name: 'No Draft WF',
        description: 'Workflow without draft',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [
          {
            id: 'step_1',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/checkout' },
      });

      const hash = calculateContentHash(version);
      await repo.markVerified(workflowId, 1, {
        schemaVersion: '1.0.0',
        workflowId,
        version: 1,
        contentHash: hash,
        runId: 'run_init_no_draft',
        verifiedAt: new Date().toISOString(),
        environment: {
          targetOrigin: baseUrl,
          browserEngine: 'chromium',
        },
        stepResults: [
          { stepId: 'step_1', action: 'clickByRole', ok: true, durationMs: 10, verification: null },
        ],
        successCriteriaResult: { passed: true },
      });

      const player = new WorkflowPlayer({ repository: repo, browserRuntime: sharedRuntime, allowLocalhost: true });
      await assert.rejects(
        () => player.playDraftForVerification(workflowId),
        (err) => {
          assert(err.message.includes('has no draft version for verification'));
          return true;
        }
      );
    });

    it('failed draft step execution produces failing evidence that markVerified rejects', async () => {
      const workflowId = 'wf_draft_fail_evidence';
      await repo.createWorkflow({
        id: workflowId,
        name: 'Failing Draft WF',
        description: 'Draft that targets nonexistent element',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [
          {
            id: 'step_fail',
            order: 1,
            action: 'clickByRole',
            description: 'Click nonexistent button',
            params: { role: 'button', name: 'Nonexistent Button', timeoutMs: 500 },
          },
        ],
        successCriteria: { finalPath: '/checkout' },
      });

      const player = new WorkflowPlayer({ repository: repo, browserRuntime: sharedRuntime, allowLocalhost: true });
      const trial = await player.playDraftForVerification(workflowId);

      assert.equal(trial.runResult.ok, false);
      assert.equal(trial.candidatePromotionReady, false);
      assert.equal(trial.evidence.stepResults[0].ok, false);

      // Attempting to promote using failing evidence is rejected by schema verification
      await assert.rejects(
        () => repo.markVerified(workflowId, 1, trial.evidence),
        (err) => {
          assert(err.message.includes('execution failed') || err.message.includes('ok was not true'));
          return true;
        }
      );

      // Active version must remain null
      const manifest = await repo.getManifest(workflowId);
      assert.equal(manifest.activeVersion, null);
    });

    it('playDraftForVerification() generates genuine evidence with derived Playwright version', async () => {
      const workflowId = 'wf_draft_evidence_env';
      await repo.createWorkflow({
        id: workflowId,
        name: 'Draft Env WF',
        description: 'Verify environment in evidence',
        target: { origin: baseUrl, startPath: '/checkout' },
        inputs: [],
        steps: [
          {
            id: 'step_1',
            order: 1,
            action: 'clickByRole',
            description: 'Click button',
            params: { role: 'button', name: 'Submit Order' },
          },
        ],
        successCriteria: { finalPath: '/checkout' },
      });

      const player = new WorkflowPlayer({ repository: repo, browserRuntime: sharedRuntime, allowLocalhost: true });
      const trial = await player.playDraftForVerification(workflowId);

      assert.equal(trial.runResult.ok, true);
      assert.notEqual(trial.evidence.environment.playwrightVersion, '1.40.0');
      assert.equal(trial.evidence.environment.playwrightVersion, '1.64.1');
      assert.equal(trial.evidence.environment.browserEngine, 'chromium');
      assert.equal(trial.evidence.environment.nodeVersion, process.version);
      assert.equal(trial.evidence.environment.platform, process.platform);
    });
  });
});
