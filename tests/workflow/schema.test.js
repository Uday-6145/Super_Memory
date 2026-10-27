/**
 * Super Memory — Workflow Memory Schema Validation Unit Tests
 *
 * Verifies strict validation rules for manifests, versions, and evidence:
 * - Rejection of unknown keys at all schema levels
 * - Enforced allowlists for actions and parameters
 * - Origin and relative path safety (credentials, traversal, queries, fragments)
 * - Prohibition of raw values in fillByLabel
 * - Prohibition of password anchors
 * - Immutability of caller objects during validation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest,
  validateWorkflowVersion,
  validateVerificationEvidence,
  verifyEvidenceMatchesWorkflow,
  WorkflowValidationError,
  InvalidWorkflowIdError,
} from '../../src/workflow/index.js';

function getValidManifest() {
  return {
    $schema: 'https://supermemory.dev/schemas/v1/manifest.json',
    schemaVersion: '1.0.0',
    id: 'wf_search_catalog',
    name: 'Search Workflow Catalog',
    description: 'Searches catalog and verifies results.',
    enabled: true,
    activeVersion: 1,
    draftVersion: 2,
    timestamps: {
      createdAt: '2026-10-27T16:30:00.000Z',
      updatedAt: '2026-10-27T16:45:00.000Z',
    },
  };
}

function getValidVersion() {
  return {
    $schema: 'https://supermemory.dev/schemas/v1/workflow-version.json',
    schemaVersion: '1.0.0',
    workflowId: 'wf_search_catalog',
    version: 1,
    status: 'draft',
    parentVersion: null,
    changeSummary: 'Initial recorded draft.',
    target: {
      origin: 'http://127.0.0.1:8080',
      startPath: '/',
    },
    inputs: [
      {
        name: 'searchQuery',
        type: 'string',
        label: 'Search Query',
        description: 'Terms to search for',
        required: true,
      },
    ],
    steps: [
      {
        id: 'step_1',
        order: 1,
        description: 'Navigate to home page',
        action: 'navigate',
        params: {
          path: '/',
          waitUntil: 'domcontentloaded',
          timeoutMs: 15000,
        },
        anchor: null,
        verification: {
          type: 'pageTitle',
          expected: 'Super Memory Test Home',
        },
      },
      {
        id: 'step_2',
        order: 2,
        description: 'Fill search query',
        action: 'fillByLabel',
        params: {
          label: 'Search Workflows',
          inputName: 'searchQuery',
          exact: false,
          timeoutMs: 10000,
        },
        anchor: {
          role: 'textbox',
          name: 'Search Workflows',
          tag: 'input',
          type: 'text',
          placeholder: 'Search workflows...',
        },
        verification: null,
      },
      {
        id: 'step_3',
        order: 3,
        description: 'Click submit button',
        action: 'clickByRole',
        params: {
          role: 'button',
          name: 'Run Search',
          exact: true,
          timeoutMs: 10000,
        },
        anchor: {
          role: 'button',
          name: 'Run Search',
          tag: 'button',
          type: 'submit',
        },
        verification: {
          type: 'textPresent',
          expected: 'Submitted: ',
        },
      },
    ],
    successCriteria: {
      finalPath: '/',
      textPresent: 'Submitted: ',
    },
  };
}

function getValidEvidence(hash = 'a'.repeat(64)) {
  return {
    $schema: 'https://supermemory.dev/schemas/v1/verification-evidence.json',
    schemaVersion: '1.0.0',
    workflowId: 'wf_search_catalog',
    version: 1,
    contentHash: hash,
    runId: 'run_20261027_164500_abc123',
    verifiedAt: '2026-10-27T16:45:00.000Z',
    environment: {
      targetOrigin: 'http://127.0.0.1:8080',
      browserEngine: 'chromium',
      playwrightVersion: '1.64.1',
      nodeVersion: 'v22.19.0',
      platform: 'darwin-arm64',
    },
    stepResults: [
      {
        stepId: 'step_1',
        action: 'navigate',
        ok: true,
        status: 200,
        durationMs: 45,
        verification: { type: 'pageTitle', passed: true },
      },
      {
        stepId: 'step_2',
        action: 'fillByLabel',
        ok: true,
        durationMs: 82,
        verification: null,
      },
      {
        stepId: 'step_3',
        action: 'clickByRole',
        ok: true,
        durationMs: 65,
        verification: { type: 'textPresent', passed: true },
      },
    ],
    successCriteriaResult: {
      passed: true,
      finalPath: '/',
      textPresentFound: true,
    },
  };
}

describe('Workflow Schema Validation', () => {
  describe('Manifest Validation', () => {
    it('1. accepts a completely valid manifest', () => {
      const manifest = getValidManifest();
      assert.deepEqual(validateManifest(manifest), { valid: true });
    });

    it('2. rejects unknown keys at manifest root', () => {
      const manifest = getValidManifest();
      manifest.unexpectedField = 'malicious';
      assert.throws(
        () => validateManifest(manifest),
        (err) => err instanceof WorkflowValidationError && err.message.includes('unexpectedField')
      );
    });

    it('3. rejects unknown keys in manifest timestamps', () => {
      const manifest = getValidManifest();
      manifest.timestamps.extraTime = '2026-10-27T16:30:00.000Z';
      assert.throws(
        () => validateManifest(manifest),
        (err) => err instanceof WorkflowValidationError && err.message.includes('extraTime')
      );
    });

    it('4. rejects invalid workflow IDs (uppercase, spaces, path traversal, symbols)', () => {
      const invalidIds = ['Wf_Capital', 'wf space', '../../etc/passwd', 'wf/slash', 'wf$symbol', 'a', 'a'.repeat(65)];
      for (const id of invalidIds) {
        const manifest = getValidManifest();
        manifest.id = id;
        assert.throws(
          () => validateManifest(manifest),
          (err) => err instanceof InvalidWorkflowIdError
        );
      }
    });

    it('5. rejects invalid timestamps', () => {
      const manifest = getValidManifest();
      manifest.timestamps.updatedAt = 'not-a-timestamp';
      assert.throws(
        () => validateManifest(manifest),
        (err) => err instanceof WorkflowValidationError && err.message.includes('updatedAt')
      );
    });

    it('6. rejects manifest when activeVersion and draftVersion are identical', () => {
      const manifest = getValidManifest();
      manifest.activeVersion = 2;
      manifest.draftVersion = 2;
      assert.throws(
        () => validateManifest(manifest),
        (err) => err instanceof WorkflowValidationError && err.message.includes('cannot reference the same version')
      );
    });
  });

  describe('Workflow Version Validation', () => {
    it('7. accepts a completely valid draft or verified version', () => {
      const version = getValidVersion();
      assert.deepEqual(validateWorkflowVersion(version), { valid: true });

      version.status = 'verified';
      assert.deepEqual(validateWorkflowVersion(version), { valid: true });
    });

    it('8. rejects unknown keys at version root', () => {
      const version = getValidVersion();
      version.injectedKey = 123;
      assert.throws(
        () => validateWorkflowVersion(version),
        (err) => err instanceof WorkflowValidationError && err.message.includes('injectedKey')
      );
    });

    it('9. rejects invalid version numbers', () => {
      const invalidVersions = [0, -1, 1.5, '1', null];
      for (const v of invalidVersions) {
        const version = getValidVersion();
        version.version = v;
        assert.throws(
          () => validateWorkflowVersion(version),
          (err) => err instanceof WorkflowValidationError && err.message.includes('Version number')
        );
      }
    });

    it('10. validates parentVersion rules relative to version number', () => {
      // v1 cannot have parentVersion
      const v1 = getValidVersion();
      v1.version = 1;
      v1.parentVersion = 1;
      assert.throws(
        () => validateWorkflowVersion(v1),
        (err) => err instanceof WorkflowValidationError && err.message.includes('parentVersion')
      );

      // v2 parentVersion must be < 2
      const v2 = getValidVersion();
      v2.version = 2;
      v2.parentVersion = 2;
      assert.throws(
        () => validateWorkflowVersion(v2),
        (err) => err instanceof WorkflowValidationError && err.message.includes('parentVersion')
      );

      v2.parentVersion = 1;
      assert.deepEqual(validateWorkflowVersion(v2), { valid: true });
    });

    it('11. rejects target origins with credentials, paths, queries, or fragments', () => {
      const invalidOrigins = [
        'http://user:pass@127.0.0.1:8080',
        'http://127.0.0.1:8080/path',
        'http://127.0.0.1:8080?token=1',
        'http://127.0.0.1:8080#section',
        'ftp://127.0.0.1:8080',
        'http://127.0.0.1:8080/', // trailing slash is non-canonical
      ];
      for (const origin of invalidOrigins) {
        const version = getValidVersion();
        version.target.origin = origin;
        assert.throws(
          () => validateWorkflowVersion(version),
          (err) => err instanceof WorkflowValidationError && err.message.includes('Target origin')
        );
      }
    });

    it('12. rejects relative paths with queries, fragments, protocol-relative prefixes, backslashes, or directory traversal', () => {
      const invalidPaths = [
        'relative/path',
        '//example.com/test',
        '/\t/evil.com',
        '/\r/evil.com',
        '/\n/evil.com',
        '/path with spaces',
        '/path\twith\ttabs',
        '/path?token=secret',
        '/path#heading',
        '/path\\with\\backslashes',
        '/path\0null',
        '/../escaped',
        '/safe/../../escaped',
        '/safe/%2e%2e/escaped',
      ];
      for (const p of invalidPaths) {
        const version = getValidVersion();
        version.target.startPath = p;
        assert.throws(
          () => validateWorkflowVersion(version),
          (err) => err instanceof WorkflowValidationError && err.message.includes('Relative path')
        );
      }
    });

    it('13. rejects inputs with duplicate names or missing required properties', () => {
      const version = getValidVersion();
      version.inputs.push({
        name: 'searchQuery', // duplicate
        type: 'string',
        label: 'Second Query',
        required: false,
      });
      assert.throws(
        () => validateWorkflowVersion(version),
        (err) => err instanceof WorkflowValidationError && err.message.includes('Duplicate input name')
      );
    });

    it('14. rejects unsupported actions and non-consecutive step orders', () => {
      const version = getValidVersion();
      version.steps[0].action = 'eval';
      assert.throws(
        () => validateWorkflowVersion(version),
        (err) => err instanceof WorkflowValidationError && err.message.includes('Unsupported action')
      );

      const versionOrder = getValidVersion();
      versionOrder.steps[1].order = 5; // non-consecutive
      assert.throws(
        () => validateWorkflowVersion(versionOrder),
        (err) => err instanceof WorkflowValidationError && err.message.includes('Step order')
      );
    });

    it('14b. rejects clickByRole with missing or empty accessible name', () => {
      const versionMissingName = getValidVersion();
      delete versionMissingName.steps[2].params.name;
      assert.throws(
        () => validateWorkflowVersion(versionMissingName),
        (err) =>
          err instanceof WorkflowValidationError &&
          err.message.includes('name at "steps[2].params.name" is required')
      );

      const versionEmptyName = getValidVersion();
      versionEmptyName.steps[2].params.name = '   ';
      assert.throws(
        () => validateWorkflowVersion(versionEmptyName),
        (err) =>
          err instanceof WorkflowValidationError &&
          err.message.includes('name at "steps[2].params.name" is required')
      );
    });

    it('15. rejects fillByLabel referencing undeclared inputName', () => {
      const version = getValidVersion();
      version.steps[1].params.inputName = 'undeclaredInput';
      assert.throws(
        () => validateWorkflowVersion(version),
        (err) => err instanceof WorkflowValidationError && err.message.includes('undeclaredInput')
      );
    });

    it('16. strictly rejects any attempt to persist a raw "value" on fillByLabel', () => {
      const forbiddenValues = ['my_password', '', null, undefined];
      for (const val of forbiddenValues) {
        const version = getValidVersion();
        version.steps[1].params.value = val;
        assert.throws(
          () => validateWorkflowVersion(version),
          (err) => err instanceof WorkflowValidationError && err.message.includes('must not contain a "value" property')
        );
      }
    });

    it('17. strictly rejects element anchors identifying password input types', () => {
      const version = getValidVersion();
      version.steps[1].anchor.type = 'password';
      assert.throws(
        () => validateWorkflowVersion(version),
        (err) => err instanceof WorkflowValidationError && err.message.includes('password input types are strictly prohibited')
      );
    });

    it('18. validates verification predicates and rejects unsupported predicate types', () => {
      const version = getValidVersion();
      version.steps[0].verification.type = 'regexMatch'; // unsupported
      assert.throws(
        () => validateWorkflowVersion(version),
        (err) => err instanceof WorkflowValidationError && err.message.includes('Unsupported verification predicate')
      );
    });

    it('19. rejects empty successCriteria', () => {
      const version = getValidVersion();
      version.successCriteria = {};
      assert.throws(
        () => validateWorkflowVersion(version),
        (err) => err instanceof WorkflowValidationError && err.message.includes('successCriteria must contain at least one')
      );
    });

    it('20. does not mutate the supplied version object during validation', () => {
      const original = getValidVersion();
      const snapshot = JSON.parse(JSON.stringify(original));
      validateWorkflowVersion(original);
      assert.deepEqual(original, snapshot, 'Validation must not mutate the target object');
    });
  });

  describe('Verification Evidence Validation', () => {
    it('21. accepts completely valid verification evidence', () => {
      const evidence = getValidEvidence();
      assert.deepEqual(validateVerificationEvidence(evidence), { valid: true });
    });

    it('22. rejects evidence with invalid 64-character hash or malformed runId', () => {
      const evidence = getValidEvidence();
      evidence.contentHash = 'short_hash';
      assert.throws(
        () => validateVerificationEvidence(evidence),
        (err) => err instanceof WorkflowValidationError && err.message.includes('contentHash')
      );

      evidence.contentHash = 'a'.repeat(64);
      evidence.runId = 'invalid run id with spaces';
      assert.throws(
        () => validateVerificationEvidence(evidence),
        (err) => err instanceof WorkflowValidationError && err.message.includes('runId')
      );
    });

    it('23. permits non-navigation steps to omit HTTP status codes', () => {
      const evidence = getValidEvidence();
      // clickByRole (stepResults[2]) has no status code
      delete evidence.stepResults[2].status;
      assert.deepEqual(validateVerificationEvidence(evidence), { valid: true });
    });

    it('24. verifyEvidenceMatchesWorkflow succeeds on matched hash, steps, and predicates', () => {
      const version = getValidVersion();
      const hash = 'b'.repeat(64);
      const evidence = getValidEvidence(hash);

      const match = verifyEvidenceMatchesWorkflow(evidence, version, hash);
      assert.deepEqual(match, { ok: true });
    });

    it('25. verifyEvidenceMatchesWorkflow rejects mismatched hash, reordered steps, or failed predicates', () => {
      const version = getValidVersion();
      const hash = 'b'.repeat(64);

      // Mismatched hash
      const evidenceMismatchedHash = getValidEvidence('c'.repeat(64));
      assert.throws(
        () => verifyEvidenceMatchesWorkflow(evidenceMismatchedHash, version, hash),
        (err) => err instanceof WorkflowValidationError && err.message.includes('does not match computed workflow hash')
      );

      // Reordered or missing steps
      const evidenceMismatchedSteps = getValidEvidence(hash);
      evidenceMismatchedSteps.stepResults[0].stepId = 'step_99';
      assert.throws(
        () => verifyEvidenceMatchesWorkflow(evidenceMismatchedSteps, version, hash),
        (err) => err instanceof WorkflowValidationError && err.message.includes('stepId')
      );

      // Failed step verification predicate
      const evidenceFailedPredicate = getValidEvidence(hash);
      evidenceFailedPredicate.stepResults[0].verification.passed = false;
      assert.throws(
        () => verifyEvidenceMatchesWorkflow(evidenceFailedPredicate, version, hash),
        (err) => err instanceof WorkflowValidationError && err.message.includes('verification did not pass')
      );

      // Failed final success criteria
      const evidenceFailedCriteria = getValidEvidence(hash);
      evidenceFailedCriteria.successCriteriaResult.passed = false;
      assert.throws(
        () => verifyEvidenceMatchesWorkflow(evidenceFailedCriteria, version, hash),
        (err) => err instanceof WorkflowValidationError && err.message.includes('successCriteriaResult did not pass')
      );
    });

    it('26. rejects verification evidence when a step result is missing ok or ok is not boolean', () => {
      const evidenceMissingOk = getValidEvidence();
      delete evidenceMissingOk.stepResults[0].ok;
      assert.throws(
        () => validateVerificationEvidence(evidenceMissingOk),
        (err) => err instanceof WorkflowValidationError && err.message.includes('must be a boolean')
      );

      const evidenceInvalidOk = getValidEvidence();
      evidenceInvalidOk.stepResults[0].ok = 'true';
      assert.throws(
        () => validateVerificationEvidence(evidenceInvalidOk),
        (err) => err instanceof WorkflowValidationError && err.message.includes('must be a boolean')
      );
    });

    it('27. rejects standalone verification evidence with duplicate stepId values', () => {
      const evidence = getValidEvidence();
      evidence.stepResults[1].stepId = 'step_1'; // duplicate step_1
      assert.throws(
        () => validateVerificationEvidence(evidence),
        (err) => err instanceof WorkflowValidationError && err.message.includes('Duplicate stepId')
      );
    });

    it('28. verifyEvidenceMatchesWorkflow rejects evidence when an intermediate step has ok === false', () => {
      const version = getValidVersion();
      const hash = 'b'.repeat(64);
      const evidenceFailedStep = getValidEvidence(hash);
      // Intermediate step 2 (fillByLabel) has verification: null, but ok: false
      evidenceFailedStep.stepResults[1].ok = false;
      assert.throws(
        () => verifyEvidenceMatchesWorkflow(evidenceFailedStep, version, hash),
        (err) => err instanceof WorkflowValidationError && err.message.includes('execution failed (ok was not true)')
      );
    });
  });
});
