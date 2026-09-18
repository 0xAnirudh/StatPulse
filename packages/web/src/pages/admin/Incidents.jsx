import { useState } from 'react';
import { api } from '../../lib/api.js';
import {
  useQuery,
  Loading,
  ErrorNote,
  Empty,
  Modal,
  Field,
  useToast,
} from '../../components/ui.jsx';
import { IMPACT_SEVERITY, INCIDENT_LABEL, when, ago } from '../../lib/format.js';

const STATUSES = ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'];
const IMPACTS = ['minor', 'major', 'critical'];

function DeclareForm({ components, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: '',
    message: '',
    impact: 'minor',
    status: 'INVESTIGATING',
    affectedComponents: [],
  });
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const toggle = (slug) =>
    setForm((f) => ({
      ...f,
      affectedComponents: f.affectedComponents.includes(slug)
        ? f.affectedComponents.filter((s) => s !== slug)
        : [...f.affectedComponents, slug],
    }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setGeneral(null);
    try {
      await api.createIncident(form);
      toast('Incident published — it is on the status page now');
      onSaved();
      onClose();
    } catch (err) {
      setErrors(err.fieldErrors);
      if (!Object.keys(err.fieldErrors).length) setGeneral(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Declare an incident"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="incident-form" disabled={busy}>
            {busy ? 'Publishing…' : 'Publish incident'}
          </button>
        </>
      }
    >
      <form id="incident-form" onSubmit={submit}>
        {general && <div className="alert bad">{general}</div>}

        <Field label="Title" error={errors.title}>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
            autoFocus
            placeholder="Elevated error rates on checkout"
          />
        </Field>

        <Field
          label="What are you telling people?"
          hint="This is the first entry on the timeline. Plain language, no jargon."
          error={errors.message}
        >
          <textarea
            value={form.message}
            onChange={(e) => setForm({ ...form, message: e.target.value })}
            required
            placeholder="We are investigating reports of failed payments. Updates to follow within 30 minutes."
          />
        </Field>

        <div className="grid-2">
          <Field label="Impact" hint="Drives the banner on the public page">
            <select
              value={form.impact}
              onChange={(e) => setForm({ ...form, impact: e.target.value })}
            >
              {IMPACTS.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          </Field>
          <Field label="Stage">
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              {STATUSES.filter((s) => s !== 'RESOLVED').map((s) => (
                <option key={s} value={s}>
                  {INCIDENT_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Affected components" error={errors.affectedComponents}>
          {components.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>
              No components yet.
            </div>
          ) : (
            <div className="inline" style={{ flexWrap: 'wrap', gap: 6 }}>
              {components.map((c) => {
                const on = form.affectedComponents.includes(c.slug);
                return (
                  <button
                    type="button"
                    key={c.slug}
                    className={`btn small${on ? ' primary' : ''}`}
                    onClick={() => toggle(c.slug)}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          )}
        </Field>
      </form>
    </Modal>
  );
}

function UpdateForm({ incident, onClose, onSaved }) {
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState(incident.status);
  const [general, setGeneral] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setGeneral(null);
    try {
      await api.updateIncident(incident.slug, { message, status });
      toast(status === 'RESOLVED' ? 'Incident resolved' : 'Update posted');
      onSaved();
      onClose();
    } catch (err) {
      setGeneral(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={incident.title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="update-form" disabled={busy}>
            {busy ? 'Posting…' : status === 'RESOLVED' ? 'Resolve incident' : 'Post update'}
          </button>
        </>
      }
    >
      <form id="update-form" onSubmit={submit}>
        {general && <div className="alert bad">{general}</div>}

        <Field label="Update">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            autoFocus
            placeholder="Rolled back the 10:05 deploy. Error rates are falling."
          />
        </Field>

        <Field label="Stage" hint="Choosing Resolved closes the incident and stamps the time.">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {INCIDENT_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
      </form>
    </Modal>
  );
}

export default function IncidentsAdmin() {
  const incidents = useQuery(() => api.adminIncidents(), [], { interval: 20_000 });
  const components = useQuery(() => api.adminComponents());
  const [declaring, setDeclaring] = useState(false);
  const [updating, setUpdating] = useState(null);

  const list = incidents.data?.incidents ?? [];
  const active = list.filter((i) => !i.resolvedAt);
  const past = list.filter((i) => i.resolvedAt);

  const card = (i) => (
    <div className="row" key={i.slug}>
      <div className="row-main">
        <div className="row-title">{i.title}</div>
        <div className="row-sub">
          {when(i.startedAt)}
          {i.resolvedAt
            ? ` · resolved ${ago(i.resolvedAt)}`
            : ` · ${i.updates?.length ?? 0} updates`}
        </div>
      </div>
      <div className="row-end">
        <span className={`pill ${IMPACT_SEVERITY[i.impact] ?? 'warn'}`}>{i.impact}</span>
        <span className={`pill ${i.resolvedAt ? 'ok' : 'idle'}`}>
          {INCIDENT_LABEL[i.status] ?? i.status}
        </span>
        {!i.resolvedAt && (
          <button className="btn small" onClick={() => setUpdating(i)}>
            Post update
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="container wide">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p>What the checks cannot see, and what you want customers to read.</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setDeclaring(true)}>
          Declare incident
        </button>
      </div>

      <ErrorNote error={incidents.error} retry={incidents.reload} />

      {incidents.loading ? (
        <Loading rows={3} />
      ) : list.length === 0 ? (
        <Empty
          title="No incidents"
          action={
            <button className="btn primary" onClick={() => setDeclaring(true)}>
              Declare one
            </button>
          }
        >
          Nothing has gone wrong yet. When it does, this is where you say so.
        </Empty>
      ) : (
        <>
          {active.length > 0 && (
            <>
              <div className="section-label">Open</div>
              <div className="card">{active.map(card)}</div>
            </>
          )}
          {past.length > 0 && (
            <>
              <div className="section-label">Resolved</div>
              <div className="card">{past.map(card)}</div>
            </>
          )}
        </>
      )}

      {declaring && (
        <DeclareForm
          components={components.data?.components ?? []}
          onClose={() => setDeclaring(false)}
          onSaved={incidents.reload}
        />
      )}
      {updating && (
        <UpdateForm
          incident={updating}
          onClose={() => setUpdating(null)}
          onSaved={incidents.reload}
        />
      )}
    </div>
  );
}
