import { luaKeyTypes } from "./lua.js"
import { ApiError } from "../http.js"
import type { AccountAuthorityPort } from "./authority.js"
import { persistentStore } from "../persistent-store.js"
import { isEverywhereKey } from "./keys.js"
import { ACCOUNT_TOMBSTONE_KEY, AUTHORITY_MARKER } from "./authority-format.js"

/*
 * The store Vector everywhere talks to: `persistentStore` (the Redis REST API, failing closed) with a guard that lets
 * a command touch only `vector:everywhere:` keys, and small typed helpers that refuse any answer of the wrong shape.
 * Values are never logged. Atomic multi-step changes are Lua scripts sent with EVAL; each module exports its scripts
 * so the test fakes can recognise them.
 */

export type StoreCommand = readonly (string | number)[]
/** Sends one command and answers its result. Throws an ApiError (503) when the store cannot answer. */
export type Store = ((command: StoreCommand) => Promise<unknown>) & { readonly accountAuthority?: AccountAuthorityPort }

/** Where each command's keys are: their positions, or "all" after the command name, or "eval". */
const KEY_POSITIONS: Readonly<Record<string, readonly number[] | "all" | "eval">> = {
  GET: [1],
  /** Reads and deletes in one step: single-use codes and OAuth states (VE-04). */
  GETDEL: [1],
  SET: [1],
  DEL: "all",
  EXISTS: "all",
  MGET: "all",
  INCR: [1],
  PEXPIRE: [1],
  PTTL: [1],
  SADD: [1],
  SREM: [1],
  SMEMBERS: [1],
  SISMEMBER: [1],
  ZADD: [1],
  ZREM: [1],
  ZCARD: [1],
  ZSCORE: [1],
  ZRANGE: [1],
  ZREVRANGE: [1],
  ZRANGEBYSCORE: [1],
  ZREMRANGEBYSCORE: [1],
  EVAL: "eval",
}

/** The keys a command touches, or undefined for a command the guard does not know. */
export function commandKeys(command: StoreCommand): string[] | undefined {
  const name = typeof command[0] === "string" ? command[0].toUpperCase() : undefined
  const positions = name === undefined ? undefined : KEY_POSITIONS[name]
  if (!positions) return undefined
  if (positions === "all") return command.slice(1).map(String)
  if (positions === "eval") {
    const count = Number(command[2])
    if (!Number.isSafeInteger(count) || count < 0 || command.length < 3 + count) return undefined
    return command.slice(3, 3 + count).map(String)
  }
  if (positions.some((position) => position >= command.length)) return undefined
  return positions.map((position) => String(command[position]))
}

function refused(): never {
  throw new ApiError(500, "EVERYWHERE_STORE_REFUSED", "Vector everywhere could not complete this request.")
}

/** The store, over `persistentStore`. Every command must name only Vector everywhere keys. */
export function everywhereStore(fetcher: typeof fetch = fetch, accountAuthority?: AccountAuthorityPort): Store {
  return Object.assign((command: StoreCommand) => {
    const keys = commandKeys(command)
    if (!keys || !keys.length) refused()
    if (!keys.every((key): boolean => isEverywhereKey(key))) {
      // The sibling key is read-only and is never exposed to a base mutation program or HTTP caller.
      const read = command[0] === "GET" && keys.length === 1 && ACCOUNT_TOMBSTONE_KEY.test(keys[0]!)
      const args = command.slice(3 + Number(command[2]))
      const kc = Number(args.at(-3)), ac = Number(args.at(-2)), gc = Number(args.at(-1))
      const guarded = command[0] === "EVAL" && typeof command[1] === "string" && command[1].startsWith(AUTHORITY_MARKER) &&
        Number.isSafeInteger(kc) && Number.isSafeInteger(ac) && Number.isSafeInteger(gc) && gc > 0 && gc <= 24 && kc >= 0 && ac >= 0 &&
        keys.length === kc + gc && args.length === ac + gc * 2 + 3 && keys.slice(0, kc).every((key) => isEverywhereKey(key)) &&
        keys.slice(kc).every((key, index) => isEverywhereKey(key) || ACCOUNT_TOMBSTONE_KEY.test(key) && args[ac + index * 2] === "missing")
      if (!read && !guarded) refused()
    }
    return persistentStore(command, fetcher)
  }, { accountAuthority })
}

export function storeUnavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected account services are temporarily unavailable.")
}

function checkTtl(ttlMs: number | undefined) {
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) throw new RangeError("A TTL is whole ms.")
}

/** A string value, or undefined when there is none. */
export async function getValue(store: Store, key: string): Promise<string | undefined> {
  const value = await store(["GET", key])
  if (value === null || value === undefined) return undefined
  if (typeof value !== "string") throw storeUnavailable()
  return value
}

export type SetOptions = {
  /** Expiry in milliseconds; omitted only for records kept until they are changed or erased (3.13). */
  readonly ttlMs?: number
  /** Only when the key does not exist yet. */
  readonly onlyNew?: boolean
  /** Only when the key exists already. */
  readonly onlyExisting?: boolean
}

