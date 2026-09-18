import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setAccessToken, onSessionLost } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [org, setOrg] = useState(null);
  const [ready, setReady] = useState(false);

  /**
   * Restore the session on load.
   *
   * The access token was in memory and is gone after a reload; the
   * refresh cookie is not. So every boot asks the server to trade the
   * cookie for a new token, which is what makes "stay logged in" work
   * without ever putting a credential somewhere a script could read it.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const renewed = await api.refresh();
        if (renewed && !cancelled) {
          setUser(renewed.user);
          const me = await api.me().catch(() => null);
          if (me && !cancelled) setOrg(me.organization);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // A refresh that fails mid-session - revoked, expired, or replayed -
  // drops straight back to signed out rather than leaving a dashboard
  // that silently fails every request.
  useEffect(() => {
    onSessionLost(() => {
      setUser(null);
      setOrg(null);
    });
  }, []);

  const signIn = useCallback(async (email, password) => {
    const res = await api.login({ email, password });
    setAccessToken(res.accessToken);
    setUser(res.user);
    const me = await api.me().catch(() => null);
    if (me) setOrg(me.organization);
    return res.user;
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setAccessToken(null);
    setUser(null);
    setOrg(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, org, ready, signIn, signOut, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
