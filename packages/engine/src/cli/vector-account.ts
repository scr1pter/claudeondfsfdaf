import { createHash, randomBytes } from "node:crypto"
import fs from "fs/promises"
import path from "path"
import open from "open"
import { Global } from "@vectordevai/core/global"
import { truthy } from "@vectordevai/core/flag/flag"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { Option, Schema } from "effect"
import { UI } from "./ui"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { listenLoopback } from "@vectordevai/core/oauth/loopback"

export const readVectorToken = VectorAccount.readVectorToken

/**
 * Vector CLI account gate.
 *
 * The `vector` terminal agent is free, but requires a Vector account. `vector login` opens {site}/auth/cli, where the
 * person approves this terminal; the browser hands a one-use code back to a listener on 127.0.0.1 and the CLI exchanges
 * it, with its PKCE verifier, for a CLI grant it stores and never shows. A token copied from {site}/auth/cli still
 * works (`vector login --token`), for free models only. Tokens are verified against the Vector API and cached with an
 * offline grace window so flaky networks never lock anyone out of their own terminal.
 */

const AUTH_FILE = path.join(Global.Path.data, "cli-auth.json")
// Read on each call, not when this module loads: a command, or a test, may set VECTOR_SITE_URL after an import.
const site = () => (process.env.VECTOR_SITE_URL ?? "https://vectordev.ai").replace(/\/+$/, "")
const DAY = 24 * 60 * 60 * 1000
const OFFLINE_GRACE = 7 * DAY
// Late enough that the command has opened its own database before the usage report reads it.
const USAGE_REPORT_DELAY = 15_000

type CliUser = { id: string; email: string }
type StoredAuth = { token: string; user: CliUser; verifiedAt: number }

async function load(): Promise<StoredAuth | undefined> {
  const raw = await fs.readFile(AUTH_FILE, "utf8").catch(() => undefined)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (
      typeof parsed?.token === "string" &&
      typeof parsed?.user?.id === "string" &&
      typeof parsed?.user?.email === "string" &&
      typeof parsed?.verifiedAt === "number"
    )
      return parsed as StoredAuth
  } catch {
    // corrupt file falls through to a fresh login
  }
  return undefined
}

// VECTOR_CLI_TOKEN values vectordev.ai accepted, by their SHA-256, so Vector Local can tell a token checked once from
// one that never was without keeping the token itself. One it rejected later comes off the list.
const CHECKED_FILE = path.join(Global.Path.data, "cli-token-checked.json")

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex")

async function checkedTokens() {
  const hashes: unknown = await Bun.file(CHECKED_FILE)
    .json()
    .catch(() => [])
  return Array.isArray(hashes) ? hashes.filter((item): item is string => typeof item === "string") : []
}

async function recordCheck(token: string, accepted: boolean) {
  const hash = tokenHash(token)
  const hashes = await checkedTokens()
  if (hashes.includes(hash) === accepted) return
  const next = accepted ? [...hashes.slice(-19), hash] : hashes.filter((item) => item !== hash)
  await fs.mkdir(path.dirname(CHECKED_FILE), { recursive: true })
  await fs.writeFile(CHECKED_FILE, JSON.stringify(next), { mode: 0o600 })
}

async function save(auth: StoredAuth) {
  await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true })
  await fs.writeFile(AUTH_FILE, JSON.stringify(auth, undefined, 2), { mode: 0o600 })
}

export async function signOut() {
  const { VectorTeams } = await import("@/teams")
  await VectorTeams.runtime.runPromise((teams) => teams.clear())
  await fs.rm(AUTH_FILE, { force: true })
  await fs.rm(CHECKED_FILE, { force: true })
}

export async function currentUser(): Promise<CliUser | undefined> {
  return (await load())?.user
}

type VerifyResult =
  | { status: "ok"; user: CliUser }
  | { status: "invalid"; message?: string }
  | { status: "offline" }
  | { status: "local" }

// With Vector Local on, Vector does not check the account with vectordev.ai unless the user allowed it: a CLI signed in
// once keeps working, and no usage report is sent (owner question 1, option A).
const ACCOUNT_SOURCE = LocalSources.get("vector-account")!
const USAGE_SOURCE = LocalSources.get("usage-checkin")!
const offline = (source: LocalSources.Source) =>
  LocalPolicy.decide(Egress.policy(), { purpose: source.purpose, url: site(), source: source.id }).decision !== "allow"
