/**
 * Super Memory — Workflow Player
 *
 * Implements deterministic playback of verified workflows using the persistent
 * FileSystemWorkflowRepository and isolated BrowserSession instances from BrowserRuntime.
 *
 * Guarantees & Constraints:
 * - Precondition safety: rejects missing, disabled, corrupt, draft-only, and unverified workflows.
 * - Playback integrity: recomputes the content hash and revalidates verification evidence before every run.
 * - Runtime input safety: validates all inputs before browser startup, rejecting empty required values.
 * - Origin confinement: enforces declared target origin on initial navigation, subsequent steps, redirects
 *   (Location and Refresh headers), popups/new tabs, and success-criteria evaluation.
 * - Failure isolation: halts immediately on step failure or predicate mismatch; skips subsequent steps.
 * - Credential hygiene: runtime input values and passwords are never logged or stored in run results,
 *   and supplied values are redacted from error messages.
 * - Subresource observability: cross-origin subresource origins and types are recorded per run
 *   (bounded, sanitized, input-redacted); allow behavior is unchanged.
 * - Resource hygiene: guarantees session closure in finally; preserves caller-owned shared runtimes.
 * - Workflow immutability: performs strictly read-only repository operations during playback.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  WorkflowError,
  CorruptRecordError,
  WorkflowValidationError,
  WorkflowNotFoundError,
  WorkflowDisabledError,
  NoVerifiedVersionError,
  WorkflowExecutionError,
} from './errors.js';

import { validateWorkflowId, verifyEvidenceMatchesWorkflow } from './schema.js';
import { calculateContentHash } from './hash.js';
import { createBrowserRuntime, ActionError } from '../browser/index.js';

/**
 * Escapes a literal string for safe inclusion in a dynamically built RegExp.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts supplied secret values from diagnostic text, covering exact,
 * trimmed, and collapsed-whitespace variants case-insensitively.
 *
 * Secret matching is syntactic, not taint tracking: occurrences of the given
 * secret strings are redacted, but transformed secrets cannot be detected.
 *
 * @param {string} text
 * @param {Array<unknown>} [secrets] - Candidate secret values; only
 *   non-empty strings participate in redaction.
 * @returns {string}
 */
function redactSecrets(text, secrets) {
  if (typeof text !== 'string') return text;
  if (!Array.isArray(secrets) || secrets.length === 0) return text;
  const variants = new Set();
  for (const secret of secrets) {
    if (typeof secret !== 'string') continue;
    const collapsed = secret.replace(/\s+/g, ' ').trim();
    for (const variant of [secret, secret.trim(), collapsed]) {
      if (variant) variants.add(variant);
    }
  }
  let out = text;
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  for (const variant of ordered) {
    out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '[REDACTED]');
  }
  return out;
}

/**
 * Sanitizes error messages for safe inclusion in run results.
 *
 * - Strips query strings and fragments from URLs of any scheme, keeping
 *   origin + path for hierarchical URLs.
 * - Fully redacts opaque executable-scheme URLs (javascript:, data:, ...).
 * - Redacts supplied secret values, including case and whitespace variants.
 * - Truncates the result to 500 characters.
 *
 * Secret matching is syntactic, not taint tracking: occurrences of the given
 * secret strings are redacted, but transformed secrets cannot be detected.
 *
 * @param {string} rawMessage
 * @param {Array<unknown>} [secrets=[]] - Candidate secret values; only
 *   non-empty strings participate in redaction.
 * @returns {string}
 */
