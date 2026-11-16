// Vector's per-channel bundle ids and executable names. electron-builder.config.ts packages with them and the
// Vector Hands identity generator (computer-helper-identity.ts) reads them, so this module stays free of side
// effects and imports: loading the builder config instead would pull in electron-builder and throw on a prod CI
// run without signing settings.

export const APP_IDS = {
  dev: "ai.vector.app.dev",
  beta: "ai.vector.app.beta",
  prod: "ai.vector.app",
} as const

export const EXECUTABLE_NAMES = {
  dev: "vector-desktop-dev",
  beta: "vector-desktop-beta",
  prod: "vector-desktop",
} as const
