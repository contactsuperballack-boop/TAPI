import { useCallback, useEffect, useRef, useState } from "react";

// Loads data once, exposes reload, and routes 401s to onAuthError so a bad/expired key returns to the connect screen.
export function useLoad(fn, deps, onAuthError) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = useCallback(async (silent) => {
    if (!silent) setState((s) => ({ ...s, loading: true }));
    try { const data = await fn(); if (alive.current) setState({ data, error: null, loading: false }); }
    catch (e) { if (e.status === 401 && onAuthError) return onAuthError(); if (alive.current) setState((s) => ({ ...s, error: e, loading: false })); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: () => run(true) };
}
