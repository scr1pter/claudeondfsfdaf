export * as ResearchReport from "./report"

import type { Research } from "@vectordevai/schema/research"
import { ResearchConfidence } from "./confidence"
import { ResearchClaim } from "./claim"
import { ResearchSignals } from "./signals"

// The report research_report writes, checked and rendered without a model. The checks are deterministic: every [N#]
// the report cites is a saved note, and every sub-question the plan marks answered has a note. Sentences that give a
// number, a date or a name without citing a note are listed as "uncited" warnings, not refused, since a summary
// sentence can stand on the cited ones around it. Rendering turns each [N#] into its source chip ([S3 p.12]) with the
// note's quote as a footnote, gives each section Vector's computed confidence, and ends with the Sources table and
// the Method: searches, pages, what was skipped and why, spend and time.
//
// Everything the model or a page wrote is made inert first: "<" and "![" are escaped, so no raw HTML and no image
// survive into the Markdown. Whatever later renders the report (the session, a `--report` file, the brain's copy)
// then fetches nothing, and an image address cannot carry text out. Footnote and link reference definitions are
// escaped too, so only Vector writes them: Markdown keeps a label's first definition, and a "[^N1]: ..." line in a
// section would otherwise stand in for the checked quote of N1.

export const CITE = /\[(N\d+(?:\s*,\s*N\d+)*)\]/g
// The same, for testing whether a sentence cites any note (a global pattern keeps its place between tests).
const CITES = /\[N\d+(?:\s*,\s*N\d+)*\]/

export const REMOVED = "Removed after checking"
export const NO_LONGER = "Its quote is no longer in its source."

export type Problems = {
  /** What stops the report: research_report refuses it with these. */
  readonly errors: readonly string[]
  /** Sentences with a number, a date or a name and no note cited. */
  readonly uncited: readonly string[]
}

