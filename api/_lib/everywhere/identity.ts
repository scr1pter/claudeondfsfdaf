import { randomBytes } from "node:crypto"
import {
  ACCOUNT_ID_PATTERN,
  installationPlatform,
  isPlatform,
  isRepositoryName,
  type PlatformId,
} from "../../../packages/schema/src/everywhere.js"
import { EVERYWHERE_PAGE, PLATFORM_NAMES } from "../../../packages/schema/src/everywhere-policy.js"
import { ApiError } from "../http.js"
import { appendAudit } from "./audit.js"
import type { EverywhereConfig } from "./config.js"
import { open, openJson, seal, sealJson, type DataKey } from "./crypto.js"
import { platformFetch, readPlatformJson } from "./fetch.js"
import { KEEP_MS, USER_ID_PATTERNS, everywhereKeys, userIdValid } from "./keys.js"
import { hmacSha256Hex } from "./signature.js"
import {
  addMembers,
  deleteKeys,
  getJson,
  getValue,
  removeMembers,
  runScript,
  setJson,
  setMembers,
  setValue,
  storeInteger,
  storeUnavailable,
  swapValue,
  takeJson,
  type Store,
} from "./store.js"

/*
 * Identity, links, installations and repository mappings (contract 3.8, E2, E13, E16).
 *
 * - An installation (a Slack workspace, a Linear workspace, a Jira site) belongs to the Vector account that connected
 *   it with its own bearer token: the OAuth `state` names that account and the finish must come from it. A re-install
 *   by another account is refused unless the connector disconnected first or the installer administers the place.
 * - A link says a platform user is a given Vector account. It proves both: the account holds a code that only its
 *   signed-in page showed, and the platform user sends it from a private place (a Slack DM, Rovo chat), or the person
 *   signs in to Linear on the link page. A code is single use, lives 10 minutes, is stored only as a keyed hash, works
 *   only on the platform it was made for, and dies when it is posted in a shared place or a newer code is made.
 * - A repository mapping says which repositories a place (a Slack channel, a Linear team, a Jira project) works on. Only
 *   the connector sets it on vectordev.ai; a linked requester may set a place's repository with the `repo` word.
 *
 * Records follow 3.13. Each one has a set that indexes it (`links:<account>`, `linked:<installation>`,
 * `installs:<account>`, `repos:<installation>`), written before the record, so erasing (erase.ts) finds every record
 * without scanning; an index entry whose record is gone or points elsewhere is ignored.
 *
 * Nothing here logs or stores a platform token in the clear, a user token, a link code or message text.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Context and small helpers
// ---------------------------------------------------------------------------------------------------------------------

export type IdentityContext = {
  readonly store: Store
  /** The data key ring (`readConfig().dataKeys`): codes are hashed with it, tokens and notices sealed under it. */
  readonly keys: readonly DataKey[]
  readonly now: number
  /** Tells the account a platform user was linked to it (3.8). Without one, the audit entry is the only notice. */
  readonly notify?: Notifier
}

function invalid(message = "This request is not valid."): never {
  throw new ApiError(400, "EVERYWHERE_INVALID", message)
}

function off(): ApiError {
  return new ApiError(503, "EVERYWHERE_OFF", "Vector everywhere is not available right now.")
}

function isRecord(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.keys(value).every((field) => allowed.includes(field))
}

function isAccount(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value)
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function accountId(value: unknown): string {
  if (!isAccount(value)) invalid()
  return value.toLowerCase()
}

/** The platform of a well-formed installation key; a malformed one is refused. */
function platformOf(installation: unknown): PlatformId {
  const platform = installationPlatform(installation)
  if (!platform) invalid()
  return platform
}

function checkUser(installation: string, userId: unknown): string {
  if (typeof userId !== "string" || !userIdValid(installation, userId)) invalid()
  return userId
}

