import type { Config, LocalCheckResult, LocalStatus } from "@vectordevai/sdk/v2/client"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import {
  LOCKED,
  NOT_ENCRYPTED,
  SERVER_KINDS,
  SHARED_MACHINE,
  WEB_ACCESS,
  allowHosts,
  hostOf,
  list,
  sourceName,
} from "@/features/local/local-model"

// Settings > Vector Local (section 8.5), as data: its sections in order, the switch, Web access under a lock, the model
// servers with their identity and encryption labels, the services the user allowed, the held change, the check's rows
// and the certificates. The pane renders these; nothing here talks to the engine.

type Policy = LocalStatus["policy"]

/** The pane's sections, top to bottom. */
export const SECTIONS = [
  { id: "switch", title: "Vector Local" },
  { id: "web", title: "Web access" },
  { id: "servers", title: "Model servers" },
  { id: "roles", title: "Roles" },
  { id: "allowed", title: "Allowed services" },
  { id: "off", title: "Off in Vector Local" },
  { id: "certificates", title: "Certificates" },
  { id: "log", title: "Network log" },
  { id: "check", title: "Run a check" },
] as const

/**
 * Which Vector the switch is for. The desktop app and Vector in a terminal outside it read different config folders
 * and keep separate confirmed copies, so neither switch reaches the other; only the company's policy reaches both. The
 * app's built-in terminal inherits the app's config folders, so a vector there reads this switch.
 */
export const SURFACE =
  "This switch is for the desktop app. Vector in a terminal outside the app keeps its own setting: vector local on turns it on there. Your company's policy applies to both."

/**
 * The switch's note on which Vector it is for: only in the desktop app, reading this computer's engine. A remote
 * engine's switch is that engine's own, and in a browser there is no desktop app to tell apart.
 */
export function surfaceNote(input: { readonly desktop: boolean; readonly remote: boolean }) {
  return input.desktop && !input.remote ? SURFACE : undefined
}

/** The switch: on or off, and whether the company decides. */
export function switchView(status: Pick<LocalStatus, "policy" | "locked" | "agent">) {
  const locked = status.locked.includes("enabled")
  return {
    on: status.policy.enabled,
    locked,
    // Turning it off loosens it, which a Vector the agent started can never do; turning it on only tightens.
    disabled: locked || (status.agent && status.policy.enabled),
    note: locked ? LOCKED : undefined,
  }
}

/** Web access's three choices, and why they cannot change under a lock that keeps `web`. */
export function webChoices(status: Pick<LocalStatus, "policy" | "locked">) {
  const locked = status.locked.includes("web")
  return WEB_ACCESS.map((option) => ({
    ...option,
    checked: status.policy.web === option.id,
    // Under a lock that leaves Web access to the user, it may only get stricter.
    disabled: locked || (status.policy.lock && LocalPolicy.stricter(status.policy.web, option.id) !== option.id),
  }))
}

/** Why Web access cannot change, under a lock. */
export function webNoteLocked(status: Pick<LocalStatus, "policy" | "locked">) {
  if (status.locked.includes("web")) return LOCKED
  if (status.policy.lock) return `${LOCKED} Your company lets you make Web access stricter only.`
  return undefined
}

/** A note under Web access when a model server on the list is on the internet: None does not stop its model calls. */
export function webNote(policy: Policy) {
  const internet = policy.endpoints.filter((endpoint) => hostClass(endpoint.origin) === "internet")
  if (internet.length === 0) return undefined
  return `Model calls still go to the ${internet.length === 1 ? "internet server" : "internet servers"} on your list (${list(internet.map((endpoint) => hostOf(endpoint.origin)))}), whatever Web access says.`
}

const FROM: Record<Policy["endpoints"][number]["from"], string> = {
  managed: "Listed by your company",
  user: "Added by you",
  environment: "From VECTOR_LOCAL_POLICY",
}

export type ServerRow = {
  readonly origin: string
  readonly host: string
  readonly from: string
  readonly labels: readonly { readonly text: string; readonly warn?: boolean }[]
  readonly identity: string
  readonly removable: boolean
}

