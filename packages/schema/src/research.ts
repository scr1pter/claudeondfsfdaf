export * as Research from "./research"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional, PositiveInt } from "./schema"

// Deep research: the shapes the research tools, the run store, the HTTP API and the app share. A run plans
// sub-questions, reads sources (S1, S2, ...), saves notes (N1, N2, ...) whose quotes were found in their source, and
// writes a report that cites the notes. The rules live in core (`research/*`) and are pure where they can be.

// Focused uses one agent, plus up to 2 researchers when the question has independent parts. Deep adds up to 4
// researchers and the judge.
export const Depth = Schema.Literals(["focused", "deep"]).annotate({ identifier: "ResearchDepth" })
export type Depth = typeof Depth.Type

// Where a run looks: the web, the web and this repository's brain, or the brain and the repository's files only.
export const Scope = Schema.Literals(["web", "web+brain", "brain"]).annotate({ identifier: "ResearchScope" })
export type Scope = typeof Scope.Type

export const Format = Schema.Literals(["brief", "report", "table", "memo"]).annotate({ identifier: "ResearchFormat" })
export type Format = typeof Format.Type

// Where each sub-question stands. A plan call that only changes these never asks the user again.
export const SubquestionStatus = Schema.Literals(["open", "answered", "dropped"]).annotate({
  identifier: "ResearchSubquestionStatus",
})
export type SubquestionStatus = typeof SubquestionStatus.Type

const Question = Schema.String.check(Schema.isLengthBetween(1, 1_000))
const Subquestion = Schema.String.check(Schema.isLengthBetween(1, 300))
const Domains = Schema.Array(Schema.String.check(Schema.isLengthBetween(1, 253))).check(Schema.isMaxLength(50))

// What `research_plan` proposes and the plan card shows. `status`, when given, lines up with `subquestions`.
export const Plan = Schema.Struct({
  question: Question,
  subquestions: Schema.Array(Subquestion).check(Schema.isLengthBetween(1, 8)),
  scope: Scope,
  depth: Depth,
  prefer_domains: optional(Domains),
  avoid_domains: optional(Domains),
  format: optional(Format),
  time_window: optional(Schema.String.check(Schema.isMaxLength(80))),
  status: optional(Schema.Array(SubquestionStatus).check(Schema.isMaxLength(8))),
}).annotate({ identifier: "ResearchPlan" })
export type Plan = typeof Plan.Type

// The plan card's answer, sent as `vector-plan:{json}`. Start keeps the plan's depth, Start deep raises it to deep,
// and Cancel stops the run. `plan` carries the fields the user edited, and `always` the ones they asked Vector to
// remember as preferences.
export const PlanAnswer = Schema.Struct({
  action: Schema.Literals(["start", "start-deep", "cancel"]),
  plan: optional(
    Schema.Struct({
      question: optional(Question),
      subquestions: optional(Schema.Array(Subquestion).check(Schema.isLengthBetween(1, 8))),
      scope: optional(Scope),
      prefer_domains: optional(Domains),
      avoid_domains: optional(Domains),
      format: optional(Format),
      time_window: optional(Schema.String.check(Schema.isMaxLength(80))),
    }),
  ),
  always: optional(Schema.Array(Schema.Literals(["prefer_domains", "avoid_domains", "format"]))),
}).annotate({ identifier: "ResearchPlanAnswer" })
export type PlanAnswer = typeof PlanAnswer.Type

// What became of a source. `robots`: the site's robots.txt asks Vector not to read it. `paywalled`: only the public
// excerpt was kept. `needs-render`: the page is built by script, so it needs the desktop browser. `failed` carries why,
// a site's challenge page ("blocked by the site") included.
export const SourceStatus = Schema.Literals([
  "read",
  "duplicate",
  "robots",
  "paywalled",
  "needs-render",
  "failed",
]).annotate({ identifier: "ResearchSourceStatus" })
export type SourceStatus = typeof SourceStatus.Type

// What kind of site a source is on, from its address alone.
export const SiteKind = Schema.Literals([
  "academic",
  "government",
  "standards",
  "reference",
  "forum",
  "other",
]).annotate({ identifier: "ResearchSiteKind" })
export type SiteKind = typeof SiteKind.Type

// What Vector noticed about a source, shown as chips beside it. These are observations, not verdicts: there is no
// "verified" signal. `primary` is a study, a filing or data of its own, by the rule in core's `research/signals.ts`.
export const Signal = Schema.Struct({
  kind: SiteKind,
  primary: Schema.Boolean,
  doi: optional(Schema.String),
  arxiv: optional(Schema.String),
  pmid: optional(Schema.String),
  published: optional(Schema.String),
  updated: optional(Schema.String),
  age_days: optional(NonNegativeInt),
  author: optional(Schema.String),
  data: Schema.Boolean,
  references: Schema.Boolean,
  duplicate_of: optional(Schema.String),
  paywalled: Schema.Boolean,
  addressed_to_ai: Schema.Boolean,
  corroborated: NonNegativeInt,
  preference: optional(Schema.Literals(["trusted", "avoided"])),
  // Read in the user's own signed-in browser after a handoff: private, like a private document's text.
  signed_in: optional(Schema.Boolean),
}).annotate({ identifier: "ResearchSignal" })
export type Signal = typeof Signal.Type

