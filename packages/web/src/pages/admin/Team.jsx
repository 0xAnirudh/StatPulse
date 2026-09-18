import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useQuery, Loading, ErrorNote, Modal, Field, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { ago, when } from '../../lib/format.js';

function InviteForm({ onClose, onSaved }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('admin');
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);
  const toast = useToast();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setGeneral(null);
    try {
      const res = await api.invite({ email, role });
      setIssued(res);
      onSaved();
    } catch (err) {
      setErrors(err.fieldErrors);
      if (!Object.keys(err.fieldErrors).length) setGeneral(err.message);
    } finally {
      setBusy(false);
    }
  }

  const link = issued ? `${window.location.origin}/accept-invite?token=${issued.token}` : '';

  /**
   * The token is shown, not emailed.
   *
   * There is no mail provider wired up, so the invitation has to be
   * handed over by the person sending it. Saying that plainly is better
   * than a "we've sent an email" that never arrives - and it is why the
   * token expires in a day and works exactly once.
   */
  if (issued) {
    return (
      <Modal
        title="Invitation created"
        onClose={onClose}
        footer={
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        }
      >
        <div className="alert warn">
          Email delivery is not configured, so send this link yourself. It expires in 24 hours and
          works once.
        </div>
        <Field label={`Invitation link for ${issued.user.email}`}>
          <input
            type="text"
            readOnly
            value={link}
            className="mono"
            onFocus={(e) => e.target.select()}
          />
        </Field>
        <button
          className="btn"
          onClick={() => {
            navigator.clipboard?.writeText(link);
            toast('Link copied');
          }}
        >
          Copy link
        </button>
      </Modal>
    );
  }

  return (
    <Modal
      title="Invite someone"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="invite-form" disabled={busy}>
            {busy ? 'Creating…' : 'Create invitation'}
          </button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit}>
        {general && <div className="alert bad">{general}</div>}

        <Field label="Email" error={errors.email}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </Field>

        <Field
          label="Role"
          hint="Admins manage the service. Owners also manage people."
          error={errors.role}
        >
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
        </Field>
      </form>
    </Modal>
  );
}

export default function TeamAdmin() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useQuery(() => api.users());
  const [inviting, setInviting] = useState(false);
  const toast = useToast();

  async function setStatus(u, status) {
    try {
      await api.updateUser(u.id, { status });
      toast(status === 'disabled' ? 'Account disabled — their sessions ended' : 'Account enabled');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  if (user?.role !== 'owner') {
    return (
      <div className="container">
        <div className="alert warn">
          Only owners can manage people. You are signed in as an admin, which covers everything
          about the service itself.
        </div>
      </div>
    );
  }

  return (
    <div className="container wide">
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p>Who can declare incidents, and who decides that.</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setInviting(true)}>
          Invite someone
        </button>
      </div>

      <ErrorNote error={error} retry={reload} />

      {loading ? (
        <Loading rows={2} />
      ) : (
        <div className="card">
          {data.users.map((u) => (
            <div className="row" key={u.id}>
              <span
                className={`dot ${u.status === 'active' ? 'ok' : u.status === 'invited' ? 'warn' : 'idle'}`}
              />
              <div className="row-main">
                <div className="row-title">
                  {u.email}
                  {u.id === user.id && <span className="pill idle">you</span>}
                </div>
                <div className="row-sub">
                  joined {when(u.memberSince)}
                  {u.lastLoginAt ? ` · last seen ${ago(u.lastLoginAt)}` : ' · never signed in'}
                </div>
              </div>
              <div className="row-end">
                <span className="pill idle">{u.role}</span>
                {u.status !== 'active' && <span className="pill warn">{u.status}</span>}
                {u.id !== user.id &&
                  (u.status === 'disabled' ? (
                    <button className="btn small ghost" onClick={() => setStatus(u, 'active')}>
                      Enable
                    </button>
                  ) : (
                    <button
                      className="btn small ghost danger"
                      onClick={() => setStatus(u, 'disabled')}
                    >
                      Disable
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {inviting && <InviteForm onClose={() => setInviting(false)} onSaved={reload} />}
    </div>
  );
}
