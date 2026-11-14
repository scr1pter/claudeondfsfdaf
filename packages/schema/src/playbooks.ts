export * as Playbooks from "./playbooks.js"

/*
 * Vector Playbooks' names, limits and download listing (WP A36), shared by the server's `GET /api/account/playbooks`,
 * the owner's publish script and the client that installs them (Track B, B07). Browser-safe: no Node imports.
 *
 * A playbook is one saved-workflow JSON file the Vector team maintains. Its name starts with `vector-`, so the client
 * installs it as `workflows/<name>.json` in the person's own config, where B07 keeps a repository's files from
 * shadowing it. A published version never changes: a fix is a higher version.
 */

/** `vector-` and lower-case words joined by hyphens: a saved workflow's name that no person's own workflow takes. */
export const NAME = /^vector-[a-z0-9]+(?:-[a-z0-9]+)*$/
/** A saved workflow's longest name. */
export const NAME_MAX = 64
/** `major.minor.patch`: plain numbers without leading zeros, so a version is also a plain path segment. */
export const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
/** A playbook file's largest size in bytes: a saved workflow's own limit. */
export const MAX_BYTES = 256 * 1024
/** How long a download link lives, in seconds. */
export const LINK_SECONDS = 600
/** The most playbooks one listing names. */
export const MAX_LISTED = 50
/**
 * The fewest published playbooks before `playbooks` can be listed. Contract §1.2 lists Playbooks once two are proven;
 * proving them is the owner's call, and this keeps the perk from ever listing a library with fewer in it.
 */
export const MINIMUM = 2

/** One entry of `GET /api/account/playbooks`: the file at `url` (an R2 link, 10 minutes) has this SHA-256. */
export type Link = { readonly name: string; readonly version: string; readonly sha256: string; readonly url: string }

export function validName(value: unknown): value is string {
  return typeof value === "string" && value.length <= NAME_MAX && NAME.test(value)
}

export function validVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value)
}

export function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. Both must be valid versions. */
export function compareVersions(a: string, b: string) {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! - right[index]!
  return 0
}

/**
 * The listing as a client should read it, or undefined when anything in it is malformed: at most `MAX_LISTED`
 * entries, each with exactly a valid name, version, SHA-256 and an https link, and no name twice. The client still
 * checks the downloaded file's SHA-256 before it writes anything.
 */
export function decodeLinks(value: unknown): Link[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LISTED) return undefined
  const names = new Set<string>()
  const links: Link[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
    const entry = item as Record<string, unknown>
    if (Object.keys(entry).some((key) => !["name", "version", "sha256", "url"].includes(key))) return undefined
    if (!validName(entry.name) || !validVersion(entry.version) || !validSha256(entry.sha256)) return undefined
    if (typeof entry.url !== "string" || !https(entry.url) || names.has(entry.name)) return undefined
    names.add(entry.name)
    links.push({ name: entry.name, version: entry.version, sha256: entry.sha256, url: entry.url })
  }
  return links
}

function https(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
  } catch {
    return false
  }
}
