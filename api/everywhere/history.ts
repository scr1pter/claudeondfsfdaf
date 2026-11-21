import { everywhereAccountApi } from "../_lib/everywhere/account-api.js"

/**
 * Vector everywhere: the signed-in account's jobs of the last 30 days, ids, codes and times, plus the one free text, a
 * private place's held summary cleaned by sanitizeReply (account-api.ts; contract 3.12, E18).
 */
export const config = { api: { bodyParser: false } }
export default everywhereAccountApi.history