const LOCAL_SIGN_IN =
  "Vector Local blocks requests to vectordev.ai, so Vector cannot check a token now. Sign in once with Vector Local off, or allow the vector-account source."

// Only a definitive answer from the Vector API counts as a rejection. Captive
// portals, proxies, rate limits, and outages must never sign a user out.
const REJECTION_CODES = new Set(["CLI_TOKEN_INVALID", "CLI_TOKEN_EXPIRED"])

// The verification at the first command of each UTC day doubles as the CLI's usage count: the server records one row
// per account per UTC day from these headers unless VECTOR_DISABLE_USAGE turns that off. Nothing else is sent.
async function verifyToken(token: string): Promise<VerifyResult> {
  if (offline(ACCOUNT_SOURCE)) return { status: "local" }
  const response = await Egress.fetch(ACCOUNT_SOURCE.id, `${site()}/api/account/cli-verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-vector-version": InstallationVersion,
      "x-vector-platform": `${process.platform}-${process.arch}`,
      ...(truthy("VECTOR_DISABLE_USAGE") ? { "x-vector-usage": "off" } : {}),
    },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response) return { status: "offline" }
  const payload = (await response.json().catch(() => undefined)) as
    | { ok?: boolean; user?: CliUser; error?: { code?: string; message?: string } }
    | undefined
  if (response.ok && payload?.ok && payload.user) return { status: "ok", user: payload.user }
  if (payload?.error?.code && REJECTION_CODES.has(payload.error.code))
    return { status: "invalid", message: payload.error.message }
  return { status: "offline" }
}

// Where the day's usage report is read and sent: this thread, unless the command routes it elsewhere.
const usageReport = {
  send: async (input: { token: string; site: string }): Promise<unknown> => {
    const { sendUsageReport } = await import("./usage-report")
    return sendUsageReport(input)
  },
}

/**
 * Sends the day's usage report through `send` instead of this thread. Reading it scans every message synchronously, so
 * the TUI, which renders on this thread, hands it to its server worker.
 */
export function routeUsageReport(send: (input: { token: string; site: string }) => Promise<unknown>) {
  usageReport.send = send
}

// A verified account's command also sends the day's usage report (./usage-report), a while after it starts. It is
// fire-and-forget: the timer never keeps a finished command alive, and the report sends at most once per UTC day.
export function scheduleUsageReport(token: string, delay = USAGE_REPORT_DELAY) {
  if (truthy("VECTOR_DISABLE_USAGE")) return
  if (offline(USAGE_SOURCE)) return
  setTimeout(() => {
    usageReport.send({ token, site: site() }).catch(() => undefined)
  }, delay).unref()
}

export type LoginOptions = {
  /** Opens the sign-in page; the system browser unless a caller (or a test) supplies one. */
  openBrowser?: (url: string) => Promise<unknown>
  /** Ends a waiting sign-in: the listener closes and nothing is stored. */
  signal?: AbortSignal
  /** The callback port on 127.0.0.1; 0 or omitted picks a free one. Fixed, it can be forwarded over SSH. */
  port?: number
  timeoutMs?: number
}

/**
 * Signs this terminal in. With `provided`, a token copied from {site}/auth/cli, which stays unmarked and works with free
 * models only. Without it, the browser sign-in that stores a CLI grant, which Vector Codium also accepts.
 */
export async function login(provided?: string, options: LoginOptions = {}): Promise<CliUser | undefined> {
  const url = `${site()}/auth/cli`
  const token = provided?.trim()
  if (!token) return browserLogin(options)
  if (!token.startsWith("vct_")) {
    UI.error(`That does not look like a Vector CLI token (they start with vct_). Get one at ${url}`)
    return undefined
  }
  const verified = await verifyToken(token)
  if (verified.status === "local") {
    UI.error(LOCAL_SIGN_IN)
    return undefined
  }
  if (verified.status === "offline") {
    UI.error("Vector could not reach vectordev.ai to verify the token. Check your connection and try again.")
    return undefined
  }
  if (verified.status === "invalid") {
    UI.error(verified.message ?? `That token was not accepted. Generate a fresh one at ${url}`)
    return undefined
  }
  await save({ token, user: verified.user, verifiedAt: Date.now() })
  // A copied token was never minted for this CLI, so Vector Codium refuses it.
  if (!tokenMarked(token))
    UI.println(
      UI.Style.TEXT_DIM +
        "A copied token works with free models only. Run vector login without --token to use Vector Codium in this terminal.",
    )
  return signedIn(verified.user)
}

async function browserLogin(options: LoginOptions) {
  if (offline(ACCOUNT_SOURCE)) {
    UI.error(LOCAL_SIGN_IN)
    return undefined
  }
  const signal = options.signal ?? new AbortController().signal
  const verifier = randomBytes(32).toString("base64url")
  const state = randomBytes(32).toString("base64url")
  const listener = await listenLoopback({
    redirect: new URL(`http://127.0.0.1:${options.port ?? 0}/callback`),
    state,
    signal,
    timeoutMs: options.timeoutMs,
    name: "Vector sign-in",
  }).catch((error: unknown) => {
    UI.error(error instanceof Error ? error.message : "Vector could not start its sign-in listener.")
    return undefined
  })
  if (!listener) return undefined
  const url = `${site()}/auth/cli?${new URLSearchParams({
    desktop: "1",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    purpose: "cli",
    port: listener.redirect.port,
  })}`
  UI.empty()
  UI.println(UI.Style.TEXT_NORMAL_BOLD + "Sign in to Vector")
  UI.println(UI.Style.TEXT_DIM + "The Vector agent is free — it just needs a Vector account.")
  UI.empty()
  UI.println("Approve this terminal in your browser. If it did not open, visit:")
  UI.println(UI.Style.TEXT_INFO_BOLD + url + UI.Style.TEXT_NORMAL)
  UI.println(
    UI.Style.TEXT_DIM +
      `The browser returns to 127.0.0.1:${listener.redirect.port} on this computer. Over SSH, forward that port, or run vector login --port <port> to choose it.`,
  )
  UI.empty()
  await (options.openBrowser ?? open)(url).catch(() => undefined)
  const exchanged = await listener.code
    .then((code) => exchange({ code, state, verifier }, listener.signal))
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : "Vector sign-in failed." }))
    .finally(listener.close)
  if (exchanged.error !== undefined) {
    UI.error(exchanged.error)
    return undefined
  }
  // A copied token's sign-in for another account goes, with that account's team choice and checked tokens, as with
  // `vector login --token`: its team would otherwise stop every command from loading its configuration.
  const replaced = await load()
  if (replaced && replaced.user.id !== exchanged.user.id) await signOut()
  await save({ token: exchanged.token, user: exchanged.user, verifiedAt: Date.now() })
  return signedIn(exchanged.user)
}

