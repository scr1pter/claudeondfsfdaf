import { bindingFor } from "./cloud-agents-binding.js"
import { cloudAgentsEnabled } from "./model-plan-config.js"
import { opsRunStarter, registerOpsRunStarter } from "./ops-incidents.js"
import { createOpsRunStarter } from "./ops-run-starter.js"
import { registerRepoBindingReader, repoBindingsAvailable, type OpsBindingReader } from "./ops-settings.js"

/*
 * WP A59: Codium's ops (Release Guard, On Call and Ship Desk) read @vector's repository bindings (`bindingFor`,
 * contract §4.18) and start "Fix it" runs through @vector's `startCloudRun` (ops-run-starter.ts). Codium's ops files
 * never import @vector's, so this module registers both. Vercel bundles each function's own import graph, so every
 * function that reads a binding or starts a fix run imports this module for its side effect: api/ops/repos.ts,
 * api/ops/incidents.ts, api/ops/uploads.ts, api/ops/worker.ts and the webhook's ops handler
 * (api/_lib/github-webhook-handlers/ops.ts, which api/github/webhook.ts bundles). It exports nothing and does no I/O
 * at import. Each guard keeps a reader or starter registered before this module (a test's) in place.
 *
 * While the cloud-agents service is off (`cloudAgentsEnabled()`, the gate on @vector's own routes) no binding is read,
 * so no repository is bound for ops, and a fix run is refused with 503 before anything is read.
 */

// RepoBinding (account, repository, installationId, suspended) must fit OpsRepoBinding: drift fails typecheck here.
const reader = (async (repositoryId) =>
  cloudAgentsEnabled() ? bindingFor(repositoryId) : undefined) satisfies OpsBindingReader

if (!repoBindingsAvailable()) registerRepoBindingReader(reader)
if (!opsRunStarter()) registerOpsRunStarter(createOpsRunStarter())
