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
export async function findMatchingWorkflow(repository, intent) {
  if (!repository || typeof repository.list !== 'function') {
    return { match: false };
  }

  const manifests = await repository.list({ enabledOnly: true });
  if (!Array.isArray(manifests) || manifests.length === 0) {
    return { match: false };
  }

  const intentTokens = new Set(
    (intent.objective || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );

  const providedParamNames = new Set((intent.parameters || []).map((p) => p.name));

  for (const manifest of manifests) {
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

    // 1. Origin match
    if (activeVersionObj.target.origin !== intent.targetOrigin) {
      continue;
    }

    // 2. Input parameter compatibility: all required workflow inputs must be provided
    const requiredInputs = (activeVersionObj.inputs || []).filter((inp) => inp.required);
    const hasAllRequiredInputs = requiredInputs.every((inp) => providedParamNames.has(inp.name));
    if (!hasAllRequiredInputs) {
      continue;
    }

    // 3. Semantic / Token match: check workflow ID, name, or description
    const candidateText = `${workflowId} ${manifest.name || ''} ${manifest.description || ''}`.toLowerCase();
    const matchesObjective = Array.from(intentTokens).some((token) => candidateText.includes(token));

    // Also match if target startPath matches and inputs match
    const matchesPath = activeVersionObj.target.startPath === intent.startPath;

    if (matchesObjective || matchesPath) {
      return {
        match: true,
        workflowId,
        version: manifest.activeVersion,
        workflow: activeVersionObj,
      };
    }
  }

  return { match: false };
}
