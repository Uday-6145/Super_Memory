import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, fetchReview, fetchWorkflow, fetchWorkflows } from './api.js';
import {
  describeCriterion,
  detailHash,
  filterWorkflows,
  formatDate,
  formatVersionLabel,
  hasActiveVersion,
  hasDraftVersion,
  isCorrupt,
  parseHashRoute,
  sortWorkflows,
  statusOf,
  toDisplayStep,
} from './library.js';

function usePairing() {
  const [state, setState] = useState({ loading: true, paired: false, health: null, error: null });

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [status, health] = await Promise.all([apiGet('/api/auth/status'), apiGet('/api/health')]);
      if (status.status !== 200 || health.status !== 200) {
        setState({ loading: false, paired: false, health: null, error: 'Application server is unreachable.' });
        return;
      }
      setState({ loading: false, paired: status.data?.paired === true, health: health.data, error: null });
    } catch {
      setState({ loading: false, paired: false, health: null, error: 'Application server is unreachable.' });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return [state, refresh];
}

function useHashRoute() {
  const [hash, setHash] = useState(() => (typeof window !== 'undefined' ? window.location.hash : ''));
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parseHashRoute(hash);
}

function PairingScreen({ onPaired, serverError }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(serverError);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost('/api/auth/pair', { code });
      if (res.status === 200 && res.data?.ok) {
        setCode('');
        onPaired();
        return;
      }
      setError(res.data?.error || 'Pairing failed.');
    } catch {
      setError('Application server is unreachable.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="panel">
      <h1>Super Memory</h1>
      <p className="muted">Local-first browser workflow memory. Pair this browser to begin.</p>
      <p className="muted">Enter the one-time pairing code printed by the application server terminal.</p>
      <form onSubmit={submit}>
        <label htmlFor="pairing-code">Pairing code</label>
        <input
          id="pairing-code"
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" disabled={busy || code.trim() === ''}>
          {busy ? 'Pairing…' : 'Pair this browser'}
        </button>
      </form>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </main>
  );
}

