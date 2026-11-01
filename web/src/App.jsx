import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from './api.js';

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

  return [state, refresh, setState];
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

function WorkflowList() {
  const [state, setState] = useState({ loading: true, workflows: [], error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet('/api/workflows');
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

  async function logout() {
    try {
      await apiPost('/api/auth/logout', {});
    } finally {
      window.location.reload();
    }
  }

  return (
    <main className="panel wide">
      <div className="row">
        <h1>Workflows</h1>
        <button type="button" onClick={logout}>Log out</button>
      </div>
      {state.loading ? <p className="muted">Loading workflows…</p> : null}
      {state.error ? <p className="error" role="alert">{state.error}</p> : null}
      {!state.loading && !state.error && state.workflows.length === 0 ? (
        <p className="muted">No workflows stored yet. Use discovery to learn your first workflow.</p>
      ) : null}
      {!state.loading && !state.error && state.workflows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Active</th>
              <th>Draft</th>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            {state.workflows.map((wf) => (
              <tr key={wf.id || wf.workflowId}>
                <td><code>{wf.id || wf.workflowId}</code></td>
                <td>{wf.corrupt ? 'corrupt' : wf.enabled === false ? 'disabled' : 'enabled'}</td>
                <td>{wf.activeVersion ? `v${wf.activeVersion}` : 'none'}</td>
                <td>{wf.draftVersion ? `v${wf.draftVersion}` : 'none'}</td>
                <td>{wf.name || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </main>
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

  return <WorkflowList />;
}
