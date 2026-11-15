import { Playbooks } from "../../packages/schema/src/playbooks.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { stripeMode, type StripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"
import { presignR2, r2Configured, validR2Key } from "./r2-presign.js"

/*
 * Vector Playbooks on the server (WP A36): the library of published playbooks and the download links Pro and up get.
 *
 * - The library is one hash under the Codium prefix, `playbooks`: field = playbook name, value = the published version's
 *   record `{v, name, version, sha256, bytes, key, publishedAt}`. Only the owner's publish script writes it. A record
 *   filed under a field other than its own name is never read, so withdrawing a name always takes it out.
 * - Each version's file is an object in the media bucket at `playbooks/<name>/<version>.json` (test mode:
 *   `playbooks/test/<name>/<version>.json`, so a test publish can never replace a live file), written once. The server
 *   never reads it: a link is a 10-minute presigned GET (`r2-presign.ts`), and the client checks the SHA-256 the listing
 *   gives before it installs anything (B07).
 * - Who may download is the route's decision from the entitlement snapshot (`api/account/playbooks.ts`).
 */

export type PlaybookRecord = {
  readonly v: 1
  readonly name: string
  readonly version: string
  readonly sha256: string
  readonly bytes: number
  readonly key: string
  readonly publishedAt: number
}

type Store = { readonly mode?: StripeMode; readonly fetcher?: typeof fetch }

/** The library's hash, in the server's mode or an explicit one (the owner's script). */
export const playbooksKey = (mode?: StripeMode) => (mode ? codiumKeyIn(mode, "playbooks") : codiumKey("playbooks"))

/** Where a version's file lives in the media bucket, for the library of `mode`. */
export function playbookObjectKey(name: string, version: string, mode: StripeMode = stripeMode()) {
  if (!Playbooks.validName(name) || !Playbooks.validVersion(version))
    throw new Error("That playbook name or version is not valid.")
  return `playbooks/${mode === "test" ? "test/" : ""}${name}/${version}.json`
}

/**
 * A stored record of the library of `mode`, or undefined when anything in it is malformed (such a record is never
 * listed or signed): its file must be exactly where `playbookObjectKey` puts that name and version.
 */
export function decodePlaybookRecord(value: unknown, mode: StripeMode = stripeMode()): PlaybookRecord | undefined {
  let parsed: unknown
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : undefined
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (
    record.v !== 1 ||
    !Playbooks.validName(record.name) ||
    !Playbooks.validVersion(record.version) ||
    !Playbooks.validSha256(record.sha256) ||
    !Number.isSafeInteger(record.bytes) ||
    (record.bytes as number) < 1 ||
    (record.bytes as number) > Playbooks.MAX_BYTES ||
    record.key !== playbookObjectKey(record.name, record.version, mode) ||
    !validR2Key(record.key) ||
    !Number.isSafeInteger(record.publishedAt) ||
    (record.publishedAt as number) <= 0
  )
    return undefined
  return {
    v: 1,
    name: record.name,
    version: record.version,
    sha256: record.sha256,
    bytes: record.bytes as number,
    key: record.key,
    publishedAt: record.publishedAt as number,
  }
}

/**
 * The published playbooks, by name, at most `Playbooks.MAX_LISTED`. Malformed records, and records filed under a field
 * that is not their own name, are left out, so each name is listed once and `withdrawPlaybook` always removes it.
 */
