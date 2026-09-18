import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api, setAccessToken } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Field } from '../components/ui.jsx';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const { setUser } = useAuth();
  const nav = useNavigate();

  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await api.acceptInvite({ token, password });
      setAccessToken(res.accessToken);
      setUser(res.user);
      nav('/admin', { replace: true });
    } catch (err) {
      setFieldErrors(err.fieldErrors);
      setError(Object.keys(err.fieldErrors).length ? null : err.message);
      setBusy(false);
    }
  }

  return (
    <div className="center-screen" style={{ marginTop: -60 }}>
      <div className="auth-card">
        <div className="page-head" style={{ display: 'block', textAlign: 'center' }}>
          <h1>Accept invitation</h1>
          <p>Choose a password to activate your account.</p>
        </div>

        <form className="card" onSubmit={submit}>
          <div className="card-body">
            {error && <div className="alert bad">{error}</div>}

            <Field label="Invitation token" error={fieldErrors.token}>
              <input
                type="text"
                value={token}
                required
                className="mono"
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>

            <Field
              label="Choose a password"
              hint="At least 12 characters. Length beats punctuation."
              error={fieldErrors.password}
            >
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                required
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Activating…' : 'Activate account'}
            </button>
          </div>
        </form>

        <div className="muted" style={{ textAlign: 'center', marginTop: 16, fontSize: 13 }}>
          <Link to="/signin" style={{ textDecoration: 'underline' }}>
            Already have an account?
          </Link>
        </div>
      </div>
    </div>
  );
}
