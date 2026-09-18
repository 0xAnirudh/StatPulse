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
import { SEVERITY, STATUS_LABEL, ago, ms } from '../../lib/format.js';

const TYPES = ['API', 'Database', 'Website', 'Webhook'];

const BLANK = {
  name: '',
  type: 'API',
  targetUrl: '',
  group: '',
  description: '',
  method: 'GET',
  expectedStatusCodes: '200',
  timeoutMs: 5000,
  degradedAboveMs: 1000,
  checkIntervalSec: 60,
  isPublic: true,
};

function ComponentForm({ initial, onClose, onSaved }) {
  const editing = Boolean(initial?.slug);
  const [form, setForm] = useState(
    initial
      ? { ...initial, expectedStatusCodes: (initial.expectedStatusCodes ?? [200]).join(', ') }
      : BLANK,
  );
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setGeneral(null);

    const body = {
      name: form.name,
      type: form.type,
      targetUrl: form.targetUrl.trim(),
      method: form.method,
      expectedStatusCodes: String(form.expectedStatusCodes)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n)),
      timeoutMs: Number(form.timeoutMs),
      degradedAboveMs: Number(form.degradedAboveMs),
      checkIntervalSec: Number(form.checkIntervalSec),
      isPublic: form.isPublic,
    };
    if (form.group?.trim()) body.group = form.group.trim();
    if (form.description?.trim()) body.description = form.description.trim();

    try {
      if (editing) await api.updateComponent(initial.slug, body);
      else await api.createComponent(body);
      toast(editing ? 'Component updated' : 'Component added — first check within a minute');
      onSaved();
      onClose();
    } catch (err) {
      setErrors(err.fieldErrors);
      /**
       * An SSRF rejection arrives as a 403 with a code like
       * target_private_address and a message naming the address. It is
       * shown against the URL field rather than as a generic banner,
       * because it is feedback about that input and the person needs to
       * fix it there.
       */
      if (err.code?.startsWith('target_')) setErrors((p) => ({ ...p, targetUrl: err.message }));
      else if (!Object.keys(err.fieldErrors).length) setGeneral(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? `Edit ${initial.name}` : 'Add a component'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="component-form" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add component'}
          </button>
        </>
      }
    >
      <form id="component-form" onSubmit={submit}>
        {general && <div className="alert bad">{general}</div>}

        <Field label="Name" error={errors.name}>
          <input
            type="text"
            value={form.name}
            onChange={set('name')}
            required
            autoFocus
            placeholder="Payment Gateway API"
          />
        </Field>

        <div className="grid-2">
          <Field label="Type" error={errors.type}>
            <select value={form.type} onChange={set('type')}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Group" hint="How it is grouped on the page" error={errors.group}>
            <input
              type="text"
              value={form.group ?? ''}
              onChange={set('group')}
              placeholder="Core"
            />
          </Field>
        </div>

        <Field
          label="URL to check"
          hint="Must be publicly reachable. Private and internal addresses are refused."
          error={errors.targetUrl}
        >
          <input
            type="text"
            value={form.targetUrl}
            onChange={set('targetUrl')}
            required
            placeholder="https://api.example.com/health"
            className="mono"
          />
        </Field>

        <div className="grid-2">
          <Field label="Method">
            <select value={form.method} onChange={set('method')}>
              <option>GET</option>
              <option>HEAD</option>
            </select>
          </Field>
          <Field
            label="Expected status codes"
            hint="Comma separated"
            error={errors.expectedStatusCodes}
          >
            <input
              type="text"
              value={form.expectedStatusCodes}
              onChange={set('expectedStatusCodes')}
              className="mono"
            />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Timeout (ms)" error={errors.timeoutMs}>
            <input
              type="number"
              value={form.timeoutMs}
              onChange={set('timeoutMs')}
              min={1000}
              max={15000}
            />
          </Field>
          <Field
            label="Degraded above (ms)"
            hint="Slower than this is Degraded, not Down"
            error={errors.degradedAboveMs}
          >
            <input
              type="number"
              value={form.degradedAboveMs}
              onChange={set('degradedAboveMs')}
              min={1}
            />
          </Field>
        </div>

        <Field label="Check every (seconds)" error={errors.checkIntervalSec}>
          <input
            type="number"
            value={form.checkIntervalSec}
            onChange={set('checkIntervalSec')}
            min={30}
            max={3600}
          />
        </Field>

        <Field label="Description" error={errors.description}>
          <input
            type="text"
            value={form.description ?? ''}
            onChange={set('description')}
            placeholder="Optional, shown under the name"
          />
        </Field>

        <label className="inline" style={{ fontSize: 13.5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.isPublic}
            onChange={set('isPublic')}
            style={{ width: 'auto' }}
          />
          Show on the public status page
        </label>
      </form>
    </Modal>
  );
}

