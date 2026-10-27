/**
 * Super Memory — Canonical Workflow Content Hashing Unit Tests
 *
 * Verifies:
 * - Deterministic SHA-256 output (64-character lowercase hexadecimal)
 * - Invariance to object key insertion order and input declaration order
 * - Exclusion of operational metadata (status, parentVersion, changeSummary, $schema)
 * - Sensitivity to any change in declarative workflow logic
 * - Zero mutation of caller objects
 * - Pre-validation before hashing
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateContentHash,
  canonicalJsonStringify,
  WorkflowValidationError,
} from '../../src/workflow/index.js';

function getBaselineVersion() {
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
        name: 'query',
        type: 'string',
        label: 'Search Query',
        required: true,
      },
      {
        name: 'category',
        type: 'string',
        label: 'Category Filter',
        required: false,
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
          inputName: 'query',
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

describe('Canonical Workflow Content Hashing', () => {
  it('1. canonicalJsonStringify recursively sorts object keys deterministically', () => {
    const objA = { z: 1, a: { y: 2, b: 3 }, m: [4, 5] };
    const objB = { a: { b: 3, y: 2 }, m: [4, 5], z: 1 };
    assert.equal(canonicalJsonStringify(objA), canonicalJsonStringify(objB));
    assert.equal(canonicalJsonStringify(objA), '{"a":{"b":3,"y":2},"m":[4,5],"z":1}');
  });

  it('2. computes a valid 64-character lowercase hex SHA-256 hash', () => {
    const version = getBaselineVersion();
    const hash = calculateContentHash(version);

    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
    assert(/^[a-f0-9]{64}$/.test(hash), 'Hash must be a 64-char lowercase hexadecimal string');
  });

  it('3. produces identical hash regardless of object key order', () => {
    const v1 = getBaselineVersion();

    // Reconstruct version with scrambled key ordering
    const v2 = {
      successCriteria: {
        textPresent: 'Submitted: ',
        finalPath: '/',
      },
      target: {
        startPath: '/',
        origin: 'http://127.0.0.1:8080',
      },
      steps: v1.steps.map((s) => ({
        description: s.description,
        verification: s.verification,
        anchor: s.anchor,
        order: s.order,
        params: { ...s.params },
        action: s.action,
        id: s.id,
      })),
      inputs: [...v1.inputs],
      version: 1,
      workflowId: 'wf_search_catalog',
      schemaVersion: '1.0.0',
      status: 'draft',
      changeSummary: 'Initial recorded draft.',
      parentVersion: null,
    };

    assert.equal(calculateContentHash(v1), calculateContentHash(v2));
  });

  it('4. produces identical hash regardless of input declaration order (sorted canonically by name)', () => {
    const v1 = getBaselineVersion();
    const v2 = getBaselineVersion();

    // Reverse input declaration order: [category, query] instead of [query, category]
    v2.inputs = [v1.inputs[1], v1.inputs[0]];

    assert.equal(calculateContentHash(v1), calculateContentHash(v2));
  });

  it('5. excludes operational metadata (status, parentVersion, changeSummary, $schema) from content hash', () => {
    const v1 = getBaselineVersion();
    const v2 = getBaselineVersion();

    // Mutate operational metadata only
    v2.status = 'verified';
    v2.changeSummary = 'Updated change log description';
    delete v2.$schema;

    assert.equal(
      calculateContentHash(v1),
      calculateContentHash(v2),
      'Content hash must be invariant to operational metadata changes'
    );
  });

  it('6. produces different hash when declarative workflow logic changes', () => {
    const baselineHash = calculateContentHash(getBaselineVersion());

    // 1. Change target origin
    const vOrigin = getBaselineVersion();
    vOrigin.target.origin = 'http://127.0.0.1:9090';
    assert.notEqual(calculateContentHash(vOrigin), baselineHash);

    // 2. Change start path
    const vPath = getBaselineVersion();
    vPath.target.startPath = '/catalog';
    assert.notEqual(calculateContentHash(vPath), baselineHash);

    // 3. Change a step parameter
    const vParam = getBaselineVersion();
    vParam.steps[1].params.label = 'Alternate Label';
    assert.notEqual(calculateContentHash(vParam), baselineHash);

    // 4. Change a step verification predicate
    const vVerif = getBaselineVersion();
    vVerif.steps[0].verification.expected = 'Different Title';
    assert.notEqual(calculateContentHash(vVerif), baselineHash);

    // 5. Change success criteria
    const vCriteria = getBaselineVersion();
    vCriteria.successCriteria.textPresent = 'All Done';
    assert.notEqual(calculateContentHash(vCriteria), baselineHash);

    // 6. Change workflow ID
    const vId = getBaselineVersion();
    vId.workflowId = 'wf_other_catalog';
    assert.notEqual(calculateContentHash(vId), baselineHash);

    // 7. Change version number
    const vNum = getBaselineVersion();
    vNum.version = 2;
    assert.notEqual(calculateContentHash(vNum), baselineHash);
  });

  it('7. does not mutate caller objects during hashing', () => {
    const original = getBaselineVersion();
    const clone = JSON.parse(JSON.stringify(original));

    calculateContentHash(original);

    assert.deepEqual(original, clone, 'Hashing must be pure and not mutate the input object');
  });

  it('8. validates version structure before hashing and throws WorkflowValidationError on malformed input', () => {
    const invalid = getBaselineVersion();
    invalid.steps[0].action = 'unsupportedAction';

    assert.throws(
      () => calculateContentHash(invalid),
      (err) => err instanceof WorkflowValidationError
    );
  });
});
