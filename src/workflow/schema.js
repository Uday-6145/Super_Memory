/**
 * Super Memory — Workflow Memory Schema Validation
 *
 * Implements strict, dependency-free schema validators for:
 * 1. Workflow Manifests (mutable operational controls)
 * 2. Workflow Versions (immutable step definitions)
 * 3. Verification Evidence (tamper-evident execution proof)
 *
 * Security & Reliability Guarantees:
 * - Strict allowlists at all object levels; unknown properties are immediately rejected.
 * - Enforces safe origin and relative path syntax (no credentials, traversal, queries, or fragments).
 * - Prohibits storage of actual form input values, passwords, credentials, or cookies.
 * - Enforces safe, minimal verification predicates (pageTitle, textPresent, textAbsent).
 * - Never mutates input objects during validation.
 */

import {
  WorkflowValidationError,
  InvalidWorkflowIdError,
} from './errors.js';

const WORKFLOW_ID_REGEX = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const INPUT_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/;
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const HEX_64_REGEX = /^[a-f0-9]{64}$/;
const RUN_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Asserts that an object contains only explicitly allowed property keys.
 *
 * @param {object} obj
 * @param {string[]} allowedKeys
 * @param {string} [path='']
 */
export function assertExactKeys(obj, allowedKeys, path = '') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new WorkflowValidationError(
      `Expected an object at "${path || 'root'}", received ${obj === null ? 'null' : Array.isArray(obj) ? 'array' : typeof obj}.`,
      { path }
    );
  }
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      const fullPath = path ? `${path}.${key}` : key;
      throw new WorkflowValidationError(
        `Unknown property "${key}" is not permitted at "${path || 'root'}".`,
        { path: fullPath }
      );
    }
  }
}

/**
 * Validates a workflow identifier slug.
 *
 * @param {string} id
 * @param {string} [path='id']
 */
export function validateWorkflowId(id, path = 'id') {
  if (typeof id !== 'string' || !WORKFLOW_ID_REGEX.test(id)) {
    throw new InvalidWorkflowIdError(
      `Invalid workflow ID at "${path}": must be 3-64 characters, lowercase alphanumeric with dashes/underscores, starting with an alphanumeric character.`,
      { workflowId: typeof id === 'string' ? id : String(id) }
    );
  }
}

/**
 * Validates an ISO 8601 timestamp string.
 *
 * @param {string} value
 * @param {string} path
 */
export function validateTimestamp(value, path) {
  if (typeof value !== 'string') {
    throw new WorkflowValidationError(`Timestamp at "${path}" must be a string.`, { path });
  }
  if (!ISO_8601_REGEX.test(value)) {
    throw new WorkflowValidationError(`Timestamp at "${path}" does not conform to ISO 8601 format: "${value}".`, { path });
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new WorkflowValidationError(`Timestamp at "${path}" represents an invalid date: "${value}".`, { path });
  }
}

/**
 * Validates a canonical target origin (e.g. "http://127.0.0.1:8080" or "https://example.com").
 *
 * Rules:
 * - Scheme must be http: or https:
 * - No credentials (user:pass@)
 * - No query strings or fragments
 * - No non-root path component
 * - Must equal canonical origin format (no trailing slash)
 *
 * @param {string} origin
 * @param {string} [path='target.origin']
 */
