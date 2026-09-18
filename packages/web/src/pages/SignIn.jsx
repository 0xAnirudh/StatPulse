import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Field } from '../components/ui.jsx';

export default function SignIn() {
  const { signIn, user } = useAuth();
  const nav = useNavigate();
  const { state } = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) nav(state?.from ?? '/admin', { replace: true });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      nav(state?.from ?? '/admin', { replace: true });
    } catch (err) {
      /**
       * Whatever the server said, verbatim.
       *
       * It deliberately returns the same message for a wrong password
       * and an unknown account - inventing a friendlier, more specific
       * one here would hand back the account-enumeration oracle the
       * backend went to some trouble to close.
       */
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="center-screen" style={{ marginTop: -60 }}>
      <div className="auth-card">
        <div className="page-head" style={{ display: 'block', textAlign: 'center' }}>
          <h1>Sign in</h1>
          <p>Manage components and declare incidents.</p>
        </div>

        <form className="card" onSubmit={submit}>
          <div className="card-body">
            {error && <div className="alert bad">{error}</div>}

            <Field label="Email">
              <input
                type="email"
                value={email}
                autoComplete="username"
                autoFocus
                required
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <Field label="Password">
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                required
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>

        <div className="muted" style={{ textAlign: 'center', marginTop: 16, fontSize: 13 }}>
          <Link to="/" style={{ textDecoration: 'underline' }}>
            Back to the status page
          </Link>
        </div>
      </div>
    </div>
  );
}
