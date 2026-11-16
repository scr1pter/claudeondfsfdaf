export * as ReviewMemoryOwner from "./memory-owner"

import { randomUUID } from "node:crypto"
import { clearTimeout, setTimeout } from "node:timers"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { ReviewMemory } from "@vectordevai/core/brain/review-memory"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import { Config } from "@/config/config"
import { ReviewMemoryAuthority } from "./memory-authority"
import { ReviewMemoryConsent } from "./memory-consent"

export const LIMIT = Object.freeze({ total: 64, scope: 8, bytes: 32 * 1024, ttl: ReviewMemoryControl.LIMIT.ttl })
export type Command = ReviewMemoryControl.Command
export type Confirmation = ReviewMemoryControl.Confirmation
export type Preview = ReviewMemoryControl.Preview
export class Error extends Schema.TaggedErrorClass<Error>()("ReviewMemoryOwner.Error", {
  code: Schema.Literals([
    "invalid",
    "denied",
    "unavailable",
    "limit",
    "stale",
    "used",
    "expired",
    "disabled",
    "not-found",
    "source-unavailable",
  ]),
  message: Schema.String,
}) {}
export interface Interface {
  readonly inspect: (options?: ReviewMemoryControl.InspectInput) => Effect.Effect<ReviewMemoryControl.Inspect, Error>
  readonly prepare: (request: unknown) => Effect.Effect<Preview, Error>
  readonly confirm: (confirmation: unknown) => Effect.Effect<ReviewMemoryControl.ConfirmationResult, Error>
  readonly discard: (previewId: unknown) => Effect.Effect<void, Error>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ReviewMemoryOwner") {}

type Receipt = { actor: ReviewMemoryConsent.Actor; expires: number; sha256: string } & (
  | { state: "prepared"; command: Command; operation: Preview["operation"] }
  | { state: "used" }
)
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const denied = () => new Error({ code: "denied", message: "Review memory requires the authenticated server owner." })
const unavailable = () => new Error({ code: "unavailable", message: "Review memory could not be verified." })
const domain = <A>(result: ReviewMemory.Result<A>): Effect.Effect<A, Error> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(
        new Error({
          code: result.reason === "authority-unavailable" ? "unavailable" : result.reason,
          message:
            "The review memory action could not be completed. Read the current repository state before trying again.",
        }),
      )

/** Inactive until an authenticated owner route/UI and physical-repository namespace are qualified. */
export function make(input: {
  memory: ReviewMemory.Interface
  settings: Pick<Config.Interface, "trust">
  clock?: { now: () => number; date: () => number; schedule?: (delay: number, callback: () => void) => () => void }
}): Interface & { readonly dispose: () => void } {
  const clock = input.clock ?? { now: () => performance.now(), date: () => Date.now() }
  const pending = new Map<string, Receipt>()
  let closed = false
  let cancel: (() => void) | undefined
  let timerEpoch = 0
  const retire = (id: string, entry: Receipt) =>
    pending.set(id, { state: "used", actor: entry.actor, expires: entry.expires, sha256: entry.sha256 })
  const purge = () => {
    const now = clock.now()
    for (const [id, entry] of pending) if (entry.expires <= now) pending.delete(id)
  }
  const schedule =
    input.clock?.schedule ??
    ((delay: number, callback: () => void) => {
      const timer = setTimeout(callback, Math.max(1, delay))
      timer.unref()
      return () => clearTimeout(timer)
    })
  const arm = () => {
    const epoch = ++timerEpoch
    cancel?.()
    cancel = undefined
    if (closed || !pending.size) return
    const next = Math.min(...[...pending.values()].map((entry) => entry.expires))
    cancel = schedule(Math.max(1, next - clock.now()), () => {
      if (closed || epoch !== timerEpoch) return
      cancel = undefined
      purge()
      arm()
    })
  }
  const owner = Effect.gen(function* () {
    const current = yield* ReviewMemoryAuthority.ownerScope(input.settings)
    if (!current.ok) return yield* current.reason === "denied" ? denied() : unavailable()
    if (closed) return yield* unavailable()
    return current.value
  })
  const dispatch = (
    place: ReviewMemory.Place,
    command: Command,
  ): Effect.Effect<ReviewMemory.Result<ReviewMemory.State | ReviewMemory.Entry>> => {
    switch (command.action) {
      case "configure":
        return input.memory.configure(place, { expected: command.expected, enabled: command.enabled })
      case "record":
        return input.memory.record(place, {
          expected: command.expected,
          kind: command.kind,
          text: command.text,
          paths: command.paths,
          citations: command.citations,
          reason: command.reason,
          visibility: command.visibility,
        })
      case "approve":
        return input.memory.approve(place, { expected: command.expected, id: command.id })
      case "reopen":
        return input.memory.reopen(place, { expected: command.expected, id: command.id, reason: command.reason })
      case "forget":
        return input.memory.forget(place, { expected: command.expected, id: command.id })
      case "erase":
        return input.memory.erase(place, { expected: command.expected })
    }
  }
  return {
    inspect: (options) =>
      Effect.gen(function* () {
        const current = yield* owner
        purge()
        arm()
        const query = Schema.decodeUnknownOption(ReviewMemoryControl.InspectInput)(options ?? {})
        if (Option.isNone(query)) return yield* new Error({ code: "invalid", message: "Invalid review memory page." })
        const state = yield* input.memory.inspect(current.place, query.value).pipe(Effect.flatMap(domain))
        const result = Schema.decodeUnknownOption(ReviewMemoryControl.Inspect)({
          repository: current.actor.repository,
          scope: current.actor.scope,
          state,
        })
        if (Option.isNone(result)) return yield* unavailable()
        return result.value
      }),
    prepare: (unknown) =>
      Effect.gen(function* () {
        const current = yield* owner
        const decoded = Schema.decodeUnknownOption(ReviewMemoryControl.Prepare)(unknown)
        if (Option.isNone(decoded))
          return yield* new Error({ code: "invalid", message: "Invalid review memory action." })
        if (decoded.value.expectedScope !== current.actor.scope)
          return yield* new Error({
            code: "stale",
            message: "The displayed repository scope changed. Read its current memory before preparing an action.",
          })
        const command = freeze(structuredClone(decoded.value.command))
        const state = yield* input.memory.inspect(current.place).pipe(Effect.flatMap(domain))
        if (state.generation !== command.expected)
          return yield* new Error({
            code: "stale",
            message: "Review memory changed. Read its current state before preparing this action.",
          })
        purge()
        if (
          pending.size >= LIMIT.total ||
          [...pending.values()].filter(
            (entry) =>
              entry.actor.principal === current.actor.principal &&
              entry.actor.repository === current.actor.repository &&
              entry.actor.scope === current.actor.scope,
          ).length >= LIMIT.scope
        )
          return yield* new Error({
            code: "limit",
            message: "Finish or wait for the existing review-memory previews before preparing another.",
          })
        const captured: { request?: ReviewMemory.OwnerRequest } = {}
        const permit: ReviewMemoryConsent.Port = {
          authorize: (request, actor) =>
            Effect.sync(() => {
              if (
                actor.key !== current.actor.key ||
                request.repository !== current.actor.repository ||
                request.scope !== current.actor.scope ||
                request.operation !== command.action ||
                captured.request
              )
                return { ok: false, reason: "denied" }
              // Do not call use(): preparation never performs the mutation and the
              // human wait starts only after Core's inspection transaction ended.
              captured.request = freeze(structuredClone(request))
              return { ok: false, reason: "authority-unavailable" }
            }),
        }
        const result = yield* dispatch(current.place, command).pipe(
          Effect.provideService(ReviewMemoryConsent.Current, permit),
        )
        const request = captured.request
        if (!request) {
          if (!result.ok) return yield* domain<never>(result)
          return yield* unavailable()
        }
        if (!/^sha256:[0-9a-f]{64}$/.test(request.digest) || Buffer.byteLength(JSON.stringify(request)) > LIMIT.bytes)
          return yield* new Error({ code: "invalid", message: "The review memory preview is invalid or too large." })
        const parsed = Schema.decodeUnknownOption(ReviewMemoryControl.Preview)({
          previewId: randomUUID(),
          sha256: request.digest.slice(7),
          expiresAt: clock.date() + LIMIT.ttl,
          repository: request.repository,
          scope: request.scope,
          operation: request.operation,
          expected: command.expected,
          payload: request.payload,
        })
        if (Option.isNone(parsed)) return yield* unavailable()
        const preview = freeze(parsed.value)
        // Concurrent preparations may have completed while Core read the exact
        // proposal. Recheck immediately before insertion, without another await.
        purge()
        if (
          pending.size >= LIMIT.total ||
          [...pending.values()].filter(
            (entry) =>
              entry.actor.principal === current.actor.principal &&
              entry.actor.repository === current.actor.repository &&
              entry.actor.scope === current.actor.scope,
          ).length >= LIMIT.scope
        )
          return yield* new Error({
            code: "limit",
            message: "Finish or wait for the existing review-memory previews before preparing another.",
          })
        pending.set(preview.previewId, {
          state: "prepared",
          command,
          actor: current.actor,
          sha256: preview.sha256,
          operation: preview.operation,
          expires: clock.now() + LIMIT.ttl,
        })
        arm()
        return preview
      }),
    confirm: (unknown) =>
      Effect.gen(function* () {
        const current = yield* owner
        const decoded = Schema.decodeUnknownOption(ReviewMemoryControl.Confirmation)(unknown)
        if (Option.isNone(decoded))
          return yield* new Error({ code: "invalid", message: "Invalid review memory confirmation." })
        const confirmation = decoded.value
        const entry = pending.get(confirmation.previewId)
        if (!entry || entry.actor.principal !== current.actor.principal) return yield* unavailable()
        if (entry.expires <= clock.now()) {
          pending.delete(confirmation.previewId)
          arm()
          return yield* new Error({ code: "expired", message: "This review memory preview expired. Prepare it again." })
        }
        if (entry.actor.key !== current.actor.key || entry.sha256 !== confirmation.approvedSha256) {
          retire(confirmation.previewId, entry)
          return yield* new Error({
            code: "stale",
            message: "The preview no longer matches this repository or confirmation.",
          })
        }
        if (entry.state === "used")
          return yield* new Error({
            code: "used",
            message:
              "This confirmation was already used. Read the current repository state; Vector will not resend the action.",
          })
        const permit: ReviewMemoryConsent.Port = {
          authorize: (request, actor, use) =>
            Effect.gen(function* () {
              const active = pending.get(confirmation.previewId)
              if (!active || active.state !== "prepared") return { ok: false, reason: "stale" }
              if (
                active.expires <= clock.now() ||
                actor.key !== active.actor.key ||
                request.repository !== active.actor.repository ||
                request.scope !== active.actor.scope ||
                request.operation !== active.operation ||
                request.digest !== `sha256:${active.sha256}`
              ) {
                retire(confirmation.previewId, active)
                return { ok: false, reason: "stale" }
              }
              // No yield separates this single-use transition from its validation.
              // Even an uncertain response may never replay the effect. Drop all
              // plaintext command/preview data from the retained receipt now.
              retire(confirmation.previewId, active)
              return yield* use()
            }),
        }
        const outcome = yield* dispatch(current.place, entry.command).pipe(
          Effect.provideService(ReviewMemoryConsent.Current, permit),
          Effect.ensuring(
            Effect.sync(() => {
              const retained = pending.get(confirmation.previewId)
              if (retained?.state === "prepared") retire(confirmation.previewId, retained)
            }),
          ),
          Effect.flatMap(domain),
        )
        const result = Schema.decodeUnknownOption(ReviewMemoryControl.ConfirmationResult)(outcome)
        if (Option.isNone(result)) return yield* unavailable()
        return result.value
      }),
    discard: (unknown) =>
      Effect.gen(function* () {
        const current = yield* owner
        const id = Schema.decodeUnknownOption(ReviewMemoryControl.PreviewID)(unknown)
        if (Option.isNone(id)) return yield* new Error({ code: "invalid", message: "Invalid review memory preview." })
        const entry = pending.get(id.value)
        if (!entry) return
        if (entry.actor.key !== current.actor.key) return yield* unavailable()
        retire(id.value, entry)
        arm()
      }),
    dispose: () => {
      closed = true
      timerEpoch++
      cancel?.()
      cancel = undefined
      pending.clear()
    },
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* ReviewMemory.Service
    const settings = yield* Config.Service
    const controls = make({ memory, settings })
    yield* Effect.addFinalizer(() => Effect.sync(controls.dispose))
    return controls
  }),
)
export const node = LayerNode.make({ service: Service, layer, deps: [ReviewMemoryAuthority.node, Config.node] })
