/**
 * Super Memory — Promotion Service (M2 Phase 4)
 *
 * Explicit promotion orchestration extracted from the Operator CLI so a
 * future local web application can approve and promote verified drafts
 * without invoking CLI commands:
 * - preview: validate everything and return display data (no side effects)
 * - promote: validate again, require explicit authorization, snapshot,
 *   mark verified, audit, and clean up staged evidence
 *
 * Design rules for this service:
 * - Dependencies are explicit: the repository, a maintenance service (for
 *   the pre-promotion safety snapshot), and an audit sink. No CLI arguments,
 *   stdout/stderr, readline, process.exit, or terminal formatting lives here.
 * - Returns structured results. Preview text, confirmation prompts, progress
 *   text, and exit codes stay in `src/cli/operator.js`.
 * - Reuses the existing domain validation without duplicating algorithms:
 *   `validateVerificationEvidence`, `verifyEvidenceMatchesWorkflow`, content
 *   hashing, and the repository's own `markVerified` lifecycle (which
 *   re-validates evidence, binding, and hashes atomically).
 * - Evidence identity is never assumed: schema, workflow ID, version, content
 *   hash, step success, and success-criteria success are all re-verified from
 *   disk on every call. A failed or incomplete trial can never promote.
 * - Authorization is explicit: `confirm` must be `true` or exactly
 *   `PROMOTE <workflowId>` (surrounding whitespace ignored). Anything else —
 *   including an absent value, since the service never prompts — returns
 *   `{ promoted: false, reason: 'cancelled' }` with no side effects. There
 *   is no automatic-approval path.
 * - Pre-promotion snapshots go through the injected maintenance service;
 *   snapshot failure aborts before anything changes with the historical
 *   error. Audit is best-effort and allow-listed; raw secrets are never
 *   accepted, returned, logged, or persisted here.
 * - No browser runtime or model provider is required or accepted.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  WorkflowError,
  WorkflowNotFoundError,
  WorkflowValidationError,
  calculateContentHash,
  validateVerificationEvidence,
  verifyEvidenceMatchesWorkflow,
} from '../workflow/index.js';
import { getStagedEvidencePath } from './execution.js';

/**
 * Creates a promotion service bound to one repository context.
 *
 * @param {object} [options]
 * @param {object} [options.repository] - Workflow repository (required).
 * @param {object} [options.maintenance] - Maintenance service exposing
 *   `snapshotBeforePromotion()` (required).
 * @param {Function} [options.audit] - Optional audit sink with the CLI
 *   `_audit(event, { managedOnly })` contract. Invoked best-effort.
 * @returns {{ repository: object, previewPromotion: Function, promote: Function }}
 */
export function createPromotionService({ repository, maintenance, audit = null } = {}) {
  if (!repository) {
    throw new WorkflowError('Promotion service requires a repository.');
  }
  if (!maintenance || typeof maintenance.snapshotBeforePromotion !== 'function') {
    throw new WorkflowError('Promotion service requires a maintenance service.');
  }
  const context = { repository, maintenance, audit };
  return {
    get repository() {
      return context.repository;
    },
    previewPromotion: (options) => previewPromotion(context, options),
    promote: (options) => promote(context, options),
  };
}

/**
 * Best-effort audit emission. Audit failures never break the operation they
 * describe, matching CLI `_audit` semantics.
 */
async function auditSafe(context, event, options) {
  if (typeof context.audit !== 'function') return;
  try {
    await context.audit(event, options);
  } catch {}
}

/**
 * Loads the verification evidence for a draft: the caller-supplied object
 * when present, otherwise the file at the explicit path or the default
 * staged-evidence location. Never trusts a path merely because it exists;
 * the bytes are fully validated by the caller.
 *
 * The load location is intentionally NOT returned: cleanup after a
 * successful promotion is restricted to the service-owned internal staged
 * path, and a caller-supplied `evidencePath` must never be deleted.
 *
 * @returns {Promise<object>} The evidence object.
 */
