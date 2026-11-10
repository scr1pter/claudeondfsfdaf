import {useCallback, useEffect, useState} from 'react';

export async function api<T>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(path, {method, headers: {'Content-Type': 'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const result = await response.json(); message = result.error?.message || message; } catch { /* Preserve HTTP error. */ }
    throw new Error(message);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function useData<T>(path: string | null, revision: number, poll = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) {setData(null); setLoading(false); return;}
    try {setData(await api<T>(path)); setError('');} catch (e) {setError((e as Error).message);} finally {setLoading(false);}
  }, [path]);
  useEffect(() => {let active = true; setData(null); setLoading(!!path); setError(''); if (!path) {setLoading(false); return;}
    const fetchData = async () => {try {const value = await api<T>(path); if (active) {setData(value); setError('');}} catch (e) {if (active) setError((e as Error).message);} finally {if (active) setLoading(false);}};
    void fetchData(); const timer = poll ? window.setInterval(fetchData, 1200) : undefined;
    return () => {active = false; if (timer) window.clearInterval(timer);};
  }, [path, revision, poll]);
  return {data, error, loading, reload};
}

export function query(values: Record<string, string | undefined>) {
  const result = new URLSearchParams(); Object.entries(values).forEach(([key, value]) => {if (value) result.set(key, value);});
  const string = result.toString(); return string ? `?${string}` : '';
}
