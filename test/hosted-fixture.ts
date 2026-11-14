import { SQL } from "bun"
import { POOL_SCRIPTS } from "../api/_lib/codium-pool"
import { HOSTED_ENTITLEMENT_SCRIPTS } from "../api/_lib/hosted-entitlement"
import { HOSTED_LEDGER_SCRIPTS } from "../api/_lib/hosted-ledger"
import type { CodiumFakes } from "../packages/web/test/fixture/codium-fakes"

/*
 * Fakes for the cloud computer's ledger (WP A51), shared by its tests and the hosted packages that follow (A53, A55).
 *
 * - `registerHostedScripts` teaches the Codium fake store (packages/web/test/fixture/codium-fakes.ts) the ledger's
 *   scripts, as TypeScript, step for step: OPEN, CLOSE, LAPSE, METER, MARK, FINISH, the entitlement's MINUTES and the
 *   pool's LOWER. `test/hosted-ledger.test.ts` also runs the real Lua on Valkey when VECTOR_TEST_REDIS_URL is set.
 * - The ledger lines (`public.vector_hosted`) live in `MemoryLedger`, which answers as the SQL function does; with
 *   VECTOR_TEST_POSTGRES_URL set (CI), `PostgresLedger` runs docs/vector/owner-actions/sql/hosted.sql itself on the
 *   disposable Postgres, as the service role.
 */

export const SUPABASE_ORIGIN = "https://hosted-db.supabase.invalid"
export const SERVICE_ROLE = "fixture-hosted-service-role"
export const HOSTED_SALT = "fixture-hosted-account-salt-".padEnd(48, "s")

type Entry = Record<string, unknown> & {
  ref: string
  startedAt: number
  expiresAt: number
  block: number
  weight: number
  endedAt?: number
}

