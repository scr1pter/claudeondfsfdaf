import { everywhereJobsApi } from "../../_lib/everywhere/jobs-api.js"

/** Vector everywhere: the computer's result: outcome, a short summary and links, never code or pull request text (contract 3.5 step 8, E4). */
export const config = { api: { bodyParser: false } }
export default everywhereJobsApi.settle