export function validateTargetOrigin(origin, path = 'target.origin') {
  if (typeof origin !== 'string' || origin.trim() === '') {
    throw new WorkflowValidationError(`Target origin at "${path}" must be a non-empty string.`, { path });
  }
  if (/\s/.test(origin)) {
    throw new WorkflowValidationError(`Target origin at "${path}" must not contain whitespace.`, { path });
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (err) {
    throw new WorkflowValidationError(`Target origin at "${path}" is not a valid absolute URL: "${origin}".`, {
      path,
      cause: err,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkflowValidationError(
      `Target origin at "${path}" must use "http:" or "https:" scheme, found "${parsed.protocol}".`,
      { path }
    );
  }
  if (parsed.username || parsed.password) {
    throw new WorkflowValidationError(`Target origin at "${path}" must not contain embedded credentials.`, { path });
  }
  if (parsed.search || parsed.hash) {
    throw new WorkflowValidationError(`Target origin at "${path}" must not contain query strings or hash fragments.`, { path });
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new WorkflowValidationError(
      `Target origin at "${path}" must not contain a path component (found "${parsed.pathname}").`,
      { path }
    );
  }
  const canonicalOrigin = `${parsed.protocol}//${parsed.host}`;
  if (origin !== canonicalOrigin) {
    throw new WorkflowValidationError(
      `Target origin at "${path}" must be in canonical form ("${canonicalOrigin}"), found "${origin}".`,
      { path }
    );
  }
}

/**
 * Validates a safe relative URL path.
 *
 * Rules:
 * - Must begin with a single forward slash ("/")
 * - Must not start with "//" (protocol-relative path)
 * - Must not contain query strings ("?") or fragments ("#")
 * - Must not contain backslashes or null bytes
 * - Must not contain directory traversal segments ("/../" or "/./")
 *
 * @param {string} relPath
 * @param {string} [path='path']
 */
export function validateRelativePath(relPath, path = 'path') {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new WorkflowValidationError(`Relative path at "${path}" must be a non-empty string.`, { path });
  }
  if (!relPath.startsWith('/')) {
    throw new WorkflowValidationError(`Relative path at "${path}" must begin with a forward slash ("/").`, { path });
  }
  if (relPath.startsWith('//')) {
    throw new WorkflowValidationError(
      `Relative path at "${path}" must not be protocol-relative (cannot start with "//").`,
      { path }
    );
  }
  if (/[\s\x00-\x1f]/.test(relPath)) {
    throw new WorkflowValidationError(
      `Relative path at "${path}" must not contain whitespace or ASCII control characters.`,
      { path }
    );
  }
  if (relPath.includes('?') || relPath.includes('#')) {
    throw new WorkflowValidationError(
      `Relative path at "${path}" must not contain query strings or hash fragments.`,
      { path }
    );
  }
  if (relPath.includes('\\')) {
    throw new WorkflowValidationError(`Relative path at "${path}" must not contain backslashes.`, { path });
  }
  if (relPath.includes('\0')) {
    throw new WorkflowValidationError(`Relative path at "${path}" must not contain null bytes.`, { path });
  }
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new WorkflowValidationError(
        `Relative path at "${path}" must not contain directory traversal segments ("${seg}").`,
        { path }
      );
    }
  }
  if (/%2e/i.test(relPath)) {
    throw new WorkflowValidationError(
      `Relative path at "${path}" must not contain URL-encoded directory traversal sequences.`,
      { path }
    );
  }
  // Enforce that resolving against a dummy origin preserves the exact origin without escape
  try {
    const dummyOrigin = 'http://127.0.0.1:8080';
    const resolved = new URL(relPath, dummyOrigin);
    if (resolved.origin !== dummyOrigin) {
      throw new WorkflowValidationError(
        `Relative path at "${path}" escapes the target origin (resolved to "${resolved.origin}").`,
        { path }
      );
    }
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      throw err;
    }
    throw new WorkflowValidationError(
      `Relative path at "${path}" failed URL resolution: ${err.message}`,
      { path, cause: err }
    );
  }
}

