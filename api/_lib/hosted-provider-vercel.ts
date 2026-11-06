import type { NetworkPolicy, Sandbox } from "@vercel/sandbox"
import { Hosted } from "../../packages/schema/src/hosted.js"
import { unavailable } from "./hosted-entitlement.js"
import type {
  ComputerConfig,
  ComputerInfo,
  ComputerStatus,
  HostedProvider,
  StartedComputer,
  StopResult,
} from "./hosted-provider.js"
import type { StripeMode } from "./model-plan-stripe.js"

/*
 * Vercel Sandbox as the cloud computer's provider (contract WP A52), through `@vercel/sandbox` (pinned in the root
 * package.json). Used only while `VECTOR_HOSTED_PROVIDER=vercel`, which the owner sets after Vercel's written OK
 * (contract §8.2 step 14), and only with every setting below: the SDK is always given the hosted team's token, team and
 * Vercel project explicitly, so it can never fall back to the main deployment's own credentials and start a computer
 * on the team that serves vectordev.ai.
 *
 * Settings: `VECTOR_HOSTED_VERCEL_TOKEN` (an access token scoped to the hosted team), `VECTOR_HOSTED_VERCEL_TEAM_ID`,
 * `VECTOR_HOSTED_VERCEL_PROJECT_ID` (the hosted team's one empty Vercel project) and `VECTOR_HOSTED_BASE_SNAPSHOT` (the
 * image workflow's snapshot id, WP A54/A58). The hosted team must be the one the spend guard watches
 * (`VERCEL_HOSTED_TEAM_ID` with `VERCEL_SPEND_WEBHOOK_SECRET_HOSTED`, M9) and never the main team.
 *
 * How a computer maps onto a sandbox: one persistent sandbox per computer, named as `hosted-provider.ts` says and
 * tagged with the server's mode and the computer's size. The first start creates it from the base snapshot; every
 * later start applies the session's settings to the stopped sandbox (a running one is stopped first, so every session
 * boots clean) and resumes it from its own saved disk. A sandbox whose saved disk has expired is deleted and made again
 * from the base snapshot. Region iad1 only, with no failover, because the rates are iad1's. The egress policy allows
 * every public domain, refuses the denied blocks before any domain rule, and has one transform: the run token header
 * on the run-API host. Vercel redacts injected header values when a policy is read back.
 */

export const MODE_TAG = "vector-mode"
export const SIZE_TAG = "vector-size"
const CALL_TIMEOUT_MS = 30_000
const RESUME_TRIES = 4
const RESUME_WAIT_MS = 2_000
const LIST_PAGE = 100
const LIST_PAGES = 50
const ID = /^[A-Za-z0-9_-]{4,128}$/

/** The SDK calls the adapter makes: the real `Sandbox` class, or a fake in tests. */
export type VercelSandboxSdk = Pick<typeof Sandbox, "create" | "get" | "getOrCreate" | "list">
type Credentials = { token: string; teamId: string; projectId: string }

/** Why the Vercel provider cannot be used, as env names only (never values). Empty when it can. */
export function vercelProviderProblems(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = []
  const team = env.VECTOR_HOSTED_VERCEL_TEAM_ID?.trim() ?? ""
  if (!env.VECTOR_HOSTED_VERCEL_TOKEN?.trim()) problems.push("VECTOR_HOSTED_VERCEL_TOKEN is not set")
  if (!ID.test(team)) problems.push("VECTOR_HOSTED_VERCEL_TEAM_ID is not set")
  if (!ID.test(env.VECTOR_HOSTED_VERCEL_PROJECT_ID?.trim() ?? ""))
    problems.push("VECTOR_HOSTED_VERCEL_PROJECT_ID is not set")
  if (!ID.test(env.VECTOR_HOSTED_BASE_SNAPSHOT?.trim() ?? "")) problems.push("VECTOR_HOSTED_BASE_SNAPSHOT is not set")
  if (team && env.VERCEL_HOSTED_TEAM_ID?.trim() !== team)
    problems.push("VERCEL_HOSTED_TEAM_ID must name the same team as VECTOR_HOSTED_VERCEL_TEAM_ID (the spend guard)")
  if (!env.VERCEL_SPEND_WEBHOOK_SECRET_HOSTED?.trim())
    problems.push("VERCEL_SPEND_WEBHOOK_SECRET_HOSTED is not set (the spend guard)")
  if (team && env.VERCEL_MAIN_TEAM_ID?.trim() === team)
    problems.push("VECTOR_HOSTED_VERCEL_TEAM_ID must not be the main team (VERCEL_MAIN_TEAM_ID)")
  return problems
}

