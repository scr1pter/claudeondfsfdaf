export * as LocalSettings from "./local-settings"

import { Effect, Option, Schema } from "effect"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { providerAllowed } from "@vectordevai/schema/provider-policy"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { LocalHardware } from "@vectordevai/core/local-mode/hardware"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { LocalRecommend } from "@vectordevai/core/local-mode/recommend"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { ModelV2 } from "@vectordevai/core/model"
import { PositiveInt } from "@vectordevai/core/schema"
import { Token } from "@vectordevai/core/util/token"
import { ConfigLocalV1 } from "@vectordevai/core/v1/config/local"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { requirement } from "@/session/overflow"
import { SystemPrompt } from "@/session/system"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Config } from "./config"

// Vector Local's settings as the Local API (PATCH /local) and `vector local` change them: what is in effect, a change
// to the user's own local block, and the check that reads every layer. A change that would loosen Vector Local (turn
// it off, a looser Web access, a new model server or a new identity for one, a newly allowed service or site) applies
// only after the owner confirms it: in an owner's app or terminal UI, which send `confirm` after a dialog, or at a
// terminal prompt. It never applies in a Vector the agent or Vector's own terminal started (the agent marker), even
// with Vector Local off, and under a company lock only the keys the company left to the user change. Config holds
// what loosens if it is written any other way, and what turning Vector Local on would let reach the internet.

const Strings = Schema.Array(Schema.String)
const ListChange = Schema.Struct({ add: Schema.optional(Strings), remove: Schema.optional(Strings) })

export const AllowRequest = Schema.Struct({
  source: Schema.String,
  hosts: Schema.optional(Strings),
  reason: Schema.String,
}).annotate({ identifier: "LocalAllowRequest" })

/** A change to the user's own local block. Lists change by what they add and remove, so two clients never race. */
export const Change = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  web: Schema.optional(LocalMode.Web),
  endpoints: Schema.optional(ListChange),
  allow: Schema.optional(
    Schema.Struct({ add: Schema.optional(Schema.Array(AllowRequest)), remove: Schema.optional(Strings) }),
  ),
  web_domains: Schema.optional(
    Schema.Struct({ allow: Schema.optional(ListChange), deny: Schema.optional(ListChange) }),
  ),
  /** A server's identity pin, by origin, as Add server or a confirmed identity change records it; null removes it. */
  pins: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(ConfigLocalV1.Pin))),
  retain_days: Schema.optional(PositiveInt),
}).annotate({ identifier: "LocalChange" })
export type Change = typeof Change.Type

export const Update = Schema.Struct({
  ...Change.fields,
  /** The owner confirmed a change that loosens Vector Local, after a dialog that listed what it loosens. */
  confirm: Schema.optional(Schema.Boolean),
  /**
   * Applies the change config is holding, which GET /local lists in `held`: these are the lines the owner saw, and it
   * applies only while they are still what is held. Needs `confirm`, and nothing else in the request.
   */
  held: Schema.optional(Strings),
  /** Which kind of client asked, for the allow entries it adds. */
  by: Schema.optional(Schema.Literals(["app", "cli"])),
}).annotate({ identifier: "LocalUpdate" })
export type Update = typeof Update.Type

export const Held = Schema.Struct({ proposed: LocalMode.Policy, changes: Strings }).annotate({
  identifier: "LocalHeld",
})

export const Source = Schema.Struct({
  id: Schema.String,
  purpose: LocalMode.Purpose,
  hosts: Strings,
  sends: Schema.String,
  why: Schema.String,
  local: LocalMode.SourceLocal,
  where: Schema.Array(LocalMode.Where),
  note: Schema.optional(Schema.String),
}).annotate({ identifier: "LocalSource" })

export const Status = Schema.Struct({
  policy: LocalMode.Policy,
  /** A change to the user's config that would loosen Vector Local, held until the owner confirms it. */
  held: Schema.optional(Held),
  /** The keys of the local block a company lock keeps the user from changing. */
  locked: Strings,
  log: Schema.Struct({ directory: Schema.String, retain_days: Schema.Finite }),
  /** An agent or Vector's own terminal started this Vector, so nothing here can loosen Vector Local. */
  agent: Schema.Boolean,
  sources: Schema.Array(Source),
}).annotate({ identifier: "LocalStatus" })
export type Status = typeof Status.Type

export const CheckRow = Schema.Struct({
  layer: Schema.Literals([
    "switch",
    "policy",
    "held",
    "guard",
    "unlabelled",
    "services",
    "web",
    "server",
    "models",
    "log",
  ]),
  status: Schema.Literals(["pass", "warn", "fail"]),
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
}).annotate({ identifier: "LocalCheckRow" })
export type CheckRow = typeof CheckRow.Type

export const CheckReport = Schema.Struct({
  enabled: Schema.Boolean,
  /** pass: every layer passed (warnings allowed); fail: one failed; off: Vector Local is off, so nothing is enforced. */
  result: Schema.Literals(["pass", "fail", "off"]),
  rows: Schema.Array(CheckRow),
}).annotate({ identifier: "LocalCheckReport" })
export type CheckReport = typeof CheckReport.Type

