/** Fixed source-owned declaration: Redis Lua runtime errors do not roll back earlier writes. */
export type LuaKeyType = "string" | "counter" | "set" | "zset"
export const KEY_TYPES_MARKER = "-- vector-everywhere-key-types:"
export function luaKeyTypes(kinds: readonly LuaKeyType[]): string {
  return KEY_TYPES_MARKER + JSON.stringify(kinds) + "\n" +
    "local kinds = cjson.decode('" + JSON.stringify(kinds) + "') " +
    "for i, expected in ipairs(kinds) do if KEYS[i] then local actual = redis.call('TYPE', KEYS[i]) if type(actual) == 'table' then actual = actual.ok end " +
    "local wanted = expected == 'counter' and 'string' or expected if actual ~= 'none' and actual ~= wanted then return redis.error_reply('WRONGTYPE everywhere preflight') end " +
    "if expected == 'counter' and actual == 'string' then local value = redis.call('GET', KEYS[i]) if value ~= '0' and not string.match(value, '^[1-9]%d*$') then return redis.error_reply('Invalid everywhere counter') end end end end "
}