/**
 * Validates a mutable workflow manifest record.
 *
 * @param {object} manifest
 * @returns {{ valid: boolean }}
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new WorkflowValidationError('Manifest must be a non-null object.');
  }

  assertExactKeys(manifest, [
    '$schema',
    'schemaVersion',
    'id',
    'name',
    'description',
    'enabled',
    'activeVersion',
    'draftVersion',
    'timestamps',
  ]);

  if (manifest.$schema !== undefined && (typeof manifest.$schema !== 'string' || manifest.$schema.trim() === '')) {
    throw new WorkflowValidationError('Optional "$schema" must be a non-empty string.', { path: '$schema' });
  }

  if (manifest.schemaVersion !== '1.0.0') {
    throw new WorkflowValidationError(
      `Unsupported schemaVersion "${manifest.schemaVersion}". Only "1.0.0" is supported.`,
      { path: 'schemaVersion' }
    );
  }

  validateWorkflowId(manifest.id, 'id');

  if (typeof manifest.name !== 'string' || manifest.name.trim() === '' || manifest.name.length > 100) {
    throw new WorkflowValidationError('Manifest "name" must be a non-empty string of at most 100 characters.', { path: 'name' });
  }

  if (typeof manifest.description !== 'string' || manifest.description.length > 500) {
    throw new WorkflowValidationError('Manifest "description" must be a string of at most 500 characters.', { path: 'description' });
  }

  if (typeof manifest.enabled !== 'boolean') {
    throw new WorkflowValidationError('Manifest "enabled" must be a boolean.', { path: 'enabled' });
  }

  if (manifest.activeVersion !== null) {
    if (!Number.isInteger(manifest.activeVersion) || manifest.activeVersion < 1) {
      throw new WorkflowValidationError('Manifest "activeVersion" must be a positive integer or null.', { path: 'activeVersion' });
    }
  }

  if (manifest.draftVersion !== null) {
    if (!Number.isInteger(manifest.draftVersion) || manifest.draftVersion < 1) {
      throw new WorkflowValidationError('Manifest "draftVersion" must be a positive integer or null.', { path: 'draftVersion' });
    }
  }

  if (manifest.activeVersion !== null && manifest.draftVersion !== null && manifest.activeVersion === manifest.draftVersion) {
    throw new WorkflowValidationError(
      `Manifest activeVersion (${manifest.activeVersion}) and draftVersion (${manifest.draftVersion}) cannot reference the same version.`,
      { path: 'draftVersion' }
    );
  }

  if (!manifest.timestamps || typeof manifest.timestamps !== 'object' || Array.isArray(manifest.timestamps)) {
    throw new WorkflowValidationError('Manifest "timestamps" must be an object.', { path: 'timestamps' });
  }
  assertExactKeys(manifest.timestamps, ['createdAt', 'updatedAt'], 'timestamps');
  validateTimestamp(manifest.timestamps.createdAt, 'timestamps.createdAt');
  validateTimestamp(manifest.timestamps.updatedAt, 'timestamps.updatedAt');

  return { valid: true };
}

/**
 * Validates a verification predicate object.
 *
 * @param {object} verification
 * @param {string} path
 */
function validateVerificationPredicate(verification, path) {
  assertExactKeys(verification, ['type', 'expected'], path);
  if (
    verification.type !== 'pageTitle' &&
    verification.type !== 'textPresent' &&
    verification.type !== 'textAbsent'
  ) {
    throw new WorkflowValidationError(
      `Unsupported verification predicate type "${verification.type}" at "${path}.type". Only "pageTitle", "textPresent", and "textAbsent" are permitted.`,
      { path: `${path}.type` }
    );
  }
  if (
    typeof verification.expected !== 'string' ||
    verification.expected.trim() === '' ||
    verification.expected.length > 500
  ) {
    throw new WorkflowValidationError(
      `Verification expected string at "${path}.expected" must be a non-empty string of at most 500 characters.`,
      { path: `${path}.expected` }
    );
  }
}

/**
 * Validates an immutable workflow version record.
 *
 * @param {object} version
 * @returns {{ valid: boolean }}
 */
