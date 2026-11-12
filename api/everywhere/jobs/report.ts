import { everywhereJobsApi } from "../../_lib/everywhere/jobs-api.js"

/** Vector everywhere: milestones and the heartbeat from the computer holding a job; answers continue, stop or lost (contract 3.5 step 7, E10). */
export const config = { api: { bodyParser: false } }
export default everywhereJobsApi.report