export function registerHostedScripts(fakes: Pick<CodiumFakes, "store" | "clock">) {
  const { store, clock } = fakes
  const grow = (key: string, at: number) => {
    const ttl = store.pttl(key)
    if (ttl === -1 || ttl < at - clock.now) store.expires.set(key, at)
  }
  const due = (key: string, member: string, at: number) => {
    const set = store.zset(key)
    const current = set.get(member)
    if (current === undefined || current > at) set.set(member, at)
  }
  const park = (settle: string, entry: Entry, ended: number) => {
    entry.endedAt = ended
    store.hash(settle).set(entry.ref, JSON.stringify(entry))
  }
  const purge = (running: string, settle: string, now: number, holdMs: number) => {
    let moved = 0
    const fields = store.hash(running)
    for (const [field, raw] of [...fields]) {
      let entry: Entry
      try {
        entry = JSON.parse(raw) as Entry
      } catch {
        return undefined
      }
      if (typeof entry.expiresAt !== "number" || typeof entry.startedAt !== "number" || typeof entry.ref !== "string")
        return undefined
      if (entry.expiresAt <= now) {
        fields.delete(field)
        park(settle, entry, Math.min(entry.expiresAt, entry.startedAt + holdMs))
        moved++
      }
    }
    store.prune(running)
    return moved
  }
  const rescore = (running: string, index: string, account: string) => {
    let earliest: number | undefined
    for (const raw of store.hash(running).values()) {
      const entry = JSON.parse(raw) as Entry
      if (earliest === undefined || entry.expiresAt < earliest) earliest = entry.expiresAt
    }
    store.prune(running)
    if (earliest === undefined) store.zset(index).delete(account)
    else store.zset(index).set(account, earliest)
    store.prune(index)
  }

  const scripts: [string, (keys: string[], argv: string[]) => unknown][] = [
    [
      HOSTED_LEDGER_SCRIPTS.OPEN,
      ([running, minutes, settle, settleDue, lapse], [payload]) => {
        const p = JSON.parse(payload!) as Record<string, any>
        const now = p.now as number
        const moved = purge(running!, settle!, now, p.holdMs)
        if (moved === undefined) return ["unavailable"]
        if (moved > 0) {
          grow(settle!, p.settleAt)
          due(settleDue!, p.account, now)
          rescore(running!, lapse!, p.account)
        }
        const raw = store.hash(running!).get(p.session)
        store.prune(running!)
        const current = raw === undefined ? undefined : (JSON.parse(raw) as Entry)
        if (p.prev < 0) {
          if (current) return ["exists"]
          const count = store.hash(running!).size
          store.prune(running!)
          if (count >= p.computers) return ["busy"]
        } else if (!current || current.block !== p.prev) return ["moved"]
        const meter = store.hash(minutes!)
        const used = Number(meter.get("used") ?? "0")
        let reserved = 0
        for (const [field, value] of [...meter]) {
          if (!field.startsWith("r:")) continue
          const match = /^(\d+):(\d+)$/.exec(value)
          if (!match) return ["unavailable"]
          if (Number(match[2]) <= now) meter.delete(field)
          else if (!current || field !== `r:${current.ref}`) reserved += Number(match[1])
        }
        const ran = current ? Math.max(0, Math.ceil((now - current.startedAt) / 60_000)) * current.weight : 0
        const grant = Math.min(p.want, Math.floor((p.cap - used - reserved - ran) / p.weight))
        if (grant < 1) {
          store.prune(minutes!)
          return ["hours"]
        }
        const entry = { ...(p.entry as Entry), minutes: grant }
        meter.set(`r:${entry.ref}`, `${grant * p.weight}:${entry.expiresAt}`)
        if (current) meter.set(`r:${current.ref}`, `${ran}:${current.expiresAt}`)
        grow(minutes!, p.minutesAt)
        store.hash(running!).set(p.session, JSON.stringify(entry))
        grow(running!, p.runningAt)
        if (current) {
          park(settle!, current, now)
          grow(settle!, p.settleAt)
          due(settleDue!, p.account, now)
        }
        rescore(running!, lapse!, p.account)
        return ["ok", grant]
      },
    ],
    [
      HOSTED_LEDGER_SCRIPTS.CLOSE,
      ([running, settle, settleDue, lapse], [session, block, ended, now, account, settleAt]) => {
        const raw = store.hash(running!).get(session!)
        store.prune(running!)
        if (raw === undefined) return ""
        const entry = JSON.parse(raw) as Entry
        if (entry.block !== Number(block)) return ""
        store.hash(running!).delete(session!)
        store.prune(running!)
        park(settle!, entry, Math.max(entry.startedAt, Number(ended)))
        grow(settle!, Number(settleAt))
        due(settleDue!, account!, Number(now))
        rescore(running!, lapse!, account!)
        return store.hash(settle!).get(entry.ref)
      },
    ],
    [
      HOSTED_LEDGER_SCRIPTS.LAPSE,
      ([running, settle, settleDue, lapse], [now, account, holdMs, settleAt]) => {
        const moved = purge(running!, settle!, Number(now), Number(holdMs))
        if (moved === undefined) return -1
        if (moved > 0) {
          grow(settle!, Number(settleAt))
          due(settleDue!, account!, Number(now))
        }
        rescore(running!, lapse!, account!)
        return moved
      },
    ],
    [
      HOSTED_LEDGER_SCRIPTS.METER,
      ([opened, settled], [ref, weighted, expireAt]) => {
        store.hash(opened!).delete(`r:${ref}`)
        store.prune(opened!)
        const meter = store.hash(settled!)
        meter.delete(`r:${ref}`)
        if (meter.has(`d:${ref}`)) return 0
        meter.set("used", String(Number(meter.get("used") ?? "0") + Number(weighted)))
        meter.set(`d:${ref}`, weighted!)
        grow(settled!, Number(expireAt))
        return 1
      },
    ],
    [
      HOSTED_LEDGER_SCRIPTS.MARK,
      ([settle], [ref, entry]) => {
        const queue = store.hash(settle!)
        if (!queue.has(ref!)) {
          store.prune(settle!)
          return 0
        }
        queue.set(ref!, entry!)
        return 1
      },
    ],
    [
      HOSTED_LEDGER_SCRIPTS.FINISH,
      ([settle, settleDue], [ref, account]) => {
        const queue = store.hash(settle!)
        queue.delete(ref!)
        if (queue.size === 0) {
          store.prune(settle!)
          store.zset(settleDue!).delete(account!)
          store.prune(settleDue!)
        }
        return 1
      },
    ],
    [
      HOSTED_ENTITLEMENT_SCRIPTS.MINUTES,
      ([minutes], [now]) => {
        const meter = store.hash(minutes!)
        const used = Number(meter.get("used") ?? "0")
        let reserved = 0
        for (const [field, value] of [...meter]) {
          if (!field.startsWith("r:")) continue
          const match = /^(\d+):(\d+)$/.exec(value)
          if (!match) return [-1, -1]
          if (Number(match[2]) <= Number(now)) meter.delete(field)
          else reserved += Number(match[1])
        }
        store.prune(minutes!)
        return [used, reserved]
      },
    ],
    [
      POOL_SCRIPTS.LOWER,
      ([debits, held, queue], [ref, target, member, at]) => {
        const records = store.hash(debits!)
        const raw = records.get(ref!)
        if (raw === undefined) {
          store.prune(debits!)
          return -2
        }
        const micro = /^\{"micro":(\d+),/.exec(raw)?.[1]
        const hold = /"hold":"([^"]+)"/.exec(raw)?.[1]
        if (!micro || !hold || !/^\d+$/.test(target!)) return -1
        if (Number(target) >= Number(micro)) return 0
        if (!hold.endsWith(`:${micro}`)) return -1
        const lowered = `${hold.slice(0, -micro.length)}${target}`
        let updated = `{"micro":${target},${raw.slice(micro.length + 10)}`
        updated = updated.replace(`"hold":"${hold}"`, `"hold":"${lowered}"`)
        if (raw.includes('"applied":false')) {
          const set = store.zset(held!)
          const score = set.get(hold)
          if (score === undefined) return -1
          set.delete(hold)
          set.set(lowered, score)
        }
        records.set(ref!, updated)
        due(queue!, member!, Number(at))
        return 1
      },
    ],
  ]
  for (const [text, run] of scripts) store.scripts.set(text, run)
}