export function sanitizeErrorMessage(rawMessage, secrets = []) {
  if (typeof rawMessage !== 'string') return 'Unknown execution error';
  let out = rawMessage
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+/g, (match) => {
      try {
        const u = new URL(match);
        if (u.origin && u.origin !== 'null') {
          return `${u.origin}${u.pathname}`;
        }
      } catch {
        // Fall through to manual stripping below.
      }
      return match.split('?')[0].split('#')[0];
    })
    .replace(/\b(javascript|data|vbscript|file):(?!\/\/)[^\s"'<>]*/gi, '$1:[REDACTED]');

  return redactSecrets(out, secrets).slice(0, 500);
}

/**
 * Evaluates an HTTP Refresh header value against the origin-confinement policy.
 *
 * Browsers honor Refresh headers on document responses by reloading or
 * navigating after the stated delay, so a cross-origin target would otherwise
 * escape every post-action check once its timer outlasts the settle windows.
 * Only delay-only values (same-URL reload, re-checked on re-navigation) and
 * same-origin http(s) targets may proceed; cross-origin, non-http(s), and
 * unparseable targets fail closed. The delay is intentionally ignored: the
 * run must not wait out an attacker's timer to observe the escape.
 *
 * @param {string} rawValue - Raw Refresh header value.
 * @param {string} baseUrl - URL of the response carrying the header.
 * @param {string} targetOrigin - Declared workflow target origin.
 * @returns {{ ok: boolean, detail: string|null }} Verdict plus the offending
 *   target for error reporting (already destined for sanitization).
 */
export function evaluateRefreshHeader(rawValue, baseUrl, targetOrigin) {
  const value = String(rawValue).trim();
  // The delay/target separator may be ';' or ','; only the first one delimits.
  let sep = -1;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === ';' || value[i] === ',') {
      sep = i;
      break;
    }
  }
  if (sep === -1) {
    return { ok: true, detail: null };
  }
  let candidate = value
    .slice(sep + 1)
    .trim()
    .replace(/^url\s*=\s*/i, '')
    .trim();
  if (
    candidate.length >= 2 &&
    ((candidate.startsWith('"') && candidate.endsWith('"')) ||
      (candidate.startsWith("'") && candidate.endsWith("'")))
  ) {
    candidate = candidate.slice(1, -1);
  }
  if (!candidate) {
    return { ok: true, detail: null };
  }
  let resolved = null;
  try {
    resolved = new URL(candidate, baseUrl);
  } catch {
    resolved = null;
  }
  if (!resolved) {
    return { ok: false, detail: candidate };
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return { ok: false, detail: resolved.href };
  }
  if (resolved.origin !== targetOrigin) {
    return { ok: false, detail: resolved.href };
  }
  return { ok: true, detail: null };
}

/**
 * Finds the first recorded main-frame commit that violates origin confinement.
 *
 * Detection only: this reports navigations that already committed; it does not
 * prevent them. Pre-commit prevention is the route layer's job. Permitted
 * commits are the declared target origin plus explicit null-origin cases:
 * `about:blank` (fresh pages, blocked-popup residue) and `chrome-error://`
 * pages (the expected residue of aborted navigations).
 *
 * @param {Array<unknown>} committedUrls - Recorded frame URLs in commit order.
 * @param {string} targetOrigin - Declared workflow target origin.
 * @returns {string|null} First violating URL, or null when history is clean.
 */
export function findAuditViolation(committedUrls, targetOrigin) {
  if (!Array.isArray(committedUrls)) return null;
  for (const url of committedUrls) {
    if (url === 'about:blank') continue;
    if (typeof url === 'string' && url.startsWith('chrome-error://')) continue;
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = null;
    }
    if (origin !== targetOrigin) {
      return typeof url === 'string' ? url : '(unavailable)';
    }
  }
  return null;
}

/**
 * Attaches commit-audit listeners to the session's main page and to every page
 * subsequently created in its context, recording main-frame commit URLs.
 *
 * Registration is best-effort and the audit never throws into the run: route
 * interception remains the enforcement layer. Primary listener cleanup is the
 * per-play context lifecycle (destroyed on session close); the returned
 * detach function performs additional explicit removal.
 *
 * @param {import('../browser/browser-session.js').BrowserSession} session
 * @param {Array<string>} sink - Receives committed main-frame URLs.
 * @returns {() => Promise<void>} Detach function for explicit cleanup.
 */
function attachCommitAudit(session, sink) {
  const frameNavigatedHandler = (frame) => {
    try {
      if (frame && frame === frame.page().mainFrame()) {
        sink.push(frame.url());
      }
    } catch {
      // Audit must never break the run.
    }
  };
  const pageCreatedHandler = (newPage) => {
    try {
      newPage.on('framenavigated', frameNavigatedHandler);
    } catch {
      // Best effort: unobservable popups remain covered by checkpoints.
    }
  };
  try {
    session.page.on('framenavigated', frameNavigatedHandler);
  } catch {
    // Best effort: a dead main page fails the run through navigation anyway.
  }
  try {
    session.context.on('page', pageCreatedHandler);
  } catch {
    // Best effort.
  }
  return async () => {
    try {
      await session.page.removeListener?.('framenavigated', frameNavigatedHandler);
    } catch {
      // Best effort: context destruction is the primary cleanup.
    }
    try {
      await session.context.removeListener?.('page', pageCreatedHandler);
    } catch {
      // Best effort.
    }
  };
}

/**
 * Validates runtime inputs against workflow declared inputs.
 *
 * @param {Array<object>} declaredInputs
 * @param {Record<string, unknown>} providedInputs
 * @param {string} workflowId
 */
