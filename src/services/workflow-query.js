/**
 * Super Memory — Workflow Query Service (M2 Phase 1)
 *
 * Read-only operations extracted from the Operator CLI so a future local web
 * application can invoke the same behavior without terminal I/O:
 * - list
 * - inspect
 * - review
 * - integrity scan
 *
 * Design rules for this service:
 * - Dependencies are explicit: callers pass the repository (or use the
 *   factory bound to one). No CLI arguments, stdout/stderr, readline,
 *   process.exit, or terminal formatting lives here.
 * - Returns structured data. Terminal tables and progress text stay in
 *   `src/cli/operator.js`.
 * - Redaction: `reviewDraft` accepts caller-supplied secrets and redacts the
 *   returned diff string. The service never returns the secrets themselves,
 *   never logs, and never persists anything. Workflow content is returned as
 *   stored (the repository already exposes it); display-time redaction of
 *   coincidental secrets in `inspect` output remains the caller's
 *   responsibility, exactly as the CLI does today with `redactSecrets`.
 * - Read-only: this service never creates, modifies, verifies, or promotes
 *   workflows. `reviewDraft` returns `null` when no draft exists.
 */

import {
  calculateContentHash,
  redactSecrets,
  WorkflowError,
  WorkflowNotFoundError,
} from '../workflow/index.js';
import { scanRepositoryIntegrity } from '../workflow/integrity.js';

/**
 * Creates a query service bound to one repository.
 *
 * @param {object} [options]
 * @param {object} [options.repository] - Workflow repository (required).
 * @returns {{ repository: object, listWorkflows: Function, inspectWorkflow: Function, reviewDraft: Function, scanIntegrity: Function }}
 */
export function createWorkflowQueryService({ repository } = {}) {
  if (!repository) {
    throw new WorkflowError('Workflow query service requires a repository.');
  }
  return {
    repository,
    listWorkflows: (options) => listWorkflows(repository, options),
    inspectWorkflow: (workflowId) => inspectWorkflow(repository, workflowId),
    reviewDraft: (workflowId, options) => reviewDraft(repository, workflowId, options),
    scanIntegrity: () => scanIntegrity(repository),
  };
}

/**
 * Lists workflows without terminal formatting.
 *
 * @param {object} repository
 * @param {object} [options]
 * @param {boolean} [options.enabledOnly]
 * @returns {Promise<Array>} Repository listing (same shape as `repository.list`).
 */
export async function listWorkflows(repository, { enabledOnly = false } = {}) {
  return repository.list({ enabledOnly });
}

/**
 * Reads every record the CLI inspect command displays. No stdout, no secrets
 * handling here: the caller redacts display strings, as the CLI does today.
 *
 * @param {object} repository
 * @param {string} workflowId
 * @returns {Promise<{ manifest: object, activeVersion: object|null, draftVersion: object|null, activeEvidence: object|null, activeHash: string|null, draftHash: string|null, referenceVersion: object|null }>}
 */
export async function inspectWorkflow(repository, workflowId) {
  if (!workflowId) {
    throw new WorkflowError('Missing workflow ID for inspect command.');
  }

  const manifest = await repository.getManifest(workflowId);
  if (!manifest) {
    throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found in repository.`, { workflowId });
  }

  const activeVersion = manifest.activeVersion
    ? await repository.getVersion(workflowId, manifest.activeVersion)
    : null;
  const draftVersion = manifest.draftVersion
    ? await repository.getVersion(workflowId, manifest.draftVersion)
    : null;

  let activeEvidence = null;
  if (activeVersion) {
    activeEvidence = await repository.getVerificationEvidence(workflowId, activeVersion.version);
  }

  let activeHash = null;
  if (activeVersion) {
    activeHash = calculateContentHash(activeVersion);
  }
  let draftHash = null;
  if (draftVersion) {
    draftHash = calculateContentHash(draftVersion);
  }

  const referenceVersion = activeVersion || draftVersion || null;

  return {
    manifest,
    activeVersion,
    draftVersion,
    activeEvidence,
    activeHash,
    draftHash,
    referenceVersion,
  };
}

/**
 * Reads the pending draft and renders the secret-safe proposal diff.
 * Strictly read-only: never modifies the repository.
 *
 * @param {object} repository
 * @param {string} workflowId
 * @param {object} [options]
 * @param {string[]} [options.secrets] - Caller-known secrets used only for redaction.
 * @returns {Promise<{ activeVersion: object|null, draftVersion: object, diff: string }|null>} Null when no draft exists.
 */
export async function reviewDraft(repository, workflowId, { secrets = [] } = {}) {
  if (!workflowId) {
    throw new WorkflowError('Missing workflow ID for review command.');
  }

  const manifest = await repository.getManifest(workflowId);
  if (!manifest) {
    throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found in repository.`, { workflowId });
  }

  if (!manifest.draftVersion) {
    return null;
  }

  const draftVersion = await repository.getVersion(workflowId, manifest.draftVersion);
  if (!draftVersion) {
    throw new WorkflowNotFoundError(
      `Draft version ${manifest.draftVersion} for workflow "${workflowId}" not found on disk.`,
      { workflowId, version: manifest.draftVersion }
    );
  }

  const activeVersion = manifest.activeVersion
    ? await repository.getVersion(workflowId, manifest.activeVersion)
    : null;

  const diff = renderDiff(activeVersion, draftVersion, { secrets });
  return { activeVersion, draftVersion, diff };
}