export type Refusal = "agent" | "locked" | "invalid" | "changed" | "not-found"

export type Outcome =
  | { readonly type: "applied"; readonly status: Status }
  | {
      readonly type: "confirm"
      readonly changes: readonly string[]
      /** For Add server: what changed about a server already on the list since it was pinned. */
      readonly identity?: readonly LocalProbe.Change[]
    }
  | {
      readonly type: "refused"
      readonly reason: Refusal
      readonly message: string
      readonly changes?: readonly string[]
    }

export const CONFIRM = "This change would loosen Vector Local. Apply it?"
export const AGENT =
  "An agent or Vector's own terminal started this Vector, so it cannot loosen Vector Local. Change it yourself in a terminal, or with /local in the terminal UI."
export const LOCKED = "Set by your company. Ask your administrator to change it."
const CHANGED = "The change waiting for you is not the one you confirmed. Look at it again before you apply it."
const NOTHING_HELD = "No change to Vector Local is waiting for you."
const WEB_LABELS: Record<LocalMode.Web, string> = {
  ask: "Ask: research and the browser can read the sites you approve.",
  network: "Your network only: only your network and sites your company lists.",
  none: "None: Vector makes no internet requests. Deep research uses your brain and files.",
}
// Where a request no part of Vector labelled would go, for the check: a documentation address that is never routed.
const UNLABELLED_PROBE = "https://198.51.100.7/"
const USER_KEYS = ["endpoints", "allow", "web_domains", "web"] as const

/** Whether this Vector carries the agent marker: an agent, a program it ran or Vector's own terminal started it. */
export function agentMarked() {
  return process.env[ChildEnvironment.AGENT_MARKER] !== undefined
}

/** What GET /local reports: the policy in effect, a held change, the keys a lock keeps and the source registry. */
export function status(policy: LocalMode.Policy = Config.local()): Status {
  const held = Config.localPending()
  return {
    policy,
    ...(held ? { held: { proposed: held.proposed, changes: [...held.changes] } } : {}),
    locked: locked(policy),
    log: Config.localLog(),
    agent: agentMarked(),
    sources: LocalSources.SOURCES.map((source) => ({
      id: source.id,
      purpose: source.purpose,
      hosts: [...source.hosts],
      sends: source.sends,
      why: source.why,
      local: source.local,
      where: [...source.where],
      ...(source.note ? { note: source.note } : {}),
    })),
  }
}

/**
 * What to install for `usable` bytes of memory, from the company's table (`local.recommend` in its policy) when Vector
 * can use it, else the bundled examples. GET /local/recommend and `vector local setup` both answer with it.
 */
export function recommendation(usable: number) {
  return LocalRecommend.recommend({ usable, table: LocalRecommend.table(Config.localRecommend()) })
}

/** The local block keys a company lock keeps from the user: always the switch, and the keys `user_may` leaves out. */
export function locked(policy: LocalMode.Policy) {
  if (!policy.lock) return []
  return ["enabled", ...USER_KEYS.filter((key) => !policy.user_may.includes(key))]
}

/**
 * Applies `update` to the user's own local block in the global config. A change that loosens Vector Local needs
 * `confirm`; without it the result lists what it would loosen and nothing is written. `holds` releases a server whose
 * new identity pin the owner just recorded.
 */
export const apply = Effect.fn("LocalSettings.apply")(function* (update: Update, holds?: LocalProbe.Holds) {
  const config = yield* Config.Service
  if (update.held) return confirmHeld(update, holds)
  const policy = Config.local()
  const refusal = validate(policy, update)
  if (refusal) return refusal
  const current = Config.localUserBlock()
  if (current.unreadable.length > 0)
    return refused(
      "invalid",
      `Vector could not read the local block in ${current.unreadable.join(", ")}. Fix it there before changing Vector Local.`,
    )
  const by = update.by ?? "app"
  const now = Date.now()
  // The request is judged by what it changes in the block in effect, so an edit config is holding is never taken for
  // part of it: that edit stays in the files as it is, and stays held until the owner confirms it on its own.
  const own = block(Config.localConfirmedBlock(), update, by, now)
  const changes = Config.localLoosening(own)
  if (changes.length > 0 && agentMarked()) return refused("agent", AGENT, changes)
  if (changes.length > 0 && update.confirm !== true) return { type: "confirm" as const, changes }
  const release = changes.length > 0 ? Config.confirmingLocal(own) : () => {}
  // The config writer takes the mutable config shape; nothing here changes the block after it is built. Resolving
  // again after the write applies the owner's confirmation even when the files already said the same.
  yield* config.updateGlobal({ local: block(current.block, update, by, now) as Block }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        Config.refreshLocal()
        release()
      }),
    ),
  )
  Object.entries(update.pins ?? {}).forEach(([origin, pin]) => {
    if (pin) holds?.confirm(origin)
  })
  return { type: "applied" as const, status: status() }
})