export function validateWorkflowVersion(version) {
  if (!version || typeof version !== 'object' || Array.isArray(version)) {
    throw new WorkflowValidationError('Workflow version must be a non-null object.');
  }

  assertExactKeys(version, [
    '$schema',
    'schemaVersion',
    'workflowId',
    'version',
    'status',
    'parentVersion',
    'changeSummary',
    'target',
    'inputs',
    'steps',
    'successCriteria',
  ]);

  if (version.$schema !== undefined && (typeof version.$schema !== 'string' || version.$schema.trim() === '')) {
    throw new WorkflowValidationError('Optional "$schema" must be a non-empty string.', { path: '$schema' });
  }

  if (version.schemaVersion !== '1.0.0') {
    throw new WorkflowValidationError(
      `Unsupported schemaVersion "${version.schemaVersion}". Only "1.0.0" is supported.`,
      { path: 'schemaVersion' }
    );
  }

  validateWorkflowId(version.workflowId, 'workflowId');

  if (!Number.isInteger(version.version) || version.version < 1) {
    throw new WorkflowValidationError('Version number must be a positive integer (>= 1).', { path: 'version' });
  }

  if (version.status !== 'draft' && version.status !== 'verified') {
    throw new WorkflowValidationError(
      `Status must be "draft" or "verified", received "${version.status}".`,
      { path: 'status' }
    );
  }

  if (version.version === 1) {
    if (version.parentVersion !== null) {
      throw new WorkflowValidationError('Version 1 must have parentVersion set to null.', { path: 'parentVersion' });
    }
  } else {
    if (
      version.parentVersion !== null &&
      (!Number.isInteger(version.parentVersion) || version.parentVersion < 1 || version.parentVersion >= version.version)
    ) {
      throw new WorkflowValidationError(
        `parentVersion (${version.parentVersion}) must be a positive integer less than version (${version.version}) or null.`,
        { path: 'parentVersion' }
      );
    }
  }

  if (typeof version.changeSummary !== 'string' || version.changeSummary.length > 500) {
    throw new WorkflowValidationError('changeSummary must be a string of at most 500 characters.', { path: 'changeSummary' });
  }

  // Target validation
  if (!version.target || typeof version.target !== 'object' || Array.isArray(version.target)) {
    throw new WorkflowValidationError('target must be an object.', { path: 'target' });
  }
  assertExactKeys(version.target, ['origin', 'startPath'], 'target');
  validateTargetOrigin(version.target.origin, 'target.origin');
  validateRelativePath(version.target.startPath, 'target.startPath');

  // Inputs validation
  if (!Array.isArray(version.inputs)) {
    throw new WorkflowValidationError('inputs must be an array.', { path: 'inputs' });
  }
  const declaredInputNames = new Set();
  for (let i = 0; i < version.inputs.length; i++) {
    const input = version.inputs[i];
    const inputPath = `inputs[${i}]`;
    assertExactKeys(input, ['name', 'type', 'label', 'description', 'required'], inputPath);

    if (typeof input.name !== 'string' || !INPUT_NAME_REGEX.test(input.name)) {
      throw new WorkflowValidationError(
        `Input name at "${inputPath}.name" must be 1-50 characters, starting with a letter and containing alphanumeric/underscore characters.`,
        { path: `${inputPath}.name` }
      );
    }
    if (declaredInputNames.has(input.name)) {
      throw new WorkflowValidationError(`Duplicate input name "${input.name}" at "${inputPath}.name".`, {
        path: `${inputPath}.name`,
      });
    }
    declaredInputNames.add(input.name);

    if (input.type !== 'string') {
      throw new WorkflowValidationError(`Input type at "${inputPath}.type" must be "string".`, { path: `${inputPath}.type` });
    }

    if (typeof input.label !== 'string' || input.label.trim() === '' || input.label.length > 100) {
      throw new WorkflowValidationError(`Input label at "${inputPath}.label" must be a non-empty string of at most 100 characters.`, {
        path: `${inputPath}.label`,
      });
    }

    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 200)) {
      throw new WorkflowValidationError(`Input description at "${inputPath}.description" must be a string of at most 200 characters.`, {
        path: `${inputPath}.description`,
      });
    }

    if (typeof input.required !== 'boolean') {
      throw new WorkflowValidationError(`Input required flag at "${inputPath}.required" must be a boolean.`, {
        path: `${inputPath}.required`,
      });
    }
  }

  // Steps validation
  if (!Array.isArray(version.steps) || version.steps.length === 0) {
    throw new WorkflowValidationError('steps must be a non-empty array of step objects.', { path: 'steps' });
  }

  const stepIds = new Set();
  for (let i = 0; i < version.steps.length; i++) {
    const step = version.steps[i];
    const stepPath = `steps[${i}]`;
    assertExactKeys(step, ['id', 'order', 'description', 'action', 'params', 'anchor', 'verification'], stepPath);

    if (typeof step.id !== 'string' || step.id.trim() === '' || step.id.length > 64) {
      throw new WorkflowValidationError(`Step id at "${stepPath}.id" must be a non-empty string of at most 64 characters.`, {
        path: `${stepPath}.id`,
      });
    }
    if (stepIds.has(step.id)) {
      throw new WorkflowValidationError(`Duplicate step id "${step.id}" at "${stepPath}.id".`, { path: `${stepPath}.id` });
    }
    stepIds.add(step.id);

    if (!Number.isInteger(step.order) || step.order !== i + 1) {
      throw new WorkflowValidationError(
        `Step order at "${stepPath}.order" must be strictly consecutive (expected ${i + 1}, found ${step.order}).`,
        { path: `${stepPath}.order` }
      );
    }

    if (typeof step.description !== 'string' || step.description.trim() === '' || step.description.length > 200) {
      throw new WorkflowValidationError(
        `Step description at "${stepPath}.description" must be a non-empty string of at most 200 characters.`,
        { path: `${stepPath}.description` }
      );
    }

    if (step.action !== 'navigate' && step.action !== 'clickByRole' && step.action !== 'fillByLabel') {
      throw new WorkflowValidationError(
        `Unsupported action "${step.action}" at "${stepPath}.action". Supported actions: "navigate", "clickByRole", "fillByLabel".`,
        { path: `${stepPath}.action` }
      );
    }

    // Step parameters validation
    const paramsPath = `${stepPath}.params`;
    if (!step.params || typeof step.params !== 'object' || Array.isArray(step.params)) {
      throw new WorkflowValidationError(`Step params at "${paramsPath}" must be an object.`, { path: paramsPath });
    }

    if (step.action === 'navigate') {
      assertExactKeys(step.params, ['path', 'waitUntil', 'timeoutMs'], paramsPath);
      validateRelativePath(step.params.path, `${paramsPath}.path`);
      if (
        step.params.waitUntil !== undefined &&
        step.params.waitUntil !== 'domcontentloaded' &&
        step.params.waitUntil !== 'load' &&
        step.params.waitUntil !== 'networkidle'
      ) {
        throw new WorkflowValidationError(
          `Invalid waitUntil "${step.params.waitUntil}" at "${paramsPath}.waitUntil".`,
          { path: `${paramsPath}.waitUntil` }
        );
      }
      if (
        step.params.timeoutMs !== undefined &&
        (!Number.isInteger(step.params.timeoutMs) || step.params.timeoutMs < 100 || step.params.timeoutMs > 300000)
      ) {
        throw new WorkflowValidationError(
          `timeoutMs at "${paramsPath}.timeoutMs" must be an integer between 100 and 300000.`,
          { path: `${paramsPath}.timeoutMs` }
        );
      }
    } else if (step.action === 'clickByRole') {
      assertExactKeys(step.params, ['role', 'name', 'exact', 'timeoutMs'], paramsPath);
      if (typeof step.params.role !== 'string' || step.params.role.trim() === '' || step.params.role.length > 50) {
        throw new WorkflowValidationError(`role at "${paramsPath}.role" must be a non-empty string of at most 50 characters.`, {
          path: `${paramsPath}.role`,
        });
      }
      if (
        typeof step.params.name !== 'string' ||
        step.params.name.trim() === '' ||
        step.params.name.length > 100
      ) {
        throw new WorkflowValidationError(
          `name at "${paramsPath}.name" is required and must be a non-empty string of at most 100 characters for deterministic targeting.`,
          { path: `${paramsPath}.name` }
        );
      }
      if (step.params.exact !== undefined && typeof step.params.exact !== 'boolean') {
        throw new WorkflowValidationError(`exact at "${paramsPath}.exact" must be a boolean.`, { path: `${paramsPath}.exact` });
      }
      if (
        step.params.timeoutMs !== undefined &&
        (!Number.isInteger(step.params.timeoutMs) || step.params.timeoutMs < 100 || step.params.timeoutMs > 300000)
      ) {
        throw new WorkflowValidationError(
          `timeoutMs at "${paramsPath}.timeoutMs" must be an integer between 100 and 300000.`,
          { path: `${paramsPath}.timeoutMs` }
        );
      }
    } else if (step.action === 'fillByLabel') {
      // Explicitly reject any 'value' property even if undefined, null, or empty
      if (Object.prototype.hasOwnProperty.call(step.params, 'value')) {
        throw new WorkflowValidationError(
          `fillByLabel params at "${paramsPath}" must not contain a "value" property. Actual values must never be persisted.`,
          { path: `${paramsPath}.value` }
        );
      }
      assertExactKeys(step.params, ['label', 'inputName', 'exact', 'timeoutMs'], paramsPath);
      if (typeof step.params.label !== 'string' || step.params.label.trim() === '' || step.params.label.length > 100) {
        throw new WorkflowValidationError(`label at "${paramsPath}.label" must be a non-empty string of at most 100 characters.`, {
          path: `${paramsPath}.label`,
        });
      }
      if (typeof step.params.inputName !== 'string' || !declaredInputNames.has(step.params.inputName)) {
        throw new WorkflowValidationError(
          `inputName "${step.params.inputName}" at "${paramsPath}.inputName" does not reference a declared workflow input.`,
          { path: `${paramsPath}.inputName` }
        );
      }
      if (step.params.exact !== undefined && typeof step.params.exact !== 'boolean') {
        throw new WorkflowValidationError(`exact at "${paramsPath}.exact" must be a boolean.`, { path: `${paramsPath}.exact` });
      }
      if (
        step.params.timeoutMs !== undefined &&
        (!Number.isInteger(step.params.timeoutMs) || step.params.timeoutMs < 100 || step.params.timeoutMs > 300000)
      ) {
        throw new WorkflowValidationError(
          `timeoutMs at "${paramsPath}.timeoutMs" must be an integer between 100 and 300000.`,
          { path: `${paramsPath}.timeoutMs` }
        );
      }
    }

    // Anchor validation (optional)
    if (step.anchor !== null && step.anchor !== undefined) {
      const anchorPath = `${stepPath}.anchor`;
      assertExactKeys(step.anchor, ['role', 'name', 'tag', 'type', 'placeholder'], anchorPath);
      if (step.anchor.type === 'password') {
        throw new WorkflowValidationError(
          `Element anchors targeting password input types are strictly prohibited at "${anchorPath}.type".`,
          { path: `${anchorPath}.type` }
        );
      }
      for (const [k, val] of Object.entries(step.anchor)) {
        if (typeof val !== 'string' || val.length > 100) {
          throw new WorkflowValidationError(`Anchor property "${k}" at "${anchorPath}.${k}" must be a string of at most 100 characters.`, {
            path: `${anchorPath}.${k}`,
          });
        }
      }
    }

    // Step Verification predicate (optional)
    if (step.verification !== null && step.verification !== undefined) {
      validateVerificationPredicate(step.verification, `${stepPath}.verification`);
    }
  }

  // Success Criteria validation
  if (!version.successCriteria || typeof version.successCriteria !== 'object' || Array.isArray(version.successCriteria)) {
    throw new WorkflowValidationError('successCriteria must be an object.', { path: 'successCriteria' });
  }
  assertExactKeys(version.successCriteria, ['finalPath', 'pageTitle', 'textPresent', 'textAbsent'], 'successCriteria');
  const criteriaKeys = Object.keys(version.successCriteria);
  if (criteriaKeys.length === 0) {
    throw new WorkflowValidationError('successCriteria must contain at least one meaningful criterion.', { path: 'successCriteria' });
  }
  if (version.successCriteria.finalPath !== undefined) {
    validateRelativePath(version.successCriteria.finalPath, 'successCriteria.finalPath');
  }
  for (const key of ['pageTitle', 'textPresent', 'textAbsent']) {
    if (version.successCriteria[key] !== undefined) {
      const val = version.successCriteria[key];
      if (typeof val !== 'string' || val.trim() === '' || val.length > 500) {
        throw new WorkflowValidationError(`successCriteria.${key} must be a non-empty string of at most 500 characters.`, {
          path: `successCriteria.${key}`,
        });
      }
    }
  }

  return { valid: true };
}

