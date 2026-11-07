// The output schemas the reviewers answer with, and lenient decoding of what they return. The schemas use only
// conservative JSON Schema (no anyOf, no $ref, no additionalProperties: false), because providers differ in
// what they accept for a forced tool call.

import {
  CATEGORIES,
  FAILURE_CLASSES,
  FAILURE_MECHANISMS,
  SEVERITIES,
  STRICT_DROPS,
  STRICT_FIX_KINDS,
  VERIFIED_BY,
  type Category,
  type FailureInfo,
  type ModelFinding,
  type ModelReport,
  type Quote,
  type ReviewConfig,
  type Risk,
  type Severity,
} from "./types"

export const MAX_TITLE_CHARS = 100
// More findings than this is not a review; the rest are ignored.
export const MAX_REPORT_FINDINGS = 100
// The summary asks for two or three sentences; the summary comment shows at most 1,500 characters of it.
export const MAX_SUMMARY_CHARS = 4_000
// A longer fix is dropped rather than cut: half a fix is worse than none, and GitHub refuses comments over 65,536
// characters.
export const MAX_SUGGESTION_CHARS = 8_000
export const MAX_SUGGESTION_LINES = 80
// VS-27a's strict fields. S5 bounds a failure's trigger and impact. The decoder keeps the first MAX_FINDING_QUOTES
// quotes that decode among a finding's first MAX_QUOTES_READ entries, and drops, never cuts, a longer quote: a cut quote
// could match the file where the whole one would not.
export const MAX_FAILURE_TEXT_CHARS = 400
export const MAX_FINDING_QUOTES = 6
export const MAX_QUOTES_READ = MAX_FINDING_QUOTES * 4
export const MAX_QUOTE_LINES = 20
export const MAX_QUOTE_CHARS = 2_000
// A quote path that could leave the repository: a `..` segment, a backslash or a drive. decodeQuote drops such a quote,
// and guardrail.ts never asks for or reads its file, for findings built without the decoder too.
export const ESCAPING_PATH = /(^|\/)\.\.(\/|$)|\\|^[A-Za-z]:/

const RISKS: Risk[] = ["low", "medium", "high"]

export const REVIEW_REPORT_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two or three sentences: what the change does and the main risk it carries.",
    },
    risk: { type: "string", enum: [...RISKS] },
    files: {
      type: "array",
      description: "The changed files that matter most, each with a few words on why.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          note: { type: "string", description: "Why this file matters, in a few words." },
        },
        required: ["path", "note"],
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path." },
          line: { type: "integer", minimum: 1, description: "First line of the problem, as a head line number." },
          endLine: { type: "integer", minimum: 1, description: "Last line, when the problem spans several lines." },
          side: { type: "string", enum: ["RIGHT", "LEFT"], description: "LEFT only for removed code." },
          severity: { type: "string", enum: [...SEVERITIES] },
          category: { type: "string", enum: [...CATEGORIES] },
          title: { type: "string", maxLength: MAX_TITLE_CHARS },
          body: {
            type: "string",
            description:
              "What goes wrong and when, why it matters, citing the code you read; end with `Fix:` and the concrete change.",
          },
          suggestion: {
            type: "string",
            description: "The exact replacement for line..endLine, with the same indentation and no fences.",
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", items: { type: "string" }, description: "path:line references you read." },
          rule: { type: "string", description: "The repository rule this breaks, quoted." },
          duplicateOf: { type: "string", description: "The id of an open earlier finding this repeats." },
        },
        required: ["path", "line", "severity", "category", "title", "body", "confidence"],
      },
    },
    priorStatus: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["fixed", "open"] },
          reason: { type: "string" },
        },
        required: ["id", "status", "reason"],
      },
    },
  },
  required: ["summary", "risk", "files", "findings"],
}

export const VERIFY_JSON_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["confirmed", "rejected"] },
          reason: { type: "string", description: "One sentence." },
        },
        required: ["id", "verdict", "reason"],
      },
    },
  },
  required: ["results"],
}

// The keys the strict schemas depend on. Each later key widens this and adds its field or enum value only when set, so
// the `guardrail: "strict"` schemas, and the digest they enter, stay as they are while it is off: VS-42 with scopeGate
// (the `scope` field), VS-43 with ruleCheck (the structured rule) and VS-44 with verifyEvidence (its certificate schema).
export type StrictSchemaKeys = Partial<Pick<ReviewConfig, "guardrail">>