export async function readPlaybooks(options: Store = {}): Promise<PlaybookRecord[]> {
  const flat = await persistentStore(["HGETALL", playbooksKey(options.mode)], options.fetcher ?? fetch)
  if (!Array.isArray(flat)) throw unavailable()
  return flat
    .flatMap((field, index) => {
      if (index % 2) return []
      const record = decodePlaybookRecord(flat[index + 1], options.mode)
      return record && record.name === field ? [record] : []
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .slice(0, Playbooks.MAX_LISTED)
}

/**
 * One playbook's published record, or undefined when it is not published, its record is malformed or the record under
 * that name is another playbook's.
 */
export async function readPlaybook(name: string, options: Store = {}) {
  if (!Playbooks.validName(name)) return undefined
  const record = decodePlaybookRecord(
    await persistentStore(["HGET", playbooksKey(options.mode), name], options.fetcher ?? fetch),
    options.mode,
  )
  return record?.name === name ? record : undefined
}

/**
 * Whether Playbooks can be listed: Track B is live (the client that installs them ships there), the media bucket can
 * be signed, the store is configured, and at least `Playbooks.MINIMUM` playbooks are published. A store that cannot
 * be read counts as not ready.
 */
export async function playbooksReady(fetcher: typeof fetch = fetch) {
  if (process.env.CODIUM_TRACK_B_LIVE !== "true" || !r2Configured("media") || !storeConfigured()) return false
  try {
    return (await readPlaybooks({ fetcher })).length >= Playbooks.MINIMUM
  } catch {
    return false
  }
}

/** The listing `GET /api/account/playbooks` answers: each playbook with a GET link that lives 10 minutes. */
export function playbookLinks(records: readonly PlaybookRecord[], now = Date.now()): Playbooks.Link[] {
  return records.map((record) => ({
    name: record.name,
    version: record.version,
    sha256: record.sha256,
    url: presignR2("media", { method: "GET", key: record.key, expiresIn: Playbooks.LINK_SECONDS, now }).url,
  }))
}

/**
 * What publishing `candidate` would do next to the current record: `new` (first version, or a higher one), `same` (this
 * exact version and file are already published) or a refusal. A published version never changes, and while a playbook
 * stays published the library never goes back to an older version: a fix, or a return to older content, is a higher
 * version. A withdrawn playbook has no current record, so this answers `new` for any version: the bucket still refuses
 * other content at any key it holds (the publish script's HEAD check), and `withdraw` prints the withdrawn version so
 * the next publish can go above it.
 */
export function publishPlan(
  current: PlaybookRecord | undefined,
  candidate: { readonly name: string; readonly version: string; readonly sha256: string },
): { readonly kind: "new" | "same" } | { readonly kind: "refused"; readonly message: string } {
  if (!current) return { kind: "new" }
  const order = Playbooks.compareVersions(candidate.version, current.version)
  if (order > 0) return { kind: "new" }
  if (order === 0 && candidate.sha256 === current.sha256) return { kind: "same" }
  if (order === 0)
    return {
      kind: "refused",
      message: `${candidate.name} ${candidate.version} is already published with other content. A published version never changes: publish a higher version.`,
    }
  return {
    kind: "refused",
    message: `${candidate.name} is at ${current.version}. Publish a version above it; to go back, republish the older content as a higher version.`,
  }
}

/** Records a published version in the library (the owner's script, after the file is in the bucket). */
export async function recordPlaybook(record: PlaybookRecord, options: Store = {}) {
  if (!decodePlaybookRecord(JSON.stringify(record), options.mode)) throw new Error("That playbook record is not valid.")
  await persistentStore(
    ["HSET", playbooksKey(options.mode), record.name, JSON.stringify(record)],
    options.fetcher ?? fetch,
  )
}

/**
 * Takes a playbook out of the library, so no new link is given for it; a link already given expires within 10 minutes.
 * The bucket keeps its files. Answers whether it was listed.
 */
export async function withdrawPlaybook(name: string, options: Store = {}) {
  if (!Playbooks.validName(name)) throw new Error("That playbook name is not valid.")
  return Number(await persistentStore(["HDEL", playbooksKey(options.mode), name], options.fetcher ?? fetch)) > 0
}

function storeConfigured() {
  return Boolean(
    (process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim()) &&
      (process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim()),
  )
}

function unavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected account services are temporarily unavailable.")
}
