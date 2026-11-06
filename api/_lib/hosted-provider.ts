import { ENTITLEMENTS } from "../../packages/schema/src/codium-entitlements.js"
import { PLANS } from "../../packages/schema/src/codium-plan.js"
import { Hosted } from "../../packages/schema/src/hosted.js"
import { codiumKey } from "./codium-keys.js"
import { notifyOwner } from "./codium-owner.js"
import { readSwitch } from "./codium-switches.js"
import { unavailable } from "./hosted-entitlement.js"
import { hostedAccount, runningBlocks, type BlockEntry } from "./hosted-ledger.js"
import { cloudflareProvider } from "./hosted-provider-cloudflare.js"
import { vercelProvider } from "./hosted-provider-vercel.js"
import { HOLD_MINUTES, HOSTED_REGION, HOSTED_SIZES } from "./hosted-rates.js"
import { ApiError } from "./http.js"
import { stripeMode, type StripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The cloud computer's provider adapter and reconciler (contract WP A52). A computer is a persistent, named microVM at
 * the provider (Vercel Sandbox today, behind `VECTOR_HOSTED_PROVIDER`), started from Vector's base snapshot the first
 * time and resumed from its own saved disk after that. This module says what every provider must do and what every
 * computer looks like; `hosted-provider-vercel.ts` and the Cloudflare stub translate it to their own SDKs.
 *
 * What every computer gets, whatever the provider (`computerConfig`):
 * - the name `vh-<HMAC(account)[0:16]>-<n>` (`hostedAccount`, so the provider never sees an account id) and the mode's
 *   tag, so a test server never touches a live computer even in a shared provider account;
 * - 2 vCPUs (standard) or 4 (large), with the memory `hosted-rates.ts` prices;
 * - a timeout of the job's deadline plus 5 minutes, after which the provider stops it on its own;
 * - one exposed port, the viewer's (`Hosted.VIEWER_PORT`);
 * - egress to the public internet only: every private, loopback, link-local, metadata, multicast and reserved block in
 *   `HOSTED_DENIED_SUBNETS` is refused by the provider's proxy, whatever name resolves to it;
 * - exactly one credential, the session's `vht_` run token, which the provider's egress proxy adds to requests for the
 *   dedicated run-API host (`Hosted.RUN_API_HOST`) and nowhere else. It is never in the computer's environment, files
 *   or disk; the computer's browser is barred from that host by its URL policy (WP A54);
 * - its saved disk kept for the plan's `diskDays` after it stops, one copy only.
 *
 * Guards on money (M8, M9):
 * - `startHostedComputer` starts a computer only for a session whose block of time is held right now (WP A51's running
 *   block), and records which session the computer runs for (`hosted:computer:<name>`) before it asks the provider;
 * - `reconcileHostedComputers` (WP A53's reaper runs it every minute; it acts at most every `RECONCILE_EVERY_MS`) lists
 *   the provider's running computers and stops every one without a live session: no record of its session, or no block
 *   of that session still held. When the owner's `hosted` switch says `stop`, it stops them all.
 *
 * Nothing here calls a provider unless `VECTOR_HOSTED_PROVIDER` names one and its settings are complete: the owner sets
 * it only after the provider's written OK (contract §1.2, §8.1 risk 1).
 */

export const HOSTED_PROVIDERS = ["vercel", "cloudflare"] as const
export type HostedProviderId = (typeof HOSTED_PROVIDERS)[number]

/** A computer's state at the provider. `pending` and `running` cost money; `stopping` and `snapshotting` are ending. */
export type ComputerStatus = "pending" | "running" | "stopping" | "snapshotting" | "stopped" | "failed" | "aborted"
export const ACTIVE_STATUSES: readonly ComputerStatus[] = ["pending", "running"]

/** Everything a provider is told about a computer it starts. Built only by `computerConfig`. */
export type ComputerConfig = {
  name: string
  /** The server's Stripe mode; the provider tags the computer with it and never touches another mode's computers. */
  mode: StripeMode
  size: Hosted.Size
  vcpus: number
  memoryGb: number
  region: string
  /** How long the session may run before the provider stops it by itself: the job's deadline plus 5 minutes. */
  timeoutMs: number
  /** Ports reachable from outside: the viewer's, and nothing else. */
  ports: readonly number[]
  /** Address blocks the computer may never reach. */
  deniedSubnets: readonly string[]
  /** The only credential: added by the provider's egress proxy to requests for the run-API host, never inside the VM. */
  injection: RunTokenInjection
  /** How long the computer's saved disk is kept after it stops: the plan's `diskDays`. */
  retentionMs: number
}

export type RunTokenInjection = { host: string; header: "authorization"; value: string }

/** A computer as the provider lists it. Usage figures are cumulative across its sessions, when the provider has them. */
export type ComputerInfo = {
  name: string
  status: ComputerStatus
  size?: Hosted.Size
  activeCpuMs?: number
  durationMs?: number
  egressBytes?: number
  updatedAt?: number
}

export type StartedComputer = {
  name: string
  /** True when the computer was made now from the base snapshot; false when its saved disk was resumed. */
  created: boolean
  /** The viewer port's public address (WP A53 hands it out only with a viewer token). */
  viewerUrl: string
  /** When the provider stops this session by itself. */
  expiresAt: number
  /** The run-API host the computer's programs call (WP A53 passes it to the boot step). */
  runHost: string
}

export type StopResult = "stopped" | "stopping" | "not-running" | "missing"

/**
 * What a provider does. Every method is idempotent and refuses (503 `HOSTED_UNAVAILABLE`) when the provider is not
 * configured, so nothing reaches a provider before the owner switched it on. A provider never touches a computer that
 * does not carry its mode's tag: `stop` and `destroy` answer `missing` for one, and `start` refuses it.
 */
export interface HostedProvider {
  readonly id: HostedProviderId
  /** Whether this provider's settings are complete (env names only in `problems`). */
  configured(): boolean
  problems(): string[]
  /** Makes the computer from the base snapshot, or resumes its saved disk with this config. A running one restarts. */
  start(config: ComputerConfig): Promise<Omit<StartedComputer, "runHost">>
  /** Replaces the injected run token, keeping the rest of the egress policy. */
  setRunToken(config: Pick<ComputerConfig, "name" | "injection" | "deniedSubnets">): Promise<void>
  /** Stops a computer; its disk is saved and kept for its retention. */
  stop(name: string): Promise<StopResult>
  /** Deletes a computer and its saved disks (account deletion, a disk past its retention). */
  destroy(name: string): Promise<"deleted" | "missing">
  /** This mode's computers whose names start with `prefix`. */
  list(prefix: string): Promise<ComputerInfo[]>
}

export type ProviderOptions = {
  /** The provider to use; by default the one `VECTOR_HOSTED_PROVIDER` names. */
  provider?: HostedProvider | undefined
  fetcher?: typeof fetch
  clock?: () => number
}

const DAY_MS = 86_400_000
const SESSION = /^[A-Za-z0-9_-]{1,64}$/
const RUN_TOKEN = /^vht_[\x21-\x7e]{16,8188}$/
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
/** Vector's own sites: never a run-API host, since the token would then reach pages the browser loads. */
const SITE_HOSTS = new Set(["vectordev.ai", "www.vectordev.ai", "remote.vectordev.ai"])

// ── Selection ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The provider `VECTOR_HOSTED_PROVIDER` names, or undefined when it names none: until the owner sets it, after the
 * provider's written OK, no code path can reach a provider. `cloudflare` is the contract's fallback, a stub that is
 * never configured.
 */
export function hostedProvider(env: Record<string, string | undefined> = process.env): HostedProvider | undefined {
  switch (env.VECTOR_HOSTED_PROVIDER?.trim()) {
    case "vercel":
      return vercelProvider({ env, mode: stripeMode() })
    case "cloudflare":
      return cloudflareProvider()
    default:
      return undefined
  }
}

/** Why cloud computers cannot start here, as env names only (never values); empty when they can. */
export function hostedProviderProblems(env: Record<string, string | undefined> = process.env): string[] {
  const provider = hostedProvider(env)
  const problems = provider ? provider.problems() : ["VECTOR_HOSTED_PROVIDER is not set to a provider"]
  if (!hostedRunHost(env)) problems.push("VECTOR_HOSTED_RUN_HOST is not a usable host here")
  try {
    hostedAccount("00000000-0000-4000-8000-000000000000")
  } catch {
    problems.push("VECTOR_HOSTED_ACCOUNT_SALT is not set")
  }
  return problems
}

/** Whether cloud computers can start here (WP A53's start check and `computer`'s readiness). */
export function hostedProviderConfigured(env: Record<string, string | undefined> = process.env) {
  return hostedProviderProblems(env).length === 0
}

/**
 * The run-API host computers call: `Hosted.RUN_API_HOST`, or `VECTOR_HOSTED_RUN_HOST` outside production (a preview
 * testing in Stripe test mode has its own address). Production never moves it, since the computer's browser policy is
 * built for the fixed host. Vector's own sites are never accepted. Undefined when the setting is unusable.
 */
export function hostedRunHost(env: Record<string, string | undefined> = process.env) {
  const configured = env.VECTOR_HOSTED_RUN_HOST?.trim().toLowerCase()
  if (!configured || configured === Hosted.RUN_API_HOST) return Hosted.RUN_API_HOST
  if (env.VERCEL_ENV === "production") return undefined
  return HOST.test(configured) && !SITE_HOSTS.has(configured) ? configured : undefined
}

// ── Names ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const COMPUTER_PREFIX = "vh-"
const NAME = /^vh-[0-9a-f]{16}-([1-9])$/
/** The most computers any plan runs at once: computers are numbered 1 to this. */
export const MAX_COMPUTERS = Math.max(...PLANS.map((plan) => ENTITLEMENTS[plan.id].hosted?.computers ?? 0))

/** The prefix every computer of `account` is named with: `vh-` and the first 16 hex digits of `hostedAccount`. */
export function accountComputerPrefix(account: string) {
  return `${COMPUTER_PREFIX}${hostedAccount(account).slice(0, 16)}-`
}

/** The provider name of `account`'s computer number `computer` (1 to `MAX_COMPUTERS`). */
export function computerName(account: string, computer: number) {
  if (!Number.isSafeInteger(computer) || computer < 1 || computer > MAX_COMPUTERS) throw request()
  return `${accountComputerPrefix(account)}${computer}`
}

export function isComputerName(name: string) {
  const match = NAME.exec(name)
  return match !== null && Number(match[1]) <= MAX_COMPUTERS
}

// ── What a computer gets ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Address blocks a computer may never reach (§WP A52): every private, loopback, link-local and cloud metadata block,
 * multicast and reserved space, and the IPv6 forms that lead back into IPv4 (mapped, NAT64, 6to4). The provider's
 * proxy refuses them before any domain rule, so a name that resolves to one is refused too. Blocks a provider may use
 * for its own plumbing and the contract does not name (shared address space, benchmarking networks) are left out.
 */
export const HOSTED_DENIED_SUBNETS: readonly string[] = Object.freeze([
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // private
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, with the 169.254.169.254 metadata address
  "172.16.0.0/12", // private
  "192.0.0.0/24", // protocol assignments, with a cloud's metadata address
  "192.168.0.0/16", // private
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved and broadcast
  "::/128", // unspecified
  "::1/128", // loopback
  "::ffff:0:0/96", // IPv4-mapped, which would reach every IPv4 block above
  "64:ff9b::/96", // NAT64, the same
  "64:ff9b:1::/48", // local-use NAT64
  "2002::/16", // 6to4, which embeds an IPv4 address
  "fc00::/7", // unique local, with the fd00:ec2::254 metadata address
  "fe80::/10", // link-local
  "ff00::/8", // multicast
])

/** The provider stops a session this long after its job's deadline, if nothing stopped it first (§WP A52). */
export const TIMEOUT_GRACE_MS = 5 * 60_000
/** The longest session a provider runs (Vercel Sandbox on Pro: 24 hours). */
export const MAX_TIMEOUT_MS = 24 * 3_600_000

/**
 * The full description of a computer for one session. Refuses (400 `HOSTED_REQUEST`) a deadline already past or one
 * the provider cannot run to, a run token that is not a `vht_` token, and a disk retention outside 1 to 90 days.
 */
export function computerConfig(input: {
  name: string
  size: Hosted.Size
  deadline: number
  runToken: string
  diskDays: number
  runHost: string
  mode: StripeMode
  now: number
}): ComputerConfig {
  if (!isComputerName(input.name) || !Hosted.isSize(input.size)) throw request()
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= input.now) throw request()
  const timeoutMs = input.deadline + TIMEOUT_GRACE_MS - input.now
  if (timeoutMs > MAX_TIMEOUT_MS) throw request()
  if (!RUN_TOKEN.test(input.runToken)) throw request()
  if (!Number.isSafeInteger(input.diskDays) || input.diskDays < 1 || input.diskDays > 90) throw request()
  if (!HOST.test(input.runHost)) throw request()
  const { vcpus, memoryGb } = HOSTED_SIZES[input.size]
  return {
    name: input.name,
    mode: input.mode,
    size: input.size,
    vcpus,
    memoryGb,
    region: HOSTED_REGION,
    timeoutMs,
    ports: [Hosted.VIEWER_PORT],
    deniedSubnets: HOSTED_DENIED_SUBNETS,
    injection: runTokenInjection(input.runHost, input.runToken),
    retentionMs: input.diskDays * DAY_MS,
  }
}

function runTokenInjection(host: string, token: string): RunTokenInjection {
  return { host, header: "authorization", value: `Bearer ${token}` }
}

// ── Starting and stopping ──────────────────────────────────────────────────────────────────────────────────────────

/** Which session a computer runs for: `{v, account, computer, session, startedAt}`, kept past the session's timeout. */
export const hostedComputerKey = (name: string) => codiumKey("hosted", "computer", name)
/** The record outlives the provider's own timeout by this much, so a running computer always has it. */
const RECORD_SLACK_MS = 60 * 60_000

type ComputerRecord = { v: 1; account: string; computer: number; session: string; startedAt: number }

/**
 * Starts (or resumes) `account`'s computer number `computer` for `session` (WP A53 calls this after `requireHostedStart`
 * and the session's first `openBlock`). Refuses with 503 `HOSTED_UNAVAILABLE` when no provider is configured, and with
 * 409 `HOSTED_SESSION_MOVED` when the session holds no block of time right now (M8: no computer runs without a hold).
 * The session record is written before the provider is asked, so the reconciler never takes a starting computer for an
 * orphan; if the store cannot write it, nothing starts.
 */
export async function startHostedComputer(
  account: string,
  input: { computer: number; session: string; size: Hosted.Size; deadline: number; runToken: string; diskDays: number },
  options: ProviderOptions = {},
): Promise<StartedComputer> {
  const fetcher = options.fetcher ?? fetch
  const now = (options.clock ?? Date.now)()
  const provider = readyProvider(options)
  const runHost = hostedRunHost()
  if (!runHost) throw unavailable()
  if (!SESSION.test(input.session)) throw request()
  const name = computerName(account, input.computer)
  const config = computerConfig({ ...input, name, runHost, mode: stripeMode(), now })
  const block = (await runningBlocks(account, fetcher)).find((entry) => entry.session === input.session)
  if (!block || !blockHeld(block, now, 0))
    throw new ApiError(409, "HOSTED_SESSION_MOVED", "This cloud computer session has no time held. Start it again.")
  const record: ComputerRecord = { v: 1, account, computer: input.computer, session: input.session, startedAt: now }
  await persistentStore(
    ["SET", hostedComputerKey(name), JSON.stringify(record), "PX", config.timeoutMs + RECORD_SLACK_MS],
    fetcher,
  )
  const started = await provider.start(config).catch((error: unknown) => {
    throw providerFailure(error)
  })
  return { ...started, runHost }
}

/** Replaces the run token a running computer's egress proxy injects (a new `vht_` for the same session). */
export async function setHostedRunToken(
  account: string,
  input: { computer: number; runToken: string },
  options: ProviderOptions = {},
) {
  const provider = readyProvider(options)
  const runHost = hostedRunHost()
  if (!runHost) throw unavailable()
  if (!RUN_TOKEN.test(input.runToken)) throw request()
  await provider
    .setRunToken({
      name: computerName(account, input.computer),
      injection: runTokenInjection(runHost, input.runToken),
      deniedSubnets: HOSTED_DENIED_SUBNETS,
    })
    .catch((error: unknown) => {
      throw providerFailure(error)
    })
}

/** Stops `account`'s computer number `computer`; its disk is saved. Idempotent. */
export async function stopHostedComputer(account: string, computer: number, options: ProviderOptions = {}) {
  const provider = readyProvider(options)
  return provider.stop(computerName(account, computer)).catch((error: unknown) => {
    throw providerFailure(error)
  })
}

/**
 * Deletes every computer of `account` and its saved disks, with the session records (P5 and the end of a disk's
 * retention: WP A53's provisioner and WP A57 call it after the account's sessions were closed). Returns the names
 * deleted. With no provider named there is nothing at a provider to delete, so only the records go; a provider that is
 * named but missing settings throws, so the caller retries once the owner fixes them.
 */
export async function eraseAccountComputers(account: string, options: ProviderOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const provider = options.provider === undefined ? hostedProvider() : options.provider
  const records = Array.from({ length: MAX_COMPUTERS }, (_, index) =>
    hostedComputerKey(computerName(account, index + 1)),
  )
  if (!provider) {
    await persistentStore(["DEL", ...records], fetcher)
    return []
  }
  if (!provider.configured()) throw unavailable()
  const deleted: string[] = []
  try {
    for (const computer of await provider.list(accountComputerPrefix(account))) {
      if (!isComputerName(computer.name)) continue
      if ((await provider.destroy(computer.name)) === "deleted") deleted.push(computer.name)
    }
  } catch (error) {
    throw providerFailure(error)
  }
  await persistentStore(["DEL", ...records], fetcher)
  return deleted
}

function readyProvider(options: ProviderOptions) {
  const provider = options.provider === undefined ? hostedProvider() : options.provider
  if (!provider?.configured()) throw unavailable()
  return provider
}

/**
 * Whether a session's running block still holds its time at `now`: within the block's hold (`expiresAt`) and no later
 * than its `stopBy` (startedAt + `HOLD_MINUTES`), plus `slackMs`. A session past its stopBy is running on time nobody
 * held, so its computer must stop.
 */
function blockHeld(block: BlockEntry, now: number, slackMs: number) {
  return now < block.expiresAt && now < block.startedAt + HOLD_MINUTES * 60_000 + slackMs
}

// ── The reconciler ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The reconciler acts at most this often, however often the reaper calls it. */
export const RECONCILE_EVERY_MS = 3 * 60_000
/** A session may run this long past its block's stopBy before the reconciler stops it (the reaper stops it first). */
export const RECONCILE_SLACK_MS = 2 * 60_000
const RECONCILE_BUDGET_MS = 40_000
export const hostedReconcileKey = () => codiumKey("hosted", "reconcile")

export type ReconcileResult = {
  ran: boolean
  reason?: "not-configured" | "recent" | "store-unavailable" | "provider-unavailable"
  /** Running or starting computers looked at. */
  checked: number
  live: number
  stopped: string[]
  /** Computers whose session could not be read (the store failed); left running, looked at again next time. */
  unknown: number
  failed: string[]
}

/**
 * The orphan reaper (M9). Lists this mode's running and starting computers and stops each one without a live session:
 * no session record, a record that does not name this computer, or no block of the session still held (WP A51's
 * running blocks). With the owner's `hosted` switch at `stop`, every one is stopped. A computer whose session cannot be
 * read is left for the next pass: the provider's own timeout (the job's deadline plus 5 minutes) still stops it. The
 * owner is emailed (once in 6 hours) when it stopped or failed to stop a computer, naming computers only.
 */
export async function reconcileHostedComputers(
  options: ProviderOptions & { force?: boolean; budgetMs?: number } = {},
): Promise<ReconcileResult> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const started = clock()
  const result: ReconcileResult = { ran: false, checked: 0, live: 0, stopped: [], unknown: 0, failed: [] }
  const provider = options.provider === undefined ? hostedProvider() : options.provider
  if (!provider?.configured()) return { ...result, reason: "not-configured" }
  let stopAll: boolean
  try {
    if (!options.force) {
      const taken = await persistentStore(
        ["SET", hostedReconcileKey(), String(started), "NX", "PX", RECONCILE_EVERY_MS - 10_000],
        fetcher,
      )
      if (taken !== "OK") return { ...result, reason: "recent" }
    }
    stopAll = (await readSwitch("hosted", fetcher, { fresh: true, now: started })) === "stop"
  } catch {
    return { ...result, reason: "store-unavailable" }
  }
  let computers: ComputerInfo[]
  try {
    computers = await provider.list(COMPUTER_PREFIX)
  } catch {
    return { ...result, reason: "provider-unavailable" }
  }
  result.ran = true
  for (const computer of computers) {
    if (!isComputerName(computer.name) || !ACTIVE_STATUSES.includes(computer.status)) continue
    if (clock() - started > (options.budgetMs ?? RECONCILE_BUDGET_MS)) {
      result.unknown++
      continue
    }
    result.checked++
    const live = stopAll ? false : await sessionLive(computer.name, fetcher, clock())
    if (live === undefined) {
      result.unknown++
      continue
    }
    if (live) {
      result.live++
      continue
    }
    try {
      const stopped = await provider.stop(computer.name)
      if (stopped === "stopped") result.stopped.push(computer.name)
    } catch {
      result.failed.push(computer.name)
    }
  }
  if (result.stopped.length || result.failed.length)
    await notifyOwner(
      {
        kind: "hosted-orphans",
        subject: "Vector cloud computers: computers without a session were stopped",
        lines: [
          stopAll
            ? "The hosted switch is at stop, so every running cloud computer was stopped."
            : "These cloud computers were running without a live session (no block of time held), so they were stopped.",
          ...(result.stopped.length ? ["", "Stopped:", ...result.stopped] : []),
          ...(result.failed.length ? ["", "Could not be stopped (tried again next pass):", ...result.failed] : []),
          "",
          "Computers are named by an HMAC of the account, never the account id. A computer without a session points at a",
          "session that ended without stopping its computer; WP A53's reaper normally stops it first.",
        ],
        dedupeMs: 6 * 3_600_000,
      },
      fetcher,
    ).catch(() => undefined)
  return result
}

