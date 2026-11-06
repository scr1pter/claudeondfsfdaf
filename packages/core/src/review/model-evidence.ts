// Model evidence (VectorScope plan, VS-07): what VectorScope's own evaluation says about the model a review runs on.
// Pure and browser-safe: the engine runner, the desktop panel and the eval tooling all use it.
//
// A certificate ties one exact "provider/model" to the eval that passed the D2 release gate on it: the report, the
// frozen dataset manifest, the gate, the runners it replayed, and digests of the prompts, the review settings and the
// pipeline revision it ran under. It expires on a fixed date, and it applies only while every one of those is
// unchanged. MODEL_EVIDENCE holds the certificates the owner approved. It is empty: no model has passed a held-out
// run (D5, D12), so every model is unvetted.
//
// The assessment warns; it never chooses. Nothing here picks, refuses or replaces a model, and a free model or one
// whose provider does not train on prompts is not thereby evaluated. The notes say why a model was used and that Vector
// keeps the one chosen. They are shown only behind the off-by-default `modelEvidence: "warn"` setting (D3).

import { openRouterModelRouting } from "../free-model-catalog"
import { FREE_MODEL_TRAINING_LABEL, freeModelMayTrain, type FreeModelChoice } from "../free-model-choice"
import { sameModel } from "./eval"
import type { Report } from "./eval-report"
import { fnv1a64 } from "./fingerprint"
import { codeSpan } from "./format"
import {
  buildFinalizePrompt,
  buildReviewPrompt,
  buildSecurityPrompt,
  buildVerifyPrompt,
  ownerBlock,
  type PromptInput,
  type VerifyPromptInput,
} from "./prompt"
import { REVIEW_REPORT_JSON_SCHEMA, VERIFY_JSON_SCHEMA } from "./schema"
import type { Finding, PriorFinding, ReviewConfig } from "./types"

// Bump when a change to the review pipeline changes what a review finds or posts: either runner (engine review/run.ts,
// the desktop's ai-review.ts), the core code they share for planning, packing, selection and anchoring, the route rules
// (privacy.ts), or the review and security agents' own prompts. Every certificate made before it then stops applying.
// promptsDigest catches a change to the text of the core prompts and output schemas without a bump, since it renders
// every section a prompt can have; it cannot see a runner filling those inputs differently or a change to the prompts'
// length limits.
export const REVIEW_PIPELINE_REVISION = 1

// A digest of the pipeline's sources (REVIEW_PIPELINE_FILES in core test/review/model-evidence.test.ts), which that
// test pins, so CI fails when one of them changes and nobody decided whether REVIEW_PIPELINE_REVISION goes up. When it
// fails: bump the revision if the change alters what a review finds or posts, then set this to the digest it prints.
export const REVIEW_PIPELINE_SOURCES = "7addfcd0033ba579"

// The longest a certificate may run from its approval. The plan asks for an expiry and sets none; a hosted model can
// change underneath its id, so the evidence is re-earned on this cadence.
export const MAX_CERTIFICATE_DAYS = 90

// The review settings that change what a review finds or posts. A certificate covers reviews under exactly these.
// Budgets, time limits, ignores and skips bound or route a review but are not part of what it is evaluated on.
export const EVIDENCE_POLICY_KEYS = [
  "security",
  "verify",
  "verifyPolicy",
  "minSeverity",
  "minConfidence",
  "nits",
  "suggestions",
  "maxComments",
  "maxSteps",
  "maxDiffChars",
] as const satisfies readonly (keyof ReviewConfig)[]

export type EvidenceAdapter = "engine" | "desktop"
const ADAPTERS: readonly EvidenceAdapter[] = ["engine", "desktop"]

// What a review ran under, as far as evidence goes. A replay artifact records the scope it was made in, and a review
// compares its own with a certificate's.
export interface EvidenceScope {
  adapter: EvidenceAdapter
  pipeline: number // REVIEW_PIPELINE_REVISION
  prompts: string // promptsDigest()
  policy: string // policyDigest(config)
  triage?: string // the cheaper first pass's "provider/model", when the review had one
  // "zdr" only when a runner enforced the route rules (privacy.ts) for the whole review: VS-23b and VS-23c set it.
  // Absent otherwise, so every scope and certificate made before VS-23 still matches.
  route?: "zdr"
}