// The report schema under `guardrail: "strict"` (VS-27a), or undefined when it is off: the legacy report schema with a
// finding's `failure`, `quotes` and `patch` added. A finding's `required` list is the legacy one, because conservative
// JSON Schema cannot say "required when blocking": S2 and S5 drop a blocking finding without them. Built from a deep copy,
// so nothing it returns shares an object with REVIEW_REPORT_JSON_SCHEMA. The quote cap is in the description, not in
// maxItems, so a provider sees only the keywords the legacy schema already sends; the decoder enforces it.
export function strictReportJsonSchema(keys: StrictSchemaKeys) {
  if (keys.guardrail !== "strict") return undefined
  const legacy = structuredClone(REVIEW_REPORT_JSON_SCHEMA)
  const finding = legacy.properties.findings.items
  return {
    ...legacy,
    properties: {
      ...legacy.properties,
      findings: {
        ...legacy.properties.findings,
        items: {
          ...finding,
          properties: {
            ...finding.properties,
            failure: {
              type: "object",
              description:
                "Required on every blocking finding: the production failure it causes, in one of the five classes.",
              properties: {
                class: { type: "string", enum: [...FAILURE_CLASSES] },
                mechanism: { type: "string", enum: [...FAILURE_MECHANISMS] },
                trigger: {
                  type: "string",
                  maxLength: MAX_FAILURE_TEXT_CHARS,
                  description: "The input or state that makes it fail.",
                },
                impact: { type: "string", maxLength: MAX_FAILURE_TEXT_CHARS, description: "What breaks when it does." },
              },
              required: ["class", "mechanism", "trigger", "impact"],
            },
            quotes: {
              type: "array",
              description: `Required on every blocking finding: up to ${MAX_FINDING_QUOTES} quotes of the code it rests on, each copied exactly.`,
              items: quoteSchema(),
            },
            patch: {
              type: "string",
              maxLength: MAX_SUGGESTION_CHARS,
              description: "A unified diff against head that fixes it, with at most 3 hunks.",
            },
          },
        },
      },
    },
  }
}

// The schema of the StrictResult a strict review reports (VS-27a), or undefined when `guardrail` is off. It is never sent
// to a model; VS-27c checks the JSON outcome against it. A lane deviation from the contract's STRICT_RESULT_JSON_SCHEMA
// constant (the round-two amendment names only the report schema): later keys add StrictDrop values (VS-42's
// `pre-existing`, VS-44's `certificate-mismatch` and `verdict-unsure`) and fields, each only under its key, so a strict
// review validates against the schema built for its own keys.
export function strictResultJsonSchema(keys: StrictSchemaKeys) {
  if (keys.guardrail !== "strict") return undefined
  return {
    type: "object",
    properties: {
      version: { type: "integer", enum: [1] },
      head: { type: "string", description: "The head commit reviewed." },
      complete: {
        type: "boolean",
        description: "False when a stage did not finish, coverage is partial or a verdict could not be read.",
      },
      incomplete: { type: "array", items: { type: "string" }, description: "Why it is incomplete, as reason codes." },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            class: { type: "string", enum: [...FAILURE_CLASSES] },
            mechanism: { type: "string", enum: [...FAILURE_MECHANISMS] },
            path: { type: "string" },
            line: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
            side: { type: "string", enum: ["RIGHT", "LEFT"] },
            title: { type: "string", maxLength: MAX_TITLE_CHARS },
            trigger: { type: "string", maxLength: MAX_FAILURE_TEXT_CHARS },
            impact: { type: "string", maxLength: MAX_FAILURE_TEXT_CHARS },
            quotes: { type: "array", minItems: 1, maxItems: MAX_FINDING_QUOTES, items: quoteSchema() },
            fix: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...STRICT_FIX_KINDS] },
                text: { type: "string", maxLength: MAX_SUGGESTION_CHARS },
              },
              required: ["kind", "text"],
            },
            verifiedBy: { type: "string", enum: [...VERIFIED_BY] },
            verifier: { type: "string" },
          },
          required: [
            "id",
            "class",
            "mechanism",
            "path",
            "line",
            "side",
            "title",
            "trigger",
            "impact",
            "quotes",
            "fix",
            "verifiedBy",
            "verifier",
          ],
        },
      },
      dropped: {
        type: "array",
        items: {
          type: "object",
          properties: {
            reason: { type: "string", enum: [...STRICT_DROPS] },
            count: { type: "integer", minimum: 1 },
          },
          required: ["reason", "count"],
        },
      },
      fixUnchecked: { type: "integer", minimum: 0 },
    },
    required: ["version", "head", "complete", "findings", "dropped", "fixUnchecked"],
  }
}

