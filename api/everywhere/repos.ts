import { everywhereAccountApi } from "../_lib/everywhere/account-api.js"

/** Vector everywhere: repository mappings per Slack channel, Linear team and Jira project, set by the connector (contract 3.8). */
export const config = { api: { bodyParser: false } }
export default everywhereAccountApi.repos