// Applies the change config holds, when it is still the one the owner saw, and lets a server whose new identity it
// records answer again.
function confirmHeld(update: Update, holds: LocalProbe.Holds | undefined): Outcome {
  const extra = Object.keys(update).filter((key) => !["held", "confirm", "by"].includes(key))
  if (extra.length > 0)
    return refused("invalid", `Confirm a held change on its own, without ${extra.join(", ")} in the same request.`)
  const held = Config.localPending()
  if (!held) return refused("changed", NOTHING_HELD)
  if (agentMarked()) return refused("agent", AGENT, held.changes)
  if (update.confirm !== true) return { type: "confirm", changes: held.changes }
  const seen = new Set(update.held ?? [])
  if (held.changes.length !== seen.size || held.changes.some((line) => !seen.has(line)))
    return refused("changed", CHANGED, held.changes)
  const before = Config.local().pins ?? {}
  Object.entries(Config.confirmLocal().pins ?? {})
    .filter(([origin, pin]) => JSON.stringify(before[origin]) !== JSON.stringify(pin))
    .forEach(([origin]) => holds?.confirm(origin))
  return { type: "applied", status: status() }
}

function refused(reason: Refusal, message: string, changes?: readonly string[]) {
  return { type: "refused" as const, reason, message, ...(changes ? { changes } : {}) }
}

/**
 * Why `change` cannot apply under `policy`, or undefined: a key a company lock keeps, a looser Web access a lock
 * allows only tighter, an address that is not a model server's origin, a service Vector Local never lets through or
 * one the registry does not have, an allow entry without a reason, or a site pattern that is not a host name.
 */
export function validate(policy: LocalMode.Policy, change: Change): Outcome | undefined {
  // Under a lock a key the company keeps does not change at all, since the policy would not read it; the user may
  // still remove what they added themselves, and make Web access stricter where the company leaves it to them.
  const touches = (key: string) => {
    if (key === "enabled") return change.enabled === false
    if (key === "web") return change.web !== undefined
    if (key === "endpoints") return (change.endpoints?.add?.length ?? 0) > 0
    if (key === "allow") return (change.allow?.add?.length ?? 0) > 0
    if (key === "web_domains") return (change.web_domains?.allow?.add?.length ?? 0) > 0
    return false
  }
  if (locked(policy).some(touches)) return refused("locked", LOCKED)
  if (policy.lock && change.web !== undefined && LocalPolicy.stricter(policy.web, change.web) !== change.web)
    return refused("locked", `${LOCKED} Your company lets you make Web access stricter only.`)
  const badEndpoint = (change.endpoints?.add ?? []).find((item) => endpointProblem(policy, item))
  if (badEndpoint) return refused("invalid", endpointProblem(policy, badEndpoint)!)
  const badSource = (change.allow?.add ?? []).map(allowProblem).find((problem) => problem !== undefined)
  if (badSource) return refused("invalid", badSource)
  const sites = [...(change.web_domains?.allow?.add ?? []), ...(change.web_domains?.deny?.add ?? [])]
  const badSite = sites.find((site) => !HOST_PATTERN.test(site.trim()))
  if (badSite)
    return refused("invalid", `${badSite} is not a site name. Use a host such as docs.example.com or *.example.com.`)
  return undefined
}

const HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

// Why an address cannot go on the model server list, as the resolver would drop it.
function endpointProblem(policy: LocalMode.Policy, input: string) {
  const place = LocalProbe.locate(input)
  if (!place)
    return `${input} is not a model server's address. Use its origin, such as http://127.0.0.1:11434, with no user name or password.`
  const resolved = LocalPolicy.resolve({
    managed: {
      lock: policy.lock,
      user_may: USER_KEYS.filter((key) => policy.user_may.includes(key)),
      endpoint_domains: [...policy.endpoint_domains],
    },
    global: { enabled: true, endpoints: [place.origin] },
  })
  if (resolved.endpoints.some((item) => item.origin === place.origin)) return undefined
  return resolved.warnings.at(-1) ?? `Vector Local cannot list ${place.origin}.`
}

function allowProblem(request: {
  readonly source: string
  readonly reason: string
  readonly hosts?: readonly string[]
}) {
  const source = LocalSources.get(request.source)
  if (!source) return `Vector has no service called ${request.source}. vector local status lists them.`
  if (source.local === "not-allowable")
    return `${source.id} sends your work outside the servers you listed, so Vector Local keeps it off.`
  if (source.local === "not-covered")
    return `${source.id} is not a request Vector makes itself, so there is nothing for Vector Local to allow.`
  if (!request.reason.trim()) return `Say why you allow ${source.id}; Vector Local shows the reason beside it.`
  if (request.reason.length > 500) return "Keep the reason under 500 characters."
  const host = (request.hosts ?? []).find((item) => !HOST_PATTERN.test(item.trim()))
  if (host) return `${host} is not a host name. Use one such as github.com or *.example.com.`
  return undefined
}

/** The user's own local block, as the global config holds it. */
export type Block = NonNullable<ConfigV1.Info["local"]>

/**
 * The user's local block after `change`: lists with what it adds (once each) and without what it removes, an allow
 * entry stamped with when and by what it was added, and a pin set or removed. Keys the change leaves out stay as
 * they are.
 */
