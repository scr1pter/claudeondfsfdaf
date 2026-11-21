// Strict review consumes only verified model verdicts and private committed evidence. None of these
// transformations are used by a review on the default policy.
import { Effect } from "effect"
import { applyFixPatch, buildAnchorIndex, lookupFile } from "@vectordevai/core/review/diff"
import { holdbackText } from "@vectordevai/core/review/holdback"
import { unfinishedCauses } from "@vectordevai/core/review/verdict"
import { strictFindingBody } from "@vectordevai/core/review/format"
import {
  MAX_FIX_HUNKS,
  strictBlobRequests,
  strictSelect,
  strictIncomplete,
  type StrictBlobs,
  type StrictInput,
} from "@vectordevai/core/review/guardrail"
import { decodeVerify, extractJson, type VerifyResult } from "@vectordevai/core/review/schema"
import type { Finding, StrictFinding } from "@vectordevai/core/review/types"
import { ReviewParse } from "./parse"
import { ReviewStrictBlobs } from "./strict-blobs"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Check each decoded value with multiline boundaries intact. A model can introduce a secret-shaped string
// of its own, including in a new evidence quote; it cannot relay that value to the verifier or the replay.
export function containsHeldValue(value: unknown): boolean {
  if (typeof value === "string") return holdbackText(value) !== value
  if (Array.isArray(value)) return value.some(containsHeldValue)
  return record(value) && Object.values(value).some(containsHeldValue)
}

// The legacy verifier accepts prose and verdict prefixes. Strict verification requires a single exact,
// schema-shaped answer for an id. A duplicate cannot override an unreadable or conflicting earlier row.
export function decodeStrictVerify(value: unknown): VerifyResult[] | undefined {
  const body =
    typeof value === "string" ? extractJson(value, (entry) => record(entry) && Array.isArray(entry.results)) : value
  if (!record(body) || !Array.isArray(body.results)) return undefined
  const rows = new Map<string, VerifyResult | undefined>()
  for (const row of body.results) {
    if (!record(row) || typeof row.id !== "string") continue
    const id = row.id.trim()
    const valid =
      id.length > 0 &&
      id === row.id &&
      !rows.has(id) &&
      (row.verdict === "confirmed" || row.verdict === "rejected") &&
      typeof row.reason === "string"
    rows.set(id, valid ? decodeVerify({ results: [row] })?.[0] : undefined)
  }
  return [...rows.values()].filter((row) => row !== undefined)
}

