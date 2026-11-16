// VS-43's rule citation check (addendum A, Now window): whether a finding's structured rule citation quotes trusted
// rule text the review actually sent, in a scope that covers the finding, on a line the change touched. Pure and
// browser-safe, and nothing calls it before VS-43 wiring, which runs it under `ruleCheck: "strict"`.
//
// I-2: a rule gives a finding repository authority only when the repository's trusted text says it. The trusted text
// is the prompt's two trusted blocks as prompt.ts's trusted() sends them: trimmed, then clipped at MAX_TRUSTED_CHARS.
// Their source is "base branch" in CI and "working tree" for trusted local and desktop runs (as PromptInput records
// it), and a quote is checked against the copy that was sent, whatever its source. "head-added" never makes a citation
// pass: in a base-branch run it only names why a quote the base text lacks failed, when the change itself added the
// quoted text. A check never raises a finding or gives it weight; VS-43 wiring may only drop a finding or strip its
// rule claim.
//
// ruleCited runs these checks in order, and the first that fails is the reason:
// - source: the cited block was sent (and, for `paths[i]`, holds that entry). `scoped:` always fails until VS-48 sends
//   scoped files. In a base-branch run, a quote the change added reads as "head-added" instead.
// - quote: it holds a letter or a digit, and covers one or more whole trusted lines of one part it may cite, at least
//   one of them a rule line (not a heading, a fence, a line in a fenced example, or one with no letter or digit) and
//   none of them a fence or a fenced example line. A line is a logical line (logicalLines): a hard-wrapped paragraph or
//   list item is one line, so the continuation of "- Never\n  log access tokens." alone covers none. Lines compare
//   after whitespace is collapsed and list and heading markers are stripped (normalizedLine). Otherwise it is
//   "clipped" when it is whole only in the text beyond the clip, or runs into the clip; "head-added" in a base-branch
//   run when the change added it to a file that can carry rules (RULE_FILES); and "misquote" otherwise, a quote across
//   two parts, or of the change's own code, included.
// - scope: every part holding it has known globs ("scope-unknown" otherwise, which fails closed), and one is unscoped
//   or has a glob that covers the finding's head path ("scope" otherwise).
// - anchor: S3 (diff.ts onChangedLine): the finding is anchored at its own lines, on code the change touched.

import { REVIEW_CONFIG_PATH, REVIEW_RULES_PATHS, ruleGlobMatches, type RulePart } from "./config"
import {
  buildAnchorIndex,
  lookupFile,
  onChangedLine,
  resolveAnchor,
  type AnchorIndex,
  type DiffFile,
  type DiffLine,
} from "./diff"
import { MAX_TRUSTED_CHARS, type PromptInput } from "./prompt"
import type { ModelFinding, RuleCitation } from "./types"

export type RulesSource = NonNullable<PromptInput["rulesSource"]>

// Why a citation failed: the vocabulary, not the check order (the header gives the order).
export const RULE_MISMATCHES = [
  "source",
  "clipped",
  "head-added",
  "misquote",
  "scope",
  "scope-unknown",
  "anchor",
] as const
export type RuleMismatch = (typeof RULE_MISMATCHES)[number]

// `rulesSource` is the cited block's source as the prompt rendered it; it is left out only for a `scoped:` citation,
// whose files no block carries yet.
export type RuleCheck =
  | { cited: true; rulesSource: RulesSource }
  | { cited: false; reason: RuleMismatch; rulesSource?: RulesSource }

// One logical line of trusted text, by its offsets in TrustedText.text. `rule` is false for a heading, a fence, a line
// in a fenced block or a line with no letter or digit; `example` is true for a fence and a line in a fenced block;
// `whole` is false only for the last line sent, when the clip cut through it.
export interface TrustedLine {
  start: number
  end: number
  rule: boolean
  example: boolean
  whole: boolean
}

// Logical lines as logicalLines reads them, with empty ones left out, joined by single spaces.
export interface TrustedText {
  text: string
  lines: readonly TrustedLine[]
}