// A fresh object on every call, so no two schemas share it.
function quoteSchema() {
  return {
    type: "object",
    properties: {
      path: { type: "string", description: "Repository-relative path." },
      line: { type: "integer", minimum: 1, description: "The quote's first line in that file." },
      side: {
        type: "string",
        enum: ["RIGHT", "LEFT"],
        description: "RIGHT quotes the head file; LEFT the base file, for code the change removed.",
      },
      code: {
        type: "string",
        maxLength: MAX_QUOTE_CHARS,
        description: `The lines exactly as the file has them, at most ${MAX_QUOTE_LINES}.`,
      },
    },
    required: ["path", "line", "side", "code"],
  }
}

export interface VerifyResult {
  id: string
  verdict: "confirmed" | "rejected"
  reason: string
}

// Models wrap JSON in prose or fences despite instructions, and sometimes quote other JSON first: a file they read,
// an example, the report of an earlier run. Every fenced block, every balanced {…} or […], the first { to the last
// } and the whole text are candidates, and the one that ends latest and passes `accept` wins, because a model's
// answer comes after whatever it quoted on the way.
export function extractJson(text: string, accept: (value: unknown) => boolean = () => true): unknown {
  const candidates = [
    ...Array.from(text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g), (match) => ({
      source: match[1] ?? "",
      end: (match.index ?? 0) + match[0].length,
    })),
    ...balancedSpans(text).map((span) => ({ source: text.slice(span.start, span.end), end: span.end })),
    ...(text.indexOf("{") !== -1 && text.lastIndexOf("}") > text.indexOf("{")
      ? [{ source: text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1), end: text.lastIndexOf("}") + 1 }]
      : []),
    { source: text, end: text.length },
  ].toSorted((a, b) => b.end - a.end || b.source.length - a.source.length)
  for (const candidate of candidates) {
    if (!candidate.source.trim()) continue
    try {
      const value: unknown = JSON.parse(candidate.source)
      if (value && typeof value === "object" && accept(value)) return value
    } catch {
      continue
    }
  }
  return undefined
}

// Every matched {…} or […] pair, nested ones included, in one pass. Quotes are tracked only inside a bracket, so
// prose before the JSON (an apostrophe, a stray "[0, n)") cannot hide the report behind it.
function balancedSpans(text: string) {
  const spans: { start: number; end: number }[] = []
  const open: number[] = []
  let quoted = false
  let escaped = false
  for (let position = 0; position < text.length; position++) {
    const char = text[position]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"' && open.length) quoted = true
    else if (char === "{" || char === "[") open.push(position)
    else if (char === "}" || char === "]") {
      const start = open.findLastIndex((index) => (text[index] === "{") === (char === "}"))
      if (start === -1) continue
      spans.push({ start: open[start], end: position + 1 })
      open.length = start
    }
  }
  return spans
}

// Accepts `info.structured`, or the text of the last message. A missing side becomes RIGHT, an unknown severity
// concern and an unknown category bug; numbers given as strings are converted and every value is clamped.
// Findings without a path or a title are dropped. Returns undefined when there is no report at all. A finding's
// strict fields (failure, quotes, patch) are read only under `guardrail: "strict"`; without it they are ignored. Under
// strict, an unknown severity is also marked severityUnreadable (VS-27b).
export function decodeReport(input: unknown, keys: StrictSchemaKeys = {}): ModelReport | undefined {
  const value =
    typeof input === "string"
      ? (extractJson(input, (candidate) => isRecord(candidate) && Array.isArray(candidate.findings)) ??
        extractJson(input, (candidate) => isRecord(candidate) && !!text(candidate.summary)))
      : input
  if (!isRecord(value)) return undefined
  const summary = text(value.summary).slice(0, MAX_SUMMARY_CHARS)
  if (!Array.isArray(value.findings) && !summary) return undefined
  const report: ModelReport = {
    summary,
    risk: RISKS.find((risk) => risk === lower(value.risk)) ?? "low",
    files: list(value.files).flatMap((entry) => {
      if (!isRecord(entry)) return []
      const path = cleanPath(text(entry.path))
      return path ? [{ path, note: oneLine(text(entry.note)) }] : []
    }),
    findings: list(value.findings)
      .flatMap((entry) => {
        const finding = decodeFinding(entry, keys.guardrail === "strict")
        return finding ? [finding] : []
      })
      .slice(0, MAX_REPORT_FINDINGS),
  }
  const priorStatus = list(value.priorStatus).flatMap((entry) => {
    if (!isRecord(entry)) return []
    const id = text(entry.id)
    const status = lower(entry.status)
    if (!id || (status !== "fixed" && status !== "open")) return []
    return [{ id, status, reason: oneLine(text(entry.reason)) } as const]
  })
  if (priorStatus.length) report.priorStatus = priorStatus
  return report
}