// ── The ledger lines ───────────────────────────────────────────────────────────────────────────────────────────────

export type LedgerRow = {
  mode: string
  account: string
  ref: string
  kind: string
  size: string | null
  units: number
  chargedMicro: number
  costMicro: number
  truedMicro: number | null
  periodStart: number | null
  periodEnd: number | null
  occurredAt: number
  settledAt: number
}

export interface LedgerBackend {
  readonly real: boolean
  call(request: Record<string, unknown>): Promise<unknown>
  rows(): Promise<LedgerRow[]>
  reset(): Promise<void>
  close(): Promise<void>
}

const REF = /^h[bser]-[A-Za-z0-9_.:-]{1,197}$/
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)

/** `public.vector_hosted` as TypeScript: the same answers, checks and once-only writes as the SQL. */
export class MemoryLedger implements LedgerBackend {
  readonly real = false
  readonly lines = new Map<string, LedgerRow>()
  /** Set to make every call fail, as an unreachable store does. */
  down = false

  async call(request: Record<string, any>) {
    if (this.down) throw new Error("ledger down")
    const { mode, account, action, now } = request
    if (
      !["live", "test"].includes(mode) ||
      typeof now !== "number" ||
      typeof account !== "string" ||
      !/^[a-f0-9]{64}$/.test(account)
    )
      return { status: "invalid" }
    let ref: string
    if (action === "record") {
      const line = request.line
      const block = line?.kind === "block" || line?.kind === "overrun"
      if (
        typeof line !== "object" ||
        typeof line.ref !== "string" ||
        !REF.test(line.ref) ||
        !["block", "overrun", "storage", "egress", "retention"].includes(line.kind) ||
        block !== (typeof line.size === "string") ||
        (line.size !== null && !["standard", "large"].includes(line.size)) ||
        typeof line.units !== "number" ||
        line.units < 0 ||
        !isInt(line.chargedMicro) ||
        !isInt(line.costMicro) ||
        line.costMicro < 0 ||
        line.chargedMicro < line.costMicro ||
        typeof line.occurredAt !== "number" ||
        line.occurredAt < 0 ||
        (line.periodStart === null) !== (line.periodEnd === null) ||
        (line.periodStart !== null &&
          (!isInt(line.periodStart) || !isInt(line.periodEnd) || line.periodEnd <= line.periodStart))
      )
        return { status: "invalid" }
      ref = line.ref
      if (!this.lines.has(`${mode}:${ref}`))
        this.lines.set(`${mode}:${ref}`, {
          mode,
          account,
          ref,
          kind: line.kind,
          size: line.size,
          units: line.units,
          chargedMicro: line.chargedMicro,
          costMicro: line.costMicro,
          truedMicro: null,
          periodStart: line.periodStart,
          periodEnd: line.periodEnd,
          occurredAt: line.occurredAt,
          settledAt: Math.trunc(now),
        })
    } else if (action === "get" || action === "trued") {
      if (typeof request.ref !== "string" || !REF.test(request.ref)) return { status: "invalid" }
      ref = request.ref
      if (action === "trued") {
        if (!isInt(request.trued) || request.trued < 0) return { status: "invalid" }
        const row = this.lines.get(`${mode}:${ref}`)
        if (row && row.account === account && request.trued < (row.truedMicro ?? row.chargedMicro))
          row.truedMicro = request.trued
      }
    } else if (action === "period") {
      if (typeof request.periodStart !== "number") return { status: "invalid" }
      const rows = [...this.lines.values()].filter(
        (row) => row.mode === mode && row.account === account && row.periodStart === request.periodStart,
      )
      return {
        status: "ok",
        totals: {
          chargedMicro: rows.reduce((sum, row) => sum + row.chargedMicro, 0),
          truedMicro: rows.reduce((sum, row) => sum + (row.truedMicro ?? row.chargedMicro), 0),
          minutes: rows
            .filter((row) => row.kind === "block" || row.kind === "overrun")
            .reduce((sum, row) => sum + row.units, 0),
          lines: rows.length,
        },
      }
    } else return { status: "invalid" }
    const row = this.lines.get(`${mode}:${ref}`)
    if (!row) return { status: "not_found" }
    if (row.account !== account) return { status: action === "record" ? "conflict" : "not_found" }
    const { mode: _mode, account: _account, ...line } = row
    return { status: "ok", line }
  }

