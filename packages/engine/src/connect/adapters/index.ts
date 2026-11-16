import type { ConnectAdapter } from "../adapter"
import { VectorScopeAdapter } from "./vectorscope"

// The adapters connected tools knows about, one line each. An owner whose member lives on another branch adds a file
// beside this one and a line here. The hub builds every adapter when its layer starts: an adapter that needs services
// widens `Services` to them and adds their layer nodes to `DEPS`, which join the hub's dependencies (connect/hub.ts
// `node`), where the layer graph checks them. Hands' adapter arrives after its merge (CW-21) and the GitHub agent's
// with CW-22.
export type Services = VectorScopeAdapter.Services

export const ADAPTERS: readonly ConnectAdapter.Factory<Services>[] = [VectorScopeAdapter.factory]

/** The layer nodes the adapters' services come from. */
export const DEPS = [...VectorScopeAdapter.DEPS] as const

export * as ConnectAdapters from "."
