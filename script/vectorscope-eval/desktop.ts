import { createHash } from "node:crypto"
import {
  buildDesktopReview,
  modelName,
  runReview,
  type LineComment,
  type ReviewClient,
  type ReviewModel,
  type ReviewOutcomeLite,
} from "../../packages/app/src/features/pull-requests/ai-review"
import { parseReviewConfig, REVIEW_CONFIG_PATH } from "../../packages/core/src/review/config"
import { parseUnifiedDiff } from "../../packages/core/src/review/diff"
import { VARIANT_KEYS } from "../../packages/core/src/review/eval"
import { evidenceScope, type EvidenceScope } from "../../packages/core/src/review/model-evidence"
import type { ReviewPrice } from "../../packages/core/src/review/plan"
import { REVIEW_REPORT_JSON_SCHEMA, VERIFY_JSON_SCHEMA } from "../../packages/core/src/review/schema"
import type { CostKind, ReviewConfig, Trust } from "../../packages/core/src/review/types"
import type { PlacedRecord, VariantRecord } from "../../packages/engine/src/review/eval"
import { untrustedGitEnv, UNTRUSTED_GIT } from "./dataset"
import type { PlannedReplay } from "./replay"

// The desktop baseline (VectorScope plan, VS-02; Phase 0 "Runner and baselines"): one dataset case through the desktop
// runner, runReview in packages/app/src/features/pull-requests/ai-review.ts, which reviews through an injected client.
// The client here records every session and prompt the runner makes and hands each to the client it wraps: a fake in
// tests, and later an SDK client on an engine server whose instance is the case's prepared checkout. The artifact has
// the engine replay's shape where the runners overlap (placed findings, attempts, prompt digests), so the two can be
// compared case by case.
//
// Nothing is posted: the desktop posts only when its user presses Post, so the artifact keeps the review the panel would
// send, before the desktop's posting check. A paid desktop replay is not wired: it needs an engine server and the eval
// ledger's admission (VS-03), and runs only in the protected vectorscope-eval environment (D5, D7).

export interface DesktopAttempt {
  seq: number
  pass: string // the session's internal name: vectorscope.review, vectorscope.security, vectorscope.verify
  agent?: string
  model?: string
  format: "report" | "verify" | "other"
  digest: string // SHA-256 of the prompt's text
  chars: number
  answered: boolean
  costUsd?: number
  unpriced?: boolean
  tokens?: { input: number; output: number }
  error?: string
  // When the prompt call started, after the first prompt of the replay, and how long it took to answer or fail, in
  // milliseconds (VS-21c). Absent in an artifact written before them.
  startMs?: number
  ms?: number
}

export interface DesktopArtifact {
  version: 1
  label: string
  adapter: "desktop"
  repetition: number
  runtime: { node: string; bun?: string; platform: string; arch: string }
  source: { repository?: string; base: string; head: string; vector?: string; manifest?: string }
  trust?: Trust // how the runner treated the checkout: untrusted when it rebuilt the change from the diff
  authored?: Trust
  models: { review: { id: string; context?: number; costKind: CostKind; price?: ReviewPrice } }
  // What a model certificate (core model-evidence.ts, VS-07) made from this replay would cover: the desktop runner,
  // the pipeline revision, prompts, the review settings the runner read and the triage model it ran with.
  scope: EvidenceScope
  sessions: { pass: string; title: string; permission: string }[] // permission is a digest of the session's rules
  passes: { pass: string; model?: string; digest: string; chars: number; startMs?: number; ms?: number }[]
  attempts: DesktopAttempt[]
  aborted: string[] // passes the runner aborted (a timeout or a stop)
  outcome?: ReviewOutcomeLite // absent when there was nothing to review or the runner failed
  placed: PlacedRecord[]
  // What the panel's Post button would send, which is never sent here.
  proposed?: { body: string; comments: LineComment[]; untrusted: boolean }
  // The pipeline variant replayed (VS-21a), and whether it reached the runner. It did not when the change itself
  // edits review.json, which the runner then never reads its settings from, or when the variant sets nothing the
  // desktop runner applies (VARIANT_KEYS.desktop); either case ran the frozen pipeline and cannot be compared.
  variant?: VariantRecord & { applied: boolean }
  error?: string // why runReview failed, when it threw
}

export interface DesktopReplayInput {
  planned: PlannedReplay
  directory: string // the case's prepared checkout, at its base: the engine instance the client reviews in
  diff: string // the candidate's unified diff, base..head
  model: ReviewModel
  client: ReviewClient
  repetition?: number
  source?: { vector?: string; manifest?: string }
  timeoutMs?: number
  now?: () => number
  // The pipeline variant, a registry name and its keys (resolveVariant in replay.ts), as the engine replay's `variant`
  // takes it. Its keys are read as a repository that chose them would set them.
  variant?: Pick<VariantRecord, "name" | "keys">
}