/** The note IDs a text cites, in the order it first cites them. */
export function cited(text: string) {
  return [
    ...new Set(
      [...text.matchAll(CITE)].flatMap((match) =>
        match[1]!
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ),
  ]
}

export function check(
  input: Research.ReportInput,
  context: { readonly notes: readonly Research.Note[]; readonly plan?: Research.Plan },
): Problems {
  const ids = new Set(context.notes.map((note) => note.id))
  const unknown = cited(texts(input).join("\n")).filter((id) => !ids.has(id))
  const plan = context.plan
  const unanswered = (plan?.subquestions ?? []).flatMap((subquestion, index) =>
    plan?.status?.[index] === "answered" && !context.notes.some((note) => answers(note, subquestion, index))
      ? [index + 1]
      : [],
  )
  const known = context.notes.map((note) => note.id)
  return {
    errors: [
      ...unknown.map(
        (id) =>
          `[${id}] is not a saved note. Cite only notes research_note saved${known.length > 0 ? `: ${list(known)}` : ""}.`,
      ),
      ...unanswered.map(
        (number) => `Sub-question ${number} is marked answered but has no note. Save a note for it or mark it open.`,
      ),
    ],
    uncited: [input.answer, ...input.sections.map((section) => section.body)]
      .flatMap(sentences)
      .filter((sentence) => !CITES.test(sentence) && factual(sentence)),
  }
}

export type Method = {
  readonly searches: number
  readonly pages: number
  /** The queries sent, as the Sources tab shows them. */
  readonly queries?: readonly string[]
  /** What research spent, already worded ("$0.42 at list prices", "61 calls to your local model"). */
  readonly spend?: string
  readonly seconds?: number
}

export type Context = {
  readonly notes: readonly Research.Note[]
  readonly sources: readonly Research.Source[]
  /** The research judge ran on this report. */
  readonly judged: boolean
  /** Notes whose quote was not found in their source when the report was checked again. */
  readonly unverified?: ReadonlySet<string>
  readonly method: Method
}

export type Rendered = {
  readonly markdown: string
  readonly sections: readonly { readonly heading: string; readonly confidence: ResearchConfidence.Result }[]
  /** Notes left out: judged unsupported, or no longer quoted by their source. */
  readonly removed: readonly string[]
}

export function render(input: Research.ReportInput, context: Context): Rendered {
  const notes = new Map(context.notes.map((note) => [note.id, note]))
  const sources = new Map(context.sources.map((source) => [source.id, source]))
  const out = (id: string) => notes.get(id)?.verdict === "unsupported" || !!context.unverified?.has(id)
  const used = cited(texts(input).join("\n")).filter((id) => notes.has(id))
  const footnoted = used.filter((id) => !out(id))
  const removed = used.filter(out)
  const quantitative = ResearchClaim.comparisons(
    footnoted.map((id) => notes.get(id)!),
    context.sources,
  )
  const sections = input.sections.map((section) => ({
    heading: section.heading,
    confidence: ResearchConfidence.section(
      cited(section.body)
        .filter((id) => notes.has(id) && !context.unverified?.has(id))
        .map((id) => citedNote(notes.get(id)!, sources)),
      { judged: context.judged },
    ),
  }))
  const body = [
    `# ${inert(oneLine(input.title))}`,
    chips(input.answer, notes, sources, out),
    ...input.sections.flatMap((section, index) => {
      const confidence = sections[index]!.confidence
      return [
        `## ${inert(oneLine(section.heading))}`,
        `Confidence: ${ResearchConfidence.LABEL[confidence.level]} (Vector's estimate)${confidence.disagree ? ` · ${ResearchConfidence.DISAGREE}` : ""}`,
        ...(confidence.disagree ? [disagreement(section.body, new Map([...notes].filter(([id]) => !out(id))))] : []),
        chips(section.body, notes, sources, out),
      ]
    }),
    ...(input.disagreements && input.disagreements.length > 0
      ? [
          "## Where sources disagree",
          input.disagreements.map((line) => `- ${chips(line, notes, sources, out)}`).join("\n"),
        ]
      : []),
    ...(quantitative.length
      ? [
          "## Quantitative comparisons",
          "Comparisons use only the scope explicitly recorded from the quoted sources. A difference is a review flag, not a verdict on which source is correct. Omitted scope and unknown source relationships remain unverified. Values within 2% are labelled agreement; that tolerance does not establish statistical equivalence.",
          ...quantitative.map((item) =>
            chips(`- ${ResearchClaim.summary(item)} [${item.left}, ${item.right}]`, notes, sources, out),
          ),
        ]
      : []),
    ...(input.open_questions.length > 0
      ? ["## Open questions", input.open_questions.map((line) => `- ${inert(oneLine(line))}`).join("\n")]
      : []),
    ...(removed.length > 0
      ? [
          `## ${REMOVED}`,
          removed
            .map((id) => {
              const note = notes.get(id)!
              const why = context.unverified?.has(id) ? NO_LONGER : "The judge found the quote does not support it."
              return `- ~~${inert(oneLine(note.claim))}~~ (${id}, ${note.source}). ${why}`
            })
            .join("\n"),
        ]
      : []),
    "## Sources",
    table(context.sources),
    "## Method",
    method(context),
    ...(input.method_notes ? [inert(input.method_notes.trim())] : []),
    footnoted
      .map((id) => {
        const note = notes.get(id)!
        const source = sources.get(note.source)
        return `[^${id}]: "${inert(oneLine(note.quote))}" ${source ? `${inert(oneLine(source.title)) || source.site}, ${source.site}` : note.source} (${chip(note, sources)})`
      })
      .join("\n"),
  ].filter((part) => part.trim().length > 0)
  return { markdown: `${body.join("\n\n")}\n`, sections, removed }
}

function texts(input: Research.ReportInput) {
  return [
    input.answer,
    ...input.sections.flatMap((section) => [section.heading, section.body]),
    ...(input.disagreements ?? []),
    ...input.open_questions,
  ]
}

// A note answers a sub-question when it names it by its words or by its number ("2", "Q2", "Sub-question 2").
function answers(note: Research.Note, subquestion: string, index: number) {
  const named = note.subquestion.trim().toLowerCase()
  if (named.replace(/\s+/g, " ") === subquestion.trim().toLowerCase().replace(/\s+/g, " ")) return true
  return new RegExp(`^(?:q|sub-?question\\s*)?#?${index + 1}$`, "i").test(named)
}

// A text's sentences: split after ".", "!" or "?" before a capital, a digit or an opening mark, and at line breaks.
// "2.9" and "e.g. this" stay whole.
function sentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\d"'(\[“‘])|\n+/u)
    .map((sentence) => sentence.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .filter((sentence) => sentence.length > 0)
}

// A sentence states something checkable when it gives a number or a date, or names someone or something: a
// capitalised word after its first, or an acronym.
function factual(sentence: string) {
  if (/\d/.test(sentence)) return true
  const words = sentence.split(/\s+/).map((word) => word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""))
  return (
    words.slice(1).some((word) => word !== "I" && /^\p{Lu}/u.test(word)) ||
    words.some((word) => /^\p{Lu}{2,}$/u.test(word))
  )
}

function citedNote(note: Research.Note, sources: ReadonlyMap<string, Research.Source>): ResearchConfidence.Cited {
  const source = sources.get(note.source)
  // A copy counts as the site it copies, so a syndicated page is not a second independent site.
  const original = source?.signals?.duplicate_of ? sources.get(source.signals.duplicate_of) : undefined
  return {
    note,
    site: (original ?? source)?.site ?? note.source,
    primary: !!(original ?? source)?.signals?.primary,
    ...(source ? { lineage: ResearchClaim.lineage(source, [...sources.values()]) } : {}),
  }
}