export const checkStrict = Effect.fn("Review.checkStrict")(function* (
  input: Omit<StrictInput, "blobs" | "parses"> & {
    findings: Finding[]
    directory: string
    changePaths: string[]
    pending: string[]
    base: string
    uncommitted: boolean
    denied: (file: string) => boolean
    holdback?: "secrets"
    signal?: AbortSignal
    deadline: number
    judge?: { model: string; answered: ReadonlySet<string> }
  },
) {
  const requests = strictBlobRequests(
    input.findings.filter((finding) => finding.verified === true),
    input.anchors,
    input.config,
  )
  const blobs: StrictBlobs = input.uncommitted
    ? { head: new Map(), base: new Map() }
    : yield* ReviewStrictBlobs.read({
        directory: input.directory,
        base: input.base,
        head: input.head,
        requests,
        denied: input.denied,
        budgetMs: Math.max(0, input.deadline - Date.now()),
        ...(input.holdback ? { holdback: input.holdback } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
  // strictSelect is synchronous. Precompute parser results for the precise patch text it tests, once
  // per unique version. An unavailable parser on a supported language cannot authorize a committable patch.
  const index = buildAnchorIndex(input.anchors)
  const parsed = new Map<string, Map<string, boolean>>()
  const time = performance.now() + Math.max(0, input.deadline - Date.now())
  for (const finding of input.findings) {
    if (!finding.verified || finding.severity !== "blocking" || !finding.patch || !finding.failure) continue
    const file = lookupFile(index, finding.path)?.file.path
    if (!file || !ReviewParse.languageOf(file)) continue
    const head = blobs.head.get(file)
    if (typeof head !== "string") continue
    const applied = applyFixPatch(head, finding.patch, { path: file, maxHunks: MAX_FIX_HUNKS })
    if (!applied.ok) continue
    const versions = parsed.get(file) ?? new Map<string, boolean>()
    parsed.set(file, versions)
    for (const text of [head, applied.text]) {
      if (versions.has(text) || input.signal?.aborted || performance.now() >= time) continue
      const result = yield* ReviewParse.parse({ path: file, text, deadline: time })
      if (result.parsed) versions.set(text, !result.hasError)
    }
  }
  const strict = strictSelect(input.findings, {
    ...input,
    blobs,
    parses: (file, text) => {
      if (!ReviewParse.languageOf(file)) return undefined
      const result = parsed.get(file)?.get(text)
      if (result === undefined) throw new Error("The patch could not be parsed.")
      return result
    },
  })
  for (const kept of strict.findings) if (input.judge?.answered.has(kept.id)) kept.verifier = input.judge.model
  const retry = new Set(input.coverage.unreviewed)
  if (!strict.complete) {
    for (const path of input.pending) retry.add(path)
    if (strict.incomplete?.includes("blob-unreadable")) {
      // A missing auxiliary quote need not invalidate a finding with another matching quote.
      // Only affected findings still outside the retained result are candidates for another pass.
      const retained = new Set(strict.findings.map((finding) => finding.id))
      for (const finding of input.findings) {
        if (!finding.verified || retained.has(finding.id)) continue
        const keys = strictBlobRequests([finding], input.anchors, input.config)
        if (
          keys.head.some((key) => blobs.head.get(key) == null) ||
          keys.base.some((key) => blobs.base.get(key) == null)
        )
          retry.add(finding.path)
      }
    }
    for (const file of input.coverage.skipped) {
      const single = {
        ...input.coverage,
        partial: undefined,
        unreviewed: [],
        skipped: [file],
        held: input.coverage.held?.filter((other) => other.path === file.path),
        specialists: [{ name: "review" as const, status: "ok" as const }],
      }
      if (file.path && unfinishedCauses(single).length) retry.add(file.path)
    }
    if (!retry.size) for (const path of input.changePaths) retry.add(path)
    if (retry.size)
      strict.incomplete = strictIncomplete(
        { ...input.coverage, unreviewed: [...retry] },
        {
          verdict: strict.incomplete?.includes("verdict-unreadable") === true,
          blob: strict.incomplete?.includes("blob-unreadable") === true,
        },
      )
  }
  return { result: strict, listed: postableStrict(strict.findings, input.findings), unreviewed: [...retry] }
})

function postableStrict(accepted: readonly StrictFinding[], candidates: readonly Finding[]): Finding[] {
  return accepted.flatMap((kept) => {
    const original = candidates.find(
      (finding) =>
        finding.verified === true &&
        finding.id === kept.id &&
        finding.path === kept.path &&
        finding.line === kept.line &&
        finding.side === kept.side,
    )
    if (!original) return []
    return [
      {
        id: kept.id,
        path: kept.path,
        line: kept.line,
        ...(kept.endLine ? { endLine: kept.endLine } : {}),
        side: kept.side,
        source: original.source,
        severity: "blocking" as const,
        category: original.category,
        confidence: original.confidence,
        title: kept.title,
        verified: true,
        failure: { class: kept.class, mechanism: kept.mechanism, trigger: kept.trigger, impact: kept.impact },
        quotes: kept.quotes,
        verifiedBy: kept.verifiedBy,
        body: strictFindingBody(kept),
        ...(kept.fix.kind === "suggestion" ? { suggestion: kept.fix.text } : {}),
        ...(kept.fix.kind === "patch" ? { patch: kept.fix.text } : {}),
      },
    ]
  })
}
