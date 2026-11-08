export * as ResearchReportTool from "./research-report"

import { Effect, Layer, Schema } from "effect"
import { Research } from "@vectordevai/schema/research"
import { makeLocationNode } from "../effect/app-node"
import { ResearchConfidence } from "../research/confidence"
import { ResearchStore } from "../research/store"
import { SpendGuard } from "../spend-guard"
import { ResearchRunV2 } from "./research-run"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// research_report on the V2 runner (section 5.4). The checks are deterministic: every [N#] cited must be a saved note,
// and a sub-question marked answered must have one; a sentence with a number, a date or a name and no citation is a
// warning, not a refusal. The report is saved as a held, private document of the brain, recalled only once the user
// keeps it; calling again saves the next version. The model gets back what was saved and the confidence of each
// section, not the whole rendered report. This runner has no research judge yet, so its reports are not judged.

export const name = "research_report"

export const description = `Writes this research run's report and saves it in the repository's brain, held and private until the user keeps it.

- answer: at most 1,500 characters. Cite notes as [N3] (or [N3, N5]) in the answer and the sections.
- sections: up to 12, each with a heading and a body; subquestion names the sub-question a section answers.
- disagreements and open_questions: say honestly where sources disagree and what is still open.
- Every cited [N#] must be a note research_note saved, and a sub-question marked answered must have a note; otherwise the report is refused with what to fix. Sentences that state a number, a date or a name without a citation are listed for you to fix.
- Calling research_report again saves the next version.`

const Section = Schema.Struct({
  heading: Schema.String.check(Schema.isLengthBetween(1, 200)),
  body: Schema.String.check(Schema.isLengthBetween(1, 6_000)).annotate({
    description: "The section, citing notes as [N3]",
  }),
  subquestion: Schema.optional(Schema.String),
})

export const Input = Schema.Struct({
  title: Schema.String.check(Schema.isLengthBetween(1, 200)),
  answer: Schema.String.check(Schema.isLengthBetween(1, 1_500)).annotate({
    description: "The answer to the question, at most 1,500 characters, citing notes as [N3]",
  }),
  sections: Schema.Array(Section).check(Schema.isMaxLength(12)),
  disagreements: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(1_000))).check(Schema.isMaxLength(12)),
  ),
  open_questions: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(12)),
  method_notes: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
})

/** What a report records: the held document and its version, and what the checks found. */
export const Metadata = Schema.Struct({
  runID: Schema.optional(Schema.String),
  document: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Int),
  uncited: Schema.optional(Schema.Array(Schema.String)),
  removed: Schema.optional(Schema.Array(Schema.String)),
  refused: Schema.optional(Schema.Boolean),
})

const Output = Schema.Struct({ text: Schema.String, metadata: Metadata })

export const HELD = "This report and its sources stay private and out of later sessions until you keep them."

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const research = yield* ResearchRunV2.Service
    const store = yield* ResearchStore.Service
    const guard = yield* SpendGuard.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          structured: Metadata,
          toStructuredOutput: ({ output }) => output.metadata,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const found = yield* research.current(context)
              if ("refused" in found) return { text: found.refused, metadata: {} }
              // A child session shares its root's run, whose spend is not the research's alone.
              const spent = found.lead.parentID ? undefined : yield* guard.snapshot(context.sessionID)
              const saved = yield* store.report(
                found.place,
                found.run.id,
                {
                  title: input.title,
                  answer: input.answer,
                  sections: input.sections.map((section) => ({
                    heading: section.heading,
                    body: section.body,
                    ...(section.subquestion ? { subquestion: section.subquestion } : {}),
                  })),
                  ...(input.disagreements ? { disagreements: [...input.disagreements] } : {}),
                  open_questions: [...input.open_questions],
                  ...(input.method_notes ? { method_notes: input.method_notes } : {}),
                } satisfies Research.ReportInput,
                {
                  judged: found.detail.notes.some(
                    (note) => note.verdict !== undefined && note.verdict !== "not-judged",
                  ),
                  ...(spent && (spent.spentUsd > 0 || spent.codiumSteps > 0)
                    ? {
                        spend:
                          spent.spentUsd > 0
                            ? `${SpendGuard.formatUsd(spent.spentUsd)} at list prices${spent.codiumSteps > 0 ? " + Codium" : ""}`
                            : "Codium",
                      }
                    : {}),
                  seconds: Math.round((Date.now() - found.run.created_at) / 1000),
                },
              )
              if (saved.type === "refused")
                return {
                  text: ["The report was not saved:", ...saved.errors.map((error) => `- ${error}`)].join("\n"),
                  metadata: { runID: found.run.id, refused: true, uncited: saved.uncited },
                }
              const confidence = saved.rendered.sections.map(
                (section) =>
                  `- ${section.heading}: ${ResearchConfidence.LABEL[section.confidence.level]}${section.confidence.disagree ? ` (${ResearchConfidence.DISAGREE})` : ""}`,
              )
              return {
                text: [
                  `Saved the report (version ${saved.version}) with its citations, sources and method. Now give the user the answer in a few lines, citing notes as [N3], rather than repeating the whole report.`,
                  ...(confidence.length ? ["Vector's estimate of each section's confidence:", ...confidence] : []),
                  ...(saved.rendered.removed.length
                    ? [`Left out after checking: ${saved.rendered.removed.join(", ")}.`]
                    : []),
                  ...(saved.uncited.length
                    ? [
                        "These sentences state a number, a date or a name without citing a note. Cite one, or reword them:",
                        ...saved.uncited.slice(0, 10).map((sentence) => `- ${sentence}`),
                      ]
                    : []),
                  saved.document ? HELD : ResearchStore.GUEST,
                ].join("\n"),
                metadata: {
                  runID: found.run.id,
                  ...(saved.document ? { document: saved.document } : {}),
                  version: saved.version,
                  uncited: saved.uncited,
                  removed: saved.rendered.removed,
                },
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/research_report",
  layer,
  deps: [ToolRegistry.node, ResearchRunV2.node, ResearchStore.node, SpendGuard.node],
})
