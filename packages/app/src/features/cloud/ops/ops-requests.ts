// The production checks' requests (WP A50), shared by the phone app (which calls its own origin's API with the website
// session) and the desktop's main process (which calls vectordev.ai with the account token it keeps). Each request the
// screens may make is one of these shapes, checked here before anything is sent; vectordev.ai checks everything again
// and decides from the plan (S1). Pure TypeScript: no DOM, Node or Solid import, so both can load it.

export type OpsRequest =
  | { kind: "incidents" }
  | { kind: "releases" }
  | { kind: "cards" }
  | { kind: "card"; id: string }
  | { kind: "image"; card: string; n: number }
  | { kind: "monitors" }
  | { kind: "domains" }
  | { kind: "repos" }
  | { kind: "snooze"; id: string; hours: number }
  | { kind: "unsnooze"; id: string }
  | { kind: "fix"; id: string; repositoryId?: number }
  | { kind: "add-domain"; domain: string }
  | { kind: "verify-domain"; domain: string }
  | { kind: "remove-domain"; domain: string }
  | { kind: "add-monitor"; url: string }
  | { kind: "remove-monitor"; id: string }

export type OpsRoute = { path: string; method: "GET" | "POST" | "DELETE"; body?: Record<string, unknown> }

const INCIDENT = /^inc_[A-Za-z0-9_-]{22}$/
const CARD = /^crd_[A-Za-z0-9_-]{22}$/
const MONITOR = /^mon_[A-Za-z0-9_-]{16}$/

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined
const whole = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined

/** The API path, method and body for a request the screens may make, or undefined for anything else. */
export function opsRoute(input: unknown): OpsRoute | undefined {
  const value = record(input)
  if (!value) return undefined
  switch (value.kind) {
    case "incidents":
      return { path: "/api/ops/incidents", method: "GET" }
    case "releases":
      return { path: "/api/ops/releases", method: "GET" }
    case "cards":
      return { path: "/api/ops/cards", method: "GET" }
    case "monitors":
      return { path: "/api/ops/monitors", method: "GET" }
    case "domains":
      return { path: "/api/ops/domains", method: "GET" }
    case "repos":
      return { path: "/api/ops/repos", method: "GET" }
    case "card":
      return typeof value.id === "string" && CARD.test(value.id)
        ? { path: `/api/ops/cards?id=${value.id}`, method: "GET" }
        : undefined
    case "image": {
      const n = whole(value.n, 1, 99)
      return typeof value.card === "string" && CARD.test(value.card) && n !== undefined
        ? { path: `/api/ops/image/${value.card}/${n}`, method: "GET" }
        : undefined
    }
    case "snooze": {
      const hours = whole(value.hours, 1, 24)
      return typeof value.id === "string" && INCIDENT.test(value.id) && hours !== undefined
        ? { path: "/api/ops/incidents", method: "POST", body: { id: value.id, action: "snooze", hours } }
        : undefined
    }
    case "unsnooze":
      return typeof value.id === "string" && INCIDENT.test(value.id)
        ? { path: "/api/ops/incidents", method: "POST", body: { id: value.id, action: "unsnooze" } }
        : undefined
    case "fix": {
      if (typeof value.id !== "string" || !INCIDENT.test(value.id)) return undefined
      if (value.repositoryId === undefined)
        return { path: "/api/ops/incidents", method: "POST", body: { id: value.id, action: "fix" } }
      const repositoryId = whole(value.repositoryId, 1, Number.MAX_SAFE_INTEGER)
      return repositoryId === undefined
        ? undefined
        : { path: "/api/ops/incidents", method: "POST", body: { id: value.id, action: "fix", repositoryId } }
    }
    case "add-domain":
    case "verify-domain":
    case "remove-domain": {
      const domain = text(value.domain, 260)
      if (!domain) return undefined
      if (value.kind === "remove-domain") return { path: "/api/ops/domains", method: "DELETE", body: { domain } }
      return {
        path: "/api/ops/domains",
        method: "POST",
        body: value.kind === "verify-domain" ? { domain, verify: true } : { domain },
      }
    }
    case "add-monitor": {
      const url = text(value.url, 2_048)
      return url ? { path: "/api/ops/monitors", method: "POST", body: { url } } : undefined
    }
    case "remove-monitor":
      return typeof value.id === "string" && MONITOR.test(value.id)
        ? { path: "/api/ops/monitors", method: "DELETE", body: { id: value.id } }
        : undefined
  }
  return undefined
}

/** A pull request the desktop may merge with the person's own GitHub sign-in (Undo or Approve). */
export type OpsMergeRequest = { repository: string; number: number; headSha?: string }

/** The merge the screens ask for, checked by shape, or undefined. */
export function opsMerge(input: unknown): OpsMergeRequest | undefined {
  const value = record(input)
  if (!value || typeof value.repository !== "string") return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repository)) return undefined
  if (value.repository.split("/")[1] === "." || value.repository.split("/")[1] === "..") return undefined
  const number = whole(value.number, 1, 1_000_000_000)
  if (number === undefined) return undefined
  if (value.headSha !== undefined && (typeof value.headSha !== "string" || !/^[0-9a-f]{40}$/.test(value.headSha)))
    return undefined
  return { repository: value.repository, number, ...(value.headSha ? { headSha: value.headSha as string } : {}) }
}

/** Where a signed image link may point: Cloudflare R2's S3 endpoint for an account, https only. */
export function imageLinkAllowed(url: string) {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === "https:" &&
      /^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/.test(parsed.hostname) &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}
