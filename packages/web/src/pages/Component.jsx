import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useQuery, Loading, ErrorNote } from '../components/ui.jsx';
import { SEVERITY, STATUS_LABEL, ago, ms, uptime } from '../lib/format.js';

/**
 * Ninety days of uptime, one bar per day.
 *
 * A day with no samples is drawn in grey rather than red. A gap in our
 * own observation is not downtime on the customer's side, and colouring
 * it as an outage would make this a chart of our reliability rather than
 * theirs.
 */
function UptimeBars({ history }) {
  const days = 90;
  const byDate = new Map(history.map((h) => [h.date, h]));
  const cells = [];

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const entry = byDate.get(d);

    let tone = 'none';
    let title = `${d} · no data`;
    if (entry && entry.checks > 0) {
      const pct = entry.uptime ?? 100;
      tone = pct >= 99.5 ? 'ok' : pct >= 95 ? 'warn' : 'bad';
      title = `${d} · ${pct}% of ${entry.checks} checks`;
    }
    cells.push(<div className={`bar ${tone}`} key={d} title={title} />);
  }

  return (
    <>
      <div className="bars">{cells}</div>
      <div className="bars-legend">
        <span>90 days ago</span>
        <span>today</span>
      </div>
    </>
  );
}

export default function ComponentPage() {
  const { slug } = useParams();
  const { data, error, loading, reload } = useQuery(() => api.component(slug), [slug], {
    interval: 30_000,
  });

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
        <Link to="/" className="btn small">
          Back to status
        </Link>
      </div>
    );

  const c = data.component;
  const tone = SEVERITY[c.status] ?? 'warn';

  return (
    <div className="container">
      <Link to="/" className="muted" style={{ fontSize: 13 }}>
        ← All systems
      </Link>

      <div className="page-head" style={{ marginTop: 14 }}>
        <div>
          <h1>{c.name}</h1>
          <p>
            {c.type}
            {c.group ? ` · ${c.group}` : ''} · last checked {ago(c.lastCheckedAt)}
          </p>
        </div>
        <div className="spacer" />
        <span className={`pill ${tone}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
      </div>

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="stat-label">Uptime, 24h</div>
          <div className="stat-value">{uptime(c.uptime?.['24h'])}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Uptime, 7d</div>
          <div className="stat-value">{uptime(c.uptime?.['7d'])}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Uptime, 90d</div>
          <div className="stat-value">{uptime(c.uptime?.['90d'])}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Response</div>
          <div className="stat-value">{ms(c.responseTimeMs)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          Daily uptime
          <span className="spacer" />
          <span className="muted" style={{ fontWeight: 400 }}>
            mean {ms(c.meanResponseMs)}
          </span>
        </div>
        <div className="card-body">
          <UptimeBars history={c.history ?? []} />
        </div>
      </div>
    </div>
  );
}
