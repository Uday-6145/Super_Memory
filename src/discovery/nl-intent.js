import { WorkflowError } from '../workflow/errors.js';
import { validateTargetOrigin, validateRelativePath } from '../workflow/schema.js';
import { createTaskIntent } from './task-intent.js';

export class NaturalLanguageIntentError extends WorkflowError {
  constructor(message, details = {}) {
    super(message, { code: 'NATURAL_LANGUAGE_INTENT_ERROR', cause: details.cause });
    this.name = 'NaturalLanguageIntentError';
    this.path = details.path || null;
    this.needsClarification = Boolean(details.needsClarification);
  }
}

const ALLOWED_NL_DRAFT_KEYS = new Set([
  'objective',
  'parameters',
  'constraints',
  'successConditions',
  'approvalRequired',
  'forbidden',
]);

function stripJsonFences(text) {
  let cleaned = String(text || '').trim();
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    if (lines[0].startsWith('```')) {
      lines.shift();
    }
    if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) {
      lines.pop();
    }
    cleaned = lines.join('\n').trim();
  }
  return cleaned;
}

export function parseNaturalLanguageTaskResponse(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new NaturalLanguageIntentError('Natural-language parser returned an empty response.', {
      needsClarification: true,
    });
  }

  const cleaned = stripJsonFences(text);
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  const candidate = firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace
    ? cleaned.slice(firstBrace, lastBrace + 1)
    : cleaned;

  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new NaturalLanguageIntentError(`Natural-language intent was not valid JSON: ${err.message}.`, {
      needsClarification: true,
      cause: err,
    });
  }
}

function validateNaturalLanguageDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new NaturalLanguageIntentError('Natural-language intent must be a JSON object.', {
      needsClarification: true,
    });
  }
  for (const key of Object.keys(draft)) {
    if (!ALLOWED_NL_DRAFT_KEYS.has(key)) {
      throw new NaturalLanguageIntentError(
        `Natural-language intent must not include "${key}". Target, identity, and storage fields are supplied by the caller.`,
        { path: key }
      );
    }
  }
  if (typeof draft.objective !== 'string' || draft.objective.trim() === '') {
    throw new NaturalLanguageIntentError('Natural-language request needs a clear objective before discovery.', {
      path: 'objective',
      needsClarification: true,
    });
  }
  if (!Array.isArray(draft.successConditions) || draft.successConditions.length === 0) {
    throw new NaturalLanguageIntentError(
      'Natural-language request needs at least one explicit success condition before discovery.',
      { path: 'successConditions', needsClarification: true }
    );
  }
  return draft;
}

function mergeFixedParameters(modelParameters, fixedParameters) {
  const merged = new Map();
  for (const param of modelParameters || []) {
    if (param && typeof param.name === 'string') {
      merged.set(param.name, param);
    }
  }
  for (const param of fixedParameters || []) {
    if (param && typeof param.name === 'string') {
      merged.set(param.name, {
        name: param.name,
        value: String(param.value ?? ''),
        ...(param.label ? { label: param.label } : {}),
        ...(param.description ? { description: param.description } : {}),
      });
    }
  }
  return Array.from(merged.values());
}

export async function parseNaturalLanguageTask({
  provider,
  request,
  targetOrigin,
  startPath = '/',
  fixedParameters = [],
  taskId,
  modelOptions = {},
} = {}) {
  if (!provider || typeof provider.complete !== 'function') {
    throw new NaturalLanguageIntentError(
      'Natural-language discovery requires a model provider with a complete() method. Provide a structured --intent file for deterministic offline use.'
    );
  }
  if (typeof request !== 'string' || request.trim() === '') {
    throw new NaturalLanguageIntentError('A natural-language task request is required.', {
      needsClarification: true,
    });
  }
  if (typeof targetOrigin !== 'string' || targetOrigin.trim() === '') {
    throw new NaturalLanguageIntentError(
      'Natural-language discovery requires an explicit --origin. The model must not invent a target origin.',
      { needsClarification: true }
    );
  }
  validateTargetOrigin(targetOrigin, 'targetOrigin');
  validateRelativePath(startPath, 'startPath');

  const systemMessage = `You convert a plain-language web task into a constrained TaskIntent draft.
Return ONLY a JSON object with exactly these keys: objective, parameters, constraints, successConditions, approvalRequired, forbidden.
Do not include targetOrigin, startPath, taskId, workflow IDs, URLs, secrets, or explanatory text.
Parameters must be objects with name and value; successConditions must be non-empty and use only finalPath, pageTitle, textPresent, or textAbsent.
If required details are missing, return {"objective": "", "parameters": [], "constraints": [], "successConditions": [], "approvalRequired": [], "forbidden": []}.`;

  const userMessage = `REQUEST:
${request}

Caller-supplied target (do not change or repeat it in the JSON):
${targetOrigin}${startPath}

Caller-supplied fixed parameters (reuse their names and values; do not invent conflicting values):
${JSON.stringify(fixedParameters || [])}

Emit the constrained JSON draft now:`;

  let completion;
  try {
    completion = await provider.complete({
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
      maxTokens: modelOptions.maxTokens ?? 1500,
      timeoutMs: modelOptions.timeoutMs ?? 30000,
    });
  } catch (err) {
    throw new NaturalLanguageIntentError(
      `Natural-language intent parsing failed: ${err.message}. Provide a structured --intent file instead.`,
      { cause: err }
    );
  }

  const draft = validateNaturalLanguageDraft(parseNaturalLanguageTaskResponse(completion?.text));
  const parameters = mergeFixedParameters(draft.parameters, fixedParameters);

  return createTaskIntent({
    taskId,
    objective: draft.objective,
    targetOrigin,
    startPath,
    parameters,
    constraints: draft.constraints || [],
    successConditions: draft.successConditions,
    approvalRequired: draft.approvalRequired || [],
    forbidden: draft.forbidden || [],
  });
}
