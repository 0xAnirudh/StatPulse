import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import StatusPage from './pages/Status.jsx';
import IncidentPage from './pages/Incident.jsx';
import ComponentPage from './pages/Component.jsx';
import HistoryPage from './pages/History.jsx';
import SignIn from './pages/SignIn.jsx';
import AcceptInvite from './pages/AcceptInvite.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ComponentsAdmin from './pages/admin/Components.jsx';
import IncidentsAdmin from './pages/admin/Incidents.jsx';
import TeamAdmin from './pages/admin/Team.jsx';
import SessionsAdmin from './pages/admin/Sessions.jsx';

function Brand() {
  return (
    <NavLink to="/" className="brand">
      <span className="brand-mark">S</span>
      StatPulse
    </NavLink>
  );
}

function TopBar() {
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  const inAdmin = pathname.startsWith('/admin');

  return (
    <div className="topbar">
      <div className="container wide topbar-inner">
        <Brand />

        {inAdmin ? (
          <nav className="nav">
            <NavLink to="/admin" end className={({ isActive }) => (isActive ? 'active' : '')}>
              Overview
            </NavLink>
            <NavLink
              to="/admin/components"
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              Components
            </NavLink>
            <NavLink to="/admin/incidents" className={({ isActive }) => (isActive ? 'active' : '')}>
              Incidents
            </NavLink>
            {user?.role === 'owner' && (
              <NavLink to="/admin/team" className={({ isActive }) => (isActive ? 'active' : '')}>
                Team
              </NavLink>
            )}
            <NavLink to="/admin/sessions" className={({ isActive }) => (isActive ? 'active' : '')}>
              Sessions
            </NavLink>
          </nav>
        ) : (
          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
              Status
            </NavLink>
            <NavLink to="/history" className={({ isActive }) => (isActive ? 'active' : '')}>
              History
            </NavLink>
          </nav>
        )}

        <div className="spacer" />

        {user ? (
          <div className="inline">
            {!inAdmin && (
              <NavLink to="/admin" className="btn small">
                Dashboard
              </NavLink>
            )}
            {inAdmin && (
              <NavLink to="/" className="btn small ghost hide-sm">
                View status page
              </NavLink>
            )}
            <span className="muted hide-sm" style={{ fontSize: 13 }}>
              {user.email}
            </span>
            <button className="btn small ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        ) : (
          <NavLink to="/signin" className="btn small">
            Sign in
          </NavLink>
        )}
      </div>
    </div>
  );
}

/**
 * Gate an admin route.
 *
 * `ready` matters: on a reload the session is restored by exchanging the
 * refresh cookie, which takes a round trip. Redirecting before that
 * settles would bounce a signed-in user to the sign-in screen every time
 * they refreshed the page.
 */
function RequireAuth({ children }) {
  const { user, ready } = useAuth();
  const { pathname } = useLocation();

  if (!ready) {
    return (
      <div className="center-screen">
        <span className="muted">Restoring session…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/signin" state={{ from: pathname }} replace />;
  return children;
}

export default function App() {
  return (
    <div className="shell">
      <TopBar />
      <main>
        <Routes>
          <Route path="/" element={<StatusPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/incidents/:slug" element={<IncidentPage />} />
          <Route path="/components/:slug" element={<ComponentPage />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />

          <Route
            path="/admin"
            element={
              <RequireAuth>
                <Dashboard />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/components"
            element={
              <RequireAuth>
                <ComponentsAdmin />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/incidents"
            element={
              <RequireAuth>
                <IncidentsAdmin />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/team"
            element={
              <RequireAuth>
                <TeamAdmin />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/sessions"
            element={
              <RequireAuth>
                <SessionsAdmin />
              </RequireAuth>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
