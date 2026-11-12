import { Effect } from "effect"
import type { BackgroundJob } from "@/background/job"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { FileLock } from "@/tool/file-lock"
import { TaskPlace } from "./place"

/** A task's registry belongs to its launcher; its runner can live in a different work instance. */
export const atLauncher =
  (task: Pick<Session.Info, "id" | "parentID">) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    task.parentID && TaskPlace.get(task.parentID)
      ? TaskPlace.within(task.parentID)(effect)
      : TaskPlace.atHome(task.id)(effect)

/** Enumerate only trusted execution contexts sharing this home; unrelated instances remain separate. */
export const all = Effect.fn("TaskJobs.all")(function* (background: BackgroundJob.Interface) {
  const current = yield* InstanceRef
  const home = yield* TaskPlace.atHome()(InstanceRef)
  if (!current || !home) return (yield* background.list()).map((info) => ({ info, place: current }))
  const contexts = [
    current,
    home,
    ...TaskPlace.places()
      .filter(
        (place) =>
          place.home.project.id === home.project.id &&
          FileLock.key(place.home.directory) === FileLock.key(home.directory),
      )
      .map((place) => place.work),
  ]
  const unique = [...new Map(contexts.map((place) => [FileLock.key(place.directory), place])).values()]
  const results = yield* Effect.forEach(unique, (place) =>
    background.list().pipe(
      Effect.provideService(InstanceRef, place),
      Effect.map((jobs) => jobs.map((info) => ({ info, place }))),
    ),
  )
  return results.flat()
})

/** Keep ID-based manager operations in the registry selected by the actual session row, never its metadata. */
export function routed(background: BackgroundJob.Interface, sessions: Session.Interface): BackgroundJob.Interface {
  const within = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
    sessions
      .get(SessionID.make(id))
      .pipe(Effect.matchEffect({ onFailure: () => effect, onSuccess: (task) => atLauncher(task)(effect) }))
  return {
    ...background,
    list: () =>
      all(background).pipe(Effect.map((entries) => [...new Map(entries.map(({ info }) => [info.id, info])).values()])),
    get: (id) => within(id, background.get(id)),
    start: (input) => (input.id ? within(input.id, background.start(input)) : background.start(input)),
    extend: (input) => within(input.id, background.extend(input)),
    cancel: (id) => within(id, background.cancel(id)),
    wait: (input) => within(input.id, background.wait(input)),
    waitForPromotion: (id) => within(id, background.waitForPromotion(id)),
    promote: (id) => within(id, background.promote(id)),
  }
}

export * as TaskJobs from "./jobs"
