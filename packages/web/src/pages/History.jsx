import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useQuery, Loading, ErrorNote, Empty } from '../components/ui.jsx';
import { IMPACT_SEVERITY, INCIDENT_LABEL, when, ago } from '../lib/format.js';

export default function HistoryPage() {
  const { data, error, loading, reload } = useQuery(() => api.incidents('?limit=50'));

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1>Incident history</h1>
          <p>Everything we have declared, most recent first.</p>
        </div>
      </div>

      <ErrorNote error={error} retry={reload} />
      {loading ? (
        <Loading rows={3} />
      ) : data?.incidents.length === 0 ? (
        <Empty title="No incidents recorded">
          Nothing has gone wrong yet — or nothing has been written down.
        </Empty>
      ) : (
        <div className="card">
          {data.incidents.map((i) => (
            <Link to={`/incidents/${i.slug}`} key={i.slug} className="row">
              <div className="row-main">
                <div className="row-title">{i.title}</div>
                <div className="row-sub">
                  {when(i.startedAt)}
                  {i.resolvedAt ? ` · resolved ${ago(i.resolvedAt)}` : ' · ongoing'}
                </div>
              </div>
              <div className="row-end">
                <span className={`pill ${IMPACT_SEVERITY[i.impact] ?? 'warn'}`}>{i.impact}</span>
                <span className={`pill ${i.resolvedAt ? 'ok' : 'idle'}`}>
                  {INCIDENT_LABEL[i.status] ?? i.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
