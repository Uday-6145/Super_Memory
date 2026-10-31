/**
 * Super Memory — Workflow Execution Service (M2 Phase 3)
 *
 * Playback (`play`) and draft trial (`trial`) orchestration extracted from
 * the Operator CLI so a future local web application can invoke the same
 * behavior without terminal I/O:
 * - play: execute the active verified workflow version
 * - trial: execute an unapproved draft for verification, stage evidence on
 *   success, clean up stale staged evidence on failure
 *
 * Design rules for this service:
 * - Dependencies are explicit: the repository, an optional shared browser
 *   runtime, headless/allow-localhost flags, and an injectable fixture
 *   starter. No CLI arguments, stdout/stderr, readline, process.exit, or
 *   terminal formatting lives here.
 * - Returns structured results (the player's run objects and
 *   `{ success, trialResult, evidencePath }`), identical in shape to what
 *   the CLI adapter returned before extraction. Progress text stays in
 *   `src/cli/operator.js`.
 * - Reuses `WorkflowPlayer` and the existing domain modules without
 *   duplicating browser execution, validation, or evidence logic.
 * - Evidence safety: success staging writes exactly the player's evidence
 *   bytes; failed trials delete only the service-owned default staged file
 *   and never a caller-supplied `evidenceOut` path. A failed trial never
 *   produces promotable evidence.
 * - Inputs: the service accepts resolved runtime input objects. Reading
 *   inputs files (`loadInputs`, moved here from the CLI for reuse) and
 *   deriving display secrets (`deriveSecrets`, still CLI-owned for output
 *   redaction) remain adapter responsibilities.
 * - No model provider is required or accepted.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import {
  WorkflowError,
  WorkflowNotFoundError,
  WorkflowPlayer,
  validateRuntimeInputs,
} from '../workflow/index.js';

/**
 * Creates an execution service bound to one repository context.
 *
 * @param {object} [options]
 * @param {object} [options.repository] - Workflow repository (required).
 * @param {object} [options.browserRuntime] - Shared browser runtime, or null
 *   to let each player provision and close an owned runtime.
 * @param {boolean} [options.allowLocalhost] - Permit loopback navigation.
 * @param {boolean} [options.headless] - Run browser headless.
 * @param {Function} [options.fixtureStarter] - Injectable
 *   `async (targetOrigin) => server|null` used for local fixture startup.
 * @returns {{ repository: object, playWorkflow: Function, trialDraft: Function }}
 */
export function createExecutionService({
  repository,
  browserRuntime = null,
  allowLocalhost = false,
  headless = true,
  fixtureStarter = ensureLocalFixtureIfTargeted,
} = {}) {
  if (!repository) {
    throw new WorkflowError('Execution service requires a repository.');
  }
  const context = { repository, browserRuntime, allowLocalhost, headless, fixtureStarter };
  return {
    get repository() {
      return context.repository;
    },
    playWorkflow: (options) => playWorkflow(context, options),
    trialDraft: (options) => trialDraft(context, options),
  };
}

/**
 * Executes the active verified version of a workflow.
 *
 * @param {object} context - Service context (see factory).
 * @param {object} [options]
 * @param {string} [options.workflowId]
 * @param {Record<string, string>} [options.inputs]
 * @returns {Promise<object>} The structured WorkflowRunResult.
 */
export async function playWorkflow(context, { workflowId, inputs = {} } = {}) {
  if (!workflowId) {
    throw new WorkflowError('Missing workflow ID for play command.');
  }

  const player = new WorkflowPlayer({
    repository: context.repository,
    browserRuntime: context.browserRuntime,
    allowLocalhost: context.allowLocalhost,
    headless: context.headless,
  });

  let autoFixtureServer = null;
  if (context.allowLocalhost) {
    try {
      const manifest = await context.repository.getManifest(workflowId);
      if (manifest?.activeVersion) {
        const activeVer = await context.repository.getVersion(workflowId, manifest.activeVersion);
        autoFixtureServer = await context.fixtureStarter(activeVer?.target?.origin);
      }
    } catch {}
  }

  try {
    return await player.play(workflowId, inputs, { allowLocalhost: context.allowLocalhost });
  } finally {
    if (!context.browserRuntime) {
      await player.close();
    }
    if (autoFixtureServer) {
      await new Promise((res) => autoFixtureServer.close(res)).catch(() => {});
    }
  }
}

/**
 * Executes the current unapproved draft for verification. Stages the
 * player's evidence file on success; removes stale service-owned staged
 * evidence on failure. Never promotes: promotion stays explicit.
 *
 * @param {object} context - Service context (see factory).
 * @param {object} [options]
 * @param {string} [options.workflowId]
 * @param {Record<string, string>} [options.inputs]
 * @param {string} [options.evidenceOut] - Caller-owned evidence destination.
 *   Never deleted by failure cleanup.
 * @returns {Promise<{ success: boolean, trialResult: object, evidencePath?: string }>}
 */