export interface ModelCertificate {
  version: 1
  id: string
  model: string // the exact "provider/model" evaluated; another route or provider to the same model is another model
  variant?: string
  triage?: string // the triage model the evaluated pipeline ran with
  route?: "zdr" // the evaluated pipeline ran on zero data retention routes only (EvidenceScope.route)
  adapters: EvidenceAdapter[] // the runners the eval replayed
  pipeline: number
  prompts: string
  policy: string
  evaluation: {
    report: string // "sha256:<hex>" of the report file the gate decided on
    manifest: string // the frozen held-out manifest's "sha256:<hex>" freeze digest
    split: string // the gate's split, "held-out"
    decision: string // the gate decision, such as "D2"
    gate: string // the gate config's digest
    collected: string // YYYY-MM-DD the results were collected
    vector?: string // the Vector commit the eval ran
  }
  approved: { by: "owner"; date: string } // D12: the owner reviews the result before it applies
  expires: string // YYYY-MM-DD: the certificate covers reviews before this date
}

// The certificates the owner approved. None: no model has passed a held-out run.
export const MODEL_EVIDENCE: readonly ModelCertificate[] = []

// What a surface knows about the model a review uses. Built by the engine's resolver and by the desktop's catalog.
export interface ModelSubject {
  model: string // "provider/model"
  variant?: string
  free: boolean
  // A free model's source and data policy, from Vector's reviewed record; freeModelMayTrain reads it, as everywhere.
  freeModel?: FreeModelChoice["freeModel"]
  status?: string // the catalog's status; "deprecated" is retired
  // Why this model: a setting named it (explicit), or Vector fell back to a default, which `setting` describes, such as
  // "your default model". `unset` says what was missing, when "no review model is set" would not be accurate, such as
  // "no model is set in .vector/review.json" on the desktop, whose agent's model may be one the person chose. Absent
  // when the caller does not know.
  choice?: { explicit: boolean; setting: string; unset?: string }
}

export type EvidenceStatus = "certified" | "unvetted" | "expired" | "stale" | "retired" | "rerouted"
export type ScopeChange = "adapter" | "pipeline" | "prompts" | "policy" | "triage" | "variant" | "route"

export interface ModelEvidence {
  role: "review" | "triage"
  subject: ModelSubject
  status: EvidenceStatus
  certificate?: string // the certificate the status is about
  expires?: string // for "expired"
  changed?: ScopeChange[] // for "stale": what differs from the certificate
  // For "rerouted": the model is a router or preset, a certificate is of the same model through another provider or
  // route (`evaluated`), or replies came from models the review did not choose.
  rerouted?: "router" | "route" | "served"
  evaluated?: string
  mayTrain: boolean
}

export interface ReviewEvidence {
  models: ModelEvidence[] // the review model, then the triage model
  unexpected: string[] // models replies came from that the review did not choose
}

// ---------------------------------------------------------------------------------------------------------------
// Scope

const CANONICAL_FINDING: Finding = {
  id: "000000000000",
  path: "src/example.ts",
  line: 1,
  side: "RIGHT",
  source: "review",
  severity: "blocking",
  category: "bug",
  title: "Example",
  body: "Example.",
  suggestion: "example",
  confidence: 1,
}

const CANONICAL_INPUT: PromptInput = {
  mode: "full",
  trust: "trusted",
  base: "0".repeat(40),
  head: "1".repeat(40),
  diff: "",
  maxComments: 10,
}

const CANONICAL_PRIOR: PriorFinding = {
  id: "111111111111",
  where: "inline",
  path: "src/example.ts",
  line: 1,
  side: "RIGHT",
  severity: "concern",
  category: "bug",
  title: "Example",
  sha: "1".repeat(40),
  status: "open",
}