export function validateRuntimeInputs(declaredInputs, providedInputs, workflowId) {
  if (!providedInputs || typeof providedInputs !== 'object' || Array.isArray(providedInputs)) {
    throw new WorkflowValidationError(
      `Runtime inputs for workflow "${workflowId}" must be an object, received ${providedInputs === null ? 'null' : Array.isArray(providedInputs) ? 'array' : typeof providedInputs}.`
    );
  }

  const declaredMap = new Map();
  for (const input of declaredInputs) {
    declaredMap.set(input.name, input);
  }

  // 1. Reject undeclared inputs
  for (const key of Object.keys(providedInputs)) {
    if (!declaredMap.has(key)) {
      throw new WorkflowValidationError(
        `Unknown input "${key}" provided for workflow "${workflowId}".`,
        { path: `inputs.${key}` }
      );
    }
  }

  // 2. Validate declared inputs
  for (const input of declaredInputs) {
    const val = providedInputs[input.name];
    if (input.required) {
      if (val === undefined || val === null) {
        throw new WorkflowValidationError(
          `Missing required input "${input.name}" for workflow "${workflowId}".`,
          { path: `inputs.${input.name}` }
        );
      }
      if (typeof val !== 'string') {
        throw new WorkflowValidationError(
          `Value for required input "${input.name}" must be a string.`,
          { path: `inputs.${input.name}` }
        );
      }
      if (val.trim() === '') {
        throw new WorkflowValidationError(
          `Required input "${input.name}" cannot be empty for workflow "${workflowId}".`,
          { path: `inputs.${input.name}` }
        );
      }
    } else {
      if (val !== undefined && val !== null && typeof val !== 'string') {
        throw new WorkflowValidationError(
          `Value for optional input "${input.name}" must be a string.`,
          { path: `inputs.${input.name}` }
        );
      }
    }
  }
}

/**
 * Asserts that a URL matches the declared target origin, preventing external redirects.
 *
 * @param {string} urlToCheck
 * @param {string} targetOrigin
 * @param {string} contextDesc
 */
function assertTargetOrigin(urlToCheck, targetOrigin, contextDesc) {
  let parsed;
  try {
    parsed = new URL(urlToCheck);
  } catch (err) {
    throw new ActionError(`Invalid URL reached during "${contextDesc}": "${urlToCheck}".`, {
      action: contextDesc,
      cause: err,
    });
  }
  if (parsed.origin !== targetOrigin) {
    throw new ActionError(
      `Cross-origin navigation rejected: destination "${parsed.origin}" does not match declared target origin "${targetOrigin}".`,
      { action: contextDesc, target: targetOrigin }
    );
  }
}

/**
 * Grace window in milliseconds for detecting popups/new tabs opened as a
 * side effect of a navigation or step action. Each confinement checkpoint
 * waits up to this long for late-arriving popup events before proceeding.
 * A popup delayed beyond this window is caught at the next checkpoint, if
 * one remains before the session closes (documented residual risk).
 */
const POPUP_SETTLE_MS = 500;

/**
 * Maximum unique (origin, resourceType) pairs retained in a run's
 * subresource report. Further pairs are counted as omitted without storing
 * their origins, bounding per-run memory on request-heavy pages.
 */
const SUBRESOURCE_REPORT_PAIR_LIMIT = 100;

/**
 * Enforces origin confinement across every page in the session context.
 *
 * The route handler blocks cross-origin top-level navigations on all pages,
 * but popup creation is asynchronous: this checkpoint closes every popup or
 * new tab (the player never drives them), reports any popup whose committed
 * URL already escaped the declared origin, and waits briefly for in-flight
 * popups to arrive so click-triggered escapes are observed before the run
 * proceeds.
 *
 * @param {import('../browser/browser-session.js').BrowserSession} session
 * @param {string} targetOrigin - Declared workflow target origin.
 * @returns {Promise<string|null>} Escaped popup URL, or null when none found.
 */
async function enforcePopupConfinement(session, targetOrigin) {
  const mainPage = session.page;
  let violation = null;

  const inspectPopup = async (popup) => {
    if (!popup || popup === mainPage) return;
    try {
      if (popup.isClosed()) return;
      let url = '';
      try {
        url = popup.url();
      } catch {
        url = '';
      }
      if (url && url !== 'about:blank') {
        let origin = null;
        try {
          origin = new URL(url).origin;
        } catch {
          origin = null;
        }
        if (origin !== targetOrigin && !violation) {
          violation = url;
        }
      }
      await popup.close().catch(() => {});
    } catch {
      // Best effort: uninspectable popups are still closed above when possible.
    }
  };

  const sweepPages = async () => {
    let pages = [];
    try {
      pages = session.context.pages();
    } catch {
      pages = [];
    }
    for (const page of pages) {
      await inspectPopup(page);
    }
  };

  await sweepPages();

  const deadline = Date.now() + POPUP_SETTLE_MS;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let popup = null;
    try {
      popup = await mainPage.waitForEvent('popup', { timeout: remaining });
    } catch {
      popup = null;
    }
    if (!popup) break;
    await inspectPopup(popup);
  }

  await sweepPages();
  return violation;
}