export interface TrustedPart {
  from: RulePart["from"] | "instructions" | "unknown"
  index?: number // a `paths` part's index in ReviewConfig.paths
  globs?: readonly string[] // [] for an unscoped part; undefined when the scope is unknown
  sent: TrustedText // what trusted() sent of this part
  full: TrustedText // the whole part, before the clip
}

// One trusted block: the source the prompt renders for it, and its parts (none when the block was not sent).
export interface TrustedBlock {
  source: RulesSource
  parts: readonly TrustedPart[]
}

export interface TrustedRules {
  instructions: TrustedBlock
  rules: TrustedBlock
  added: readonly TrustedText[] // each run of consecutive added lines in the diff's RULE_FILES
  anchors: DiffFile[]
  index: AnchorIndex
}

/**
 * The trusted rule text a review sent, read once per review. The wiring passes the values it puts in PromptInput
 * (`instructions`, `instructionsSource`, `rules`, `rulesSource`), the anchoring diff, and `parts`: rulePartsForPaths
 * with the arguments that built `rules`. Parts are used only when they reproduce the sent text, that is when their
 * texts joined by blank lines, then trimmed, are `rules` trimmed; each part's offsets are then read inside that trimmed
 * text, where trusted() clips. Otherwise the block is one part whose scope is unknown, so every citation of it fails
 * closed. A block's source is the one trusted() renders, "base branch" when none is given, even for a block that was
 * not sent.
 */
export function trustedRules(input: {
  instructions?: string
  instructionsSource?: RulesSource
  rules?: string
  rulesSource?: RulesSource
  parts?: readonly RulePart[]
  anchors: DiffFile[]
}): TrustedRules {
  const instructions = input.instructions?.trim() ?? ""
  const rules = input.rules?.trim() ?? ""
  return {
    instructions: {
      source: input.instructionsSource ?? "base branch",
      parts: instructions ? [part({ from: "instructions", globs: [] }, instructions, 0, instructions.length)] : [],
    },
    rules: { source: input.rulesSource ?? "base branch", parts: rules ? rulesParts(rules, input.parts) : [] },
    added: input.anchors
      .filter(
        (file) => RULE_FILES.has(file.path) || RULE_FILE_NAMES.has(file.path.slice(file.path.lastIndexOf("/") + 1)),
      )
      .flatMap((file) => file.hunks.flatMap((hunk) => addedRuns(hunk.lines)))
      .map((run) => textOf(logicalLines(run).map((line) => ({ ...line, whole: true })))),
    anchors: input.anchors,
    index: buildAnchorIndex(input.anchors),
  }
}

/** Whether a finding's structured citation holds against the trusted rule text (the header lists the checks). */
export function ruleCited(
  finding: Pick<ModelFinding, "path" | "line" | "endLine" | "side"> & { citation: RuleCitation },
  trusted: TrustedRules,
): RuleCheck {
  const source = finding.citation.source
  const block = source.kind === "repository_instructions" ? trusted.instructions : trusted.rules
  const fail = (reason: RuleMismatch): RuleCheck =>
    source.kind === "scoped" ? { cited: false, reason } : { cited: false, reason, rulesSource: block.source }
  // The quote read as the trusted text is, so it may keep the markers and line breaks it copied.
  const quote = logicalLines(finding.citation.quote.split(/\r\n?|\n/))
    .map((line) => line.text)
    .filter(Boolean)
    .join(" ")
  const added = () => block.source === "base branch" && trusted.added.some((text) => coverage(text, quote) === "whole")
  const candidates = candidatesOf(source, block)
  if (!candidates.length) return fail(source.kind !== "scoped" && added() ? "head-added" : "source")
  // A citation built without decodeRuleCitation may hold no word at all.
  if (!/[\p{L}\p{N}]/u.test(quote)) return fail("misquote")
  const holding = candidates.filter((candidate) => coverage(candidate.sent, quote) === "whole")
  if (!holding.length) {
    const clipped = (candidate: TrustedPart) =>
      coverage(candidate.full, quote) === "whole" || coverage(candidate.sent, quote) === "cut"
    if (candidates.some(clipped)) return fail("clipped")
    return fail(added() ? "head-added" : "misquote")
  }
  if (holding.some((candidate) => candidate.globs === undefined)) return fail("scope-unknown")
  const path = lookupFile(trusted.index, finding.path)?.file.path ?? finding.path
  const inScope = holding.some(
    (candidate) =>
      candidate.globs !== undefined &&
      (candidate.globs.length === 0 || candidate.globs.some((glob) => ruleGlobMatches(path, glob))),
  )
  if (!inScope) return fail("scope")
  const resolved = resolveAnchor(trusted.index, finding)
  if (!resolved.ok || !onChangedLine(trusted.anchors, finding, resolved.anchor)) return fail("anchor")
  return { cited: true, rulesSource: block.source }
}

