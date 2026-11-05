export * as ShipDesk from "./ship-desk.js"

/*
 * Ship Desk's shared formats (contract WP A49), read by the API (api/_lib/ship-desk.ts) and by `vector ship capture`
 * (packages/engine/src/cli/cmd/ship.ts). Browser-safe: no Node imports.
 *
 * A card is a private record of one pull request from a Codium run of Vector's GitHub agent: the checks, the run's
 * verdict and before/after screenshots. The screenshots come from a separate capture job in the person's own repository,
 * which holds no `id-token` and no run token: only a capture ticket (`vcap_…`) that the run's own token asked for. A
 * ticket names one run, and so one pull request; it uploads at most `LIMITS.files` images, all inside one 15-minute
 * window that opens when the capture first uploads.
 */

export const LIMITS = {
  /** A capture's uploads start and finish within this many ms of the ticket's first upload. */
  windowMs: 15 * 60_000,
  /** A ticket must be first used this long after the run's deadline at most (publish, then the capture's own build). */
  ticketGraceMs: 60 * 60_000,
  /** Images one capture uploads, and a card keeps (the plan's `shipDesk.images` may only be lower). */
  files: 8,
  /** One image's bytes. */
  imageBytes: 5 * 1024 * 1024,
  /** The smallest file that can hold a PNG or WebP header this module reads. */
  imageMinBytes: 32,
  /** Widest or tallest image accepted, in pixels. */
  imageDimension: 16_384,
  /** Routes `.vector/ship.json` may name (each is shot before and after). */
  routes: 4,
  /** A route's characters. */
  routeChars: 200,
  /** A shell command's characters in `.vector/ship.json`. */
  commandChars: 1_000,
  /** The pull request title a card keeps. */
  titleChars: 200,
  /** Check runs a card lists. */
  checks: 20,
  /** `.vector/ship.json`'s bytes. */
  shipJsonBytes: 16 * 1024,
  /** A pull request body this module reads for the run marker (GitHub's own limit is 65,536 characters). */
  bodyChars: 65_536,
} as const

export const TICKET_PREFIX = "vcap_"
/** `vcap_` and 32 random bytes in base64url. */
export const TICKET = /^vcap_[A-Za-z0-9_-]{43}$/
export const CAPTURE_ID = /^cap_[A-Za-z0-9_-]{22}$/
export const CARD_ID = /^crd_[A-Za-z0-9_-]{22}$/

/**
 * A run id of Vector's GitHub agent: `gh-<repositoryId>-<runId>-<runAttempt>-<checkRunId>` (vector-at-mention spec,
 * run tokens and INV-K5), at most 128 characters of `[A-Za-z0-9_.-]`.
 */
export const RUN_ID = /^gh-([1-9]\d{0,19})-[A-Za-z0-9_.-]{1,100}$/

/** The repository id a run id names, or undefined when it is not one of Vector's GitHub run ids. */
export function runRepository(rid: unknown): number | undefined {
  if (typeof rid !== "string" || rid.length > 128) return undefined
  const match = RUN_ID.exec(rid)
  const id = match ? Number(match[1]) : Number.NaN
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

const MARKER = /<!--\s*vector:rid\s+([A-Za-z0-9_.-]{1,128})\s*-->/g

/**
 * The run id in a pull request body's `<!-- vector:rid <rid> -->` marker, which the publish step of Vector's GitHub
 * agent writes. Only a lookup key: Ship Desk reads the verdict from the run record, never from the body. Undefined when
 * there is no marker, a malformed one, or two that disagree.
 */
export function runMarker(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined
  const found = new Set<string>()
  for (const match of body.slice(0, LIMITS.bodyChars).matchAll(MARKER)) found.add(match[1]!)
  if (found.size !== 1) return undefined
  const rid = [...found][0]!
  return runRepository(rid) !== undefined ? rid : undefined
}

export type Slot = "before" | "after"
export type ImageType = "image/png" | "image/webp"
export const IMAGE_TYPES: readonly ImageType[] = ["image/png", "image/webp"]

export function extension(type: ImageType) {
  return type === "image/png" ? "png" : "webp"
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function ascii(bytes: Uint8Array, at: number, text: string) {
  for (let index = 0; index < text.length; index++) if (bytes[at + index] !== text.charCodeAt(index)) return false
  return true
}

/**
 * What an image file is, from its first bytes only (its signature, never a name or a declared type): PNG (the 8-byte
 * signature, then the IHDR chunk) or WebP (RIFF … WEBP, then a VP8, VP8L or VP8X chunk), with its size in pixels.
 * Anything else, SVG included, is undefined. `bytes` needs at least the first 30 bytes.
 */
export function sniffImage(bytes: Uint8Array): { type: ImageType; width: number; height: number } | undefined {
  const fits = (width: number, height: number) =>
    width >= 1 && height >= 1 && width <= LIMITS.imageDimension && height <= LIMITS.imageDimension
  if (bytes.length >= 24 && PNG.every((value, index) => bytes[index] === value) && ascii(bytes, 12, "IHDR")) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    return fits(width, height) ? { type: "image/png", width, height } : undefined
  }
  if (bytes.length >= 30 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    let width = 0
    let height = 0
    if (ascii(bytes, 12, "VP8X")) {
      width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
      height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
    } else if (ascii(bytes, 12, "VP8L")) {
      if (bytes[20] !== 0x2f) return undefined
      width = 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8))
      height = 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10))
    } else if (ascii(bytes, 12, "VP8 ")) {
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
      width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff
      height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff
    } else return undefined
    return fits(width, height) ? { type: "image/webp", width, height } : undefined
  }
  return undefined
}

