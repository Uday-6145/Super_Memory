/**
 * Super Memory — Deterministic Workflow Failure Diagnostics
 *
 * Collects structured, sanitized diagnostic records upon workflow execution failures
 * to enable deterministic failure categorization and model-assisted repair generation.
 *
 * Safety & Sanitation Rules:
 * - Runtime credentials and secret input values are strictly redacted.
 * - Snapshots are strictly bounded in text length and element count.
 * - URLs are stripped of query parameters and hash fragments.
 * - Password input types and sensitive form values are never included.
 */

import { sanitizeSnapshotUrl } from '../browser/index.js';

/**
 * Escapes a literal string for safe inclusion in a dynamically built RegExp.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts supplied secret values from text, covering exact, trimmed,
 * and collapsed-whitespace variants case-insensitively.
 *
 * @param {string} text
 * @param {Array<unknown>} [secrets=[]]
 * @returns {string}
 */
export function redactSecrets(text, secrets = []) {
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
 * Sanitizes and redacts a URL by:
 * 1. Stripping query parameters, fragments, and credentials.
 * 2. Redacting obvious credential/secret patterns in URL path segments (e.g. /token/, /secret/, /key/, JWTs, etc.).
 * 3. Redacting any supplied secret values that appear anywhere in the URL (including path segments or substrings).
 * 4. Bounding the URL length to 500 characters.
 *
 * @param {string} url
 * @param {Array<unknown>} [secrets=[]]
 * @returns {string}
 */
export function sanitizeAndRedactUrl(url, secrets = []) {
  if (typeof url !== 'string' || url.trim() === '') return '';

  // 1. Strip queries, fragments, credentials
  let clean = sanitizeSnapshotUrl(url);

  // 2. Generic path-based credential redaction
  // (a) Sensitive path segments following keywords like token, key, secret, session, bearer, etc.
  clean = clean.replace(
    /(^|\/)(tokens?|keys?|secrets?|sessions?|bearer|passwords?|apikeys?|api_keys?|credentials?)\/([^\/?#]+)/gi,
    '$1$2/[REDACTED]'
  );

  // (b) Standard JWT token pattern in path segment: eyJ...
  clean = clean.replace(
    /\/eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+(?=\/|$)/g,
    '/[REDACTED]'
  );

  // (c) Long high-entropy hex/alphanumeric tokens in path segment (>= 32 chars)
  clean = clean.replace(
    /\/([a-zA-Z0-9_\-]{32,})(?=\/|$)/g,
    '/[REDACTED]'
  );

  // 3. Redact supplied secrets across the entire URL (path segments, substrings)
  clean = redactSecrets(clean, secrets);

  // 4. Bound length
  return clean.slice(0, 500);
}

/**
 * Determines a high-level failure category based on error message, failed step,
 * and runtime context.
 *
 * @param {object} params
 * @param {Error|string} [params.error]
 * @param {object|null} [params.step]
 * @param {boolean} [params.confinementViolation=false]
 * @param {object|null} [params.verification]
 * @param {object|null} [params.successCriteriaResult]
 * @param {object|null} [params.snapshot]
 * @returns {'ELEMENT_NOT_FOUND' | 'TIMEOUT' | 'NAVIGATION_ERROR' | 'CONFINEMENT_VIOLATION' | 'VERIFICATION_FAILED' | 'SUCCESS_CRITERIA_FAILED' | 'PAGE_STRUCTURE_CHANGED' | 'UNKNOWN_ERROR'}
 */
export function categorizeFailure({
  error,
  step,
  confinementViolation = false,
  verification = null,
  successCriteriaResult = null,
  snapshot = null,
} = {}) {
  if (confinementViolation) {
    return 'CONFINEMENT_VIOLATION';
  }

  const rawMsg = error && typeof error === 'object' ? error.message : String(error || '');
  const msg = rawMsg.toLowerCase();

  if (
    msg.includes('cross-origin navigation') ||
    msg.includes('post-execution audit detected a committed navigation') ||
    msg.includes('target origin')
  ) {
    return 'CONFINEMENT_VIOLATION';
  }

  // Verification failure ONLY when verification explicitly failed
  const isVerificationFailed =
    (verification && typeof verification === 'object' && verification.passed === false) ||
    msg.includes('verification predicate failed');

  // If interactive elements were not found or timed out, that is ELEMENT_NOT_FOUND
  if (step?.action === 'clickByRole' || step?.action === 'fillByLabel') {
    if (
      msg.includes('waiting for') ||
      msg.includes('locator') ||
      msg.includes('not found') ||
      msg.includes('element')
    ) {
      return 'ELEMENT_NOT_FOUND';
    }
  }

  if (isVerificationFailed) {
    return 'VERIFICATION_FAILED';
  }

  if (step?.action === 'clickByRole' || step?.action === 'fillByLabel') {
    if (
      msg.includes('timed out after') ||
      msg.includes('timeout')
    ) {
      return 'ELEMENT_NOT_FOUND';
    }
  }

  if (
    step?.action === 'navigate' ||
    msg.includes('initial navigation failed') ||
    msg.includes('navigation step failed') ||
    msg.includes('navigation error') ||
    msg.includes('http status')
  ) {
    return 'NAVIGATION_ERROR';
  }

  if (
    !step &&
    successCriteriaResult &&
    !successCriteriaResult.passed &&
    !successCriteriaResult.details?.includes('Skipped')
  ) {
    return 'SUCCESS_CRITERIA_FAILED';
  }

  if (msg.includes('timeout') || msg.includes('timed out')) {
    return 'TIMEOUT';
  }

  return 'UNKNOWN_ERROR';
}

/**
 * Sanitizes and bounds a DOM snapshot, redacting any secrets.
 *
 * @param {object|null} snapshot
 * @param {Array<string>} secrets
 * @returns {object|null}
 */
export function sanitizeSnapshot(snapshot, secrets = []) {
  if (!snapshot || typeof snapshot !== 'object') return null;

  const sanitizedText = redactSecrets(snapshot.text || '', secrets).slice(0, 2000);
  const elements = Array.isArray(snapshot.elements)
    ? snapshot.elements.slice(0, 50).map((el) => ({
        tag: redactSecrets(el.tag || '', secrets).slice(0, 50),
        role: redactSecrets(el.role || '', secrets).slice(0, 50),
        name: redactSecrets(el.name || '', secrets).slice(0, 100),
        type: el.type === 'password' ? '[REDACTED]' : redactSecrets(el.type || '', secrets).slice(0, 50) || null,
        placeholder: el.placeholder ? redactSecrets(el.placeholder, secrets).slice(0, 100) : null,
        label: el.label ? redactSecrets(el.label, secrets).slice(0, 100) : null,
        href: el.href ? sanitizeAndRedactUrl(el.href, secrets) : null,
        disabled: Boolean(el.disabled),
      }))
    : [];

  return {
    url: sanitizeAndRedactUrl(snapshot.url || '', secrets),
    title: redactSecrets(snapshot.title || '', secrets).slice(0, 200),
    text: sanitizedText,
    isTextTruncated: Boolean(snapshot.isTextTruncated || (snapshot.text && snapshot.text.length > 2000)),
    elements,
    areElementsTruncated: Boolean(snapshot.areElementsTruncated || (snapshot.elements && snapshot.elements.length > 50)),
  };
}

/**
 * Collects a structured failure diagnostic record from a failed workflow execution.
 *
 * @param {object} params
 * @param {string} params.workflowId
 * @param {number} params.version
 * @param {string} [params.error] - Raw or sanitized error message.
 * @param {object|null} [params.failedStep] - Step definition that failed.
 * @param {import('../browser/browser-session.js').BrowserSession|null} [params.session]
 * @param {Array<string>} [params.secrets=[]] - Sensitive inputs to redact.
 * @param {boolean} [params.confinementViolation=false]
 * @param {object|null} [params.successCriteriaResult=null]
 * @param {object|null} [params.verification=null]
 * @returns {Promise<object>}
 */
export async function collectFailureDiagnostic({
  workflowId,
  version,
  error = 'Unknown error',
  failedStep = null,
  session = null,
  secrets = [],
  confinementViolation = false,
  successCriteriaResult = null,
  verification = null,
} = {}) {
  let rawSnapshot = null;
  let pageUrl = '';
  let pageTitle = '';

  if (session && !session.isClosed) {
    try {
      if (session.page && !session.page.isClosed?.()) {
        pageUrl = session.page.url?.() || '';
        pageTitle = (await session.page.title?.().catch(() => '')) || '';
      }
    } catch {
      // Best effort page inspection
    }

    try {
      rawSnapshot = await session.getSnapshot({
        maxTextLength: 2000,
        maxElements: 50,
      });
    } catch {
      rawSnapshot = null;
    }
  }

  const boundedSnapshot = sanitizeSnapshot(rawSnapshot, secrets);
  const cleanUrl = sanitizeAndRedactUrl(pageUrl, secrets);
  const cleanTitle = redactSecrets(pageTitle, secrets).slice(0, 200);
  const cleanError = redactSecrets(String(error), secrets).slice(0, 500);

  const category = categorizeFailure({
    error,
    step: failedStep,
    confinementViolation,
    verification,
    successCriteriaResult,
    snapshot: boundedSnapshot,
  });

  const expected = {};
  if (failedStep) {
    if (failedStep.action === 'clickByRole') {
      expected.role = failedStep.params?.role ? redactSecrets(failedStep.params.role, secrets) : null;
      expected.name = failedStep.params?.name ? redactSecrets(failedStep.params.name, secrets) : null;
      expected.exact = Boolean(failedStep.params?.exact);
    } else if (failedStep.action === 'fillByLabel') {
      expected.label = failedStep.params?.label ? redactSecrets(failedStep.params.label, secrets) : null;
      expected.inputName = failedStep.params?.inputName ? redactSecrets(failedStep.params.inputName, secrets) : null;
      expected.exact = Boolean(failedStep.params?.exact);
    } else if (failedStep.action === 'navigate') {
      expected.path = failedStep.params?.path ? redactSecrets(failedStep.params.path, secrets) : null;
    }
    if (failedStep.anchor) {
      expected.anchor = Object.fromEntries(
        Object.entries(failedStep.anchor).map(([k, v]) => [
          k,
          typeof v === 'string' ? redactSecrets(v, secrets) : v,
        ])
      );
    }
  }

  let criteriaMismatch = null;
  if (successCriteriaResult && !successCriteriaResult.passed) {
    criteriaMismatch = {
      finalPathMatched: successCriteriaResult.finalPathMatched ?? null,
      pageTitleMatched: successCriteriaResult.pageTitleMatched ?? null,
      textPresentFound: successCriteriaResult.textPresentFound ?? null,
      textAbsentFound: successCriteriaResult.textAbsentFound ?? null,
    };
  }

  return {
    workflowId,
    version,
    category,
    error: cleanError,
    failedStep: failedStep
      ? {
          id: redactSecrets(failedStep.id || '', secrets),
          order: failedStep.order,
          action: failedStep.action,
          description: redactSecrets(failedStep.description || '', secrets),
          expected,
          verification: failedStep.verification
            ? {
                type: failedStep.verification.type,
                expected: redactSecrets(failedStep.verification.expected || '', secrets),
              }
            : null,
        }
      : null,
    page: {
      url: cleanUrl,
      title: cleanTitle,
      snapshot: boundedSnapshot,
    },
    successCriteriaMismatch: criteriaMismatch,
    timestamp: new Date().toISOString(),
  };
}