// Replays one case through the desktop runner as a pull request from someone else's fork: untrusted, with no viewer,
// so the runner rebuilds the change from the diff and never trusts the checkout. The pull request's number, title and
// body are neutral; the case's id names the artifact only and never reaches the runner.
export async function desktopReplay(input: DesktopReplayInput): Promise<DesktopArtifact> {
  const item = input.planned.case
  const recording = recordingClient(input.client, input.now)
  const variant = input.variant
  // The runner never takes settings from a review.json the pull request changes (runReview's setting()), and then reads
  // that file only as a changed file. So a case whose change touches it gets no variant and keeps its own text, and
  // its settings are the defaults. A variant whose keys the desktop runner does not all apply is not handed over
  // either, so the run is the frozen pipeline's. The artifact says the variant was not applied.
  const touched = changesFile(input.diff, REVIEW_CONFIG_PATH)
  const settings =
    variant && !touched && appliable(variant.keys) ? withReviewSettings(recording.client, variant.keys) : undefined
  const read = settingsReader(settings?.client ?? recording.client, { ignore: touched })
  const repository = item.repository?.url
  const pr = {
    number: 1,
    title: "Proposed change",
    body: "",
    author: "contributor",
    url: repository ? `${repository}/pull/1` : "https://github.com/replay/replay/pull/1",
    baseRefName: item.baseRef ?? "base",
    headRefName: "candidate",
    headRefOid: item.head,
    baseRefOid: item.base,
    isCrossRepository: true,
  }
  const outcome = await runReview(
    {
      directory: input.directory,
      pr,
      diff: input.diff,
      catalog: [input.model],
      preferredModels: [modelName(input.model)],
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.now ? { now: input.now } : {}),
    },
    read.client,
  ).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  const done = outcome instanceof Error ? undefined : outcome
  const posting = done ? buildDesktopReview(done, pr.url) : undefined
  // The settings as the runner parses them: what it read of review.json, or the defaults when it read none.
  const json = read.text()
  const { config } = parseReviewConfig({ json: json?.trim() ? json : undefined, trigger: "desktop" })
  return {
    version: 1,
    label: item.label,
    adapter: "desktop",
    repetition: input.repetition ?? 1,
    runtime: {
      node: process.version,
      ...(process.versions.bun ? { bun: process.versions.bun } : {}),
      platform: process.platform,
      arch: process.arch,
    },
    source: {
      ...(repository ? { repository } : {}),
      base: item.base,
      head: item.head,
      ...input.source,
    },
    ...(done ? { trust: done.checkout.trust, ...(done.authored ? { authored: done.authored } : {}) } : {}),
    models: {
      review: {
        id: modelName(input.model),
        ...(input.model.context ? { context: input.model.context } : {}),
        costKind: input.model.costKind,
        ...(input.model.price ? { price: input.model.price } : {}),
      },
    },
    scope: evidenceScope({ adapter: "desktop", config, ...(done?.triage ? { triage: done.triage } : {}) }),
    sessions: recording.sessions,
    passes: recording.attempts.map((attempt) => ({
      pass: attempt.pass,
      ...(attempt.model ? { model: attempt.model } : {}),
      digest: attempt.digest,
      chars: attempt.chars,
      ...(attempt.startMs !== undefined ? { startMs: attempt.startMs } : {}),
      ...(attempt.ms !== undefined ? { ms: attempt.ms } : {}),
    })),
    attempts: recording.attempts,
    aborted: recording.aborted,
    ...(done ? { outcome: done } : {}),
    placed: (done?.selection.inline ?? []).map((finding) => ({
      id: finding.id,
      path: finding.anchor.path,
      line: finding.anchor.line,
      ...(finding.anchor.startLine !== undefined ? { startLine: finding.anchor.startLine } : {}),
      side: finding.anchor.side,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      source: finding.source,
      verified: finding.verified === true,
    })),
    ...(posting ? { proposed: { body: posting.body, comments: posting.comments, untrusted: posting.untrusted } } : {}),
    ...(variant ? { variant: { name: variant.name, keys: variant.keys, applied: settings?.served() ?? false } } : {}),
    ...(outcome instanceof Error ? { error: outcome.message } : {}),
  }
}

// A client that answers the runner's settings read of the case's review.json with these keys set over the file's own,
// as a repository that chose them would have it, and passes every other call through. The file's other keys, "verify"
// among them, stay, as in the engine replay, where the variant's policy arrives as REVIEW_VERIFY_POLICY and the base's
// "verify" still wins. A file that is not a JSON object reads as one holding only these keys, which leaves the same
// settings as the engine's parser does with the defaults. Only the first read is the settings read: the runner makes
// it before it reads any changed file, so a later read (a finding that names the file) gets the file as it is.
// served() says whether the runner read its settings. Use it only for a case whose change leaves the file alone.
export function withReviewSettings(inner: ReviewClient, keys: Record<string, unknown>) {
  let served = false
  const client: ReviewClient = {
    ...inner,
    file: {
      ...inner.file,
      read: async (request) => {
        if (request.path !== REVIEW_CONFIG_PATH || served) return inner.file.read(request)
        served = true
        const result = await inner.file.read(request).catch(() => undefined)
        const text = result?.data?.type === "text" ? result.data.content : ""
        return { data: { type: "text", content: JSON.stringify({ ...jsonObject(text), ...keys }) } }
      },
    },
  }
  return { client, served: () => served }
}

