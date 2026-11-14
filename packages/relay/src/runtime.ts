// The parts of Cloudflare's Workers runtime the relay uses, typed here so the package needs no global runtime types and
// the tests can hand the same code an in-memory runtime. Only what the relay calls is declared. The CI smoke test
// (e2e/relay-smoke.ts, under `wrangler dev --local`) runs this code on the real runtime.

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

/** A server-side WebSocket with the hibernation API's attachment. `readyState` 1 is open. */
export interface RelaySocket {
  readonly readyState: number
  send(message: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  accept?(): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

export interface DurableObjectState {
  readonly storage: DurableObjectStorage
  acceptWebSocket(socket: RelaySocket, tags?: string[]): void
  getWebSockets(tag?: string): RelaySocket[]
  setWebSocketAutoResponse(pair?: unknown): void
  getWebSocketAutoResponseTimestamp(socket: RelaySocket): Date | null
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

/** The Worker's bindings (wrangler.jsonc) and secrets (set with `wrangler secret put`). */
export interface Env {
  ACCOUNT_RELAY: DurableObjectNamespace
  REMOTE_FLAGS: KVNamespace
  TICKET_PUBLIC_KEYS?: string
  INTERNAL_SECRET?: string
  ACCOUNT_KEY?: string
}

/** What differs between Cloudflare's runtime and the tests: the clock, WebSocket pairs and the 101 answer. */
export interface Runtime {
  now(): number
  pair(): { client: RelaySocket; server: RelaySocket }
  upgrade(client: RelaySocket, headers: Record<string, string>): Response
  autoResponse(request: string, response: string): unknown
}

type WorkersGlobals = {
  WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket }
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown
}

/** Cloudflare's own runtime. */
export function workersRuntime(): Runtime {
  const globals = globalThis as unknown as WorkersGlobals
  return {
    now: () => Date.now(),
    pair: () => {
      const pair = new globals.WebSocketPair()
      return { client: pair[0], server: pair[1] }
    },
    upgrade: (client, headers) => new Response(null, { status: 101, webSocket: client, headers } as ResponseInit),
    autoResponse: (request, response) => new globals.WebSocketRequestResponsePair(request, response),
  }
}
