export * as EverywherePreferenceWire from "./preferences"

import { Schema } from "effect"
import { ConfigEverywhereV1 } from "../v1/config/everywhere"
import type { ModelPlanStatus } from "../model-plan-status"

export const Version = Schema.Literal(1)
export const Revision = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

const Read = Schema.Struct({ version: Version, kind: Schema.Literal("read") }).annotate({
  parseOptions: { onExcessProperty: "error" },
})
export const Update = Schema.Struct({
  version: Version,
  kind: Schema.Literal("update"),
  revision: Revision,
  settings: ConfigEverywhereV1.Info,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export type Update = typeof Update.Type

export const Request = Schema.Union([Read, Update])
export type Request = typeof Request.Type

export const Snapshot = Schema.Struct({
  revision: Revision,
  everywhere: ConfigEverywhereV1.Info,
  locked: Schema.Array(Schema.String),
})
export type Snapshot = typeof Snapshot.Type

export const Result = Schema.Union([
  Schema.Struct({ version: Version, kind: Schema.Literal("ready"), snapshot: Snapshot }),
  Schema.Struct({
    version: Version,
    kind: Schema.Literals(["invalid", "locked", "stale", "unavailable", "unsupported"]),
  }),
])
export type Result = typeof Result.Type

export type ChangeResult =
  | Result
  | {
      version: 1
      kind: "cancelled" | "not-offered" | "remote-unavailable" | "remote-stayed-on"
    }

export function offered(status: ModelPlanStatus.Status | undefined) {
  const remote = status?.entitlements?.remote as { computers?: unknown } | undefined
  return Boolean(
    status?.signedIn &&
      !status.error &&
      status.listed?.includes("everywhere") &&
      status.listed.includes("remote") &&
      typeof remote?.computers === "number" &&
      remote.computers > 0,
  )
}
