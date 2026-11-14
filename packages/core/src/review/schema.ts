// The output schemas the reviewers answer with, and lenient decoding of what they return. The schemas use only
// conservative JSON Schema (no anyOf, no $ref, no additionalProperties: false), because providers differ in
// what they accept for a forced tool call.

import {
  CATEGORIES,
  CERTIFICATE_REACH,
  CERTIFICATE_VERDICTS,
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
  type RuleCitation,
  type RuleSource,
  type Severity,
  type VerifyCertificate,
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
// VS-43's structured rule quote (decodeRuleCitation): a longer one is dropped, never cut, as a code quote is.
export const MAX_RULE_QUOTE_CHARS = 1_000
// VS-44's certificate trace: 1 to this many quotes from the trigger to the failure, kept whole or not at all
// (decodeVerifyCertificates), as many as a finding may quote. Its guards are capped as a finding's quotes are.
export const MAX_TRACE_QUOTES = MAX_FINDING_QUOTES
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
// (the result schema's `pre-existing` drop now; the report schema's `scope` field with VS-42 wiring), VS-43 with
// ruleCheck (the structured rule) and VS-44 with verifyEvidence (its certificate schema, verifyCertJsonSchema, now; its
// drops and the result's certificate field with VS-44 wiring). Without `guardrail: "strict"` every later key is
// ignored, as the guardrail ignores it.
export type StrictSchemaKeys = Partial<Pick<ReviewConfig, "guardrail" | "scopeGate" | "verifyEvidence">>

// The report schema under `guardrail: "strict"` (VS-27a), or undefined when it is off: the legacy report schema with a
// finding's `failure`, `quotes` and `patch` added. A finding's `required` list is the legacy one, because conservative
// JSON Schema cannot say "required when blocking": S2 and S5 drop a blocking finding without them. Built from a deep copy,
// so nothing it returns shares an object with REVIEW_REPORT_JSON_SCHEMA. The quote cap is in the description, not in
// maxItems, so a provider sees only the keywords the legacy schema already sends; the decoder enforces it. VS-42's
// `scope` field joins it only with VS-42 wiring (with VS-27c), under `scopeGate: "introduced"`; until then this schema,
// and decodeReport, are the same whatever scopeGate says.
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
// review validates against the schema built for its own keys. VS-44's drops and its finding's certificate field join
// with VS-44 wiring, so until then this schema is the same whatever verifyEvidence says.
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
            // VS-42's `pre-existing` only under `scopeGate: "introduced"`, the one key that produces it.
            reason: {
              type: "string",
              enum: STRICT_DROPS.filter((reason) => reason !== "pre-existing" || keys.scopeGate === "introduced"),
            },
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

// The verify schema under `guardrail: "strict"` with `verifyEvidence: "certificate"` (VS-44), or undefined otherwise: the
// legacy verify schema with `unsure` as a verdict, and each result's certificate (`trace`, `guards`, `noGuards` and
// `reach`) added. The round-two amendment's builder form of the addendum's VERIFY_CERT_JSON_SCHEMA, built from a deep
// copy as strictReportJsonSchema is. Its `required` list is the legacy one: fixed claims are answered in the same
// results and a rejected verdict needs no trace, so certified() enforces the rest. The caps are in the descriptions,
// not in minItems or maxItems, so a provider sees only the keywords the legacy schemas already send; the decoder and
// certified() enforce them. The text is untuned (tuning waits for the held-out freeze, I-13). It enters promptsDigest
// only under both keys, and no runner sends it before VS-44 wiring (with VS-27c's blind candidate).
export function verifyCertJsonSchema(keys: StrictSchemaKeys) {
  if (keys.guardrail !== "strict" || keys.verifyEvidence !== "certificate") return undefined
  const legacy = structuredClone(VERIFY_JSON_SCHEMA)
  const result = legacy.properties.results.items
  return {
    ...legacy,
    properties: {
      ...legacy.properties,
      results: {
        ...legacy.properties.results,
        items: {
          ...result,
          properties: {
            ...result.properties,
            verdict: { ...result.properties.verdict, enum: [...CERTIFICATE_VERDICTS] },
            trace: {
              type: "array",
              description: `Required with confirmed: 1 to ${MAX_TRACE_QUOTES} quotes of the code from the trigger to the failure, in that order, each copied exactly.`,
              items: quoteSchema(),
            },
            guards: {
              type: "array",
              description: `Up to ${MAX_FINDING_QUOTES} quotes of the checks on that path that could stop the failure, each copied exactly.`,
              items: quoteSchema(),
            },
            noGuards: {
              type: "string",
              maxLength: MAX_FAILURE_TEXT_CHARS,
              description: "When guards is empty: where you looked for a guard, in one sentence.",
            },
            reach: {
              type: "string",
              enum: [...CERTIFICATE_REACH],
              description:
                "How the failing path is reached: caller-shown when the trace quotes a caller that reaches it, entry-point when the code is itself an entry point, assumed otherwise.",
            },
          },
        },
      },
    },
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
  const entries = verifyEntries(input, /^(confirm|reject)/)
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

// The results of a verify answer, or undefined when it has none: the answer when it is a list, its `results` when that
// is one, and in text the first JSON value holding such a list in which some result names a finding and a verdict that
// `verdicts` (a pattern without the g flag) accepts, so unrelated JSON cannot read as "no findings confirmed".
// decodeVerify and decodeVerifyCertificates share it and differ only in the verdicts they accept.
function verifyEntries(input: unknown, verdicts: RegExp): unknown[] | undefined {
  const value =
    typeof input === "string"
      ? extractJson(input, (candidate) => {
          const entries = isRecord(candidate) ? candidate.results : candidate
          return (
            Array.isArray(entries) &&
            entries.some((entry) => isRecord(entry) && !!text(entry.id) && verdicts.test(lower(entry.verdict)))
          )
        })
      : input
  if (Array.isArray(value)) return value
  return isRecord(value) && Array.isArray(value.results) ? value.results : undefined
}

// A verify answer under verifyCertJsonSchema (VS-44), in decodeVerify's shape, so that VS-44 wiring can pass it as the
// verify pass's decoder whenever verifyCertJsonSchema(keys) is defined; nothing calls it before then, and decodeVerify
// reads every answer as it did (the two share verifyEntries). A result needs an id and a verdict read by how it starts
// ("confirm", "reject" or "unsure"); any other verdict drops the result, so its id stays unanswered and still fails
// closed (`verdict-unreadable`). Its trace is read as strictly as a finding's quotes are (decodeQuote), and kept whole
// or not at all: an array of 1 to MAX_TRACE_QUOTES entries that all decode. A quote with a bad line, an escaping path,
// or no code or code over a cap, more than MAX_TRACE_QUOTES entries, or a trace that is not a list (one quote object,
// or a non-blank text) leaves the trace out and marks it traceUnreadable; it is never cut, since a part of a trace is
// not a path from the trigger to the failure. An absent or null trace, an empty list or a blank text is no trace, and
// is not marked. A quote with no path keeps path "", which certified() reads as the finding's file; the decoder does
// not know that file, so such a quote of a Markdown file loses a fence around it.
// Guards are the first MAX_FINDING_QUOTES that decode among the first MAX_QUOTES_READ entries, as a finding's quotes
// are. `noGuards` is one line of at most MAX_FAILURE_TEXT_CHARS code points, dropped when longer, and `reach` is read
// in any case, with spaces or underscores for hyphens; anything else leaves it out, which certified() reads as
// "assumed". Results with the same id are all kept: VS-44 wiring decides what conflicting ones mean.
export function decodeVerifyCertificates(input: unknown): VerifyCertificate[] | undefined {
  const entries = verifyEntries(input, /^(confirm|reject|unsure)/)
  if (!entries) return undefined
  return entries.flatMap((entry: unknown): VerifyCertificate[] => {
    if (!isRecord(entry)) return []
    const id = text(entry.id)
    const said = lower(entry.verdict)
    const verdict = CERTIFICATE_VERDICT_PREFIXES.find((item) => said.startsWith(item.prefix))?.verdict
    if (!id || !verdict) return []
    const noGuards = oneLine(text(entry.noGuards))
    const reach = CERTIFICATE_REACH.find((name) => name === lower(entry.reach).replace(/[\s_]+/g, "-"))
    return [
      {
        id,
        verdict,
        reason: oneLine(text(entry.reason)),
        ...decodeTrace(entry.trace),
        guards: list(entry.guards)
          .slice(0, MAX_QUOTES_READ)
          .flatMap((item) => {
            const quote = decodeQuote(item, "")
            return quote ? [quote] : []
          })
          .slice(0, MAX_FINDING_QUOTES),
        ...(noGuards && Array.from(noGuards).length <= MAX_FAILURE_TEXT_CHARS ? { noGuards } : {}),
        ...(reach ? { reach } : {}),
      },
    ]
  })
}

const CERTIFICATE_VERDICT_PREFIXES = [
  { prefix: "confirm", verdict: "confirmed" },
  { prefix: "reject", verdict: "rejected" },
  { prefix: "unsure", verdict: "unsure" },
] as const

// A certificate's trace, whole or not at all: kept when it is 1 to MAX_TRACE_QUOTES entries that all decode. Absent,
// null, an empty list or a blank text is no trace; anything else is marked unreadable, a non-empty list it cannot keep
// and a value that is not a list alike (one quote object, or a text such as "src/a.ts:3"), so a format failure is
// counted apart from a missing trace.
function decodeTrace(input: unknown): Pick<VerifyCertificate, "trace" | "traceUnreadable"> {
  if (input === undefined || input === null || (typeof input === "string" && input.trim() === "")) return {}
  if (!Array.isArray(input)) return { traceUnreadable: true }
  if (input.length === 0) return {}
  const trace =
    input.length > MAX_TRACE_QUOTES
      ? []
      : input.flatMap((entry) => {
          const quote = decodeQuote(entry, "")
          return quote ? [quote] : []
        })
  return trace.length === input.length ? { trace } : { traceUnreadable: true }
}

// Why decodeRuleCitation refused a citation: not an object (the legacy quoted text, among others), a source it cannot
// name, or a quote it cannot check. Kept apart, so a measurement can count format mismatches by kind.
export type RuleCitationProblem = "not-structured" | "source" | "quote"

// One structured rule citation (VS-43), as `{ citation } | { problem }`, the shape of privacy.ts's readZdrAttestation.
// VS-43 wiring calls it under `ruleCheck: "strict"`; decodeReport and decodeFinding do not, so `rule` stays the quoted
// text. The source is read leniently: `paths[i]` (0-based into the parsed ReviewConfig.paths) and `scoped:<path>` in
// any case and spacing, and the two block names in any case, with their tag's angle brackets and slash, and with spaces
// or hyphens for underscores. A file name ("AGENTS.md", ".vector/review.md") names no block, so it is a "source"
// problem. A scoped path keeps its case, is trimmed and loses a leading "./" or "/", and is refused when it is empty,
// holds a control character (a line break among them), or could leave the repository. The quote is text with CRLF
// folded and the ends trimmed, holding a letter or a digit, of at most MAX_RULE_QUOTE_CHARS code points (as JSON
// Schema's maxLength counts them); a longer one is refused, never cut. `lines` is a whole number of 1 or more, text
// such as "L3-L7" or "3–7", or `{ start, end }`, with 1 <= start <= end; anything else drops it, and the citation still
// decodes. Other keys are ignored.
export function decodeRuleCitation(input: unknown): { citation: RuleCitation } | { problem: RuleCitationProblem } {
  if (!isRecord(input)) return { problem: "not-structured" }
  const source = ruleSource(input.source)
  if (!source) return { problem: "source" }
  const quote = typeof input.quote === "string" ? input.quote.replace(/\r\n?/g, "\n").trim() : ""
  if (!/[\p{L}\p{N}]/u.test(quote) || Array.from(quote).length > MAX_RULE_QUOTE_CHARS) return { problem: "quote" }
  const lines = ruleLines(input.lines)
  return { citation: { source, quote, ...(lines ? { lines } : {}) } }
}

function ruleSource(input: unknown): RuleSource | undefined {
  if (typeof input !== "string") return undefined
  const said = input.trim()
  const paths = said.match(/^paths\s*\[\s*(\d+)\s*\]$/i)
  if (paths) return Number.isSafeInteger(Number(paths[1])) ? { kind: "paths", index: Number(paths[1]) } : undefined
  const scoped = said.match(/^scoped\s*:(.*)$/is)
  if (scoped) {
    const path = cleanPath(scoped[1].trim())
    return path && !/\p{Cc}/u.test(path) && !ESCAPING_PATH.test(path) ? { kind: "scoped", path } : undefined
  }
  const name = said
    .toLowerCase()
    .replace(/^<\/?|\/?>$/g, "")
    .trim()
    .replace(/[\s-]+/g, "_")
  if (name === "repository_instructions" || name === "review_rules") return { kind: name }
  return undefined
}

function ruleLines(input: unknown): RuleCitation["lines"] {
  const range = typeof input === "string" ? input.match(/^\s*L?(\d+)\s*(?:[-–]\s*L?(\d+)\s*)?$/i) : null
  const [start, end] =
    typeof input === "number"
      ? [input, input]
      : range
        ? [Number(range[1]), Number(range[2] ?? range[1])]
        : isRecord(input)
          ? [input.start, input.end]
          : []
  if (typeof start !== "number" || typeof end !== "number") return undefined
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return undefined
  return { start, end }
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