/**
 * Runs a read-only integrity scan over the repository.
 *
 * @param {object} repository
 * @returns {Promise<object>} Integrity report (never modifies the repository).
 */
export async function scanIntegrity(repository) {
  return scanRepositoryIntegrity(repository.baseDir);
}

/**
 * Compares an active version and a draft version and produces a human-readable,
 * secret-safe diff identifying exact step, target, input, and success criteria changes.
 *
 * Moved verbatim from `src/cli/operator.js` (M2 Phase 1) so both the service
 * and the CLI render identical diffs. The CLI re-exports this symbol to
 * preserve its existing import surface.
 *
 * @param {object|null} activeVersion
 * @param {object} draftVersion
 * @param {object} [options]
 * @param {string[]} [options.secrets]
 * @returns {string}
 */
export function renderDiff(activeVersion, draftVersion, { secrets = [] } = {}) {
  const out = [];

  out.push('================================================================================');
  out.push(`REPAIR PROPOSAL REVIEW: ${draftVersion.workflowId}`);
  out.push('================================================================================');
  out.push(`Draft Version:   v${draftVersion.version}`);
  out.push(`Parent Version:  ${draftVersion.parentVersion ? `v${draftVersion.parentVersion}` : 'none'}`);
  out.push(`Active Version:  ${activeVersion ? `v${activeVersion.version}` : 'none (draft-only)'}`);
  out.push(`Change Summary:  ${redactSecrets(draftVersion.changeSummary || '(no summary provided)', secrets)}`);

  let draftHash = 'unknown';
  let activeHash = null;
  try {
    draftHash = calculateContentHash(draftVersion);
  } catch {}
  if (activeVersion) {
    try {
      activeHash = calculateContentHash(activeVersion);
    } catch {}
  }
  out.push(`Content Hash:    ${activeHash ? `${activeHash.slice(0, 16)}... -> ` : ''}${draftHash.slice(0, 16)}...`);

  if (!activeVersion) {
    out.push('\n--- Initial Draft Version (No parent active version to diff against) ---');
    for (const step of draftVersion.steps || []) {
      const stepId = redactSecrets(step.id || '', secrets);
      const stepParams = redactSecrets(JSON.stringify(step.params || {}), secrets);
      const stepDesc = step.description ? ` (${redactSecrets(step.description, secrets)})` : '';
      out.push(`  [Added Step ${step.order}] ${step.action} (${stepId})${stepDesc}: ${stepParams}`);
    }
    out.push('================================================================================');
    return out.join('\n');
  }

  // 1. Step Changes
  out.push('\n--- Step Changes ---');
  const activeSteps = activeVersion.steps || [];
  const draftSteps = draftVersion.steps || [];
  const maxSteps = Math.max(activeSteps.length, draftSteps.length);

  let hasStepChanges = false;
  for (let i = 0; i < maxSteps; i++) {
    const a = activeSteps[i];
    const d = draftSteps[i];

    if (a && d) {
      const aJson = JSON.stringify({ action: a.action, description: a.description, params: a.params, verification: a.verification });
      const dJson = JSON.stringify({ action: d.action, description: d.description, params: d.params, verification: d.verification });

      if (aJson === dJson && a.id === d.id) {
        const dId = redactSecrets(d.id || '', secrets);
        const dParams = formatStepParams(d.params, secrets);
        out.push(`  [Unchanged] Step ${d.order} (${dId}): ${d.action} ${dParams}`);
      } else {
        hasStepChanges = true;
        const dId = redactSecrets(d.id || '', secrets);
        out.push(`  [Modified]  Step ${d.order} (${dId}):`);
        if (a.action !== d.action) {
          out.push(`    - action: ${a.action}`);
          out.push(`    + action: ${d.action}`);
        }
        if (a.description !== d.description) {
          out.push(`    - description: ${redactSecrets(a.description || '', secrets)}`);
          out.push(`    + description: ${redactSecrets(d.description || '', secrets)}`);
        }
        if (JSON.stringify(a.params) !== JSON.stringify(d.params)) {
          out.push(`    - target: ${redactSecrets(JSON.stringify(a.params || {}), secrets)}`);
          out.push(`    + target: ${redactSecrets(JSON.stringify(d.params || {}), secrets)}`);
        }
        if (JSON.stringify(a.verification) !== JSON.stringify(d.verification)) {
          out.push(`    - verification: ${redactSecrets(JSON.stringify(a.verification || null), secrets)}`);
          out.push(`    + verification: ${redactSecrets(JSON.stringify(d.verification || null), secrets)}`);
        }
      }
    } else if (!a && d) {
      hasStepChanges = true;
      const dId = redactSecrets(d.id || '', secrets);
      const dParams = redactSecrets(JSON.stringify(d.params || {}), secrets);
      out.push(`  [Added]     Step ${d.order} (${dId}): ${d.action} ${dParams}`);
      if (d.description) {
        out.push(`              description: ${redactSecrets(d.description, secrets)}`);
      }
      if (d.verification) {
        out.push(`              verification: ${redactSecrets(JSON.stringify(d.verification), secrets)}`);
      }
    } else if (a && !d) {
      hasStepChanges = true;
      const aId = redactSecrets(a.id || '', secrets);
      const aParams = redactSecrets(JSON.stringify(a.params || {}), secrets);
      out.push(`  [Removed]   Step ${a.order} (${aId}): ${a.action} ${aParams}`);
      if (a.description) {
        out.push(`              description: ${redactSecrets(a.description, secrets)}`);
      }
      if (a.verification) {
        out.push(`              verification: ${redactSecrets(JSON.stringify(a.verification), secrets)}`);
      }
    }
  }

  if (!hasStepChanges && activeSteps.length === draftSteps.length) {
    out.push('  (No step differences detected)');
  }

  // 2. Target Changes
  out.push('\n--- Target Changes ---');
  const aTarget = activeVersion.target || {};
  const dTarget = draftVersion.target || {};
  let targetChanged = false;
  if (aTarget.origin !== dTarget.origin) {
    targetChanged = true;
    out.push(`  - origin: ${redactSecrets(aTarget.origin || '', secrets)}`);
    out.push(`  + origin: ${redactSecrets(dTarget.origin || '', secrets)}`);
  }
  if (aTarget.startPath !== dTarget.startPath) {
    targetChanged = true;
    out.push(`  - startPath: ${redactSecrets(aTarget.startPath || '', secrets)}`);
    out.push(`  + startPath: ${redactSecrets(dTarget.startPath || '', secrets)}`);
  }
  if (!targetChanged) {
    out.push('  (No target changes)');
  }

  // 3. Input Declaration Changes
  out.push('\n--- Input Changes ---');
  const aInputs = JSON.stringify(activeVersion.inputs || []);
  const dInputs = JSON.stringify(draftVersion.inputs || []);
  if (aInputs !== dInputs) {
    out.push(`  - inputs: ${redactSecrets(aInputs, secrets)}`);
    out.push(`  + inputs: ${redactSecrets(dInputs, secrets)}`);
  } else {
    out.push('  (No input declaration changes)');
  }

  // 4. Success Criteria Changes
  out.push('\n--- Success Criteria Changes ---');
  const aSC = JSON.stringify(activeVersion.successCriteria || {});
  const dSC = JSON.stringify(draftVersion.successCriteria || {});
  if (aSC !== dSC) {
    out.push(`  - criteria: ${redactSecrets(aSC, secrets)}`);
    out.push(`  + criteria: ${redactSecrets(dSC, secrets)}`);
  } else {
    out.push('  (No success criteria changes)');
  }

  out.push('\nStatus: UNAPPROVED DRAFT (Untrusted until trialed and explicitly promoted)');
  out.push('================================================================================');

  return out.join('\n');
}

function formatStepParams(params, secrets = []) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  if (params.role) parts.push(`role: "${redactSecrets(params.role, secrets)}"`);
  if (params.name) parts.push(`name: "${redactSecrets(params.name, secrets)}"`);
  if (params.label) parts.push(`label: "${redactSecrets(params.label, secrets)}"`);
  if (params.inputName) parts.push(`inputName: "${redactSecrets(params.inputName, secrets)}"`);
  return parts.length > 0 ? `(${parts.join(', ')})` : '';
}