/** Sets a string value. Answers false when `onlyNew` or `onlyExisting` stopped it. */
export async function setValue(store: Store, key: string, value: string, options: SetOptions = {}): Promise<boolean> {
  checkTtl(options.ttlMs)
  if (options.onlyNew && options.onlyExisting) throw new RangeError("Choose onlyNew or onlyExisting.")
  const command: (string | number)[] = ["SET", key, value]
  if (options.ttlMs !== undefined) command.push("PX", options.ttlMs)
  if (options.onlyNew) command.push("NX")
  if (options.onlyExisting) command.push("XX")
  const result = await store(command)
  if (result === "OK") return true
  if (result === null || result === undefined) {
    if (options.onlyNew || options.onlyExisting) return false
  }
  throw storeUnavailable()
}

/** Deletes keys; answers how many existed. */
export async function deleteKeys(store: Store, ...keys: readonly string[]): Promise<number> {
  if (!keys.length) return 0
  const count = storeInteger(await store(["DEL", ...keys]))
  if (count < 0) throw storeUnavailable()
  return count
}

/** A JSON value passed through `decode`; a stored value that does not parse or decode means the store is unwell. */
export async function getJson<T>(store: Store, key: string, decode: (value: unknown) => T | undefined) {
  const raw = await getValue(store, key)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw storeUnavailable()
  }
  const value = decode(parsed)
  if (value === undefined) throw storeUnavailable()
  return value
}

export async function setJson(store: Store, key: string, value: unknown, options: SetOptions = {}) {
  const text = JSON.stringify(value)
  if (typeof text !== "string") throw new TypeError("Only JSON values can be stored.")
  return setValue(store, key, text, options)
}

/** Reads and deletes a string value in one step, so only one caller ever gets it (VE-04 codes and states). */
export async function takeValue(store: Store, key: string): Promise<string | undefined> {
  const value = await store(["GETDEL", key])
  if (value === null || value === undefined) return undefined
  if (typeof value !== "string") throw storeUnavailable()
  return value
}

/**
 * Reads, deletes and decodes a JSON value in one step. A value that does not parse or decode is gone all the same and
 * answers undefined, so a damaged single-use record can never be used.
 */
export async function takeJson<T>(store: Store, key: string, decode: (value: unknown) => T | undefined) {
  const raw = await takeValue(store, key)
  if (raw === undefined) return undefined
  try {
    return decode(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** The members of a set, as strings. */
export async function setMembers(store: Store, key: string): Promise<string[]> {
  const value = await store(["SMEMBERS", key])
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw storeUnavailable()
  return value.filter((member): member is string => typeof member === "string")
}

/**
 * Changes a value only while the key still holds exactly `ARGV[1]` (an empty string for "no value"), in one step, so
 * two writers that read the same old value cannot both win. An empty `ARGV[2]` deletes the key instead. The records
 * this is used for are kept until changed (3.13), so the value is written with no expiry. KEYS: the key. ARGV:
 * expected, next. Answers 1 or 0.
 */
export const SWAP_SCRIPT = luaKeyTypes(["string"]) + [
  "local current = redis.call('GET', KEYS[1])",
  "if (current == false and ARGV[1] == '') or current == ARGV[1] then",
  "if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end return 1 end",
  "return 0",
].join(" ")

/**
 * Replaces `expected` (undefined for "no value yet") with `next` (undefined to delete). Answers false when someone
 * else changed the value first, and the caller reads it again.
 */
export async function swapValue(
  store: Store,
  key: string,
  expected: string | undefined,
  next: string | undefined,
): Promise<boolean> {
  if (expected === "" || next === "") throw new RangeError("An empty value cannot be swapped.")
  const result = storeInteger(await runScript(store, SWAP_SCRIPT, [key], [expected ?? "", next ?? ""]))
  if (result !== 0 && result !== 1) throw storeUnavailable()
  return result === 1
}

/** Adds members to a set. */
export async function addMembers(store: Store, key: string, ...members: readonly string[]): Promise<void> {
  if (!members.length) return
  const added = storeInteger(await store(["SADD", key, ...members]))
  if (added < 0) throw storeUnavailable()
}

/** Removes members from a set. */
export async function removeMembers(store: Store, key: string, ...members: readonly string[]): Promise<void> {
  if (!members.length) return
  const removed = storeInteger(await store(["SREM", key, ...members]))
  if (removed < 0) throw storeUnavailable()
}

/** Runs a Lua script with its keys and arguments. */
export function runScript(
  store: Store,
  script: string,
  keys: readonly string[],
  args: readonly (string | number)[],
): Promise<unknown> {
  return store(["EVAL", script, keys.length, ...keys, ...args])
}

/** A whole number from a store answer (Redis sends integers as numbers, REST bridges sometimes as strings). */
export function storeInteger(value: unknown): number {
  const number =
    typeof value === "number" ? value : typeof value === "string" && /^-?[0-9]{1,16}$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(number)) throw storeUnavailable()
  return number
}

/**
 * A cooldown deadline read with ZSCORE: no score is 0. Native Redis may answer a number and REST bridges a string;
 * anything else, or a negative deadline, is a store fault rather than a cooldown.
 */
export function storeScore(value: unknown): number {
  if (value === null || value === undefined) return 0
  const at = storeInteger(value)
  if (at < 0) throw storeUnavailable()
  return at
}
