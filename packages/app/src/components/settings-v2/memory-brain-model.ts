import type {
  MemoryBootstrap,
  MemoryDistillEstimate,
  MemoryDistillResult,
  MemorySettings,
} from "@vectordevai/sdk/v2/client"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

type BrainStatus = Pick<ModelPlanStatus.Status, "signedIn" | "access" | "plan" | "error" | "listed">

export const BRAIN_HELPERS = {
  title: "Use Codium for Brain helpers",
  consent:
    "Let Codium help word skill drafts, learn from your corrections, and suggest records from documents. These helpers send bounded excerpts to a qualified model with zero data retention. They share a separate cap of about 10% of the month's Codium.",
  control:
    "Subscribing never turns this on. Learning and individual helper Off settings still apply. Vector Local keeps helpers local.",
  bootstrap:
    "Scan this repository's tracked documents on this computer, then review what a model would receive. Nothing is sent until you confirm. Suggestions wait for your review.",
} as const

/** Missing capability is an old engine, never implicit consent. */
export function brainControls(settings: MemorySettings | undefined) {
  return settings?.codiumHelpers === "ask" || settings?.codiumHelpers === "on" || settings?.codiumHelpers === "off"
}

/** H1: engine support and an old saved preference cannot advertise a service the account no longer lists. */
export function brainOffered(status: BrainStatus | undefined) {
  return status?.signedIn === true && !status.error && status.listed?.includes("brain") === true
}

export function brainAccessible(status: BrainStatus | undefined) {
  return brainOffered(status) && status?.access === true && !!status.plan
}

export function askBrainConsent(input: { settings?: MemorySettings; status?: BrainStatus; presented: boolean }) {
  return (
    brainControls(input.settings) &&
    input.settings?.codiumHelpers === "ask" &&
    brainAccessible(input.status) &&
    !input.presented
  )
}

/** Presentation history only. This key and its saved boolean cannot authorize a helper request. */
export function brainConsentKey(engine: string, account: string) {
  return JSON.stringify([engine, account.trim().toLowerCase()])
}

/** An explicit answer is saved only to an engine that still exposes this capability; no optimistic permission. */
export async function saveBrainConsent(
  choice: "on" | "off",
  input: {
    current: () => boolean
    available: () => Promise<boolean>
    read: () => Promise<{ data?: MemorySettings; error?: unknown }>
    write: (change: { codiumHelpers: "on" | "off" }) => Promise<{ data?: MemorySettings; error?: unknown }>
  },
) {
  if (!input.current()) return { state: "changed" as const }
  const fresh = await input.read().catch(() => ({ data: undefined, error: true }))
  if (!input.current()) return { state: "changed" as const }
  if (fresh.error || !brainControls(fresh.data)) return { state: "unavailable" as const }
  // Off remains available even if the service was withdrawn while the owner was looking at the setting.
  if (choice === "on" && !(await input.available().catch(() => false))) return { state: "unavailable" as const }
  if (!input.current()) return { state: "changed" as const }
  const saved = await input.write({ codiumHelpers: choice }).catch(() => ({ data: undefined, error: true }))
  if (!saved.data || saved.error || saved.data.codiumHelpers !== choice) return { state: "failed" as const }
  return { state: "saved" as const, settings: saved.data }
}

export function runnableEstimate(estimate: MemoryDistillEstimate) {
  return (
    estimate.enabled === true &&
    !estimate.refused &&
    Number.isFinite(estimate.sections) &&
    estimate.sections > 0 &&
    typeof estimate.model === "string" &&
    estimate.model.length > 0
  )
}

/** A stale or malformed preview must never broaden the explicit confirmation. */
export function boundedBootstrap(preview: MemoryBootstrap) {
  return (
    preview.type === "ready" &&
    preview.maxTokens === 7500 &&
    preview.documents.length <= 4 &&
    Number.isSafeInteger(preview.queued) &&
    preview.queued >= 0 &&
    Number.isSafeInteger(preview.pending) &&
    preview.pending >= 0 &&
    preview.documents.every(
      (document) => typeof document.id === "string" && document.id.length > 0 && typeof document.title === "string",
    ) &&
    new Set(preview.documents.map((document) => document.id)).size === preview.documents.length
  )
}

/** Only an explicit confirmation invokes this function. Preparing or refreshing a preview calls no model. */
export async function runBrainBootstrap(
  preview: MemoryBootstrap,
  input: {
    current: (estimate: MemoryDistillEstimate) => boolean | Promise<boolean>
    send: (request: {
      documentID: string
      model: string
      maxTokens: number
    }) => Promise<{ data?: MemoryDistillResult; error?: unknown }>
    result: (document: string, result: MemoryDistillResult) => void
  },
) {
  if (!boundedBootstrap(preview)) return { completed: 0, state: "invalid" as const }
  let completed = 0
  for (const document of preview.documents) {
    if (!runnableEstimate(document.estimate)) continue
    if (
      !(await Promise.resolve()
        .then(() => input.current(document.estimate))
        .catch(() => false))
    )
      return { completed, state: "changed" as const }
    const result = await input
      .send({ documentID: document.id, model: document.estimate.model!, maxTokens: preview.maxTokens })
      .catch(() => ({ data: undefined, error: true }))
    if (result.error || !result.data) return { completed, state: "failed" as const }
    input.result(document.title, result.data)
    completed++
    if (result.data.error !== undefined) return { completed, state: "failed" as const }
  }
  return { completed, state: "done" as const }
}
