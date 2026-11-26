export * as EverywhereSession from "./everywhere-session"

import { Effect, Option, Schema } from "effect"
import { EverywhereSessionWire } from "@vectordevai/core/everywhere/session-binding"
import { unattendedMetadata, UNATTENDED_SHELL_KEY, UNATTENDED_SHELL_OFFLINE } from "@vectordevai/core/everywhere/frame"
import { Config } from "@/config/config"
import { EverywherePreferences } from "@/config/everywhere-preferences"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { UnattendedRecords } from "@/worktree/unattended-records"

export type Handler = (input: unknown) => Effect.Effect<EverywhereSessionWire.Result>
export type Attach = (handler: Handler) => void

const refused = { version: 1, kind: "refused" } as const
const unavailable = { version: 1, kind: "unavailable" } as const

type Placement = typeof UnattendedRecords.Placed.Type
const matches = (left: Placement, right: Placement) =>
  left.jid === right.jid &&
  left.directory === right.directory &&
  left.project === right.project &&
  left.branch === right.branch &&
  left.base === right.base &&
  left.common === right.common &&
  left.gitDirectory === right.gitDirectory &&
  left.directoryIdentity === right.directoryIdentity &&
  left.gitIdentity === right.gitIdentity

/** Uses the actual listener's instance store. The handler is published only through the utility process parent port. */
export const make = Effect.gen(function* () {
  const worktree = yield* Worktree.Service
  const store = yield* InstanceStore.Service
  const config = yield* Config.Service
  const sessions = yield* Session.Service
  const path = yield* EverywherePreferences.StatePath

  const create = Effect.fn("EverywhereSession.create")(function* (
    input: unknown,
  ): Effect.fn.Return<EverywhereSessionWire.Result, Error> {
    const decoded = Schema.decodeUnknownOption(EverywhereSessionWire.Request)(input)
    if (Option.isNone(decoded)) return refused
    const request = decoded.value
    const placed = yield* worktree.withUnattendedPlacement(request, Effect.succeed)
    if (!placed || Config.lockedKeys().includes("everywhere")) return refused
    const loaded = (yield* store.loaded()).filter((item) => item.project.id === placed.project)
    // Desktop's scoped GET /config/trust opens the placed checkout before calling the private creator.
    // The creator must never bootstrap a checkout or use a context from another listener.
    const instance = loaded.find((item) => item.directory === placed.directory)
    if (!instance) return refused
    const parent = yield* Worktree.canonicalPath(instance.project.worktree)
    if (!parent) return refused
    const paths = yield* Effect.forEach(loaded, (item) => Worktree.canonicalPath(item.directory))
    const checkout = loaded[paths.indexOf(parent)]
    if (!checkout) return refused

    const allowed = Effect.gen(function* () {
      if (Config.lockedKeys().includes("everywhere")) return false
      const global = yield* config.readGlobal()
      const preferences = yield* EverywherePreferences.effective(path, global.everywhere)
      if (preferences?.enabled !== true) return false
      const listed = yield* Effect.forEach(preferences.projects ?? [], (item) => Worktree.canonicalPath(item.directory))
      if (!listed.includes(parent)) return false
      return (yield* config.trust().pipe(Effect.provideService(InstanceRef, checkout))).trusted === true
    })
    if (!(yield* allowed)) return refused

    return yield* Effect.gen(function* () {
      if ((yield* config.trust()).trusted !== false || Config.lockedKeys().includes("everywhere")) return refused
      const existing = yield* UnattendedRecords.read(request.jid, "session", UnattendedRecords.Bound)
      if (existing) {
        if (!matches(existing, placed) || existing.claim !== request.claim) return refused
        const session = yield* sessions.get(SessionID.make(existing.sessionID)).pipe(Effect.option)
        if (
          Option.isNone(session) ||
          session.value.directory !== placed.directory ||
          session.value.projectID !== placed.project
        )
          return refused
        return (
          (yield* worktree.withUnattendedPlacement(request, (current) =>
            Effect.succeed(
              matches(placed, current) && !Config.lockedKeys().includes("everywhere")
                ? ({ version: 1, kind: "created", sessionID: existing.sessionID } as const)
                : refused,
            ),
          )) ?? refused
        )
      }

      // Exclusive intent also fences another Engine process. A crash before the binding leaves the reservation inert.
      yield* UnattendedRecords.write(request.jid, "session-intent", { claim: request.claim })
      if (Config.lockedKeys().includes("everywhere")) return refused
      // The binding command creates a local session record. Automatic sharing belongs to ordinary session creation.
      const session = yield* sessions.create(
        {
          title: request.title,
          metadata: { ...unattendedMetadata(request), [UNATTENDED_SHELL_KEY]: UNATTENDED_SHELL_OFFLINE },
          permission: [...request.permission],
        },
        "owner",
      )
      if (session.directory !== placed.directory || session.projectID !== placed.project || !(yield* allowed))
        return refused
      return (
        (yield* worktree.withUnattendedPlacement(request, (current) =>
          Effect.gen(function* () {
            if (!matches(placed, current) || Config.lockedKeys().includes("everywhere")) return refused
            yield* UnattendedRecords.write(request.jid, "session", {
              ...current,
              claim: request.claim,
              sessionID: session.id,
            })
            return { version: 1, kind: "created", sessionID: session.id } as const
          }),
        )) ?? refused
      )
    }).pipe(Effect.provideService(InstanceRef, instance))
  })

  return ((input) => create(input).pipe(Effect.catchCause(() => Effect.succeed(unavailable)))) satisfies Handler
})