export function block(
  current: ConfigLocalV1.Info | undefined,
  change: Change,
  by: "app" | "cli",
  now: number,
): ConfigLocalV1.Info {
  const list = (
    items: readonly string[] | undefined,
    edit: typeof ListChange.Type,
    key: (item: string) => string = (item) => item,
  ) => {
    const removed = new Set((edit.remove ?? []).map(key))
    return (edit.add ?? [])
      .map((item) => item.trim())
      .reduce(
        (kept, item) => (kept.some((other) => key(other) === key(item)) ? kept : [...kept, item]),
        (items ?? []).filter((item) => !removed.has(key(item))),
      )
  }
  const origin = (item: string) => LocalProbe.locate(item)?.origin ?? item
  const endpoints = change.endpoints
    ? list(
        current?.endpoints,
        { add: change.endpoints.add?.map(origin), remove: change.endpoints.remove?.map(origin) },
        origin,
      )
    : current?.endpoints && [...current.endpoints]
  const removedSources = new Set(change.allow?.remove ?? [])
  const added = (change.allow?.add ?? []).map(
    (item): LocalMode.Allowed => ({
      source: item.source,
      ...(item.hosts?.length ? { hosts: item.hosts.map((host) => host.trim().toLowerCase()) } : {}),
      reason: item.reason.trim(),
      added_at: now,
      added_by: by,
    }),
  )
  const replaced = new Set(added.map((item) => item.source))
  const allow = change.allow
    ? [
        ...(current?.allow ?? []).filter((item) => !removedSources.has(item.source) && !replaced.has(item.source)),
        ...added,
      ]
    : current?.allow && [...current.allow]
  const domains = change.web_domains
    ? {
        ...current?.web_domains,
        ...(change.web_domains.allow ? { allow: list(current?.web_domains?.allow, change.web_domains.allow) } : {}),
        ...(change.web_domains.deny ? { deny: list(current?.web_domains?.deny, change.web_domains.deny) } : {}),
      }
    : current?.web_domains
  // A pin config no longer needs is removed by setting it undefined, which the config writer drops.
  const pins = change.pins
    ? {
        ...current?.pins,
        ...Object.fromEntries(
          Object.entries(change.pins).map(([key, pin]) => [origin(key), pin ?? undefined] as const),
        ),
      }
    : current?.pins
  return {
    ...current,
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
    ...(change.web === undefined ? {} : { web: change.web }),
    ...(endpoints === undefined ? {} : { endpoints: [...endpoints] }),
    ...(allow === undefined ? {} : { allow }),
    ...(domains === undefined ? {} : { web_domains: domains }),
    ...(pins === undefined ? {} : { pins: pins as Record<string, typeof ConfigLocalV1.Pin.Type> }),
    ...(change.retain_days === undefined ? {} : { log: { ...current?.log, retain_days: change.retain_days } }),
  }
}

/**
 * Reads every layer of Vector Local, one row each: the switch, the policy's sources, a held change, the network guard,
 * what happens to a request no part of Vector labelled, Vector's own services, Web access, each model server on the
 * list (it answers, and as the server it was when it was added), the models Vector may call and the network log.
 * `models` is the models row (modelsRow), when the caller can read the providers.
 */
export async function check(input: {
  readonly policy?: LocalMode.Policy
  readonly holds?: LocalProbe.Holds
  readonly models?: CheckRow
}): Promise<CheckReport> {
  const policy = input.policy ?? Config.local()
  if (!policy.enabled)
    return {
      enabled: false,
      result: "off",
      rows: [
        { layer: "switch", status: "warn", title: "Vector Local is off", detail: "Turn it on with vector local on." },
      ],
    }
  const held = Config.localPending()
  const unlabelled = LocalPolicy.decide(policy, { purpose: "unknown", url: UNLABELLED_PROBE })
  const service = LocalPolicy.decide(policy, {
    purpose: "catalog",
    url: "https://vectordev.ai/",
    source: "model-catalog",
  })
  const allowed = policy.allow.map((item) => item.source)
  const log = Config.localLog()
  const logProblem = policy.warnings.find((warning) => warning.includes("network log"))
  const rows: CheckRow[] = [
    {
      layer: "switch",
      status: policy.pending ? "fail" : "pass",
      title: policy.pending ? "Vector Local is still starting" : "Vector Local is on",
      detail: policy.pending
        ? "Its policy has not been read yet, so only this computer is reachable."
        : policy.lock
          ? LOCKED
          : undefined,
    },
    {
      layer: "policy",
      status: policy.warnings.filter((warning) => warning !== logProblem).length > 0 ? "warn" : "pass",
      title: "Policy read from your user config and your company's policy",
      detail: policy.warnings.filter((warning) => warning !== logProblem).join(" ") || undefined,
    },
    ...(held
      ? [
          {
            layer: "held" as const,
            status: "warn" as const,
            title: "A change to your config would loosen Vector Local",
            detail: `It ${held.changes.join(", ")}. ${Config.localHeldAdvice()}`,
          },
        ]
      : []),
    {
      layer: "guard",
      status: EgressGuard.installed() ? "pass" : "fail",
      title: EgressGuard.installed()
        ? "The network guard is installed in this process"
        : "The network guard is not installed in this process",
      detail: EgressGuard.installed() ? undefined : "Requests no part of Vector labelled are not checked here.",
    },
    {
      layer: "unlabelled",
      status: unlabelled.decision === "block" ? "pass" : "fail",
      title:
        unlabelled.decision === "block"
          ? "Requests no part of Vector labelled are blocked"
          : "Requests no part of Vector labelled are not blocked",
    },
    {
      layer: "services",
      status: "pass",
      title:
        service.decision === "allow"
          ? "Vector's own services are blocked, except the ones you allowed"
          : "Vector's own services are blocked unless you allow one",
      detail: [
        ...(allowed.length > 0 ? [`You allowed ${allowed.join(", ")}.`] : []),
        "Free models provided by Vector and Vector Codium stay off with Vector Local on.",
      ].join(" "),
    },
    { layer: "web", status: "pass", title: `Web access: ${WEB_LABELS[policy.web]}` },
    ...(await serverRows(policy, input.holds)),
    ...(input.models ? [input.models] : []),
    {
      layer: "log",
      status: logProblem ? "fail" : "pass",
      title: logProblem
        ? "The network log is kept in memory only"
        : `The network log is kept for ${log.retain_days} days`,
      detail: logProblem ?? log.directory,
    },
  ]
  return { enabled: true, result: rows.some((row) => row.status === "fail") ? "fail" : "pass", rows }
}

