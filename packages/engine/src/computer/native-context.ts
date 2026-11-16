import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))

export const SafetyCheck = Schema.Struct({
  id: Text(256),
  code: Text(128),
  message: Text(1000),
})
export type SafetyCheck = typeof SafetyCheck.Type
const Scroll = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(Computer.LIMITS.batchSteps)),
  dx: Schema.Int.check(Schema.isBetween({ minimum: -10000, maximum: 10000 })),
  dy: Schema.Int.check(Schema.isBetween({ minimum: -10000, maximum: 10000 })),
})

/** Provider-owned checks travel outside model arguments and never carry approval answers. */
export const Context = Schema.Struct({
  provider: Schema.Literals(["openai", "anthropic"]),
  safetyChecks: Schema.Array(SafetyCheck).check(
    Schema.isMaxLength(3),
    Schema.makeFilter((checks) => new Set(checks.map((check) => check.id)).size === checks.length, {
      expected: "distinct provider safety check IDs",
    }),
  ),
  scrolls: Schema.optional(
    Schema.Array(Scroll).check(
      Schema.isMaxLength(Computer.LIMITS.batchSteps),
      Schema.makeFilter((scrolls) => new Set(scrolls.map((scroll) => scroll.index)).size === scrolls.length, {
        expected: "distinct native scroll action indices",
      }),
    ),
  ),
})
export type Context = typeof Context.Type

export interface Outcome {
  readonly provider: Context["provider"]
  readonly acknowledgedSafetyChecks: readonly SafetyCheck[]
  readonly computerDeclined: boolean
}

export function parse(value: unknown): Context {
  const decoded = Schema.decodeUnknownOption(Context)(value)
  if (Option.isNone(decoded)) throw new Error("The provider computer safety checks are invalid.")
  return decoded.value
}

/** Preserve invalid supplied envelopes so the computer tool refuses them instead of losing their checks. */
export function executionContext(value: unknown): { computerNative?: unknown } {
  if (typeof value !== "object" || value === null || !("computerNative" in value)) return {}
  return { computerNative: value.computerNative }
}

export * as ComputerNativeContext from "./native-context"
