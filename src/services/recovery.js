/**
 * Super Memory — Workflow Recovery Service (M2 Phase 5)
 *
 * Failure diagnosis and repair orchestration extracted from the Operator CLI
 * so a future local application can recover failed workflows without
 * invoking CLI commands:
 * - diagnose: run the active version and decide whether repair is needed
 * - repair: diagnose, generate a validated repair proposal, create a draft
 *
 * Design rules for this service:
 * - Dependencies are explicit: the repository and an execution service
 *   exposing `playWorkflow` (for diagnostic playback). No browser runtime,
 *   no terminal I/O, no prompts, no exit codes here.
 * - Browser execution is delegated to the injected Execution Service; this
 *   module never instantiates `WorkflowPlayer` directly, so there is exactly
 *   one playback path. Trial execution, evidence staging, approval, and
 *   promotion stay with their own services and the caller.
 * - Reuses the existing repair domain without duplicating it:
 *   `generateRepairProposal` (prompt, parse, structural validation, and
 *   DOM grounding) and `applyRepairToDraft` (draft creation with the
 *   active version untouched and criteria/bindings preserved) from
 *   `src/workflow/repair.js` remain the implementations of record.
 * - Diagnostic preference order is preserved: the player-attached
 *   `runResult.diagnostic` (built from the live failed page) wins;
 *   otherwise the existing `collectFailureDiagnostic` fallback runs with
 *   `session: null`. Nothing is fabricated when no snapshot exists —
 *   ungroundable proposals are then rejected by the grounding gate.
 * - The model provider is always caller-supplied (or null for the domain's
 *   default resolution). Provider-string parsing and fixture-specific mocks
 *   stay in the CLI adapter. Tests inject mock providers; no live inference
 *   happens here.
 * - Secrets travel only as redaction context: they are used for diagnostic
 *   redaction and draft-summary redaction and are never returned, logged,
 *   or persisted by this service.
 */

import {
  WorkflowError,
  WorkflowNotFoundError,
} from '../workflow/index.js';
import { collectFailureDiagnostic } from '../workflow/diagnostics.js';
import {
  applyRepairToDraft,
  generateRepairProposal,
} from '../workflow/repair.js';

/**
 * Creates a recovery service bound to one repository context.
 *
 * @param {object} [options]
 * @param {object} [options.repository] - Workflow repository (required).
 * @param {object} [options.execution] - Execution service exposing
 *   `playWorkflow({ workflowId, inputs })` (required).
 * @returns {{ repository: object, diagnoseFailure: Function, proposeRepair: Function }}
 */
export function createRecoveryService({ repository, execution } = {}) {
  if (!repository) {
    throw new WorkflowError('Recovery service requires a repository.');
  }
  if (!execution || typeof execution.playWorkflow !== 'function') {
    throw new WorkflowError('Recovery service requires an execution service.');
  }
  const context = { repository, execution };
  return {
    get repository() {
      return context.repository;
    },
    diagnoseFailure: (options) => diagnoseFailure(context, options),
    proposeRepair: (options) => proposeRepair(context, options),
  };
}

/**
 * Runs the active version and decides whether repair is needed. Makes no
 * model calls.
 *
 * @param {object} context - Service context (see factory).
 * @param {object} [options]
 * @param {string} [options.workflowId]
 * @param {Record<string, string>} [options.inputs] - Already-resolved inputs.
 * @param {Array<string>} [options.secrets] - Redaction context for the
 *   fallback diagnostic path.
 * @returns {Promise<{ repairNeeded: boolean, reason?: string, runResult: object, diagnostic?: object, activeVersion?: object }>}
 */
export async function diagnoseFailure(context, { workflowId, inputs = {}, secrets = [] } = {}) {
  if (!workflowId) {
    throw new WorkflowError('Missing workflow ID for repair command.');
  }

  const manifest = await context.repository.getManifest(workflowId);
  if (!manifest) {
    throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found.`, { workflowId });
  }

  if (!manifest.activeVersion) {
    throw new WorkflowError(`Workflow "${workflowId}" has no active verified version to repair.`);
  }

  const activeVersion = await context.repository.getVersion(workflowId, manifest.activeVersion);

  const runResult = await context.execution.playWorkflow({ workflowId, inputs });

  if (runResult.ok) {
    return { repairNeeded: false, reason: 'active_passed', runResult };
  }

  const failedStep = activeVersion.steps?.find((s) => s.id === runResult.failedStepId) || null;
  const diagnostic =
    runResult.diagnostic ||
    (await collectFailureDiagnostic({
      workflowId,
      version: activeVersion.version,
      error: runResult.error,
      failedStep,
      session: null,
      secrets,
    }));

  return { repairNeeded: true, runResult, diagnostic, activeVersion };
}

/**
 * Diagnoses a failure and, when needed, generates a validated repair
 * proposal and creates an unapproved draft. The active version is never
 * modified; trial and promotion remain the caller's explicit next steps.
 *
 * @param {object} context - Service context (see factory).
 * @param {object} [options]
 * @param {string} [options.workflowId]
 * @param {Record<string, string>} [options.inputs] - Already-resolved inputs.
 * @param {object|null} [options.provider] - Resolved model-provider instance
 *   (or null for the domain's default resolution).
 * @param {number} [options.retries] - Retry attempts for transient errors.
 * @param {Array<string>} [options.secrets] - Redaction context.
 * @returns {Promise<{ repaired: boolean, reason?: string, draft?: object, proposal?: object, diagnostic?: object, runResult?: object }>}
 */
export async function proposeRepair(
  context,
  { workflowId, inputs = {}, provider = null, retries, secrets = [] } = {}
) {
  const diagnosis = await diagnoseFailure(context, { workflowId, inputs, secrets });

  if (!diagnosis.repairNeeded) {
    return { repaired: false, reason: 'active_passed', runResult: diagnosis.runResult };
  }

  const { diagnostic, activeVersion, runResult } = diagnosis;

  const proposalResult = await generateRepairProposal(
    provider,
    diagnostic,
    activeVersion,
    retries !== undefined ? { retries } : {}
  );
  const proposal = proposalResult.proposal;

  const draft = await applyRepairToDraft(context.repository, proposal, {
    changeSummary: proposal.suspectedCause,
    secrets,
  });

  return { repaired: true, draft, proposal, diagnostic, runResult };
}