async function loadEvidence(context, workflowId, draftVersion, { evidence = null, evidencePath = null } = {}) {
  if (evidence) {
    return evidence;
  }
  const evidenceSourcePath = evidencePath
    ? path.resolve(evidencePath)
    : getStagedEvidencePath(context.repository.baseDir, workflowId, draftVersion.version);
  try {
    const raw = await fs.readFile(evidenceSourcePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new WorkflowError(
      `No trial verification evidence found for draft v${draftVersion.version} at "${evidenceSourcePath}". ` +
        `Draft must be trialed successfully via "super-memory trial ${workflowId} --inputs <file>" before promotion.`
    );
  }
}

/**
 * Fetches the manifest and draft and validates the complete evidence chain:
 * schema, workflow binding, version binding, content-hash binding, step
 * success, and success-criteria success.
 *
 * @returns {Promise<{ manifest: object, draftVersion: object, evidence: object, computedHash: string }>}
 */
async function validatePromotionPrerequisites(context, workflowId, { evidence = null, evidencePath = null } = {}) {
  if (!workflowId) {
    throw new WorkflowError('Missing workflow ID for promote command.');
  }

  const manifest = await context.repository.getManifest(workflowId);
  if (!manifest) {
    throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found in repository.`, { workflowId });
  }

  if (!manifest.draftVersion) {
    throw new WorkflowError(`Workflow "${workflowId}" has no draft version to promote.`);
  }

  const draftVersion = await context.repository.getVersion(workflowId, manifest.draftVersion);
  if (!draftVersion) {
    throw new WorkflowNotFoundError(
      `Draft version ${manifest.draftVersion} for workflow "${workflowId}" not found on disk.`,
      { workflowId, version: manifest.draftVersion }
    );
  }

  const resolved = await loadEvidence(context, workflowId, draftVersion, {
    evidence,
    evidencePath,
  });

  // Validate evidence schema and invariants.
  validateVerificationEvidence(resolved);

  if (resolved.workflowId !== workflowId) {
    throw new WorkflowValidationError(
      `Verification evidence workflowId ("${resolved.workflowId}") does not match target workflow ("${workflowId}").`
    );
  }

  if (resolved.version !== draftVersion.version) {
    throw new WorkflowValidationError(
      `Verification evidence version (v${resolved.version}) does not match draft version (v${draftVersion.version}).`
    );
  }

  // Recompute current disk content hash and verify against evidence.
  const computedHash = calculateContentHash(draftVersion);
  verifyEvidenceMatchesWorkflow(resolved, draftVersion, computedHash);

  // Require all steps to have passed and criteria passed.
  if (!resolved.successCriteriaResult || !resolved.successCriteriaResult.passed) {
    throw new WorkflowValidationError('Cannot promote draft: trial evidence reports that success criteria failed.');
  }

  for (const sr of resolved.stepResults || []) {
    if (!sr.ok) {
      throw new WorkflowValidationError(`Cannot promote draft: step "${sr.stepId}" failed during trial verification.`);
    }
  }

  return { manifest, draftVersion, evidence: resolved, computedHash };
}

/**
 * Validates everything promotion requires and returns the display data,
 * without side effects: no snapshot, no promotion, no audit, no cleanup.
 *
 * @param {object} context - Service context (see factory).
 * @param {object} [options]
 * @param {string} [options.workflowId]
 * @param {object} [options.evidence] - Caller-supplied evidence object.
 * @param {string} [options.evidencePath] - Explicit evidence file.
 * @returns {Promise<{ manifest: object, draftVersion: object, evidence: object, computedHash: string, confirmationPhrase: string }>}
 */
export async function previewPromotion(context, { workflowId, evidence = null, evidencePath = null } = {}) {
  const { manifest, draftVersion, evidence: resolved, computedHash } = await validatePromotionPrerequisites(
    context,
    workflowId,
    { evidence, evidencePath }
  );
  return {
    manifest,
    draftVersion,
    evidence: resolved,
    computedHash,
    confirmationPhrase: `PROMOTE ${workflowId}`,
  };
}

/**
 * Returns true only for explicit operator authorization: boolean `true`
 * (non-interactive acceptance) or exactly `PROMOTE <workflowId>`
 * (surrounding whitespace ignored). Every other value — including an
 * absent one, since the service never prompts — is a refusal.
 */
export function isExplicitlyConfirmed(confirm, workflowId) {
  if (confirm === undefined || confirm === null) {
    return false;
  }
  if (typeof confirm === 'string' && confirm.trim() === `PROMOTE ${workflowId}`) {
    return true;
  }
  if (confirm === true) {
    return true;
  }
  return false;
}

/**
 * Promotes the current draft after re-validating the full evidence chain
 * from disk, requiring explicit authorization, snapshotting via the
 * maintenance service, marking verified, auditing, and cleaning up the
 * service-owned internal staged evidence file (never a caller-owned path).
 *
 * @param {object} context - Service context (see factory).
 * @param {object} [options]
 * @param {string} [options.workflowId]
 * @param {object} [options.evidence] - Caller-supplied evidence object.
 * @param {string} [options.evidencePath] - Explicit evidence file.
 * @param {string|boolean} [options.confirm] - Explicit authorization.
 * @returns {Promise<{ promoted: boolean, reason?: string, manifest?: object, version?: object, evidence?: object, computedHash?: string }>}
 */
export async function promote(context, { workflowId, evidence = null, evidencePath = null, confirm } = {}) {
  const { manifest, draftVersion, evidence: resolved, computedHash } =
    await validatePromotionPrerequisites(context, workflowId, { evidence, evidencePath });

  if (!isExplicitlyConfirmed(confirm, workflowId)) {
    return { promoted: false, reason: 'cancelled' };
  }

  // Managed repositories are snapshotted before promotion; snapshot failure
  // aborts before anything changes.
  await context.maintenance.snapshotBeforePromotion();

  // Atomic promotion through validated repository lifecycle (re-validates).
  const promotionResult = await context.repository.markVerified(workflowId, draftVersion.version, resolved);
  await auditSafe(context, {
    type: 'promotion',
    workflowId,
    version: draftVersion.version,
    contentHash: resolved.contentHash,
  });

  // Clean up the service-owned internal staged evidence file, if present.
  // A caller-supplied `evidencePath` is caller-owned and must never be
  // deleted, even though its bytes were used for this promotion. Stale
  // internal staged evidence from an earlier trial is still removed, since
  // it is eligible for promotion and the draft just left draft status.
  // Best-effort: cleanup failure never reverses a completed promotion.
  try {
    await fs.unlink(getStagedEvidencePath(context.repository.baseDir, workflowId, draftVersion.version));
  } catch {}

  return {
    promoted: true,
    manifest: promotionResult.manifest,
    version: promotionResult.version,
    evidence: promotionResult.evidence,
    computedHash,
  };
}
