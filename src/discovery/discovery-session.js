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
import { DiscoverySessionJournal } from './session-journal.js';

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

// Ambiguous forward-progression controls. Harmless on ordinary pages, but on
// checkout, payment, billing, order-review, or confirmation surfaces they are
// frequently the control that submits, pays, or finalizes. Never treat them
// as self-evidently safe.
const AMBIGUOUS_PROGRESSION_PATTERNS = [
  /\bcontinue\b/i,
  /\bnext\b/i,
  /\bproceed\b/i,
  /\bconfirm\b/i,
  /\bfinish\b/i,
];

// Page surfaces where an ambiguous control must be treated as consequential.
// Matched against URL pathname and page title only (never full page text, so
// incidental body copy cannot widen the policy).
const SENSITIVE_PAGE_PATTERNS = [
  /checkout/i,
  /payment/i,
  /billing/i,
  /\border\b/i,
  /review/i,
  /confirm/i,
  /\bpay\b/i,
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

function getPageContextText(observation) {
  let pathname = '';
  try {
    pathname = new URL(observation?.url || '').pathname;
  } catch {}
  return `${pathname} | ${observation?.title || ''}`;
}

function actionRequiresApproval(decision, observedElement, intent, observation) {
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

  const ambiguousMatch = AMBIGUOUS_PROGRESSION_PATTERNS.find((pattern) => pattern.test(targetText));
  if (ambiguousMatch) {
    const pageContext = getPageContextText(observation);
    const sensitivePage = SENSITIVE_PAGE_PATTERNS.find((pattern) => pattern.test(pageContext));
    if (sensitivePage) {
      return {
        required: true,
        reason: `ambiguous progression control (${ambiguousMatch}) on a sensitive page surface (${sensitivePage})`,
      };
    }
    const declaredPolicy = [...(intent.approvalRequired || []), ...(intent.forbidden || [])].filter(
      (term) => typeof term === 'string' && term.trim() !== ''
    );
    if (declaredPolicy.length > 0) {
      return {
        required: true,
        reason: `ambiguous progression control (${ambiguousMatch}) while the task declares an approval/forbidden policy`,
      };
    }
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
   * @param {string|null} [options.journalDir] - Scratch directory for crash-safe session journaling (null disables)
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
    journalDir = null,
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
    this.journalDir = journalDir;
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
  _evaluateSuccessConditions(intent, rawEvidence) {
    const conditions = Array.isArray(intent?.successConditions) ? intent.successConditions : [];
    if (conditions.length === 0) {
      return { passed: true, details: 'No explicit success conditions declared.' };
    }

    // Raw browser evidence is trusted-local only. It must never be forwarded to
    // the provider, events, journals, diagnostics, or persisted artifacts. The
    // result intentionally reports only whether every condition passed.
    if (!rawEvidence || typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) {
      return { passed: false, details: 'Success conditions were not satisfied.' };
    }

    const currentUrl = typeof rawEvidence.url === 'string' ? rawEvidence.url : '';
    const currentTitle = typeof rawEvidence.title === 'string' ? rawEvidence.title : '';
    const currentText = typeof rawEvidence.text === 'string' ? rawEvidence.text : '';

    // Parameter-bound conditions resolve locally from declared task
    // parameters. Resolved values stay inside this trusted-local evaluation:
    // they are never emitted in details, events, journals, or model prompts.
    const parameterValues = {};
    for (const param of intent?.parameters || []) {
      if (param && typeof param.name === 'string') {
        parameterValues[param.name] = param.value;
      }
    }

    let pathname = '';
    try {
      pathname = new URL(currentUrl).pathname;
    } catch {}

    for (const cond of conditions) {
      if (!cond || typeof cond !== 'object') {
        return { passed: false, details: 'Success conditions were not satisfied.' };
      }

      let expected;
      if (cond.input !== undefined) {
        const resolved = parameterValues[cond.input];
        if (typeof resolved !== 'string' || resolved.trim() === '') {
          return { passed: false, details: 'Success conditions were not satisfied.' };
        }
        expected = resolved;
      } else if (typeof cond.expected === 'string' && cond.expected.trim() !== '') {
        expected = cond.expected;
      } else {
        return { passed: false, details: 'Success conditions were not satisfied.' };
      }

      if (cond.type === 'finalPath') {
        if (cond.input !== undefined || (pathname !== expected && !pathname.endsWith(expected))) {
          return { passed: false, details: 'Success conditions were not satisfied.' };
        }
      } else if (cond.type === 'pageTitle') {
        if (!currentTitle.includes(expected)) {
          return { passed: false, details: 'Success conditions were not satisfied.' };
        }
      } else if (cond.type === 'textPresent') {
        if (!currentText.includes(expected)) {
          return { passed: false, details: 'Success conditions were not satisfied.' };
        }
      } else if (cond.type === 'textAbsent') {
        if (currentText.includes(expected)) {
          return { passed: false, details: 'Success conditions were not satisfied.' };
        }
      } else {
        return { passed: false, details: 'Success conditions were not satisfied.' };
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
    // Preflight: every parameter referenced by a success condition must have
    // a usable value before any browser session or action begins. A
    // referenced parameter is required for this run even if the intent lists
    // it with an empty value. The reason names parameters only, never values.
    const parameterValues = {};
    for (const param of intent?.parameters || []) {
      if (param && typeof param.name === 'string') {
        parameterValues[param.name] = param.value;
      }
    }
    const unresolvedRefs = [];
    for (const cond of intent?.successConditions || []) {
      if (cond && cond.input !== undefined) {
        const value = parameterValues[cond.input];
        if (typeof value !== 'string' || value.trim() === '') {
          unresolvedRefs.push(cond.input);
        }
      }
    }
    if (unresolvedRefs.length > 0) {
      return {
        status: 'ABORTED_UNVERIFIABLE',
        reason: `Success conditions reference task parameters that were not supplied with usable values: ${[...new Set(unresolvedRefs)].join(', ')}.`,
        trace: [],
        eventsCount: 0,
      };
    }

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
    let lastJournalObservation = null;
    // Loop variables are function-scoped so the finally journal handoff can read them.
    let stepIndex = 0;
    let lastActionKey = null;
    let lastActionPageHash = null;
    const attemptedConsequentialActions = new Set();

    this._emit('intake', { taskId: intent.taskId, objective: intent.objective });

    // Crash-safe scratch journal (diagnostic only; never executed from).
    let journal = null;
    if (this.journalDir) {
      try {
        journal = new DiscoverySessionJournal({
          journalDir: this.journalDir,
          taskId: intent.taskId,
          secrets,
        });
        await journal.checkpoint({
          intent,
          stepIndex: 0,
          modelCallCount: 0,
          totalTokensUsed: 0,
          lastObservation: null,
          attemptedConsequentialKeys: [],
          reason: 'session started',
        });
      } catch (err) {
        this._emit('journal_error', { message: err.message });
        journal = null;
      }
    }
    this.lastJournalPath = journal ? journal.journalPath : null;

    try {
      // 1. Launch BrowserSession
      session = await this.browserRuntime.createSession({
        allowLocalhost: this.allowLocalhost,
      });

      // 2. Navigate to initial target origin + startPath
      const initialUrl = `${intent.targetOrigin}${intent.startPath}`;
      await session.navigate(initialUrl);

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
        lastJournalObservation = observation;
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

        // If model declares done, verify outcome against raw local evidence.
        // The model only receives the sanitized observation above.
        if (decision.done) {
          state = 'VERIFY_OUTCOME';
          const outcome = this._evaluateSuccessConditions(intent, rawSnapshot);
          if (outcome.passed) {
            if (trace.length === 0) {
              state = 'ABORTED_UNVERIFIABLE';
              return {
                status: 'ABORTED_UNVERIFIABLE',
                reason: 'Outcome verified with no executed actions; an empty trace cannot produce a candidate workflow.',
                trace,
                eventsCount: trace.length,
              };
            }
            this._emit('verdict', { status: 'SUCCESS', details: outcome.details });
            state = 'SUCCESS';
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
        const approvalCheck = actionRequiresApproval(decision, observedElement, intent, observation);
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

        // Record trace entry. preObservation is the sanitized observation the
        // decision was grounded in; postObservation is attached after the
        // action settles. Candidate conversion pairs them to prove action
        // effects before persisting any step verification.
        trace.push({
          stepIndex,
          decision,
          observedElement,
          preObservation: observation,
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
        lastJournalObservation = postObservation;
        if (journal) {
          try {
            await journal.checkpoint({
              intent,
              stepIndex,
              modelCallCount,
              totalTokensUsed: this.totalTokensUsed,
              lastObservation: postObservation,
              attemptedConsequentialKeys: [...attemptedConsequentialActions],
              reason: `completed step ${stepIndex}`,
            });
          } catch (err) {
            this._emit('journal_error', { message: err.message });
          }
        }
        // Verify with the raw post-action snapshot before it crosses any
        // redaction, logging, journal, or candidate-conversion boundary.
        const autoOutcome = this._evaluateSuccessConditions(intent, postSnapshot);

        if (autoOutcome.passed) {
          if (trace.length === 0) {
            state = 'ABORTED_UNVERIFIABLE';
            return {
              status: 'ABORTED_UNVERIFIABLE',
              reason: 'Outcome verified with no executed actions; an empty trace cannot produce a candidate workflow.',
              trace,
              eventsCount: trace.length,
            };
          }
          state = 'SUCCESS';
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
      if (journal) {
        try {
          if (state === 'SUCCESS') {
            // The completed candidate lives in the workflow repository; scratch is deleted.
            await journal.discard();
          } else if (
            state === 'CANCELLED' ||
            state === 'APPROVAL_REQUIRED' ||
            state.startsWith('ABORTED')
          ) {
            await journal.finalize(state, {
              intent,
              stepIndex,
              modelCallCount,
              totalTokensUsed: this.totalTokensUsed,
              lastObservation: lastJournalObservation,
              attemptedConsequentialKeys: [...attemptedConsequentialActions],
              reason: `terminal state ${state}`,
            });
          } else {
            // Interrupted mid-state (exception or crash path): leave an in-progress marker.
            await journal.checkpoint({
              intent,
              stepIndex,
              modelCallCount,
              totalTokensUsed: this.totalTokensUsed,
              lastObservation: lastJournalObservation,
              attemptedConsequentialKeys: [...attemptedConsequentialActions],
              reason: `interrupted during ${state}`,
            });
          }
        } catch (err) {
          this._emit('journal_error', { message: err.message });
        }
      }
      if (session) {
        await session.close().catch(() => {});
      }
    }
  }
}
