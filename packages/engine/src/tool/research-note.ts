import { ResearchStore } from "@vectordevai/core/research/store"
import { ResearchClaim } from "@vectordevai/core/research/claim"
import { Research } from "@vectordevai/schema/research"
import { Effect, Schema } from "effect"
import { ResearchRun } from "./research-run"
import { ResearchSource } from "./research-source"
import { Tool } from "./tool"
import DESCRIPTION from "./research-note.txt"

// research_note (section 5.4, RC4) checks a note twice. The quote must be in the source: at least 12 characters and,
// once both are normalised, a substring of the source's saved text (the run store's own check, since the brain's
// refuses held documents, which research sources are). Otherwise the note is refused and the agent is pointed at the
// chunk to copy from. Then whether the quote states the claim: a note whose quote does not is saved as a paraphrase,
// which cannot make a section High confidence on its own.

export const Parameters = Schema.Struct({
  subquestion: Schema.String.check(Schema.isLengthBetween(1, 300)).annotate({
    description: "The sub-question this note answers, as the plan words it",
  }),
  claim: Schema.String.check(Schema.isLengthBetween(1, 400)).annotate({
    description: "What the source says, in one short sentence",
  }),
  source: Schema.String.annotate({ description: 'The source the quote is from, such as "S3"' }),
  quote: Schema.String.check(Schema.isLengthBetween(1, 600)).annotate({
    description: "Words copied word for word from the source, at least 12 characters, that state the claim",
  }),
  page: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "The PDF page the quote is on",
  }),
  stance: Schema.optional(Research.Stance).annotate({
    description: "supports (default), contradicts or context",
  }),
  measurement: Schema.optional(Research.Measurement).annotate({
    description:
      "Optional quantitative finding. Copy the number, unit and every supplied scope field from this quote. Do not convert amounts or guess missing dates/populations.",
  }),
})

type Metadata = { runID?: string; note?: string; source?: string; support?: boolean; refused?: boolean }

export const ResearchNoteTool = Tool.define<typeof Parameters, Metadata, ResearchRun.Service | ResearchStore.Service>(
  "research_note",
  Effect.gen(function* () {
    const research = yield* ResearchRun.Service
    const store = yield* ResearchStore.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const found = yield* research.current(ctx)
          if ("refused" in found) return { title: "Not saved", output: found.refused, metadata: {} }
          const source = params.source.trim().toUpperCase()
          // A researcher cites no source it may not see, so a note cannot test guesses at a private page's words.
          const saved = yield* store.source(found.place, found.run.id, source)
          if (saved && ResearchSource.hidden(saved, ctx.agent === ResearchRun.LEAD))
            return {
              title: "Note refused",
              output: ResearchSource.HIDDEN,
              metadata: { runID: found.run.id, source: params.source, refused: true },
            }
          const noted = yield* store.note(found.place, found.run.id, {
            subquestion: params.subquestion,
            claim: params.claim,
            source,
            quote: params.quote,
            ...(params.page ? { page: params.page } : {}),
            ...(params.stance ? { stance: params.stance } : {}),
            ...(params.measurement ? { measurement: params.measurement } : {}),
            publicOnly: ctx.agent !== ResearchRun.LEAD,
          })
          if (noted.type === "refused")
            return {
              title: "Note refused",
              output: noted.message,
              metadata: { runID: found.run.id, source: params.source, refused: true },
            }
          const note = noted.note
          return {
            title: `${note.id}: ${note.claim.slice(0, 60)}`,
            output:
              (note.support
                ? `Saved ${note.id} (${note.source}${note.page ? ` p.${note.page}` : ""}, ${note.stance}). Cite it as [${note.id}].`
                : `Saved ${note.id} (${note.source}, ${note.stance}) as a paraphrase: the quote is in ${note.source} but does not state the whole claim, so on its own it cannot make a section High confidence. Narrow the claim to what the quote says, or quote the words that say it. Cite it as [${note.id}].`) +
              (noted.comparisons?.length ? `\n${noted.comparisons.map(ResearchClaim.summary).join("\n")}` : ""),
            metadata: { runID: found.run.id, note: note.id, source: note.source, support: note.support },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
