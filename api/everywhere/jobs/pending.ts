import { everywhereJobsApi } from "../../_lib/everywhere/jobs-api.js"

/** Vector everywhere: a computer that wants jobs asks for waiting ones with its readiness booleans, and gets fresh offers (contract 3.4). */
export const config = { api: { bodyParser: false } }
export default everywhereJobsApi.pending
