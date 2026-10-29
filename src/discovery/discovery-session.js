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

const CONSEQUENTIAL_TEXT_PATTERNS = [
  /order/i,
  /checkout/i,
  /purchase/i,
  /payment/i,
  /\bpay\b/i,
  /submit/i,
  /\bsend\b/i,
  /delete/i,
  /remove/i,
];

function getActionTargetText(decision, observedElement) {
  const parts = [
    decision?.name,
    decision?.label,
    decision?.path,
    observedElement?.name,
    observedElement?.placeholder,
  ];
  return parts.filter((part) => typeof part === 'string' && part.trim() !== '').join(' | ');
}

function actionRequiresApproval(decision, observedElement, intent) {
  const targetText = getActionTargetText(decision, observedElement);
  const normalizedTarget = targetText.toLowerCase();

  for (const term of intent.approvalRequired || []) {
    if (typeof term === 'string' && term.trim() !== '' && normalizedTarget.includes(term.toLowerCase())) {
      return { required: true, reason: `matches TaskIntent approval-required term "${term}"` };
    }
  }

  const matchedPattern = CONSEQUENTIAL_TEXT_PATTERNS.find((pattern) => pattern.test(targetText));
  if (matchedPattern) {
    return { required: true, reason: `matches consequential-action pattern ${matchedPattern}` };
  }

  return { required: false };
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
   * @param {Function} [options.approveAction] - Explicit approval callback for consequential actions
   * @param {number} [options.maxWallClockMs=300000] - Maximum discovery wall-clock duration
   * @param {number} [options.maxTotalTokens=60000] - Maximum cumulative model tokens
   * @param {Function} [options.now] - Injectable clock returning milliseconds, for tests
   */
  constructor({
    browserRuntime,
    modelProvider,
    maxSteps = 25,
    maxModelCalls = 30,
    maxConsecutiveInvalidDecisions = 2,
    allowLocalhost = false,
    onEvent = null,
    approveAction = null,
    maxWallClockMs = 300000,
    maxTotalTokens = 60000,
    now = null,
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
    this.approveAction = approveAction;
    this.maxWallClockMs = maxWallClockMs;
    this.maxTotalTokens = maxTotalTokens;
    this.clockNow = typeof now === 'function' ? now : () => performance.now();
    this.totalTokensUsed = 0;
  }

  _wallClockExceeded(startTime) {
    if (!Number.isFinite(this.maxWallClockMs) || this.maxWallClockMs < 0) {
      return false;
    }
    return this.clockNow() - startTime >= this.maxWallClockMs;
  }

  _addModelTokenUsage(usage, fallbackTokens) {
    let tokens = 0;
    if (usage && typeof usage === 'object') {
      if (Number.isFinite(usage.totalTokens)) {
        tokens = usage.totalTokens;
      } else {
        const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
        const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
        tokens = inputTokens + outputTokens;
      }
    }
    if (!(tokens > 0)) {
      tokens = fallbackTokens;
    }
    this.totalTokensUsed = (this.totalTokensUsed || 0) + tokens;
    return this.totalTokensUsed;
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
    const startTime = this.clockNow();
    const maxTokensPerCall = 2048;
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
      const attemptedConsequentialActions = new Set();

      while (stepIndex < this.maxSteps) {
        if (options.signal?.aborted) {
          state = 'CANCELLED';
          return { status: 'CANCELLED', reason: 'Operation aborted by caller signal.', trace, eventsCount: trace.length };
        }

        // Budget checks: model calls and wall-clock time terminate before further work.
        if (modelCallCount >= this.maxModelCalls) {
          state = 'ABORTED_BUDGET';
          return { status: 'ABORTED_BUDGET', reason: `Exceeded model call budget (${this.maxModelCalls}).`, trace, eventsCount: trace.length };
        }
        if (this._wallClockExceeded(startTime)) {
          state = 'ABORTED_BUDGET';
          return { status: 'ABORTED_BUDGET', reason: `Exceeded maximum discovery wall-clock duration (${this.maxWallClockMs}ms).`, trace, eventsCount: trace.length };
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
            maxTokens: maxTokensPerCall,
            timeoutMs: 30000,
            signal: options.signal,
          });
          this._addModelTokenUsage(completionResult?.usage, maxTokensPerCall);
          if (Number.isFinite(this.maxTotalTokens) && this.totalTokensUsed >= this.maxTotalTokens) {
            state = 'ABORTED_BUDGET';
            return { status: 'ABORTED_BUDGET', reason: `Exceeded maximum cumulative model tokens (${this.maxTotalTokens}).`, trace, eventsCount: trace.length };
          }
          if (this._wallClockExceeded(startTime)) {
            state = 'ABORTED_BUDGET';
            return { status: 'ABORTED_BUDGET', reason: `Exceeded maximum discovery wall-clock duration (${this.maxWallClockMs}ms).`, trace, eventsCount: trace.length };
          }
        } catch (err) {
          if (options.signal?.aborted) {
            state = 'CANCELLED';
            return { status: 'CANCELLED', reason: 'Operation aborted by caller signal.', trace, eventsCount: trace.length };
          }
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

        // Target element reference
        const observedElement =
          decision.elementIndex !== undefined && observation.elements
            ? observation.elements[decision.elementIndex]
            : null;

        // Consequential-action approval: deterministic policy only, never model rationale.
        // Consequential actions are single-attempt: an uncertain outcome must not be retried blindly.
        const approvalCheck = actionRequiresApproval(decision, observedElement, intent);
        if (approvalCheck.required) {
          const consequentialKey = `${decision.action}:${decision.elementIndex ?? ''}:${getActionTargetText(decision, observedElement).toLowerCase()}`;
          if (attemptedConsequentialActions.has(consequentialKey)) {
            state = 'ABORTED_UNVERIFIABLE';
            return {
              status: 'ABORTED_UNVERIFIABLE',
              reason: `Consequential action "${actionSignature}" was already attempted once; refusing a blind retry.`,
              trace,
              eventsCount: trace.length,
            };
          }
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

        let consequentialApproval = null;
        if (approvalCheck.required) {
          const consequentialKey = `${decision.action}:${decision.elementIndex ?? ''}:${getActionTargetText(decision, observedElement).toLowerCase()}`;

          this._emit('approval_required', {
            stepIndex,
            action: decision.action,
            target: getActionTargetText(decision, observedElement),
            reason: approvalCheck.reason,
          });

          if (typeof this.approveAction !== 'function') {
            state = 'APPROVAL_REQUIRED';
            return {
              status: 'APPROVAL_REQUIRED',
              reason: `Consequential action "${actionSignature}" requires explicit approval (${approvalCheck.reason}). No action was performed.`,
              trace,
              eventsCount: trace.length,
            };
          }

          let approved = false;
          try {
            approved = await this.approveAction({
              intent,
              decision,
              observedElement,
              observation,
              reason: approvalCheck.reason,
            });
          } catch (err) {
            state = 'APPROVAL_REQUIRED';
            return {
              status: 'APPROVAL_REQUIRED',
              reason: `Consequential action "${actionSignature}" requires explicit approval; approval callback failed: ${err.message}. No action was performed.`,
              trace,
              eventsCount: trace.length,
            };
          }

          if (!approved) {
            state = 'APPROVAL_REQUIRED';
            return {
              status: 'APPROVAL_REQUIRED',
              reason: `Consequential action "${actionSignature}" was declined. No action was performed.`,
              trace,
              eventsCount: trace.length,
            };
          }

          attemptedConsequentialActions.add(consequentialKey);
          consequentialApproval = { approved: true, source: 'explicit-callback', reason: approvalCheck.reason };
        }

        if (this._wallClockExceeded(startTime)) {
          state = 'ABORTED_BUDGET';
          return { status: 'ABORTED_BUDGET', reason: `Exceeded maximum discovery wall-clock duration (${this.maxWallClockMs}ms).`, trace, eventsCount: trace.length };
        }

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
          ...(consequentialApproval ? { approval: consequentialApproval } : {}),
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
        if (trace.length > 0) {
          trace[trace.length - 1].postObservation = postObservation;
        }
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
