import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useQuery, Loading, ErrorNote, Empty } from '../components/ui.jsx';
import { useAuth } from '../lib/auth.jsx';
import { SEVERITY, STATUS_LABEL, HEADLINE, IMPACT_SEVERITY, ago, ms } from '../lib/format.js';

export default function Dashboard() {
  const { org } = useAuth();
  const status = useQuery(() => api.status(), [], { interval: 15_000 });
  const components = useQuery(() => api.adminComponents(), [], { interval: 15_000 });
  const incidents = useQuery(() => api.adminIncidents(), [], { interval: 30_000 });

  const all = components.data?.components ?? [];
  const live = all.filter((c) => c.isActive);
  const down = live.filter((c) => c.status === 'DOWN');
  const degraded = live.filter((c) => c.status === 'DEGRADED');
  const open = (incidents.data?.incidents ?? []).filter((i) => !i.resolvedAt);

  const latencies = live.map((c) => c.responseTimeMs).filter((n) => typeof n === 'number');
  const meanLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  const overall = status.data?.status;
  const tone = SEVERITY[overall] ?? 'idle';

  return (
    <div className="container wide">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>{org?.name ?? 'Your organization'} · refreshing every 15 seconds</p>
        </div>
        <div className="spacer" />
        <Link to="/admin/incidents" className="btn primary">
          Declare incident
        </Link>
      </div>

      <ErrorNote error={components.error} retry={components.reload} />

      {status.data && (
        <div className={`banner ${tone}`} style={{ marginBottom: 18 }}>
          <span className={`dot ${tone}`} style={{ width: 11, height: 11 }} />
          {HEADLINE[overall] ?? overall}
          <span className="spacer" />
          <Link to="/" style={{ fontSize: 13, fontWeight: 500, textDecoration: 'underline' }}>
            View public page
          </Link>
        </div>
      )}

      <div className="stat-grid" style={{ marginBottom: 22 }}>
        <div className="stat">
          <div className="stat-label">Monitored</div>
          <div className="stat-value">{live.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Down</div>
          <div className="stat-value" style={{ color: down.length ? 'var(--bad)' : undefined }}>
            {down.length}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Degraded</div>
          <div
            className="stat-value"
            style={{ color: degraded.length ? 'var(--warn)' : undefined }}
          >
            {degraded.length}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Mean response</div>
          <div className="stat-value">{meanLatency == null ? '—' : `${meanLatency}`}</div>
        </div>
      </div>

      {open.length > 0 && (
        <>
          <div className="section-label">Open incidents</div>
          <div className="card" style={{ marginBottom: 6 }}>
            {open.map((i) => (
              <Link to="/admin/incidents" className="row" key={i.slug}>
                <div className="row-main">
                  <div className="row-title">{i.title}</div>
                  <div className="row-sub">started {ago(i.startedAt)}</div>
                </div>
                <div className="row-end">
                  <span className={`pill ${IMPACT_SEVERITY[i.impact] ?? 'warn'}`}>{i.impact}</span>
                  <span className="pill idle">{i.status}</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <div className="section-label">Components</div>

      {components.loading ? (
        <Loading rows={4} />
      ) : all.length === 0 ? (
        <Empty
          title="Nothing is being monitored"
          action={
            <Link to="/admin/components" className="btn primary">
              Add a component
            </Link>
          }
        >
          Point StatPulse at a URL and it starts checking within a minute.
        </Empty>
      ) : (
        <div className="card">
          {all.map((c) => {
            const t = c.isActive ? (SEVERITY[c.status] ?? 'warn') : 'idle';
            return (
              <Link to="/admin/components" className="row" key={c.slug}>
                <span className={`dot ${t}`} />
                <div className="row-main">
                  <div className="row-title">{c.name}</div>
                  <div className="row-sub mono">{c.targetUrl}</div>
                </div>
                <div className="row-end">
                  <span className="hide-sm">{ms(c.responseTimeMs)}</span>
                  <span className="hide-sm">{ago(c.lastCheckedAt)}</span>
                  <span className={`pill ${t}`}>
                    {c.isActive ? (STATUS_LABEL[c.status] ?? c.status) : 'Paused'}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
