// The canned model a projection runs against (VS-21b, ReviewEval.project): one blocking finding on the first changed
// line of every file, a security finding on the first sensitive one, and every candidate confirmed, so the review,
// security and verify passes all run and verify's prompt carries every candidate. A finalizer gets the same answer
// as its pass. It and the fake server (../lib/llm-server, TestLLMServer.loopback) are test code that VS-21c's entry
// point (packages/engine/script/vectorscope-replay.ts) imports on purpose, in its dry branch only, as the deviation log
// records (2026-11-06, VS-21c). A dry projection's safety never rests on them: ReviewEval.project refuses a run without
// the strict egress guard and checks where every model's requests would go, and the entry point fails a run whose
// guard saw a connection off this computer. The paid branch never loads either. A change here changes what a dry
// projection records, so review it as eval code.
//
// VS-21e's opt-in scenario, "suggestion-untrusted" (the entry point's --scenario), adds one finding to the review
// pass's answer: a nit carrying a suggestion, on the first added line of the first file that has one, else the first
// changed line. Run on an untrusted case under `verify: "all"`, engine:shared-verify then sends it to verify (an
// untrusted suggestion, plan.ts verifyCandidates) and the frozen engine rule does not, so the shared policy has exactly
// one more verify candidate. Without the scenario the answers are exactly the default ones.

import { Effect } from "effect"
import type { DiffFile } from "@vectordevai/core/review/diff"
import { isSensitivePath } from "@vectordevai/core/review/ignore"
import type { ModelFinding } from "@vectordevai/core/review/types"
import { ReviewEval, type WireRequest } from "../../src/review/eval"
import { reply, type Hit, type TestLLMServer } from "../lib/llm-server"

// Each pass by the opening of its prompt (core review/prompt.ts), security before review.
const PASSES = [
  ["security", "You are Vector's security reviewer"],
  ["verify", "You are checking candidate findings"],
  ["review", "You are Vector's code reviewer"],
] as const

// The canned scenarios a projection can opt into (VS-21e); the entry point's --scenario takes these names.
export type ProjectionScenario = "suggestion-untrusted"
export const PROJECTION_SCENARIOS: readonly ProjectionScenario[] = ["suggestion-untrusted"]

export function projectionFindings(files: readonly DiffFile[], scenario?: ProjectionScenario) {
  const review = files.flatMap((file) => {
    const at = firstChange(file)
    return at ? [finding(file.path, at, "bug", `Projected finding in ${file.path}`)] : []
  })
  const sensitive = files.find((file) => isSensitivePath(file.path)) ?? files[0]
  const at = sensitive && firstChange(sensitive)
  const security =
    sensitive && at ? [finding(sensitive.path, at, "security", `Projected security finding in ${sensitive.path}`)] : []
  if (scenario !== "suggestion-untrusted") return { review, security }
  const suggested =
    files.find((file) => firstChange(file)?.side === "RIGHT") ?? files.find((file) => firstChange(file) !== undefined)
  const where = suggested && firstChange(suggested)
  if (!suggested || !where) return { review, security }
  return {
    review: [
      ...review,
      {
        ...finding(suggested.path, where, "style", `Projected suggestion in ${suggested.path}`),
        severity: "nit" as const,
        suggestion: "// projected suggestion",
      },
    ],
    security,
  }
}

// The answer to each request: the pass comes from the session's first user message, which is its prompt.
export function projectionReplies(input: { files: readonly DiffFile[]; scenario?: ProjectionScenario }) {
  const found = projectionFindings(input.files, input.scenario)
  return (hit: Hit) => {
    const prompt = firstUserText(hit.body)
    const pass = PASSES.find(([, opening]) => prompt.includes(opening))?.[0]
    if (!pass) return undefined
    const answer =
      pass === "verify"
        ? { results: projectionVerdicts(prompt) }
        : {
            summary: `Projected ${pass} report.`,
            risk: "medium",
            files: input.files.map((file) => ({ path: file.path, note: "Projected note." })),
            findings: found[pass],
          }
    return reply()
      .tool("StructuredOutput", answer)
      .usage({
        input: Math.ceil(hit.text.length / ReviewEval.CHARS_PER_TOKEN),
        output: Math.ceil(JSON.stringify(answer).length / ReviewEval.CHARS_PER_TOKEN),
      })
  }
}

// Verify's answer: every candidate and fixed claim its prompt names, confirmed. It reads the decoded prompt, where the
// ids are quoted as `id="…"`; in the raw JSON body the quotes are escaped.
export function projectionVerdicts(prompt: string) {
  return [...prompt.matchAll(/<untrusted_(?:candidate|fixed_claim) id="([^"]+)"/g)].map((match) => ({
    id: match[1] ?? "",
    verdict: "confirmed" as const,
    reason: "Confirmed by the projection's canned model.",
  }))
}

// The loopback provider's log as a projection reads it: each request's session header and raw body.
export const received = (llm: TestLLMServer["Service"]) =>
  llm.hits.pipe(
    Effect.map((hits) =>
      hits.map(
        (hit): WireRequest => ({
          ...(hit.session ? { sessionID: hit.session } : {}),
          path: hit.url.pathname,
          body: hit.text,
        }),
      ),
    ),
  )

// The first user message's text, for the chat completions (`messages`) and responses (`input`) protocols alike.
export function firstUserText(body: Record<string, unknown>) {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
  const user = messages.find((message) => isRecord(message) && message.role === "user")
  const content = isRecord(user) ? user.content : undefined
  if (typeof content === "string") return content
  const parts: unknown[] = Array.isArray(content) ? content : []
  return parts.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n")
}

// The first changed line: the first added one, on the new side, or else the first deleted one, on the old side.
function firstChange(file: DiffFile) {
  const lines = file.hunks.flatMap((hunk) => hunk.lines)
  const added = lines.find((line) => line.kind === "add" && line.newLine !== undefined)?.newLine
  if (added !== undefined) return { line: added, side: "RIGHT" as const }
  const deleted = lines.find((line) => line.kind === "del" && line.oldLine !== undefined)?.oldLine
  if (deleted !== undefined) return { line: deleted, side: "LEFT" as const }
  return undefined
}

function finding(
  path: string,
  at: { line: number; side: "RIGHT" | "LEFT" },
  category: ModelFinding["category"],
  title: string,
): ModelFinding {
  return {
    path,
    line: at.line,
    side: at.side,
    severity: "blocking",
    category,
    title,
    body: "A canned finding from the projection's fake model.",
    confidence: 0.9,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
