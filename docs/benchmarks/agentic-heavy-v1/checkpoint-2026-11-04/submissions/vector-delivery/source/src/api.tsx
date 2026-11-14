import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Session, Workspace } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function api<T = Record<string, never>>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    let error: {error?: {code?: string; message?: string}} = {};
    try { error = await response.json(); } catch { /* A non-JSON failure still has a visible message. */ }
    throw new ApiError(response.status, error.error?.code || 'request_failed', error.error?.message || `Request failed (${response.status}). Please try again.`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
export const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body !== undefined ? {body: JSON.stringify(body)} : {}) });
export const message = (e: unknown) => e instanceof Error ? e.message : 'Something went wrong. Please try again.';

interface AppContextValue {
  session: Session; workspace: Workspace; base: string; version: number;
  refresh: () => void; reloadSession: () => Promise<void>; canEdit: boolean; canManage: boolean; isOwner: boolean;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() { const value = useContext(AppContext); if (!value) throw new Error('Workspace context missing'); return value; }

export function useResource<T>(path: string | null) {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    if (!path) { setData(null); setLoading(false); return; }
    setLoading(true);
    api<T>(path).then(result => { if (generation.current === current) { setData(result); setError(''); } })
      .catch(e => { if (generation.current === current) { setError(message(e)); if (e instanceof ApiError && [401,403,404].includes(e.status)) setData(null); } })
      .finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current++; };
  }, [path, version, tick]);
  const retry = useCallback(() => setTick(t => t + 1), []);
  return { data, error, loading, retry };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}

export function centsFromDollars(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error('Enter a valid dollar amount with at most two decimal places.');
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (cents > 100000000n) throw new Error('Unit price must not exceed $1,000,000.00.');
  return Number(cents);
}
export function integer(value: string, min: number, max: number) {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`Enter a whole number from ${min} to ${max}.`);
  return Number(value);
}
export const money = (cents: number) => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100);
export const date = (value?: string | null) => value ? new Date(value).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', ...(value.length === 10 ? {timeZone:'UTC'} : {})}) : '—';
export const label = (value: string) => value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