export function decodeVerify(input: unknown): VerifyResult[] | undefined {
  const value =
    typeof input === "string"
      ? extractJson(input, (candidate) => {
          // Only results that name a finding and a verdict count, so unrelated JSON cannot read as "no findings
          // confirmed".
          const entries = isRecord(candidate) ? candidate.results : candidate
          return (
            Array.isArray(entries) &&
            entries.some(
              (entry) => isRecord(entry) && !!text(entry.id) && /^(confirm|reject)/.test(lower(entry.verdict)),
            )
          )
        })
      : input
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.results)
      ? value.results
      : undefined
  if (!entries) return undefined
  return entries.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return []
    const id = text(entry.id)
    const said = lower(entry.verdict)
    const verdict = said.startsWith("confirm") ? "confirmed" : said.startsWith("reject") ? "rejected" : undefined
    if (!id || !verdict) return []
    return [{ id, verdict, reason: oneLine(text(entry.reason)) } as VerifyResult]
  })
}

function decodeFinding(input: unknown, strict: boolean): ModelFinding | undefined {
  if (!isRecord(input)) return undefined
  const path = cleanPath(text(input.path))
  const title = oneLine(text(input.title)).slice(0, MAX_TITLE_CHARS)
  if (!path || !title) return undefined
  // A finding with no usable line keeps line 1, so it is anchored or listed rather than lost.
  const line = Math.max(1, integer(input.line) ?? 1)
  const severity = SEVERITIES.find((value: Severity) => value === lower(input.severity))
  const finding: ModelFinding = {
    path,
    line,
    side: lower(input.side) === "left" ? "LEFT" : "RIGHT",
    severity: severity ?? "concern",
    category: CATEGORIES.find((category: Category) => category === lower(input.category)) ?? "bug",
    title,
    body: text(input.body),
    confidence: confidence(input.confidence),
  }
  const endLine = integer(input.endLine)
  if (endLine !== undefined && endLine > line) finding.endLine = endLine
  const suggestion = cleanSuggestion(input.suggestion)
  if (suggestion !== undefined) finding.suggestion = suggestion
  const evidence = list(input.evidence)
    .flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : []))
    .slice(0, 20)
  if (evidence.length) finding.evidence = evidence
  const rule = oneLine(text(input.rule)).slice(0, 300)
  if (rule) finding.rule = rule
  const duplicateOf = text(input.duplicateOf)
  if (duplicateOf) finding.duplicateOf = duplicateOf
  if (!strict) return finding
  // An unreadable severity stays "concern" as above, so strict mode never reads it as blocking, and is marked, so S2
  // drops it as `severity-unreadable` rather than as a concern the model chose (VS-27b, [GP3]).
  if (!severity) finding.severityUnreadable = true
  const failure = decodeFailure(input.failure)
  if (failure) finding.failure = failure
  const quotes = list(input.quotes)
    .slice(0, MAX_QUOTES_READ)
    .flatMap((entry) => {
      const quote = decodeQuote(entry, path)
      return quote ? [quote] : []
    })
    .slice(0, MAX_FINDING_QUOTES)
  if (quotes.length) finding.quotes = quotes
  const patch = cleanCode(input.patch, { maxChars: MAX_SUGGESTION_CHARS })?.value
  if (patch !== undefined) finding.patch = patch
  return finding
}

// A failure needs a class and a mechanism the enums name, read in any case and with spaces or underscores for hyphens;
// anything else is no failure, which S2 drops. Trigger and impact are kept whole, even empty, for S5 to judge.
function decodeFailure(input: unknown): FailureInfo | undefined {
  if (!isRecord(input)) return undefined
  const token = (value: unknown) => lower(value).replace(/[\s_]+/g, "-")
  const failureClass = FAILURE_CLASSES.find((name) => name === token(input.class))
  const mechanism = FAILURE_MECHANISMS.find((name) => name === token(input.mechanism))
  if (!failureClass || !mechanism) return undefined
  return { class: failureClass, mechanism, trigger: oneLine(text(input.trigger)), impact: oneLine(text(input.impact)) }
}

