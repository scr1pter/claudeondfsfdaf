import { codiumKey } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/** Deferred paid allowance is still owed while a provider key's fraud ramp withholds it. Amounts stay private. */
export const rampOwedKey = () => codiumKey("funding", "ramp-owed")
export const rampVersionKey = () => codiumKey("funding", "ramp-version")
const WRITE = [
  "local previous = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')",
  "local value = tonumber(ARGV[2])",
  "if ARGV[3] == 'raise' then value = math.max(previous, value) end",
  "if value == 0 then redis.call('HDEL', KEYS[1], ARGV[1]) else redis.call('HSET', KEYS[1], ARGV[1], tostring(value)) end",
  "if value ~= previous then redis.call('INCR', KEYS[2]) end",
  "return value",
].join(" ")
const READ = "return {redis.call('GET', KEYS[2]) or '0', redis.call('HGETALL', KEYS[1])}"
export const RAMP_SCRIPTS = { WRITE, READ } as const

/** Raise before provisioning; lower only after the provider limit has converged. */
export async function writeRampOwed(
  account: string,
  micro: number,
  fetcher: typeof fetch,
  mode: "raise" | "set" = "set",
) {
  if (!Number.isSafeInteger(micro) || micro < 0) throw unavailable()
  const result = await persistentStore(
    ["EVAL", WRITE, 2, rampOwedKey(), rampVersionKey(), account, Math.ceil(micro / 10_000), mode],
    fetcher,
  )
  if (!Number.isSafeInteger(result) || Number(result) < 0) throw unavailable()
}

export async function rampVersion(fetcher: typeof fetch) {
  const value = await persistentStore(["GET", rampVersionKey()], fetcher)
  const version = value === null ? "0" : String(value)
  if (!/^\d+$/.test(version) || !Number.isSafeInteger(Number(version))) throw unavailable()
  return version
}

/** A release moving allowance from the index onto a key must not produce a mixed, understated funding reading. */
export async function rampOwedCents(before: string, fetcher: typeof fetch) {
  const result = await persistentStore(["EVAL", READ, 2, rampOwedKey(), rampVersionKey()], fetcher)
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    String(result[0]) !== before ||
    !Array.isArray(result[1]) ||
    result[1].length % 2 ||
    result[1].length > 100_000
  )
    throw unavailable()
  const entries: unknown[] = result[1]
  const amounts = entries.filter((_, index) => index % 2).map(Number)
  if (amounts.some((value) => !Number.isSafeInteger(value) || value < 0)) throw unavailable()
  const total = amounts.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(total)) throw unavailable()
  return total
}

function unavailable() {
  return new ApiError(503, "CODIUM_RAMP_UNAVAILABLE", "Deferred model allowance could not be verified.")
}
