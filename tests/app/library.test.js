import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeCriterion,
  describeStepAnchor,
  detailHash,
  filterWorkflows,
  formatDate,
  formatVersionLabel,
  hasActiveVersion,
  hasDraftVersion,
  isCorrupt,
  matchesEnabled,
  matchesQuery,
  matchesStatus,
  parseHashRoute,
  sortWorkflows,
  statusOf,
  toDisplayStep,
} from '../../web/src/library.js';

function wf(overrides = {}) {
  return {
    id: 'wf_one',
    name: 'Order coffee beans',
    description: 'Reorders beans when stock runs low',
    enabled: true,
    activeVersion: 2,
    draftVersion: null,
    timestamps: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-01T10:00:00Z' },
    ...overrides,
  };
}

describe('Workflow library helpers (M3.2)', () => {
  it('parses hash routes for library and detail views', () => {
    assert.deepEqual(parseHashRoute(''), { view: 'library' });
    assert.deepEqual(parseHashRoute('#/'), { view: 'library' });
    assert.deepEqual(parseHashRoute('#/w/abc'), { view: 'detail', workflowId: 'abc' });
    assert.deepEqual(parseHashRoute('#/w/a%2Fb'), { view: 'library' });
    assert.deepEqual(parseHashRoute('#/unknown'), { view: 'library' });
    assert.deepEqual(parseHashRoute(null), { view: 'library' });
    assert.equal(detailHash('wf one'), '#/w/wf%20one');
  });

  it('searches by name, description, and id case-insensitively', () => {
    const items = [wf()];
    assert.equal(filterWorkflows(items, { query: 'coffee' }).length, 1);
    assert.equal(filterWorkflows(items, { query: 'STOCK runs LOW' }).length, 1);
    assert.equal(filterWorkflows(items, { query: 'WF_ONE' }).length, 1);
    assert.equal(filterWorkflows(items, { query: 'tea' }).length, 0);
    assert.equal(filterWorkflows(items, { query: 'coffee tea' }).length, 0);
    assert.equal(filterWorkflows(items, { query: '' }).length, 1);
  });

  it('filters enabled and disabled workflows', () => {
    const items = [wf(), wf({ id: 'wf_two', enabled: false }), { id: 'bad', corrupt: true, error: 'x' }];
    assert.deepEqual(filterWorkflows(items, { enabled: 'enabled' }).map((w) => w.id), ['wf_one']);
    assert.deepEqual(filterWorkflows(items, { enabled: 'disabled' }).map((w) => w.id), ['wf_two']);
    assert.equal(filterWorkflows(items, { enabled: 'all' }).length, 3);
    assert.equal(matchesEnabled({ id: 'bad', corrupt: true }, 'enabled'), false);
  });

  it('filters active and draft workflows', () => {
    const items = [
      wf({ id: 'a', activeVersion: 1, draftVersion: null }),
      wf({ id: 'd', activeVersion: null, draftVersion: 3 }),
      wf({ id: 'n', activeVersion: null, draftVersion: null }),
    ];
    assert.deepEqual(filterWorkflows(items, { status: 'active' }).map((w) => w.id), ['a']);
    assert.deepEqual(filterWorkflows(items, { status: 'draft' }).map((w) => w.id), ['d']);
    assert.equal(matchesStatus({ id: 'bad', corrupt: true }, 'active'), false);
    assert.equal(matchesStatus({ id: 'bad', corrupt: true }, 'draft'), false);
  });

  it('combines search and filters', () => {
    const items = [
      wf({ id: 'a', name: 'Order coffee', enabled: true, activeVersion: 1 }),
      wf({ id: 'b', name: 'Order tea', enabled: false, activeVersion: 1 }),
    ];
    assert.deepEqual(
      filterWorkflows(items, { query: 'order', enabled: 'enabled', status: 'active' }).map((w) => w.id),
      ['a']
    );
    assert.equal(filterWorkflows(items, { query: 'order', enabled: 'disabled', status: 'draft' }).length, 0);
  });

  it('sorts by name and updated date, tolerating missing timestamps', () => {
    const items = [
      wf({ id: 'b', name: 'Beta', timestamps: { updatedAt: '2026-02-01T00:00:00Z' } }),
      wf({ id: 'a', name: 'alpha', timestamps: {} }),
      wf({ id: 'c', name: 'Gamma', timestamps: { updatedAt: '2026-10-01T00:00:00Z' } }),
    ];
    assert.deepEqual(sortWorkflows(items, 'name').map((w) => w.id), ['a', 'b', 'c']);
    assert.deepEqual(sortWorkflows(items, 'updated').map((w) => w.id), ['c', 'b', 'a']);
    assert.deepEqual(filterWorkflows(null, {}), []);
    assert.deepEqual(sortWorkflows(undefined), []);
  });

  it('classifies workflow status safely', () => {
    assert.equal(statusOf(wf()), 'enabled');
    assert.equal(statusOf(wf({ enabled: false })), 'disabled');
    assert.equal(statusOf({ id: 'x', corrupt: true }), 'corrupt');
    assert.equal(isCorrupt({}), false);
    assert.equal(hasActiveVersion(wf({ activeVersion: 0 })), false);
    assert.equal(hasDraftVersion(wf({ draftVersion: 2 })), true);
    assert.equal(matchesQuery(wf(), '  '), true);
  });

  it('formats dates and version labels without throwing', () => {
    assert.notEqual(formatDate('2026-09-01T10:00:00Z'), 'unknown');
    assert.equal(formatDate(''), 'unknown');
    assert.equal(formatDate('not-a-date'), 'unknown');
    assert.equal(formatDate(null), 'unknown');
    assert.equal(formatVersionLabel('active', 2), 'Active v2 (verified)');
    assert.equal(formatVersionLabel('draft', null), 'No draft');
    assert.equal(formatVersionLabel('active', null), 'No active version');
  });

  it('describes step anchors from the allowlist only', () => {
    assert.equal(
      describeStepAnchor({ role: 'button', name: 'Buy', label: 'Buy now', inputName: 'item', secret: 'x', password: 'y' }),
      'role: button, name: Buy, label: Buy now, input: item'
    );
    assert.equal(describeStepAnchor({ unknown: 1 }), '');
    assert.equal(describeStepAnchor(null), '');
    assert.equal(describeStepAnchor('x'), '');
  });

  it('describes success criteria without resolving input references', () => {
    assert.equal(describeCriterion('finalPath', '/done'), 'Final path must be “/done”');
    assert.equal(
      describeCriterion('textPresent', { input: 'book_title' }),
      'Page must contain the runtime value of book_title'
    );
    assert.equal(describeCriterion('textAbsent', { expected: 'Sold out' }), 'Page must not contain “Sold out”');
    assert.equal(describeCriterion('weirdType', { nested: { deep: true } }), 'Criterion: weirdType');
    assert.equal(describeCriterion('textPresent', { input: '' }), 'Criterion: textPresent');
    assert.equal(describeCriterion('pageTitle', 42), 'Criterion: pageTitle');
  });

  it('extracts display steps and rejects malformed ones', () => {
    const shown = toDisplayStep({
      id: 's1',
      order: 1,
      action: 'clickByRole',
      description: 'Buy',
      params: { role: 'button', name: 'Buy', extra: 'dropped' },
      injected: true,
    });
    assert.deepEqual(shown, {
      order: 1,
      id: 's1',
      action: 'clickByRole',
      description: 'Buy',
      anchor: 'role: button, name: Buy',
    });
    assert.equal(toDisplayStep(null), null);
    assert.equal(toDisplayStep({ order: 1 }), null);
    assert.equal(toDisplayStep('x'), null);
    assert.deepEqual(toDisplayStep({ action: 'navigate' }), {
      order: null,
      id: '',
      action: 'navigate',
      description: '',
      anchor: '',
    });
  });
});
