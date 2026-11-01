import { ResearchConfidence } from "@vectordevai/core/research/confidence"
import { ResearchStore } from "@vectordevai/core/research/store"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Research } from "@vectordevai/schema/research"
import { Effect, Schema } from "effect"
import { SessionID } from "../session/schema"
import { ResearchRun } from "./research-run"
import { Tool } from "./tool"
import DESCRIPTION from "./research-report.txt"

// research_report (section 5.4). The checks are deterministic: every [N#] cited must be a saved note, and a sub-question
// marked answered must have one; a sentence with a number, a date or a name and no citation is a warning, not a
// refusal. Each note's quote is checked against its source again, in case the source was forgotten since. The report is
// saved as a held, private document of the brain, recalled only once the user keeps it; calling again saves the next
// version. The model gets back what was saved and the confidence of each section, not the whole rendered report.

const Section = Schema.Struct({
  heading: Schema.String.check(Schema.isLengthBetween(1, 200)),
  body: Schema.String.check(Schema.isLengthBetween(1, 6_000)).annotate({
    description: "The section, citing notes as [N3]",
  }),
  subquestion: Schema.optional(Schema.String),
})

export const Parameters = Schema.Struct({
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

type Metadata = {
  runID?: string
  document?: string
  version?: number
  uncited?: readonly string[]
  removed?: readonly string[]
  refused?: boolean
}

export const HELD =
  "This report and its sources stay private and out of later sessions until you keep them (Keep in brain, or ask Vector to keep it)."

export const ResearchReportTool = Tool.define<
  typeof Parameters,
  Metadata,
  ResearchRun.Service | ResearchStore.Service | SpendGuard.Service
>(
  "research_report",
  Effect.gen(function* () {
    const research = yield* ResearchRun.Service
    const store = yield* ResearchStore.Service
    const guard = yield* SpendGuard.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const found = yield* research.current(ctx)
          if ("refused" in found) return { title: "Not saved", output: found.refused, metadata: {} }
          if (found.lead.id !== ctx.sessionID)
            return { title: "Not saved", output: "Only the research lead writes the report.", metadata: {} }
          // A lead the build agent started shares its launcher's run, whose spend is not the research's alone.
          const spent = found.lead.parentID ? undefined : yield* guard.snapshot(SessionID.make(ctx.sessionID))
          const input: Research.ReportInput = {
            title: params.title,
            answer: params.answer,
            sections: params.sections.map((section) => ({
              heading: section.heading,
              body: section.body,
              ...(section.subquestion ? { subquestion: section.subquestion } : {}),
            })),
            ...(params.disagreements ? { disagreements: [...params.disagreements] } : {}),
            open_questions: [...params.open_questions],
            ...(params.method_notes ? { method_notes: params.method_notes } : {}),
          }
          const saved = yield* store.report(found.place, found.run.id, input, {
            judged: found.detail.notes.some((note) => note.verdict !== undefined && note.verdict !== "not-judged"),
            ...(spent && (spent.spentUsd > 0 || spent.codiumSteps > 0)
              ? {
                  spend:
                    spent.spentUsd > 0
                      ? `${SpendGuard.formatUsd(spent.spentUsd)} at list prices${spent.codiumSteps > 0 ? " + Codium" : ""}`
                      : "Codium",
                }
              : {}),
            seconds: Math.round((Date.now() - found.run.created_at) / 1000),
          })
          if (saved.type === "refused")
            return {
              title: "Report refused",
              output: ["The report was not saved:", ...saved.errors.map((error) => `- ${error}`)].join("\n"),
              metadata: { runID: found.run.id, refused: true, uncited: saved.uncited },
            }
          const confidence = saved.rendered.sections.map(
            (section) =>
              `- ${section.heading}: ${ResearchConfidence.LABEL[section.confidence.level]}${section.confidence.disagree ? ` (${ResearchConfidence.DISAGREE})` : ""}`,
          )
          return {
            title: params.title,
            output: [
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
        }).pipe(Effect.orDie),
    }
  }),
)