/** The exit status `vector local check` ends with: 0 when every layer passes, 1 when one fails, 2 when Local is off. */
export function exitCode(report: CheckReport) {
  if (report.result === "off") return 2
  return report.result === "fail" ? 1 : 0
}

// One row per model server on the list: it answers, as the server it was when it was added. A server whose identity
// changed is held until the owner confirms it (LocalProbe.verify). A company's patterns name no one server to read.
async function serverRows(policy: LocalMode.Policy, holds: LocalProbe.Holds | undefined): Promise<CheckRow[]> {
  if (policy.endpoints.length === 0)
    return [
      {
        layer: "server",
        status: "fail",
        title: "No model servers on your list",
        detail: "Model calls have nowhere to go. Add one with vector local setup.",
      },
    ]
  return Promise.all(
    policy.endpoints.map(async (endpoint): Promise<CheckRow> => {
      const origin = LocalPolicy.origin(endpoint.origin)
      if (!origin || endpoint.origin.includes("*") || !URL.canParse(endpoint.origin))
        return {
          layer: "server",
          status: "pass",
          title: `Your company lists ${endpoint.origin}`,
          detail: "Servers that match it are on your list; Vector reads each when it first calls it.",
          origin: endpoint.origin,
        }
      const by = endpoint.from === "managed" ? " (listed by your company)" : ""
      const pin = policy.pins?.[origin]
      const verified = pin
        ? await LocalProbe.verify({ origin, pin, holds }).catch(() => ({ status: "unreachable" as const }))
        : await LocalProbe.probe(origin)
            .then((server) => (server ? { status: "same" as const, server } : { status: "unreachable" as const }))
            .catch(() => ({ status: "unreachable" as const }))
      if (verified.status === "unreachable")
        return {
          layer: "server",
          status: "fail",
          title: `Nothing answered at ${origin}${by}`,
          detail: "Start the server, or remove it from your list.",
          origin,
        }
      if (verified.status === "changed")
        return { layer: "server", status: "fail", title: verified.message, detail: CHECK_IT, origin }
      const server = verified.server
      const notes = [
        pin ? "It answers as it did when it was added." : NO_PIN,
        server.class !== "this-computer" && !server.encrypted ? NOT_ENCRYPTED : undefined,
        server.forwards ? FORWARDS : undefined,
      ].filter((note) => note !== undefined)
      return {
        layer: "server",
        status: notes.length > 1 || !pin ? "warn" : "pass",
        title: `${[server.name, server.version].filter(Boolean).join(" ")} at ${new URL(origin).host}${by}`,
        detail: notes.join(" "),
        origin,
      }
    }),
  )
}

const CHECK_IT = "Requests to it are held. Check the server, then add it again to record who it is now."
const NO_PIN =
  "It has no identity pin, so Vector cannot tell if another server takes its place. Add it again with vector local setup to pin it."
export const NOT_ENCRYPTED = "Not encrypted: prompts to this server travel in plain text on your network."
export const FORWARDS =
  "This server may pass your prompts or queries on to services it is set up to use. Vector can't see past it."

/**
 * Reads the server a typed address points at, as Add server does: with Vector Local on, a server not on the list yet
 * is read through Egress.checking, so only that origin is let through while it is read (no prompts are sent). A
 * server Vector Local would not let the user list is not read at all (probeProblem), and neither is one a Vector the
 * agent started could not add.
 */