/**
 * Evaluates an in-step verification predicate against the current session DOM.
 *
 * @param {import('../browser/browser-session.js').BrowserSession} session
 * @param {object} verification
 * @returns {Promise<{ type: string, passed: boolean }>}
 */
async function evaluateVerificationPredicate(session, verification) {
  if (verification.type === 'pageTitle') {
    const title = await session.page.title();
    const passed = title.includes(verification.expected);
    return { type: verification.type, passed };
  }

  if (verification.type === 'textPresent') {
    const snapshot = await session.getSnapshot({ maxTextLength: 10000 });
    const passed = snapshot.text.includes(verification.expected);
    return { type: verification.type, passed };
  }

  if (verification.type === 'textAbsent') {
    const snapshot = await session.getSnapshot({ maxTextLength: 10000 });
    const passed = !snapshot.text.includes(verification.expected);
    return { type: verification.type, passed };
  }

  return { type: verification.type, passed: false };
}

/**
 * Evaluates workflow success criteria at the conclusion of execution.
 *
 * @param {import('../browser/browser-session.js').BrowserSession} session
 * @param {object} criteria
 * @returns {Promise<{ passed: boolean, finalPathMatched: boolean|null, pageTitleMatched: boolean|null, textPresentFound: boolean|null, textAbsentFound: boolean|null }>}
 */
async function evaluateSuccessCriteria(session, criteria) {
  const result = {
    passed: true,
    finalPathMatched: null,
    pageTitleMatched: null,
    textPresentFound: null,
    textAbsentFound: null,
  };

  if (!criteria || typeof criteria !== 'object') {
    return result;
  }

  if (criteria.finalPath !== undefined) {
    let currentPath;
    try {
      currentPath = new URL(session.page.url()).pathname;
    } catch {
      currentPath = '';
    }
    const matched = currentPath === criteria.finalPath;
    result.finalPathMatched = matched;
    if (!matched) result.passed = false;
  }

  if (criteria.pageTitle !== undefined) {
    const title = await session.page.title();
    const matched = title.includes(criteria.pageTitle);
    result.pageTitleMatched = matched;
    if (!matched) result.passed = false;
  }

  if (criteria.textPresent !== undefined || criteria.textAbsent !== undefined) {
    const snapshot = await session.getSnapshot({ maxTextLength: 10000 });
    if (criteria.textPresent !== undefined) {
      const found = snapshot.text.includes(criteria.textPresent);
      result.textPresentFound = found;
      if (!found) result.passed = false;
    }
    if (criteria.textAbsent !== undefined) {
      const absentPassed = !snapshot.text.includes(criteria.textAbsent);
      result.textAbsentFound = absentPassed;
      if (!absentPassed) result.passed = false;
    }
  }

  return result;
}

export class WorkflowPlayer {
  /**
   * @param {object} options
   * @param {import('./repository.js').FileSystemWorkflowRepository} options.repository - Persistent storage repository.
   * @param {import('../browser/browser-runtime.js').BrowserRuntime} [options.browserRuntime] - Shared browser runtime.
   * @param {boolean} [options.allowLocalhost=false] - Whether localhost/loopback destinations are permitted.
   * @param {boolean} [options.headless=true] - Run browser in headless mode.
   */
  constructor({ repository, browserRuntime = null, allowLocalhost = false, headless = true } = {}) {
    if (!repository || typeof repository.getManifest !== 'function') {
      throw new WorkflowError('A valid FileSystemWorkflowRepository instance is required for WorkflowPlayer.');
    }
    this.repository = repository;
    this.allowLocalhost = Boolean(allowLocalhost);
    this.headless = Boolean(headless);
    this.ownsRuntime = !browserRuntime;
    this._browserRuntime = browserRuntime;
    this._isClosed = false;
  }

  /**
   * Lazily provisions the managed browser runtime if owned and not yet launched.
   *
   * @private
   * @returns {Promise<import('../browser/browser-runtime.js').BrowserRuntime>}
   */
  async _getRuntime() {
    if (this._isClosed) {
      throw new WorkflowError('Cannot execute: WorkflowPlayer is already closed.');
    }
    if (!this._browserRuntime) {
      this._browserRuntime = createBrowserRuntime({
        headless: this.headless,
        allowLocalhost: this.allowLocalhost,
      });
    }
    return this._browserRuntime;
  }

