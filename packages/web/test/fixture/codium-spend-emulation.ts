import { POOL_SCRIPTS } from "../../../../api/_lib/codium-pool"
import { MODEL_SPEND_SCRIPTS } from "../../../../api/_lib/codium-spend-ledger"

/*
 * The A17 spend scripts as TypeScript, step for step, for the in-memory stores that run the root `test/` suite without
 * Valkey (test.yml): GENESIS, the ledger's READ, status's read-only DAY figure and the common pool HOLD, with the
 * shared ledger read and fence they are built from (codium-spend-ledger.ts MODEL_SPEND_LUA). Model ADMIT and SETTLE are
 * deliberately not emulated: their money and race assertions run only on real Lua. test/codium-pool.test.ts runs the
 * same HOLD/READ cases both in memory and on Valkey (VECTOR_TEST_REDIS_URL), which is the check that this emulation and
 * the Lua agree; DAY's agreement with ADMIT is checked on real Lua in model-plans-api.test.ts.
 */

export type SpendValue =
  | { kind: "string"; value: string }
  | { kind: "hash"; value: Map<string, string> }
  | { kind: "set"; value: Set<string> }
  | { kind: "zset"; value: Map<string, number> }

/** What a store gives the emulation: its live values, and Valkey's writes with their lifetime rules. */
export type SpendStore = {
  /** The live value, or undefined (missing or expired). */
  read(key: string): SpendValue | undefined
  /** SET, which clears the lifetime unless `keepTtl` (KEEPTTL). */
  setString(key: string, value: string, keepTtl?: boolean): void
  /** The hash or sorted set at `key`, created when missing; `prune` removes it again once empty. */
  hash(key: string): Map<string, string>
  zset(key: string): Map<string, number>
  prune(key: string): void
  /** PTTL: -2 for a missing key, -1 for one without a lifetime. */
  pttl(key: string): number
  /** PEXPIREAT on an existing key. */
  expireAt(key: string, at: number): void
}

type Script = (keys: string[], argv: string[]) => unknown
type Json = Record<string, unknown>

const SAFE = Number.MAX_SAFE_INTEGER
const PURPOSES = new Set([
  "chat",
  "title",
  "brain",
  "review",
  "judge",
  "race",
  "playbook",
  "task",
  "cloud-agents",
  "hosted",
])
const RECORD_NUMBERS = ["micro", "deadline", "admittedAt", "periodEnd", "runUntil", "version", "charge", "gcAt"]

// Lua's tonumber, then the script's integer guard.
function integer(value: unknown, signed = false) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN
  if (!Number.isFinite(n) || n > SAFE || n < (signed ? -SAFE : 0) || !Number.isInteger(n)) return undefined
  return n
}
const plus = (a: number | undefined, b: number | undefined) =>
  a === undefined || b === undefined || a > SAFE - b ? undefined : a + b
function object(raw: unknown): Json | undefined {
  if (typeof raw !== "string") return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === "object" && value !== null ? (value as Json) : undefined
  } catch {
    return undefined
  }
}
function member(raw: unknown) {
  if (typeof raw !== "string") return undefined
  const match = /^([A-Za-z0-9-]+):([a-z][a-z0-9-]*):([A-Za-z0-9_.-]+):(\d+)$/.exec(raw)
  const micro = integer(match?.[4])
  if (!match || match[1]!.length > 64 || !PURPOSES.has(match[2]!) || match[3]!.length > 128 || micro === undefined)
    return undefined
  return { ticket: match[1]!, purpose: match[2]!, run: match[3]!, micro }
}
// Lua truthiness: only nil and false are false.
const truthy = (value: unknown) => value !== undefined && value !== null && value !== false
const isTable = (value: unknown): value is Json => typeof value === "object" && value !== null
const empty = (value: unknown) => isTable(value) && Object.keys(value).length === 0

