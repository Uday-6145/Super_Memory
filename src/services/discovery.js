/**
 * Super Memory — Workflow Discovery Service (M2 Phase 6)
 *
 * Natural-language task intake, workflow lookup, existing-workflow replay,
 * and new discovery orchestration, extracted from the Operator CLI so a
 * future local application can discover and reuse workflows without
 * invoking CLI commands.
 *
 * Design rules for this service:
 * - Dependencies are explicit: the repository, an execution service (used
 *   ONLY for the lookup-replay branch), and an optional shared browser
 *   runtime for the discovery loop. No CLI arguments, stdout/stderr,
 *   readline, process.exit, terminal formatting, or file-system reads here.
 * - Reuses the existing discovery domain without duplicating it:
 *   intent validation (`task-intent.js`), natural-language parsing
 *   (`nl-intent.js`), conservative lookup (`lookup.js`), the
 *   evidence-driven loop (`discovery-session.js`), and candidate
 *   construction (`candidate.js`) remain the implementations of record.
 * - Providers are lazy and caller-resolved. The service accepts thunk
 *   resolvers (`getNlProvider`, `getDiscoveryProvider`) and invokes each at
 *   most once, only when its phase is actually reached. The natural-language
 *   provider is required only for plain-text objectives; the discovery-loop
 *   provider only after a lookup miss. The service never parses provider
 *   strings and never builds the fixture-specific mock — that stays with
 *   the CLI adapter, which closes over its existing configuration.
 * - Returns the existing discriminated results (`reused`, `discovered`,
 *   `ambiguous`, `failed`) with the same fields the CLI produced. Progress
 *   streams through the caller-supplied `onEvent` callback unchanged.
 * - Journals stay caller-configured (explicit directory or null), hash-only,
 *   and non-resumable. Successful discovery persists the candidate draft
 *   through `repository.createWorkflow`, exactly as the CLI did; trial and
 *   promotion remain separate explicit steps owned by other services.
 * - No browser sessions are shared with ExecutionService: replay goes
 *   through `execution.playWorkflow`, while the multi-step discovery loop
 *   stays inside `DiscoveryOrchestrator`'s owned session lifecycle.
 */

import { WorkflowError } from '../workflow/errors.js';
import {
  createTaskIntent,
  findMatchingWorkflow,
  parseNaturalLanguageTask,
  validateTaskIntent,
  DiscoveryOrchestrator,
} from '../discovery/index.js';
import { createBrowserRuntime } from '../browser/index.js';
import { ensureLocalFixtureIfTargeted } from './execution.js';

/**
 * Establishes the single validated source of truth for effective runtime
 * inputs during discovery: the merge of TaskIntent parameters and any
 * separately supplied runtime inputs.
 *
 * Moved here from `src/cli/operator.js` (M2 Phase 6); re-exported there to
 * preserve the existing import surface.
 *
 * Rules (fail closed; error messages name inputs, never values):
 * - Every runtime input must be declared as a task parameter.
 * - When both sources supply a non-empty value for the same input, the
 *   values must agree exactly; a conflict is rejected rather than silently
 *   preferring one source across discovery, lookup, and playback.
 * - An empty intent value means "supplied at runtime" and is filled from
 *   the runtime inputs; otherwise the intent value is the effective value.
 *
 * @param {object} intent - Validated TaskIntent
 * @param {object} runtimeInputs - Runtime input values by name
 * @returns {Record<string, string>} Effective runtime inputs by name
 */
export function resolveEffectiveInputs(intent, runtimeInputs = {}) {
  if (!runtimeInputs || typeof runtimeInputs !== 'object' || Array.isArray(runtimeInputs)) {
    throw new WorkflowError('Runtime inputs must be an object mapping input names to string values.');
  }

  const declared = new Map();
  for (const param of intent?.parameters || []) {
    if (param && typeof param.name === 'string') {
      declared.set(param.name, param);
    }
  }

  const inputs = {};
  for (const [name, value] of Object.entries(runtimeInputs)) {
    if (typeof value !== 'string') {
      throw new WorkflowError(`Runtime input "${name}" must be a string value.`);
    }
    if (!declared.has(name)) {
      throw new WorkflowError(
        `Runtime input "${name}" is not declared in the task intent parameters. Declare it in the intent or remove it from the inputs file.`
      );
    }
    const intentValue = declared.get(name).value;
    if (typeof intentValue === 'string' && intentValue !== '' && value !== intentValue) {
      throw new WorkflowError(
        `Runtime input "${name}" conflicts with the task intent parameter of the same name. Provide one consistent value in the intent and the inputs file.`
      );
    }
    inputs[name] = value;
  }

  for (const param of intent?.parameters || []) {
    if (param && typeof param.name === 'string' && inputs[param.name] === undefined) {
      inputs[param.name] = param.value;
    }
  }

  return inputs;
}

