export * as ConfigComputerV1 from "./computer"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../../schema"

const Access = Schema.Literals(["allow", "deny"])
const WindowsApp = Schema.Union([
  Schema.Struct({ aumid: Schema.String, access: Access }),
  Schema.Struct({
    publisher: Schema.String,
    product: Schema.String,
    binary: Schema.optional(Schema.String),
    access: Access,
  }),
])

// Keep omitted keys absent so one managed source does not replace another's explicit policy with defaults.
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Company switch for computer use (default: true). Enabling it does not grant the user's consent.",
  }),
  default_app_access: Schema.optional(Schema.Literals(["ask", "deny"])).annotate({
    description:
      "Access for apps without a company rule (default: ask). Company allow rules still require user consent.",
  }),
  allow_always: Schema.optional(Schema.Boolean).annotate({
    description: "Let users remember their own app approvals (default: true)",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Permit background windows when the user enables them (default: true)",
  }),
  keep_awake: Schema.optional(Schema.Boolean).annotate({
    description: "Permit keeping the computer awake while acting (default: true)",
  }),
  away_minutes: Schema.optional(PositiveInt.check(Schema.isBetween({ minimum: 5, maximum: 240 }))).annotate({
    description: "Maximum minutes without physical input before pausing for the user (5–240)",
  }),
  screenshot_retention_days: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(365))).annotate({
    description: "Maximum days to retain screenshots (0–365); 0 retains none",
  }),
  max_actions: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(5000))).annotate({
    description: "Computer actions before a check-in with the user (1–5000, default: 300)",
  }),
  max_minutes: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(600))).annotate({
    description:
      "Active minutes before a check-in with the user, excluding time awaiting approval (1–600, default: 45)",
  }),
  native_tools: Schema.optional(Schema.Literals(["auto", "off"])).annotate({
    description: "Provider-native computer tools (default: off in this release)",
  }),
  screenshots: Schema.optional(
    Schema.Struct({
      keep: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(10))).annotate({
        description: "Recent screenshots to include in model context (1–10, default: 3)",
      }),
      max_width: Schema.optional(PositiveInt).annotate({ description: "Maximum screenshot width in pixels" }),
      max_height: Schema.optional(PositiveInt).annotate({ description: "Maximum screenshot height in pixels" }),
    }),
  ),
  apps: Schema.optional(
    Schema.Struct({
      macos: Schema.optional(Schema.Record(Schema.String, Access)).annotate({
        description:
          "Apple-signed apps use bundleId; third-party apps use bundleId@TeamID. Allow still requires user consent.",
      }),
      windows: Schema.optional(Schema.mutable(Schema.Array(WindowsApp))).annotate({
        description:
          "Verified packaged app AUMIDs or Authenticode publisher and product rules, optionally narrowed by binary. Allow still requires user consent.",
      }),
    }),
  ),
}).annotate({ identifier: "ComputerConfig" })
export type Info = Schema.Schema.Type<typeof Info>
