import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/* ---- toasts ------------------------------------------------------------ */

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/* ---- modal ------------------------------------------------------------- */

export function Modal({ title, children, footer, onClose }) {
  // Escape closes. A dialog that can only be dismissed by hunting for a
  // button is the kind of thing people notice and cannot name.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---- forms ------------------------------------------------------------- */

export function Field({ label, hint, error, children }) {
  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      {label && <label>{label}</label>}
      {children}
      {error ? (
        <div className="field-error">{error}</div>
      ) : hint ? (
        <div className="hint">{hint}</div>
      ) : null}
    </div>
  );
}

/* ---- states ------------------------------------------------------------ */

export function Empty({ title, children, action }) {
  return (
    <div className="card">
      <div className="empty">
        <h3>{title}</h3>
        {children && <p style={{ margin: '0 0 14px' }}>{children}</p>}
        {action}
      </div>
    </div>
  );
}

export function Loading({ rows = 3 }) {
  return (
    <div className="card">
      {Array.from({ length: rows }, (_, i) => (
        <div className="row" key={i}>
          <div className="skeleton" style={{ width: 9, height: 9, borderRadius: '50%' }} />
          <div className="skeleton" style={{ height: 13, width: `${120 + ((i * 47) % 90)}px` }} />
          <div className="row-end">
            <div className="skeleton" style={{ height: 13, width: 54 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorNote({ error, retry }) {
  if (!error) return null;
  return (
    <div className="alert bad">
      {error.message}
      {retry && (
        <>
          {' '}
          <button className="btn small ghost" onClick={retry} style={{ marginLeft: 6 }}>
            Retry
          </button>
        </>
      )}
    </div>
  );
}

/* ---- data loading ------------------------------------------------------ */

/**
 * Fetch something, with the three states every screen actually has.
 *
 * `interval` re-fetches without flipping back to the loading skeleton,
 * so a screen that refreshes every few seconds does not flicker.
 */
export function useQuery(fn, deps = [], { interval } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const run = async (first) => {
      try {
        const result = await fn();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled && first) setError(err);
      } finally {
        if (!cancelled && first) setLoading(false);
      }
    };

    setLoading(true);
    run(true);

    if (interval) timer = setInterval(() => run(false), interval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `fn` is intentionally left out: callers pass an inline arrow, so
    // including it would re-run this on every render. The deps array the
    // caller supplies is what decides when to refetch.
  }, [...deps, tick]);

  return { data, error, loading, reload };
}