// The parts a citation may quote: the whole block for a block name, the one `paths` entry for `paths[i]` (or the
// block's one part when its parts are unknown, which then fails as "scope-unknown"), and none for `scoped:`.
function candidatesOf(source: RuleCitation["source"], block: TrustedBlock): readonly TrustedPart[] {
  if (source.kind === "scoped") return []
  if (source.kind !== "paths") return block.parts
  if (block.parts.some((candidate) => candidate.from === "unknown")) return block.parts
  return block.parts.filter((candidate) => candidate.from === "paths" && candidate.index === source.index)
}

// Files whose added lines can carry rules into a trusted block: the instruction files baseInstructions reads (AGENTS.md
// and CLAUDE.md, matched at any depth for VS-48's scoped files, and .vector/RULES.md) and the review rules and config.
// A quote of the change's own code is a "misquote", never "head-added". Their lines are read as Markdown, so a rule a
// change adds to review.json `paths` (a JSON string) is not found there either.
const RULE_FILES = new Set<string>([".vector/RULES.md", ...REVIEW_RULES_PATHS, REVIEW_CONFIG_PATH])
const RULE_FILE_NAMES = new Set(["AGENTS.md", "CLAUDE.md"])

// The rules block's parts inside the trimmed text trusted() clips, or one part of unknown scope when `parts` are absent
// or do not reproduce it. A part's offsets are its offsets in the joined text less what the trim removed at its start.
function rulesParts(rules: string, parts: readonly RulePart[] | undefined): TrustedPart[] {
  const joined = parts?.map((item) => item.text).join("\n\n") ?? ""
  if (!parts || joined.trim() !== rules) return [part({ from: "unknown" }, rules, 0, rules.length)]
  const lead = joined.length - joined.trimStart().length
  const starts = parts.reduce<number[]>((out, item, at) => {
    out.push(at === 0 ? -lead : out[at - 1] + parts[at - 1].text.length + 2)
    return out
  }, [])
  return parts.map((item, at) =>
    part(
      {
        from: item.from,
        globs: item.from === "global" ? [] : item.from === "section" ? [...item.globs] : [item.glob],
        ...(item.from === "paths" ? { index: item.index } : {}),
      },
      rules,
      Math.max(0, starts[at]),
      Math.max(0, Math.min(rules.length, starts[at] + item.text.length)),
    ),
  )
}

// One part: the text between `start` and `end` of a trimmed block, both as sent (what lies before MAX_TRUSTED_CHARS)
// and whole. A logical line the clip cut through is sent as far as the clip, and is whole only when the cut removed
// nothing but whitespace: a wrapped bullet whose later lines lie past the clip is not whole.
function part(
  about: Pick<TrustedPart, "from" | "index" | "globs">,
  block: string,
  start: number,
  end: number,
): TrustedPart {
  const lines = block
    .slice(start, end)
    .split("\n")
    .reduce<{ text: string; start: number }[]>((out, text) => {
      const previous = out[out.length - 1]
      out.push({ text, start: previous ? previous.start + previous.text.length + 1 : start })
      return out
    }, [])
  const full = logicalLines(lines.map((line) => line.text))
  return {
    ...about,
    sent: textOf(
      full.flatMap((line) => {
        const sent = line.lines.filter((at) => lines[at].start < MAX_TRUSTED_CHARS)
        if (!sent.length) return []
        const text = joinedText(sent.map((at) => lines[at].text.slice(0, MAX_TRUSTED_CHARS - lines[at].start)))
        return [{ ...line, text, whole: text === line.text }]
      }),
    ),
    full: textOf(full.map((line) => ({ ...line, whole: true }))),
  }
}