export async function probe(input: { readonly url: string; readonly headers?: Readonly<Record<string, string>> }) {
  const place = LocalProbe.locate(input.url)
  if (!place)
    return {
      server: null,
      message: `${input.url} is not a model server's address. Use its origin, such as http://127.0.0.1:11434.`,
    }
  const problem = probeProblem(Egress.policy(), place.origin)
  if (problem) return { server: null, message: problem }
  const server = await Egress.checking(LocalProbe.SERVER_CHECK, place.origin, () =>
    LocalProbe.probe(input.url, { headers: input.headers }),
  ).catch(() => undefined)
  if (server) return { server }
  return { server: null, message: `No model server Vector knows answered at ${place.origin}.` }
}

/**
 * Why Add server does not read the server at `origin`, before anything connects, or undefined. A server on the list,
 * and one on this computer, are always read. Otherwise: a Vector the agent started cannot add a server, so it reads
 * none; and with Vector Local on, a server on the internet is not read with Web access None, one outside your network
 * and the sites the policy names is not read with Your network only, and under a company lock one the company does not
 * let you list is not read. Egress.checking would let any of them through, since allowing the source would.
 */
function probeProblem(policy: LocalMode.Policy, origin: string) {
  const place = LocalPolicy.hostClass(new URL(origin).hostname)
  if (place === "this-computer" || LocalPolicy.listed(policy, origin)) return undefined
  if (agentMarked()) return AGENT
  if (!policy.enabled) return undefined
  if (place === "internet" && policy.web === "none")
    return "Web access is set to None, so Vector reads no server on the internet. Your network still works."
  if (policy.lock && endpointProblem(policy, origin))
    return policy.user_may.includes("endpoints")
      ? `${LOCKED} It lets you add only servers on your network or the ones it names, so Vector does not read ${origin}.`
      : `${LOCKED} It keeps the model server list, so Vector does not read ${origin}.`
  if (place === "internet" && policy.web === "network" && !LocalPolicy.named(policy, origin))
    return `Web access is set to Your network only, so Vector reads no server on the internet your company does not name. Set Web access to Ask to add ${origin}.`
  return undefined
}

/**
 * The models row of the check: the providers whose models Vector may call with Vector Local on, and the ones it keeps
 * off. It fails when none is left, since every model call would then be refused.
 */
export const modelsRow = Effect.fn("LocalSettings.modelsRow")(function* () {
  const providers = yield* Provider.Service
  const usable = Object.values(yield* providers.list()).filter((provider) => Object.keys(provider.models).length > 0)
  const off = (yield* providers.unavailable()).filter((item) => item.reason === "off-in-local").map((item) => item.id)
  const offLine = off.length > 0 ? `Off in Vector Local: ${[...new Set(off)].join(", ")}.` : undefined
  if (usable.length === 0)
    return {
      layer: "models" as const,
      status: "fail" as const,
      title: "No models Vector may call with Vector Local on",
      detail: ["Add a model server with vector local setup.", offLine].filter(Boolean).join(" "),
    }
  return {
    layer: "models" as const,
    status: "pass" as const,
    title: `Models Vector may call: ${usable.map((provider) => `${provider.id} (${Object.keys(provider.models).length})`).join(", ")}`,
    ...(offLine ? { detail: offLine } : {}),
  }
})

// The provider name each kind of server is added as, the names the app's server presets use.
const PROVIDER_NAMES: Record<LocalProbe.Kind, string> = {
  ollama: "ollama",
  lmstudio: "lm-studio",
  vllm: "vllm",
  llamacpp: "llama-cpp",
  sglang: "sglang",
  openai: "local-server",
}
const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

/** A provider name based on `base` that nothing uses yet: ollama, then ollama-2, ollama-3, … */
export function freeID(base: string, taken: readonly string[]) {
  const used = (id: string) => taken.includes(id) || providerAllowed(id)
  if (!used(base)) return base
  return Array.from({ length: 98 }, (_, index) => `${base}-${index + 2}`).find((id) => !used(id)) ?? base
}

/**
 * What changed about a server already pinned since it was pinned (its kind, version, models or https key), as it
 * answers now: empty for a server with no pin, or one that answers as it did.
 */
export function identity(server: LocalProbe.Server) {
  const pin = Config.local().pins?.[server.origin]
  return pin ? LocalProbe.changes(pin, server) : []
}

/**
 * Add server: puts the server on the model server list with the identity it answered with (a change that loosens
 * Vector Local while it is on, so it needs `confirm` then; a new identity for a server on the list needs it on or off),
 * and adds it to the user's global config as a provider with the models it runs there, each with its context, reply
 * limit, tool calling and image input. Its cloud models are left out. Nothing is written when the listing is refused
 * or waits for confirmation. `identity` says what changed when the server was pinned before and answers differently
 * now.
 */