// The one-use code and its verifier buy the grant once. Only a CLI grant is stored: a code minted for another purpose
// (a desktop sign-in or a deletion) would buy another credential, which this terminal must not keep.
async function exchange(input: { code: string; state: string; verifier: string }, signal: AbortSignal) {
  const response = await Egress.fetch(ACCOUNT_SOURCE.id, `${site()}/api/account/cli-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  }).catch(() => undefined)
  if (!response) return { error: "Vector could not reach vectordev.ai to finish signing in. Run vector login again." }
  const payload = (await response.json().catch(() => undefined)) as
    | { token?: unknown; user?: { id?: unknown; email?: unknown }; error?: { message?: unknown } }
    | undefined
  const message = payload?.error?.message
  if (!response.ok)
    return { error: typeof message === "string" ? message : "Vector sign-in failed. Run vector login again." }
  const token = payload?.token
  const user = payload?.user
  const claims = typeof token === "string" ? tokenClaims(token) : undefined
  if (
    typeof token !== "string" ||
    typeof user?.id !== "string" ||
    typeof user.email !== "string" ||
    claims?.client !== "cli" ||
    typeof claims.jti !== "string" ||
    claims.sub !== user.id
  )
    return { error: "vectordev.ai did not return a CLI sign-in. Run vector login again." }
  return { token, user: { id: user.id, email: user.email } }
}

// The claims a vct_ token carries, read without verifying it: only the server can verify the signature, and these
// decide nothing beyond what this CLI keeps and shows.
function tokenClaims(token: string) {
  const payload = token.startsWith("vct_") ? token.slice(4).split(".") : []
  if (payload.length !== 2) return undefined
  const decoded = Buffer.from(payload[0]!, "base64url").toString("utf8")
  const claims = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        sub: Schema.optional(Schema.String),
        client: Schema.optional(Schema.String),
        jti: Schema.optional(Schema.String),
      }),
    ),
  )(decoded)
  return Option.getOrUndefined(claims)
}

/** Whether a token was minted for a Vector client (this CLI's sign-in or the desktop's), which Vector Codium accepts. */
export function tokenMarked(token: string) {
  const client = tokenClaims(token)?.client
  return client === "cli" || client === "desktop"
}

/** The stored sign-in's token kind, for display: Codium refuses a copied token. */
export async function storedTokenMarked() {
  const stored = await load()
  return stored ? tokenMarked(stored.token) : undefined
}

/**
 * Whether the stored sign-in still stands, asked of vectordev.ai now rather than at the day's first command: a grant
 * revoked or expired since then is signed out here, so `vector login` signs in again instead of calling it current.
 * Only a refusal counts; an unreachable site or Vector Local keeps the sign-in, as the daily check does.
 */
export async function confirmStoredSignIn() {
  const stored = await load()
  if (!stored) return false
  const verified = await verifyToken(stored.token)
  if (verified.status === "ok") await save({ token: stored.token, user: verified.user, verifiedAt: Date.now() })
  if (verified.status !== "invalid") return true
  await signOut()
  return false
}

async function signedIn(user: CliUser) {
  const { VectorTeams } = await import("@/teams")
  await VectorTeams.runtime
    .runPromise((teams) => teams.refresh())
    .catch((error: unknown) =>
      UI.println(
        `Signed in, but Vector Teams could not refresh: ${error instanceof Error ? error.message : "try again from vector org list"}`,
      ),
    )
  UI.empty()
  UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓ Signed in as " + user.email)
  UI.empty()
  UI.println(
    "Now run " +
      UI.Style.TEXT_INFO_BOLD +
      "vector" +
      UI.Style.TEXT_NORMAL +
      " inside any repository to start the agent — you type to it there, not at the shell prompt.",
  )
  return user
}

/**
 * Blocks agent commands until a Vector account is present. Returns quietly
 * when the session is already verified; exits the process when sign-in is
 * impossible (declined, invalid, or non-interactive without a token).
 */
export async function ensureVectorAccount(): Promise<void> {
  const envToken = process.env.VECTOR_CLI_TOKEN
  if (envToken) {
    const verified = await verifyToken(envToken)
    if (verified.status === "ok" || verified.status === "invalid") await recordCheck(envToken, verified.status === "ok")
    if (verified.status === "ok") scheduleUsageReport(envToken)
    if (verified.status === "ok" || verified.status === "offline") return
    // Signed in once: with Vector Local on, a token vectordev.ai accepted before (the stored sign-in, or this variable
    // checked with Vector Local off) is not checked again. One never checked is not a sign-in.
    if (verified.status === "local") {
      if ((await load())?.token === envToken || (await checkedTokens()).includes(tokenHash(envToken))) return
      UI.error(`A free Vector account is required, and VECTOR_CLI_TOKEN has not been checked yet. ${LOCAL_SIGN_IN}`)
      process.exit(1)
    }
    UI.error("VECTOR_CLI_TOKEN is not valid. Generate a new token at " + `${site()}/auth/cli`)
    process.exit(1)
  }

  const stored = await load()
  if (stored) {
    const age = Date.now() - stored.verifiedAt
    // Once per UTC day rather than once per 24 hours, because the server counts the CLI's active days from this check.
    if (Math.floor(stored.verifiedAt / DAY) === Math.floor(Date.now() / DAY)) {
      scheduleUsageReport(stored.token)
      return
    }
    const verified = await verifyToken(stored.token)
    // Signed in once: with Vector Local on, the account is not checked again and the grace period does not run out.
    if (verified.status === "local") return
    if (verified.status === "ok") {
      await save({ token: stored.token, user: verified.user, verifiedAt: Date.now() })
      scheduleUsageReport(stored.token)
      return
    }
    if (verified.status === "offline") {
      if (age < OFFLINE_GRACE) return
      UI.error("Vector could not verify your account and the offline grace period has passed. Reconnect and try again.")
      process.exit(1)
    }
    // token revoked or expired — fall through to a fresh login
    await signOut()
    UI.println(UI.Style.TEXT_WARNING_BOLD + "Your Vector session expired — sign in again.")
  }

  if (offline(ACCOUNT_SOURCE)) {
    UI.error(`A free Vector account is required. ${LOCAL_SIGN_IN}`)
    process.exit(1)
  }

  if (!process.stdin.isTTY) {
    UI.error(
      `A free Vector account is required. Run "vector login" in a terminal, or set VECTOR_CLI_TOKEN (create one at ${site()}/auth/cli).`,
    )
    process.exit(1)
  }

  const user = await login()
  if (!user) process.exit(1)
}
