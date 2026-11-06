import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@vectordevai/core/background-job"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { InstanceState } from "@/effect/instance-state"
import { disposing, markDisposing } from "@/effect/instance-registry"
import { Effect, Layer } from "effect"

export {
  RunFailed,
  Service,
  type Durable,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@vectordevai/core/background-job"

/**
 * Keeps the legacy service instance-scoped while sharing the core registry engine. Each instance's registry holds its
 * own lease, which its durable jobs' rows name, and a job its instance stops while going away is interrupted.
 */
const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    const store = yield* BackgroundJobStore.Service
    // The directories with a registry, one entry per registry.
    const live = new Set<{ directory: string }>()
    let release: (() => void)[] = []
    // Finalizers run in reverse order: this one last, after the registries closed.
    yield* Effect.addFinalizer(() => Effect.sync(() => release.forEach((done) => done())))
    const state = yield* InstanceState.make((ctx) =>
      Effect.gen(function* () {
        const entry = { directory: ctx.directory }
        const owner = BackgroundJobStore.open()
        live.add(entry)
        // Registered before the registry's jobs, so it runs after they have settled.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            BackgroundJobStore.close(owner)
            live.delete(entry)
          }),
        )
        return yield* CoreBackgroundJob.makeWith({ store, owner, disposing: () => disposing(ctx.directory) })
      }),
    )
    // The service going away, as when a runtime shuts down, disposes every instance it holds: this runs first.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        release = [...live].map((entry) => markDisposing(entry.directory))
      }),
    )
    return CoreBackgroundJob.Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      start: (input) => InstanceState.useEffect(state, (jobs) => jobs.start(input)),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, (jobs) => jobs.promote(id)),
      cancel: (id) => InstanceState.useEffect(state, (jobs) => jobs.cancel(id)),
      lease: () => InstanceState.useEffect(state, (jobs) => jobs.lease()),
    })
  }),
)

export const node = LayerNode.make({ service: CoreBackgroundJob.Service, layer, deps: [BackgroundJobStore.node] })

export * as BackgroundJob from "./job"