/** The egress policy a computer runs under: public internet only, and the one injected credential. */
export function vercelNetworkPolicy(config: Pick<ComputerConfig, "injection" | "deniedSubnets">): NetworkPolicy {
  return {
    allow: {
      [config.injection.host]: [{ transform: [{ headers: { [config.injection.header]: config.injection.value } }] }],
      "*": [],
    },
    subnets: { deny: [...config.deniedSubnets] },
  }
}

/** The sandbox settings every session applies, at creation and before each resume. */
export function vercelSessionSettings(config: ComputerConfig) {
  return {
    persistent: true,
    resources: { vcpus: config.vcpus },
    timeout: config.timeoutMs,
    ports: [...config.ports],
    networkPolicy: vercelNetworkPolicy(config),
    tags: { [MODE_TAG]: config.mode, [SIZE_TAG]: config.size },
    region: config.region,
    snapshotExpiration: config.retentionMs,
    keepLastSnapshots: { count: 1, expiration: config.retentionMs, deleteEvicted: true },
  }
}

/** What creating a computer sends: the session's settings, from the base snapshot, with no environment variables. */
export function vercelCreateParams(config: ComputerConfig, baseSnapshot: string) {
  return {
    name: config.name,
    source: { type: "snapshot" as const, snapshotId: baseSnapshot },
    ...vercelSessionSettings(config),
  }
}

/** What resuming a computer applies first: the session's settings, and no failover out of iad1. */
export function vercelUpdateParams(config: ComputerConfig) {
  return { ...vercelSessionSettings(config), failoverRegions: [] }
}

let loaded: Promise<VercelSandboxSdk> | undefined
/** The real SDK, loaded on the first call that needs it (never at module load, so tests and cold starts skip it). */
function realSdk(): Promise<VercelSandboxSdk> {
  loaded ??= import("@vercel/sandbox").then((module) => module.Sandbox)
  return loaded
}

/**
 * The Vercel provider. `sdk` replaces the real SDK in tests; `mode` is the server's Stripe mode, which every computer
 * it makes is tagged with and every computer it touches must carry.
 */