export const addServer = Effect.fn("LocalSettings.addServer")(function* (input: {
  readonly server: LocalProbe.Server
  readonly provider?: string
  readonly confirm?: boolean
  readonly by: "app" | "cli"
  readonly holds?: LocalProbe.Holds
}) {
  const config = yield* Config.Service
  const providers = yield* Provider.Service
  // The user's global config as last written, the repository's config and every provider Vector knows: a name any of
  // them uses is taken, so a server never replaces a provider.
  const taken = [
    ...Object.keys((yield* config.getGlobal()).provider ?? {}),
    ...Object.keys((yield* config.get()).provider ?? {}),
    ...Object.keys(yield* providers.list()),
  ]
  const named = input.provider?.trim()
  const providerID = named || freeID(PROVIDER_NAMES[input.server.kind], taken)
  if (!PROVIDER_ID.test(providerID) || (named && (taken.includes(named) || providerAllowed(named))))
    return refused(
      "invalid",
      `Choose an unused provider name of lowercase letters, numbers, hyphens or underscores, not ${providerID}.`,
    )
  const server = input.server
  const changed = identity(server)
  const listed = yield* apply(
    {
      endpoints: { add: [server.origin] },
      pins: { [server.origin]: server.pin },
      confirm: input.confirm,
      by: input.by,
    },
    input.holds,
  )
  if (listed.type === "confirm") {
    // Typed as the outcome it is, so a caller that asks the owner and tries again still tells it from the result.
    const asking: Extract<Outcome, { type: "confirm" }> = { ...listed, identity: changed }
    return asking
  }
  if (listed.type !== "applied") return listed
  const patch = LocalProbe.patch({ providerID, server, list: false })
  const models = server.models.filter((model) => !model.cloud)
  yield* config.updateGlobal({
    provider: {
      [providerID]: {
        npm: "@ai-sdk/openai-compatible",
        name: `${server.name} (${new URL(server.origin).host})`,
        options: { baseURL: server.baseURL, ...patch.provider[providerID]?.options },
        models: Object.fromEntries(
          models.map((model) => [model.id, { name: model.id, ...patch.provider[providerID]?.models[model.id] }]),
        ),
      },
    },
  } as ConfigV1.Info)
  return {
    type: "added" as const,
    provider: providerID,
    models: models.map((model) => model.id),
    identity: changed,
    status: status(),
  }
})

export const Role = Schema.Literals(["agent", "subagent", "review", "judge", "research"])
export type Role = typeof Role.Type

// The agent whose tools each role's check sends, and who needs the context, for the message. Vectorscope reviews with
// the review agent; the judge's tools are the read-only specialist's, which Deep research's judge (no tools) fits in.
const ROLES: Record<Role, { readonly agent: string; readonly label: string }> = {
  agent: { agent: "build", label: "Vector's agent" },
  subagent: { agent: "general", label: "Vector's subagents" },
  review: { agent: "review", label: "Vectorscope" },
  judge: { agent: "judge", label: "Vector's judge" },
  research: { agent: "research", label: "Deep research" },
}

/**
 * Check models for one model: 2 or 3 requests to its server with the role's real tools, as the agent sends them
 * (LocalProbe.check), after reading the server and comparing it with its identity pin. A result is written to the
 * user's global config: the model's tool calling and limits, what the server says about itself in the provider's
 * options (`forwards` for a LiteLLM proxy, `concurrency` where none is set, `headerTimeout`), and `local.checked`; a
 * model the catalog lists at a cloud address keeps the catalog's limits. It reads only servers you or your company
 * host: never a cloud AI service, and never a server on the internet that is not on the list, since its requests carry
 * the role's tools and the provider's key. With Vector Local on it reaches only a server on the list, since its
 * requests are model calls.
 */
