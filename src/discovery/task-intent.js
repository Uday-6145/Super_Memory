/**
 * Super Memory — Task Intent Module (Discovery Engine)
 *
 * Defines and strictly validates the TaskIntent structure representing
 * a user's natural language goal, target origin, parameters, constraints,
 * and success criteria.
 *
 * Security & Integrity Invariants:
 * - Hand-rolled exact-key validator (mirroring schema.js and repair.js).
 * - Target origins must be canonical http/https without paths, queries, or credentials.
 * - Parameters are mapped to string inputs only (no arbitrary JSON objects).
 * - TaskIntent is discovery-side metadata; it does NOT mutate or violate workflow schema.
 */

import { WorkflowError } from '../workflow/errors.js';
import { validateTargetOrigin, validateRelativePath } from '../workflow/schema.js';

export class TaskIntentError extends WorkflowError {
  constructor(message, details = {}) {
    super(message, { code: 'TASK_INTENT_ERROR', ...details });
    this.name = 'TaskIntentError';
    this.path = details.path || null;
  }
}

const ALLOWED_CONDITION_TYPES = new Set(['finalPath', 'pageTitle', 'textPresent', 'textAbsent']);

/**
 * Validates a TaskIntent object strictly against exact keys and schema constraints.
 *
 * @param {object} intent - Candidate TaskIntent object
 * @returns {{ valid: boolean }}
 */
export function validateTaskIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new TaskIntentError('TaskIntent must be a non-null object.');
  }

  const allowedKeys = new Set([
    'taskId',
    'objective',
    'targetOrigin',
    'startPath',
    'parameters',
    'constraints',
    'successConditions',
    'approvalRequired',
    'forbidden',
  ]);

  for (const key of Object.keys(intent)) {
    if (!allowedKeys.has(key)) {
      throw new TaskIntentError(`Unknown field "${key}" in TaskIntent.`, { path: key });
    }
  }

  // 1. taskId: non-empty string, <= 64 chars
  if (typeof intent.taskId !== 'string' || intent.taskId.trim() === '' || intent.taskId.length > 64) {
    throw new TaskIntentError('TaskIntent "taskId" must be a non-empty string of at most 64 characters.', {
      path: 'taskId',
    });
  }

  // 2. objective: non-empty string, <= 500 chars
  if (typeof intent.objective !== 'string' || intent.objective.trim() === '' || intent.objective.length > 500) {
    throw new TaskIntentError('TaskIntent "objective" must be a non-empty string of at most 500 characters.', {
      path: 'objective',
    });
  }

  // 3. targetOrigin: canonical http/https origin
  validateTargetOrigin(intent.targetOrigin, 'targetOrigin');

  // 4. startPath: leading slash relative path
  validateRelativePath(intent.startPath, 'startPath');

  // 5. parameters: array of { name, value, label?, description? }
  if (!Array.isArray(intent.parameters)) {
    throw new TaskIntentError('TaskIntent "parameters" must be an array.', { path: 'parameters' });
  }

  const seenParamNames = new Set();
  for (let i = 0; i < intent.parameters.length; i++) {
    const param = intent.parameters[i];
    if (!param || typeof param !== 'object' || Array.isArray(param)) {
      throw new TaskIntentError(`Parameter at index ${i} must be a non-null object.`, { path: `parameters[${i}]` });
    }
    if (typeof param.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(param.name)) {
      throw new TaskIntentError(
        `Parameter name "${param.name}" at index ${i} must be an alphanumeric identifier starting with a letter (<= 50 chars).`,
        { path: `parameters[${i}].name` }
      );
    }
    if (seenParamNames.has(param.name)) {
      throw new TaskIntentError(`Duplicate parameter name "${param.name}" in TaskIntent.`, {
        path: `parameters[${i}].name`,
      });
    }
    seenParamNames.add(param.name);

    if (typeof param.value !== 'string' || param.value.length > 1000) {
      throw new TaskIntentError(`Parameter value for "${param.name}" must be a string of at most 1000 characters.`, {
        path: `parameters[${i}].value`,
      });
    }
  }

  // 6. constraints: array of objects (optional, defaults to [])
  if (intent.constraints !== undefined) {
    if (!Array.isArray(intent.constraints)) {
      throw new TaskIntentError('TaskIntent "constraints" must be an array if provided.', { path: 'constraints' });
    }
    for (let i = 0; i < intent.constraints.length; i++) {
      const c = intent.constraints[i];
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        throw new TaskIntentError(`Constraint at index ${i} must be an object.`, { path: `constraints[${i}]` });
      }
      if (typeof c.kind !== 'string' || c.kind.trim() === '') {
        throw new TaskIntentError(`Constraint at index ${i} must have a non-empty "kind" string.`, {
          path: `constraints[${i}].kind`,
        });
      }
    }
  }

  // 7. successConditions: array of { type, expected } with at least one condition
  if (!Array.isArray(intent.successConditions) || intent.successConditions.length === 0) {
    throw new TaskIntentError('TaskIntent "successConditions" must be a non-empty array.', {
      path: 'successConditions',
    });
  }

  for (let i = 0; i < intent.successConditions.length; i++) {
    const sc = intent.successConditions[i];
    if (!sc || typeof sc !== 'object' || Array.isArray(sc)) {
      throw new TaskIntentError(`successCondition at index ${i} must be an object.`, {
        path: `successConditions[${i}]`,
      });
    }
    if (!ALLOWED_CONDITION_TYPES.has(sc.type)) {
      throw new TaskIntentError(
        `Invalid successCondition type "${sc.type}" at index ${i}. Allowed: ${Array.from(ALLOWED_CONDITION_TYPES).join(', ')}`,
        { path: `successConditions[${i}].type` }
      );
    }
    // A condition carries exactly one value source: a literal "expected" string
    // or an "input" reference to a declared task parameter. References are
    // inert names, resolved locally at verification time; finalPath stays
    // literal-only so navigation targets can never be input-driven.
    for (const key of Object.keys(sc)) {
      if (key !== 'type' && key !== 'expected' && key !== 'input') {
        throw new TaskIntentError(`Unknown field "${key}" in successCondition at index ${i}.`, {
          path: `successConditions[${i}].${key}`,
        });
      }
    }
    const hasExpected = sc.expected !== undefined;
    const hasInput = sc.input !== undefined;
    if (hasExpected === hasInput) {
      throw new TaskIntentError(
        `successCondition at index ${i} must declare exactly one of "expected" (literal) or "input" (declared parameter reference).`,
        { path: `successConditions[${i}]` }
      );
    }
    if (hasInput) {
      if (sc.type === 'finalPath') {
        throw new TaskIntentError(
          `successCondition "finalPath" at index ${i} must use a literal "expected" path; input references are not allowed.`,
          { path: `successConditions[${i}].input` }
        );
      }
      if (typeof sc.input !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(sc.input)) {
        throw new TaskIntentError(
          `successCondition "input" at index ${i} must be a valid parameter name.`,
          { path: `successConditions[${i}].input` }
        );
      }
      if (!seenParamNames.has(sc.input)) {
        throw new TaskIntentError(
          `successCondition at index ${i} references undeclared parameter "${sc.input}". Only declared task parameters may be referenced.`,
          { path: `successConditions[${i}].input` }
        );
      }
    } else if (typeof sc.expected !== 'string' || sc.expected.trim() === '') {
      throw new TaskIntentError(`successCondition "expected" at index ${i} must be a non-empty string.`, {
        path: `successConditions[${i}].expected`,
      });
    }
  }

  // 8. approvalRequired & forbidden: arrays of strings if present
  if (intent.approvalRequired !== undefined && !Array.isArray(intent.approvalRequired)) {
    throw new TaskIntentError('TaskIntent "approvalRequired" must be an array if provided.', {
      path: 'approvalRequired',
    });
  }
  if (intent.forbidden !== undefined && !Array.isArray(intent.forbidden)) {
    throw new TaskIntentError('TaskIntent "forbidden" must be an array if provided.', { path: 'forbidden' });
  }

  return { valid: true };
}

