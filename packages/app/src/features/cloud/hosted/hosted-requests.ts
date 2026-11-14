// The cloud computer's requests (WP A56), shared by the phone app (which calls its own origin's API with the website
// session) and the desktop's main process (which calls vectordev.ai with the account token it keeps). Each request the
// screens may make is one of these shapes, checked here before anything is sent; vectordev.ai checks everything again
// and decides from the plan (S1). Pure TypeScript: no DOM, Node or Solid import, so both can load it.
//
// The estimate (`/api/model-plans/estimate`, the pre-start ceiling) takes an account token, so only the desktop sends
// it; the phone's website session is not an estimate caller.

export const SIZES = ["standard", "large"] as const
export type HostedSize = (typeof SIZES)[number]

export type HostedRequest =
  | { kind: "status" }
  | { kind: "sessions" }
  | { kind: "computers" }
  | { kind: "start"; size: HostedSize; jobMinutes: number; prompt: string; title?: string }
  | { kind: "stop"; id: string }
  | { kind: "takeover"; id: string }
  | { kind: "release"; id: string }
  | { kind: "viewer"; id: string; mode: "view" | "control" }
  | { kind: "download"; id: string }
  | { kind: "estimate"; size: HostedSize; minutes: number }
  | { kind: "jobs" }
  | { kind: "job"; id: string }
  | {
      kind: "queue"
      prompt: string
      criteria: string[]
      deliverBy: number
      size: HostedSize
      jobMinutes: number
      title?: string
    }
  | { kind: "cancel-job"; id: string }
  | { kind: "approve-job"; id: string }

export type HostedRoute = { path: string; method: "GET" | "POST"; body?: Record<string, unknown> }

/** The limits the server applies (packages/schema/src/hosted.ts), repeated so the screens refuse early. */
export const LIMITS = {
  prompt: 32_000,
  jobPrompt: 24_000,
  title: 120,
  criteria: 10,
  criterion: 300,
  minutesMin: 15,
  // The longest job any plan has (Ultra's 12 hours); the plan's own cap comes from the status.
  minutesMax: 720,
} as const

const SESSION = /^hs_[a-z2-7]{26}$/
const JOB = /^(?:jb|jr)_[a-z2-7]{26}$/
const QUEUED_JOB = /^jb_[a-z2-7]{26}$/

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const whole = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined
const size = (value: unknown) => (SIZES.some((item) => item === value) ? (value as HostedSize) : undefined)

/** A job's words: trimmed, at most `max` characters, no NUL. */
export function cleanPrompt(value: unknown, max: number) {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return text && text.length <= max && !text.includes("\u0000") ? text : undefined
}

/** A title: one line, at most 120 characters, no control characters. */
export function cleanTitle(value: unknown) {
  if (typeof value !== "string") return undefined
  const text = value.trim().replace(/\s+/g, " ")
  return text && text.length <= LIMITS.title && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined
}

/** Success criteria from the screens: one per line, at most 10, each one line of at most 300 characters. */
export function cleanCriteria(value: unknown) {
  const lines = (Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : [])
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean)
  if (lines.length === 0 || lines.length > LIMITS.criteria) return undefined
  if (lines.some((line) => line.length > LIMITS.criterion || /[\u0000-\u001f\u007f]/.test(line))) return undefined
  return lines
}

