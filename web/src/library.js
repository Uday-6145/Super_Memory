/**
 * Pure Workflow Library helpers: search, filtering, sorting, formatting, and
 * hash-route parsing. No JSX and no browser APIs, so this module is tested
 * directly with node:test.
 *
 * Security rules enforced here:
 * - Corrupt repository entries are never treated as workflows and never
 *   navigate anywhere; their raw `error` text is never rendered (it may
 *   contain filesystem paths or internal details).
 * - Step rendering uses an explicit allowlist of descriptive fields; unknown
 *   `params` keys and any runtime values are dropped, never displayed.
 * - Success criteria render only known shapes; unknown shapes fall back to
 *   the criterion type name instead of dumping raw objects.
 */

export function isCorrupt(entry) {
  return Boolean(entry && entry.corrupt);
}

export function statusOf(entry) {
  if (isCorrupt(entry)) return 'corrupt';
  return entry && entry.enabled === false ? 'disabled' : 'enabled';
}

function isRealVersion(value) {
  return Number.isInteger(value) && value >= 1;
}

export function hasActiveVersion(entry) {
  return Boolean(entry && !isCorrupt(entry) && isRealVersion(entry.activeVersion));
}

export function hasDraftVersion(entry) {
  return Boolean(entry && !isCorrupt(entry) && isRealVersion(entry.draftVersion));
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Parses a location hash into a view descriptor.
 * Supported: '' | '#/' -> library; '#/w/:id' -> detail (id without '/').
 */
export function parseHashRoute(hash) {
  const clean = typeof hash === 'string' ? hash : '';
  const match = clean.match(/^#\/w\/([^/#?]+)$/);
  if (match) {
    const workflowId = decodeURIComponent(match[1]);
    if (workflowId !== '' && !workflowId.includes('/')) {
      return { view: 'detail', workflowId };
    }
  }
  return { view: 'library' };
}

export function detailHash(workflowId) {
  return `#/w/${encodeURIComponent(workflowId)}`;
}

export function matchesQuery(entry, query) {
  const q = textOf(query).trim().toLowerCase();
  if (q === '') return true;
  const haystack = `${textOf(entry && entry.name)}\n${textOf(entry && entry.description)}\n${textOf(entry && (entry.id || entry.workflowId))}`.toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

export function matchesEnabled(entry, enabledFilter) {
  if (enabledFilter === 'all') return true;
  if (enabledFilter === 'disabled') return entry != null && entry.enabled === false && !isCorrupt(entry);
  // 'enabled': corrupt entries have no meaningful status and stay hidden.
  return entry != null && entry.enabled !== false && !isCorrupt(entry);
}

export function matchesStatus(entry, statusFilter) {
  if (statusFilter === 'all') return true;
  if (statusFilter === 'active') return hasActiveVersion(entry);
  if (statusFilter === 'draft') return hasDraftVersion(entry);
  return true;
}

export function filterWorkflows(workflows, { query = '', enabled = 'all', status = 'all' } = {}) {
  const items = Array.isArray(workflows) ? workflows : [];
  return items.filter(
    (entry) => matchesQuery(entry, query) && matchesEnabled(entry, enabled) && matchesStatus(entry, status)
  );
}

function updatedTime(entry) {
  const raw = entry && entry.timestamps && entry.timestamps.updatedAt;
  const time = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isNaN(time) ? 0 : time;
}

export function sortWorkflows(workflows, sortKey = 'updated') {
  const items = [...(Array.isArray(workflows) ? workflows : [])];
  if (sortKey === 'name') {
    items.sort((a, b) => textOf(a && a.name).localeCompare(textOf(b && b.name), undefined, { sensitivity: 'base' }));
  } else {
    items.sort((a, b) => updatedTime(b) - updatedTime(a));
  }
  return items;
}

export function formatDate(iso) {
  if (typeof iso !== 'string' || iso.trim() === '') return 'unknown';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'unknown';
  return new Date(time).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatVersionLabel(kind, version) {
  if (version == null) return kind === 'active' ? 'No active version' : 'No draft';
  return kind === 'active' ? `Active v${version} (verified)` : `Draft v${version} (pending review)`;
}

/**
 * Allowlisted, descriptive rendering of one step's anchor. Unknown param
 * keys are dropped; no runtime values ever appear here (versions store
 * declarations and input-name references only).
 */
export function describeStepAnchor(params) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  if (typeof params.role === 'string' && params.role !== '') parts.push(`role: ${params.role}`);
  if (typeof params.name === 'string' && params.name !== '') parts.push(`name: ${params.name}`);
  if (typeof params.label === 'string' && params.label !== '') parts.push(`label: ${params.label}`);
  if (typeof params.inputName === 'string' && params.inputName !== '') parts.push(`input: ${params.inputName}`);
  return parts.join(', ');
}

const CRITERION_LABELS = {
  finalPath: 'Final path must be',
  pageTitle: 'Page title must contain',
  textPresent: 'Page must contain',
  textAbsent: 'Page must not contain',
};

/**
 * Human-readable rendering of one success-criterion entry.
 * Never resolves `{input}` references to real values.
 */
export function describeCriterion(type, value) {
  const label = CRITERION_LABELS[type];
  if (!label) return `Criterion: ${String(type)}`;
  if (typeof value === 'string') return `${label} “${value}”`;
  if (value && typeof value === 'object' && typeof value.input === 'string' && value.input !== '') {
    return `${label} the runtime value of ${value.input}`;
  }
  if (value && typeof value === 'object' && typeof value.expected === 'string' && value.expected !== '') {
    return `${label} “${value.expected}”`;
  }
  return `Criterion: ${String(type)}`;
}

/**
 * Extracts only the approved descriptive fields of a step for display.
 * Returns null when the step record itself is malformed.
 */
export function toDisplayStep(step) {
  if (!step || typeof step !== 'object' || typeof step.action !== 'string') return null;
  return {
    order: typeof step.order === 'number' ? step.order : null,
    id: typeof step.id === 'string' ? step.id : '',
    action: step.action,
    description: typeof step.description === 'string' ? step.description : '',
    anchor: describeStepAnchor(step.params),
  };
}