/**
 * Helper to build and validate a TaskIntent from parameters.
 *
 * @param {object} options
 * @param {string} [options.taskId]
 * @param {string} options.objective
 * @param {string} options.targetOrigin
 * @param {string} [options.startPath='/']
 * @param {Array<{ name: string, value: string, label?: string, description?: string }>} [options.parameters=[]]
 * @param {Array<object>} [options.constraints=[]]
 * @param {Array<{ type: string, expected?: string, input?: string }>} options.successConditions - Literal {type, expected} or parameter-bound {type, input}
 * @param {Array<string>} [options.approvalRequired=[]]
 * @param {Array<string>} [options.forbidden=[]]
 * @returns {object} Validated TaskIntent object
 */
export function createTaskIntent({
  taskId,
  objective,
  targetOrigin,
  startPath = '/',
  parameters = [],
  constraints = [],
  successConditions = [],
  approvalRequired = [],
  forbidden = [],
}) {
  const generatedId =
    taskId ||
    `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const intent = {
    taskId: generatedId,
    objective: String(objective || '').trim(),
    targetOrigin: String(targetOrigin || '').trim(),
    startPath: String(startPath || '/').trim(),
    parameters: parameters.map((p) => ({
      name: String(p.name || '').trim(),
      value: String(p.value ?? ''),
      label: p.label ? String(p.label).trim() : undefined,
      description: p.description ? String(p.description).trim() : undefined,
    })),
    constraints: [...constraints],
    successConditions: successConditions.map((sc) =>
      sc && sc.input !== undefined
        ? { type: String(sc.type || '').trim(), input: String(sc.input || '').trim() }
        : { type: String(sc?.type || '').trim(), expected: String(sc?.expected || '').trim() }
    ),
    approvalRequired: [...approvalRequired],
    forbidden: [...forbidden],
  };

  validateTaskIntent(intent);
  return intent;
}
