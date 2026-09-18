import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useQuery, Loading, ErrorNote } from '../components/ui.jsx';
import { IMPACT_SEVERITY, INCIDENT_LABEL, when, ago } from '../lib/format.js';

export default function IncidentPage() {
  const { slug } = useParams();
  const { data, error, loading, reload } = useQuery(() => api.incident(slug), [slug]);

  if (loading)
    return (
      <div className="container">
        <Loading rows={2} />
      </div>
    );
  if (error)
    return (
      <div className="container">
        <ErrorNote error={error} retry={reload} />
        <Link to="/history" className="btn small">
          Back to history
        </Link>
      </div>
    );

  const i = data.incident;

  return (
    <div className="container">
      <Link to="/history" className="muted" style={{ fontSize: 13 }}>
        ← Incident history
      </Link>

      <div className="page-head" style={{ marginTop: 14 }}>
        <div>
          <h1>{i.title}</h1>
          <p>
            Started {when(i.startedAt)}
            {i.resolvedAt ? ` · resolved ${when(i.resolvedAt)}` : ' · ongoing'}
          </p>
        </div>
        <div className="spacer" />
        <div className="inline">
          <span className={`pill ${IMPACT_SEVERITY[i.impact] ?? 'warn'}`}>{i.impact}</span>
          <span className={`pill ${i.resolvedAt ? 'ok' : 'idle'}`}>
            {INCIDENT_LABEL[i.status] ?? i.status}
          </span>
        </div>
      </div>

      {i.affectedComponents.length > 0 && (
        <div className="alert warn">Affects {i.affectedComponents.join(', ')}</div>
      )}

      <div className="card">
        <div className="card-head">Timeline</div>
        <div className="card-body">
          <div className="timeline">
            {/* Newest first: the thing people want during an outage is the
                latest word, not the archaeology. */}
            {[...i.updates].reverse().map((u, idx) => (
              <div className={`tl-item${idx === 0 ? ' current' : ''}`} key={idx}>
                <div className="tl-meta">
                  {INCIDENT_LABEL[u.status] ?? u.status} · {when(u.timestamp)} · {ago(u.timestamp)}
                </div>
                <div>{u.message}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
