import { Config } from "@/config/config"
import { Effect, Layer } from "effect"

export function make(overrides: Partial<Config.Interface> = {}) {
  return Config.Service.of({
    get: () => Effect.succeed({}),
    getGlobal: () => Effect.succeed({}),
    update: () => Effect.void,
    updateGlobal: (config) => Effect.succeed({ info: config, changed: false }),
    updateMcpLocal: () => Effect.void,
    removeMcpLocal: () => Effect.void,
    storedMcp: () => Effect.succeed({}),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    loaded: () => Effect.succeed({ files: [], directories: [] }),
    trustedPath: () => Effect.succeed(undefined),
    waitForDependencies: () => Effect.void,
    permissionCeiling: () => Effect.succeed(undefined),
    researchDomains: () => Effect.succeed({ prefer: [], avoid: [] }),
    localPolicy: () => Effect.succeed(Config.local()),
    trust: () => Effect.succeed({ workspace: "", fingerprint: "", trusted: false, ignored: false, settings: false }),
    approve: () => Effect.void,
    inheritTrust: () => Effect.succeed(false),
    ...overrides,
  })
}

export function layer(overrides?: Partial<Config.Interface>) {
  return Layer.succeed(Config.Service, make(overrides))
}

export * as TestConfig from "./config"