function textOf(lines: readonly { text: string; rule: boolean; example: boolean; whole: boolean }[]): TrustedText {
  const kept = lines.filter((line) => line.text)
  return {
    text: kept.map((line) => line.text).join(" "),
    lines: kept.reduce<TrustedLine[]>((out, line) => {
      const start = out.length ? out[out.length - 1].end + 1 : 0
      out.push({ start, end: start + line.text.length, rule: line.rule, example: line.example, whole: line.whole })
      return out
    }, []),
  }
}

// The texts of each run of consecutive added lines in one hunk.
function addedRuns(lines: readonly DiffLine[]): string[][] {
  return lines.reduce<string[][]>((runs, line, at) => {
    if (line.kind !== "add") return runs
    if (at === 0 || lines[at - 1].kind !== "add") runs.push([])
    runs[runs.length - 1].push(line.text)
    return runs
  }, [])
}

type LogicalLine = { lines: number[]; rule: boolean; example: boolean }

// Physical lines folded into logical ones, in order, each with the indices of the physical lines it holds. A non-blank
// line continues the paragraph or list item line before it, as Markdown reads a hard-wrapped line, unless it starts a
// block of its own: a line that stands ALONE, a bullet, a deeper blockquote, or a numbered item that is numbered 1 or
// sits left of the text of the line it follows (where Markdown starts a sibling item). So a quote of a wrapped bullet's
// continuation alone ("log access tokens." out of "- Never\n  log access tokens.") covers no whole line. A fence and
// each line in a fenced block stand alone as examples, no rule lines: a "Bad:" example quoted alone, or beside the rule
// it illustrates, would claim the opposite of the rule.
function logicalLines(raw: readonly string[]): (LogicalLine & { text: string })[] {
  return raw
    .reduce<{ out: LogicalLine[]; fenced: boolean; open?: { depth: number; column: number } }>(
      (state, line, at) => {
        const fence = FENCE.test(line.trim())
        if (state.fenced || fence) {
          state.out.push({ lines: [at], rule: false, example: true })
          return { out: state.out, fenced: fence ? !state.fenced : true }
        }
        const rest = line.replace(QUOTED, "")
        const column = line.length - rest.length
        const content = rest.trim()
        const depth = line.slice(0, column).split(">").length - 1
        const numbered = /^(\d{1,9})[.)]\s/.exec(content)
        const open = state.open
        const continues =
          open !== undefined &&
          content !== "" &&
          depth <= open.depth &&
          !ALONE.test(content) &&
          !/^[-*+]\s/.test(content) &&
          !(numbered && (Number(numbered[1]) === 1 || column < open.column))
        if (continues) {
          const last = state.out[state.out.length - 1]
          last.lines.push(at)
          last.rule = last.rule || /[\p{L}\p{N}]/u.test(content)
          return state
        }
        state.out.push({ lines: [at], rule: normalizedLine(line).rule, example: false })
        const marker = /^(?:[-*+]|\d{1,9}[.)])\s+/.exec(content)?.[0] ?? ""
        return {
          out: state.out,
          fenced: false,
          open: content && !ALONE.test(content) ? { depth, column: column + marker.length } : undefined,
        }
      },
      { out: [], fenced: false },
    )
    .out.map((line) => ({ ...line, text: joinedText(line.lines.map((at) => raw[at])) }))
}