function chip(note: Research.Note, sources: ReadonlyMap<string, Research.Source>) {
  const source = sources.get(note.source)
  return [source?.id ?? note.source, note.page ? `p.${note.page}` : undefined].filter(Boolean).join(" ")
}

// [N3] as its source chip and footnote; a note left out after checking is dropped from the text.
function chips(
  text: string,
  notes: ReadonlyMap<string, Research.Note>,
  sources: ReadonlyMap<string, Research.Source>,
  out: (id: string) => boolean,
) {
  return inert(text).replace(CITE, (whole, ids: string) =>
    ids
      .split(",")
      .map((id) => id.trim())
      .flatMap((id) => {
        const note = notes.get(id)
        if (!note) return [whole]
        if (out(id)) return []
        return [`\\[${chip(note, sources)}\\][^${id}]`]
      })
      .join(" "),
  )
}

// "Sources disagree", with the quote of a note that contradicts and one that supports.
function disagreement(body: string, notes: ReadonlyMap<string, Research.Note>) {
  const ids = new Set(cited(body))
  const against = [...notes.values()].find(
    (note) => ids.has(note.id) && (note.stance === "contradicts" || note.verdict === "contradicted"),
  )
  const supporting = [...notes.values()].find((note) => ids.has(note.id) && note.stance === "supports")
  return [
    supporting ? `> ${supporting.source}: "${inert(oneLine(supporting.quote))}"` : undefined,
    against ? `> ${against.source}: "${inert(oneLine(against.quote))}"` : undefined,
  ]
    .filter(Boolean)
    .join("\n>\n")
}

function table(sources: readonly Research.Source[]) {
  if (sources.length === 0) return "No sources were read."
  const rows = sources.map((source) => {
    const signals = source.signals ? ResearchSignals.labels(source.signals).join(" · ") : ""
    // A page's title is its author's words: its backslashes, brackets and angle brackets are escaped, so it cannot
    // end the link text, start an image or hold HTML, and the address's brackets, spaces and angle brackets are
    // percent-encoded so it cannot end the link.
    const title = cell((oneLine(source.title) || source.url).replace(/[\\[\]<]/g, "\\$&"))
    const target = source.url.replace(
      /[()<>\s]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    )
    return `| ${source.id} | [${title}](${target}) | ${cell(source.site)} | ${status(source)} | ${cell(signals)} |`
  })
  return ["| | Source | Site | Status | Signals |", "|---|---|---|---|---|", ...rows].join("\n")
}

function status(source: Research.Source) {
  const words: Readonly<Record<Research.SourceStatus, string>> = {
    read: "Read",
    duplicate: "Copy",
    robots: "Skipped: robots.txt",
    paywalled: "Paywalled (excerpt only)",
    "needs-render": "Skipped: needs the desktop browser",
    failed: "Skipped",
  }
  return cell(source.status === "failed" && source.reason ? `${words.failed}: ${source.reason}` : words[source.status])
}

function method(context: Context) {
  const skipped = context.sources.filter((source) => source.status !== "read" && source.status !== "paywalled")
  return [
    `- Searches: ${context.method.searches}`,
    ...(context.method.queries ?? []).map((query) => `  - ${inert(oneLine(query))}`),
    `- Pages read: ${context.method.pages}`,
    `- Skipped: ${skipped.length}`,
    ...skipped.map((source) => `  - ${source.id} ${source.site}: ${status(source)}`),
    ...(context.method.spend ? [`- Spend: ${context.method.spend}`] : []),
    ...(context.method.seconds !== undefined ? [`- Time: ${duration(context.method.seconds)}`] : []),
  ].join("\n")
}

function duration(seconds: number) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`
  return `${Math.round(seconds / 60)} min`
}

function list(ids: readonly string[]) {
  return ids.length <= 12 ? ids.join(", ") : `${ids.slice(0, 12).join(", ")} and ${ids.length - 12} more`
}

function cell(text: string) {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()
}

// Text Vector did not write, with no raw HTML, image or definition left in it: "<", "![" and "[^" are escaped, and so
// is a "[" that opens a link reference definition ("[label]: address", whose label may run over lines). A mark after
// an odd run of backslashes is escaped already; after an even run (none included) the backslashes are literal, so the
// mark is live and gets one more. A citation followed by a colon ("[N1]: ...") is left for `chips`, which turns it into
// a source chip.
function inert(text: string) {
  return text.replace(
    /(?<!\\)((?:\\\\)*)(<|!\[|\[(?=\^|(?!N\d+(?:\s*,\s*N\d+)*\])(?:[^[\]\\]|\\[\s\S])*\]:))/g,
    (_, slashes: string, mark: string) => `${slashes}${mark === "![" ? "!\\[" : `\\${mark}`}`,
  )
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}