// A quote is a claim S4 checks against the file at its exact line, so it is read strictly, unlike a finding. Its line
// is a whole number of 1 or more, or text that is only one, after an optional L: "-5", "line -5", 15.4 or 0.6 drop the
// quote rather than point it at another line. A quote with no path is the finding's file. A path that could leave the
// repository (a `..` segment, a backslash or a drive) drops it; VS-27b's S4 still checks containment against the
// tree-ish. Its code keeps its fence in a Markdown file, where a fence is file text, and its line moves past the empty
// lines the cleaning strips from the start, so the line is still the first line of the code. One with no code or over
// a cap is dropped.
function decodeQuote(input: unknown, findingPath: string): Quote | undefined {
  if (!isRecord(input)) return undefined
  const said = typeof input.line === "string" ? input.line.match(/^\s*L?(\d+)\s*$/i)?.[1] : input.line
  const line = typeof said === "string" ? Number(said) : said
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) return undefined
  const path = cleanPath(text(input.path)) || findingPath
  if (ESCAPING_PATH.test(path)) return undefined
  const code = cleanCode(input.code, {
    maxChars: MAX_QUOTE_CHARS,
    maxLines: MAX_QUOTE_LINES,
    keepFence: MARKDOWN.test(path),
  })
  if (!code) return undefined
  return { path, line: line + code.skipped, side: lower(input.side) === "left" ? "LEFT" : "RIGHT", code: code.value }
}

// Files whose text holds fenced code blocks.
const MARKDOWN = /\.(?:md|mdx|markdown|mdown|mkd|mkdn|mdc|qmd|rmd)$/i

// Models that ignore the schema sometimes answer in percent; 1 < c <= 100 is read as a percentage. A missing
// confidence becomes 0.5, which is below the default threshold, so an unrated finding is counted, not posted.
function confidence(input: unknown): number {
  const value = typeof input === "string" ? Number.parseFloat(input) : typeof input === "number" ? input : Number.NaN
  if (!Number.isFinite(value)) return 0.5
  const scaled = value > 1 && value <= 100 ? value / 100 : value
  return Math.min(1, Math.max(0, scaled))
}

function integer(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input)) return Math.round(input)
  if (typeof input !== "string") return undefined
  const match = input.match(/\d+/)
  return match ? Number(match[0]) : undefined
}

function cleanPath(path: string): string {
  return path.replace(/^(\.\/|\/)+/, "")
}

// One fence around a whole text, with its body.
const FENCED = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/

// The replacement text keeps its indentation. A fence around it and trailing blank lines are removed.
function cleanSuggestion(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  let value = input.replace(/\r\n?/g, "\n")
  const fenced = value.match(FENCED)
  if (fenced) value = fenced[2] ?? ""
  value = value.replace(/^\n+/, "").replace(/\s+$/, "")
  if (value.length > MAX_SUGGESTION_CHARS || value.split("\n").length > MAX_SUGGESTION_LINES) return undefined
  return value.trim() ? value : undefined
}

// Code copied from a file, or a patch: CRLF becomes LF, one fence around it is removed unless `keepFence`, and empty
// lines at the start and end are stripped, keeping indentation and every other space, since a patch's context lines
// need theirs. `skipped` counts the empty lines stripped from the start. Empty or over a cap, it is dropped, not cut.
// A text longer than its cap plus FENCE_ALLOWANCE is dropped before FENCED runs, since FENCED backtracks quadratically
// on a long run of backticks or tildes and only a fence or padding that long could bring it under the cap. The empty
// lines go by splitting, not by `\n+$`, which backtracks the same way on a long run of line breaks.
function cleanCode(input: unknown, limits: { maxChars: number; maxLines?: number; keepFence?: boolean }) {
  if (typeof input !== "string") return undefined
  const normalized = input.replace(/\r\n?/g, "\n")
  if (normalized.length > limits.maxChars + FENCE_ALLOWANCE) return undefined
  const lines = ((limits.keepFence ? undefined : normalized.match(FENCED)?.[2]) ?? normalized).split("\n")
  const skipped = lines.findIndex((line) => line !== "")
  const kept = lines.slice(skipped, lines.findLastIndex((line) => line !== "") + 1)
  const value = kept.join("\n")
  if (!value.trim() || value.length > limits.maxChars || kept.length > (limits.maxLines ?? Number.POSITIVE_INFINITY))
    return undefined
  return { value, skipped }
}

const FENCE_ALLOWANCE = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}