export function spendScripts(store: SpendStore): [string, Script][] {
  const typed = (key: string, kind: SpendValue["kind"]) => {
    const value = store.read(key)
    return value === undefined || value.kind === kind
  }
  const get = (key: string) => {
    const value = store.read(key)
    return value?.kind === "string" ? value.value : undefined
  }
  const hget = (key: string, field: string) => {
    const value = store.read(key)
    return value?.kind === "hash" ? value.value.get(field) : undefined
  }
  const entries = (key: string) => {
    const value = store.read(key)
    return value?.kind === "hash" ? [...value.value] : []
  }
  const scores = (key: string) => {
    const value = store.read(key)
    return value?.kind === "zset" ? [...value.value].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)) : []
  }
  const exists = (key: string) => store.read(key) !== undefined
  const grow = (key: string, at: number, now: number) => {
    const ttl = store.pttl(key)
    if (ttl !== -1 && ttl < at - now && exists(key)) store.expireAt(key, at)
  }
  const runPoolFree = (key: string, pool: string) => {
    if (!typed(key, "string")) return false
    const previous = get(key)
    return previous === undefined || previous === pool
  }
  const bindRunPool = (key: string, pool: string, until: number, now: number) => {
    const fresh = !exists(key)
    store.setString(key, pool, true)
    if (fresh) store.expireAt(key, until)
    else grow(key, until, now)
  }

  // model_spend_read
  const spendRead = (
    ledgerKey: string,
    reservationsKey: string,
    heldKey: string,
    debitsKey: string,
    now: number | undefined,
    account: string,
    pool: string,
  ) => {
    if (
      now === undefined ||
      !typed(ledgerKey, "hash") ||
      !typed(reservationsKey, "hash") ||
      !typed(heldKey, "zset") ||
      !typed(debitsKey, "hash")
    )
      return undefined
    const genesis = object(hget(ledgerKey, "genesis"))
    const committed = integer(hget(ledgerKey, "committed"))
    const compacted = integer(hget(ledgerKey, "compacted"))
    const expectedReserved = integer(hget(ledgerKey, "reserved"))
    const expectedOpen = integer(hget(ledgerKey, "openCount"))
    if (
      !genesis ||
      genesis.v !== 1 ||
      genesis.account !== account ||
      genesis.pool !== pool ||
      typeof genesis.creation !== "string" ||
      typeof genesis.subscription !== "string" ||
      integer(genesis.start) === undefined ||
      integer(genesis.end) === undefined ||
      Number(genesis.end) <= Number(genesis.start) ||
      committed === undefined ||
      compacted === undefined ||
      expectedReserved === undefined ||
      expectedOpen === undefined
    )
      return undefined
    const records = new Map<string, Json>()
    let reserved: number | undefined = 0
    let abandoned: number | undefined = 0
    let done: number | undefined = compacted
    let openCount = 0
    let gcMicro: number | undefined = 0
    const gc: string[] = []
    for (const [ticket, raw] of entries(reservationsKey)) {
      const record = object(raw)
      if (record)
        for (const key of RECORD_NUMBERS) {
          if (record[key] === undefined) continue
          const value = integer(record[key])
          if (value === undefined) return undefined
          record[key] = value
        }
      const held = record && member(record.member)
      if (
        !record ||
        !held ||
        record.ticket !== ticket ||
        held.ticket !== record.ticket ||
        record.account !== account ||
        record.pool !== pool ||
        held.micro !== record.micro ||
        held.purpose !== record.purpose ||
        held.run !== (record.run ?? "-") ||
        typeof record.day !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(record.day) ||
        typeof record.deadline !== "number" ||
        typeof record.admittedAt !== "number" ||
        typeof record.periodEnd !== "number" ||
        typeof record.runUntil !== "number" ||
        typeof record.epoch !== "string" ||
        typeof record.version !== "number" ||
        record.group !== undefined
      )
        return undefined
      if (record.state === "open") {
        reserved = plus(reserved, held.micro)
        openCount++
        if (reserved === undefined) return undefined
        if (record.deadline <= now) {
          abandoned = plus(abandoned, held.micro)
          if (abandoned === undefined) return undefined
        }
      } else if (
        record.state === "done" &&
        typeof record.charge === "number" &&
        typeof record.gcAt === "number" &&
        record.gcAt >= record.deadline &&
        ["cancel", "complete", "broken"].includes(String(record.kind))
      ) {
        done = plus(done, record.charge)
        if (done === undefined) return undefined
        if (record.gcAt <= now) {
          gc.push(ticket)
          gcMicro = plus(gcMicro, record.charge)
          if (gcMicro === undefined) return undefined
        }
      } else return undefined
      records.set(ticket, record)
    }
    if (done !== committed || reserved !== expectedReserved || openCount !== expectedOpen) return undefined
    let applied: number | undefined = 0
    let pending: number | undefined = 0
    const debits: Json[] = []
    const debitHolds = new Set<string>()
    for (const [, raw] of entries(debitsKey)) {
      const debit = object(raw)
      const held = debit && member(debit.hold)
      if (
        !debit ||
        !held ||
        integer(debit.micro) === undefined ||
        typeof debit.applied !== "boolean" ||
        integer(debit.at) === undefined ||
        !PURPOSES.has(String(debit.purpose)) ||
        (debit.run !== undefined &&
          (typeof debit.run !== "string" ||
            debit.run.length > 128 ||
            !/^[A-Za-z0-9_.-]+$/.test(debit.run) ||
            debit.run === "-")) ||
        held.micro !== debit.micro ||
        held.purpose !== debit.purpose ||
        held.run !== (debit.run ?? "-")
      )
        return undefined
      if (debit.applied) applied = plus(applied, held.micro)
      else pending = plus(pending, held.micro)
      if (applied === undefined || pending === undefined) return undefined
      debitHolds.add(String(debit.hold))
      debits.push(debit)
    }
    let nonmodelHeld: number | undefined = 0
    const holds: NonNullable<ReturnType<typeof member>>[] = []
    for (const [raw, score] of scores(heldKey)) {
      const held = member(raw)
      if (!held || integer(score) === undefined) return undefined
      const record = records.get(held.ticket)
      if (record) {
        if (
          held.purpose !== record.purpose ||
          held.run !== (record.run ?? "-") ||
          (raw !== record.member && (record.state !== "done" || held.micro !== record.charge))
        )
          return undefined
      } else if (score > now) {
        nonmodelHeld = plus(nonmodelHeld, held.micro)
        if (nonmodelHeld === undefined) return undefined
        if (!debitHolds.has(raw)) holds.push(held)
      }
    }
    for (const debit of debits) {
      if (debit.applied) continue
      const value = store.read(heldKey)
      const score = integer(value?.kind === "zset" ? value.value.get(String(debit.hold)) : undefined)
      if (score === undefined || score <= now || records.has(member(debit.hold)!.ticket)) return undefined
    }
    return {
      genesis,
      committed,
      compacted,
      reserved,
      abandoned,
      openCount,
      nonmodelHeld,
      applied,
      pending,
      records,
      debits,
      holds,
      gc,
      gcMicro,
    }
  }
  type Spend = NonNullable<ReturnType<typeof spendRead>>

  const compact = (spend: Spend, ledgerKey: string, reservationsKey: string) => {
    if (!spend.gc.length) return
    const reservations = store.hash(reservationsKey)
    for (const ticket of spend.gc) reservations.delete(ticket)
    store.prune(reservationsKey)
    store.hash(ledgerKey).set("compacted", String(spend.compacted + spend.gcMicro))
  }

  // model_pool_fence
  const fence = (accountKey: string, entKey: string, f: unknown, spend: Spend) => {
    if (
      !isTable(f) ||
      typeof f.accountRecord !== "string" ||
      integer(f.now) === undefined ||
      integer(f.graceMs) === undefined ||
      integer(f.start) === undefined ||
      integer(f.end) === undefined ||
      integer(f.totalMicro) === undefined ||
      !typed(accountKey, "string") ||
      !typed(entKey, "string")
    )
      return "unavailable"
    if (get(accountKey) !== f.accountRecord) return "stale"
    const account = object(f.accountRecord)
    const key = account?.key
    if (!account || !isTable(key)) return "unavailable"
    const risk = account.risk
    if (
      truthy(account.closing) ||
      truthy(account.upgrade) ||
      truthy(account.keyCreation) ||
      truthy(account.transition) ||
      (truthy(account.ownerEnd) && !truthy((account.ownerEnd as Json).done)) ||
      truthy(key.provisioning) ||
      truthy(key.revoked) ||
      (truthy(risk) &&
        (!isTable(risk) ||
          risk.blocked !== false ||
          !isTable(risk.openDisputes) ||
          !empty(risk.openDisputes) ||
          !isTable(risk.efw) ||
          !empty(risk.efw)))
    )
      return "stale"
    const carry = key.carry
    const total = plus(
      integer(key.creditsMicro),
      carry === undefined ? 0 : isTable(carry) ? integer(carry.micro) : undefined,
    )
    const proof = key.spendGenesis
    if (
      !isTable(proof) ||
      proof.state !== "ready" ||
      proof.nonce !== spend.genesis.creation ||
      key.hash !== f.pool ||
      key.subscription !== f.subscription ||
      key.start !== f.start ||
      key.end !== f.end ||
      spend.genesis.subscription !== f.subscription ||
      spend.genesis.start !== f.start ||
      spend.genesis.end !== f.end ||
      total === undefined ||
      total !== f.totalMicro
    )
      return "unavailable"
    const snapshot = object(get(entKey))
    if (!snapshot) return "stale"
    if (snapshot.v !== 1 || snapshot.account !== f.account || snapshot.livemode !== f.livemode) return "unavailable"
    const now = Number(f.now)
    const periodStart = Number(snapshot.periodStart)
    const periodEnd = Number(snapshot.periodEnd)
    if (
      snapshot.subscription !== f.subscription ||
      snapshot.periodStart !== Number(f.start) * 1000 ||
      snapshot.periodEnd !== Number(f.end) * 1000 ||
      snapshot.meterEpoch !== `${String(f.subscription)}:${periodStart}` ||
      (f.version !== undefined && snapshot.version !== f.version) ||
      now < periodStart
    )
      return "stale"
    if (snapshot.state === "active") return now >= periodEnd ? "stale" : undefined
    if (snapshot.state !== "renewing" || now >= periodEnd + Number(f.graceMs)) return "stale"
    return undefined
  }

  return [
    [
      MODEL_SPEND_SCRIPTS.GENESIS,
      ([accountKey, ledgerKey, reservationsKey], [raw]) => {
        const input = object(raw)
        if (
          !input ||
          input.v !== 1 ||
          typeof input.account !== "string" ||
          typeof input.pool !== "string" ||
          typeof input.subscription !== "string" ||
          typeof input.creation !== "string" ||
          input.creation.length > 64 ||
          !/^[A-Za-z0-9-]+$/.test(input.creation) ||
          integer(input.start) === undefined ||
          integer(input.end) === undefined ||
          integer(Number(input.end) * 1000 + 3_456_000_000) === undefined ||
          Number(input.end) <= Number(input.start) ||
          !typed(accountKey!, "string") ||
          !typed(ledgerKey!, "hash") ||
          !typed(reservationsKey!, "hash")
        )
          return 0
        const accountRaw = get(accountKey!)
        const key = object(accountRaw)?.key
        const proof = isTable(key) ? key.spendGenesis : undefined
        if (
          !isTable(key) ||
          !isTable(proof) ||
          proof.nonce !== input.creation ||
          key.hash !== input.pool ||
          key.subscription !== input.subscription ||
          key.start !== input.start ||
          key.end !== input.end
        )
          return 0
        const existing = hget(ledgerKey!, "genesis")
        if (existing !== undefined) {
          const old = object(existing)
          return proof.state === "ready" &&
            old &&
            old.v === 1 &&
            old.account === input.account &&
            old.pool === input.pool &&
            old.creation === input.creation &&
            old.subscription === input.subscription &&
            old.start === input.start &&
            old.end === input.end &&
            ["committed", "compacted", "reserved", "openCount"].every(
              (field) => integer(hget(ledgerKey!, field)) !== undefined,
            )
            ? 1
            : 0
        }
        if (
          proof.state !== "pending" ||
          key.provisioning !== true ||
          truthy(key.revoked) ||
          exists(ledgerKey!) ||
          exists(reservationsKey!)
        )
          return 0
        const needle = `"spendGenesis":{"nonce":"${input.creation}","state":"pending"}`
        const first = accountRaw!.indexOf(needle)
        if (first < 0 || accountRaw!.indexOf(needle, first + needle.length) >= 0) return 0
        const ready = `"spendGenesis":{"nonce":"${input.creation}","state":"ready"}`
        const ledger = store.hash(ledgerKey!)
        for (const [field, value] of [
          ["genesis", raw!],
          ["committed", "0"],
          ["compacted", "0"],
          ["reserved", "0"],
          ["openCount", "0"],
        ] as const)
          ledger.set(field, value)
        store.expireAt(ledgerKey!, Number(input.end) * 1000 + 3_456_000_000)
        store.setString(
          accountKey!,
          accountRaw!.slice(0, first) + ready + accountRaw!.slice(first + needle.length),
        )
        return 1
      },
    ],
    [
      MODEL_SPEND_SCRIPTS.READ,
      ([ledgerKey, reservationsKey, heldKey, debitsKey], [now, account, pool]) => {
        const value = spendRead(ledgerKey!, reservationsKey!, heldKey!, debitsKey!, integer(now), account!, pool!)
        if (!value) return [-1]
        compact(value, ledgerKey!, reservationsKey!)
        return [value.committed, value.reserved, value.abandoned, value.nonmodelHeld, value.applied, value.pending]
      },
    ],
    [
      MODEL_SPEND_SCRIPTS.DAY,
      ([ledgerKey, reservationsKey, heldKey, debitsKey, dayKey], [rawNow, account, pool, day]) => {
        const now = integer(rawNow)
        const value = spendRead(ledgerKey!, reservationsKey!, heldKey!, debitsKey!, now, account!, pool!)
        if (!value || now === undefined || !typed(dayKey!, "hash")) return -1
        let daily = integer(hget(dayKey!, "total") ?? "0")
        for (const record of value.records.values())
          if (record.state === "open" && record.day === day && Number(record.deadline) <= now)
            daily = plus(daily, Number(record.micro))
        for (const held of value.holds) daily = plus(daily, held.micro)
        const dayStart = now - (now % 86_400_000)
        for (const debit of value.debits)
          if (Number(debit.at) >= dayStart && Number(debit.at) < dayStart + 86_400_000)
            daily = plus(daily, Number(debit.micro))
        return daily ?? -1
      },
    ],
    [
      POOL_SCRIPTS.HOLD,
      ([heldKey, debitsKey, ledgerKey, reservationsKey, runKey, accountKey, entKey], [raw]) => {
        const p = object(raw)
        const f = p?.fence
        const now = integer(p?.now)
        if (
          !p ||
          !isTable(f) ||
          now === undefined ||
          f.now !== now ||
          f.pool !== p.pool ||
          f.account !== p.account ||
          !integer(p.required) ||
          integer(p.deadline) === undefined ||
          Number(p.deadline) <= now ||
          !integer(p.ttl) ||
          integer(p.observedMicro) === undefined ||
          typeof p.member !== "string" ||
          (p.run !== undefined && typeof p.run !== "string")
        )
          return "unavailable"
        const parsed = member(p.member)
        if (!parsed || parsed.micro !== p.required || parsed.run !== (p.run ?? "-")) return "unavailable"
        const spend = spendRead(ledgerKey!, reservationsKey!, heldKey!, debitsKey!, now, String(p.account), String(p.pool))
        if (!spend || spend.records.has(parsed.ticket)) return "unavailable"
        const refusal = fence(accountKey!, entKey!, f, spend)
        if (refusal) return refusal
        if (p.run !== undefined && !runPoolFree(runKey!, String(p.pool))) return "runexpired"
        const burden = plus(
          plus(plus(Math.max(Number(p.observedMicro), spend.committed), spend.reserved), spend.nonmodelHeld),
          spend.applied,
        )
        if (burden === undefined) return "unavailable"
        if (Number(f.totalMicro) - burden < Number(p.required)) return "monthly"
        compact(spend, ledgerKey!, reservationsKey!)
        const held = store.zset(heldKey!)
        for (const [value, at] of held) if (at <= now) held.delete(value)
        const fresh = held.size === 0
        held.set(p.member, Number(p.deadline))
        if (fresh) store.expireAt(heldKey!, now + Number(p.ttl))
        else grow(heldKey!, now + Number(p.ttl), now)
        if (p.run !== undefined)
          bindRunPool(runKey!, String(p.pool), Math.max(now + 259_200_000, Number(p.deadline)), now)
        return "ok"
      },
    ],
  ]
}

/**
 * The ledger fields of a pool whose key was created fresh, as GENESIS leaves them (the account's key then carries
 * `spendGenesis: {nonce, state: "ready"}`). `committedMicro` seeds a committed floor whose done records were already
 * compacted away, which is a state real settlements reach after their records expire.
 */
export function readyGenesisFields(input: {
  account: string
  pool: string
  subscription: string
  start: number
  end: number
  nonce: string
  committedMicro?: number
}) {
  const committed = String(input.committedMicro ?? 0)
  return [
    [
      "genesis",
      JSON.stringify({
        v: 1,
        account: input.account,
        pool: input.pool,
        subscription: input.subscription,
        start: input.start,
        end: input.end,
        creation: input.nonce,
      }),
    ],
    ["committed", committed],
    ["compacted", committed],
    ["reserved", "0"],
    ["openCount", "0"],
  ] as const
}