export async function trialDraft(context, { workflowId, inputs = {}, evidenceOut = null } = {}) {
  if (!workflowId) {
    throw new WorkflowError('Missing workflow ID for trial command.');
  }

  const manifest = await context.repository.getManifest(workflowId);
  if (!manifest) {
    throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found in repository.`, { workflowId });
  }

  if (!manifest.draftVersion) {
    throw new WorkflowError(`Workflow "${workflowId}" has no draft version for verification.`);
  }

  const draftVersion = await context.repository.getVersion(workflowId, manifest.draftVersion);
  if (!draftVersion) {
    throw new WorkflowNotFoundError(
      `Draft version ${manifest.draftVersion} for workflow "${workflowId}" not found on disk.`,
      { workflowId, version: manifest.draftVersion }
    );
  }

  // Validate inputs against draft declarations early, before any browser work.
  validateRuntimeInputs(draftVersion.inputs || [], inputs, workflowId);

  const player = new WorkflowPlayer({
    repository: context.repository,
    browserRuntime: context.browserRuntime,
    allowLocalhost: context.allowLocalhost,
    headless: context.headless,
  });

  let autoFixtureServer = null;
  if (context.allowLocalhost) {
    autoFixtureServer = await context.fixtureStarter(draftVersion.target?.origin);
  }

  let trialResult;
  try {
    trialResult = await player.playDraftForVerification(workflowId, inputs, {
      allowLocalhost: context.allowLocalhost,
    });
  } finally {
    if (!context.browserRuntime) {
      await player.close();
    }
    if (autoFixtureServer) {
      await new Promise((res) => autoFixtureServer.close(res)).catch(() => {});
    }
  }

  if (trialResult.candidatePromotionReady) {
    // Save staged evidence: exactly the player's evidence bytes.
    const targetPath = evidenceOut
      ? path.resolve(evidenceOut)
      : getStagedEvidencePath(context.repository.baseDir, workflowId, draftVersion.version);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, JSON.stringify(trialResult.evidence, null, 2), 'utf8');

    return {
      success: true,
      trialResult,
      evidencePath: targetPath,
    };
  }

  // Clean up only the service-owned internal staged evidence file in
  // .staging so a failed run cannot leave stale staged evidence eligible
  // for promotion. Never delete a caller-owned custom evidenceOut file.
  const defaultStagedPath = getStagedEvidencePath(context.repository.baseDir, workflowId, draftVersion.version);
  try {
    await fs.unlink(defaultStagedPath);
  } catch {}

  return {
    success: false,
    trialResult,
  };
}

/**
 * Returns the default staging path for trial verification evidence.
 * Placed inside `<baseDir>/.staging/` so repository version scanners ignore it.
 *
 * Moved here from `src/cli/operator.js` (M2 Phase 3); re-exported there to
 * preserve the existing import surface.
 *
 * @param {string} baseDir
 * @param {string} workflowId
 * @param {number} draftVersion
 * @returns {string}
 */
export function getStagedEvidencePath(baseDir, workflowId, draftVersion) {
  return path.join(path.resolve(baseDir), '.staging', `${workflowId}-draft-${draftVersion}.evidence.json`);
}

/**
 * Reads and validates a JSON inputs file without echoing its contents or secrets.
 *
 * Moved here from `src/cli/operator.js` (M2 Phase 3); re-exported there to
 * preserve the existing import surface.
 *
 * @param {string} inputsPath
 * @returns {Promise<Record<string, string>>}
 */
export async function loadInputs(inputsPath) {
  if (!inputsPath) return {};
  const resolved = path.resolve(inputsPath);
  let content;
  try {
    content = await fs.readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new WorkflowError(`Inputs file not found: "${inputsPath}".`);
    }
    throw new WorkflowError(`Failed to read inputs file "${inputsPath}": ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new WorkflowError(`Invalid JSON in inputs file "${inputsPath}": ${err.message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WorkflowError(`Inputs file "${inputsPath}" must contain a JSON object mapping input names to string values.`);
  }

  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string') {
      throw new WorkflowError(`Input "${key}" must be a string value (received ${typeof val}).`);
    }
  }

  return parsed;
}

/**
 * Ensures the local synthetic fixture server is running if the target origin is on port 8080.
 *
 * Moved here from `src/cli/operator.js` (M2 Phase 3) so both the execution
 * service and discovery orchestration share one implementation. The CLI
 * imports it for discovery use.
 *
 * @param {string} targetOrigin
 * @returns {Promise<import('node:http').Server|null>}
 */
export async function ensureLocalFixtureIfTargeted(targetOrigin) {
  if (!targetOrigin) return null;
  try {
    const url = new URL(targetOrigin);
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && (url.port === '8080' || !url.port)) {
      const isListening = await new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:8080/store', { timeout: 300 }, (res) => {
          res.resume();
          resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });

      if (!isListening) {
        const { startFixtureServer } = await import('../../scripts/serve-fixture.js');
        return await startFixtureServer(8080);
      }
    }
  } catch {}
  return null;
}