export const checkModel = Effect.fn("LocalSettings.checkModel")(function* (input: {
  readonly model: string
  readonly role?: Role
  readonly confirmed?: boolean
}) {
  const config = yield* Config.Service
  const providers = yield* Provider.Service
  const agents = yield* Agent.Service
  const registry = yield* ToolRegistry.Service
  const ref = ModelV2.parse(input.model)
  if (!ref.providerID || !ref.modelID)
    return refused("invalid", `Name the model as provider/model, such as ollama/qwen3-coder.`)
  const provider = (yield* providers.getProvider(ref.providerID)) as Provider.Info | undefined
  const configured = (yield* config.get()).provider?.[ref.providerID]
  const options = { ...configured?.options, ...provider?.options } as Record<string, unknown>
  const baseURL = typeof options.baseURL === "string" ? options.baseURL : undefined
  if (!baseURL)
    return refused(
      "invalid",
      `${ref.providerID} has no server address (options.baseURL), so it is not a server Vector can check.`,
    )
  const headers = Object.fromEntries(
    Object.entries(isRecord(options.headers) ? options.headers : {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
  const apiKey = provider?.key ?? (typeof options.apiKey === "string" ? options.apiKey : undefined)
  const policy = Config.local()
  const place = LocalProbe.locate(baseURL)
  const problem = checkProblem(policy, baseURL)
  if (problem) return refused("invalid", problem)
  const server = yield* Effect.promise(() => LocalProbe.probe(baseURL, { headers }).catch(() => undefined))
  if (!server) return refused("not-found", `No model server Vector knows answered at ${place?.origin ?? baseURL}.`)
  const pin = policy.pins?.[server.origin]
  const changed = pin ? LocalProbe.changes(pin, server) : []
  if (changed.length > 0) return refused("changed", LocalProbe.changedMessage(server.origin))
  const role = ROLES[input.role ?? "agent"]
  const agent = yield* agents.get(role.agent)
  const offered = yield* registry.tools({ providerID: ref.providerID, modelID: ref.modelID, agent })
  // The tools the agent's own rules turn off are left out, as a session's request leaves them out (resolveTools).
  const off = Permission.disabled(
    offered.map((tool) => tool.id),
    agent.permission,
  )
  const tools = offered
    .filter((tool) => !off.has(tool.id))
    .map((tool) => ({
      name: tool.id,
      description: tool.description,
      parameters: ToolJsonSchema.fromTool(tool) as Record<string, unknown>,
    }))
  const model = yield* providers.getModel(ref.providerID, ref.modelID).pipe(Effect.option)
  const system = agent.prompt ? [agent.prompt] : Option.isSome(model) ? SystemPrompt.provider(model.value) : []
  const required = requirement(Token.estimate([...system, ...tools.map((tool) => JSON.stringify(tool))].join("\n")))
  const free =
    server.class === "this-computer"
      ? yield* Effect.promise(() =>
          LocalHardware.read()
            .then(LocalHardware.free)
            .catch(() => undefined),
        )
      : undefined
  const checked = yield* Effect.promise(() =>
    LocalProbe.check({
      server,
      model: ref.modelID,
      tools,
      required,
      role: role.label,
      headers,
      apiKey,
      free,
      confirmed: input.confirmed,
    }),
  )
  if (checked.result === "ask") return { type: "checked" as const, checked }
  const result = unsized(checked, model, role.label, server)
  const current = Config.localUserBlock().block
  const concurrency = (yield* config.getGlobal()).provider?.[ref.providerID]?.options?.concurrency
  const patch = LocalProbe.patch({
    providerID: ref.providerID,
    server,
    checks: [result],
    current,
    concurrency,
    list: false,
  })
  // A model the catalog lists at a cloud address keeps the catalog's limits: the server checked here, such as a proxy
  // the user hosts, passes its requests on to that service. What the server says about itself applies either way: a
  // LiteLLM proxy passes every prompt on (`forwards`, so its steps are never counted as free local ones and a dollar
  // cap still stops them), how many requests it takes where no count is set, and the longer wait for headers.
  const listedAt = Option.isSome(model) ? model.value.api.url : ""
  const catalogued = URL.canParse(listedAt) && LocalPolicy.hostClass(new URL(listedAt).hostname) === "internet"
  const written = patch.provider[ref.providerID]
  const entry = catalogued ? undefined : written?.models[ref.modelID]
  yield* config.updateGlobal({
    ...(entry || written?.options
      ? {
          provider: {
            [ref.providerID]: {
              ...(written?.options ? { options: written.options } : {}),
              ...(entry ? { models: { [ref.modelID]: entry } } : {}),
            },
          },
        }
      : {}),
    local: { checked: { ...current?.checked, ...patch.local.checked } },
  } as ConfigV1.Info)
  return { type: "checked" as const, checked: result }
})

// A model that works but whose context neither the server nor the user's config gives: Vector's agents refuse a model
// with no known context on a server someone hosts (session/overflow.ts), so the check says so rather than a plain
// "works", with how to set it.
function unsized(
  checked: LocalProbe.Checked,
  model: Option.Option<Provider.Model>,
  role: string,
  server: LocalProbe.Server,
): LocalProbe.Checked {
  if (checked.result !== "works" || checked.context || checked.message) return checked
  const configured = Option.isSome(model) ? model.value.limit.input || model.value.limit.context : 0
  if (configured > 0) return checked
  const fix =
    server.kind === "ollama"
      ? "Set num_ctx for it in Ollama, or limit.context for this model in your config."
      : "Set limit.context for this model in your config."
  return {
    ...checked,
    message: `It calls tools, but ${server.name} did not say how large ${checked.model}'s context is, so ${role} refuses it until a context is set. ${fix}`,
  }
}

// Why Check models does not read the server at `address`: a cloud AI service the company did not list, whose limits
// come from the model catalog; a server on the internet that is not on the list; or, with Vector Local on, any server
// that is not on the list.
function checkProblem(policy: LocalMode.Policy, address: string) {
  const place = LocalProbe.locate(address)
  const unlisted =
    "is not on your model server list, so Vector Local sends it no model calls. Add it with vector local setup."
  if (!place) return policy.enabled ? `${address} ${unlisted}` : undefined
  if (LocalPolicy.listed(policy, place.origin)) return undefined
  const name = new URL(place.origin).hostname
  if (
    Config.localCloudHosts().some((pattern) => LocalPolicy.hostMatches(name, pattern)) ||
    LocalSources.digestListed(name)
  )
    return `${place.origin} is a cloud AI service, not a server you host. Check models reads only model servers you or your company host; a cloud model's limits come from the model catalog.`
  if (policy.enabled) return `${place.origin} ${unlisted}`
  if (LocalPolicy.hostClass(name) === "internet")
    return `${place.origin} is on the internet and not on your model server list, so Check models sends it neither the role's tools nor the provider's key. Add it with vector local setup first.`
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