/**
 * Validates a verification evidence record.
 *
 * @param {object} evidence
 * @returns {{ valid: boolean }}
 */
export function validateVerificationEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new WorkflowValidationError('Verification evidence must be a non-null object.');
  }

  assertExactKeys(evidence, [
    '$schema',
    'schemaVersion',
    'workflowId',
    'version',
    'contentHash',
    'runId',
    'verifiedAt',
    'environment',
    'stepResults',
    'successCriteriaResult',
  ]);

  if (evidence.$schema !== undefined && (typeof evidence.$schema !== 'string' || evidence.$schema.trim() === '')) {
    throw new WorkflowValidationError('Optional "$schema" must be a non-empty string.', { path: '$schema' });
  }

  if (evidence.schemaVersion !== '1.0.0') {
    throw new WorkflowValidationError(
      `Unsupported schemaVersion "${evidence.schemaVersion}". Only "1.0.0" is supported.`,
      { path: 'schemaVersion' }
    );
  }

  validateWorkflowId(evidence.workflowId, 'workflowId');

  if (!Number.isInteger(evidence.version) || evidence.version < 1) {
    throw new WorkflowValidationError('Evidence version must be a positive integer.', { path: 'version' });
  }

  if (typeof evidence.contentHash !== 'string' || !HEX_64_REGEX.test(evidence.contentHash)) {
    throw new WorkflowValidationError('contentHash must be a 64-character lowercase hexadecimal SHA-256 string.', {
      path: 'contentHash',
    });
  }

  if (typeof evidence.runId !== 'string' || !RUN_ID_REGEX.test(evidence.runId)) {
    throw new WorkflowValidationError('runId must be a 1-64 character string containing alphanumeric, dashes, or underscores.', {
      path: 'runId',
    });
  }

  validateTimestamp(evidence.verifiedAt, 'verifiedAt');

  // Environment validation
  if (!evidence.environment || typeof evidence.environment !== 'object' || Array.isArray(evidence.environment)) {
    throw new WorkflowValidationError('environment must be an object.', { path: 'environment' });
  }
  assertExactKeys(
    evidence.environment,
    ['targetOrigin', 'browserEngine', 'playwrightVersion', 'nodeVersion', 'platform'],
    'environment'
  );
  validateTargetOrigin(evidence.environment.targetOrigin, 'environment.targetOrigin');
  if (
    typeof evidence.environment.browserEngine !== 'string' ||
    evidence.environment.browserEngine.trim() === '' ||
    evidence.environment.browserEngine.length > 50
  ) {
    throw new WorkflowValidationError('environment.browserEngine must be a non-empty string of at most 50 characters.', {
      path: 'environment.browserEngine',
    });
  }
  for (const optKey of ['playwrightVersion', 'nodeVersion', 'platform']) {
    if (evidence.environment[optKey] !== undefined) {
      if (typeof evidence.environment[optKey] !== 'string' || evidence.environment[optKey].length > 50) {
        throw new WorkflowValidationError(`environment.${optKey} must be a string of at most 50 characters.`, {
          path: `environment.${optKey}`,
        });
      }
    }
  }

  // Step results validation
  if (!Array.isArray(evidence.stepResults) || evidence.stepResults.length === 0) {
    throw new WorkflowValidationError('stepResults must be a non-empty array of result objects.', { path: 'stepResults' });
  }

  const seenStepIds = new Set();
  for (let i = 0; i < evidence.stepResults.length; i++) {
    const res = evidence.stepResults[i];
    const resPath = `stepResults[${i}]`;
    assertExactKeys(res, ['stepId', 'action', 'ok', 'status', 'durationMs', 'verification'], resPath);

    if (typeof res.stepId !== 'string' || res.stepId.trim() === '') {
      throw new WorkflowValidationError(`stepId at "${resPath}.stepId" must be a non-empty string.`, { path: `${resPath}.stepId` });
    }

    if (seenStepIds.has(res.stepId)) {
      throw new WorkflowValidationError(`Duplicate stepId "${res.stepId}" at "${resPath}.stepId".`, {
        path: `${resPath}.stepId`,
      });
    }
    seenStepIds.add(res.stepId);

    if (res.action !== 'navigate' && res.action !== 'clickByRole' && res.action !== 'fillByLabel') {
      throw new WorkflowValidationError(`Invalid action "${res.action}" at "${resPath}.action".`, { path: `${resPath}.action` });
    }

    if (typeof res.ok !== 'boolean') {
      throw new WorkflowValidationError(
        `ok at "${resPath}.ok" must be a boolean indicating step execution success.`,
        { path: `${resPath}.ok` }
      );
    }

    if (res.status !== undefined && res.status !== null) {
      if (!Number.isInteger(res.status) || res.status < 100 || res.status > 599) {
        throw new WorkflowValidationError(`status at "${resPath}.status" must be a valid HTTP status code (100-599).`, {
          path: `${resPath}.status`,
        });
      }
    }

    if (typeof res.durationMs !== 'number' || res.durationMs < 0 || Number.isNaN(res.durationMs)) {
      throw new WorkflowValidationError(`durationMs at "${resPath}.durationMs" must be a non-negative number.`, {
        path: `${resPath}.durationMs`,
      });
    }

    if (res.verification !== null && res.verification !== undefined) {
      assertExactKeys(res.verification, ['type', 'passed'], `${resPath}.verification`);
      if (typeof res.verification.passed !== 'boolean') {
        throw new WorkflowValidationError(`verification.passed at "${resPath}.verification.passed" must be a boolean.`, {
          path: `${resPath}.verification.passed`,
        });
      }
    }
  }

  // Success criteria result
  if (
    !evidence.successCriteriaResult ||
    typeof evidence.successCriteriaResult !== 'object' ||
    Array.isArray(evidence.successCriteriaResult)
  ) {
    throw new WorkflowValidationError('successCriteriaResult must be an object.', { path: 'successCriteriaResult' });
  }
  assertExactKeys(
    evidence.successCriteriaResult,
    ['passed', 'finalPath', 'pageTitleMatched', 'textPresentFound', 'textAbsentFound', 'details'],
    'successCriteriaResult'
  );
  if (typeof evidence.successCriteriaResult.passed !== 'boolean') {
    throw new WorkflowValidationError('successCriteriaResult.passed must be a boolean.', {
      path: 'successCriteriaResult.passed',
    });
  }

  return { valid: true };
}

