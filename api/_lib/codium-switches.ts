import { randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { codiumKey } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

export const SWITCH_NAMES = ["sales", "codium", "cloudAgents", "hosted", "ops", "remote", "vault", "push"] as const
export type SwitchName = (typeof SWITCH_NAMES)[number]
/** `hosted` alone also takes `no-new` (no new work) and `stop` (running work stops too). */
export type SwitchValue = "on" | "off" | "no-new" | "stop"
const VALUES: Record<SwitchName, readonly SwitchValue[]> = {
  sales: ["on", "off"],
  codium: ["on", "off"],
  cloudAgents: ["on", "off"],
  hosted: ["on", "no-new", "stop"],
  ops: ["on", "off"],
  remote: ["on", "off"],
  vault: ["on", "off"],
  push: ["on", "off"],
}
export const switchKey = (name: SwitchName) => codiumKey("switch", name)
export const switchAuditKey = () => codiumKey("switch", "audit")
export const disabledSetKey = (name: "models-off" | "perks-off") => codiumKey(name)
export const SWITCH_CACHE_MS = 30_000
const AUDIT_KEEP_MS = 90 * 86_400_000
const Stored = Schema.Struct({
  value: Schema.String,
  changedAt: Schema.optional(Schema.Number),
  generation: Schema.optional(Schema.String),
  offSince: Schema.optional(Schema.Number),
})
export type SwitchState = { value: SwitchValue; changedAt: number; generation: string; offSince?: number }
type ReadOptions = { fresh?: boolean; now?: number }
// Fetcher identity keeps independent local services and modes from sharing cached configuration.
const cache = new WeakMap<typeof fetch, Map<string, { until: number; value: SwitchState | readonly string[] }>>()

const WRITE = [
  "local raw = redis.call('GET', KEYS[1]) local previous = 'on' local old = nil",
  "if raw then local ok, parsed = pcall(cjson.decode, raw) if ok and type(parsed) == 'table' then old = parsed previous = parsed.value else previous = raw end end",
  "if previous == ARGV[1] and old and old.generation and old.changedAt then return {raw, 0} end",
  "local record = cjson.decode(ARGV[2])",
  "if record.value == 'off' and previous == 'off' and old and old.offSince then record.offSince = old.offSince end",
  "local saved = cjson.encode(record) local audit = cjson.decode(ARGV[3]) audit.previous = previous",
  "redis.call('SET', KEYS[1], saved) redis.call('ZADD', KEYS[2], ARGV[4], cjson.encode(audit))",
  "redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5]) redis.call('PEXPIRE', KEYS[2], ARGV[6]) return {saved, 1}",
].join(" ")
const DISABLE = [
  "local changed = 0 if ARGV[2] == '1' then changed = redis.call('SADD', KEYS[1], ARGV[1]) else changed = redis.call('SREM', KEYS[1], ARGV[1]) end",
  "if changed == 1 then redis.call('ZADD', KEYS[2], ARGV[4], ARGV[3]) redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5]) redis.call('PEXPIRE', KEYS[2], ARGV[6]) end return changed",
].join(" ")
const ESCALATE_HOSTED = [
  "local raw = redis.call('GET', KEYS[1]) local previous = 'on' local old = nil",
  "if raw then local ok, parsed = pcall(cjson.decode, raw) if ok and type(parsed) == 'table' then old = parsed previous = parsed.value else previous = string.gsub(string.gsub(raw, '^%s+', ''), '%s+$', '') end end",
  "local ranks = {on = 0, ['no-new'] = 1, stop = 2} local rank = ranks[previous] local nextRank = ranks[ARGV[1]]",
  "if not rank or not nextRank then return {'', -1} end",
  "if old then for _, field in ipairs({'changedAt', 'offSince'}) do local at = old[field] if at ~= nil and (type(at) ~= 'number' or at < 0 or at > 9007199254740991 or at ~= math.floor(at)) then return {'', -1} end end if old.generation ~= nil and (type(old.generation) ~= 'string' or old.generation == '') then return {'', -1} end end",
  "if rank >= nextRank then return {raw, 0} end",
  "local record = cjson.decode(ARGV[2]) local audit = cjson.decode(ARGV[3]) audit.previous = previous",
  "local saved = cjson.encode(record) redis.call('SET', KEYS[1], saved) redis.call('ZADD', KEYS[2], ARGV[4], cjson.encode(audit))",
  "redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5]) redis.call('PEXPIRE', KEYS[2], ARGV[6]) return {saved, 1}",
].join(" ")
export const SWITCH_SCRIPTS = { WRITE, DISABLE, ESCALATE_HOSTED } as const

/** A missing switch is on. Corrupt configuration fails closed; financial mutations bypass the 30-second cache. */
export async function readSwitchState(
  name: SwitchName,
  fetcher: typeof fetch = fetch,
  options: ReadOptions = {},
): Promise<SwitchState> {
  const key = switchKey(name)
  const now = options.now ?? Date.now()
  const saved = cache.get(fetcher)?.get(key)
  if (!options.fresh && saved && saved.until > now) return saved.value as SwitchState
  const stored = await persistentStore(["GET", key], fetcher)
  const state = decode(name, stored)
  remember(fetcher, key, state, now)
  return state
}
export async function readSwitch(
  name: SwitchName,
  fetcher: typeof fetch = fetch,
  options: ReadOptions = {},
): Promise<SwitchValue> {
  return (await readSwitchState(name, fetcher, options)).value
}

/** Changes state and appends its audit record atomically. A no-op does not reset the service-off clock. */
export async function writeSwitch(
  name: SwitchName,
  value: SwitchValue,
  actor: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (
    !SWITCH_NAMES.includes(name) ||
    !VALUES[name].includes(value) ||
    !validActor(actor) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new ApiError(400, "CODIUM_SWITCH_INVALID", "Choose an available Codium setting.")
  const generation = randomUUID()
  const state: SwitchState = { value, changedAt: now, generation, ...(value === "off" ? { offSince: now } : {}) }
  const result = await persistentStore(
    [
      "EVAL",
      WRITE,
      2,
      switchKey(name),
      switchAuditKey(),
      value,
      JSON.stringify(state),
      JSON.stringify({ id: generation, at: now, actor, name, value }),
      now,
      now - AUDIT_KEEP_MS,
      AUDIT_KEEP_MS,
    ],
    fetcher,
  )
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    typeof result[0] !== "string" ||
    ![0, 1].includes(Number(result[1]))
  )
    throw unavailable()
  const saved = decode(name, result[0])
  remember(fetcher, switchKey(name), saved, now)
  return { ...saved, changed: Number(result[1]) === 1 }
}

/** Signed spend callbacks may only strengthen the actual hosted guard; the comparison and audit share one script. */
export async function escalateHostedSwitch(
  value: "no-new" | "stop",
  actor: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!["no-new", "stop"].includes(value) || !validActor(actor) || !Number.isSafeInteger(now) || now < 0)
    throw new ApiError(400, "CODIUM_SWITCH_INVALID", "Choose an available Codium setting.")
  const generation = randomUUID()
  const state: SwitchState = { value, changedAt: now, generation }
  const result = await persistentStore(
    [
      "EVAL",
      ESCALATE_HOSTED,
      2,
      switchKey("hosted"),
      switchAuditKey(),
      value,
      JSON.stringify(state),
      JSON.stringify({ id: generation, at: now, actor, name: "hosted", value }),
      now,
      now - AUDIT_KEEP_MS,
      AUDIT_KEEP_MS,
    ],
    fetcher,
  )
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    typeof result[0] !== "string" ||
    ![0, 1].includes(Number(result[1]))
  )
    throw unavailable()
  const saved = decode("hosted", result[0])
  // An earlier Lua response can arrive after a stronger concurrent write. Never cache its older state.
  cache.get(fetcher)?.delete(switchKey("hosted"))
  return { ...saved, changed: Number(result[1]) === 1 }
}