function AppLayout({ children }) {
  async function logout() {
    try {
      await apiPost('/api/auth/logout', {});
    } finally {
      window.location.hash = '#/';
      window.location.reload();
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">Super Memory</a>
        <nav aria-label="Primary">
          <a href="#/">Library</a>
        </nav>
        <button type="button" className="ghost" onClick={logout}>Log out</button>
      </header>
      {children}
    </div>
  );
}

function StatusPill({ entry }) {
  const status = statusOf(entry);
  return <span className={`pill pill-${status}`}>{status}</span>;
}

function VersionBadges({ entry }) {
  return (
    <span className="badges">
      {hasActiveVersion(entry) ? (
        <span className="badge badge-active">active v{entry.activeVersion}</span>
      ) : (
        <span className="badge badge-none">no active</span>
      )}
      {hasDraftVersion(entry) ? (
        <span className="badge badge-draft">draft v{entry.draftVersion}</span>
      ) : (
        <span className="badge badge-none">no draft</span>
      )}
    </span>
  );
}

function LibraryControls({ query, onQuery, enabled, onEnabled, status, onStatus, sort, onSort }) {
  const enabledOptions = [
    ['all', 'All'],
    ['enabled', 'Enabled'],
    ['disabled', 'Disabled'],
  ];
  const statusOptions = [
    ['all', 'All states'],
    ['active', 'Active'],
    ['draft', 'Draft'],
  ];
  return (
    <div className="controls">
      <div className="control">
        <label htmlFor="library-search">Search</label>
        <input
          id="library-search"
          type="search"
          placeholder="Name, description, or ID…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div className="control" role="group" aria-label="Enabled filter">
        <span className="control-label" aria-hidden="true">Availability</span>
        {enabledOptions.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={enabled === value ? 'chip chip-on' : 'chip'}
            aria-pressed={enabled === value}
            onClick={() => onEnabled(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="control" role="group" aria-label="Version filter">
        <span className="control-label" aria-hidden="true">Version</span>
        {statusOptions.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={status === value ? 'chip chip-on' : 'chip'}
            aria-pressed={status === value}
            onClick={() => onStatus(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="control">
        <label htmlFor="library-sort">Sort</label>
        <select id="library-sort" value={sort} onChange={(e) => onSort(e.target.value)}>
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
        </select>
      </div>
    </div>
  );
}

function WorkflowLibrary({ prefs, onPrefs }) {
  const [state, setState] = useState({ loading: true, workflows: [], error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWorkflows();
        if (cancelled) return;
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        if (res.status !== 200) {
          setState({ loading: false, workflows: [], error: res.data?.error || 'Could not load workflows.' });
          return;
        }
        setState({ loading: false, workflows: res.data?.workflows || [], error: null });
      } catch {
        if (!cancelled) setState({ loading: false, workflows: [], error: 'Application server is unreachable.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) {
    return (
      <main className="panel wide">
        <h1>Workflow Library</h1>
        <p className="muted">Loading workflows…</p>
      </main>
    );
  }

  if (state.error) {
    return (
      <main className="panel wide">
        <h1>Workflow Library</h1>
        <p className="error" role="alert">{state.error}</p>
      </main>
    );
  }

  const visible = sortWorkflows(filterWorkflows(state.workflows, prefs), prefs.sort);
  const isFiltering = prefs.query.trim() !== '' || prefs.enabled !== 'all' || prefs.status !== 'all';

  return (
    <main className="panel wide">
      <h1>Workflow Library</h1>
      <p className="muted">
        {state.workflows.length === 0
          ? 'No workflows stored yet.'
          : `${visible.length} of ${state.workflows.length} workflow${state.workflows.length === 1 ? '' : 's'} shown.`}
      </p>
      <LibraryControls
        query={prefs.query}
        onQuery={(query) => onPrefs({ ...prefs, query })}
        enabled={prefs.enabled}
        onEnabled={(enabled) => onPrefs({ ...prefs, enabled })}
        status={prefs.status}
        onStatus={(status) => onPrefs({ ...prefs, status })}
        sort={prefs.sort}
        onSort={(sort) => onPrefs({ ...prefs, sort })}
      />
      {state.workflows.length === 0 ? (
        <p className="muted">No workflows stored yet. Use discovery to learn your first workflow.</p>
      ) : visible.length === 0 ? (
        <p className="muted" role="status">
          {prefs.query.trim() !== ''
            ? `No workflows match “${prefs.query.trim()}”.`
            : 'No workflows match the selected filters.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Workflow</th>
                <th scope="col">Status</th>
                <th scope="col">Versions</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((wf) => (
                <tr key={wf.id || wf.workflowId}>
                  <td>
                    {isCorrupt(wf) ? (
                      <span>
                        <code>{wf.id || wf.workflowId}</code>
                        <span className="muted"> — unreadable entry (details unavailable)</span>
                      </span>
                    ) : (
                      <span>
                        <a href={detailHash(wf.id)}>{wf.name || wf.id}</a>
                        {wf.description ? <span className="muted block">{wf.description}</span> : null}
                        <code className="muted block">{wf.id}</code>
                      </span>
                    )}
                  </td>
                  <td><StatusPill entry={wf} /></td>
                  <td><VersionBadges entry={wf} /></td>
                  <td className="muted">{formatDate(wf.timestamps?.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isFiltering && state.workflows.length > 0 ? (
        <p>
          <button
            type="button"
            className="ghost"
            onClick={() => onPrefs({ query: '', enabled: 'all', status: 'all', sort: prefs.sort })}
          >
            Clear search and filters
          </button>
        </p>
      ) : null}
    </main>
  );
}

function InputsTable({ inputs }) {
  const rows = Array.isArray(inputs) ? inputs : [];
  if (rows.length === 0) {
    return <p className="muted">No declared inputs.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Required</th>
            <th scope="col">Label</th>
            <th scope="col">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((input, index) => (
            <tr key={input?.name || index}>
              <td><code>{input?.name || ''}</code></td>
              <td>{input?.type || ''}</td>
              <td>{input?.required ? 'required' : 'optional'}</td>
              <td>{input?.label || ''}</td>
              <td className="muted">{input?.description || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StepsList({ steps }) {
  const rows = (Array.isArray(steps) ? steps : []).map(toDisplayStep).filter(Boolean);
  if (rows.length === 0) {
    return <p className="muted">No steps recorded.</p>;
  }
  return (
    <ol className="steps">
      {rows.map((step, index) => (
        <li key={step.id || index} className="step">
          <div className="step-head">
            <span className="step-order">{step.order ?? index + 1}</span>
            <code>{step.action}</code>
            {step.id ? <code className="muted">{step.id}</code> : null}
          </div>
          {step.description ? <p>{step.description}</p> : null}
          {step.anchor ? <p className="muted">Target — <code>{step.anchor}</code></p> : null}
        </li>
      ))}
    </ol>
  );
}

function CriteriaView({ criteria }) {
  const entries = criteria && typeof criteria === 'object' ? Object.entries(criteria) : [];
  if (entries.length === 0) {
    return <p className="muted">No success criteria recorded.</p>;
  }
  return (
    <ul className="criteria">
      {entries.map(([type, value]) => (
        <li key={type}><code>{type}</code> — {describeCriterion(type, value)}</li>
      ))}
    </ul>
  );
}

function VersionPanel({ kind, version, hash, evidence }) {
  if (!version) {
    return (
      <section className={`version version-${kind}`} aria-label={kind === 'active' ? 'Active version' : 'Draft version'}>
        <h3>{kind === 'active' ? 'Active version' : 'Draft version'}</h3>
        <p className="muted">{formatVersionLabel(kind, null)}</p>
      </section>
    );
  }
  return (
    <section className={`version version-${kind}`} aria-label={kind === 'active' ? 'Active version' : 'Draft version'}>
      <h3>{formatVersionLabel(kind, version.version)}</h3>
      <dl className="facts">
        <div><dt>Target</dt><dd><code>{version.target?.origin || ''}{version.target?.startPath || ''}</code></dd></div>
        <div><dt>Schema</dt><dd><code>{version.schemaVersion || '1.0.0'}</code></dd></div>
        {kind === 'draft' && version.parentVersion != null ? (
          <div><dt>Parent</dt><dd><code>v{version.parentVersion}</code></dd></div>
        ) : null}
        {kind === 'draft' && version.changeSummary ? (
          <div><dt>Change summary</dt><dd>{version.changeSummary}</dd></div>
        ) : null}
        {hash ? <div><dt>Content hash</dt><dd><code className="wrap">{hash}</code></dd></div> : null}
        {kind === 'active' && evidence ? (
          <div>
            <dt>Verified</dt>
            <dd>{formatDate(evidence.verifiedAt)}{evidence.runId ? <span> · run <code>{evidence.runId}</code></span> : null}</dd>
          </div>
        ) : null}
      </dl>
      <h4>Inputs</h4>
      <InputsTable inputs={version.inputs} />
      <h4>Steps</h4>
      <StepsList steps={version.steps} />
      <h4>Success criteria</h4>
      <CriteriaView criteria={version.successCriteria} />
    </section>
  );
}

function diffLineClass(line) {
  if (line.startsWith('===') || line.startsWith('--- ')) return 'diff-head';
  if (line.includes('[Added') || line.startsWith('+')) return 'diff-add';
  if (line.includes('[Removed') || line.startsWith('-')) return 'diff-del';
  if (line.includes('[Changed') || line.includes('->')) return 'diff-chg';
  return '';
}

function ReviewPanel({ workflowId }) {
  const [state, setState] = useState({ loading: true, review: null, error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchReview(workflowId);
        if (cancelled) return;
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        if (res.status !== 200) {
          setState({ loading: false, review: null, error: res.data?.error || 'Could not load the draft review.' });
          return;
        }
        setState({ loading: false, review: res.data, error: null });
      } catch {
        if (!cancelled) setState({ loading: false, review: null, error: 'Application server is unreachable.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  if (state.loading) return <p className="muted">Loading draft review…</p>;
  if (state.error) return <p className="error" role="alert">{state.error}</p>;
  if (!state.review || state.review.hasDraft !== true) {
    return <p className="muted">No pending draft. This workflow has nothing awaiting review.</p>;
  }
  const { draftVersion, activeVersion, diff } = state.review;
  return (
    <div>
      <p>
        {activeVersion
          ? <>Draft <code>v{draftVersion?.version}</code> proposes changes to active <code>v{activeVersion?.version}</code>.</>
          : <>Initial draft <code>v{draftVersion?.version}</code> — no active version exists yet.</>}
      </p>
      {typeof diff === 'string' && diff !== '' ? (
        <pre className="diff" tabIndex={0} aria-label="Draft diff">
          {diff.split('\n').map((line, index) => (
            <span key={index} className={diffLineClass(line)}>{line}{'\n'}</span>
          ))}
        </pre>
      ) : (
        <p className="muted">The review service returned no diff text.</p>
      )}
    </div>
  );
}

function WorkflowDetail({ workflowId }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    (async () => {
      try {
        const res = await fetchWorkflow(workflowId);
        if (cancelled) return;
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        if (res.status === 404) {
          setState({ loading: false, data: null, error: `No workflow found with ID “${workflowId}”.` });
          return;
        }
        if (res.status !== 200) {
          setState({ loading: false, data: null, error: res.data?.error || 'Could not load the workflow.' });
          return;
        }
        setState({ loading: false, data: res.data, error: null });
      } catch {
        if (!cancelled) setState({ loading: false, data: null, error: 'Application server is unreachable.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  if (state.loading) {
    return (
      <main className="panel wide">
        <p><a href="#/">← Workflow Library</a></p>
        <p className="muted">Loading workflow…</p>
      </main>
    );
  }

  if (state.error || !state.data) {
    return (
      <main className="panel wide">
        <p><a href="#/">← Workflow Library</a></p>
        <p className="error" role="alert">{state.error || 'Could not load the workflow.'}</p>
      </main>
    );
  }

  const { manifest, activeVersion, draftVersion, activeEvidence, activeHash, draftHash } = state.data;
  const refVersion = activeVersion || draftVersion;

  return (
    <main className="panel wide">
      <p><a href="#/">← Workflow Library</a></p>
      <h1>{manifest.name}</h1>
      {manifest.description ? <p>{manifest.description}</p> : null}
      <p>
        <StatusPill entry={manifest} /> <VersionBadges entry={manifest} />
      </p>
      <dl className="facts">
        <div><dt>Workflow ID</dt><dd><code>{manifest.id}</code></dd></div>
        {refVersion?.target ? (
          <>
            <div><dt>Target origin</dt><dd><code>{refVersion.target.origin || ''}</code></dd></div>
            <div><dt>Start path</dt><dd><code>{refVersion.target.startPath || ''}</code></dd></div>
          </>
        ) : null}
        <div><dt>Created</dt><dd>{formatDate(manifest.timestamps?.createdAt)}</dd></div>
        <div><dt>Updated</dt><dd>{formatDate(manifest.timestamps?.updatedAt)}</dd></div>
      </dl>
      <h2>Versions</h2>
      <VersionPanel kind="active" version={activeVersion} hash={activeHash} evidence={activeEvidence} />
      <VersionPanel kind="draft" version={draftVersion} hash={draftHash} evidence={null} />
      <h2>Draft review</h2>
      <ReviewPanel workflowId={manifest.id} />
    </main>
  );
}

function AuthenticatedApp() {
  const route = useHashRoute();
  const [prefs, setPrefs] = useState({ query: '', enabled: 'all', status: 'all', sort: 'updated' });

  return (
    <AppLayout>
      {route.view === 'detail'
        ? <WorkflowDetail key={route.workflowId} workflowId={route.workflowId} />
        : <WorkflowLibrary prefs={prefs} onPrefs={setPrefs} />}
    </AppLayout>
  );
}

export default function App() {
  const [pairing, refresh] = usePairing();

  if (pairing.loading) {
    return (
      <main className="panel">
        <h1>Super Memory</h1>
        <p className="muted">Connecting to the local application server…</p>
      </main>
    );
  }

  if (!pairing.paired) {
    return <PairingScreen onPaired={refresh} serverError={pairing.error} />;
  }

  return <AuthenticatedApp />;
}
