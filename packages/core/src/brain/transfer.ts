export * as BrainTransfer from "./transfer"

import { Option, Schema } from "effect"
import type { BrainExport } from "./export"
import type { BrainWorkflow } from "./workflow"

/** Transfer observations are descriptive. Importing them never seeds the live learner or grants model permissions. */
export const Insight = Schema.Struct({
  tier: Schema.Literals(["chat", "light", "standard", "thorough"]),
  model: Schema.String.check(Schema.isMaxLength(512)),
  effort: Schema.String.check(Schema.isMaxLength(80)),
  split: Schema.Literals(["solo", "subagents"]),
  runs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2000 })),
  passRate: Schema.optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  checkedShare: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
})
export const Insights = Schema.Struct({
  format: Schema.Literal("vector-workflow-insights"),
  version: Schema.Literal(1),
  rows: Schema.Array(Insight).check(Schema.isMaxLength(100)),
})
export type Insights = typeof Insights.Type

export function insights(value: BrainWorkflow.Insights): Insights {
  return { format: "vector-workflow-insights", version: 1, rows: value.tiers.flatMap((tier) => tier.arms.map((arm) => ({
    tier: tier.tier,
    model: `${arm.arm.providerID}/${arm.arm.modelID}`.slice(0, 512),
    effort: arm.arm.effort.slice(0, 80),
    split: arm.arm.split,
    runs: Math.min(2000, Math.max(0, Math.trunc(arm.rows))),
    ...(arm.passRate === undefined ? {} : { passRate: arm.passRate }),
    checkedShare: arm.checkedShare,
  }))).slice(0, 100) }
}

export function decodeInsights(text: string) {
  if (Buffer.byteLength(text) > 256 * 1024) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Insights))(text))
}

/** Reviewable lessons, with no asserted authority, dollar figures, token totals or private relative weights. */
export function insightMemory(file: Insights): BrainExport.File {
  const now = Date.now()
  return { format: "vector-memory", version: 1, scope: "repository", exportedAt: now, documents: [],
    entries: file.rows.map((row, index) => ({
      id: `imported-workflow-${index}`, scope: "repository", kind: "lesson", status: "proposed", pinned: false,
      text: `Imported workflow observation for ${row.tier} work: ${row.model}, ${row.effort} effort, ${row.split}. ${row.runs} recorded runs; ${row.passRate === undefined ? "no checked outcome" : `${Math.round(row.passRate * 100)}% passed`}; ${Math.round(row.checkedShare * 100)}% checked. Review this history before applying it to new work.`,
      paths: [], evidence: [], createdAt: now,
    })),
  }
}