/** Per-model and per-perk kill sets are private server controls, independent of the configured catalog/listing. */
export async function readDisabledSet(
  name: "models-off" | "perks-off",
  fetcher: typeof fetch = fetch,
  options: ReadOptions = {},
) {
  const key = disabledSetKey(name)
  const now = options.now ?? Date.now()
  const saved = cache.get(fetcher)?.get(key)
  if (!options.fresh && saved && saved.until > now) return new Set(saved.value as readonly string[])
  const raw = await persistentStore(["SMEMBERS", key], fetcher)
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string" || !validItem(value))) throw unavailable()
  remember(fetcher, key, raw as string[], now)
  return new Set(raw as string[])
}
export async function writeDisabledItem(
  name: "models-off" | "perks-off",
  id: string,
  disabled: boolean,
  actor: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (
    !["models-off", "perks-off"].includes(name) ||
    !validItem(id) ||
    !validActor(actor) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new ApiError(400, "CODIUM_SWITCH_INVALID", "Choose an available Codium setting.")
  const changed = await persistentStore(
    [
      "EVAL",
      DISABLE,
      2,
      disabledSetKey(name),
      switchAuditKey(),
      id,
      disabled ? 1 : 0,
      JSON.stringify({ id: randomUUID(), at: now, actor, name, item: id, disabled }),
      now,
      now - AUDIT_KEEP_MS,
      AUDIT_KEEP_MS,
    ],
    fetcher,
  )
  if (changed !== 0 && changed !== 1) throw unavailable()
  cache.get(fetcher)?.delete(disabledSetKey(name))
  return { changed: changed === 1 }
}

function decode(name: SwitchName, stored: unknown): SwitchState {
  if (stored === null || stored === undefined) return { value: "on", changedAt: 0, generation: "default" }
  const raw = String(stored)
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Stored))(raw))
  const value = parsed?.value ?? raw.trim()
  const known = VALUES[name].find((allowed) => allowed === value)
  if (
    !known ||
    (known === "off" && parsed?.generation !== undefined && parsed.offSince === undefined) ||
    (parsed &&
      ([parsed.changedAt, parsed.offSince].some((at) => at !== undefined && (!Number.isSafeInteger(at) || at < 0)) ||
        (parsed.generation !== undefined && !parsed.generation)))
  )
    throw unavailable()
  return {
    value: known,
    changedAt: parsed?.changedAt ?? 0,
    generation: parsed?.generation ?? "legacy",
    ...(parsed?.offSince === undefined ? {} : { offSince: parsed.offSince }),
  }
}
function remember(fetcher: typeof fetch, key: string, value: SwitchState | readonly string[], now: number) {
  const values = cache.get(fetcher) ?? new Map()
  values.set(key, { until: now + SWITCH_CACHE_MS, value })
  cache.set(fetcher, values)
}
const validItem = (value: string) => /^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,199}$/.test(value)
const validActor = (value: string) => /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)
function unavailable() {
  return new ApiError(503, "CODIUM_SWITCH_UNAVAILABLE", "A Vector Codium setting could not be read.")
}
