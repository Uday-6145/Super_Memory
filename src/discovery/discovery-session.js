/**
 * Super Memory — Discovery Session & Orchestrator
 *
 * Coordinates the interactive discovery loop:
 * OBSERVE -> DECIDE -> GUARD -> ACT -> VERIFY_OUTCOME -> CONVERT
 *
 * Security & Reliability Invariants:
 * - Hand-rolled state machine; no third-party agent framework.
 * - Enforces bounded step limits, model calls, and consecutive errors.
 * - Parameter values are treated as secrets and redacted from traces and prompts.
 * - Out-of-observation actions and prompt injection instructions are strictly rejected.
 * - Deterministic outcome verification against declared successConditions.
 * - On success, emits a candidate WorkflowVersion draft (never auto-promoted).
 */

import { performance } from 'node:perf_hooks';
import { WorkflowError } from '../workflow/errors.js';
import { redactSecrets, sanitizeSnapshot } from '../workflow/diagnostics.js';
import { buildDecisionPrompt, parseDecisionResponse, validateActionDecision } from './decision.js';
import { buildCandidateFromTrace } from './candidate.js';

export class DiscoverySessionError extends WorkflowError {
  constructor(message, details = {}) {
    super(message, { code: 'DISCOVERY_SESSION_ERROR', ...details });
    this.name = 'DiscoverySessionError';
  }
}

export class DiscoveryOrchestrator {
  /**
   * @param {object} options
   * @param {import('../browser/browser-runtime.js').BrowserRuntime} options.browserRuntime
   * @param {object} options.modelProvider - Provider instance with complete() method
   * @param {number} [options.maxSteps=25]
   * @param {number} [options.maxModelCalls=30]
   * @param {number} [options.maxConsecutiveInvalidDecisions=2]
   * @param {boolean} [options.allowLocalhost=false]
   * @param {Function} [options.onEvent] - Structured event callback
   */
  constructor({
    browserRuntime,
    modelProvider,
    maxSteps = 25,
    maxModelCalls = 30,
    maxConsecutiveInvalidDecisions = 2,
    allowLocalhost = false,
    onEvent = null,
  } = {}) {
    if (!browserRuntime) {
      throw new DiscoverySessionError('BrowserRuntime instance is required for DiscoveryOrchestrator.');
    }
    if (!modelProvider || typeof modelProvider.complete !== 'function') {
      throw new DiscoverySessionError('A model provider instance with a complete() method is required.');
    }

    this.browserRuntime = browserRuntime;
    this.modelProvider = modelProvider;
    this.maxSteps = maxSteps;
    this.maxModelCalls = maxModelCalls;
    this.maxConsecutiveInvalidDecisions = maxConsecutiveInvalidDecisions;
    this.allowLocalhost = allowLocalhost;
    this.onEvent = onEvent;
  }

  /**
   * Emits a structured observability event.
   *
   * @private
   * @param {string} type - Event type (observe, decide, guard, act, outcome, verdict)
   * @param {object} data
   */
  _emit(type, data = {}) {
    const event = {
      event: type,
      timestamp: new Date().toISOString(),
      ...data,
    };
    if (typeof this.onEvent === 'function') {
      try {
        this.onEvent(event);
      } catch {}
    }
  }

  /**
   * Evaluates whether all success conditions of the intent are met by the observation.
   *
   * @private
   * @param {object} intent
   * @param {object} observation
   * @returns {{ passed: boolean, details: string }}
   */
  _evaluateSuccessConditions(intent, observation) {
    if (!intent.successConditions || intent.successConditions.length === 0) {
      return { passed: true, details: 'No explicit success conditions declared.' };
    }

    const currentUrl = observation?.url || '';
    const currentTitle = observation?.title || '';
    const currentText = observation?.text || '';

    let pathname = '';
    try {
      pathname = new URL(currentUrl).pathname;
    } catch {}

    for (const cond of intent.successConditions) {
      if (cond.type === 'finalPath') {
        if (pathname !== cond.expected && !pathname.endsWith(cond.expected)) {
          return { passed: false, details: `Path mismatch: expected "${cond.expected}", got "${pathname}".` };
        }
      } else if (cond.type === 'pageTitle') {
        if (!currentTitle.includes(cond.expected)) {
          return { passed: false, details: `Title mismatch: "${cond.expected}" not found in "${currentTitle}".` };
        }
      } else if (cond.type === 'textPresent') {
        if (!currentText.includes(cond.expected)) {
          return { passed: false, details: `Text present missing: "${cond.expected}" not found in page text.` };
        }
      } else if (cond.type === 'textAbsent') {
        if (currentText.includes(cond.expected)) {
          return { passed: false, details: `Text absent failed: "${cond.expected}" was found in page text.` };
        }
      }
    }

    return { passed: true, details: 'All declared success conditions satisfied.' };
  }

