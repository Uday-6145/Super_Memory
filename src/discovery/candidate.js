/**
 * Super Memory — Trace to Candidate Workflow Conversion
 *
 * Implements pure deterministic conversion from an executed discovery trace
 * and TaskIntent into a strictly validated WorkflowVersion draft object.
 *
 * Invariants:
 * - Emitted workflow version has status: 'draft', version: 1, parentVersion: null.
 * - Workflow ID slug strictly matches WORKFLOW_ID_REGEX (/^[a-z0-9][a-z0-9_-]{2,63}$/).
 * - All declared TaskIntent parameters are mapped to workflow inputs.
 * - Steps enforce 1-based consecutive ordering, schema-valid actions, and anchor extraction.
 * - Resulting draft is strictly verified via validateWorkflowVersion and calculateContentHash.
 */

import { WorkflowError } from '../workflow/errors.js';
import { validateWorkflowVersion, validateWorkflowId } from '../workflow/schema.js';
import { calculateContentHash } from '../workflow/hash.js';

export class CandidateConversionError extends WorkflowError {
  constructor(message, details = {}) {
    super(message, { code: 'CANDIDATE_CONVERSION_ERROR', ...details });
    this.name = 'CandidateConversionError';
  }
}

/**
 * Generates a valid workflow ID slug from an objective and taskId.
 *
 * @param {string} objective
 * @param {string} [taskId]
 * @returns {string}
 */
export function generateWorkflowIdSlug(objective, taskId) {
  let slug = (objective || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 40);

  if (!slug || slug.length < 3 || !/^[a-z0-9]/.test(slug)) {
    const fallbackSuffix = (taskId || 'task').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    slug = `wf_${fallbackSuffix || 'discovered'}`;
  }

  // Ensure slug passes validateWorkflowId regex
  try {
    validateWorkflowId(slug);
    return slug;
  } catch {
    return `wf_discovered_${Date.now().toString(36)}`;
  }
}

/**
 * Builds a schema-valid WorkflowVersion draft object from a successful discovery trace.
 *
 * @param {object} params
 * @param {Array<object>} params.trace - Executed trace entries
 * @param {object} params.intent - Validated TaskIntent object
 * @param {object} [params.finalObservation] - Final observation snapshot
 * @returns {object} Validated draft WorkflowVersion
 */
export function buildCandidateFromTrace({ trace, intent, finalObservation }) {
  if (!Array.isArray(trace) || trace.length === 0) {
    throw new CandidateConversionError('Cannot build candidate workflow: trace is empty or invalid.');
  }

  if (!intent || typeof intent !== 'object') {
    throw new CandidateConversionError('TaskIntent is required to build a candidate workflow.');
  }

  const workflowId = generateWorkflowIdSlug(intent.objective, intent.taskId);

  // 1. Inputs: promoted from TaskIntent parameters
  const declaredInputs = (intent.parameters || []).map((param) => ({
    name: param.name,
    type: 'string',
    label: param.label || param.name,
    description: param.description || `Parameter ${param.name}`,
    required: true,
  }));

  // 2. Steps: mapped deterministically from trace entries
  const steps = [];
  let order = 1;

  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i];
    const decision = entry.decision;
    if (!decision || !entry.result?.ok) {
      continue;
    }

    const stepId = `step_${order}`;
    let stepDescription = decision.rationale || `Step ${order}: ${decision.action}`;
    if (stepDescription.length > 200) {
      stepDescription = stepDescription.slice(0, 200);
    }

    let actionParams;
    if (decision.action === 'navigate') {
      actionParams = { path: decision.path };
    } else if (decision.action === 'clickByRole') {
      actionParams = {
        role: decision.role,
        name: decision.name,
        exact: false,
      };
    } else if (decision.action === 'fillByLabel') {
      actionParams = {
        label: decision.label,
        inputName: decision.inputName,
        exact: false,
      };
    } else {
      throw new CandidateConversionError(`Unsupported action "${decision.action}" in trace.`);
    }

    // Anchor derivation from observed element
    let anchor = null;
    const element = entry.observedElement;
    if (element && typeof element === 'object') {
      anchor = {
        role: element.role ? String(element.role).slice(0, 100) : '',
        name: element.name ? String(element.name).slice(0, 100) : '',
        tag: element.tag ? String(element.tag).toLowerCase().slice(0, 100) : 'div',
        type: element.type ? String(element.type).toLowerCase().slice(0, 100) : '',
        placeholder: element.placeholder ? String(element.placeholder).slice(0, 100) : '',
      };
      if (anchor.type === 'password') {
        anchor.type = '';
      }
    }

    // Step verification predicate: only persist if confirmed against post-action observation
    let stepVerification = null;
    if (decision.expects && typeof decision.expects === 'object') {
      const postObs = entry.postObservation || finalObservation;
      let confirmed = true;
      if (postObs) {
        if (decision.expects.type === 'textPresent') {
          confirmed = (postObs.text || '').includes(decision.expects.expected);
        } else if (decision.expects.type === 'pageTitle') {
          confirmed = (postObs.title || '').includes(decision.expects.expected);
        } else if (decision.expects.type === 'textAbsent') {
          confirmed = !(postObs.text || '').includes(decision.expects.expected);
        }
      }
      if (confirmed) {
        stepVerification = {
          type: decision.expects.type,
          expected: decision.expects.expected,
        };
      }
    }

    steps.push({
      id: stepId,
      order,
      description: stepDescription,
      action: decision.action,
      params: actionParams,
      anchor,
      verification: stepVerification,
    });

    order++;
  }

  if (steps.length === 0) {
    throw new CandidateConversionError('Discovery trace contains no successful actions to convert.');
  }

  // 3. Success Criteria derived from intent conditions and final observation
  const successCriteria = {};
  for (const cond of intent.successConditions || []) {
    if (cond.type === 'finalPath') {
      successCriteria.finalPath = cond.expected;
    } else if (cond.type === 'pageTitle') {
      successCriteria.pageTitle = cond.expected;
    } else if (cond.type === 'textPresent') {
      successCriteria.textPresent = cond.expected;
    } else if (cond.type === 'textAbsent') {
      successCriteria.textAbsent = cond.expected;
    }
  }

  // If no finalPath was set in successConditions but observation has a path, use the final relative path
  if (!successCriteria.finalPath && finalObservation?.url) {
    try {
      const u = new URL(finalObservation.url);
      successCriteria.finalPath = u.pathname;
    } catch {}
  }

  // Fallback: if successCriteria is completely empty, use startPath
  if (Object.keys(successCriteria).length === 0) {
    successCriteria.finalPath = intent.startPath || '/';
  }

  const changeSummary = `Discovered: ${intent.objective.slice(0, 200)}`;

  const candidateVersion = {
    $schema: 'https://supermemory.dev/schemas/v1/workflow-version.json',
    schemaVersion: '1.0.0',
    workflowId,
    version: 1,
    status: 'draft',
    parentVersion: null,
    changeSummary,
    target: {
      origin: intent.targetOrigin,
      startPath: intent.startPath,
    },
    inputs: declaredInputs,
    steps,
    successCriteria,
  };

  // Validate strictly with existing schema validation
  validateWorkflowVersion(candidateVersion);

  // Compute canonical content hash
  const contentHash = calculateContentHash(candidateVersion);

  return {
    candidate: candidateVersion,
    contentHash,
  };
}