// A logical line's text from its physical lines: the first as normalizedLine reads it, and each continuation with only
// its blockquote marks stripped and its whitespace collapsed, since it starts no list item or heading.
function joinedText(raw: readonly string[]) {
  return raw
    .map((line, at) => (at === 0 ? normalizedLine(line).text : line.replace(QUOTED, "").replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .join(" ")
}

const FENCE = /^(?:```|~~~)/
// Indentation and blockquote marks before a line's content.
const QUOTED = /^\s*(?:>\s*)*/
// Lines that stand alone, neither continuing the line before nor continued: a heading, a fence, a table row, and a
// thematic break or setext underline.
const ALONE = /^(?:#{1,6}(?:\s|$)|```|~~~|\|)|^(?:=+|-+|(?:[-*_]\s*){3,})$/

// One line as the check compares it: trimmed, with a heading's `#` marks or a blockquote's `>` and a list item's marker
// (and its task box) stripped, and inner whitespace collapsed. A heading, a fence or a line with no letter or digit
// is not a rule line, so a quote of `## path: src/**` alone, or of a heading, covers no rule.
function normalizedLine(raw: string): { text: string; rule: boolean } {
  const line = raw.trim()
  const heading = /^#{1,6}(?:\s+|$)/.exec(line)
  const text = (
    heading
      ? line.slice(heading[0].length)
      : line.replace(/^(?:>\s*)+/, "").replace(/^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "")
  )
    .replace(/\s+/g, " ")
    .trim()
  return { text, rule: !heading && !FENCE.test(line) && /[\p{L}\p{N}]/u.test(text) }
}

// Whether a text holds the quote as whole lines: "whole" when some occurrence starts at a line's start, ends at the end
// of a line sent whole, spans a rule line and spans no example; "cut" when one starts at a line's start and ends where
// the clip cut the last line sent (only the last line can be cut). Matching is exact and literal, so no character in a
// quote is special. It takes time linear in the text and the quote, however many lines the quote matches: the added
// runs come from the diff, up to 64 MB, and a prompt injection can choose the quote.
function coverage(text: TrustedText, quote: string): "whole" | "cut" | undefined {
  if (!quote) return undefined
  const starts = new Map(text.lines.map((line, at) => [line.start, at]))
  const ends = new Map(text.lines.map((line, at) => [line.end, at]))
  // How many rule and example lines come before each line, so a span of any length is read in constant time.
  const before = text.lines.reduce(
    (out, line, at) => {
      out.rules.push(out.rules[at] + Number(line.rule))
      out.examples.push(out.examples[at] + Number(line.example))
      return out
    },
    { rules: [0], examples: [0] },
  )
  const whole = occurs(text.text, quote, (start) => {
    const first = starts.get(start)
    const last = ends.get(start + quote.length)
    if (first === undefined || last === undefined || !text.lines[last].whole) return false
    return before.rules[last + 1] > before.rules[first] && before.examples[last + 1] === before.examples[first]
  })
  if (whole) return "whole"
  const final = text.lines.at(-1)
  const cut = final && !final.whole && text.text.endsWith(quote) && starts.has(text.text.length - quote.length)
  return cut ? "cut" : undefined
}

// Whether `match` holds at some offset where `quote` occurs in `text`, tried in order and stopping at the first that
// holds. Knuth-Morris-Pratt does amortized constant work per character of the text, so a quote that occurs at every
// one of many lines costs one pass over the text, not a comparison per line.
function occurs(text: string, quote: string, match: (start: number) => boolean): boolean {
  // border[i]: the length of the longest proper prefix of quote[0..i] that is also its suffix.
  const border = [0]
  for (let at = 1, length = 0; at < quote.length; at++) {
    while (length > 0 && quote[at] !== quote[length]) length = border[length - 1]
    if (quote[at] === quote[length]) length++
    border.push(length)
  }
  for (let at = 0, length = 0; at < text.length; at++) {
    while (length > 0 && text[at] !== quote[length]) length = border[length - 1]
    if (text[at] === quote[length]) length++
    if (length < quote.length) continue
    if (match(at - length + 1)) return true
    length = border[length - 1]
  }
  return false
}
