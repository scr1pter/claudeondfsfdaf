export * as ConnectPlacement from "./placement"

import { Effect, Option } from "effect"
import { Connect } from "@vectordevai/schema/connect"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceStore } from "@/project/instance-store"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import type { TaskIsolation } from "@/task/isolation"
import { TaskPlace } from "@/task/place"
import { FileLock } from "@/tool/file-lock"

// InstanceStore bootstraps the runtime that already contains Connect. Resolve it at use time, as isolation does,
// instead of making the registry's static service graph depend on its own bootstrap.
const instances = Effect.fn("ConnectPlacement.instances")(function* (): Effect.fn.Return<InstanceStore.Interface> {
  const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
  const provided = yield* Effect.serviceOption(InstanceStore.Service)
  if (Option.isSome(provided)) return provided.value
  const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
  return yield* Effect.promise(() => AppRuntime.runPromise(InstanceStore.Service))
})

/** A placement may only be used while TaskIsolation.review holds the task's identity lock. */
export const use = <A, E, R>(
  input: {
    readonly record: TaskIsolation.Record
    readonly requester: SessionID
    readonly places: Set<SessionID>
    readonly stopHelpers: Effect.Effect<void>
  },
  review: (parentID: SessionID) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Connect.Refusal, R | Session.Service> =>
  Effect.gen(function* () {
    const home = yield* InstanceState.context
    const sessions = yield* Session.Service
    const store = yield* instances()
    // A review disposes only its own fresh work instance. It cannot retire one another live caller is using.
    if ((yield* store.loaded()).some((ctx) => FileLock.key(ctx.directory) === FileLock.key(input.record.directory)))
      return yield* new Connect.Refusal({
        code: "unavailable",
        message: "The task's worktree instance is in use. Wait for it to close before reviewing it.",
      })
    return yield* Effect.acquireUseRelease(
      store.load({ directory: input.record.directory, worktree: input.record.directory, project: home.project }),
      (work) =>
        Effect.gen(function* () {
          const place = yield* sessions.create({
            title: "VectorScope worktree review",
            internal: "vectorscope.place",
            parentID: input.requester,
          })
          TaskPlace.set(place.id, { home, work })
          input.places.add(place.id)
          return yield* review(place.id).pipe(
            Effect.ensuring(
              input.stopHelpers.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    TaskPlace.dropWork(place.id)
                    input.places.delete(place.id)
                  }),
                ),
              ),
            ),
          )
        }),
      (work) => store.dispose(work),
    )
  })

/** Keep asks closed too: reviewing must not acquire read authority the requester would have had to ask for. */
export function readDenies(input: {
  readonly rules: PermissionV1.Ruleset
  readonly sources: readonly string[]
  readonly work: readonly string[]
}): ConnectPolicy.Decision<PermissionV1.Ruleset> {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "")
  const sources = [...new Set(input.sources.map(normalize))]
  const work = [...new Set(input.work.map(normalize))]
  const denied = new Set<string>()
  for (const raw of ConnectPolicy.readPatterns(input.rules)) {
    const pattern = normalize(raw)
    denied.add(pattern)
    if (!pattern.startsWith("/") && !/^[A-Za-z]:\//.test(pattern)) continue
    const source = sources.find((root) => pattern === root || pattern.startsWith(`${root}/`))
    if (source) {
      const relative = pattern === source ? "*" : pattern.slice(source.length + 1)
      denied.add(relative)
      for (const root of work) denied.add(`${root}/${relative}`)
      continue
    }
    // Case and short-path aliases cannot prove another absolute pattern disjoint from this checkout.
    return {
      ok: false,
      refusal: new Connect.Refusal({
        code: "read-rule",
        message: "This session's absolute read rule cannot be safely transferred into the task worktree.",
      }),
    }
  }
  return { ok: true, value: [...denied].map((pattern) => ({ permission: "read", pattern, action: "deny" })) }
}
