/**
 * Super Memory — Workflow Lookup Module (Discovery Engine)
 *
 * Implements deterministic lookup across repository workflows to identify
 * if a reusable verified workflow already exists for the given TaskIntent.
 *
 * Lookup Criteria:
 * 1. Enabled status (must not be disabled).
 * 2. Target origin match (must match intent.targetOrigin exactly).
 * 3. Parameter compatibility (all required workflow inputs must be satisfied by intent parameters).
 * 4. Objective match: workflowId, name, or description overlap with intent objective tokens.
 */

/**
 * Searches the repository for a verified workflow matching the TaskIntent.
 *
 * @param {import('../workflow/repository.js').FileSystemWorkflowRepository} repository
 * @param {object} intent - Validated TaskIntent
 * @returns {Promise<{ match: boolean, workflowId?: string, version?: number, workflow?: object }>}
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'with', 'from', 'into', 'onto', 'upon',
  'to', 'of', 'on', 'in', 'at', 'by', 'as', 'is', 'are', 'be', 'this', 'that',
  'these', 'those', 'it', 'its', 'you', 'your', 'our', 'we', 'please', 'add',
  'new', 'existing', 'current', 'workflow', 'workflows', 'discovered', 'discovery',
  'task', 'tasks', 'test', 'tests', 'demo', 'sample', 'draft', 'verified', 'active',
]);

function getMeaningfulTokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token))
  );
}

function countSharedTokens(left, right) {
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }
  return shared;
}

function isSuccessCriteriaCompatible(intent, workflowSuccessCriteria = {}) {
  for (const condition of intent.successConditions || []) {
    if (!condition || typeof condition.expected !== 'string') {
      return false;
    }
    if (workflowSuccessCriteria[condition.type] !== condition.expected) {
      return false;
    }
  }
  return true;
}

export async function findMatchingWorkflow(repository, intent) {
  if (!repository || typeof repository.list !== 'function') {
    return { match: false };
  }

  const manifests = await repository.list({ enabledOnly: true });
  if (!Array.isArray(manifests) || manifests.length === 0) {
    return { match: false };
  }

  const intentTokens = getMeaningfulTokens(intent.objective);
  const providedParamNames = new Set((intent.parameters || []).map((p) => p.name));
  const candidates = [];

  for (const manifest of manifests) {
    if (manifest.enabled === false) {
      continue;
    }
    if (!manifest.activeVersion) {
      continue;
    }

    const workflowId = manifest.id || manifest.workflowId;
    if (!workflowId) {
      continue;
    }

    let activeVersionObj;
    try {
      activeVersionObj = await repository.getVersion(workflowId, manifest.activeVersion);
    } catch {
      continue;
    }

    if (!activeVersionObj || !activeVersionObj.target) {
      continue;
    }
    if (activeVersionObj.status && activeVersionObj.status !== 'verified') {
      continue;
    }

    // 1. Exact origin and compatible start path.
    if (activeVersionObj.target.origin !== intent.targetOrigin) {
      continue;
    }
    if (activeVersionObj.target.startPath !== intent.startPath) {
      continue;
    }

    // 2. Input compatibility: every required workflow input must be supplied, and
    // every supplied intent parameter must correspond to a declared workflow input.
    // This prevents merging extraneous values that ordinary playback would reject.
    const declaredInputNames = new Set((activeVersionObj.inputs || []).map((inp) => inp.name));
    const requiredInputs = (activeVersionObj.inputs || []).filter((inp) => inp.required);
    const hasAllRequiredInputs = requiredInputs.every((inp) => providedParamNames.has(inp.name));
    const hasOnlyDeclaredInputs = Array.from(providedParamNames).every((name) => declaredInputNames.has(name));
    if (!hasAllRequiredInputs || !hasOnlyDeclaredInputs) {
      continue;
    }

    // 3. Requested outcome compatibility: the saved workflow must promise all of the
    // requested success conditions. A shared origin is not proof of a shared outcome.
    if (!isSuccessCriteriaCompatible(intent, activeVersionObj.successCriteria || {})) {
      continue;
    }

    // 4. Meaningful objective compatibility: require at least two shared significant
    // tokens. One common word is never enough to select an executable workflow.
    const candidateText = `${workflowId} ${manifest.name || ''} ${manifest.description || ''}`;
    const sharedObjectiveTokens = countSharedTokens(intentTokens, getMeaningfulTokens(candidateText));
    if (sharedObjectiveTokens < 2) {
      continue;
    }

    candidates.push({
      workflowId,
      version: manifest.activeVersion,
      workflow: activeVersionObj,
    });
  }

  if (candidates.length === 0) {
    return { match: false };
  }

  // Never silently choose the first of several weakly distinguishable candidates.
  if (candidates.length > 1) {
    return {
      match: false,
      ambiguous: true,
      candidates: candidates.map(({ workflowId, version }) => ({ workflowId, version })),
    };
  }

  return {
    match: true,
    workflowId: candidates[0].workflowId,
    version: candidates[0].version,
    workflow: candidates[0].workflow,
  };
}
