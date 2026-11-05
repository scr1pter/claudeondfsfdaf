export * as ResearchNoteTool from "./research-note"

import { Effect, Layer, Schema } from "effect"
import { Research } from "@vectordevai/schema/research"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { ResearchSource } from "../research/source"
import { ResearchStore } from "../research/store"
import { ResearchClaim } from "../research/claim"
import { ResearchRunV2 } from "./research-run"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// research_note on the V2 runner (section 5.4, RC4) checks a note twice, in the run store, as the V1 runner's does. The
// quote must be in the source: at least 12 characters and, once both are normalised, a substring of the source's saved
// text. Otherwise the note is refused and the agent is pointed at the chunk to copy from. Then whether the quote states
// the claim: a note whose quote does not is saved as a paraphrase, which cannot make a section High confidence alone.

export const name = "research_note"

export const description = `Saves a finding of this research run as a note (N1, N2, ...) that the report can cite as [N3].

- source is the S# the quote is from; quote is copied word for word from it, at least 12 characters. A quote that is not in the source is refused, with the chunk to copy from.
- claim says in one short sentence what the quote shows. When the quote does not state the whole claim, the note is kept as a paraphrase, which cannot make a section High confidence on its own.
- stance: supports (default), contradicts (the source says otherwise), or context.
- measurement optionally records a numeric metric, reported value, unit, scale and explicit scope (period, geography, population, methodology, definition, currency). Copy these from the quote; omit inferred scope. Vector compares compatible scopes and flags differences for review. This does not verify the source's truth.`

export const Input = Schema.Struct({
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

/** What a note records: the note saved, and whether its quote states its claim. */
export const Metadata = Schema.Struct({
  runID: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  support: Schema.optional(Schema.Boolean),
  refused: Schema.optional(Schema.Boolean),
})

const Output = Schema.Struct({ text: Schema.String, metadata: Metadata })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const research = yield* ResearchRunV2.Service
    const store = yield* ResearchStore.Service

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
              const source = input.source.trim().toUpperCase()
              // A note cites no source its agent may not see, so it cannot test guesses at a private page's words.
              const saved = yield* store.source(found.place, found.run.id, source)
              if (saved && ResearchSource.hidden(saved, context.agent === AgentV2.researchID))
                return {
                  text: ResearchSource.HIDDEN,
                  metadata: { runID: found.run.id, source: input.source, refused: true },
                }
              const noted = yield* store.note(found.place, found.run.id, {
                subquestion: input.subquestion,
                claim: input.claim,
                source,
                quote: input.quote,
                ...(input.page ? { page: input.page } : {}),
                ...(input.stance ? { stance: input.stance } : {}),
                ...(input.measurement ? { measurement: input.measurement } : {}),
                publicOnly: context.agent !== AgentV2.researchID,
              })
              if (noted.type === "refused")
                return { text: noted.message, metadata: { runID: found.run.id, source: input.source, refused: true } }
              const note = noted.note
              return {
                text:
                  (note.support
                    ? `Saved ${note.id} (${note.source}${note.page ? ` p.${note.page}` : ""}, ${note.stance}). Cite it as [${note.id}].`
                    : `Saved ${note.id} (${note.source}, ${note.stance}) as a paraphrase: the quote is in ${note.source} but does not state the whole claim, so on its own it cannot make a section High confidence. Narrow the claim to what the quote says, or quote the words that say it. Cite it as [${note.id}].`) +
                  (noted.comparisons?.length ? `\n${noted.comparisons.map(ResearchClaim.summary).join("\n")}` : ""),
                metadata: { runID: found.run.id, note: note.id, source: note.source, support: note.support },
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/research_note",
  layer,
  deps: [ToolRegistry.node, ResearchRunV2.node, ResearchStore.node],
})