export function vercelProvider(options: {
  env?: Record<string, string | undefined>
  mode: StripeMode
  sdk?: VercelSandboxSdk
  clock?: () => number
  /** Waits between tries to resume a computer that is still saving its disk (a test seam). */
  wait?: (ms: number) => Promise<void>
}): HostedProvider {
  const env = options.env ?? process.env
  const clock = options.clock ?? Date.now
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const problems = () => vercelProviderProblems(env)
  const ready = async () => {
    if (problems().length) throw unavailable()
    const credentials: Credentials = {
      token: env.VECTOR_HOSTED_VERCEL_TOKEN!.trim(),
      teamId: env.VECTOR_HOSTED_VERCEL_TEAM_ID!.trim(),
      projectId: env.VECTOR_HOSTED_VERCEL_PROJECT_ID!.trim(),
    }
    return { sdk: options.sdk ?? (await realSdk()), credentials, base: env.VECTOR_HOSTED_BASE_SNAPSHOT!.trim() }
  }
  const owned = (sandbox: { tags?: Record<string, string> | undefined }) => sandbox.tags?.[MODE_TAG] === options.mode
  const signal = () => AbortSignal.timeout(CALL_TIMEOUT_MS)
  const find = async (sdk: VercelSandboxSdk, credentials: Credentials, name: string) => {
    try {
      const sandbox = await sdk.get({ ...credentials, name, resume: false, signal: signal() })
      return owned(sandbox) ? sandbox : "missing"
    } catch (error) {
      const kind = sandboxError(error)
      if (kind === "not-found") return "missing"
      if (kind === "disk-missing") return "disk-missing"
      throw unavailable()
    }
  }

  return {
    id: "vercel",
    configured: () => problems().length === 0,
    problems,

    async start(config) {
      const { sdk, credentials, base } = await ready()
      if (config.mode !== options.mode) throw unavailable()
      let created = false
      let sandbox: Sandbox
      try {
        sandbox = await sdk.getOrCreate({
          ...credentials,
          ...vercelCreateParams(config, base),
          resume: false,
          onCreate: async () => {
            created = true
          },
          signal: signal(),
        })
      } catch {
        throw unavailable()
      }
      if (created) return started(sandbox, true, config, clock)
      // A sandbox of this name that another mode (or anything but Vector) made is never resumed, stopped or changed.
      if (!owned(sandbox)) throw unavailable()
      try {
        if (ACTIVE.includes(computerStatus(sandbox.status))) {
          await sandbox.stop({ signal: signal() }).catch((error: unknown) => {
            if (sandboxError(error) !== "stopping") throw error
          })
        }
        await sandbox.update(vercelUpdateParams(config), { signal: signal() })
      } catch {
        throw unavailable()
      }
      let resumed: Sandbox
      try {
        // A computer stopped a moment ago may still be saving its disk; it resumes once that is done.
        for (let attempt = 1; ; attempt++) {
          try {
            resumed = await sdk.get({ ...credentials, name: config.name, resume: true, signal: signal() })
            break
          } catch (error) {
            if (attempt >= RESUME_TRIES || sandboxError(error) !== "stopping") throw error
            await wait(RESUME_WAIT_MS)
          }
        }
      } catch (error) {
        if (sandboxError(error) !== "disk-missing") throw unavailable()
        // Its saved disk expired with the plan's retention: start again from the base snapshot.
        try {
          await sandbox.delete({ deleteOrphanSnapshots: true, signal: signal() })
          resumed = await sdk.create({ ...credentials, ...vercelCreateParams(config, base), signal: signal() })
        } catch {
          throw unavailable()
        }
        return started(resumed, true, config, clock)
      }
      return started(resumed, false, config, clock)
    },

    async setRunToken(config) {
      const { sdk, credentials } = await ready()
      const sandbox = await find(sdk, credentials, config.name)
      if (typeof sandbox === "string") throw unavailable()
      try {
        await sandbox.update({ networkPolicy: vercelNetworkPolicy(config) }, { signal: signal() })
      } catch {
        throw unavailable()
      }
    },

    async stop(name): Promise<StopResult> {
      const { sdk, credentials } = await ready()
      const sandbox = await find(sdk, credentials, name)
      if (sandbox === "missing") return "missing"
      if (sandbox === "disk-missing") return "not-running"
      const status = computerStatus(sandbox.status)
      if (status === "stopping" || status === "snapshotting") return "stopping"
      if (!ACTIVE.includes(status)) return "not-running"
      try {
        await sandbox.stop({ signal: signal() })
        return "stopped"
      } catch (error) {
        const kind = sandboxError(error)
        if (kind === "stopping") return "stopping"
        if (kind === "stopped") return "not-running"
        throw unavailable()
      }
    },

    async destroy(name) {
      const { sdk, credentials } = await ready()
      const sandbox = await find(sdk, credentials, name)
      if (sandbox === "missing") return "missing"
      // Its saved disk is already gone; what Vercel keeps is the name and settings, with no data of the subscriber's.
      if (sandbox === "disk-missing") return "deleted"
      try {
        if (ACTIVE.includes(computerStatus(sandbox.status)))
          await sandbox.stop({ signal: signal() }).catch((error: unknown) => {
            if (!["stopping", "stopped"].includes(sandboxError(error))) throw error
          })
        await sandbox.delete({ deleteOrphanSnapshots: true, signal: signal() })
        return "deleted"
      } catch (error) {
        if (sandboxError(error) === "not-found") return "missing"
        throw unavailable()
      }
    },

    async list(prefix) {
      const { sdk, credentials } = await ready()
      const found: ComputerInfo[] = []
      let cursor: string | undefined
      try {
        for (let page = 0; page < LIST_PAGES; page++) {
          const result = await sdk.list({
            ...credentials,
            namePrefix: prefix,
            tags: { [MODE_TAG]: options.mode },
            limit: LIST_PAGE,
            sortBy: "name",
            ...(cursor ? { cursor } : {}),
            signal: signal(),
          })
          for (const item of result.sandboxes) {
            // The listing is filtered by name and tag already; both are checked again, so nothing else is touched.
            if (!item.name.startsWith(prefix) || item.tags?.[MODE_TAG] !== options.mode) continue
            const size = item.tags[SIZE_TAG]
            found.push({
              name: item.name,
              status: computerStatus(item.status),
              ...(Hosted.isSize(size) ? { size } : {}),
              ...(typeof item.totalActiveCpuDurationMs === "number"
                ? { activeCpuMs: item.totalActiveCpuDurationMs }
                : {}),
              ...(typeof item.totalDurationMs === "number" ? { durationMs: item.totalDurationMs } : {}),
              ...(typeof item.totalEgressBytes === "number" ? { egressBytes: item.totalEgressBytes } : {}),
              updatedAt: item.updatedAt,
            })
          }
          cursor = result.pagination.next ?? undefined
          if (!cursor) break
        }
      } catch {
        throw unavailable()
      }
      return found
    },
  }
}