/** `.vector/ship.json`: how the capture job starts the app and what it shoots (contract §4.15). */
export type ShipJson = {
  install?: string
  build?: string
  start: string
  port: number
  routes: string[]
}

const COMMAND_CHARS = /^[^\u0000-\u0008\u000a-\u001f\u007f]+$/
const ROUTE = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/

/** Whether a route is a plain path on the app (no host, no scheme, no `//`, no spaces or control characters). */
export function validRoute(route: unknown): route is string {
  return typeof route === "string" && route.length <= LIMITS.routeChars && ROUTE.test(route) && !route.includes("\\")
}

/** `.vector/ship.json`, checked by shape. A file that is not this shape captures nothing. */
export function parseShipJson(text: string): ShipJson | undefined {
  if (typeof text !== "string" || text.length > LIMITS.shipJsonBytes) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const file = value as Record<string, unknown>
  const command = (input: unknown) =>
    typeof input === "string" &&
    input.trim().length > 0 &&
    input.length <= LIMITS.commandChars &&
    COMMAND_CHARS.test(input)
  for (const name of ["install", "build"] as const)
    if (file[name] !== undefined && !command(file[name])) return undefined
  if (!command(file.start)) return undefined
  if (!Number.isSafeInteger(file.port) || (file.port as number) < 1024 || (file.port as number) > 65_535)
    return undefined
  const routes = file.routes === undefined ? ["/"] : file.routes
  if (!Array.isArray(routes) || routes.length < 1 || routes.length > LIMITS.routes) return undefined
  if (!routes.every(validRoute) || new Set(routes).size !== routes.length) return undefined
  return {
    ...(typeof file.install === "string" ? { install: file.install } : {}),
    ...(typeof file.build === "string" ? { build: file.build } : {}),
    start: file.start as string,
    port: file.port as number,
    routes: routes as string[],
  }
}

// ── The capture API (`POST /api/ops/uploads`) ──────────────────────────────────────────────────────────────────────

/** `{action: "ticket"}` with the run's own `vrt_` token. */
export type TicketAnswer = { ticket: string; expiresAt: number }

/** `{action: "card", pr}` with the ticket: the pull request the ticket may capture. Starts nothing. */
export type CardAnswer = {
  repository: string
  number: number
  baseRef: string
  baseSha?: string
  headSha: string
  /** Images this capture may upload. */
  files: number
}

export type CaptureFile = { slot: Slot; route: string; bytes: number; type: ImageType }

/** `{action: "start", pr, files}`: opens the window (on the ticket's first use) and signs one upload per file. */
export type StartAnswer = {
  capture: string
  until: number
  uploads: { n: number; url: string; method: "PUT"; headers: Record<string, string>; expiresAt: number }[]
}

/** `{action: "finish", pr, capture}`: each upload checked by its signature and size; the card shows what passed. */
export type FinishAnswer = {
  images: number
  refused: { n: number; reason: "missing" | "size" | "type" }[]
}
