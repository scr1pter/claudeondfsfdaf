import type { ConnectAdapter } from "../adapter"

// The adapters connected tools knows about, one line each. An owner whose member lives on another branch adds a file
// beside this one and a line here. The hub builds every adapter when its layer starts: an adapter that needs services
// widens the factory type below to them, and they join the hub's dependencies (connect/hub.ts `deps`), where the layer
// graph checks them. VectorScope's adapter arrives with CW-04, Hands' after its merge (CW-21) and the GitHub agent's
// with CW-22.
export const ADAPTERS: readonly ConnectAdapter.Factory[] = []

export * as ConnectAdapters from "."