  /**
   * Executes the active verified version of a workflow.
   *
   * @param {string} workflowId - Identifier of workflow to play.
   * @param {Record<string, string>} [inputs={}] - Runtime input values matching version inputs.
   * @param {object} [options]
   * @param {boolean} [options.throwOnFailure=false] - If true, throws WorkflowExecutionError on failure.
   * @param {number} [options.stepTimeoutMs] - Override default step timeout in milliseconds.
   * @returns {Promise<object>} The structured WorkflowRunResult.
   */
  async play(workflowId, inputs = {}, options = {}) {
    if (this._isClosed) {
      throw new WorkflowError('Cannot play workflow: WorkflowPlayer is closed.');
    }

    validateWorkflowId(workflowId);

    // 1. Precondition checks: load manifest and active verified version
    const manifest = await this.repository.getManifest(workflowId);
    if (!manifest) {
      throw new WorkflowNotFoundError(`Workflow "${workflowId}" not found.`, { workflowId });
    }

    if (!manifest.enabled) {
      throw new WorkflowDisabledError(`Workflow "${workflowId}" is disabled.`, { workflowId });
    }

    if (manifest.activeVersion === null || manifest.activeVersion === undefined) {
      throw new NoVerifiedVersionError(
        `Workflow "${workflowId}" has no active verified version (draft-only).`,
        { workflowId }
      );
    }

    const versionObj = await this.repository.getVersion(workflowId, manifest.activeVersion);
    if (!versionObj) {
      throw new WorkflowNotFoundError(
        `Active version ${manifest.activeVersion} for workflow "${workflowId}" not found on disk.`,
        { workflowId, version: manifest.activeVersion }
      );
    }

    if (versionObj.status !== 'verified') {
      throw new NoVerifiedVersionError(
        `Active version ${manifest.activeVersion} of workflow "${workflowId}" is not verified (status: "${versionObj.status}").`,
        { workflowId, version: manifest.activeVersion }
      );
    }

    // 1b. Playback-time integrity revalidation: independently recompute the content
    // hash and revalidate the sealed verification evidence instead of trusting the
    // repository's `verified` status alone. Fails closed before browser startup.
    if (typeof this.repository.getVerificationEvidence !== 'function') {
      throw new WorkflowError(
        `Cannot play workflow "${workflowId}": repository does not provide verification evidence for integrity revalidation.`
      );
    }
    const evidence = await this.repository.getVerificationEvidence(workflowId, manifest.activeVersion);
    if (!evidence) {
      throw new NoVerifiedVersionError(
        `Active version ${manifest.activeVersion} of workflow "${workflowId}" has no verification evidence; refusing playback.`,
        { workflowId, version: manifest.activeVersion }
      );
    }
    let recomputedHash;
    try {
      recomputedHash = calculateContentHash(versionObj);
    } catch (err) {
      throw new CorruptRecordError(
        `Active version ${manifest.activeVersion} of workflow "${workflowId}" failed integrity revalidation: unable to recompute content hash (${err.message}).`,
        { cause: err }
      );
    }
    try {
      verifyEvidenceMatchesWorkflow(evidence, versionObj, recomputedHash);
    } catch (err) {
      throw new CorruptRecordError(
        `Active version ${manifest.activeVersion} of workflow "${workflowId}" failed integrity revalidation: stored content no longer matches its verification evidence (${err.message}).`,
        { cause: err }
      );
    }

    // 2. Validate all runtime inputs before browser initialization
    validateRuntimeInputs(versionObj.inputs, inputs, workflowId);
    const inputSecrets = Object.values(inputs).filter((value) => typeof value === 'string');

    // 3. Prepare run execution metadata
    const runId = `run_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const startTime = performance.now();
    const startedAt = new Date().toISOString();

    const runResult = {
      runId,
      workflowId,
      version: versionObj.version,
      ok: true,
      status: 'success',
      startedAt,
      finishedAt: null,
      durationMs: 0,
      stepResults: [],
      successCriteriaResult: null,
      error: null,
      subresourceReport: null,
    };

    const runtime = await this._getRuntime();
    let session = null;
    let crossOriginBlockedUrl = null;
    let routeFault = null;
    const committedMainFrameUrls = [];
    let auditDetach = null;
    const subresourcePairs = new Map();
    let subresourceOmittedEvents = 0;
    let subresourceObservedEvents = 0;

    // Single source for confinement/interception failure reporting: a recorded
    // violation takes precedence over an interception fault.
    const confinementFailureMessage = () => {
      if (crossOriginBlockedUrl) {
        return `Cross-origin navigation rejected: destination "${crossOriginBlockedUrl}" does not match declared target origin "${versionObj.target.origin}".`;
      }
      if (routeFault) {
        return `Navigation interception failed for "${routeFault.url}": ${routeFault.reason}. Failing closed.`;
      }
      return null;
    };

    try {
      session = await runtime.createSession({ allowLocalhost: this.allowLocalhost });

      // Enforce strict target origin confinement on main frame navigations and redirects
      // across every page in the context, including popups and new tabs.
      const mainPage = session.page;
      // Phase A observability: record cross-origin subresource loads (sanitized
      // origin + resource type only). This never changes allow behavior: every
      // request observed here is still continued exactly as before.
      const observeSubresourceRequest = (routeRequest, knownMainFrame) => {
        try {
          if (knownMainFrame) return;
          let url = null;
          try {
            url = routeRequest.url();
          } catch {
            return;
          }
          let resourceType = null;
          try {
            resourceType = routeRequest.resourceType();
          } catch {
            return;
          }
          if (typeof resourceType !== 'string' || resourceType === '') return;
          let origin = null;
          try {
            origin = new URL(url).origin;
          } catch {
            return;
          }
          // Opaque origins (data:, blob:) involve no network host and carry no
          // third-party dependency; same-origin loads are out of scope for
          // cross-origin dependency research.
          if (!origin || origin === 'null' || origin === versionObj.target.origin) return;
          subresourceObservedEvents += 1;
          const safeOrigin = redactSecrets(origin, inputSecrets);
          const key = `${safeOrigin}|${resourceType}`;
          const existing = subresourcePairs.get(key);
          if (existing) {
            existing.count += 1;
            return;
          }
          if (subresourcePairs.size >= SUBRESOURCE_REPORT_PAIR_LIMIT) {
            subresourceOmittedEvents += 1;
            return;
          }
          subresourcePairs.set(key, { origin: safeOrigin, resourceType, count: 1 });
        } catch {
          // The observer must never break the run or the route.
        }
      };
      await session.context.route('**/*', async (route) => {
        const req = route.request();
        let reqPage = null;
        let isMainFrameNav = false;
        try {
          const frame = req.frame();
          reqPage = frame.page();
          isMainFrameNav = req.isNavigationRequest() && frame === reqPage.mainFrame();
        } catch {
          isMainFrameNav = false;
        }
        const closeForeignPage = async () => {
          if (reqPage && reqPage !== mainPage) {
            await reqPage.close().catch(() => {});
          }
        };
        if (isMainFrameNav) {
          let reqUrl = null;
          try {
            reqUrl = req.url();
          } catch {
            reqUrl = null;
          }
          let reqOrigin = null;
          try {
            reqOrigin = reqUrl ? new URL(reqUrl).origin : null;
          } catch {
            reqOrigin = null;
          }
          if (!reqUrl || !reqOrigin) {
            // The destination cannot be verified: fail closed without navigating.
            if (!crossOriginBlockedUrl && !routeFault) {
              routeFault = { url: reqUrl || '(unavailable)', reason: 'unparseable request URL' };
            }
            await route.abort('failed').catch(() => {});
            await closeForeignPage();
            return;
          }
          if (reqOrigin !== versionObj.target.origin) {
            crossOriginBlockedUrl = reqUrl;
            await route.abort('blockedbyclient').catch(() => {});
            await closeForeignPage();
            return;
          }

          try {
            const response = await route.fetch({
              maxRedirects: 0,
              timeout: options.stepTimeoutMs || 30000,
            });
            const status = response.status();
            const headers = response.headers();
            const loc = headers['location'];

            if (status >= 300 && status <= 399 && loc) {
              // Safe redirect policy: only same-origin http(s) targets are followed.
              // Anything else (foreign origin, non-http(s) scheme, or an
              // unparseable Location value) is rejected instead of being
              // passed to the browser.
              let redirectUrl = null;
              try {
                redirectUrl = new URL(loc, reqUrl);
              } catch {
                redirectUrl = null;
              }
              const redirectOk =
                redirectUrl !== null &&
                (redirectUrl.protocol === 'http:' || redirectUrl.protocol === 'https:') &&
                redirectUrl.origin === versionObj.target.origin;
              if (!redirectOk) {
                crossOriginBlockedUrl = redirectUrl ? redirectUrl.href : String(loc);
                await route.abort('blockedbyclient').catch(() => {});
                await closeForeignPage();
                return;
              }
            }

            // Refresh headers trigger document navigation after a delay on any
            // status, so inspect them here instead of waiting out the timer.
            const refreshHeader = headers['refresh'];
            if (typeof refreshHeader === 'string' && refreshHeader.trim() !== '') {
              const refreshVerdict = evaluateRefreshHeader(refreshHeader, reqUrl, versionObj.target.origin);
              if (!refreshVerdict.ok) {
                crossOriginBlockedUrl = refreshVerdict.detail;
                await route.abort('blockedbyclient').catch(() => {});
                await closeForeignPage();
                return;
              }
            }

            await route.fulfill({ response });
            return;
          } catch (routeErr) {
            // Any interception failure fails closed: the request is aborted so
            // it can never fall through to an uninspected native request, and
            // the fault is recorded for honest error reporting. First fault wins.
            if (!crossOriginBlockedUrl && !routeFault) {
              const reason =
                routeErr && routeErr.message ? routeErr.message : String(routeErr);
              routeFault = { url: reqUrl, reason };
            }
            await route.abort('failed').catch(() => {});
            return;
          }
        }
        observeSubresourceRequest(req, isMainFrameNav);
        await route.continue().catch(() => {});
      });

      // Commit audit: record main-frame commits for post-close validation.
      auditDetach = attachCommitAudit(session, committedMainFrameUrls);

      // 4. Initial target navigation
      const initialUrl = new URL(versionObj.target.startPath, versionObj.target.origin);
      assertTargetOrigin(initialUrl.href, versionObj.target.origin, 'initialNavigation');

      const initialNav = await session.navigate(initialUrl.href, {
        waitUntil: 'domcontentloaded',
        timeoutMs: options.stepTimeoutMs || 30000,
      });

      const initialPopupViolation = await enforcePopupConfinement(session, versionObj.target.origin);
      if (initialPopupViolation && !crossOriginBlockedUrl) {
        crossOriginBlockedUrl = initialPopupViolation;
      }

      const initialConfinementFailure = confinementFailureMessage();
      if (initialConfinementFailure) {
        throw new ActionError(initialConfinementFailure, {
          action: 'initialNavigation',
          target: versionObj.target.origin,
        });
      }

      if (!initialNav.ok && initialNav.status && initialNav.status >= 400) {
        throw new ActionError(`Initial navigation failed with HTTP status ${initialNav.status}.`, {
          action: 'initialNavigation',
          target: initialUrl.href,
        });
      }

      assertTargetOrigin(session.page.url(), versionObj.target.origin, 'initialNavigationRedirect');

      // 5. Execute steps in strictly consecutive validated order
      const sortedSteps = [...versionObj.steps].sort((a, b) => a.order - b.order);

      for (const step of sortedSteps) {
        const stepStart = performance.now();
        const stepResult = {
          stepId: step.id,
          action: step.action,
          ok: true,
          durationMs: 0,
          verification: null,
        };

        try {
          if (step.action === 'navigate') {
            const nextUrl = new URL(step.params.path, versionObj.target.origin);
            assertTargetOrigin(nextUrl.href, versionObj.target.origin, step.id);

            const navRes = await session.navigate(nextUrl.href, {
              waitUntil: step.params.waitUntil || 'domcontentloaded',
              timeoutMs: step.params.timeoutMs || options.stepTimeoutMs || 30000,
            });

            if (!navRes.ok && navRes.status && navRes.status >= 400) {
              throw new ActionError(`Navigation step failed with HTTP status ${navRes.status}.`, {
                action: 'navigate',
                target: nextUrl.href,
              });
            }

            assertTargetOrigin(session.page.url(), versionObj.target.origin, step.id);
          } else if (step.action === 'clickByRole') {
            await session.clickByRole({
              role: step.params.role,
              name: step.params.name,
              exact: Boolean(step.params.exact),
              timeoutMs: step.params.timeoutMs || options.stepTimeoutMs || 10000,
            });

            assertTargetOrigin(session.page.url(), versionObj.target.origin, step.id);
          } else if (step.action === 'fillByLabel') {
            // Retrieve runtime input; sensitive values are never logged or echoed
            const runtimeValue = inputs[step.params.inputName] ?? '';
            await session.fillByLabel({
              label: step.params.label,
              value: runtimeValue,
              exact: Boolean(step.params.exact),
              timeoutMs: step.params.timeoutMs || options.stepTimeoutMs || 10000,
            });

            assertTargetOrigin(session.page.url(), versionObj.target.origin, step.id);
          }

          const popupViolation = await enforcePopupConfinement(session, versionObj.target.origin);
          if (popupViolation && !crossOriginBlockedUrl) {
            crossOriginBlockedUrl = popupViolation;
          }

          // Step verification predicate
          if (step.verification) {
            const predResult = await evaluateVerificationPredicate(session, step.verification);
            stepResult.verification = {
              type: predResult.type,
              passed: predResult.passed,
            };

            if (!predResult.passed) {
              throw new ActionError(
                `Step verification predicate failed: expected ${step.verification.type} "${step.verification.expected}".`,
                { action: step.action, target: step.id }
              );
            }
          }

          const stepConfinementFailure = confinementFailureMessage();
          if (stepConfinementFailure) {
            throw new ActionError(stepConfinementFailure, {
              action: step.action,
              target: versionObj.target.origin,
            });
          }

          stepResult.durationMs = Math.round(performance.now() - stepStart);
          runResult.stepResults.push(stepResult);
        } catch (stepErr) {
          stepResult.ok = false;
          stepResult.durationMs = Math.round(performance.now() - stepStart);
          const rawErr = confinementFailureMessage() ?? stepErr.message;
          stepResult.error = sanitizeErrorMessage(rawErr, inputSecrets);
          runResult.stepResults.push(stepResult);

          runResult.ok = false;
          runResult.status = 'failed';
          runResult.error = stepResult.error;
          // Halt execution immediately: remaining steps are skipped
          break;
        }
      }

      // 6. Evaluate success criteria only if all steps succeeded
      if (runResult.ok) {
        // H2: re-assert origin confinement immediately before reading success criteria,
        // so delayed client-side redirects cannot slip in after the final step checks.
        const criteriaPopupViolation = await enforcePopupConfinement(session, versionObj.target.origin);
        if (criteriaPopupViolation && !crossOriginBlockedUrl) {
          crossOriginBlockedUrl = criteriaPopupViolation;
        }
        const criteriaConfinementFailure = confinementFailureMessage();
        if (criteriaConfinementFailure) {
          throw new ActionError(criteriaConfinementFailure, {
            action: 'successCriteria',
            target: versionObj.target.origin,
          });
        }
        assertTargetOrigin(session.page.url(), versionObj.target.origin, 'successCriteria');

        const criteriaResult = await evaluateSuccessCriteria(session, versionObj.successCriteria);
        assertTargetOrigin(session.page.url(), versionObj.target.origin, 'successCriteriaFinal');
        runResult.successCriteriaResult = criteriaResult;
        if (!criteriaResult.passed) {
          runResult.ok = false;
          runResult.status = 'failed';
          runResult.error = 'Workflow completed all steps but success criteria were not satisfied.';
        }
      } else {
        runResult.successCriteriaResult = {
          passed: false,
          details: 'Skipped due to prior step execution failure.',
        };
      }
    } catch (unhandledErr) {
      if (runResult.ok) {
        runResult.ok = false;
        runResult.status = 'failed';
        const rawErr = confinementFailureMessage() ?? unhandledErr.message;
        runResult.error = sanitizeErrorMessage(rawErr, inputSecrets);
      }
    } finally {
      if (session) {
        await session.close().catch(() => {});
      }
      if (auditDetach) {
        try {
          await auditDetach();
        } catch {
          // Best effort: context destruction is the primary cleanup.
        }
        auditDetach = null;
      }
      // Post-close reconciliation: a violation, interception fault, or foreign
      // commit recorded during the finalization window flips an otherwise
      // successful result to failed. Earliest failure wins.
      if (runResult.ok) {
        const lateFailure = confinementFailureMessage();
        const auditDetail = lateFailure
          ? null
          : findAuditViolation(committedMainFrameUrls, versionObj.target.origin);
        const flipMessage =
          lateFailure ??
          (auditDetail
            ? `Post-execution audit detected a committed navigation to "${auditDetail}" outside the declared target origin "${versionObj.target.origin}".`
            : null);
        if (flipMessage) {
          runResult.ok = false;
          runResult.status = 'failed';
          runResult.error = sanitizeErrorMessage(flipMessage, inputSecrets);
        }
      }
      runResult.subresourceReport = {
        pairs: [...subresourcePairs.values()].sort((a, b) => {
          if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
          if (a.resourceType !== b.resourceType) return a.resourceType < b.resourceType ? -1 : 1;
          return 0;
        }),
        omittedEvents: subresourceOmittedEvents,
        observedEvents: subresourceObservedEvents,
      };
      runResult.finishedAt = new Date().toISOString();
      runResult.durationMs = Math.round(performance.now() - startTime);
    }

    if (options.throwOnFailure && !runResult.ok) {
      throw new WorkflowExecutionError(runResult.error || 'Workflow execution failed.', {
        workflowId,
        version: versionObj.version,
        runResult,
      });
    }

    return runResult;
  }

  /**
   * Closes internally managed browser runtime resources safely and idempotently.
   */
  async close() {
    if (this._isClosed) return;
    this._isClosed = true;

    if (this.ownsRuntime && this._browserRuntime) {
      try {
        await this._browserRuntime.close();
      } finally {
        this._browserRuntime = null;
      }
    }
  }
}

/**
 * Functional convenience helper for single-run workflow execution.
 * Automatically initializes and disposes player resources.
 *
 * @param {string} workflowId
 * @param {Record<string, string>} [inputs={}]
 * @param {object} [options]
 * @returns {Promise<object>} The WorkflowRunResult.
 */
export async function playWorkflow(workflowId, inputs = {}, options = {}) {
  const player = new WorkflowPlayer(options);
  try {
    return await player.play(workflowId, inputs, options);
  } finally {
    await player.close();
  }
}
