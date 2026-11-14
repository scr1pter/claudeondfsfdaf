// The names, numbers and patterns @vector shares between the hosted API, the engine, the desktop and the app
// (docs/vector/build/vector-at-mention-spec.md section 2.1). The hosted API runs on Node on Vercel and loads this file
// by its relative .js path, so it has no imports and uses nothing newer than ES2023.

export const WORKFLOW_FILE = ".github/workflows/vector.yml"
// What the v3 builder writes. review/workflow's GITHUB_WORKFLOW_VERSION, which the CLI compares against, stays "2" while
// the CLI and the desktop still install the v2 workflow.
export const WORKFLOW_VERSION = "3"
// Compare workflow versions as numbers: as strings, "10" sorts below "3".
export const MIN_CODIUM_WORKFLOW_VERSION = 3
// Provisional unpublished release reservation; setup remains gated until this CLI actually ships.
export const MIN_AGENTS_CLI = "1.99.113"

export const JOB = {
  agent: "Vector agent",
  publish: "Vector publish",
  review: "Vector review",
  bind: "Vector bind",
  // The v2 App task job, which installed workflows and the App's job check still name.
  legacyTask: "Vector task",
} as const

// One OIDC audience per endpoint, so a bind token can never mint and a mint token can never bind.
export const AUDIENCE = {
  mint: "https://vectordev.ai/api/cloud-agents/mint",
  bind: "https://vectordev.ai/api/cloud-agents/bind",
} as const

export const ENDPOINT = {
  bindCode: "/api/cloud-agents/bind-code",
  bind: "/api/cloud-agents/bind",
  bindings: "/api/cloud-agents/bindings",
  unbind: "/api/cloud-agents/unbind",
  mint: "/api/cloud-agents/mint",
  heartbeat: "/api/cloud-agents/heartbeat",
  settle: "/api/cloud-agents/settle",
  runs: "/api/cloud-agents/runs",
  artifactKey: "/api/cloud-agents/artifact-key",
} as const

export const COMMAND_MENTIONS = ["/vector", "/vs"] as const
// Installed workflows still route these.
export const LEGACY_MENTIONS = ["/vectorscope", "/vx"] as const

// A GitHub App slug, as api/_lib/github-app.ts accepts VECTOR_GITHUB_APP_SLUG.
const SLUG = "[a-z0-9][a-z0-9-]{0,98}[a-z0-9]"
const SLUG_ONLY = new RegExp(`^${SLUG}$`)
// The whole string, so a different host, a port, user info, a query, a fragment or an encoded path never yields a
// slug. Without the m flag, $ matches only at the very end, so a trailing newline fails too.
const INSTALL_URL = new RegExp(`^https://github\\.com/apps/(${SLUG})/installations/new$`)

// The App handle comes first when the slug is known. An invalid slug is ignored rather than mentioned, since an
// "@name" in a comment notifies whichever GitHub account holds that name.
export function mentions(slug?: string) {
  const commands = [...COMMAND_MENTIONS, ...LEGACY_MENTIONS]
  return slug !== undefined && SLUG_ONLY.test(slug) ? [`@${slug}`, ...commands] : commands
}

// The slug in the public installation answer's installUrl, which keeps its {available, installUrl?} shape.
export function slugFromInstallUrl(url: string | undefined) {
  return INSTALL_URL.exec(url ?? "")?.[1]
}

export function onActionsRunner(env: Readonly<Record<string, string | undefined>>) {
  return env.GITHUB_ACTIONS === "true"
}

// Bridged tools drive the user's own browser or computer, which a run on GitHub Actions must never reach. The set holds
// the tool ids the registry offers and the registry keys the contract names, so either spelling is withheld.
const WITHHELD = new Set(["browser", "vector_cloud", "vectorcloud", "research_browser", "researchbrowser"])

export function withheldOnActions(toolId: string) {
  return WITHHELD.has(toolId) || computerUse(toolId)
}

// Computer use by name: a tool id, or an MCP server's or MCP tool's own name. The bridged ids above are Vector's own
// tools, so an MCP server or tool that only shares one of those names (a `browser` server) is not computer use.
export function computerUse(name: string) {
  return /^computer(?:$|[_-])/i.test(name)
}

// Codium's run-id grammar (RUN and validRunId in api/_lib/codium-pool.ts) as one pattern: "-" alone is refused.
export const RUN_ID_PATTERN = /^(?!-$)[A-Za-z0-9_.-]{1,128}$/

// "gh-<repositoryId>-<runId>-<runAttempt>-<checkRunId>": the prefix and the four ids keep it unique across Codium's
// services, and four 20-digit ids make it 86 characters. Pass verified OIDC claims; anything other than a positive
// decimal id throws, so the result always matches RUN_ID_PATTERN.
export function runId(
  repositoryId: string | number,
  run: string | number,
  attempt: string | number,
  checkRun: string | number,
) {
  return `gh-${[repositoryId, run, attempt, checkRun].map(decimalId).join("-")}`
}

function decimalId(value: string | number) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text === "string" && /^[1-9]\d{0,19}$/.test(text)) return text
  throw new RangeError("A GitHub id must be a positive decimal integer of at most 20 digits")
}

// An issue or pull request number, a dispatch's run id, or a schedule's id.
export const THREAD_PATTERN = /^(?:[1-9]\d{0,9}|dispatch-[1-9]\d{0,19}|schedule-[0-9a-f]{8})$/

