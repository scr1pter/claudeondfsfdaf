import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { LocalEvent } from "@vectordevai/schema/local-event"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalDetect } from "@vectordevai/core/local-mode/detect"
import { LocalHardware } from "@vectordevai/core/local-mode/hardware"
import { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { StartupHold } from "@vectordevai/core/startup-hold"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { LocalSettings } from "@/config/local-settings"
import { EffectBridge } from "@/effect/bridge"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstanceHttpApi } from "../api"
import { LocalApiError, LocalConfirmError } from "../groups/local"

const failure = (code: typeof LocalApiError.Type.data.code, message: string, changes?: readonly string[]) =>
  new LocalApiError({ name: "LocalError", data: { code, message, ...(changes ? { changes: [...changes] } : {}) } })

// The purposes whose requests Vector Local asks about once, which a grant answers: downloads and a manual update check.
const ASKS = new Set<LocalMode.Purpose>(["model-download", "tool-download", "plugin", "lsp-install", "updates"])

export const localHandlers = HttpApiBuilder.group(InstanceHttpApi, "local", (handlers) =>
  Effect.gen(function* () {
    const holds = yield* LocalProbe.HoldsService
    const config = yield* Config.Service
    const bridge = yield* EffectBridge.make()
    // Add server and Check models write a provider to the user's global config. As after PATCH /global/config, the
    // idle instances load it again, so a provider list and the models a session picks include it, and clients hear
    // global.disposed and read their provider lists again.
    const reload = () => bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
    // The app and the terminal UI reload GET /local on local.updated, and tell the user about a block on
    // local.blocked. Both go to every client of this server, like the policy they describe.
    yield* Effect.acquireRelease(Effect.sync(announce), (stop) => Effect.sync(stop))

    // The policy as this repository's instance reports it: with a note when the repository's own config has a local
    // block, which never applies.
    const get = Effect.fn("LocalHttpApi.get")(function* () {
      return LocalSettings.status(yield* config.localPolicy())
    })

    const update = Effect.fn("LocalHttpApi.update")(function* (ctx: { payload: LocalSettings.Update }) {
      const outcome = yield* LocalSettings.apply(ctx.payload, holds)
      if (outcome.type === "applied") return outcome.status
      if (outcome.type === "confirm")
        return yield* new LocalConfirmError({
          name: "LocalConfirmError",
          data: { message: LocalSettings.CONFIRM, changes: [...outcome.changes] },
        })
      return yield* failure(outcome.reason, outcome.message, outcome.changes)
    })

    const egress = Effect.fn("LocalHttpApi.egress")(function* (ctx: {
      query: { since?: number; session?: string; blocked?: boolean }
    }) {
      return Egress.events(ctx.query)
    })

    const egressSummary = Effect.fn("LocalHttpApi.egressSummary")(function* (ctx: { query: { session?: string } }) {
      return Egress.summary(ctx.query.session)
    })

    const egressExport = Effect.fn("LocalHttpApi.egressExport")(function* (ctx: {
      query: { since?: number; session?: string; blocked?: boolean; format?: "jsonl" | "csv" }
    }) {
      const events = yield* Effect.promise(() => Egress.exported(ctx.query))
      const csv = ctx.query.format === "csv"
      return HttpServerResponse.text(csv ? toCsv(events) : events.map((event) => JSON.stringify(event)).join("\n"), {
        contentType: csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
        headers: {
          "content-disposition": `attachment; filename="vector-network-log.${csv ? "csv" : "jsonl"}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      })
    })

    // Under a company lock the company sets how long the network log is kept, so only it erases the log. A Vector the
    // agent started never erases it: the log is the owner's record of what Vector sent, as a shorter one would be.
    const egressClear = Effect.fn("LocalHttpApi.egressClear")(function* () {
      if (Config.local().lock)
        return yield* failure(
          "locked",
          `${LocalSettings.LOCKED} Your company sets how long the network log is kept, so it is not erased here.`,
        )
      if (LocalSettings.agentMarked())
        return yield* failure(
          "agent",
          "An agent or Vector's own terminal started this Vector, so it cannot erase the network log. Erase it yourself in the app or the terminal UI.",
        )
      yield* Effect.promise(() => Egress.erase())
      return true
    })

    // The desktop records what its windows did only while it applies Vector Local, which it may while this Vector reads
    // it off (the two disagree, and the desktop uses the stricter), so its lines are kept whatever this policy says.
    const egressReport = Effect.fn("LocalHttpApi.egressReport")(function* (ctx: {
      payload: { events: readonly LocalMode.Event[] }
    }) {
      ctx.payload.events.forEach((event) => Egress.report(event))
      return ctx.payload.events.length
    })

    const detect = Effect.fn("LocalHttpApi.detect")(function* (ctx: { payload: void | { ports?: readonly number[] } }) {
      const ports = [...new Set([...LocalDetect.PORTS, ...((ctx.payload || undefined)?.ports ?? [])])]
      return yield* Effect.promise(() => LocalDetect.detect({ ports }))
    })

    const probe = Effect.fn("LocalHttpApi.probe")(function* (ctx: {
      payload: { url: string; headers?: Readonly<Record<string, string>> }
    }) {
      return yield* Effect.promise(() => LocalSettings.probe(ctx.payload))
    })

    const addServer = Effect.fn("LocalHttpApi.addServer")(function* (ctx: {
      payload: { url: string; headers?: Readonly<Record<string, string>>; provider?: string; confirm?: boolean }
    }) {
      const read = yield* Effect.promise(() => LocalSettings.probe(ctx.payload))
      if (!read.server) return yield* failure("not-found", read.message ?? `Nothing answered at ${ctx.payload.url}.`)
      const outcome = yield* LocalSettings.addServer({
        server: read.server,
        provider: ctx.payload.provider,
        confirm: ctx.payload.confirm,
        by: "app",
        holds,
      })
      // A server already on the list that answers differently says what changed, for the identity-changed copy.
      const identity = (changed: readonly LocalProbe.Change[] | undefined) =>
        changed && changed.length > 0 ? { identity: [...changed] } : {}
      if (outcome.type === "added") {
        reload()
        return {
          provider: outcome.provider,
          models: outcome.models,
          server: read.server,
          status: outcome.status,
          ...identity(outcome.identity),
        }
      }
      if (outcome.type === "confirm")
        return yield* new LocalConfirmError({
          name: "LocalConfirmError",
          data: { message: LocalSettings.CONFIRM, changes: [...outcome.changes], ...identity(outcome.identity) },
        })
      return yield* failure(outcome.reason, outcome.message, outcome.changes)
    })

    const check = Effect.fn("LocalHttpApi.check")(function* (ctx: {
      payload: void | { model?: string; role?: LocalSettings.Role; confirmed?: boolean }
    }) {
      const payload = ctx.payload || undefined
      const models = yield* LocalSettings.modelsRow().pipe(Effect.orElseSucceed(() => undefined))
      const report = yield* Effect.promise(() => LocalSettings.check({ holds, models }))
      if (!payload?.model) return report
      const checked = yield* LocalSettings.checkModel({
        model: payload.model,
        role: payload.role,
        confirmed: payload.confirmed,
      })
      if (checked.type === "refused") return yield* failure(checked.reason, checked.message, checked.changes)
      const result = checked.checked
      // A check that asks first writes nothing.
      if (result.result !== "ask") reload()
      return {
        ...report,
        model: {
          model: result.model,
          result: result.result,
          requests: result.requests,
          checked_at: result.checked_at,
          ...(result.message === undefined ? {} : { message: result.message }),
          ...(result.context === undefined ? {} : { context: result.context }),
          ...(result.ttft_ms === undefined ? {} : { ttft_ms: result.ttft_ms }),
          ...(result.server_version === undefined ? {} : { server_version: result.server_version }),
        },
      }
    })

    // A grant answers one ask (rule 7): it lets the next request of that kind through, never every one after it.
    const grant = Effect.fn("LocalHttpApi.grant")(function* (ctx: { payload: { source: string } }) {
      const source = LocalSources.get(ctx.payload.source)
      if (!source) return yield* failure("not-found", `Vector has no service called ${ctx.payload.source}.`)
      if (!ASKS.has(source.purpose) && source.local !== "ask-once")
        return yield* failure(
          "invalid",
          `Vector Local does not ask before ${source.id}, so there is nothing to answer once. Allow it for good instead (PATCH /local, or vector local allow).`,
        )
      if (LocalSettings.agentMarked()) return yield* failure("agent", LocalSettings.AGENT)
      Egress.grant(source.id, { once: true })
      return true
    })

    // The desktop's first run holds Vector's own startup fetches until the person has chosen how to run models.
    const releaseStartup = Effect.fn("LocalHttpApi.releaseStartup")(function* () {
      return StartupHold.release()
    })

    const recommend = Effect.fn("LocalHttpApi.recommend")(function* () {
      const hardware = yield* Effect.promise(() => LocalHardware.read())
      const suggested = LocalSettings.recommendation(hardware.usable)
      return {
        hardware: {
          summary: LocalHardware.describe(hardware),
          kind: hardware.kind,
          total: hardware.memory.total,
          usable: hardware.usable,
        },
        tier: suggested.tier,
        summary: suggested.summary,
        ...(suggested.note ? { note: suggested.note } : {}),
        label: suggested.label,
        date: suggested.date,
        roles: Object.fromEntries(Object.entries(suggested.roles).map(([role, entry]) => [role, entry ?? null])),
        alternatives: [...suggested.alternatives],
      }
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("egress", egress)
      .handle("egressSummary", egressSummary)
      .handle("egressExport", egressExport)
      .handle("egressClear", egressClear)
      .handle("egressReport", egressReport)
      .handle("detect", detect)
      .handle("probe", probe)
      .handle("addServer", addServer)
      .handle("check", check)
      .handle("grant", grant)
      .handle("releaseStartup", releaseStartup)
      .handle("recommend", recommend)
  }),
)

// Tells every client of this server when the policy changes or a loosening change is held, and about blocks worth
// telling the user (Egress.notices: unlabelled requests and blocks the user caused, once per source in ten minutes).
function announce() {
  const emit = (type: string, properties: Record<string, unknown>) =>
    GlobalBus.emit("event", { directory: "global", payload: { type, properties } })
  const stopLocal = Config.subscribeLocal((change) =>
    emit(LocalEvent.Updated.type, {
      enabled: change.policy.enabled,
      web: change.policy.web,
      lock: change.policy.lock,
      held: change.type === "loosening" || Config.localPending() !== undefined,
    }),
  )
  const stopBlocked = Egress.notices((event) =>
    emit(LocalEvent.Blocked.type, { source: event.source, origin: event.origin }),
  )
  return () => {
    stopLocal()
    stopBlocked()
  }
}

const COLUMNS = [
  "time",
  "source",
  "purpose",
  "class",
  "origin",
  "method",
  "bytes_out",
  "bytes_in",
  "decision",
  "rule",
  "reason",
  "session_id",
  "root_session_id",
  "tool",
  "personal",
  "documents",
  "repository",
] as const

// The network log as CSV: one row per event, the time in ISO form. A cell a spreadsheet would read as a formula is
// written as text.
function toCsv(events: readonly LocalMode.Event[]) {
  const cell = (value: string | number | undefined) => {
    const text = value === undefined ? "" : String(value)
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
  }
  const rows = events.map((event) =>
    [
      new Date(event.time).toISOString(),
      event.source,
      event.purpose,
      event.class,
      event.origin,
      event.method,
      event.bytes_out,
      event.bytes_in,
      event.decision,
      event.rule,
      event.reason,
      event.session_id,
      event.root_session_id,
      event.tool,
      event.carried.personal,
      event.carried.documents,
      event.carried.repository,
    ]
      .map(cell)
      .join(","),
  )
  return [COLUMNS.join(","), ...rows].join("\n")
}
