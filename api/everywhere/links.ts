import { everywhereAccountApi } from "../_lib/everywhere/account-api.js"

/** Vector everywhere: the signed-in account's links, and unlinking one of them (contract 3.8). */
export const config = { api: { bodyParser: false } }
export default everywhereAccountApi.links
