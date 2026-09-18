import { api } from '../../lib/api.js';
import { useQuery, Loading, ErrorNote, Empty, useToast } from '../../components/ui.jsx';
import { ago, when } from '../../lib/format.js';

/**
 * Your own live sessions.
 *
 * Revoking one takes effect immediately - it is an SREM against the
 * refresh whitelist, not a flag that expires eventually - which is the
 * whole reason the backend keeps that list.
 */
export default function SessionsAdmin() {
  const { data, error, loading, reload } = useQuery(() => api.sessions());
  const toast = useToast();

  async function revoke(id) {
    try {
      await api.revokeSession(id);
      toast('Session ended');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  return (
    <div className="container wide">
      <div className="page-head">
        <div>
          <h1>Sessions</h1>
          <p>Every device currently signed in as you. Revoking is immediate.</p>
        </div>
      </div>

      <ErrorNote error={error} retry={reload} />

      {loading ? (
        <Loading rows={2} />
      ) : data.sessions.length === 0 ? (
        <Empty title="No other sessions">This is the only one.</Empty>
      ) : (
        <div className="card">
          {data.sessions.map((s) => (
            <div className="row" key={s.id}>
              <span className="dot ok" />
              <div className="row-main">
                <div className="row-title mono">{s.ip || 'unknown address'}</div>
                <div className="row-sub">{s.userAgent || 'unknown client'}</div>
              </div>
              <div className="row-end">
                <span className="hide-sm">started {when(s.createdAt)}</span>
                <span>{ago(s.createdAt)}</span>
                <button className="btn small ghost danger" onClick={() => revoke(s.id)}>
                  Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
