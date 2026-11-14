// The parts of Cloudflare's Workers runtime the ops Worker uses, typed here so the package needs no global runtime types
// and the tests can hand the same code an in-memory runtime. Only what the Worker calls is declared. The CI smoke test
// (e2e/ops-smoke.mjs, on Cloudflare's local runtime through miniflare) runs this code on the real runtime.

export type SqlValue = string | number | null | ArrayBuffer

export interface SqlCursor<Row> {
  toArray(): Row[]
}

export interface SqlStorage {
  exec<Row extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<Row>
}

export interface DurableObjectStorage {
  readonly sql: SqlStorage
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
  deleteAll(): Promise<void>
}

export interface DurableObjectState {
  readonly storage: DurableObjectStorage
}

export interface DurableObjectId {
  toString(): string
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

export interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** The Worker's bindings and variable (wrangler.jsonc) and its secrets (set with `wrangler secret put`). */
export interface Env {
  OPS_ACCOUNT: DurableObjectNamespace
  OPS_FLAGS: KVNamespace
  INTERNAL_SECRET?: string
  ACCOUNT_KEY?: string
  API_ORIGIN?: string
}

/** An outbound fetch: the probes, the DNS-over-HTTPS lookups and the reports to the API. */
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>

/** What differs between Cloudflare's runtime and the tests: the clock and the outbound fetch. */
export interface Runtime {
  now(): number
  fetch: Fetcher
}

/** Cloudflare's own runtime. */
export function workersRuntime(): Runtime {
  return {
    now: () => Date.now(),
    fetch: (input, init) => fetch(input, init),
  }
}