/**
 * Whether `name` runs for a live session: true or false, or undefined when the store cannot say. A record that is
 * missing, unreadable or names another computer, or a session with no block held, is not live.
 */
async function sessionLive(name: string, fetcher: typeof fetch, now: number): Promise<boolean | undefined> {
  let raw: unknown
  try {
    raw = await persistentStore(["GET", hostedComputerKey(name)], fetcher)
  } catch {
    return undefined
  }
  const record = decodeRecord(raw)
  if (!record) return false
  try {
    if (computerName(record.account, record.computer) !== name) return false
  } catch {
    return false
  }
  let blocks: BlockEntry[]
  try {
    blocks = await runningBlocks(record.account, fetcher)
  } catch {
    return undefined
  }
  const block = blocks.find((entry) => entry.session === record.session)
  return block !== undefined && blockHeld(block, now, RECONCILE_SLACK_MS)
}

function decodeRecord(raw: unknown): ComputerRecord | undefined {
  if (typeof raw !== "string") return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (
    record.v !== 1 ||
    typeof record.account !== "string" ||
    typeof record.session !== "string" ||
    !SESSION.test(record.session) ||
    typeof record.computer !== "number" ||
    typeof record.startedAt !== "number"
  )
    return undefined
  return record as ComputerRecord
}

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function request() {
  return new ApiError(400, "HOSTED_REQUEST", "This cloud computer request is not valid.")
}

/** A provider's failure as the service's answer: Vector's own refusals pass through, anything else is a 503. */
function providerFailure(error: unknown) {
  return error instanceof ApiError ? error : unavailable()
}