export default function ComponentsAdmin() {
  const { data, error, loading, reload } = useQuery(() => api.adminComponents(), [], {
    interval: 15_000,
  });
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const toast = useToast();

  async function checkNow(slug) {
    try {
      await api.checkNow(slug);
      toast('Check queued — the result lands within a few seconds');
      setTimeout(reload, 4000);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function remove() {
    try {
      await api.deleteComponent(confirming.slug);
      toast('Component removed. Its history is kept.');
      setConfirming(null);
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function togglePaused(c) {
    try {
      await api.updateComponent(c.slug, { isActive: !c.isActive });
      toast(c.isActive ? 'Paused — checks stopped' : 'Resumed');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  return (
    <div className="container wide">
      <div className="page-head">
        <div>
          <h1>Components</h1>
          <p>What gets checked, how often, and what counts as healthy.</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEditing(BLANK)}>
          Add component
        </button>
      </div>

      <ErrorNote error={error} retry={reload} />

      {loading ? (
        <Loading rows={4} />
      ) : data.components.length === 0 ? (
        <Empty
          title="No components yet"
          action={
            <button className="btn primary" onClick={() => setEditing(BLANK)}>
              Add your first component
            </button>
          }
        >
          Point StatPulse at a URL and it will check it every minute.
        </Empty>
      ) : (
        <div className="card">
          {data.components.map((c) => {
            const tone = c.isActive ? (SEVERITY[c.status] ?? 'warn') : 'idle';
            return (
              <div className="row" key={c.slug}>
                <span className={`dot ${tone}`} />
                <div className="row-main">
                  <div className="row-title">
                    {c.name}
                    {!c.isPublic && <span className="pill idle">private</span>}
                    {!c.isActive && <span className="pill idle">paused</span>}
                  </div>
                  <div className="row-sub mono">{c.targetUrl}</div>
                </div>
                <div className="row-end">
                  <span className="hide-sm">{ms(c.responseTimeMs)}</span>
                  <span className="hide-sm">{ago(c.lastCheckedAt)}</span>
                  <span className={`pill ${tone}`}>
                    {c.isActive ? (STATUS_LABEL[c.status] ?? c.status) : 'Paused'}
                  </span>
                  <div className="inline">
                    <button
                      className="btn small ghost"
                      onClick={() => checkNow(c.slug)}
                      title="Check now"
                    >
                      Check
                    </button>
                    <button className="btn small ghost" onClick={() => togglePaused(c)}>
                      {c.isActive ? 'Pause' : 'Resume'}
                    </button>
                    <button className="btn small ghost" onClick={() => setEditing(c)}>
                      Edit
                    </button>
                    <button className="btn small ghost danger" onClick={() => setConfirming(c)}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ComponentForm
          initial={editing.slug ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}

      {confirming && (
        <Modal
          title={`Delete ${confirming.name}?`}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={remove}>
                Delete component
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            It stops being checked and disappears from the public page. Its uptime history is kept —
            deleting a component should not erase the record of how it behaved.
          </p>
        </Modal>
      )}
    </div>
  );
}
