/**
 * Super Memory — Canonical Workflow Content Hashing
 *
 * Generates deterministic SHA-256 content hashes of workflow version definitions.
 *
 * Principles:
 * 1. Hashes only the declarative workflow logic (target, inputs, ordered steps, success criteria).
 * 2. Excludes volatile and operational metadata (status, timestamps, parentVersion, changeSummary).
 * 3. Enforces deterministic key order and whitespace-free canonical JSON serialization.
 * 4. Never mutates the source workflow version object.
 *
 * Security & Integrity Note:
 * This content hash provides tamper detection and verifies that the exact workflow
 * definition executed during verification matches the definition replayed in production.
 * It detects modifications relative to a trusted, separately preserved digest.
 * A digest stored alongside a mutable record does not independently prevent an actor
 * with write access from modifying both.
 */

import { createHash } from 'node:crypto';
import { validateWorkflowVersion } from './schema.js';

/**
 * Deterministically serializes a JavaScript value into a canonical JSON string
 * with recursively sorted object keys and no extra whitespace.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJsonStringify(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => {
    return JSON.stringify(key) + ':' + canonicalJsonStringify(value[key]);
  });
  return '{' + entries.join(',') + '}';
}

/**
 * Computes a deterministic SHA-256 content hash of a workflow version's declarative logic.
 *
 * Included Fields in Canonical Projection:
 * - schemaVersion
 * - workflowId
 * - version
 * - target.origin
 * - target.startPath
 * - inputs (sorted by name)
 * - steps (sorted by order)
 * - successCriteria
 *
 * Excluded Fields (Operational Metadata):
 * - status (draft vs verified)
 * - parentVersion
 * - changeSummary
 * - $schema
 * - Any operational timestamps or verification records
 *
 * @param {object} version - Valid workflow version object.
 * @returns {string} 64-character lowercase hexadecimal SHA-256 hash.
 */
export function calculateContentHash(version) {
  validateWorkflowVersion(version);

  const canonicalInputs = version.inputs
    .map((input) => ({
      name: input.name,
      type: input.type,
      label: input.label,
      ...(input.description !== undefined ? { description: input.description } : {}),
      required: input.required,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const canonicalSteps = version.steps
    .map((step) => {
      const canonicalStep = {
        id: step.id,
        order: step.order,
        description: step.description,
        action: step.action,
        params: { ...step.params },
      };
      if (step.anchor !== null && step.anchor !== undefined) {
        canonicalStep.anchor = { ...step.anchor };
      }
      if (step.verification !== null && step.verification !== undefined) {
        canonicalStep.verification = { ...step.verification };
      }
      return canonicalStep;
    })
    .sort((a, b) => a.order - b.order);

  const canonicalProjection = {
    schemaVersion: version.schemaVersion,
    workflowId: version.workflowId,
    version: version.version,
    target: {
      origin: version.target.origin,
      startPath: version.target.startPath,
    },
    inputs: canonicalInputs,
    steps: canonicalSteps,
    successCriteria: { ...version.successCriteria },
  };

  const canonicalJson = canonicalJsonStringify(canonicalProjection);
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}
