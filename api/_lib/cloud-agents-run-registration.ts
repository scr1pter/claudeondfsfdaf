import { listCloudRuns } from "./cloud-agents-runs.js"
import { cloudRunReader, registerCloudRunReader } from "./cloud-run-reader.js"
import { cloudAgentsEnabled } from "./model-plan-config.js"

/*
 * WP A59 (BT11): the @vector run records (`listCloudRuns`, spec 2.16) are Codium's one cloud run reader, behind
 * Remote's run list (`remoteCloudRuns`) and Ship Desk's run checks and verdicts (`lookupRun`). Vercel bundles each
 * function's own import graph, so every function that reads runs imports this module: api/ops/cards.ts,
 * api/remote/cloud-runs.ts and the webhook's ops handler (api/_lib/github-webhook-handlers/ops.ts, which
 * api/github/webhook.ts bundles; that file is Codium's A47 router and is not edited, spec 0.2). The guard keeps a
 * reader registered before this module from making the registration throw.
 *
 * While the cloud-agents service is off (`cloudAgentsEnabled()`, the same gate as the service's own run list in
 * cloud-agents-api.ts), its run state is not read and the reader lists nothing.
 */

if (!cloudRunReader())
  registerCloudRunReader(async (account, input) => (cloudAgentsEnabled() ? listCloudRuns(account, input) : []))
