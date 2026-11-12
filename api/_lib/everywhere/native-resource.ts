import { luaKeyTypes } from "./lua.js"
import { JOB_ID_PATTERN } from "../../../packages/schema/src/everywhere.js"
import { runScript, storeInteger, storeUnavailable, type Store } from "./store.js"

/** Replace only a terminal job's observed native owner. The new pending owner and its short expiry are inseparable. */
export const REPLACE_NATIVE_RESERVATION_SCRIPT = luaKeyTypes(["string"]) + [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2], 'PX', 30000) return 1",
].join(" ")

export async function replaceNativeReservation(store: Store, key: string, previous: string, owner: string) {
  if (!JOB_ID_PATTERN.test(previous) || !JOB_ID_PATTERN.test(owner) || previous === owner) throw new RangeError("Invalid native reservation")
  const result = storeInteger(await runScript(store, REPLACE_NATIVE_RESERVATION_SCRIPT, [key], [previous, owner]))
  if (result !== 0 && result !== 1) throw storeUnavailable()
  return result === 1
}
