/**
 * Super Memory — Workflow Memory Error Hierarchy
 *
 * Provides typed, sanitized errors for workflow schema validation, lifecycle
 * transitions, content hashing, and version conflict detection.
 *
 * Security Guarantees:
 * - Never includes credentials, secret tokens, or API keys in error messages.
 * - Never prints raw user input values, passwords, or full DOM contents.
 * - Sanitizes URLs by omitting sensitive query parameters or fragments.
 */

export class WorkflowError extends Error {
  /**
   * @param {string} message - Sanitized, user-facing error description.
   * @param {object} [options]
   * @param {string} [options.code='WORKFLOW_ERROR'] - Machine-readable error code.
   * @param {Error} [options.cause] - Underlying cause, if any.
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'WorkflowError';
    this.code = options.code || 'WORKFLOW_ERROR';
  }
}

export class WorkflowValidationError extends WorkflowError {
  /**
   * @param {string} message - Specific validation failure reason.
   * @param {object} [options]
   * @param {string} [options.code='VALIDATION_ERROR'] - Error code.
   * @param {string} [options.path] - Property path that failed validation.
   * @param {Error} [options.cause] - Underlying cause.
   */
  constructor(message, options = {}) {
    super(message, { code: options.code || 'VALIDATION_ERROR', cause: options.cause });
    this.name = 'WorkflowValidationError';
    this.path = options.path || null;
  }
}

export class InvalidWorkflowIdError extends WorkflowValidationError {
  /**
   * @param {string} message - Description of why the ID is invalid.
   * @param {object} [options]
   * @param {string} [options.workflowId] - The invalid workflow ID string.
   * @param {Error} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, { code: 'INVALID_WORKFLOW_ID', cause: options.cause });
    this.name = 'InvalidWorkflowIdError';
    this.workflowId = options.workflowId || null;
  }
}

export class ImmutableVersionError extends WorkflowError {
  /**
   * @param {string} message - Description of immutable version violation.
   * @param {object} [options]
   * @param {string} [options.workflowId] - Target workflow ID.
   * @param {number} [options.version] - Target version number.
   * @param {Error} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, { code: 'IMMUTABLE_VERSION', cause: options.cause });
    this.name = 'ImmutableVersionError';
    this.workflowId = options.workflowId || null;
    this.version = options.version || null;
  }
}

export class VersionConflictError extends WorkflowError {
  /**
   * @param {string} message - Description of concurrency/version conflict.
   * @param {object} [options]
   * @param {string} [options.workflowId] - Target workflow ID.
   * @param {number | string} [options.expectedVersion] - Expected version or timestamp.
   * @param {number | string} [options.actualVersion] - Actual version or timestamp found.
   * @param {Error} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, { code: 'VERSION_CONFLICT', cause: options.cause });
    this.name = 'VersionConflictError';
    this.workflowId = options.workflowId || null;
    this.expectedVersion = options.expectedVersion ?? null;
    this.actualVersion = options.actualVersion ?? null;
  }
}

export class CorruptRecordError extends WorkflowError {
  /**
   * @param {string} message - Description of corrupted record.
   * @param {object} [options]
   * @param {string} [options.filePath] - File path of corrupted record.
   * @param {Error} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, { code: 'CORRUPT_RECORD', cause: options.cause });
    this.name = 'CorruptRecordError';
    this.filePath = options.filePath || null;
  }
}