/**
 * Creates a discovery service bound to one repository context.
 *
 * @param {object} [options]
 * @param {object} [options.repository] - Workflow repository (required).
 * @param {object} [options.execution] - Execution service exposing
 *   `playWorkflow({ workflowId, inputs })`, used only for the
 *   existing-workflow replay branch (required).
 * @param {object|null} [options.browserRuntime] - Shared browser runtime
 *   for the discovery loop, or null to provision and close an owned
 *   runtime per discovery run.
 * @returns {{ repository: object, discover: Function }}
 */
export function createDiscoveryService({ repository, execution, browserRuntime = null } = {}) {
  if (!repository) {
    throw new WorkflowError('Discovery service requires a repository.');
  }
  if (!execution || typeof execution.playWorkflow !== 'function') {
    throw new WorkflowError('Discovery service requires an execution service.');
  }
  const context = { repository, execution, browserRuntime };
  return {
    get repository() {
      return context.repository;
    },
    discover: (options) => discover(context, options),
  };
}

/**
 * Normalizes one of the supported task specifications into a validated
 * TaskIntent. Intent files are read by the caller; this function handles
 * intent objects, JSON strings, and plain natural-language objectives.
 */
async function normalizeIntent(context, { task, origin, startPath = '/', parameters = [], inputs = {}, getNlProvider = null }) {
  void context;
  let intent;
  if (task && typeof task === 'object' && !Array.isArray(task)) {
    intent = task;
    validateTaskIntent(intent);
  } else if (typeof task === 'string' && task.trim().startsWith('{')) {
    intent = JSON.parse(task);
    validateTaskIntent(intent);
  } else {
    const request = String(task || '').trim();
    if (!request) {
      throw new Error('A task objective is required. Provide plain text plus --origin, or provide --intent <path>.');
    }
    if (!origin) {
      throw new Error('Plain-language discovery requires an explicit --origin. The model must not invent a target origin.');
    }
    const fixedParams = Array.isArray(parameters) && parameters.length > 0
      ? parameters
      : Object.entries(inputs || {}).map(([name, value]) => ({ name, value: String(value) }));

    if (typeof getNlProvider !== 'function') {
      throw new Error('Plain-language discovery requires a model provider with a complete() method.');
    }
    const nlProvider = await getNlProvider();
    if (!nlProvider || typeof nlProvider.complete !== 'function') {
      throw new Error('Plain-language discovery requires a model provider with a complete() method.');
    }

    try {
      intent = await parseNaturalLanguageTask({
        provider: nlProvider,
        request,
        targetOrigin: origin,
        startPath,
        fixedParameters: fixedParams,
      });
    } catch (err) {
      if (err && err.needsClarification) {
        throw new Error(`Ambiguous task request: ${err.message} Refine the objective or provide --intent <path>.`);
      }
      throw err;
    }
  }
  return intent;
}

/**
 * Discovers or reuses a workflow for a task.
 *
 * @param {object} context - Service context (see factory).
 * @param {object} [options]
 * @param {object|string} [options.task] - Intent object, JSON string, or
 *   plain-text objective (intent files are read by the caller).
 * @param {string} [options.origin] - Required for plain-text objectives.
 * @param {string} [options.startPath='/'] - Start path for NL objectives.
 * @param {Array} [options.parameters=[]] - Fixed parameters for NL parsing.
 * @param {object} [options.inputs={}] - Already-resolved runtime inputs.
 * @param {Function} [options.getNlProvider] - Lazy `() => provider`
 *   resolver, invoked at most once and only for plain-text objectives.
 * @param {Function} [options.getDiscoveryProvider] - Lazy `() => provider`
 *   resolver, invoked at most once and only after a lookup miss.
 * @param {Function} [options.approveAction] - Explicit approval callback,
 *   forwarded to the orchestrator.
 * @param {Function} [options.fixtureStarter] - Injectable fixture starter;
 *   defaults to the shared local-fixture helper.
 * @param {string|null} [options.journalDir] - Explicit scratch journal
 *   directory or null to disable (the caller resolves defaults).
 * @param {boolean} [options.allowLocalhost] - Loopback navigation for the
 *   discovery loop.
 * @param {boolean} [options.headless] - Headless browser for owned runtimes.
 * @param {Function} [options.onEvent] - Structured progress callback.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {number} [options.maxSteps] - Discovery step budget override.
 * @param {number} [options.maxModelCalls] - Model-call budget override.
 * @param {number} [options.maxConsecutiveInvalidDecisions] - Override.
 * @param {number} [options.maxWallClockMs] - Wall-clock budget override.
 * @param {number} [options.maxTotalTokens] - Token budget override.
 * @returns {Promise<object>} Discriminated discovery result.
 */
function emitProgress(onEvent, event, data = {}) {
  if (typeof onEvent === 'function') {
    try {
      onEvent({ event, timestamp: new Date().toISOString(), ...data });
    } catch {}
  }
}

