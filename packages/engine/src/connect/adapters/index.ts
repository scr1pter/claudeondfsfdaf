import type { ConnectAdapter } from "../adapter"
import { ConnectGithubAgentAdapter } from "./github-agent"
import { ConnectHandsAdapter } from "./hands"
import { VectorScopeAdapter } from "./vectorscope"

// The adapters connected tools knows about, one line each. An owner whose member lives on another branch adds a file
// beside this one and a line here. The hub builds every adapter when its layer starts: an adapter that needs services
// widens `Services` to them and adds their layer nodes to `DEPS`, which join the hub's dependencies (connect/hub.ts
// `node`), where the layer graph checks them. The GitHub agent's adapter needs no services, so it adds nothing to
// `Services` or `DEPS`.
export type Services = VectorScopeAdapter.Services | ConnectHandsAdapter.Services

export const ADAPTERS: readonly ConnectAdapter.Factory<Services>[] = [
  VectorScopeAdapter.factory,
  ConnectHandsAdapter.factory,
  ConnectGithubAgentAdapter.factory,
]

/** The layer nodes the adapters' services come from. */
export const DEPS = [...VectorScopeAdapter.DEPS, ...ConnectHandsAdapter.DEPS] as const

export * as ConnectAdapters from "."
