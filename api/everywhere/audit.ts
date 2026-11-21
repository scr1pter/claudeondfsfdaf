import { everywhereAccountApi } from "../_lib/everywhere/account-api.js"

/** Vector everywhere: the signed-in account's audit log of the last 90 days, ids and fixed codes only (contract E16). */
export const config = { api: { bodyParser: false } }
export default everywhereAccountApi.audit