// Every optional input set, so every section a prompt renders only when it has something to show is in the digest:
// the pull request's title, body and commits, open findings, the diff and the files left out of it, annotated and
// exact head files, related code, CI checks, linked requirements, history, comments, the team's dismissals, the
// repository's instructions and review rules, and an incremental review's focus and settled files.
const POPULATED_INPUT: PromptInput = {
  ...CANONICAL_INPUT,
  baseRef: "main",
  pr: { number: 1, title: "Example", body: "Example.", author: "example", commits: ["Example"] },
  diff: "diff --git a/src/example.ts b/src/example.ts",
  notInlined: [{ path: "src/other.ts", additions: 1, deletions: 1 }],
  focus: [{ path: "src/example.ts", start: 1, end: 2 }],
  headFiles: [
    { path: "src/example.ts", text: "example", exact: true },
    { path: "src/annotated.ts", text: "1 + example", exact: true, annotated: true },
  ],
  related: [
    { symbol: "example", path: "src/example.ts", hits: [{ path: "src/caller.ts", line: 1, text: "example()" }] },
  ],
  history: [{ path: "src/example.ts", text: "1111111 Example" }],
  requirements: "[R1] Example.",
  instructions: "Example.",
  checks: [
    { name: "test", conclusion: "failure", excerpt: "Example." },
    { name: "lint", conclusion: "" },
  ],
  rules: "Example.",
  teamDismissed: [
    { category: "style", dir: "", words: ["example"] },
    { category: "bug", dir: "src", words: ["example"] },
  ],
  humanComments: [{ author: "example", association: "MEMBER", path: "src/example.ts", line: 1, body: "Example." }],
  prior: [CANONICAL_PRIOR],
  settled: ["src/settled.ts"],
}

const POPULATED_VERIFY: Omit<VerifyPromptInput, "trust"> = {
  head: CANONICAL_INPUT.head,
  uncommitted: true,
  candidates: [CANONICAL_FINDING],
  fixed: [{ ...CANONICAL_PRIOR, reason: "Example." }],
  headFiles: POPULATED_INPUT.headFiles,
}

// The prompts promptsDigest is built from, for its test: for trusted and untrusted reviews, the review and security
// prompts bare and with every input set (full and incremental, with and without nits, a commit and uncommitted
// changes), the verify prompt bare and with every input set, the finalizer and the owner's memory block.
export function canonicalPrompts(): string[] {
  return [
    ...(["trusted", "untrusted"] as const).flatMap((trust) => {
      const headFiles = trust === "untrusted" ? [{ path: "src/example.ts", text: "", exact: true }] : undefined
      const inputs: PromptInput[] = [
        { ...CANONICAL_INPUT, trust, ...(headFiles ? { headFiles } : {}) },
        { ...CANONICAL_INPUT, trust, mode: "incremental", since: "2".repeat(40) },
        { ...POPULATED_INPUT, trust, nits: true },
        { ...POPULATED_INPUT, trust, nits: false, uncommitted: true },
        { ...POPULATED_INPUT, trust, mode: "incremental", since: "2".repeat(40), nits: true },
        { ...POPULATED_INPUT, trust, mode: "incremental", since: "2".repeat(40), uncommitted: true },
      ]
      return [
        ...inputs.flatMap((input) => [buildReviewPrompt(input), buildSecurityPrompt(input)]),
        buildVerifyPrompt({ trust, head: CANONICAL_INPUT.head, candidates: [CANONICAL_FINDING] }),
        buildVerifyPrompt({ ...POPULATED_VERIFY, trust }),
      ]
    }),
    buildFinalizePrompt(),
    ownerBlock(["Example."]),
  ]
}

let prompts: string | undefined

// A digest of the core review prompts and output schemas, built from fixed inputs so it changes only when their text
// does (canonicalPrompts).
export function promptsDigest(): string {
  prompts ??= fnv1a64(JSON.stringify([...canonicalPrompts(), REVIEW_REPORT_JSON_SCHEMA, VERIFY_JSON_SCHEMA]))
  return prompts
}