export const Source = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  canonical_url: Schema.String,
  title: Schema.String,
  site: Schema.String,
  status: SourceStatus,
  reason: optional(Schema.String),
  pages: optional(PositiveInt),
  signals: optional(Signal),
  fetched_at: optional(NonNegativeInt),
}).annotate({ identifier: "ResearchSource" })
export type Source = typeof Source.Type

export const Stance = Schema.Literals(["supports", "contradicts", "context"]).annotate({ identifier: "ResearchStance" })
export type Stance = typeof Stance.Type

// What the research judge said of a note. `not-judged` is a note the judge did not answer for, or answered in a line
// Vector could not read.
export const Verdict = Schema.Literals(["supported", "partial", "unsupported", "contradicted", "not-judged"]).annotate({
  identifier: "ResearchVerdict",
})
export type Verdict = typeof Verdict.Type

// Optional, source-quoted metadata for comparing quantitative findings. These are the source's reported
// quantities and scope, never a certification of the claim or a model's inferred population or date.
const MeasureText = Schema.String.check(Schema.isLengthBetween(1, 160))
export interface Measurement extends Schema.Schema.Type<typeof Measurement> {}
export const Measurement = Schema.Struct({
  metric: MeasureText,
  value: Schema.Finite,
  unit: Schema.String.check(Schema.isLengthBetween(1, 64)),
  scale: optional(Schema.Literals(["one", "thousand", "million", "billion", "trillion"])),
  currency: optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))),
  period: optional(MeasureText),
  geography: optional(MeasureText),
  population: optional(MeasureText),
  methodology: optional(MeasureText),
  definition: optional(MeasureText),
}).annotate({ identifier: "Research.Measurement" })

// A finding. Its quote was found in the saved text of its source when it was saved. `support` is whether the quote
// states the claim (`BrainLexical.states`); a note where it does not is a paraphrase, which cannot make a section High
// confidence on its own.
export const Note = Schema.Struct({
  id: Schema.String,
  subquestion: Schema.String,
  claim: Schema.String.check(Schema.isLengthBetween(1, 400)),
  source: Schema.String,
  quote: Schema.String.check(Schema.isLengthBetween(1, 600)),
  page: optional(PositiveInt),
  stance: Stance,
  support: Schema.Boolean,
  verdict: optional(Verdict),
  measurement: optional(Measurement),
  created_at: NonNegativeInt,
}).annotate({ identifier: "ResearchNote" })
export type Note = typeof Note.Type

export const RunStatus = Schema.Literals(["planned", "running", "done", "stopped", "failed"]).annotate({
  identifier: "ResearchRunStatus",
})
export type RunStatus = typeof RunStatus.Type

export const Run = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  question: Schema.String,
  plan: optional(Plan),
  depth: Depth,
  scope: Scope,
  status: RunStatus,
  report_document_id: optional(Schema.String),
  pages: NonNegativeInt,
  searches: NonNegativeInt,
  steps: NonNegativeInt,
  cost_usd: Schema.Finite,
  kept: Schema.Boolean,
  created_at: NonNegativeInt,
  updated_at: NonNegativeInt,
}).annotate({ identifier: "ResearchRun" })
export type Run = typeof Run.Type

export const ReportSection = Schema.Struct({
  heading: Schema.String.check(Schema.isLengthBetween(1, 200)),
  body: Schema.String.check(Schema.isLengthBetween(1, 6_000)),
  subquestion: optional(Schema.String),
}).annotate({ identifier: "ResearchReportSection" })
export type ReportSection = typeof ReportSection.Type

// What `research_report` takes. The answer and each section cite notes as [N3].
export const ReportInput = Schema.Struct({
  title: Schema.String.check(Schema.isLengthBetween(1, 200)),
  answer: Schema.String.check(Schema.isLengthBetween(1, 1_500)),
  sections: Schema.Array(ReportSection).check(Schema.isMaxLength(12)),
  disagreements: optional(Schema.Array(Schema.String.check(Schema.isMaxLength(1_000))).check(Schema.isMaxLength(12))),
  open_questions: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(12)),
  method_notes: optional(Schema.String.check(Schema.isMaxLength(2_000))),
}).annotate({ identifier: "ResearchReportInput" })
export type ReportInput = typeof ReportInput.Type

// A run changed: started, planned, read a source, saved a note or a report, was kept, or was forgotten (`forgotten`,
// which a run never is in the store). The app reloads the run from GET /memory/research/:runID.
export const Updated = define({
  type: "research.updated",
  schema: {
    runID: Schema.String,
    sourceID: optional(Schema.String),
    noteID: optional(Schema.String),
    status: Schema.Literals([...RunStatus.literals, "forgotten"]),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
