import { GithubSecrets } from "./cmd/github.secrets"
import { createHash } from "node:crypto"
import fs from "fs/promises"
import path from "path"
import open from "open"
import { Global } from "@vectordevai/core/global"
import { truthy } from "@vectordevai/core/flag/flag"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { UI } from "./ui"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSources } from "@vectordevai/core/local-mode/sources"

export const readVectorToken = VectorAccount.readVectorToken

/**
 * Vector CLI account gate.
 *
 * The `vector` terminal agent is free, but requires a Vector account. Tokens
 * are minted at {site}/auth/cli after signing in and pasted into the CLI once;
 * they are verified against the Vector API and cached with an offline grace
 * window so flaky networks never lock anyone out of their own terminal.
 */

const AUTH_FILE = path.join(Global.Path.data, "cli-auth.json")
const SITE = (process.env.VECTOR_SITE_URL ?? "https://vectordev.ai").replace(/\/+$/, "")
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
  LocalPolicy.decide(Egress.policy(), { purpose: source.purpose, url: SITE, source: source.id }).decision !== "allow"
const LOCAL_SIGN_IN =
  "Vector Local blocks requests to vectordev.ai, so Vector cannot check a token now. Sign in once with Vector Local off, or allow the vector-account source."

// Only a definitive answer from the Vector API counts as a rejection. Captive
// portals, proxies, rate limits, and outages must never sign a user out.
const REJECTION_CODES = new Set(["CLI_TOKEN_INVALID", "CLI_TOKEN_EXPIRED"])

// The verification at the first command of each UTC day doubles as the CLI's usage count: the server records one row
// per account per UTC day from these headers unless VECTOR_DISABLE_USAGE turns that off. Nothing else is sent.
async function verifyToken(token: string): Promise<VerifyResult> {
  if (offline(ACCOUNT_SOURCE)) return { status: "local" }
  const response = await Egress.fetch(ACCOUNT_SOURCE.id, `${SITE}/api/account/cli-verify`, {
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
    usageReport.send({ token, site: SITE }).catch(() => undefined)
  }, delay).unref()
}

// Prompt on stderr so a piped stdout never receives prompt text.
function ask(prompt: string): Promise<string> {
  const readline = require("readline") as typeof import("readline")
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => rl.question(prompt, (answer: string) => (rl.close(), resolve(answer.trim()))))
}

export async function login(provided?: string): Promise<CliUser | undefined> {
  const url = `${SITE}/auth/cli`
  let token = provided?.trim() ?? ""
  if (!token) {
    UI.empty()
    UI.println(UI.Style.TEXT_NORMAL_BOLD + "Sign in to Vector")
    UI.println(UI.Style.TEXT_DIM + "The Vector agent is free — it just needs a Vector account.")
    UI.empty()
    UI.println("1. Your browser is opening " + UI.Style.TEXT_INFO_BOLD + url + UI.Style.TEXT_NORMAL)
    UI.println("2. Sign in (or create a free account) and copy the command it shows you")
    UI.println("3. Run that command — or paste just the token below")
    UI.empty()
    await open(url).catch(() => undefined)
    token = (await ask("CLI token: ")).trim()
  }
  if (!token) {
    UI.error("No token entered.")
    return undefined
  }
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
  const { VectorTeams } = await import("@/teams")
  await VectorTeams.runtime
    .runPromise((teams) => teams.refresh())
    .catch((error: unknown) =>
      UI.println(
        `Signed in, but Vector Teams could not refresh: ${error instanceof Error ? error.message : "try again from vector org list"}`,
      ),
    )
  UI.empty()
  UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓ Signed in as " + verified.user.email)
  UI.empty()
  UI.println(
    "Now run " +
      UI.Style.TEXT_INFO_BOLD +
      "vector" +
      UI.Style.TEXT_NORMAL +
      " inside any repository to start the agent — you type to it there, not at the shell prompt.",
  )
  return verified.user
}

/**
 * Blocks agent commands until a Vector account is present. Returns quietly
 * when the session is already verified; exits the process when sign-in is
 * impossible (declined, invalid, or non-interactive without a token).
 */
export async function ensureVectorAccount(): Promise<void> {
  if (GithubSecrets.credentials.pendingRunToken()) {
    const { verifyGithubRun } = await import("./cmd/github.cloud")
    const accepted = process.env.GITHUB_ACTIONS === "true" && (await verifyGithubRun())
    if (accepted) return
    UI.error("This Codium run is not authorized.")
    process.exit(1)
  }
  if (GithubSecrets.credentials.loaded() && !GithubSecrets.credentials.cliToken()) {
    UI.error("This GitHub run requires its repository VECTOR_CLI_TOKEN secret.")
    process.exit(1)
  }
  const envToken = GithubSecrets.credentials.cliToken() ?? process.env.VECTOR_CLI_TOKEN
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
    UI.error("VECTOR_CLI_TOKEN is not valid. Generate a new token at " + `${SITE}/auth/cli`)
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
      `A free Vector account is required. Run "vector login" in a terminal, or set VECTOR_CLI_TOKEN (create one at ${SITE}/auth/cli).`,
    )
    process.exit(1)
  }

  const user = await login()
  if (!user) process.exit(1)
}