const ACTIVE: readonly ComputerStatus[] = ["pending", "running"]
const STATUSES: readonly ComputerStatus[] = [
  "pending",
  "running",
  "stopping",
  "snapshotting",
  "stopped",
  "failed",
  "aborted",
]

/** Vercel's session status as a computer status; anything unknown counts as running, so it is never left alone. */
function computerStatus(status: unknown): ComputerStatus {
  return STATUSES.find((value) => value === status) ?? "running"
}

function started(
  sandbox: Sandbox,
  created: boolean,
  config: ComputerConfig,
  clock: () => number,
): Omit<StartedComputer, "runHost"> {
  let viewerUrl: string
  try {
    viewerUrl = sandbox.domain(Hosted.VIEWER_PORT)
  } catch {
    throw unavailable()
  }
  const expiresAt = sandbox.expiresAt?.getTime()
  return {
    name: sandbox.name,
    created,
    viewerUrl,
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : clock() + config.timeoutMs,
  }
}

/**
 * What a failed SDK call means, from the SDK's error (`APIError` carries the HTTP response and its JSON): the sandbox
 * does not exist (404), its saved disk expired (410 `snapshot_not_found`), it is already stopping or snapshotting
 * (422), it is already stopped (410), or anything else.
 */
export function sandboxError(error: unknown): "not-found" | "disk-missing" | "stopping" | "stopped" | "other" {
  const failure = error as { response?: { status?: unknown }; json?: { error?: { code?: unknown } } } | undefined
  const status = failure?.response?.status
  const code = failure?.json?.error?.code
  if (status === 404) return "not-found"
  if (status === 410 && code === "snapshot_not_found") return "disk-missing"
  if (status === 410) return "stopped"
  if (status === 422 && (code === "sandbox_stopping" || code === "sandbox_snapshotting")) return "stopping"
  return "other"
}
