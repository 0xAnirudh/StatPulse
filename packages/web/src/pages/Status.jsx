import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useQuery, Loading, ErrorNote, Empty } from '../components/ui.jsx';
import {
  SEVERITY,
  HEADLINE,
  STATUS_LABEL,
  IMPACT_SEVERITY,
  ago,
  ms,
  uptime,
} from '../lib/format.js';

/**
 * The public status page.
 *
 * Polls every thirty seconds. The endpoint is cached and answers 304
 * when nothing has changed, so watching this page costs almost nothing -
 * which matters, because the moment everyone watches it is the moment
 * the system can least afford the load.
 */
export default function StatusPage() {
  const { data, error, loading, reload } = useQuery(() => api.status(), [], { interval: 30_000 });

  if (loading) {
    return (
      <div className="container">
        <div className="skeleton" style={{ height: 66, marginBottom: 26 }} />
        <Loading rows={4} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container">
        <ErrorNote error={error} retry={reload} />
      </div>
    );
  }

  const tone = SEVERITY[data.status] ?? 'warn';

  return (
    <div className="container">
      <div className={`banner ${tone}`}>
        <span className={`dot ${tone}`} style={{ width: 11, height: 11 }} />
        {HEADLINE[data.status] ?? data.status}
        <span className="spacer" />
        <span style={{ fontSize: 12.5, fontWeight: 500, opacity: 0.85 }}>
          {data.stale ? 'showing cached data' : `updated ${ago(data.updatedAt)}`}
        </span>
      </div>

      {data.stale && (
        <div className="alert warn" style={{ marginTop: 14 }}>
          This page is being served from cache because the database is unreachable. The statuses
          below were accurate as of {ago(data.updatedAt)}.
        </div>
      )}

      {data.activeIncidents.length > 0 && (
        <>
          <div className="section-label">Active incidents</div>
          {data.activeIncidents.map((i) => (
            <Link
              to={`/incidents/${i.slug}`}
              key={i.slug}
              className="card"
              style={{ display: 'block' }}
            >
              <div className="card-body">
                <div className="inline" style={{ marginBottom: 6 }}>
                  <span className={`pill ${IMPACT_SEVERITY[i.impact] ?? 'warn'}`}>{i.impact}</span>
                  <span className="pill idle">{i.status}</span>
                  <span className="muted" style={{ fontSize: 12.5, marginLeft: 'auto' }}>
                    started {ago(i.startedAt)}
                  </span>
                </div>
                <div style={{ fontWeight: 580, fontSize: 15.5, marginBottom: 4 }}>{i.title}</div>
                {i.latestUpdate && <div className="muted">{i.latestUpdate.message}</div>}
                {i.affectedComponents.length > 0 && (
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                    Affects {i.affectedComponents.join(', ')}
                  </div>
                )}
              </div>
            </Link>
          ))}
        </>
      )}

      {data.groups.length === 0 ? (
        <div style={{ marginTop: 22 }}>
          <Empty title="Nothing is being monitored yet">
            Add a component from the dashboard and it will start reporting within a minute.
          </Empty>
        </div>
      ) : (
        data.groups.map((g) => (
          <div key={g.name}>
            <div className="section-label">{g.name}</div>
            <div className="card">
              {g.components.map((c) => {
                const t = SEVERITY[c.status] ?? 'warn';
                return (
                  <Link to={`/components/${c.slug}`} key={c.slug} className="row">
                    <span className={`dot ${t}`} />
                    <div className="row-main">
                      <div className="row-title">{c.name}</div>
                      {c.description && <div className="row-sub">{c.description}</div>}
                    </div>
                    <div className="row-end">
                      <span className="hide-sm" title="90-day uptime">
                        {uptime(c.uptime?.['90d'])}
                      </span>
                      <span className="hide-sm">{ms(c.responseTimeMs)}</span>
                      <span className={`pill ${t}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))
      )}

      <div className="muted" style={{ fontSize: 12.5, marginTop: 30 }}>
        Checks run every 60 seconds. This page refreshes automatically.{' '}
        <Link to="/history" style={{ textDecoration: 'underline' }}>
          Past incidents
        </Link>
      </div>
    </div>
  );
}
