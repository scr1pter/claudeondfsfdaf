import { everywhereAccountApi } from "../_lib/everywhere/account-api.js"

/** Vector everywhere: link codes for Slack and Jira, and the start of the Linear sign-in that links (contract 3.8). */
export const config = { api: { bodyParser: false } }
export default everywhereAccountApi.link
