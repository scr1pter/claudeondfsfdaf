import type { RunBudget } from "@vectordevai/sdk/v2/client"

// The desktop spend ledger, as the renderer sees it through window.api. The web
// build has no ledger, so every accessor here returns undefined there.
//
// These types mirror packages/desktop/src/main/spend-limits.ts structurally;
// the renderer cannot import from the desktop main process.

export type SpendLimit = { usd: number; warnAt?: number }

// One overall set: the day and month limits count every repository, and no
// repository has a limit of its own.
export type SpendLimitSet = {
  perRun?: SpendLimit
  perDay?: SpendLimit
  perMonth?: SpendLimit
}

export type SpendPolicy = { interactive: SpendLimitSet; unattended: SpendLimitSet }

export type SpendWindowTotal = {
  costUsd: number
  tokens: number
  runs: number
  unmeasuredRuns: number
  billing?: "codium"
}

export type SpendSummary = {
  at: string
  day: string
  month: string
  all: { day: SpendWindowTotal; month: SpendWindowTotal }
  policy: SpendPolicy
}

export type SpendEvent = {
  billing?: "codium"
  id: string
  projectPath: string
  runId: string
  provider: string
  model: string
  costUsd?: number
  tokens?: number
  at: string
  source: "session" | "parallel" | "scheduled"
}

export type SpendLimitsApi = {
  limits: () => Promise<SpendPolicy>
  setLimits: (next: Partial<SpendPolicy>) => Promise<SpendPolicy>
  status: () => Promise<SpendSummary>
  recent: (limit?: number) => Promise<SpendEvent[]>
}

export function spendLimitsApi() {
  return (globalThis.window?.api as (Record<string, unknown> & { spendLimits?: SpendLimitsApi }) | undefined)
    ?.spendLimits
}

const CACHE_MS = 30_000
let cached: { at: number; policy: Promise<SpendPolicy | undefined> } | undefined

// Read on every prompt submit, so the policy is cached for 30 seconds rather
// than paying an IPC round trip per message. Saving limits clears it.
export function cachedSpendPolicy(api = spendLimitsApi(), now = Date.now()) {
  if (!api) return Promise.resolve(undefined)
  if (cached && now - cached.at < CACHE_MS) return cached.policy
  const policy = api.limits().catch(() => undefined)
  cached = { at: now, policy }
  return policy
}

export function clearSpendPolicyCache() {
  cached = undefined
}

// The prompt budget for a foreground chat: the interactive per-run cap, when
// the user has set one.
export function interactiveRunBudget(policy: SpendPolicy | undefined) {
  const perRun = policy?.interactive.perRun
  if (!perRun || !(perRun.usd > 0)) return undefined
  return { usd: perRun.usd, ...(perRun.warnAt === undefined ? {} : { warnAt: perRun.warnAt }) }
}

// A prompt budget replaces the configured budget.run for its run rather than
// adding to it, so it is built on top of that config: its step limits stay, and
// the smaller of the two dollar caps wins, with that cap's warn threshold.
// `capUsd` renews a stopped run's cap for a continuation. With neither an
// interactive cap nor a renewed one, no budget is sent and the engine applies
// the config on its own.
export function promptRunBudget(input: {
  configured: RunBudget | undefined
  policy: SpendPolicy | undefined
  capUsd?: number
}): RunBudget | undefined {
  const interactive = interactiveRunBudget(input.policy)
  if (!interactive && input.capUsd === undefined) return undefined
  const configured = input.configured ?? {}
  const cap = input.capUsd === undefined ? smallerCap(configured, interactive) : { usd: input.capUsd }
  const warnAt = cap?.warnAt ?? interactive?.warnAt ?? configured.warnAt
  return {
    ...configured,
    ...(cap ? { usd: cap.usd } : {}),
    ...(warnAt === undefined ? {} : { warnAt }),
  }
}

function smallerCap(configured: RunBudget, interactive: RunBudget | undefined) {
  if (configured.usd === undefined) return interactive
  if (interactive?.usd === undefined || configured.usd <= interactive.usd) return configured
  return interactive
}