  /**
   * Executes a discovery session for a given TaskIntent.
   *
   * @param {object} intent - Validated TaskIntent
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ status: string, reason?: string, candidate?: object, contentHash?: string, trace: Array<object>, eventsCount: number }>}
   */
  async runDiscovery(intent, options = {}) {
    const secrets = (intent.parameters || [])
      .map((p) => p.value)
      .filter((v) => typeof v === 'string' && v.trim().length > 0);

    const trace = [];
    let modelCallCount = 0;
    let consecutiveInvalidDecisions = 0;
    let session = null;
    let state = 'INTAKE';

    this._emit('intake', { taskId: intent.taskId, objective: intent.objective });

    try {
      // 1. Launch BrowserSession
      session = await this.browserRuntime.createSession({
        allowLocalhost: this.allowLocalhost,
      });

      // 2. Navigate to initial target origin + startPath
      const initialUrl = `${intent.targetOrigin}${intent.startPath}`;
      await session.navigate(initialUrl);

      // Loop variables
      let stepIndex = 0;
      let lastActionKey = null;
      let lastActionPageHash = null;

      while (stepIndex < this.maxSteps) {
        if (options.signal?.aborted) {
          state = 'CANCELLED';
          return { status: 'CANCELLED', reason: 'Operation aborted by caller signal.', trace, eventsCount: trace.length };
        }

        // Budget check
        if (modelCallCount >= this.maxModelCalls) {
          state = 'ABORTED_BUDGET';
          return { status: 'ABORTED_BUDGET', reason: `Exceeded model call budget (${this.maxModelCalls}).`, trace, eventsCount: trace.length };
        }

        // STATE: OBSERVE
        state = 'OBSERVE';
        const rawSnapshot = await session.getSnapshot({ maxTextLength: 3000, maxElements: 40 });
        const observation = sanitizeSnapshot(rawSnapshot, secrets);
        const currentObservationHash = `${observation.url}::${(observation.text || '').slice(0, 200)}::${(observation.elements || []).length}`;

        this._emit('observe', {
          stepIndex,
          url: redactSecrets(observation.url, secrets),
          title: redactSecrets(observation.title, secrets),
          elementsCount: observation.elements?.length || 0,
        });

        // Check if no interactive elements available
        if (!observation.elements || observation.elements.length === 0) {
          state = 'ABORTED_AMBIGUOUS';
          return {
            status: 'ABORTED_AMBIGUOUS',
            reason: 'Current page contains no interactive elements to proceed.',
            trace,
            eventsCount: trace.length,
          };
        }

        // STATE: DECIDE
        state = 'DECIDE';
        const promptMessages = buildDecisionPrompt({
          intent,
          observation,
          stepIndex,
          trace,
          secrets,
        });

        modelCallCount++;
        let completionResult;
        try {
          completionResult = await this.modelProvider.complete({
            messages: promptMessages,
            maxTokens: 1000,
            timeoutMs: 30000,
          });
        } catch (err) {
          consecutiveInvalidDecisions++;
          if (consecutiveInvalidDecisions >= this.maxConsecutiveInvalidDecisions) {
            state = 'ABORTED_AMBIGUOUS';
            return {
              status: 'ABORTED_AMBIGUOUS',
              reason: `Model completion failed consecutively: ${err.message}`,
              trace,
              eventsCount: trace.length,
            };
          }
          continue;
        }

        let decision;
        try {
          decision = parseDecisionResponse(completionResult.text);
          validateActionDecision(decision, observation, intent);
          consecutiveInvalidDecisions = 0;
        } catch (err) {
          consecutiveInvalidDecisions++;
          this._emit('decide_error', { stepIndex, error: err.message });
          if (consecutiveInvalidDecisions >= this.maxConsecutiveInvalidDecisions) {
            state = 'ABORTED_AMBIGUOUS';
            return {
              status: 'ABORTED_AMBIGUOUS',
              reason: `Model produced invalid action decisions consecutively: ${err.message}`,
              trace,
              eventsCount: trace.length,
            };
          }
          continue;
        }

        this._emit('decide', {
          stepIndex,
          action: decision.action,
          role: decision.role,
          name: redactSecrets(decision.name || '', secrets),
          label: redactSecrets(decision.label || '', secrets),
          done: Boolean(decision.done),
        });

        // If model declares done, verify outcome
        if (decision.done) {
          state = 'VERIFY_OUTCOME';
          const outcome = this._evaluateSuccessConditions(intent, observation);
          if (outcome.passed) {
            this._emit('verdict', { status: 'SUCCESS', details: outcome.details });
            state = 'CONVERT';
            const { candidate, contentHash } = buildCandidateFromTrace({
              trace,
              intent,
              finalObservation: observation,
            });
            return {
              status: 'SUCCESS',
              candidate,
              contentHash,
              trace,
              eventsCount: trace.length,
            };
          } else {
            // Not yet satisfied
            this._emit('outcome_check', { passed: false, details: outcome.details });
          }
        }

        // STATE: GUARD
        state = 'GUARD';
        // Forbidden action check
        const actionSignature = `${decision.action}:${decision.name || decision.label || decision.path}`;
        const isForbidden = (intent.forbidden || []).some((f) => actionSignature.toLowerCase().includes(f.toLowerCase()));
        if (isForbidden) {
          state = 'ABORTED_UNSAFE';
          return {
            status: 'ABORTED_UNSAFE',
            reason: `Action "${actionSignature}" matches forbidden policy in TaskIntent.`,
            trace,
            eventsCount: trace.length,
          };
        }

        // Loop / Duplicate Prevention: if same action on same page state was already executed without state change
        if (actionSignature === lastActionKey && currentObservationHash === lastActionPageHash) {
          state = 'ABORTED_UNVERIFIABLE';
          return {
            status: 'ABORTED_UNVERIFIABLE',
            reason: `Detected redundant action loop: "${actionSignature}" was repeated on identical page state without progress.`,
            trace,
            eventsCount: trace.length,
          };
        }

        // Target element reference
        const observedElement =
          decision.elementIndex !== undefined && observation.elements
            ? observation.elements[decision.elementIndex]
            : null;

        // STATE: ACT
        state = 'ACT';
        const actStartTime = performance.now();
        let actionResult = { ok: false, status: 0, durationMs: 0 };

        try {
          if (decision.action === 'navigate') {
            const nextUrl = new URL(decision.path, intent.targetOrigin).toString();
            await session.navigate(nextUrl);
            actionResult.ok = true;
            actionResult.status = 200;
          } else if (decision.action === 'clickByRole') {
            await session.clickByRole({ role: decision.role, name: decision.name });
            actionResult.ok = true;
            actionResult.status = 200;
          } else if (decision.action === 'fillByLabel') {
            const param = (intent.parameters || []).find((p) => p.name === decision.inputName);
            const value = param ? param.value : '';
            await session.fillByLabel({ label: decision.label, value });
            actionResult.ok = true;
            actionResult.status = 200;
          }
        } catch (err) {
          actionResult.ok = false;
          actionResult.error = redactSecrets(err.message, secrets);
        }

        actionResult.durationMs = Math.round(performance.now() - actStartTime);

        // Record trace entry
        trace.push({
          stepIndex,
          decision,
          observedElement,
          result: actionResult,
        });

        this._emit('act', {
          stepIndex,
          action: decision.action,
          ok: actionResult.ok,
          durationMs: actionResult.durationMs,
        });

        if (!actionResult.ok) {
          // If action execution failed in browser, fail closed
          state = 'ABORTED_AMBIGUOUS';
          return {
            status: 'ABORTED_AMBIGUOUS',
            reason: `Action execution failed in browser: ${actionResult.error}`,
            trace,
            eventsCount: trace.length,
          };
        }

        lastActionKey = actionSignature;
        lastActionPageHash = currentObservationHash;
        stepIndex++;

        // Settle briefly after action
        await new Promise((res) => setTimeout(res, 200));

        // Post-action verification check
        const postSnapshot = await session.getSnapshot({ maxTextLength: 3000, maxElements: 40 });
        const postObservation = sanitizeSnapshot(postSnapshot, secrets);
        const autoOutcome = this._evaluateSuccessConditions(intent, postObservation);

        if (autoOutcome.passed) {
          state = 'CONVERT';
          this._emit('verdict', { status: 'SUCCESS', details: autoOutcome.details });
          const { candidate, contentHash } = buildCandidateFromTrace({
            trace,
            intent,
            finalObservation: postObservation,
          });
          return {
            status: 'SUCCESS',
            candidate,
            contentHash,
            trace,
            eventsCount: trace.length,
          };
        }
      }

      // If loop exited due to step bound
      state = 'ABORTED_BUDGET';
      return {
        status: 'ABORTED_BUDGET',
        reason: `Exceeded maximum discovery steps (${this.maxSteps}) without achieving verified outcome.`,
        trace,
        eventsCount: trace.length,
      };
    } finally {
      if (session) {
        await session.close().catch(() => {});
      }
    }
  }
}
