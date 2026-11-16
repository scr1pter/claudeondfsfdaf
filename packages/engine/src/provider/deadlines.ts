import { clearTimeout, setTimeout } from "node:timers"
import { Context, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"

/** Request deadlines can use a controlled clock without changing the clock that drives network I/O. */
export interface Interface {
  schedule(ms: number, run: () => void): () => void
}

export class Service extends Context.Service<Service, Interface>()("@vector/ProviderDeadlines") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.succeed(Service, {
    schedule: (ms, run) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
  }),
  deps: [],
})

export * as ProviderDeadlines from "./deadlines"