/** The API path, method and body for a request the screens may make, or undefined for anything else. */
export function hostedRoute(input: unknown): HostedRoute | undefined {
  const value = record(input)
  if (!value) return undefined
  const id = typeof value.id === "string" ? value.id : ""
  switch (value.kind) {
    case "status":
      return { path: "/api/hosted/status", method: "GET" }
    case "sessions":
      return { path: "/api/hosted/sessions", method: "GET" }
    case "computers":
      return { path: "/api/hosted/computers", method: "GET" }
    case "jobs":
      return { path: "/api/hosted/jobs", method: "GET" }
    case "start": {
      const prompt = cleanPrompt(value.prompt, LIMITS.prompt)
      const chosen = size(value.size)
      const jobMinutes = whole(value.jobMinutes, LIMITS.minutesMin, LIMITS.minutesMax)
      if (!prompt || !chosen || jobMinutes === undefined) return undefined
      const title = value.title === undefined ? undefined : cleanTitle(value.title)
      if (value.title !== undefined && !title) return undefined
      return {
        path: "/api/hosted/sessions",
        method: "POST",
        body: { size: chosen, jobMinutes, prompt, ...(title ? { title } : {}) },
      }
    }
    case "stop":
    case "takeover":
    case "release":
    case "download":
      return SESSION.test(id) ? { path: `/api/hosted/sessions/${id}/${value.kind}`, method: "POST", body: {} } : undefined
    case "viewer":
      return SESSION.test(id) && (value.mode === "view" || value.mode === "control")
        ? { path: `/api/hosted/sessions/${id}/viewer`, method: "POST", body: { mode: value.mode } }
        : undefined
    case "estimate": {
      const chosen = size(value.size)
      const minutes = whole(value.minutes, LIMITS.minutesMin, LIMITS.minutesMax)
      if (!chosen || minutes === undefined) return undefined
      return { path: "/api/model-plans/estimate", method: "POST", body: { kind: "hosted", minutes, size: chosen } }
    }
    case "job":
      return JOB.test(id) ? { path: `/api/hosted/jobs/${id}`, method: "GET" } : undefined
    case "cancel-job":
      return JOB.test(id) ? { path: `/api/hosted/jobs/${id}`, method: "POST", body: { action: "cancel" } } : undefined
    case "approve-job":
      return QUEUED_JOB.test(id) ? { path: `/api/hosted/jobs/${id}/approve`, method: "POST", body: {} } : undefined
    case "queue": {
      const prompt = cleanPrompt(value.prompt, LIMITS.jobPrompt)
      const criteria = cleanCriteria(value.criteria)
      const chosen = size(value.size)
      const jobMinutes = whole(value.jobMinutes, LIMITS.minutesMin, LIMITS.minutesMax)
      const deliverBy = whole(value.deliverBy, 1, Number.MAX_SAFE_INTEGER)
      if (!prompt || !criteria || !chosen || jobMinutes === undefined || deliverBy === undefined) return undefined
      const title = value.title === undefined ? undefined : cleanTitle(value.title)
      if (value.title !== undefined && !title) return undefined
      return {
        path: "/api/hosted/jobs",
        method: "POST",
        body: { prompt, criteria, deliverBy, size: chosen, jobMinutes, ...(title ? { title } : {}) },
      }
    }
  }
  return undefined
}

const VIEWER_TOKEN = /^vvt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/**
 * Whether a live view link from vectordev.ai may be opened: the computer's own viewer page (https, its root, no
 * credentials, no port, no query) with a viewer token in its fragment, `#vt=<token>`, and nothing else. The token
 * stays in the fragment, so it never reaches a server log or a referrer.
 */
export function viewerLinkAllowed(url: unknown) {
  if (typeof url !== "string" || url.length > 4_096) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search) return false
    if (parsed.pathname !== "/" || !/^[a-z0-9.-]+$/.test(parsed.hostname) || !parsed.hostname.includes(".")) return false
    const fragment = new URLSearchParams(parsed.hash.slice(1))
    const token = fragment.get("vt")
    return [...fragment.keys()].length === 1 && token !== null && VIEWER_TOKEN.test(token)
  } catch {
    return false
  }
}

/** A live view link's origin: the only place its window may go. */
export function viewerOrigin(url: string) {
  return viewerLinkAllowed(url) ? new URL(url).origin : undefined
}

/**
 * Whether a session's files link may be opened: vectordev.ai's own download route for that session with its link
 * token (`/api/hosted/sessions/<id>/download?t=…`), which redirects to the files for 24 hours.
 */
export function downloadLinkAllowed(url: unknown, site = "https://vectordev.ai") {
  if (typeof url !== "string" || url.length > 4_096) return false
  try {
    const parsed = new URL(url)
    const origin = new URL(site).origin
    return (
      parsed.origin === origin &&
      !parsed.username &&
      !parsed.password &&
      /^\/api\/hosted\/sessions\/hs_[a-z2-7]{26}\/download$/.test(parsed.pathname) &&
      [...parsed.searchParams.keys()].join(",") === "t" &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

/** Whether a job's pull request link may be opened: a github.com pull request or compare page, https only. */
export function pullRequestLinkAllowed(url: unknown) {
  if (typeof url !== "string" || url.length > 2_048) return false
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      /^\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}\/(?:pull\/\d{1,10}|compare\/[^\s]+)\/?$/.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

/** Whether a recording segment link may be opened: a signed link to Cloudflare R2's S3 endpoint, https only. */
export function recordingLinkAllowed(url: unknown) {
  if (typeof url !== "string" || url.length > 4_096) return false
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
