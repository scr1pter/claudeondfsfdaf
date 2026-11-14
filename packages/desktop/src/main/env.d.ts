interface ImportMetaEnv {
  readonly VECTOR_CHANNEL: string
  readonly VECTOR_REQUIRED_CLI_VERSION: string
}

declare const VECTOR_COMPUTER_RESET_VERIFIED: boolean
/** Canonical SHA-256 pin document for final Windows helper bytes, compiled into packaged Main. */
declare const VECTOR_COMPUTER_HELPER_SHA256: string

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:vector-server" {
  export namespace Server {
    export const listen: typeof import("../../../engine/dist/types/src/node").Server.listen
    export type Listener = import("../../../engine/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../engine/dist/types/src/node").Config.get
    export type Info = import("../../../engine/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../engine/dist/types/src/node").bootstrap
}
