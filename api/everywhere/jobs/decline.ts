import { everywhereJobsApi } from "../../_lib/everywhere/jobs-api.js"

/** Vector everywhere: a computer turns an offered or claimed job down with a fixed reason (contract 3.4 step 5a). */
export const config = { api: { bodyParser: false } }
export default everywhereJobsApi.decline