/**
 * Validates that a verification evidence record matches a specific workflow version and its content hash.
 *
 * @param {object} evidence - Parsed verification evidence object.
 * @param {object} version - Parsed workflow version object.
 * @param {string} computedHash - Expected SHA-256 content hash of the workflow version.
 * @returns {{ ok: boolean }}
 */
export function verifyEvidenceMatchesWorkflow(evidence, version, computedHash) {
  validateVerificationEvidence(evidence);
  validateWorkflowVersion(version);

  if (evidence.workflowId !== version.workflowId) {
    throw new WorkflowValidationError(
      `Evidence workflowId "${evidence.workflowId}" does not match version workflowId "${version.workflowId}".`,
      { path: 'workflowId' }
    );
  }

  if (evidence.version !== version.version) {
    throw new WorkflowValidationError(
      `Evidence version (${evidence.version}) does not match workflow version (${version.version}).`,
      { path: 'version' }
    );
  }

  if (evidence.contentHash !== computedHash) {
    throw new WorkflowValidationError(
      `Evidence contentHash "${evidence.contentHash}" does not match computed workflow hash "${computedHash}".`,
      { path: 'contentHash' }
    );
  }

  if (evidence.stepResults.length !== version.steps.length) {
    throw new WorkflowValidationError(
      `Evidence stepResults count (${evidence.stepResults.length}) does not match version steps count (${version.steps.length}).`,
      { path: 'stepResults' }
    );
  }

  for (let i = 0; i < version.steps.length; i++) {
    const expectedStep = version.steps[i];
    const actualResult = evidence.stepResults[i];

    if (actualResult.stepId !== expectedStep.id) {
      throw new WorkflowValidationError(
        `Evidence step at index ${i} has stepId "${actualResult.stepId}", expected "${expectedStep.id}".`,
        { path: `stepResults[${i}].stepId` }
      );
    }

    if (actualResult.action !== expectedStep.action) {
      throw new WorkflowValidationError(
        `Evidence step at index ${i} has action "${actualResult.action}", expected "${expectedStep.action}".`,
        { path: `stepResults[${i}].action` }
      );
    }

    if (actualResult.ok !== true) {
      throw new WorkflowValidationError(
        `Step "${expectedStep.id}" execution failed (ok was not true).`,
        { path: `stepResults[${i}].ok` }
      );
    }

    // If step declared verification, evidence must verify it passed
    if (expectedStep.verification) {
      if (!actualResult.verification) {
        throw new WorkflowValidationError(
          `Step "${expectedStep.id}" required verification predicate but evidence omitted verification result.`,
          { path: `stepResults[${i}].verification` }
        );
      }
      if (actualResult.verification.type !== expectedStep.verification.type) {
        throw new WorkflowValidationError(
          `Step "${expectedStep.id}" verification type "${actualResult.verification.type}" does not match expected "${expectedStep.verification.type}".`,
          { path: `stepResults[${i}].verification.type` }
        );
      }
      if (actualResult.verification.passed !== true) {
        throw new WorkflowValidationError(
          `Step "${expectedStep.id}" verification did not pass.`,
          { path: `stepResults[${i}].verification.passed` }
        );
      }
    }
  }

  if (evidence.successCriteriaResult.passed !== true) {
    throw new WorkflowValidationError('Verification evidence indicates successCriteriaResult did not pass.', {
      path: 'successCriteriaResult.passed',
    });
  }

  return { ok: true };
}
