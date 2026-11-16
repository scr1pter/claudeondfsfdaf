import { ApiError } from "../http.js"
import { ACCOUNT_ID_PATTERN } from "../../../packages/schema/src/everywhere.js"
import { everywhereKeys } from "./keys.js"
import { ACCOUNT_TOMBSTONE_KEY, AUTHORITY_MARKER } from "./authority-format.js"
import { getValue, runScript, type Store } from "./store.js"

/** Supplied by the trusted account-deletion adapter. Never accept a key or readiness assertion from a request. */
export type AccountAuthorityPort = (account: string) => Promise<{ readonly tombstoneKey: string } | undefined>
export const missingAccountAuthority: AccountAuthorityPort = async () => undefined
export type AuthorityContext = { readonly store: Store; readonly accountAuthority?: AccountAuthorityPort }
export type AuthorityGuard = { readonly key: string; readonly value?: string }

export function authorityChanged() { return new ApiError(409, "EVERYWHERE_AUTHORITY_CHANGED", "The connection or account changed. Try again.") }
export function accountUnavailable() { return new ApiError(503, "EVERYWHERE_ACCOUNT_UNVERIFIED", "Account status could not be verified. Try again later.") }
export function withAccountAuthority(store: Store, accountAuthority: AccountAuthorityPort): Store {
  return Object.assign((command: Parameters<Store>[0]) => store(command), { accountAuthority })
}

/** A missing adapter is unavailable. Any upstream tombstone bytes, including malformed values, close admission. */
export async function accountGuards(ctx: AuthorityContext, account: string): Promise<readonly AuthorityGuard[]> {
  if (!ACCOUNT_ID_PATTERN.test(account)) throw accountUnavailable()
  const owner = account.toLowerCase()
  if (await getValue(ctx.store, everywhereKeys.accountClosed(owner)) !== undefined) throw authorityChanged()
  const provider = ctx.accountAuthority ?? ctx.store.accountAuthority ?? missingAccountAuthority
  const authority = await provider(owner)
  if (!authority || !ACCOUNT_TOMBSTONE_KEY.test(authority.tombstoneKey) || !authority.tombstoneKey.endsWith(`:${owner}`)) throw accountUnavailable()
  return [{ key: everywhereKeys.accountClosed(owner) }, { key: authority.tombstoneKey }]
}
export async function checkAccount(ctx: AuthorityContext, account: string) {
  for (const guard of await accountGuards(ctx, account)) if (await getValue(ctx.store, guard.key) !== undefined) throw authorityChanged()
}

/** Guard keys/values are appended, then hidden from the original source-owned program's KEYS/ARGV tables. */
export const AUTHORITY_PREFIX = AUTHORITY_MARKER + [
  "local kc = tonumber(ARGV[#ARGV - 2]) local ac = tonumber(ARGV[#ARGV - 1]) local gc = tonumber(ARGV[#ARGV])",
  "for i = 1, gc do local v = redis.call('GET', KEYS[kc + i]) local at = ac + (i - 1) * 2",
  "if (ARGV[at + 1] == 'missing' and v ~= false) or (ARGV[at + 1] == 'exact' and v ~= ARGV[at + 2]) then return {'ve:authority-changed', i} end end",
  "local originalKeys = {} for i = 1, kc do originalKeys[i] = KEYS[i] end",
  "local originalArgs = {} for i = 1, ac do originalArgs[i] = ARGV[i] end",
  "local KEYS = originalKeys local ARGV = originalArgs",
].join(" ") + " "

export async function authorizedScript(store: Store, guards: readonly AuthorityGuard[], script: string, keys: readonly string[], args: readonly (string | number)[]) {
  if (!guards.length || guards.length > 24) throw new RangeError("Invalid authority proof")
  const result = await runScript(store, AUTHORITY_PREFIX + script, [...keys, ...guards.map((guard) => guard.key)],
    [...args, ...guards.flatMap((guard) => [guard.value === undefined ? "missing" : "exact", guard.value ?? ""]), keys.length, args.length, guards.length])
  if (Array.isArray(result) && result[0] === "ve:authority-changed") throw authorityChanged()
  return result
}

/** Internal commands only; the program is fixed and accepts no Lua or command name from an HTTP body. */
export const ATOMIC_COMMANDS_SCRIPT = [
  "local operations = cjson.decode(ARGV[1]) local kinds = {SET='string', SADD='set', SREM='set', ZADD='zset', ZREM='zset'}",
  "for _, operation in ipairs(operations) do local wanted = kinds[operation[1]] if wanted then local actual = redis.call('TYPE', operation[2]) if type(actual) == 'table' then actual = actual.ok end if actual ~= 'none' and actual ~= wanted then return redis.error_reply('WRONGTYPE everywhere preflight') end end end",
  "local result = {} for i, operation in ipairs(operations) do result[i] = redis.call(unpack(operation)) end return result",
].join(" ")
export async function authorizedCommands(store: Store, guards: readonly AuthorityGuard[], commands: readonly (readonly (string | number)[])[]) {
  if (!commands.length || commands.length > 32) throw new RangeError("Invalid atomic write")
  const allowed = new Set(["SET", "DEL", "SADD", "SREM", "ZADD", "ZREM", "PEXPIRE"])
  if (commands.some((command) => !allowed.has(String(command[0])))) throw new RangeError("Invalid atomic write")
  const keys = [...new Set(commands.flatMap((command) => command[0] === "DEL" ? command.slice(1).map(String) : [String(command[1])]))]
  return authorizedScript(store, guards, ATOMIC_COMMANDS_SCRIPT, keys, [JSON.stringify(commands)])
}

/** Cleanup reuses existing programs, but every mutation still proves its exact durable closing generation. */
export function fencedStore(store: Store, guards: readonly AuthorityGuard[]): Store {
  return Object.assign(async (command: Parameters<Store>[0]) => {
    if (command[0] !== "EVAL") {
      if (["GET", "MGET", "EXISTS", "SMEMBERS", "SISMEMBER", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZCARD", "ZSCORE", "PTTL"].includes(String(command[0]))) return store(command)
      return authorizedCommands(store, guards, [command]).then((result) => Array.isArray(result) ? result[0] : result)
    }
    const count = Number(command[2])
    let program = String(command[1])
    let keys = command.slice(3, 3 + count).map(String)
    let args = command.slice(3 + count)
    const proofs: AuthorityGuard[] = [...guards]
    // Flatten only our exact source-owned wrapper. A base program never gains access to sibling guard keys.
    while (program.startsWith(AUTHORITY_PREFIX)) {
      const kc = Number(args.at(-3)), ac = Number(args.at(-2)), gc = Number(args.at(-1))
      if (!Number.isSafeInteger(kc) || !Number.isSafeInteger(ac) || !Number.isSafeInteger(gc) || gc < 1 || keys.length !== kc + gc || args.length !== ac + gc * 2 + 3) throw authorityChanged()
      proofs.push(...keys.slice(kc).map((key, index) => ({ key, ...(args[ac + index * 2] === "exact" ? { value: String(args[ac + index * 2 + 1]) } : {}) })))
      program = program.slice(AUTHORITY_PREFIX.length)
      keys = keys.slice(0, kc); args = args.slice(0, ac)
    }
    return authorizedScript(store, proofs, program, keys, args)
  }, { accountAuthority: store.accountAuthority })
}