function parseStored(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** A set member that names a link: its installation and user id, as JSON so neither can be read into the other. */
export function linkMember(installation: string, userId: string) {
  return JSON.stringify([installation, userId])
}

/** The installation and user id from a `links:<account>` member, when it is well formed. */
export function parseLinkMember(member: string): { installation: string; userId: string } | undefined {
  const parsed = parseStored(member)
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
  const [installation, userId] = parsed
  if (typeof installation !== "string" || typeof userId !== "string" || !userIdValid(installation, userId))
    return undefined
  return { installation, userId }
}

/** "a•••@example.com": enough for a person to recognise their own account, and no more (3.8). */
export function maskEmail(email: unknown): string | undefined {
  if (typeof email !== "string") return undefined
  const match = /^([^\s@])[^\s@]*@([^\s@]+\.[^\s@]+)$/u.exec(email.trim().toLowerCase())
  return match ? `${match[1]}•••@${match[2]}` : undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------------------------------------------------

/** 32 letters: digits and capitals without I, L, O and U, so a code read aloud or retyped is not misread. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** A link code: 8 characters (3.8). */
export const LINK_CODE_CHARS = 8
/** A Jira site connect code: 12 characters, typed once by an admin on vectordev.ai (3.8). */
export const CONNECT_CODE_CHARS = 12

function randomCode(length: number) {
  // 256 is a multiple of 32, so masking each byte keeps every letter equally likely.
  let out = ""
  for (const byte of randomBytes(length)) out += CODE_ALPHABET.charAt(byte & 31)
  return out
}

/** Groups of four with hyphens between, as the page shows a code. */
export function formatCode(code: string) {
  return code.match(/.{1,4}/g)?.join("-") ?? code
}

/**
 * A code as a person typed it: any case, with spaces or hyphens between groups, and the look-alike letters O, I and L
 * read as 0, 1 and 1. Anything else, or the wrong length, is not a code.
 */
export function normalizeCode(text: unknown, length: number): string | undefined {
  if (typeof text !== "string" || text.length > 64) return undefined
  const compact = text.trim().toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1")
  if (compact.length !== length) return undefined
  for (const letter of compact) if (!CODE_ALPHABET.includes(letter)) return undefined
  return compact
}

/**
 * A code's store id: an HMAC under the data key rather than a plain hash, so a copy of the store does not give the
 * codes away (an 8-letter code has only 40 bits).
 */
function codeHash(keys: readonly DataKey[], kind: "link" | "connect", code: string) {
  const key = keys[0]
  if (!key) throw off()
  return hmacSha256Hex(key.key, `vector-everywhere-${kind}-code\0`, code)
}

// ---------------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------------

/** `link:<installation>:<userId>` (3.13). */
export type LinkRecord = { readonly account: string; readonly linkedAt: number }

function decodeLink(value: unknown): LinkRecord | undefined {
  if (!isRecord(value, ["account", "linkedAt"])) return undefined
  if (!isAccount(value.account) || !isTime(value.linkedAt)) return undefined
  return { account: value.account.toLowerCase(), linkedAt: value.linkedAt }
}

/** `install:<installation>` (3.13). `tokenEnc` is sealed to this key; Jira sites keep no token. */
export type InstallRecord = {
  readonly connector: string
  readonly tokenEnc?: string
  readonly scopes: readonly string[]
  readonly botUserId?: string
  readonly installedAt: number
  /** Jira: the Forge app installation id the site's invocation tokens carry (4.4). */
  readonly forgeInstallationId?: string
}

const SCOPE = /^[A-Za-z0-9:._-]{1,64}$/
const MAX_SCOPES = 64
const FORGE_INSTALLATION = /^[\x21-\x7e]{1,256}$/
const TOKEN = /^[\x21-\x7e]{1,8192}$/

function decodeInstall(platform: PlatformId) {
  return (value: unknown): InstallRecord | undefined => {
    if (!isRecord(value, ["connector", "tokenEnc", "scopes", "botUserId", "installedAt", "forgeInstallationId"]))
      return undefined
    const { connector, tokenEnc, scopes, botUserId, installedAt, forgeInstallationId } = value
    if (!isAccount(connector) || !isTime(installedAt)) return undefined
    if (tokenEnc !== undefined && typeof tokenEnc !== "string") return undefined
    if (
      !Array.isArray(scopes) ||
      scopes.length > MAX_SCOPES ||
      !scopes.every((scope) => typeof scope === "string" && SCOPE.test(scope))
    )
      return undefined
    if (botUserId !== undefined && (typeof botUserId !== "string" || !USER_ID_PATTERNS[platform].test(botUserId)))
      return undefined
    if (
      forgeInstallationId !== undefined &&
      (typeof forgeInstallationId !== "string" || !FORGE_INSTALLATION.test(forgeInstallationId))
    )
      return undefined
    return {
      connector: connector.toLowerCase(),
      ...(tokenEnc !== undefined ? { tokenEnc } : {}),
      scopes: [...scopes] as string[],
      ...(botUserId !== undefined ? { botUserId } : {}),
      installedAt,
      ...(forgeInstallationId !== undefined ? { forgeInstallationId } : {}),
    }
  }
}

/** `linkcode:<hash>`: the account it links to, the platform it works on, and the account's sealed e-mail. */
type LinkCodeRecord = {
  readonly account: string
  readonly platform: PlatformId
  readonly installation?: string
  readonly issuedAt: number
  readonly noticeEnc?: string
}

function decodeLinkCode(value: unknown): LinkCodeRecord | undefined {
  if (!isRecord(value, ["account", "platform", "installation", "issuedAt", "noticeEnc"])) return undefined
  const { account, platform, installation, issuedAt, noticeEnc } = value
  if (!isAccount(account) || !isPlatform(platform) || !isTime(issuedAt)) return undefined
  if (installation !== undefined && installationPlatform(installation) !== platform) return undefined
  if (noticeEnc !== undefined && typeof noticeEnc !== "string") return undefined
  return {
    account: account.toLowerCase(),
    platform,
    ...(installation !== undefined ? { installation: installation as string } : {}),
    issuedAt,
    ...(noticeEnc !== undefined ? { noticeEnc } : {}),
  }
}

/** `connectcode:<hash>`: a Jira site connect code, bound to the admin who passed the check and the site (3.8). */
type ConnectCodeRecord = {
  readonly cloudId: string
  readonly accountId: string
  readonly forgeInstallationId?: string
  readonly issuedAt: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function decodeConnectCode(value: unknown): ConnectCodeRecord | undefined {
  if (!isRecord(value, ["cloudId", "accountId", "forgeInstallationId", "issuedAt"])) return undefined
  const { cloudId, accountId, forgeInstallationId, issuedAt } = value
  if (typeof cloudId !== "string" || !UUID.test(cloudId) || !isTime(issuedAt)) return undefined
  if (typeof accountId !== "string" || !USER_ID_PATTERNS.jira.test(accountId)) return undefined
  if (
    forgeInstallationId !== undefined &&
    (typeof forgeInstallationId !== "string" || !FORGE_INSTALLATION.test(forgeInstallationId))
  )
    return undefined
  return {
    cloudId: cloudId.toLowerCase(),
    accountId,
    ...(forgeInstallationId !== undefined ? { forgeInstallationId } : {}),
    issuedAt,
  }
}

export const OAUTH_PURPOSES = ["install", "link"] as const
export type OAuthPurpose = (typeof OAUTH_PURPOSES)[number]

/** `state:<id>`: an OAuth state (3.8). Ids and a purpose only, no personal data. */
export type OAuthState = {
  readonly account: string
  readonly platform: PlatformId
  readonly purpose: OAuthPurpose
  /** The installation the install started for, when the page knew it (4.2: the team must match after the exchange). */
  readonly installation?: string
  readonly issuedAt: number
}

function decodeState(value: unknown): OAuthState | undefined {
  if (!isRecord(value, ["account", "platform", "purpose", "installation", "issuedAt"])) return undefined
  const { account, platform, purpose, installation, issuedAt } = value
  if (!isAccount(account) || !isPlatform(platform) || !isTime(issuedAt)) return undefined
  if (!(OAUTH_PURPOSES as readonly unknown[]).includes(purpose)) return undefined
  if (installation !== undefined && installationPlatform(installation) !== platform) return undefined
  return {
    account: account.toLowerCase(),
    platform,
    purpose: purpose as OAuthPurpose,
    ...(installation !== undefined ? { installation: installation as string } : {}),
    issuedAt,
  }
}

/** A repository as the server knows it: `owner/name`, and GitHub's id once it is known (3.8). */
export type RepoRef = { readonly fullName: string; readonly id?: number }

/** A place's mapping, as the rest of the server reads it. */
export type RepoMapping = {
  readonly place: string
  readonly repositories: readonly RepoRef[]
  /** The Vector account that set it. */
  readonly setBy: string
  /** The connector marked this Linear team or Jira project private, so it is not a shared place (1). */
  readonly private: boolean
  readonly setAt: number
}

/** A place: a Slack channel id, a Linear team id or a Jira project key. */
export const PLACE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** A Linear team may map several repositories (3.8); 20 is far more than a team works on. */
export const MAX_MAPPED_REPOSITORIES = 20

/** `repo:<installation>:<place>` as stored: 3.13's fields, with `null` for a repository id not known yet. */
function decodeMapping(place: string) {
  return (value: unknown): RepoMapping | undefined => {
    if (!isRecord(value, ["repositoryIds", "fullNames", "setBy", "private", "setAt"])) return undefined
    const { repositoryIds, fullNames, setBy, setAt } = value
    if (!Array.isArray(repositoryIds) || !Array.isArray(fullNames) || repositoryIds.length !== fullNames.length)
      return undefined
    if (fullNames.length > MAX_MAPPED_REPOSITORIES || !isAccount(setBy) || !isTime(setAt)) return undefined
    if (typeof value.private !== "boolean") return undefined
    const repositories: RepoRef[] = []
    for (let index = 0; index < fullNames.length; index++) {
      const fullName = fullNames[index]
      const id = repositoryIds[index]
      if (!isRepositoryName(fullName)) return undefined
      if (id !== null && !(typeof id === "number" && Number.isSafeInteger(id) && id > 0)) return undefined
      repositories.push(id === null ? { fullName } : { fullName, id })
    }
    return { place, repositories, setBy: setBy.toLowerCase(), private: value.private, setAt }
  }
}

function encodeMapping(mapping: Omit<RepoMapping, "place">) {
  return {
    repositoryIds: mapping.repositories.map((repository) => repository.id ?? null),
    fullNames: mapping.repositories.map((repository) => repository.fullName),
    setBy: mapping.setBy,
    private: mapping.private,
    setAt: mapping.setAt,
  }
}

/** Checks a list of repositories: well-formed names, positive ids, at most 20, no name twice. */
export function checkRepositories(input: unknown): RepoRef[] | undefined {
  if (!Array.isArray(input) || input.length > MAX_MAPPED_REPOSITORIES) return undefined
  const seen = new Set<string>()
  const out: RepoRef[] = []
  for (const item of input) {
    if (!isRecord(item, ["fullName", "id"])) return undefined
    const { fullName, id } = item
    if (!isRepositoryName(fullName)) return undefined
    if (id !== undefined && !(typeof id === "number" && Number.isSafeInteger(id) && id > 0)) return undefined
    const folded = fullName.toLowerCase()
    if (seen.has(folded)) return undefined
    seen.add(folded)
    out.push(id === undefined ? { fullName } : { fullName, id: id as number })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------------------------------------------------

/** What the account is told after a link (3.8): ids and the place, never a display name or message text. */
export type LinkNotice = {
  readonly account: string
  /** The account's address, from its own signed-in session; absent when it is not known. */
  readonly email?: string
  readonly platform: PlatformId
  readonly installation: string
  readonly userId: string
}

export type Notifier = (notice: LinkNotice) => Promise<void>

/**
 * The e-mail half of the link notice (the vectordev.ai half is the `link` entry in the account's audit log, which the
 * page shows with an unlink button). Sent through the site's existing mail sender when it is configured; otherwise
 * nothing is sent. A failure is logged by code only and never undoes the link.
 */
export function emailNotifier(env: Readonly<Record<string, string | undefined>> = process.env): Notifier {
  return async (notice) => {
    const apiKey = env.RESEND_API_KEY?.trim()
    const from = env.VECTOR_PURCHASE_EMAIL_FROM?.trim()
    if (!apiKey || !from || !notice.email) return
    const name = PLATFORM_NAMES[notice.platform]
    const text = [
      `A ${name} user (id ${notice.userId}) in ${notice.installation} is now linked to your Vector account.`,
      `Requests that user makes to Vector in ${name} can now run on your computer.`,
      "",
      `If this was not you, unlink it at https://${EVERYWHERE_PAGE}.`,
    ].join("\n")
    try {
      const { Resend } = await import("resend")
      const result = await new Resend(apiKey).emails.send({
        from,
        to: notice.email,
        subject: `Vector everywhere: a ${name} account was linked`,
        text,
      })
      if (result.error) console.error("Vector everywhere: the link notice was not sent", { code: "email-refused" })
    } catch {
      console.error("Vector everywhere: the link notice was not sent", { code: "email-failed" })
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------------------------

/** Platforms whose people link by sending a code to the bot in a private place (3.8). */
export const CODE_LINK_PLATFORMS = ["slack", "jira"] as const
/** Platforms whose people link by signing in on the link page (3.8: Linear; Jira only if Rovo chat cannot carry codes). */
export const SIGN_IN_LINK_PLATFORMS = ["linear", "jira"] as const

/** The platform user behind a link attempt, as the platform's verified event or sign-in describes them. */
export type LinkActor = {
  readonly bot: boolean
  readonly external: boolean
  readonly guest: boolean
  /** A Jira automation or a Linear app user. */
  readonly automation?: boolean
}

export type LinkRefusal =
  | "shared-place"
  | "link-invalid"
  | "bot"
  | "automation"
  | "external"
  | "guest"
  | "not-connected"

export type LinkVerdict =
  | {
      readonly ok: true
      readonly account: string
      /** "a•••@example.com", for the platform user's private notice; absent when the address is not known. */
      readonly hint?: string
      /** The identity was already linked to this account; nothing changed. */
      readonly already: boolean
      /** The account the identity was linked to before, when the person moved the link. */
      readonly previous?: string
    }
  | { readonly ok: false; readonly code: LinkRefusal }

function actorRefusal(actor: LinkActor): "bot" | "automation" | "external" | "guest" | undefined {
  if (actor.bot) return "bot"
  if (actor.automation) return "automation"
  if (actor.external) return "external"
  if (actor.guest) return "guest"
  return undefined
}

/** Failed link code attempts one platform user may make in an hour before every attempt is refused. */
export const LINK_TRIES_MAX = 10

/** Counts a failed attempt; the counter's hour starts at the first. KEYS: the counter. ARGV: its lifetime. */
export const LINK_TRIES_SCRIPT =
  "local count = redis.call('INCR', KEYS[1]) if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return count"

async function triesLeft(store: Store, installation: string, userId: string) {
  const raw = await getValue(store, everywhereKeys.linkTries(installation, userId))
  return raw === undefined || storeInteger(raw) < LINK_TRIES_MAX
}

async function countTry(store: Store, installation: string, userId: string) {
  storeInteger(
    await runScript(store, LINK_TRIES_SCRIPT, [everywhereKeys.linkTries(installation, userId)], [KEEP_MS.linkTries]),
  )
}

/**
 * Makes a link code for the signed-in account (3.8). The code works only on `platform` (and only in `installation`,
 * when the page names one), for 10 minutes, once. Making a new code ends the account's older one. The account's e-mail
 * is sealed into the record for the link notice and is gone with the code.
 */
export async function issueLinkCode(
  ctx: IdentityContext,
  input: {
    readonly account: string
    readonly email?: string
    readonly platform: PlatformId
    readonly installation?: string
  },
): Promise<{ readonly code: string; readonly expiresAt: number }> {
  const account = accountId(input.account)
  if (!(CODE_LINK_PLATFORMS as readonly string[]).includes(input.platform))
    throw new ApiError(400, "EVERYWHERE_UNSUPPORTED", "Links on this platform are made by signing in, not with a code.")
  if (input.installation !== undefined && installationPlatform(input.installation) !== input.platform) invalid()
  const pointer = everywhereKeys.linkCodes(account)
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = randomCode(LINK_CODE_CHARS)
    const hash = codeHash(ctx.keys, "link", code)
    const key = everywhereKeys.linkCode(hash)
    const record: LinkCodeRecord = {
      account,
      platform: input.platform,
      ...(input.installation !== undefined ? { installation: input.installation } : {}),
      issuedAt: ctx.now,
      ...(input.email ? { noticeEnc: sealJson(ctx.keys, { email: input.email }, key) } : {}),
    }
    if (!(await setJson(ctx.store, key, record, { ttlMs: KEEP_MS.linkCode, onlyNew: true }))) continue
    const previous = await getValue(ctx.store, pointer)
    await setValue(ctx.store, pointer, hash, { ttlMs: KEEP_MS.linkCode })
    if (previous !== undefined && previous !== hash && /^[0-9a-f]{64}$/.test(previous))
      await deleteKeys(ctx.store, everywhereKeys.linkCode(previous))
    return { code: formatCode(code), expiresAt: ctx.now + KEEP_MS.linkCode }
  }
  throw storeUnavailable()
}

/**
 * Redeems a link code a platform user sent to the bot (3.8). `installation` and `userId` come from the platform's
 * verified event; `place` says whether the message was private (a Slack DM, Rovo chat) or in a place others read.
 *
 * - A code sent in a shared place is burned and refused, whoever sent it.
 * - Any other attempt that names a live code uses it up, whatever the answer.
 * - The code must be the account's newest, made for this platform (and this installation when it names one).
 * - Bots, automations, external users and guests are refused; so is an installation nobody connected.
 * - After 10 failed attempts in an hour the platform user is refused without any code being read.
 */
export async function redeemLinkCode(
  ctx: IdentityContext,
  input: {
    readonly code: string
    readonly installation: string
    readonly userId: string
    readonly place: "private" | "shared"
    readonly actor: LinkActor
  },
): Promise<LinkVerdict> {
  const platform = platformOf(input.installation)
  const userId = checkUser(input.installation, input.userId)
  const code = normalizeCode(input.code, LINK_CODE_CHARS)
  const refuse = (reason: LinkRefusal): LinkVerdict => ({ ok: false, code: reason })

  if (input.place !== "private") {
    if (code) await deleteKeys(ctx.store, everywhereKeys.linkCode(codeHash(ctx.keys, "link", code)))
    return refuse("shared-place")
  }
  if (!(await triesLeft(ctx.store, input.installation, userId))) return refuse("link-invalid")
  const failed = async () => {
    await countTry(ctx.store, input.installation, userId)
    return refuse("link-invalid")
  }
  if (!code) return failed()
  const hash = codeHash(ctx.keys, "link", code)
  const key = everywhereKeys.linkCode(hash)
  const found = await takeJson(ctx.store, key, decodeLinkCode)
  if (!found) return failed()
  const pointer = everywhereKeys.linkCodes(found.account)
  if ((await getValue(ctx.store, pointer)) !== hash) return failed()
  await swapValue(ctx.store, pointer, hash, undefined)
  if (found.platform !== platform || (found.installation !== undefined && found.installation !== input.installation))
    return failed()
  const refusal = actorRefusal(input.actor)
  if (refusal) return refuse(refusal)
  if (!(await findInstall(ctx.store, input.installation))) return refuse("not-connected")
  let email: string | undefined
  if (found.noticeEnc) {
    const opened = openJson(ctx.keys, found.noticeEnc, key, (value) =>
      isRecord(value, ["email"]) && typeof value.email === "string" ? value.email : undefined,
    )
    if (opened.ok) email = opened.value
  }
  return writeLink(ctx, { account: found.account, installation: input.installation, userId, platform, email })
}

/**
 * Links the platform user a sign-in on the link page proved (3.8: Linear's `viewer.id` and organization) to the
 * signed-in Vector account. The caller has already checked that the sign-in was started by this same account.
 */
export async function linkBySignIn(
  ctx: IdentityContext,
  input: {
    readonly account: string
    readonly email?: string
    readonly installation: string
    readonly userId: string
    readonly actor: LinkActor
  },
): Promise<LinkVerdict> {
  const account = accountId(input.account)
  const platform = platformOf(input.installation)
  const userId = checkUser(input.installation, input.userId)
  if (!(SIGN_IN_LINK_PLATFORMS as readonly string[]).includes(platform))
    throw new ApiError(400, "EVERYWHERE_UNSUPPORTED", "Links on this platform are made with a code.")
  const refusal = actorRefusal(input.actor)
  if (refusal) return { ok: false, code: refusal }
  if (!(await findInstall(ctx.store, input.installation))) return { ok: false, code: "not-connected" }
  return writeLink(ctx, { account, installation: input.installation, userId, platform, email: input.email })
}

async function writeLink(
  ctx: IdentityContext,
  input: {
    readonly account: string
    readonly installation: string
    readonly userId: string
    readonly platform: PlatformId
    readonly email?: string
  },
): Promise<LinkVerdict> {
  const { account, installation, userId, platform } = input
  const key = everywhereKeys.link(installation, userId)
  const member = linkMember(installation, userId)
  const hint = maskEmail(input.email)
  // The indexes first: a record is never written without the entries that let erase find it.
  await addMembers(ctx.store, everywhereKeys.links(account), member)
  await addMembers(ctx.store, everywhereKeys.linked(installation), userId)
  const next = JSON.stringify({ account, linkedAt: ctx.now } satisfies LinkRecord)
  let previous: LinkRecord | undefined
  for (let attempt = 0; ; attempt++) {
    if (attempt === 5) throw storeUnavailable()
    const raw = await getValue(ctx.store, key)
    previous = decodeLink(parseStored(raw))
    if (previous?.account === account) return { ok: true, account, already: true, ...(hint ? { hint } : {}) }
    if (await swapValue(ctx.store, key, raw, next)) break
  }
  if (previous) {
    await dropLinkIndexes(ctx.store, installation, userId, previous.account, { linked: false })
    await appendAudit(
      ctx.store,
      previous.account,
      { event: "unlink", platform, installation, userId, code: "unlinked" },
      ctx.now,
    )
  }
  await appendAudit(ctx.store, account, { event: "link", platform, installation, userId }, ctx.now)
  if (ctx.notify) {
    await ctx
      .notify({ account, ...(input.email ? { email: input.email } : {}), platform, installation, userId })
      .catch(() => console.error("Vector everywhere: the link notice was not sent", { code: "notify-failed" }))
  }
  return {
    ok: true,
    account,
    already: false,
    ...(hint ? { hint } : {}),
    ...(previous ? { previous: previous.account } : {}),
  }
}

/**
 * Removes a link's index entries for `account`, then puts back any that a link written in the meantime still needs,
 * so an index never loses an entry for a live record.
 */
async function dropLinkIndexes(
  store: Store,
  installation: string,
  userId: string,
  account: string,
  options: { readonly linked: boolean },
) {
  await removeMembers(store, everywhereKeys.links(account), linkMember(installation, userId))
  if (options.linked) await removeMembers(store, everywhereKeys.linked(installation), userId)
  const now = decodeLink(parseStored(await getValue(store, everywhereKeys.link(installation, userId))))
  if (!now) return
  if (now.account === account) await addMembers(store, everywhereKeys.links(account), linkMember(installation, userId))
  if (options.linked) await addMembers(store, everywhereKeys.linked(installation), userId)
}

/** The Vector account a platform user linked on an installation, or undefined when there is no link. */
export async function findLink(store: Store, installation: string, userId: string): Promise<LinkRecord | undefined> {
  return getJson(store, everywhereKeys.link(installation, checkUser(installation, userId)), decodeLink)
}

export type LinkView = {
  readonly installation: string
  readonly platform: PlatformId
  readonly userId: string
  readonly linkedAt: number
}

/** The account's links, oldest first. Index entries whose record is gone or points elsewhere are left out. */
export async function listLinks(store: Store, account: string): Promise<LinkView[]> {
  const owner = accountId(account)
  const links: LinkView[] = []
  for (const member of await setMembers(store, everywhereKeys.links(owner))) {
    const parsed = parseLinkMember(member)
    if (!parsed) continue
    const record = decodeLink(
      parseStored(await getValue(store, everywhereKeys.link(parsed.installation, parsed.userId))),
    )
    if (record?.account !== owner) continue
    links.push({
      installation: parsed.installation,
      platform: platformOf(parsed.installation),
      userId: parsed.userId,
      linkedAt: record.linkedAt,
    })
  }
  return links.sort((a, b) => a.linkedAt - b.linkedAt || (a.installation < b.installation ? -1 : 1))
}

/**
 * Removes a link: from vectordev.ai (pass `account`, and only that account's own link goes) or with the `unlink` word
 * (the platform user's verified id is enough). Answers the account the link pointed to, or `ok: false` when there was
 * no such link.
 */
export async function unlink(
  ctx: IdentityContext,
  input: { readonly installation: string; readonly userId: string; readonly account?: string },
): Promise<{ readonly ok: true; readonly account: string } | { readonly ok: false }> {
  const platform = platformOf(input.installation)
  const userId = checkUser(input.installation, input.userId)
  const owner = input.account === undefined ? undefined : accountId(input.account)
  const key = everywhereKeys.link(input.installation, userId)
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await getValue(ctx.store, key)
    const record = decodeLink(parseStored(raw))
    if (!record || (owner !== undefined && record.account !== owner)) return { ok: false }
    if (!(await swapValue(ctx.store, key, raw, undefined))) continue
    await dropLinkIndexes(ctx.store, input.installation, userId, record.account, { linked: true })
    await appendAudit(
      ctx.store,
      record.account,
      { event: "unlink", platform, installation: input.installation, userId, code: "unlinked" },
      ctx.now,
    )
    return { ok: true, account: record.account }
  }
  throw storeUnavailable()
}

// ---------------------------------------------------------------------------------------------------------------------
// OAuth states
// ---------------------------------------------------------------------------------------------------------------------

const STATE_ID = /^[A-Za-z0-9_-]{16,128}$/

/** A random OAuth state for the signed-in account, kept 10 minutes (3.8). */
export async function createState(
  ctx: Pick<IdentityContext, "store" | "now">,
  input: {
    readonly account: string
    readonly platform: PlatformId
    readonly purpose: OAuthPurpose
    readonly installation?: string
  },
): Promise<{ readonly state: string; readonly expiresAt: number }> {
  const account = accountId(input.account)
  if (input.installation !== undefined && installationPlatform(input.installation) !== input.platform) invalid()
  const record: OAuthState = {
    account,
    platform: input.platform,
    purpose: input.purpose,
    ...(input.installation !== undefined ? { installation: input.installation } : {}),
    issuedAt: ctx.now,
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = randomBytes(24).toString("base64url")
    if (await setJson(ctx.store, everywhereKeys.state(state), record, { ttlMs: KEEP_MS.state, onlyNew: true }))
      return { state, expiresAt: ctx.now + KEEP_MS.state }
  }
  throw storeUnavailable()
}

/** Reads and deletes a state in one step: it works once, and an unknown or expired one answers undefined. */
export async function takeState(store: Store, state: unknown): Promise<OAuthState | undefined> {
  if (typeof state !== "string" || !STATE_ID.test(state)) return undefined
  return takeJson(store, everywhereKeys.state(state), decodeState)
}

/** Where each platform's OAuth starts and returns (4.2, 4.3), and the scopes each purpose asks for. */
export const OAUTH = {
  slack: {
    authorize: "https://slack.com/oauth/v2/authorize",
    redirect: "https://vectordev.ai/api/slack/oauth",
    scopes: {
      install: [
        "app_mentions:read",
        "chat:write",
        "assistant:write",
        "im:history",
        "users:read",
        "channels:history",
        "groups:history",
      ],
    },
  },
  linear: {
    authorize: "https://linear.app/oauth/authorize",
    redirect: "https://vectordev.ai/api/linear/oauth",
    scopes: { install: ["read", "write", "app:assignable", "app:mentionable"], link: ["read"] },
  },
} as const

/** The platform's authorize URL for a state, or undefined when the platform has no OAuth for that purpose. */
export function oauthUrl(
  config: EverywhereConfig,
  input: { readonly platform: PlatformId; readonly purpose: OAuthPurpose; readonly state: string },
) {
  if (input.platform === "slack" && input.purpose === "install" && config.slack) {
    const url = new URL(OAUTH.slack.authorize)
    url.searchParams.set("client_id", config.slack.clientId)
    url.searchParams.set("scope", OAUTH.slack.scopes.install.join(","))
    url.searchParams.set("redirect_uri", OAUTH.slack.redirect)
    url.searchParams.set("state", input.state)
    return url.href
  }
  if (input.platform === "linear" && config.linear) {
    const url = new URL(OAUTH.linear.authorize)
    url.searchParams.set("client_id", config.linear.clientId)
    url.searchParams.set("redirect_uri", OAUTH.linear.redirect)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("scope", OAUTH.linear.scopes[input.purpose].join(","))
    url.searchParams.set("state", input.state)
    // An install acts as the workspace's app user and needs an admin; a link signs in as the person (3.8, 4.3).
    url.searchParams.set("actor", input.purpose === "install" ? "app" : "user")
    return url.href
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Installations
// ---------------------------------------------------------------------------------------------------------------------

/** What a platform's OAuth exchange (or a Jira connect code) gives when an installation is made. */
export type InstallGrant = {
  readonly installation: string
  /** The platform token. Sealed to the installation's record; never returned or logged. */
  readonly token?: string
  readonly scopes: readonly string[]
  readonly botUserId?: string
  readonly forgeInstallationId?: string
  /**
   * The platform user who installed, and whether the platform says they administer the place: Slack `is_admin` or
   * `is_owner`; every Linear `actor=app` install; every Jira connect code (it is issued only after the ADMINISTER check).
   */
  readonly installer: { readonly userId?: string; readonly admin: boolean }
}

export type InstallVerdict =
  | {
      readonly ok: true
      readonly installation: string
      /** `new`, `renewed` by the same connector, or `connector-change` by a platform admin. */
      readonly change: "new" | "renewed" | "connector-change"
      /** The connector before a connector change. */
      readonly previous?: string
    }
  | { readonly ok: false; readonly code: "installed-elsewhere" }

function checkGrant(grant: InstallGrant): PlatformId {
  const platform = platformOf(grant.installation)
  if (
    !Array.isArray(grant.scopes) ||
    grant.scopes.length > MAX_SCOPES ||
    !grant.scopes.every((scope) => SCOPE.test(scope))
  )
    invalid()
  if (grant.token !== undefined && (typeof grant.token !== "string" || !TOKEN.test(grant.token))) invalid()
  if (grant.botUserId !== undefined && !USER_ID_PATTERNS[platform].test(grant.botUserId)) invalid()
  if (grant.forgeInstallationId !== undefined && !FORGE_INSTALLATION.test(grant.forgeInstallationId)) invalid()
  if (grant.installer.userId !== undefined && !USER_ID_PATTERNS[platform].test(grant.installer.userId)) invalid()
  return platform
}

/**
 * Records an installation for the account that finished it (3.8). A first install, or a re-install by the same
 * connector, is recorded. A re-install by another account is refused unless the installer administers the place, in
 * which case the connector changes and both accounts' logs say so. After the connector disconnects there is no record,
 * so anyone may install again.
 */
export async function recordInstall(
  ctx: IdentityContext,
  input: { readonly account: string; readonly grant: InstallGrant; readonly event: "install" | "connect" },
): Promise<InstallVerdict> {
  const account = accountId(input.account)
  const platform = checkGrant(input.grant)
  const { installation } = input.grant
  const key = everywhereKeys.install(installation)
  await addMembers(ctx.store, everywhereKeys.installs(account), installation)
  let current: InstallRecord | undefined
  for (let attempt = 0; ; attempt++) {
    if (attempt === 5) throw storeUnavailable()
    const raw = await getValue(ctx.store, key)
    current = decodeInstall(platform)(parseStored(raw))
    if (current && current.connector !== account && !input.grant.installer.admin) {
      await dropInstallIndex(ctx.store, installation, account)
      return { ok: false, code: "installed-elsewhere" }
    }
    const record: InstallRecord = {
      connector: account,
      ...(input.grant.token !== undefined ? { tokenEnc: seal(ctx.keys, input.grant.token, key) } : {}),
      scopes: [...input.grant.scopes],
      ...(input.grant.botUserId !== undefined ? { botUserId: input.grant.botUserId } : {}),
      installedAt: ctx.now,
      ...(input.grant.forgeInstallationId !== undefined
        ? { forgeInstallationId: input.grant.forgeInstallationId }
        : {}),
    }
    if (await swapValue(ctx.store, key, raw, JSON.stringify(record))) break
  }
  const change = !current ? "new" : current.connector === account ? "renewed" : "connector-change"
  if (change === "connector-change" && current) {
    await dropInstallIndex(ctx.store, installation, current.connector)
    await appendAudit(
      ctx.store,
      current.connector,
      {
        event: "connector-change",
        platform,
        installation,
        actor: account,
        code: "admin",
        ...(input.grant.installer.userId !== undefined ? { userId: input.grant.installer.userId } : {}),
      },
      ctx.now,
    )
  }
  await appendAudit(
    ctx.store,
    account,
    { event: input.event, platform, installation, ...(change === "connector-change" ? { code: "admin" } : {}) },
    ctx.now,
  )
  return {
    ok: true,
    installation,
    change,
    ...(change === "connector-change" && current ? { previous: current.connector } : {}),
  }
}

/** Removes an installation from an account's index unless the account is (again) its connector. */
async function dropInstallIndex(store: Store, installation: string, account: string) {
  await removeMembers(store, everywhereKeys.installs(account), installation)
  const now = await readInstall(store, installation)
  if (now?.connector === account) await addMembers(store, everywhereKeys.installs(account), installation)
}

/** An installation's record, or undefined when nobody connected it. A record that does not decode reads as none. */
export async function readInstall(store: Store, installation: string): Promise<InstallRecord | undefined> {
  const platform = platformOf(installation)
  return decodeInstall(platform)(parseStored(await getValue(store, everywhereKeys.install(installation))))
}

/** An installation's record; a record that does not decode means the store is unwell (fails closed). */
export async function findInstall(store: Store, installation: string): Promise<InstallRecord | undefined> {
  return getJson(store, everywhereKeys.install(installation), decodeInstall(platformOf(installation)))
}

/** The platform token of an installation, opened only where it is used. Never logged, never sent to a computer. */
export function installToken(
  keys: readonly DataKey[],
  installation: string,
  record: InstallRecord,
): string | undefined {
  if (!record.tokenEnc) return undefined
  const opened = open(keys, record.tokenEnc, everywhereKeys.install(installation))
  return opened.ok ? opened.value : undefined
}

export type InstallView = {
  readonly installation: string
  readonly platform: PlatformId
  readonly installedAt: number
  readonly scopes: readonly string[]
  readonly botUserId?: string
}

/** The installations the account connected. Never a token. */
export async function listInstalls(store: Store, account: string): Promise<InstallView[]> {
  const owner = accountId(account)
  const out: InstallView[] = []
  for (const installation of await setMembers(store, everywhereKeys.installs(owner))) {
    const platform = installationPlatform(installation)
    if (!platform) continue
    const record = await readInstall(store, installation)
    if (record?.connector !== owner) continue
    out.push({
      installation,
      platform,
      installedAt: record.installedAt,
      scopes: record.scopes,
      ...(record.botUserId !== undefined ? { botUserId: record.botUserId } : {}),
    })
  }
  return out.sort((a, b) => a.installedAt - b.installedAt || (a.installation < b.installation ? -1 : 1))
}

// ---------------------------------------------------------------------------------------------------------------------
// Jira site connect codes
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether the user behind `userToken` (the app-user token Forge sends with a call, `x-forge-oauth-user`) administers
 * the Jira site: `GET /rest/api/3/mypermissions?permissions=ADMINISTER` with that token (3.8). Any failure answers
 * false. The token is used for this one call and is never stored or logged.
 */
export async function jiraSiteAdmin(
  input: { readonly cloudId: string; readonly userToken: string },
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (typeof input.cloudId !== "string" || !UUID.test(input.cloudId)) return false
  if (typeof input.userToken !== "string" || !TOKEN.test(input.userToken)) return false
  try {
    const response = await platformFetch(
      "jira",
      `https://api.atlassian.com/ex/jira/${input.cloudId.toLowerCase()}/rest/api/3/mypermissions?permissions=ADMINISTER`,
      { headers: { authorization: `Bearer ${input.userToken}`, accept: "application/json" } },
      fetcher,
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return false
    }
    const body = await readPlatformJson(response)
    const permissions = (body as { permissions?: { ADMINISTER?: { havePermission?: unknown } } } | null)?.permissions
    return permissions?.ADMINISTER?.havePermission === true
  } catch {
    return false
  }
}

/**
 * Issues a Jira site connect code during a Forge call (3.8, 4.4), only after the caller passes the ADMINISTER check
 * with their own user token. The code is bound to that Atlassian account and cloud id, works once, for 10 minutes, and
 * is redeemed on vectordev.ai by the signed-in Vector account that becomes the site's connector.
 */
export async function issueConnectCode(
  ctx: IdentityContext,
  input: {
    readonly cloudId: string
    readonly accountId: string
    readonly userToken: string
    readonly forgeInstallationId?: string
  },
  fetcher: typeof fetch = fetch,
): Promise<
  | { readonly ok: true; readonly code: string; readonly expiresAt: number }
  | { readonly ok: false; readonly code: "not-allowed" }
> {
  if (typeof input.cloudId !== "string" || !UUID.test(input.cloudId)) invalid()
  if (typeof input.accountId !== "string" || !USER_ID_PATTERNS.jira.test(input.accountId)) invalid()
  if (input.forgeInstallationId !== undefined && !FORGE_INSTALLATION.test(input.forgeInstallationId)) invalid()
  if (!(await jiraSiteAdmin({ cloudId: input.cloudId, userToken: input.userToken }, fetcher)))
    return { ok: false, code: "not-allowed" }
  const record: ConnectCodeRecord = {
    cloudId: input.cloudId.toLowerCase(),
    accountId: input.accountId,
    ...(input.forgeInstallationId !== undefined ? { forgeInstallationId: input.forgeInstallationId } : {}),
    issuedAt: ctx.now,
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = randomCode(CONNECT_CODE_CHARS)
    const key = everywhereKeys.connectCode(codeHash(ctx.keys, "connect", code))
    if (await setJson(ctx.store, key, record, { ttlMs: KEEP_MS.connectCode, onlyNew: true }))
      return { ok: true, code: formatCode(code), expiresAt: ctx.now + KEEP_MS.connectCode }
  }
  throw storeUnavailable()
}

/**
 * Redeems a Jira connect code for the signed-in account, which becomes the site's connector. The code works once, and
 * only for the cloud id it was issued for: naming another site burns it. Its issuer passed the ADMINISTER check, so a
 * site another account connected changes connector, as a platform admin's re-install does.
 */
export async function redeemConnectCode(
  ctx: IdentityContext,
  input: { readonly account: string; readonly code: string; readonly cloudId?: string },
): Promise<InstallVerdict | { readonly ok: false; readonly code: "code-invalid" }> {
  const account = accountId(input.account)
  const code = normalizeCode(input.code, CONNECT_CODE_CHARS)
  if (!code) return { ok: false, code: "code-invalid" }
  const found = await takeJson(
    ctx.store,
    everywhereKeys.connectCode(codeHash(ctx.keys, "connect", code)),
    decodeConnectCode,
  )
  if (!found) return { ok: false, code: "code-invalid" }
  if (
    input.cloudId !== undefined &&
    (typeof input.cloudId !== "string" || input.cloudId.toLowerCase() !== found.cloudId)
  )
    return { ok: false, code: "code-invalid" }
  return recordInstall(ctx, {
    account,
    event: "connect",
    grant: {
      installation: `jira:${found.cloudId}`,
      scopes: [],
      ...(found.forgeInstallationId !== undefined ? { forgeInstallationId: found.forgeInstallationId } : {}),
      installer: { userId: found.accountId, admin: true },
    },
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Repository mappings
// ---------------------------------------------------------------------------------------------------------------------

export type MappingVerdict =
  | { readonly ok: true; readonly mapping: RepoMapping }
  | {
      readonly ok: false
      readonly code: "not-connected" | "not-connector" | "not-linked" | "bot" | "automation" | "external" | "guest"
    }

function checkPlace(place: unknown): string {
  if (typeof place !== "string" || !PLACE_PATTERN.test(place)) invalid()
  return place
}

async function writeMapping(store: Store, installation: string, mapping: RepoMapping) {
  await addMembers(store, everywhereKeys.repos(installation), mapping.place)
  await setJson(store, everywhereKeys.repo(installation, mapping.place), encodeMapping(mapping))
}

/** A place's mapping, or undefined when it has none. */
export async function findMapping(store: Store, installation: string, place: string): Promise<RepoMapping | undefined> {
  platformOf(installation)
  const where = checkPlace(place)
  return getJson(store, everywhereKeys.repo(installation, where), decodeMapping(where))
}

/** Every mapped place of an installation, by place. */
export async function listMappings(store: Store, installation: string): Promise<RepoMapping[]> {
  platformOf(installation)
  const out: RepoMapping[] = []
  for (const place of await setMembers(store, everywhereKeys.repos(installation))) {
    if (!PLACE_PATTERN.test(place)) continue
    const mapping = decodeMapping(place)(parseStored(await getValue(store, everywhereKeys.repo(installation, place))))
    if (mapping) out.push(mapping)
  }
  return out.sort((a, b) => (a.place < b.place ? -1 : a.place > b.place ? 1 : 0))
}

/**
 * Sets a place's repositories on vectordev.ai (3.8). Only the installation's connector may. `private` marks a Linear
 * team or Jira project private; left out, it keeps its current value.
 */
export async function setMapping(
  ctx: IdentityContext,
  input: {
    readonly account: string
    readonly installation: string
    readonly place: string
    readonly repositories: readonly RepoRef[]
    readonly private?: boolean
  },
): Promise<MappingVerdict> {
  const account = accountId(input.account)
  platformOf(input.installation)
  const place = checkPlace(input.place)
  const repositories = checkRepositories(input.repositories)
  if (!repositories) invalid("Name at most 20 repositories as owner/name, each once.")
  const install = await findInstall(ctx.store, input.installation)
  if (!install) return { ok: false, code: "not-connected" }
  if (install.connector !== account) return { ok: false, code: "not-connector" }
  const existing = await findMapping(ctx.store, input.installation, place)
  const mapping: RepoMapping = {
    place,
    repositories,
    setBy: account,
    private: input.private ?? existing?.private ?? false,
    setAt: ctx.now,
  }
  await writeMapping(ctx.store, input.installation, mapping)
  return { ok: true, mapping }
}

/**
 * Sets a place's repository from the requester's `repo owner/name` word (3.8). The requester must be a linked person
 * (not a bot, automation, external user or guest) on a connected installation: at launch the sponsor is the
 * requester's own linked account (3.9), so that is the sponsor's linked requester. The place keeps its private mark.
 */
export async function setMappingByWord(
  ctx: IdentityContext,
  input: {
    readonly installation: string
    readonly place: string
    readonly userId: string
    readonly actor: LinkActor
    readonly repository: RepoRef
  },
): Promise<MappingVerdict> {
  platformOf(input.installation)
  const place = checkPlace(input.place)
  const userId = checkUser(input.installation, input.userId)
  const repositories = checkRepositories([input.repository])
  if (!repositories) invalid("Name the repository as owner/name.")
  const refusal = actorRefusal(input.actor)
  if (refusal) return { ok: false, code: refusal }
  if (!(await findInstall(ctx.store, input.installation))) return { ok: false, code: "not-connected" }
  const link = await findLink(ctx.store, input.installation, userId)
  if (!link) return { ok: false, code: "not-linked" }
  const existing = await findMapping(ctx.store, input.installation, place)
  const mapping: RepoMapping = {
    place,
    repositories,
    setBy: link.account,
    private: existing?.private ?? false,
    setAt: ctx.now,
  }
  await writeMapping(ctx.store, input.installation, mapping)
  return { ok: true, mapping }
}

/** Removes a place's mapping. Only the installation's connector may. */
export async function removeMapping(
  ctx: IdentityContext,
  input: { readonly account: string; readonly installation: string; readonly place: string },
): Promise<
  | { readonly ok: true; readonly removed: boolean }
  | { readonly ok: false; readonly code: "not-connected" | "not-connector" }
> {
  const account = accountId(input.account)
  platformOf(input.installation)
  const place = checkPlace(input.place)
  const install = await findInstall(ctx.store, input.installation)
  if (!install) return { ok: false, code: "not-connected" }
  if (install.connector !== account) return { ok: false, code: "not-connector" }
  const removed = (await deleteKeys(ctx.store, everywhereKeys.repo(input.installation, place))) > 0
  await removeMembers(ctx.store, everywhereKeys.repos(input.installation), place)
  // A mapping written in the meantime keeps its index entry.
  if (await getValue(ctx.store, everywhereKeys.repo(input.installation, place)))
    await addMembers(ctx.store, everywhereKeys.repos(input.installation), place)
  return { ok: true, removed }
}

// ---------------------------------------------------------------------------------------------------------------------
// Finishing an OAuth flow
// ---------------------------------------------------------------------------------------------------------------------

/** What a sign-in on the link page proved: the platform user and their workspace (Linear `viewer.id`, organization). */
export type SignedInIdentity = { readonly installation: string; readonly userId: string; readonly actor: LinkActor }

/**
 * A platform's half of the OAuth finish: exchanging the code for an installation (VE-11 Slack, VE-12 Linear) or for
 * the identity of the person who signed in (VE-12 Linear). Called only after the state was taken and its account
 * checked against the bearer token's.
 */
export type OAuthExchange = {
  readonly install?: (code: string, state: OAuthState) => Promise<InstallGrant>
  readonly link?: (code: string, state: OAuthState) => Promise<SignedInIdentity>
}
export type OAuthExchanges = Partial<Record<PlatformId, OAuthExchange>>

export type OAuthFinish =
  | {
      readonly purpose: "install"
      readonly platform: PlatformId
      readonly installation: string
      readonly change: "new" | "renewed" | "connector-change"
    }
  | {
      readonly purpose: "link"
      readonly platform: PlatformId
      readonly installation: string
      readonly userId: string
      readonly hint?: string
      readonly already: boolean
    }

const OAUTH_CODE = /^[\x21-\x7e]{1,1024}$/

/**
 * Finishes an install or a sign-in link with `{code, state}` that the vectordev.ai landing page posted with the
 * signed-in account's bearer token (3.8). The state is used up first, whatever happens next. It finishes only for the
 * account that started it, and the platform's code is exchanged only after that check.
 */
export async function finishOAuth(
  ctx: IdentityContext,
  input: {
    readonly account: string
    readonly email?: string
    readonly code: unknown
    readonly state: unknown
    readonly exchanges: OAuthExchanges
    /** Whether the platform's intake is on (`platformOn`). */
    readonly platformOn: (platform: PlatformId) => boolean
  },
): Promise<OAuthFinish> {
  const account = accountId(input.account)
  if (typeof input.code !== "string" || !OAUTH_CODE.test(input.code)) invalid()
  const state = await takeState(ctx.store, input.state)
  if (!state)
    throw new ApiError(400, "EVERYWHERE_STATE_INVALID", "This sign-in has expired or was already used. Start again.")
  if (state.account !== account)
    throw new ApiError(
      403,
      "EVERYWHERE_STATE_ACCOUNT",
      "This sign-in was started by another Vector account. Start again while signed in to your own account.",
    )
  if (!input.platformOn(state.platform)) throw new ApiError(404, "NOT_FOUND", "Not found.")
  const exchange = input.exchanges[state.platform]?.[state.purpose]
  if (!exchange)
    throw new ApiError(501, "EVERYWHERE_UNAVAILABLE", `${PLATFORM_NAMES[state.platform]} cannot be connected here yet.`)
  const exchanged = await (exchange as (code: string, state: OAuthState) => Promise<InstallGrant | SignedInIdentity>)(
    input.code,
    state,
  ).catch((error: unknown) => {
    if (error instanceof ApiError) throw error
    throw new ApiError(
      502,
      "EVERYWHERE_EXCHANGE_FAILED",
      `${PLATFORM_NAMES[state.platform]} did not finish the sign-in. Try again.`,
    )
  })
  if (installationPlatform(exchanged.installation) !== state.platform)
    throw new ApiError(
      502,
      "EVERYWHERE_EXCHANGE_FAILED",
      `${PLATFORM_NAMES[state.platform]} did not finish the sign-in. Try again.`,
    )

  if (state.purpose === "install") {
    const grant = exchanged as InstallGrant
    if (state.installation !== undefined && grant.installation !== state.installation)
      throw new ApiError(
        409,
        "EVERYWHERE_WRONG_PLACE",
        "Vector was installed in a different place than the one this started for.",
      )
    const verdict = await recordInstall(ctx, { account, grant, event: "install" })
    if (!verdict.ok)
      throw new ApiError(
        409,
        "EVERYWHERE_INSTALLED_ELSEWHERE",
        "Another Vector account connected this place. It disconnects first, or an admin of the place installs Vector.",
      )
    return { purpose: "install", platform: state.platform, installation: verdict.installation, change: verdict.change }
  }

  const identity = exchanged as SignedInIdentity
  const verdict = await linkBySignIn(ctx, {
    account,
    ...(input.email ? { email: input.email } : {}),
    installation: identity.installation,
    userId: identity.userId,
    actor: identity.actor,
  })
  if (!verdict.ok)
    throw new ApiError(403, "EVERYWHERE_LINK_REFUSED", "This account cannot be linked.", {
      detail: { reason: verdict.code },
    })
  return {
    purpose: "link",
    platform: state.platform,
    installation: identity.installation,
    userId: identity.userId,
    already: verdict.already,
    ...(verdict.hint ? { hint: verdict.hint } : {}),
  }
}
