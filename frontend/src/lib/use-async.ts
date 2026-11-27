"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

/**
 * Runs `fetcher` on mount and whenever it changes (wrap it in useCallback with its inputs).
 * Keeps the last good data while a refetch runs or fails; a response for an older fetcher is
 * dropped. `setData` allows optimistic updates; `reload` refetches and shows `loading`.
 */
export function useAsync<T>(fetcher: () => Promise<T>) {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  const latest = useRef(0);

  const run = useCallback(async () => {
    const id = ++latest.current;
    try {
      const data = await fetcher();
      if (id === latest.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === latest.current) setState((prev) => ({ ...prev, error, loading: false }));
    }
  }, [fetcher]);

  useEffect(() => {
    void run();
  }, [run]);

  const reload = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true }));
    await run();
  }, [run]);

  const setData = useCallback((update: (prev: T | null) => T | null) => {
    setState((prev) => ({ ...prev, data: update(prev.data) }));
  }, []);

  return { ...state, reload, setData };
}
