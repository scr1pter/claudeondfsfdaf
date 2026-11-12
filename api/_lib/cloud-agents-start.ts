import { createHash, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import { GithubAgents } from "../../packages/core/src/github-agents.js"
import { bindingFor, bindingKey, generationKey, type RepoBinding } from "./cloud-agents-binding.js"
import {
  cloudAgentEntitlement,
  ENABLED_SOURCES,
  RUN_SOURCES,
  type CloudAgentAllowance,
  type RunTrigger,
} from "./cloud-agents-entitlement.js"
import { githubApp, type createGithubApp } from "./github-app.js"
import type { GithubIdentity } from "./github-oidc.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

const Account = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const Decimal = Schema.String.check(
  Schema.makeFilter((value: string) => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))),
)
const Whole = Schema.Number.check(Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value > 0))
const Ticket = Schema.Struct({
  repositoryId: Decimal,
  account: Account,
  generation: Whole,
  source: Schema.Literals(RUN_SOURCES),
  purpose: Schema.Literals(["task", "review", "incident", "changes"]),
  exp: Whole,
})
const decodeTicket = Schema.decodeUnknownOption(Schema.fromJsonString(Ticket), { onExcessProperty: "error" })
const FORMAT = /^vtk_[A-Za-z0-9_-]{43}$/
const TTL = 900

type TicketDeps = { store?: typeof persistentStore; app?: ReturnType<typeof createGithubApp>; now?: () => number }
type StartDeps = TicketDeps & { entitlement?: typeof cloudAgentEntitlement; fetcher?: typeof fetch }
export type StartCloudRunResult =
  | { ok: true; dispatchedAt: number }
  | {
      ok: false
      reason:
        | "not-bound"
        | "not-binder"
        | "app-required"
        | "source-unavailable"
        | "purpose-unavailable"
        | "dispatch-failed"
        | Extract<CloudAgentAllowance, { active: false }>["reason"]
    }

export type PreparedCloudRun = {
  ok: true
  /** The opaque ticket's SHA-256; the raw ticket stays in this server-side closure. */
  ticketHash: string
  dispatch: () => Promise<StartCloudRunResult>
  /** Cancel only before dispatch starts, for example after losing an atomic laptop/Actions routing claim. */
  cancel: () => Promise<boolean>
}

/** Internal user-tap entry point. It stores no prompt or requester identity, and never runs inference itself. */
export async function startCloudRun(trigger: RunTrigger, deps: StartDeps = {}): Promise<StartCloudRunResult> {
  const prepared = await prepareCloudRun(trigger, deps)
  return prepared.ok ? prepared.dispatch() : prepared
}

/** Issue a ticket without dispatching. A router must commit its own exclusive route before calling dispatch. */
export async function prepareCloudRun(
  trigger: RunTrigger,
  deps: StartDeps = {},
): Promise<PreparedCloudRun | Extract<StartCloudRunResult, { ok: false }>> {
  const store = deps.store ?? persistentStore
  const app = deps.app ?? githubApp
  const now = deps.now ?? Date.now
  if (!ENABLED_SOURCES.has(trigger.source)) return { ok: false, reason: "source-unavailable" }
  if (trigger.purpose === "scheduled") return { ok: false, reason: "purpose-unavailable" }
  if (
    !Schema.is(Account)(trigger.account) ||
    trigger.target.kind !== "github-run" ||
    !Number.isSafeInteger(trigger.target.repositoryId) ||
    trigger.target.repositoryId < 1 ||
    typeof trigger.prompt !== "string" ||
    !trigger.prompt.trim() ||
    !["task", "review", "incident", "changes"].includes(trigger.purpose)
  )
    throw invalidRequest()
  const binding = await bindingFor(String(trigger.target.repositoryId), store)
  if (!binding || binding.suspended) return { ok: false, reason: "not-bound" }
  if (binding.account !== trigger.account) return { ok: false, reason: "not-binder" }
  if (!binding.installationId || !app.configuration().available) return { ok: false, reason: "app-required" }
  const at = now()
  const allowance = await (deps.entitlement ?? cloudAgentEntitlement)(
    trigger.account,
    { source: trigger.source, now: at },
    deps.fetcher ?? fetch,
  )
  if (!allowance.active) return { ok: false, reason: allowance.reason }
  const ticket = `vtk_${randomBytes(32).toString("base64url")}`
  const record = {
    repositoryId: binding.repositoryId,
    account: binding.account,
    generation: binding.generation,
    source: trigger.source,
    purpose: trigger.purpose,
    exp: now() + TTL * 1000,
  }
  if (!Schema.is(Ticket)(record)) throw invalidRequest()
  const key = ticketKey(ticket)
  const prompt = trigger.prompt
  const issued = await command(
    [
      "EVAL",
      ISSUE,
      "4",
      key,
      `vector:cli-revoked:${binding.account}`,
      bindingKey(binding.repositoryId),
      generationKey(binding.repositoryId),
      JSON.stringify(record),
      binding.account,
      binding.generation,
      TTL,
    ],
    store,
  )
  if (issued === "stale") return { ok: false, reason: "not-bound" }
  if (issued !== "OK") throw unavailable()
  let cancelled = false
  let operation: Promise<StartCloudRunResult> | undefined
  const remove = async () => {
    const removed = await command(["DEL", key], store)
    if (removed !== 0 && removed !== 1) throw unavailable()
  }
  const dispatch = async (): Promise<StartCloudRunResult> => {
    if (cancelled || now() >= record.exp || !ENABLED_SOURCES.has(record.source)) {
      await remove()
      return { ok: false, reason: "not-bound" }
    }
    // Preparing is not continuing authority. Rebinding, erasure, suspension and allowance changes before the
    // router commits must all refuse here; mint repeats these checks before granting any model authority.
    const current = await bindingFor(binding.repositoryId, store)
    if (
      !current ||
      current.suspended ||
      current.account !== record.account ||
      current.generation !== record.generation
    ) {
      await remove()
      return { ok: false, reason: "not-bound" }
    }
    if (!current.installationId || !app.configuration().available) {
      await remove()
      return { ok: false, reason: "app-required" }
    }
    const allowance = await (deps.entitlement ?? cloudAgentEntitlement)(
      record.account,
      { source: record.source, now: now() },
      deps.fetcher ?? fetch,
    )
    if (!allowance.active) {
      await remove()
      return { ok: false, reason: allowance.reason }
    }
    const ready = await command(
      [
        "EVAL",
        READY,
        "4",
        key,
        `vector:cli-revoked:${record.account}`,
        bindingKey(binding.repositoryId),
        generationKey(binding.repositoryId),
        JSON.stringify(record),
        record.account,
        record.generation,
      ],
      store,
    )
    if (ready === "stale") {
      await remove()
      return { ok: false, reason: "not-bound" }
    }
    if (ready !== "OK") throw unavailable()
    try {
      await app.dispatch(current.repositoryId, {
        ref: current.defaultRef,
        prompt,
        ticket,
        ownerId: current.ownerId,
        installationId: current.installationId,
      })
    } catch (error) {
      await remove()
      return {
        ok: false,
        reason: error instanceof ApiError && error.code === "APP_NOT_INSTALLED" ? "app-required" : "dispatch-failed",
      }
    }
    return { ok: true, dispatchedAt: now() }
  }
  return {
    ok: true,
    ticketHash: createHash("sha256").update(ticket).digest("hex"),
    dispatch: () => (operation ??= dispatch()),
    cancel: async () => {
      if (operation) return false
      cancelled = true
      await remove()
      return true
    },
  }
}

