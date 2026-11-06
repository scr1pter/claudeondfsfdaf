import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@vectordevai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@vectordevai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { PermissionV2 } from "@vectordevai/core/permission"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { EventV2Bridge } from "@/event-v2-bridge"
import { UNREAD } from "@/tool/shell/unread"
import { TaskPlace } from "@/task/place"

export const Event = PermissionV1.Event

/** The feedback a permission request no one answered in time is declined with (`sizing.subagents.ask_timeout`). */
export const TIMED_OUT =
  "No one answered this permission request in time, so it was declined. Do not retry it or work around it; continue without it and say so in your report."

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  /**
   * Declines one unanswered request that timed out with `CorrectedError({ feedback: message })`. Unlike a rejection it
   * leaves the session's other requests pending. Returns whether it was still pending.
   */
  readonly expire: (requestID: string, message: string) => Effect.Effect<boolean>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  const rule = rulesets
    .flat()
    .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
    action: "ask" as const,
    permission,
    pattern: "*",
  }
  // A shell statement the scan cannot fully read is allowed only by a rule written for it, never by a wildcard such as
  // "*" or "*--version", whether configured or approved with "always".
  if (rule.action === "allow" && pattern.startsWith(UNREAD) && !rule.pattern.startsWith(UNREAD.trim()))
    return { ...rule, action: "ask" }
  return rule
}

export class Service extends Context.Service<Service, Interface>()("@vector/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(
      function* (input: PermissionV1.AskInput) {
        const { approved, pending } = yield* InstanceState.get(state)
        const { ruleset, ...request } = input
        let needsAsk = PermissionPolicy.requiresApproval(request.permission, request.always, request.patterns)

        for (const pattern of request.patterns) {
          // Approvals are shared by every session in the instance and come last, so on their own they would override a
          // session's deny (plan mode, a review session). They may only turn an ask into an allow.
          const own = evaluate(request.permission, pattern, ruleset)
          const rule = own.action === "deny" ? own : evaluate(request.permission, pattern, ruleset, approved)
          yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
          if (rule.action === "deny") {
            return yield* new PermissionV1.DeniedError({
              ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
              permission: request.permission,
              pattern,
            })
          }
          if (rule.action === "allow") continue
          needsAsk = true
        }

        if (!needsAsk) return

        const id = request.id ?? PermissionV1.ID.ascending()
        const info: PermissionV1.Request = {
          id,
          sessionID: request.sessionID,
          permission: request.permission,
          patterns: request.patterns,
          metadata: request.metadata,
          always: request.always,
          tool: request.tool,
        }
        yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

        const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
        pending.set(id, { info, deferred })
        yield* events.publish(Event.Asked, info)
        return yield* Deferred.await(deferred).pipe(
          // A request whose asker stopped waiting, such as a stopped subagent, is withdrawn the way a rejection is
          // announced, so clients stop showing a prompt that can no longer be answered.
          Effect.onInterrupt(() =>
            pending.has(id)
              ? events.publish(Event.Replied, { sessionID: info.sessionID, requestID: id, reply: "reject" })
              : Effect.void,
          ),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(id)
            }),
          ),
        )
      },
      (effect, input) => TaskPlace.atHome(input.sessionID)(effect),
    )

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
      const reply =
        input.reply === "always" &&
        !PermissionV2.canAlwaysApprove(existing.info.permission, existing.info.always, existing.info.patterns)
          ? "once"
          : input.reply

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply,
      })

      if (reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        if (PermissionPolicy.requiresApproval(item.info.permission, item.info.always, item.info.patterns)) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const expire = Effect.fn("Permission.expire")(function* (requestID: string, message: string) {
      const { pending } = yield* InstanceState.get(state)
      const existing = pending.get(requestID as PermissionV1.ID)
      if (!existing) return false
      pending.delete(existing.info.id)
      yield* Effect.logInfo("expired", { requestID })
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: "reject",
      })
      yield* Deferred.fail(existing.deferred, new PermissionV1.CorrectedError({ feedback: message }))
      return true
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, expire, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Permission from "."