/** Each server on the list: who listed it, where it is, whether its prompts are encrypted, and its identity pin. */
export function serverRows(status: Pick<LocalStatus, "policy" | "locked">): ServerRow[] {
  return status.policy.endpoints.map((endpoint) => {
    const place = hostClass(endpoint.origin)
    const https = endpoint.origin.startsWith("https:")
    const pin = status.policy.pins?.[endpoint.origin]
    return {
      origin: endpoint.origin,
      host: hostOf(endpoint.origin),
      from: FROM[endpoint.from],
      labels: [
        {
          text:
            place === "this-computer"
              ? "This computer"
              : place === "your-network"
                ? "Your network"
                : endpoint.from === "managed"
                  ? "Company endpoint (listed by your company)"
                  : "Internet endpoint you listed",
        },
        ...(!https && place !== "this-computer" ? [{ text: NOT_ENCRYPTED, warn: true }] : []),
        ...(https ? [{ text: pin?.spki ? "Encrypted, key pinned" : "Encrypted" }] : []),
        ...(place === "this-computer" ? [{ text: SHARED_MACHINE }] : []),
      ],
      identity: pin
        ? `Answers as ${SERVER_KINDS[pin.kind] ?? pin.kind}${pin.version ? ` ${pin.version}` : ""}`
        : "No identity pinned yet. Add it again to pin the server it answers as.",
      // A company lock keeps what the user may add, not what they added themselves.
      removable: endpoint.from === "user",
    }
  })
}

const BY: Record<Policy["allow"][number]["added_by"], string> = {
  app: "Added in the app",
  cli: "Added in a terminal",
  managed: "Set by your company",
}

/**
 * The services the user or the company allowed, each with what it sends, where it may go, the reason, who and when.
 * An entry with no hosts covers every host its source reaches, which `hosts` says.
 */
export function allowedRows(status: Pick<LocalStatus, "policy" | "locked" | "sources">) {
  return status.policy.allow.map((entry) => {
    const source = status.sources.find((item) => item.id === entry.source)
    return {
      source: entry.source,
      name: sourceName(entry.source, status.sources),
      sends: source?.sends ?? "Unknown to this version of Vector",
      hosts: allowHosts(entry.hosts, source?.hosts ?? []),
      reason: entry.reason,
      by: BY[entry.added_by],
      when: entry.added_at ? new Date(entry.added_at).toLocaleDateString("en-US", { dateStyle: "medium" }) : "",
      removable: entry.added_by !== "managed",
    }
  })
}

/** "A change to your config would loosen Vector Local: it turns Vector Local off." */
export function heldText(held: NonNullable<LocalStatus["held"]>) {
  return `A change to your config would loosen Vector Local: it ${list(held.changes)}. It waits for you.`
}

export const CHECK_STATUS: Record<LocalCheckResult["rows"][number]["status"], string> = {
  pass: "Pass",
  warn: "Warning",
  fail: "Failed",
}

/** The check's verdict line. */
export function checkVerdict(report: Pick<LocalCheckResult, "result" | "rows">) {
  if (report.result === "off") return "Vector Local is off, so nothing is enforced. The rows say what would apply."
  const failed = report.rows.filter((row) => row.status === "fail").length
  const warned = report.rows.filter((row) => row.status === "warn").length
  if (failed) return `${failed} ${failed === 1 ? "layer failed" : "layers failed"}.`
  return warned ? `Every layer passed, with ${warned} ${warned === 1 ? "warning" : "warnings"}.` : "Every layer passed."
}

/** The certificate files Vector adds to the system's, as the user's own config lists them. */
export function certificateLines(config: Pick<Config, "local"> | undefined) {
  return config?.local?.ca?.files ?? []
}

export const CERTIFICATES =
  "Vector adds these certificate files to the ones this computer trusts, for model servers and company services that use your company's certificate authority. The desktop app asks you before it trusts one from your own config; your company's apply without asking. The app's windows use this computer's certificate store."

export const DICTATION_LOCAL =
  "With Vector Local on, dictation uses its model only when it is already on this computer. Install it from a folder, or allow its one download."

function hostClass(origin: string) {
  return URL.canParse(origin) ? LocalPolicy.hostClass(new URL(origin).hostname) : "internet"
}