/** A read-only peek: only bound reservation may consume a valid ticket. Missing/mismatched tokens grant nothing. */
export async function peekRunTicket(
  ticket: unknown,
  identity: GithubIdentity,
  binding: RepoBinding,
  deps: TicketDeps = {},
) {
  const config = (deps.app ?? githubApp).configuration()
  const slug = config.available ? GithubAgents.slugFromInstallUrl(config.installUrl) : undefined
  if (
    !slug ||
    identity.audience !== GithubAgents.AUDIENCE.mint ||
    !identity.actorIsBot ||
    identity.actor !== `${slug}[bot]` ||
    identity.event !== "workflow_dispatch" ||
    identity.repositoryId !== binding.repositoryId ||
    typeof ticket !== "string" ||
    !FORMAT.test(ticket)
  )
    return undefined
  const key = ticketKey(ticket)
  const raw = await command(["GET", key], deps.store ?? persistentStore)
  if (raw === null) return undefined
  const record = typeof raw === "string" ? Option.getOrUndefined(decodeTicket(raw)) : undefined
  if (!record) throw unavailable()
  if (
    record.repositoryId !== identity.repositoryId ||
    record.account !== binding.account ||
    record.generation !== binding.generation ||
    record.exp <= (deps.now ?? Date.now)() ||
    !ENABLED_SOURCES.has(record.source)
  )
    return undefined
  return { ...record, key }
}

function ticketKey(ticket: string) {
  return `vector:cloud-agents:ticket:${createHash("sha256").update(ticket).digest("hex")}`
}
async function command(input: readonly (string | number)[], store: typeof persistentStore) {
  return Promise.resolve()
    .then(() => store(input))
    .catch(() => {
      throw unavailable()
    })
}
function invalidRequest() {
  return new ApiError(400, "INVALID_REQUEST", "Send only a supported GitHub run trigger.")
}
function unavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Cloud run requests are temporarily unavailable.")
}
const ISSUE = `
for i, expected in ipairs({'string', 'string', 'hash', 'string'}) do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= expected then return 'corrupt' end
end
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('HGET', KEYS[3], 'account') ~= ARGV[2]
  or redis.call('HGET', KEYS[3], 'generation') ~= ARGV[3] or redis.call('GET', KEYS[4]) ~= ARGV[3]
  or redis.call('HEXISTS', KEYS[3], 'suspended') == 1 then return 'stale' end
return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[4])
`

const READY = `
for i, expected in ipairs({'string', 'string', 'hash', 'string'}) do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= expected then return 'corrupt' end
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('EXISTS', KEYS[2]) == 1
  or redis.call('HGET', KEYS[3], 'account') ~= ARGV[2] or redis.call('HGET', KEYS[3], 'generation') ~= ARGV[3]
  or redis.call('GET', KEYS[4]) ~= ARGV[3] or redis.call('HEXISTS', KEYS[3], 'suspended') == 1 then return 'stale' end
return 'OK'
`
