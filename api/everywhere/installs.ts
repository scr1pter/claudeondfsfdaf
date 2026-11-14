import { everywhereAccountApi } from "../_lib/everywhere/account-api.js"

/** Vector everywhere: installations the signed-in account connected: start an install, redeem a Jira connect code, disconnect (contract 3.8, E13). */
export const config = { api: { bodyParser: false } }
export default everywhereAccountApi.installs