export async function discover(
  context,
  {
    task,
    origin,
    startPath = '/',
    parameters = [],
    inputs = {},
    getNlProvider = null,
    getDiscoveryProvider = null,
    approveAction,
    fixtureStarter = ensureLocalFixtureIfTargeted,
    journalDir,
    allowLocalhost = false,
    headless = true,
    onEvent = null,
    signal,
    maxSteps,
    maxModelCalls,
    maxConsecutiveInvalidDecisions,
    maxWallClockMs,
    maxTotalTokens,
  } = {}
) {
  let intent = await normalizeIntent(context, {
    task,
    origin,
    startPath,
    parameters,
    inputs,
    getNlProvider,
  });

  // Single source of truth for effective runtime inputs: intent parameters
  // reconciled with separately supplied runtime inputs. Conflicts,
  // undeclared runtime inputs, and non-string values are rejected here so
  // lookup, secrets, and playback can never silently diverge. The actual
  // values used for verification are stamped back so every downstream
  // consumer succeeds or fails on identical inputs.
  const effectiveInputs = resolveEffectiveInputs(intent, inputs);
  intent = {
    ...intent,
    parameters: (intent.parameters || []).map((param) => ({
      ...param,
      value: effectiveInputs[param.name],
    })),
  };
  validateTaskIntent(intent);

  // Lookup: reuse a verified workflow when one matches conservatively.
  emitProgress(onEvent, 'lookup-check', { targetOrigin: intent.targetOrigin });
  const match = await findMatchingWorkflow(context.repository, intent);

  if (match.ambiguous) {
    return {
      action: 'ambiguous',
      candidates: match.candidates,
      intent,
      trace: [],
    };
  }

  if (match.match) {
    // Replay through the injected execution service. No model provider is
    // resolved, no session is opened, and no journal is created.
    const playResult = await context.execution.playWorkflow({
      workflowId: match.workflowId,
      inputs: effectiveInputs,
    });

    return {
      action: 'reused',
      workflowId: match.workflowId,
      version: match.version,
      result: playResult,
    };
  }

  // Lookup miss: new discovery is necessary, so the loop provider is
  // required from here on.
  emitProgress(onEvent, 'lookup-miss', {});
  if (typeof getDiscoveryProvider !== 'function') {
    throw new Error('Discovery requires a model provider with a complete() method.');
  }
  const modelProvider = await getDiscoveryProvider();
  if (!modelProvider || typeof modelProvider.complete !== 'function') {
    throw new Error('Discovery requires a model provider with a complete() method.');
  }

  let ownRuntime = null;
  let runtime = context.browserRuntime;
  if (!runtime) {
    ownRuntime = await createBrowserRuntime({ headless });
    runtime = ownRuntime;
  }

  let autoFixtureServer = null;
  if (allowLocalhost) {
    autoFixtureServer = await fixtureStarter(intent.targetOrigin);
  }

  try {
    const orchestrator = new DiscoveryOrchestrator({
      browserRuntime: runtime,
      modelProvider,
      allowLocalhost,
      approveAction,
      journalDir,
      onEvent,
      maxSteps,
      maxModelCalls,
      maxConsecutiveInvalidDecisions,
      maxWallClockMs,
      maxTotalTokens,
    });

    const discoveryRes = await orchestrator.runDiscovery(intent, { signal });

    if (discoveryRes.status !== 'SUCCESS') {
      return {
        action: 'failed',
        status: discoveryRes.status,
        reason: discoveryRes.reason,
        trace: discoveryRes.trace,
        journalPath: orchestrator.lastJournalPath,
      };
    }

    // The manifest name is limited to 100 characters while the change
    // summary is not. Derive a valid name from the full summary without
    // modifying the candidate itself; the description keeps everything.
    const summary = discoveryRes.candidate.changeSummary || 'Discovered Workflow';
    const name = summary.length > 100 ? `${summary.slice(0, 97)}...` : summary;

    await context.repository.createWorkflow({
      id: discoveryRes.candidate.workflowId,
      name,
      description: summary,
      target: discoveryRes.candidate.target,
      inputs: discoveryRes.candidate.inputs,
      steps: discoveryRes.candidate.steps,
      successCriteria: discoveryRes.candidate.successCriteria,
      schemaVersion: discoveryRes.candidate.schemaVersion,
    });

    return {
      action: 'discovered',
      workflowId: discoveryRes.candidate.workflowId,
      draft: discoveryRes.candidate,
      contentHash: discoveryRes.contentHash,
      trace: discoveryRes.trace,
    };
  } finally {
    if (ownRuntime) {
      await ownRuntime.close().catch(() => {});
    }
    if (autoFixtureServer) {
      await new Promise((res) => autoFixtureServer.close(res)).catch(() => {});
    }
  }
}

// Re-export the NL intent parser for callers that normalize intents
// explicitly; orchestration itself stays inside `discover`.
export { createTaskIntent, parseNaturalLanguageTask, validateTaskIntent, findMatchingWorkflow };