export const BRANCH_PREFIX = "vector"
export const BUNDLE_DIR = "vector-out"
export const BUNDLE_FILES = ["patch.diff", "summary.json"] as const
export const SESSION_FILE = "session.vsa"

export function bundleArtifact(run: string | number, attempt: string | number) {
  return `vector-run-${run}-${attempt}`
}

export function sessionArtifact(thread: string) {
  return `vector-session-${thread}`
}

export const SANDBOX_USER = "vector-agent"
// Set only by the trusted sandbox launcher after verifying the required kernel boundary.
export const TOOL_PID_NAMESPACE_ENV = "VECTOR_GITHUB_TOOL_PID_NAMESPACE"
// FD3 is opened by the trusted hosted runner after sudo and is never inherited by tools.
export const SESSION_PROOF_ENV = "VECTOR_GITHUB_SESSION_PROOF"
// The only names the engine starts with in the sandbox. The sandbox sets HOME and RUNNER_TEMP to the agent user's own
// directories, and GITHUB_EVENT_PATH to a copy the agent user can read.
export const SANDBOX_ENV_ALLOW = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_SERVER_URL",
  "GITHUB_API_URL",
  "GITHUB_WORKSPACE",
  "RUNNER_OS",
  "MENTIONS",
  "MODEL",
  "SHARE",
  "VECTOR_SHARE_CONSENT",
  "VECTOR_MODE",
  "VECTOR_THREAD",
  "VECTOR_PROMPT",
  "VECTOR_SCHEDULE_PROMPTS",
  "VECTOR_WORKFLOW_VERSION",
  "VECTOR_DISABLE_USAGE",
  "VECTOR_PURE",
  "VECTOR_DISABLE_PROJECT_CONFIG",
  "VECTOR_RUN_DEADLINE",
  "VECTOR_RUN_ID",
  "VECTOR_BUNDLE_DIR",
  "VECTOR_SECRET_CHANNEL",
  TOOL_PID_NAMESPACE_ENV,
  SESSION_PROOF_ENV,
  "HOME",
  "RUNNER_TEMP",
] as const
// Case-sensitive, as environment names are on Linux. Where names are case-insensitive (Windows), match the upper-cased
// name.
export const SECRET_NAME_PATTERN = /(?:_TOKEN|_KEY|_SECRET|_PASSWORD)$/

export const HEARTBEAT_SECONDS = 60
// A run with no heartbeat and no Codium request for this long is settled as idle.
export const IDLE_SECONDS = 600
// A mint is refused when less agent time than this is left.
export const MIN_LEFT_SECONDS = 300
// The engine stops this long before its deadline, so the bundle is written in time.
export const STOP_MARGIN_SECONDS = 180
// A run token's exp is its deadline plus this, so heartbeat and settle still work just after the deadline.
export const SETTLE_GRACE_SECONDS = 900
export const CONCURRENCY_RETRY_MS = 900_000
export const AT_ONCE_WAIT_MS = 600_000
export const AT_ONCE_POLL_MS = 30_000
export const BIND_CODE_SECONDS = 600
export const TICKET_SECONDS = 900
export const TIMEOUT_MIN = { codiumAgent: 135, ownKeyAgent: 60, publish: 15, bind: 5, route: 3, review: 20 } as const
export const PATCH_LIMITS = {
  bytes: 8_000_000,
  files: 2_000,
  fileBytes: 10_000_000,
  summaryBytes: 262_144,
  sessionBytes: 20_000_000,
} as const
export const RUN_LOGIN_DAYS = 90
// Run records kept per account.
export const RUNS_KEPT = 200
export const SESSION_DAYS = 7
export const BUNDLE_DAYS = 1

// What `vector github mint` writes as status= to $GITHUB_OUTPUT (section 2.9.1).
export const MINT_STATUS = [
  "ok",
  "not-bound",
  "suspended",
  "update-required",
  "binding-unavailable",
  "not-in-plan",
  "service-off",
  "source-unavailable",
  "runner",
  "hours",
  "at-once",
  "scheduled",
  "denied",
  "needs-app",
  "unavailable",
] as const
export type MintStatus = (typeof MINT_STATUS)[number]

export const OUTCOME = ["changes", "no-changes", "draft", "failed", "refused", "cancelled"] as const
export type Outcome = (typeof OUTCOME)[number]

// The gateway codes of section 2.9.2 that end a run in a draft, the waits included once their retries run out. The
// local deadline ("deadline") and the codes of the default row are not stop codes.
export const STOP_CODES = [
  "MODEL_PLAN_RUN_EXPIRED",
  "MODEL_PLAN_RUN_LIMIT",
  "MODEL_PLAN_DAILY_LIMIT",
  "MODEL_PLAN_EXHAUSTED",
  "MODEL_PLAN_PAYMENT_REQUIRED",
  "MODEL_PLAN_REQUIRED",
  "MODEL_PLAN_CAPACITY",
  "MODEL_PLAN_BLOCKED",
  "CODIUM_PERK_REQUIRED",
  "MODEL_PLAN_CONCURRENCY",
  "MODEL_PLAN_BUSY",
  "MODEL_PLAN_RENEWING",
  "MODEL_PLAN_UPGRADE_REQUIRED",
  "CODIUM_UPDATE_REQUIRED",
  "MODEL_PLANS_DISABLED",
  "MODEL_PLAN_MODEL_UNAVAILABLE",
] as const
export type StopCode = (typeof STOP_CODES)[number]

export * as GithubAgents from "./github-agents.js"
