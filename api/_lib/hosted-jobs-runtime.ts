import { registerHostedJobsRunner } from "./hosted-crons.js"
import { handoffAlertHook } from "./hosted-handoff.js"
import { jobHeartbeat, runDueHostedJobs } from "./hosted-jobs.js"
import { registerHostedHeartbeatHook } from "./hosted-sessions.js"

/*
 * Done by Morning's hooks into the cloud computer (contract WP A55), registered by static import from the two routes
 * that run them, as hosted-run.ts is from the gateway's routes:
 * - the reaper (`api/hosted/reaper.ts`, every minute) runs the queue: running jobs' outcomes, recurring jobs' runs and
 *   due jobs' starts (WP A53's `registerHostedJobsRunner`);
 * - the heartbeat (`api/hosted/sessions/[id]/heartbeat.ts`) adds a job session's recording links to its answer, and
 *   sends one title-only phone alert when the computer hands itself to the person (WP A56, hosted-handoff.ts).
 * Each registers once per process; the tests that need their own runner do not import this module.
 */

registerHostedJobsRunner((options) => runDueHostedJobs(options))
registerHostedHeartbeatHook("done-by-morning", (context) => jobHeartbeat(context))
registerHostedHeartbeatHook("handoff", handoffAlertHook())
