import { everywhereAccountApi } from "../_lib/everywhere/account-api.js"

/** Vector everywhere: the OAuth landing page posts {code, state} here with the signed-in account's bearer token (contract 3.8). */
export const config = { api: { bodyParser: false } }
export default everywhereAccountApi.oauthFinish