  async rows() {
    return [...this.lines.values()]
  }

  async reset() {
    this.lines.clear()
  }

  async close() {}
}

/** The real SQL on a disposable Postgres (CI), called as the service role exactly as PostgREST would. */
export class PostgresLedger implements LedgerBackend {
  readonly real = true
  private constructor(private readonly database: SQL) {}

  static async connect(address: string) {
    const url = new URL(address)
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/vector_shares_test")
      throw new Error("Hosted ledger SQL tests require the disposable loopback vector_shares_test database")
    const database = new SQL(url.href)
    await database
      .unsafe(
        `
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    `,
      )
      .simple()
    await database
      .unsafe(await Bun.file(new URL("../docs/vector/owner-actions/sql/hosted.sql", import.meta.url)).text())
      .simple()
    return new PostgresLedger(database)
  }

  async call(request: Record<string, unknown>) {
    const rows = await this.database.begin(async (transaction) => {
      await transaction`set local role service_role`
      return transaction`select public.vector_hosted(${request}::jsonb) as result`
    })
    return rows[0].result
  }

  async rows(): Promise<LedgerRow[]> {
    const rows = await this.database`select * from public.vector_hosted_ledger order by ref`
    return rows.map((row: any) => ({
      mode: row.mode,
      account: row.account,
      ref: row.ref,
      kind: row.kind,
      size: row.size,
      units: Number(row.units),
      chargedMicro: Number(row.charged_micro),
      costMicro: Number(row.cost_micro),
      truedMicro: row.trued_micro === null ? null : Number(row.trued_micro),
      periodStart: row.period_start === null ? null : Number(row.period_start),
      periodEnd: row.period_end === null ? null : Number(row.period_end),
      occurredAt: Number(row.occurred_at),
      settledAt: Number(row.settled_at),
    }))
  }

  async reset() {
    await this.database`truncate public.vector_hosted_ledger`
  }

  async close() {
    await this.database.close()
  }
}

export async function ledgerBackend(): Promise<LedgerBackend> {
  const address = process.env.VECTOR_TEST_POSTGRES_URL
  return address ? PostgresLedger.connect(address) : new MemoryLedger()
}

/** The fakes' fetch, plus Supabase's RPC endpoint answered by `ledger`. */
export function hostedFetcher(fakes: CodiumFakes, ledger: LedgerBackend, calls: string[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === SUPABASE_ORIGIN) {
      if (url.pathname !== "/rest/v1/rpc/vector_hosted" || init?.method !== "POST")
        return new Response("not found", { status: 404 })
      const headers = new Headers(init.headers)
      if (headers.get("apikey") !== SERVICE_ROLE || headers.get("authorization") !== `Bearer ${SERVICE_ROLE}`)
        return new Response("unauthorized", { status: 401 })
      const body = JSON.parse(String(init.body)) as { request: Record<string, unknown> }
      calls.push(String(body.request.action))
      try {
        return Response.json(await ledger.call(body.request))
      } catch {
        return new Response("unavailable", { status: 503 })
      }
    }
    return fakes.fetcher(input, init)
  }) as typeof fetch
}
