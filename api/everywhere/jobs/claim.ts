import { everywhereJobsApi } from "../../_lib/everywhere/jobs-api.js"

/** Vector everywhere: a computer claims an offered or waiting job of its own account and takes a 5-minute lease (contract 3.4, 3.5 step 3). */
export const config = { api: { bodyParser: false } }
export default everywhereJobsApi.claim
