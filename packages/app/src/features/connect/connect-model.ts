import type { Connect } from "@vectordevai/schema/connect"
import type { Config } from "@vectordevai/sdk/v2/client"

export const REVIEW_DEFAULTS = { after_run: "off", before_commit: "offer", max_rounds: 1, max_cost_usd: 2 } as const
export type ReviewSettings = {
  after_run: "off" | "report" | "repair"
  before_commit: "off" | "offer" | "run"
  max_rounds: number
  max_cost_usd: number
}

export function readReviewSettings(config?: Pick<Config, "connect">): ReviewSettings {
  const review = config?.connect?.review
  return {
    after_run: review?.after_run ?? REVIEW_DEFAULTS.after_run,
    before_commit: review?.before_commit ?? REVIEW_DEFAULTS.before_commit,
    max_rounds: review?.max_rounds ?? REVIEW_DEFAULTS.max_rounds,
    max_cost_usd: review?.max_cost_usd ?? REVIEW_DEFAULTS.max_cost_usd,
  }
}

export function parseReviewSettings(draft: {
  after_run: string
  before_commit: string
  max_rounds: string
  max_cost_usd: string
}): ReviewSettings {
  const after_run = draft.after_run
  const before_commit = draft.before_commit
  if (after_run !== "off" && after_run !== "report" && after_run !== "repair")
    throw new Error("Choose when to review completed work.")
  if (before_commit !== "off" && before_commit !== "offer" && before_commit !== "run")
    throw new Error("Choose what to do before a commit.")
  const max_rounds = Number(draft.max_rounds)
  const max_cost_usd = Number(draft.max_cost_usd)
  if (!Number.isInteger(max_rounds) || max_rounds < 1 || max_rounds > 3)
    throw new Error("Choose between one and three review rounds.")
  if (!Number.isFinite(max_cost_usd) || max_cost_usd <= 0) throw new Error("Enter a review cap greater than zero.")
  return { after_run, before_commit, max_rounds, max_cost_usd }
}

export function reviewSettingsPatch(settings: ReviewSettings): Config {
  return { connect: { review: settings } }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Reads only a pointer from the hub's saved metadata; surfaces fetch the current owned run before showing it. */
export function metadataRunID(metadata: Readonly<Record<string, unknown>>, sessionID?: string) {
  const saved = metadata.connect
  if (!sessionID || !record(saved) || typeof saved.id !== "string" || !/^cr_[A-Za-z0-9_-]{1,61}$/.test(saved.id))
    return undefined
  if (!record(saved.request) || saved.request.id !== saved.id || !record(saved.request.requester)) return undefined
  return saved.request.requester.sessionID === sessionID ? saved.id : undefined
}

export function placeLabel(place: Connect.Place) {
  return { local: "This computer", "your-cloud": "Your accounts", "vector-cloud": "Vector's servers" }[place]
}

export function destinationLabel(destination?: Connect.SendsTo) {
  if (!destination) return "No destination reported"
  if (destination === "this-computer") return "This computer"
  if (destination === "vector-codium") return "Vector Codium"
  if (destination.startsWith("model-server:")) return `Your model server: ${destination.slice(13)}`
  return `Your provider: ${destination.slice(9)}`
}

export function memberRows(members: readonly Connect.Member[], desktop: readonly Connect.Member[] = []) {
  const merged = new Map(members.map((member) => [member.id, member]))
  for (const member of desktop) {
    // Desktop discovery supplements the engine registry; it cannot replace a member or add a hand-off action.
    if (merged.has(member.id) || !member.id.startsWith("external:") || member.reach === "connect") continue
    merged.set(member.id, member)
  }
  return [...merged.values()].map((member) => ({
    ...member,
    placeLabel: placeLabel(member.place),
    stateLabel: { ready: "Ready", busy: "Busy", unavailable: "Unavailable", off: "Off", "not-installed": "Not installed" }[member.state],
    destinationLabel: destinationLabel(member.sendsTo),
    reason: member.reason ?? (member.state === "ready" ? undefined : "This member is not ready."),
  }))
}

export function costLabel(result: Pick<Connect.Result, "cost" | "sendsTo">) {
  if (result.sendsTo === "vector-codium" || result.cost?.kind === "plan") return "Plan usage"
  if (result.cost?.kind === "local") return "Your model server"
  if (result.cost?.kind === "free") return "Free model"
  if (result.cost?.kind !== "priced" || result.cost.usd === undefined) return "Usage unavailable"
  return `$${result.cost.usd.toFixed(2)}`
}

export function verdictLabel(result: Connect.Result) {
  if (result.state === "refused") return "Review refused"
  if (result.state === "cancelled") return "Review cancelled"
  if (result.state === "failed") return "Review failed"
  if (result.state !== "completed" || result.verdict === "incomplete") return "Incomplete review"
  const open = result.findings.filter((finding) => !["fixed", "dismissed"].includes(finding.status))
  if (result.verdict === "blocking" || open.some((finding) => finding.severity === "blocking"))
    return "Blocking findings"
  if (open.some((finding) => finding.severity === "concern") || result.verdict === "findings") return "Findings"
  if (result.verdict === "clean") return "No blocking findings"
  return "Not reviewed"
}

export function actionableFindings(run: Connect.Run, sessionID: string | undefined, owner: boolean) {
  if (!owner || !sessionID || run.request.requester.sessionID !== sessionID || run.status !== "done") return []
  if (!run.result || !["completed", "partial"].includes(run.result.state)) return []
  return run.result.findings.filter((finding) => !["fixed", "dismissed", "fixing"].includes(finding.status))
}

export function findingsPrompt(input: {
  run: string
  findings: readonly string[]
  action: "fix" | "dismiss"
  mode?: Connect.FixMode
}) {
  if (!/^cr_[A-Za-z0-9_-]{1,61}$/.test(input.run)) throw new Error("The review run is not valid.")
  if (
    input.findings.length === 0 ||
    input.findings.length > 200 ||
    new Set(input.findings).size !== input.findings.length
  )
    throw new Error("Select each finding once.")
  if (input.findings.some((id) => !id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)))
    throw new Error("A finding identifier is not valid.")
  // Only identifiers cross the composer boundary. Finding text remains untrusted data in the saved run.
  const ids = JSON.stringify(input.findings)
  if (input.action === "dismiss") return `Dismiss findings ${ids} from connected review ${input.run}.`
  return `Use the connect tool to fix findings ${ids} from run ${input.run}, mode ${input.mode ?? "here"}. Keep the required approval.`
}
