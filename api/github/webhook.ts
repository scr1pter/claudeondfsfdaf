import { cloudAgentsWebhookHandler } from "../_lib/github-webhook-handlers/cloud-agents.js"
import { opsWebhookHandler, registerShipDeskIntake } from "../_lib/github-webhook-handlers/ops.js"
import { createGithubWebhookRoute, type GithubWebhookHandler } from "../_lib/github-webhook.js"
import { shipDeskIntake } from "../_lib/ship-desk.js"

// The signature is checked over the raw body, so Vercel must not parse it first.
export const config = { api: { bodyParser: false } }
export const maxDuration = 15

// WP A49: Ship Desk takes the pull requests the ops handler passes it (cards, the run check, the opt-in, the count).
registerShipDeskIntake((pull, context) => shipDeskIntake(pull, context))

/**
 * `POST /api/github/webhook` (contract WP A47, §4.18 amendment 14): every delivery from the GitHub App, checked and
 * deduped once (api/_lib/github-webhook.ts), then passed to each handler that named its event. A part of Vector that
 * needs GitHub's events adds its handler to this list; Codex's `cloudAgentsWebhookHandler` is added by the integration
 * commit (A59), one import and one entry.
 */
export const GITHUB_WEBHOOK_HANDLERS: readonly GithubWebhookHandler[] = [opsWebhookHandler, cloudAgentsWebhookHandler]

export default createGithubWebhookRoute({ handlers: GITHUB_WEBHOOK_HANDLERS })