export function policyDigest(config: Pick<ReviewConfig, (typeof EVIDENCE_POLICY_KEYS)[number]>): string {
  return fnv1a64(JSON.stringify(EVIDENCE_POLICY_KEYS.map((key) => [key, config[key]])))
}

// `route` is the caller's to set, only when it enforced the route rules; it is never read from the config, so no scope
// claims a zero data retention route that nothing enforced.
export function evidenceScope(input: {
  adapter: EvidenceAdapter
  config: Pick<ReviewConfig, (typeof EVIDENCE_POLICY_KEYS)[number]>
  triage?: string
  route?: "zdr"
}): EvidenceScope {
  return {
    adapter: input.adapter,
    pipeline: REVIEW_PIPELINE_REVISION,
    prompts: promptsDigest(),
    policy: policyDigest(input.config),
    ...(input.triage ? { triage: input.triage } : {}),
    ...(input.route ? { route: input.route } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Model identity

// A router or preset: OpenRouter may answer each request with another model (its own routers, such as the free router
// and openrouter/auto, and `@preset/` names), so no single evaluation can describe what answers. The same rule
// free-model-catalog applies to requests.
export function routedModel(model: string) {
  const slash = model.indexOf("/")
  return slash > 0 && openRouterModelRouting(undefined, model.slice(slash + 1)).length > 0
}

// Another route or provider to a certified model is found with the eval's sameModel (eval.ts). It errs towards "same",
// which here only ever says that a certificate of another route does not cover this one; it never certifies.

// ---------------------------------------------------------------------------------------------------------------
// Certificates

const MODEL = /^[^/\s]+\/\S+$/
const SHA256 = /^sha256:[0-9a-f]{64}$/
const FNV = /^[0-9a-f]{16}$/
const DAY_MS = 24 * 60 * 60 * 1000

// Everything wrong with a certificate; empty when it can apply. A certificate with any problem never certifies.
export function certificateProblems(value: unknown): string[] {
  const cert = record(value)
  if (!cert) return ["the certificate is not an object"]
  const evaluation = record(cert.evaluation)
  const approved = record(cert.approved)
  const text = (item: unknown) => typeof item === "string" && item.trim() !== ""
  const adapters = Array.isArray(cert.adapters) ? cert.adapters : undefined
  const approvedOn = date(approved?.date)
  const expires = date(cert.expires)
  const collected = date(evaluation?.collected)
  return [
    ...(cert.version === 1 ? [] : ["version must be 1"]),
    ...(text(cert.id) ? [] : ["id must be text"]),
    ...(typeof cert.model === "string" && MODEL.test(cert.model) ? [] : ['model must be an exact "provider/model"']),
    ...(typeof cert.model === "string" && routedModel(cert.model)
      ? ["model is a router or preset, which may answer with another model, so it cannot be certified"]
      : []),
    ...(cert.variant === undefined || text(cert.variant) ? [] : ["variant must be text when set"]),
    ...(cert.triage === undefined || (typeof cert.triage === "string" && MODEL.test(cert.triage))
      ? []
      : ['triage must be a "provider/model" when set']),
    ...(cert.route === undefined || cert.route === "zdr" ? [] : ['route must be "zdr" when set']),
    ...(adapters?.length &&
    adapters.every((item) => ADAPTERS.includes(item as EvidenceAdapter)) &&
    new Set(adapters).size === adapters.length
      ? []
      : ['adapters must list "engine" or "desktop", each once']),
    ...(Number.isInteger(cert.pipeline) && (cert.pipeline as number) > 0 ? [] : ["pipeline must be a revision"]),
    ...(typeof cert.prompts === "string" && FNV.test(cert.prompts) ? [] : ["prompts must be a promptsDigest()"]),
    ...(typeof cert.policy === "string" && FNV.test(cert.policy) ? [] : ["policy must be a policyDigest()"]),
    ...(!evaluation
      ? ["evaluation must name the report, manifest, split, decision, gate and collection date"]
      : [
          ...(typeof evaluation.report === "string" && SHA256.test(evaluation.report)
            ? []
            : ["evaluation.report must be the report's sha256: digest"]),
          ...(typeof evaluation.manifest === "string" && SHA256.test(evaluation.manifest)
            ? []
            : ["evaluation.manifest must be the frozen manifest's sha256: digest"]),
          ...(evaluation.split === "held-out" ? [] : ["evaluation.split must be held-out"]),
          ...(text(evaluation.decision) ? [] : ["evaluation.decision must name the gate decision"]),
          ...(text(evaluation.gate) ? [] : ["evaluation.gate must be the gate config's digest"]),
          ...(collected === undefined ? ["evaluation.collected must be a YYYY-MM-DD date"] : []),
          ...(evaluation.vector === undefined || text(evaluation.vector) ? [] : ["evaluation.vector must be text"]),
        ]),
    ...(approved?.by === "owner" ? [] : ["approved.by must be owner"]),
    ...(approvedOn === undefined ? ["approved.date must be a YYYY-MM-DD date"] : []),
    ...(approvedOn !== undefined && collected !== undefined && approvedOn < collected
      ? ["approved.date is before the results were collected"]
      : []),
    ...(expires === undefined ? ["expires must be a YYYY-MM-DD date"] : []),
    ...(expires !== undefined && approvedOn !== undefined && expires <= approvedOn
      ? ["expires must be after approved.date"]
      : []),
    ...(expires !== undefined && approvedOn !== undefined && expires - approvedOn > MAX_CERTIFICATE_DAYS * DAY_MS
      ? [`expires must be at most ${MAX_CERTIFICATE_DAYS} days after approved.date`]
      : []),
  ]
}

// A certificate from a report whose gate made a passing release decision, with the scope every candidate run was
// replayed in. It says what is wrong instead when the report or the scopes cannot support one. The owner's approval
// and the expiry are the caller's: nothing here approves.
export function certify(input: {
  id: string
  report: Pick<Report, "split" | "frozen" | "gate" | "decision" | "problems">
  reportDigest: string // "sha256:<hex>" of the report file
  manifest: string // the manifest's freeze digest
  collected: string
  scopes: readonly EvidenceScope[] // of the candidate's runs, from their replay artifacts
  variant?: string
  vector?: string
  approved: ModelCertificate["approved"]
  expires: string
}): { certificate?: ModelCertificate; problems: string[] } {
  const decision = input.report.decision
  const first = input.scopes[0]
  const problems = [
    ...(decision ? [] : ["the report has no gate decision"]),
    ...(decision && decision.outcome !== "pass" ? [`the gate's outcome is ${decision.outcome}, not pass`] : []),
    ...(decision && !decision.release.eligible
      ? [`the report is not a release decision: ${decision.release.reasons.join("; ")}`]
      : []),
    ...(input.report.frozen ? [] : ["the manifest's held-out labels are not frozen"]),
    ...(input.report.problems.length ? [`the report lists ${input.report.problems.length} problem(s)`] : []),
    ...(first ? [] : ["no replay scope was given for the candidate's runs"]),
    ...(first &&
    input.scopes.some(
      (scope) =>
        scope.pipeline !== first.pipeline ||
        scope.prompts !== first.prompts ||
        scope.policy !== first.policy ||
        scope.triage !== first.triage,
    )
      ? ["the candidate's runs were replayed under different pipelines, prompts, settings or triage models"]
      : []),
    ...(first && input.scopes.some((scope) => scope.route !== first.route)
      ? ["the candidate's runs were replayed under different privacy routes"]
      : []),
  ]
  if (!decision || !first) return { problems }
  const certificate: ModelCertificate = {
    version: 1,
    id: input.id,
    model: decision.candidate.model,
    ...(input.variant ? { variant: input.variant } : {}),
    ...(first.triage ? { triage: first.triage } : {}),
    ...(first.route ? { route: first.route } : {}),
    adapters: ADAPTERS.filter((adapter) => input.scopes.some((scope) => scope.adapter === adapter)),
    pipeline: first.pipeline,
    prompts: first.prompts,
    policy: first.policy,
    evaluation: {
      report: input.reportDigest,
      manifest: input.manifest,
      split: input.report.split ?? "",
      decision: decision.decision,
      gate: input.report.gate.digest,
      collected: input.collected,
      ...(input.vector ? { vector: input.vector } : {}),
    },
    approved: input.approved,
    expires: input.expires,
  }
  const all = [...problems, ...certificateProblems(certificate)]
  return all.length ? { problems: all } : { certificate, problems: [] }
}

// ---------------------------------------------------------------------------------------------------------------
// Assessment

export function assessReview(input: {
  review: ModelSubject
  triage?: ModelSubject
  scope: EvidenceScope
  served?: readonly string[] // every model a reply in the review came from
  now: number
  certificates?: readonly ModelCertificate[]
}): ReviewEvidence {
  const certificates = (input.certificates ?? MODEL_EVIDENCE).filter((cert) => certificateProblems(cert).length === 0)
  const chosen = new Set([input.review.model, ...(input.triage ? [input.triage.model] : [])])
  const unexpected = [...new Set((input.served ?? []).filter((name) => !chosen.has(name)))]
  const review = assessModel(input.review, input.scope, certificates, input.now)
  const models: ModelEvidence[] = [
    unexpected.length && review.status === "certified" ? { ...review, status: "rerouted", rerouted: "served" } : review,
  ]
  if (input.triage) {
    // A certificate covers its pipeline's triage model with it (scope.triage), so the cheaper model has no evaluation of
    // its own: it is retired, a router, or as covered as the review model is.
    const own = intrinsic(input.triage)
    models.push({
      role: "triage",
      subject: input.triage,
      mayTrain: mayTrain(input.triage),
      ...(own ?? { status: models[0]!.status === "certified" ? "certified" : "unvetted" }),
    })
  }
  return { models, unexpected }
}

function assessModel(
  subject: ModelSubject,
  scope: EvidenceScope,
  certificates: readonly ModelCertificate[],
  now: number,
): ModelEvidence {
  const base = { role: "review" as const, subject, mayTrain: mayTrain(subject) }
  const own = intrinsic(subject)
  if (own) return { ...base, ...own }
  const exact = certificates.filter((cert) => cert.model === subject.model)
  if (!exact.length) {
    const other = certificates.find((cert) => sameModel(cert.model, subject.model))
    return other
      ? { ...base, status: "rerouted", rerouted: "route", certificate: other.id, evaluated: other.model }
      : { ...base, status: "unvetted" }
  }
  const checked = exact
    .map((cert) => ({ cert, changed: changes(cert, subject, scope), expired: now >= date(cert.expires)! }))
    // The certificate that applies, else the closest: fewest changes, then not expired, then the latest approved.
    .toSorted(
      (a, b) =>
        a.changed.length - b.changed.length ||
        Number(a.expired) - Number(b.expired) ||
        b.cert.approved.date.localeCompare(a.cert.approved.date),
    )
  const best = checked[0]!
  if (best.changed.length) return { ...base, status: "stale", certificate: best.cert.id, changed: best.changed }
  if (best.expired) return { ...base, status: "expired", certificate: best.cert.id, expires: best.cert.expires }
  return { ...base, status: "certified", certificate: best.cert.id }
}

function intrinsic(subject: ModelSubject): Pick<ModelEvidence, "status" | "rerouted"> | undefined {
  if (subject.status === "deprecated") return { status: "retired" }
  if (routedModel(subject.model)) return { status: "rerouted", rerouted: "router" }
  return undefined
}

function changes(cert: ModelCertificate, subject: ModelSubject, scope: EvidenceScope): ScopeChange[] {
  return [
    ...(cert.adapters.includes(scope.adapter) ? [] : ["adapter" as const]),
    ...(cert.pipeline === scope.pipeline ? [] : ["pipeline" as const]),
    ...(cert.prompts === scope.prompts ? [] : ["prompts" as const]),
    ...(cert.policy === scope.policy ? [] : ["policy" as const]),
    ...(cert.triage === scope.triage ? [] : ["triage" as const]),
    ...(cert.variant === subject.variant ? [] : ["variant" as const]),
    ...(cert.route === scope.route ? [] : ["route" as const]),
  ]
}

function mayTrain(subject: ModelSubject) {
  return freeModelMayTrain(subject)
}

// ---------------------------------------------------------------------------------------------------------------
// Notes

const CHANGE_WORDS: Record<ScopeChange, string> = {
  adapter: "another review runner",
  pipeline: "an earlier review pipeline",
  prompts: "other review prompts",
  policy: "other review settings",
  triage: "another triage model, or none",
  variant: "another variant of the model",
  route: "another privacy setting",
}

// One paragraph per model that has something to say: what the evidence is, whether its provider may train on the code
// it is sent, and why it was used. A certified model with nothing else to say gets none, so no note ever claims review
// quality. `choice: false` leaves out why it was used, for a surface that already says so.
export function modelEvidenceNotes(evidence: ReviewEvidence, options: { choice?: boolean } = {}): string[] {
  const review = evidence.models[0]
  const notes = evidence.models.flatMap((entry) => {
    const name = codeSpan(entry.subject.model)
    const sentences = [
      ...(entry.role === "review" || entry.status === "retired" || entry.status === "rerouted"
        ? statusSentences(entry, name)
        : []),
      ...(entry.mayTrain
        ? [
            `${name} is labelled "${FREE_MODEL_TRAINING_LABEL}": its provider may log the code it is sent and use it to train models. Don't use it for private code.`,
          ]
        : []),
    ]
    if (!sentences.length) return []
    const choice = options.choice === false ? undefined : entry.subject.choice
    return [
      [
        ...sentences,
        ...(choice
          ? [
              choice.explicit
                ? `Vector used it because ${choice.setting} names it, and does not switch a chosen model.`
                : `${capitalize(choice.unset ?? `no ${entry.role} model is set`)}, so Vector used ${choice.setting}.`,
            ]
          : []),
      ].join(" "),
    ]
  })
  return [
    ...notes,
    ...(evidence.unexpected.length && review
      ? [
          `Replies in this review came from ${evidence.unexpected.map(codeSpan).join(", ")}, which it did not choose${review.status === "rerouted" && review.rerouted === "served" ? `, so the VectorScope evaluation of ${codeSpan(review.subject.model)} does not cover them` : ""}.`,
        ]
      : []),
  ]
}

function statusSentences(entry: ModelEvidence, name: string): string[] {
  const id = entry.certificate ? ` (${codeSpan(entry.certificate)})` : ""
  switch (entry.status) {
    case "certified":
      return []
    case "unvetted":
      return [
        `${name} has no VectorScope evaluation on record, so how well it reviews is unmeasured.`,
        // "Does not train" only from Vector's reviewed record; a free model without one is only free.
        ...(entry.subject.free
          ? [
              entry.subject.freeModel?.dataPolicy === "no-training"
                ? "Being free, and from a provider that does not train on prompts, is not evidence of review quality."
                : "Being free is not evidence of review quality.",
            ]
          : []),
      ]
    case "expired":
      return [`The VectorScope evaluation of ${name} on record${id} expired on ${entry.expires} and no longer applies.`]
    case "stale":
      return [
        `The VectorScope evaluation of ${name} on record${id} was made with ${joinWords((entry.changed ?? []).map((change) => CHANGE_WORDS[change]))}, so it does not apply here.`,
      ]
    case "retired":
      return [`${name} is retired by its provider, so no evaluation applies to it. Choose a current model.`]
    case "rerouted":
      if (entry.rerouted === "router")
        return [
          `${name} is a router: each request may be answered by a different model, so no evaluation applies to it.`,
        ]
      if (entry.rerouted === "route")
        return [
          `${name} has no VectorScope evaluation of its own. The one on record${id} is of ${codeSpan(entry.evaluated ?? "")}, which may be the same model through another provider or route, and does not cover ${name}.`,
        ]
      return []
  }
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("")
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
}

// Milliseconds at the start of a YYYY-MM-DD day in UTC, or undefined for anything else.
function date(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value) ? time : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