// A client that passes every call through and keeps the text of the runner's settings read of review.json, its first
// read of that file. With `ignore`, for a case whose change touches the file, it keeps none: the runner then reads the
// file only as a changed file and runs under the defaults.
function settingsReader(inner: ReviewClient, options: { ignore?: boolean } = {}) {
  let text: string | undefined
  let seen = false
  const client: ReviewClient = {
    ...inner,
    file: {
      ...inner.file,
      read: async (request) => {
        const result = await inner.file.read(request)
        if (request.path === REVIEW_CONFIG_PATH && !seen && !options.ignore) {
          seen = true
          text = result?.data?.type === "text" ? result.data.content : undefined
        }
        return result
      },
    },
  }
  return { client, text: () => text }
}

// Whether the desktop runner applies every one of these keys: at least one, each with a value, all in
// VARIANT_KEYS.desktop. A key it does not apply would leave the run the frozen pipeline's under the variant's name.
function appliable(keys: Partial<ReviewConfig>) {
  const allowed: readonly string[] = VARIANT_KEYS.desktop
  const entries = Object.entries(keys)
  return entries.length > 0 && entries.every(([key, value]) => value !== undefined && allowed.includes(key))
}

// Whether a unified diff changes this path, at either end of a rename, compared without case as the runner does.
function changesFile(diff: string, path: string) {
  const wanted = path.toLowerCase()
  return parseUnifiedDiff(diff).some((file) =>
    [file.path, file.oldPath ?? file.path].some((name) => name.toLowerCase() === wanted),
  )
}

function jsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text.replace(/^﻿/, ""))
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// A client that passes every call through and keeps a record of the sessions, prompts and aborts, with each prompt
// call's start after the first one's and its duration, on `now`'s clock.
export function recordingClient(inner: ReviewClient, now: () => number = Date.now) {
  const sessions: DesktopArtifact["sessions"] = []
  const attempts: DesktopAttempt[] = []
  const aborted: string[] = []
  const passOf = new Map<string, string>()
  const clock: { first?: number } = {}
  const client: ReviewClient = {
    ...inner,
    session: {
      ...inner.session,
      create: async (request) => {
        const result = await inner.session.create(request)
        const pass = request.internal ?? "session"
        if (result.data?.id) passOf.set(result.data.id, pass)
        sessions.push({ pass, title: request.title ?? "", permission: digest(request.permission ?? []) })
        return result
      },
      prompt: async (request) => {
        const text = (request.parts ?? []).map((part) => part.text).join("\n")
        const started = now()
        clock.first ??= started
        const attempt: DesktopAttempt = {
          seq: attempts.length + 1,
          pass: passOf.get(request.sessionID) ?? "unknown",
          ...(request.agent ? { agent: request.agent } : {}),
          ...(request.model ? { model: `${request.model.providerID}/${request.model.modelID}` } : {}),
          format:
            request.format?.schema === REVIEW_REPORT_JSON_SCHEMA
              ? "report"
              : request.format?.schema === VERIFY_JSON_SCHEMA
                ? "verify"
                : "other",
          digest: digest(text),
          chars: text.length,
          answered: false,
          startMs: started - clock.first,
        }
        attempts.push(attempt)
        const result = await inner.session.prompt(request).catch((error: unknown) => {
          attempt.error = error instanceof Error ? error.message : String(error)
          attempt.ms = now() - started
          throw error
        })
        attempt.ms = now() - started
        const info = result.data?.info
        attempt.answered = !!result.data
        if (info?.cost !== undefined) attempt.costUsd = info.cost
        if (info?.unpriced) attempt.unpriced = true
        if (info?.tokens) attempt.tokens = { input: info.tokens.input, output: info.tokens.output }
        if (info?.error) attempt.error = typeof info.error === "string" ? info.error : JSON.stringify(info.error)
        return result
      },
      abort: async (request) => {
        aborted.push(passOf.get(request.sessionID) ?? "unknown")
        return inner.session.abort(request)
      },
    },
  }
  return { client, sessions, attempts, aborted }
}

// The candidate's diff from a prepared checkout, with local git only and none of the user's git config.
export function candidateDiff(directory: string, view: { base: string; head: string }) {
  const result = Bun.spawnSync(
    [
      "git",
      ...UNTRUSTED_GIT,
      "-C",
      directory,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
      view.base,
      view.head,
    ],
    { env: untrustedGitEnv(), stdout: "pipe", stderr: "pipe" },
  )
  if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

function digest(value: unknown) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, entry: unknown) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? Object.fromEntries(Object.entries(entry).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : entry,
        )
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex")
}
