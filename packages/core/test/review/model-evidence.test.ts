import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { FREE_MODEL_TRAINING_LABEL } from "@vectordevai/core/free-model-choice"
import { DEFAULT_GATE, gateDigest } from "@vectordevai/core/review/eval-report"
import { fnv1a64 } from "@vectordevai/core/review/fingerprint"
import {
  assessReview,
  canonicalPrompts,
  certificateProblems,
  certify,
  evidenceScope,
  MAX_CERTIFICATE_DAYS,
  MODEL_EVIDENCE,
  modelEvidenceNotes,
  policyDigest,
  promptsDigest,
  REVIEW_PIPELINE_REVISION,
  REVIEW_PIPELINE_SOURCES,
  routedModel,
  type EvidenceScope,
  type ModelCertificate,
  type ModelSubject,
} from "@vectordevai/core/review/model-evidence"
import { DEFAULT_REVIEW_CONFIG, UNAPPLIED_REVIEW_KEYS, type ReviewConfig } from "@vectordevai/core/review/types"

// The review pipeline's sources, from the repository root: both runners, the core code they share for planning,
// packing, selection, anchoring and the prompts (whose length limits promptsDigest cannot see), the route rules
// (VS-23a), the payload holdback (VS-34a), the trivial gate and the pre-dispatch estimate (VS-24c), the tree-sitter
// parser (VS-25a), the Tier 1 impact slice and its builder (VS-25b), and the review and security agents' own prompts.
// REVIEW_PIPELINE_SOURCES pins a digest of them. The web-tree-sitter runtime init the parser shares with the shell tool
// (engine util/tree-sitter.ts) is left out on purpose: it decides nothing a review finds, and pinning it would tie shell
// changes to the review pin. So, for now, are the slice's shared readers, BrainCode and BrainGraph (core brain/code.ts
// and graph.ts, which also rank the desktop's files) and the changedSymbols fallback (review/symbols.ts): no runner
// reaches them through the slice before VS-25b wiring, which adds them here when it makes them decide the slice.
const REVIEW_PIPELINE_FILES = [
  "packages/engine/src/review/run.ts",
  "packages/app/src/features/pull-requests/ai-review.ts",
  "packages/core/src/review/plan.ts",
  "packages/core/src/review/pack.ts",
  "packages/core/src/review/select.ts",
  "packages/core/src/review/diff.ts",
  "packages/core/src/review/fingerprint.ts",
  "packages/core/src/review/prompt.ts",
  "packages/core/src/review/privacy.ts",
  "packages/core/src/review/holdback.ts",
  "packages/core/src/review/trivial.ts",
  "packages/core/src/review/dispatch.ts",
  "packages/engine/src/review/parse.ts",
  "packages/core/src/review/impact.ts",
  "packages/engine/src/review/impact.ts",
  "packages/engine/src/agent/prompt/review.txt",
  "packages/engine/src/agent/prompt/security.txt",
]

// Model evidence (VS-07) over synthetic certificates. No real certificate exists: MODEL_EVIDENCE is empty until the
// owner approves one from a held-out run.

const SONNET = "anthropic/claude-sonnet-4-5"
const SCOPE = evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG })
const NOW = Date.parse("2027-01-01T12:00:00Z")

function cert(overrides: Partial<ModelCertificate> = {}): ModelCertificate {
  return {
    version: 1,
    id: "vs-2026-12-sonnet",
    model: SONNET,
    adapters: ["engine"],
    pipeline: SCOPE.pipeline,
    prompts: SCOPE.prompts,
    policy: SCOPE.policy,
    evaluation: {
      report: `sha256:${"a".repeat(64)}`,
      manifest: `sha256:${"b".repeat(64)}`,
      split: "held-out",
      decision: "D2",
      gate: gateDigest(DEFAULT_GATE),
      collected: "2026-12-01",
    },
    approved: { by: "owner", date: "2026-12-02" },
    expires: "2027-02-01",
    ...overrides,
  }
}

const chosen = (model: string, overrides: Partial<ModelSubject> = {}): ModelSubject => ({
  model,
  free: false,
  choice: { explicit: true, setting: "--model" },
  ...overrides,
})

const assess = (
  review: ModelSubject,
  options: {
    certificates?: ModelCertificate[]
    scope?: EvidenceScope
    triage?: ModelSubject
    served?: string[]
    now?: number
  } = {},
) =>
  assessReview({
    review,
    ...(options.triage ? { triage: options.triage } : {}),
    scope: options.scope ?? SCOPE,
    ...(options.served ? { served: options.served } : {}),
    now: options.now ?? NOW,
    certificates: options.certificates ?? [cert()],
  })

describe("the registry", () => {
  test("holds no certificate, so every model is unvetted, and anything in it must be valid", () => {
    expect(MODEL_EVIDENCE).toEqual([])
    for (const item of MODEL_EVIDENCE) expect(certificateProblems(item)).toEqual([])
    const evidence = assessReview({ review: chosen(SONNET), scope: SCOPE, now: NOW })
    expect(evidence.models.map((entry) => entry.status)).toEqual(["unvetted"])
  })
})

describe("scope", () => {
  test("names the runner, pipeline revision, prompts, review settings and triage model", () => {
    expect(SCOPE).toEqual({
      adapter: "engine",
      pipeline: REVIEW_PIPELINE_REVISION,
      prompts: promptsDigest(),
      policy: policyDigest(DEFAULT_REVIEW_CONFIG),
    })
    expect(promptsDigest()).toMatch(/^[0-9a-f]{16}$/)
    expect(promptsDigest()).toBe(promptsDigest())
    // Printed at 6e2f1d04, before VS-25b: a section a key enables enters the digest only under that key (contract §0.3).
    expect(promptsDigest()).toBe("5d59e9ee06077c23")
    expect(evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG, triage: "acme/cheap" })).toMatchObject({
      adapter: "desktop",
      triage: "acme/cheap",
    })
  })

  // Phase 1 review: the digest rendered bare inputs only, so a section a prompt shows only when it has something to show
  // could change without changing it.
  test("the prompts digest renders every section a prompt can have, with and without nits, uncommitted too", () => {
    const text = canonicalPrompts().join("\n")
    for (const section of [
      "## Open findings",
      "<open_findings>",
      "## Focus",
      "<focus>",
      "were reviewed before; their diff is shown without context lines",
      "The last review was of",
      "<untrusted_pr_title>",
      "<untrusted_pr_body>",
      "<untrusted_commits>",
      "<untrusted_diff>",
      "<untrusted_changed_files_not_inlined>",
      "open them yourself",
      "their pull request versions are in `<untrusted_pr_file>` blocks when they fit",
      'annotated="true"',
      "<related_code>",
      "<ci_checks>",
      "<untrusted_ci_log",
      "<untrusted_linked_requirements>",
      "<history>",
      "<untrusted_comments>",
      "<team_dismissed>",
      "the repository root",
      "<repository_instructions",
      "<review_rules",
      "Nit means a clarity or style point",
      "Do not report nits.",
      "- Formatting, or anything a linter catches.",
      "- Style, formatting, naming, comments, wording",
      "Reviewing the uncommitted changes in the working tree",
      "the uncommitted changes in the working tree.",
      "<untrusted_fixed_claim",
      "Each `<untrusted_fixed_claim>`",
      "<how_the_owner_reviews>",
      "Stop investigating.",
      "Anything that is not a security defect.",
      "The working tree is the base branch.",
    ])
      expect(text).toContain(section)
  })

  // VS-25b: the <untrusted_impact> block renders only when a slice is set, which only `impact: "graph"` will do, so it
  // enters the digest only under that key and the default digest holds.
  test("the prompts digest covers the impact block under impact: graph only", () => {
    expect(promptsDigest({})).toBe(promptsDigest())
    expect(promptsDigest({ impact: "grep" })).toBe(promptsDigest())
    expect(promptsDigest({ impact: "graph" })).not.toBe(promptsDigest())
    expect(promptsDigest({ impact: "graph" })).toBe(promptsDigest({ impact: "graph" }))
    expect(canonicalPrompts().join("\n")).not.toContain("untrusted_impact")
    expect(canonicalPrompts({ impact: "grep" })).toEqual(canonicalPrompts())
    const graph = canonicalPrompts({ impact: "graph" })
    expect(graph.slice(0, canonicalPrompts().length)).toEqual(canonicalPrompts())
    const text = graph.join("\n")
    for (const section of [
      "`<untrusted_impact>` lists the definitions this change touches",
      "<untrusted_impact>\n",
      "<untrusted_changed_definition ",
      "<untrusted_call_site ",
      'in="caller"',
      "<untrusted_tests>",
      "<untrusted_impact_note>",
      "its time limit; 1 file not searched, missing from a partial clone; git output over its limit; a git error",
    ])
      expect(text).toContain(section)
    // Both trusts, the review and security prompts.
    expect(graph.length - canonicalPrompts().length).toBe(4)
  })

  // The runners and the core code they share have no digest a review can compute, so this pins one: a change to any of
  // these files fails here until someone decides whether REVIEW_PIPELINE_REVISION goes up and updates the pin.
  test("the pipeline's sources are pinned next to REVIEW_PIPELINE_REVISION", () => {
    const root = path.join(import.meta.dir, "..", "..", "..", "..")
    const digest = fnv1a64(
      REVIEW_PIPELINE_FILES.map(
        (file) => `${file}\n${readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n")}`,
      ).join("\0"),
    )
    if (digest !== REVIEW_PIPELINE_SOURCES)
      throw new Error(
        `The review pipeline's sources changed (${REVIEW_PIPELINE_FILES.join(", ")}). If the change alters what a review finds or posts, bump REVIEW_PIPELINE_REVISION (REVIEW_PIPELINE_REVISION is ${REVIEW_PIPELINE_REVISION}). Then set REVIEW_PIPELINE_SOURCES in packages/core/src/review/model-evidence.ts to "${digest}".`,
      )
    expect(digest).toBe(REVIEW_PIPELINE_SOURCES)
  })

  test("the policy digest follows the settings that change what is found or posted, and no others", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    for (const change of [
      { verify: "all" as const },
      { verifyPolicy: "shared" as const },
      { security: "always" as const },
      { minConfidence: 0.5 },
      { maxComments: 3 },
      { nits: true },
    ])
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, ...change })).not.toBe(base)
    for (const change of [
      { maxCostUsd: 9 },
      { timeoutMinutes: 30 },
      { ignore: ["docs/**"] },
      { modelEvidence: "warn" as const },
      { model: "acme/other" },
      // The route settings (VS-23a) are scope, not policy: EvidenceScope.route, set only by a runner enforcing them.
      { privacy: "zdr" as const },
      { zdrAttested: ["openrouter"] },
      // VS-33's attestation objects are route settings too.
      { zdrAttested: [{ id: "openrouter", operator: "openrouter", region: "eu" as const, extendedCache: true }] },
      // VS-24's token cap is a budget, and its trivial gate is applied by no runner yet.
      { maxInputTokens: 200_000 },
      { trivial: "review" as const },
      { trivial: "skip" as const },
      // VS-25's impact slice is applied by no runner yet either.
      { impact: "grep" as const },
      { impact: "graph" as const },
    ])
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, ...change })).toBe(base)
  })

  // VS-24c: `trivial` is a policy key (a skipped change is not reviewed) that no runner applies before VS-24 wiring, so
  // it never enters the digest yet: a review whose config sets `trivial: "skip"` runs, and is scoped as, the full
  // review. Once a runner applies it (it leaves UNAPPLIED_REVIEW_KEYS), it counts only when set to "skip", so the digest
  // of every config made before it, the frozen engine baseline's included, still holds.
  test("the policy digest leaves out VS-24's trivial until a runner applies it", () => {
    // Printed by policyDigest at 8f38f824, before `trivial` was a policy key.
    expect(policyDigest(DEFAULT_REVIEW_CONFIG)).toBe("70512122f41ec160")
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(UNAPPLIED_REVIEW_KEYS).toContain("trivial")
    for (const trivial of ["skip", "review", undefined] as const)
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, trivial })).toBe(base)
    const skip: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, trivial: "skip" }
    expect(evidenceScope({ adapter: "engine", config: skip })).toEqual(SCOPE)
    expect(evidenceScope({ adapter: "desktop", config: skip })).toEqual(
      evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG }),
    )
    // Every other key keeps its digest behaviour: a changed value still moves it, with trivial set or not.
    expect(policyDigest({ ...skip, maxComments: 3 })).not.toBe(policyDigest(skip))
    expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, maxSteps: 31 })).not.toBe(base)
  })

  // VS-25b: `impact` is a policy key (the slice is context the model reviews with) that no runner applies before VS-25b
  // wiring, so neither the policy digest nor the prompts digest of a scope moves with it yet. Once a runner applies it,
  // only "graph" counts, in both.
  test("the scope leaves out VS-25b's impact until a runner applies it", () => {
    const base = policyDigest(DEFAULT_REVIEW_CONFIG)
    expect(UNAPPLIED_REVIEW_KEYS).toContain("impact")
    for (const impact of ["graph", "grep", undefined] as const)
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, impact })).toBe(base)
    const graph: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, impact: "graph" }
    expect(evidenceScope({ adapter: "engine", config: graph })).toEqual(SCOPE)
    expect(evidenceScope({ adapter: "engine", config: graph }).prompts).toBe(promptsDigest())
    expect(policyDigest({ ...graph, nits: true })).not.toBe(policyDigest(graph))
  })

  test("a route is in the scope only when the caller enforced it", () => {
    expect(Object.hasOwn(SCOPE, "route")).toBe(false)
    expect(evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG, route: "zdr" })).toEqual({
      ...SCOPE,
      route: "zdr",
    })
    // A config that asks for zdr does not make the scope claim a route nothing enforced.
    const asked: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, privacy: "zdr" }
    expect(evidenceScope({ adapter: "engine", config: asked })).toEqual(SCOPE)
  })
})

describe("certificates", () => {
  test("a complete certificate has no problems", () => {
    expect(certificateProblems(cert())).toEqual([])
    expect(
      certificateProblems(cert({ triage: "acme/cheap", variant: "high", adapters: ["engine", "desktop"] })),
    ).toEqual([])
  })

  test("refuses routers, missing evidence, an approval other than the owner's and a long or missing expiry", () => {
    expect(certificateProblems(cert({ model: "vector/openrouter/free" }))).toContain(
      "model is a router or preset, which may answer with another model, so it cannot be certified",
    )
    expect(certificateProblems(cert({ model: "sonnet" }))).toContain('model must be an exact "provider/model"')
    expect(certificateProblems(cert({ adapters: [] }))).toContain('adapters must list "engine" or "desktop", each once')
    expect(certificateProblems(cert({ prompts: "nope" }))).toContain("prompts must be a promptsDigest()")
    const evaluation = cert().evaluation
    expect(certificateProblems(cert({ evaluation: { ...evaluation, split: "development" } }))).toContain(
      "evaluation.split must be held-out",
    )
    expect(certificateProblems(cert({ evaluation: { ...evaluation, manifest: "draft" } }))).toContain(
      "evaluation.manifest must be the frozen manifest's sha256: digest",
    )
    expect(
      certificateProblems({
        ...cert(),
        approved: { by: "someone", date: "2026-12-02" },
      } as unknown as ModelCertificate),
    ).toContain("approved.by must be owner")
    expect(certificateProblems(cert({ approved: { by: "owner", date: "2026-11-30" } }))).toContain(
      "approved.date is before the results were collected",
    )
    expect(certificateProblems(cert({ expires: "2026-12-02" }))).toContain("expires must be after approved.date")
    expect(certificateProblems(cert({ expires: "2027-06-01" }))).toContain(
      `expires must be at most ${MAX_CERTIFICATE_DAYS} days after approved.date`,
    )
    expect(certificateProblems({ ...cert(), expires: undefined })).toContain("expires must be a YYYY-MM-DD date")
    expect(certificateProblems(cert({ expires: "2027-02-30" }))).toContain("expires must be a YYYY-MM-DD date")
    expect(certificateProblems("cert")).toEqual(["the certificate is not an object"])
    expect(certificateProblems(cert({ route: "zdr" }))).toEqual([])
    expect(certificateProblems({ ...cert(), route: "other" })).toContain('route must be "zdr" when set')
  })

  test("certify builds one only from a passing release decision on frozen labels with one scope", () => {
    const report = {
      split: "held-out",
      frozen: true,
      gate: { config: DEFAULT_GATE, digest: gateDigest(DEFAULT_GATE) },
      decision: {
        decision: "D2",
        candidate: { variant: "engine", model: SONNET },
        outcome: "pass" as const,
        rules: [],
        release: { eligible: true, reasons: [] },
      },
      problems: [],
    }
    const input = {
      id: "vs-2026-12-sonnet",
      report,
      reportDigest: `sha256:${"a".repeat(64)}`,
      manifest: `sha256:${"b".repeat(64)}`,
      collected: "2026-12-01",
      scopes: [SCOPE, SCOPE],
      approved: { by: "owner" as const, date: "2026-12-02" },
      expires: "2027-02-01",
    }
    expect(certify(input)).toEqual({ certificate: cert(), problems: [] })

    const failed = certify({ ...input, report: { ...report, decision: { ...report.decision, outcome: "review" } } })
    expect(failed.certificate).toBeUndefined()
    expect(failed.problems).toContain("the gate's outcome is review, not pass")
    const ineligible = certify({
      ...input,
      report: {
        ...report,
        decision: {
          ...report.decision,
          release: { eligible: false, reasons: ["the results are from the development split"] },
        },
      },
    })
    expect(ineligible.problems).toContain(
      "the report is not a release decision: the results are from the development split",
    )
    expect(certify({ ...input, report: { ...report, frozen: false } }).problems).toContain(
      "the manifest's held-out labels are not frozen",
    )
    expect(certify({ ...input, scopes: [SCOPE, { ...SCOPE, policy: "0".repeat(16) }] }).problems).toContain(
      "the candidate's runs were replayed under different pipelines, prompts, settings or triage models",
    )
    expect(certify({ ...input, scopes: [] }).problems).toContain("no replay scope was given for the candidate's runs")
    // A privacy route is its own reason, and a certificate from runs on one route names it.
    const zdr = { ...SCOPE, route: "zdr" as const }
    expect(certify({ ...input, scopes: [SCOPE, zdr] }).problems).toEqual([
      "the candidate's runs were replayed under different privacy routes",
    ])
    expect(certify({ ...input, scopes: [zdr, zdr] })).toEqual({ certificate: cert({ route: "zdr" }), problems: [] })
    expect(certify({ ...input, expires: "2027-12-01" }).certificate).toBeUndefined()
    const router = certify({
      ...input,
      report: {
        ...report,
        decision: { ...report.decision, candidate: { variant: "engine", model: "vector/openrouter/free" } },
      },
    })
    expect(router.certificate).toBeUndefined()
  })
})

describe("assessing a review's models", () => {
  test("an exact, current certificate in the same scope certifies, and certification says nothing", () => {
    const evidence = assess(chosen(SONNET))
    expect(evidence.models[0]).toMatchObject({ status: "certified", certificate: "vs-2026-12-sonnet" })
    expect(modelEvidenceNotes(evidence)).toEqual([])
  })

  test("unvetted: no certificate for the model; the note keeps the chosen model and says why it ran", () => {
    const evidence = assess(chosen("openai/gpt-5.5"))
    expect(evidence.models[0]!.status).toBe("unvetted")
    expect(modelEvidenceNotes(evidence)).toEqual([
      "`openai/gpt-5.5` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Vector used it because --model names it, and does not switch a chosen model.",
    ])
    // A default the review fell back to says so; a surface that already names the model can leave the reason out.
    const fallback = assess(chosen("openai/gpt-5.5", { choice: { explicit: false, setting: "your default model" } }))
    expect(modelEvidenceNotes(fallback)[0]).toEndWith("No review model is set, so Vector used your default model.")
    expect(modelEvidenceNotes(fallback, { choice: false })).toEqual([
      "`openai/gpt-5.5` has no VectorScope evaluation on record, so how well it reviews is unmeasured.",
    ])
    // A surface that cannot say "no review model is set" says what was left unset instead.
    const agent = assess(
      chosen("openai/gpt-5.5", {
        choice: { explicit: false, setting: "your agent's model", unset: "no model is set in .vector/review.json" },
      }),
    )
    expect(modelEvidenceNotes(agent)[0]).toEndWith(
      "No model is set in .vector/review.json, so Vector used your agent's model.",
    )
  })

  test("expired and stale certificates no longer apply, and say why", () => {
    const expired = assess(chosen(SONNET), { now: Date.parse("2027-02-01T00:00:00Z") })
    expect(expired.models[0]).toMatchObject({ status: "expired", expires: "2027-02-01" })
    expect(modelEvidenceNotes(expired)[0]).toStartWith(
      "The VectorScope evaluation of `anthropic/claude-sonnet-4-5` on record (`vs-2026-12-sonnet`) expired on 2027-02-01 and no longer applies.",
    )

    const desktop = assess(chosen(SONNET), { scope: { ...SCOPE, adapter: "desktop" } })
    expect(desktop.models[0]).toMatchObject({ status: "stale", changed: ["adapter"] })
    const settings = assess(chosen(SONNET), {
      scope: evidenceScope({ adapter: "engine", config: { ...DEFAULT_REVIEW_CONFIG, verify: "all" } }),
    })
    expect(settings.models[0]!.changed).toEqual(["policy"])
    const pipeline = assess(chosen(SONNET), {
      scope: { ...SCOPE, pipeline: SCOPE.pipeline + 1, prompts: "f".repeat(16) },
    })
    expect(pipeline.models[0]!.changed).toEqual(["pipeline", "prompts"])
    expect(modelEvidenceNotes(pipeline)[0]).toStartWith(
      "The VectorScope evaluation of `anthropic/claude-sonnet-4-5` on record (`vs-2026-12-sonnet`) was made with an earlier review pipeline and other review prompts, so it does not apply here.",
    )
    const triaged = assess(chosen(SONNET), {
      scope: { ...SCOPE, triage: "acme/cheap" },
      triage: chosen("acme/cheap"),
    })
    expect(triaged.models.map((entry) => [entry.role, entry.status])).toEqual([
      ["review", "stale"],
      ["triage", "unvetted"],
    ])
    expect(triaged.models[0]!.changed).toEqual(["triage"])
    const variant = assess(chosen(SONNET, { variant: "high" }))
    expect(variant.models[0]!.changed).toEqual(["variant"])
    // A certificate made on zero data retention routes covers only reviews on them, and the other way round.
    const zdr = { ...SCOPE, route: "zdr" as const }
    const route = assess(chosen(SONNET), { certificates: [cert({ route: "zdr" })] })
    expect(route.models[0]).toMatchObject({ status: "stale", changed: ["route"] })
    expect(modelEvidenceNotes(route)[0]).toStartWith(
      "The VectorScope evaluation of `anthropic/claude-sonnet-4-5` on record (`vs-2026-12-sonnet`) was made with another privacy setting, so it does not apply here.",
    )
    expect(assess(chosen(SONNET), { scope: zdr }).models[0]).toMatchObject({ status: "stale", changed: ["route"] })
    expect(assess(chosen(SONNET), { scope: zdr, certificates: [cert({ route: "zdr" })] }).models[0]!.status).toBe(
      "certified",
    )

    // The closest certificate is the one reported: here the current one, which certifies.
    const both = assess(chosen(SONNET), {
      certificates: [cert({ id: "old", expires: "2026-12-31", approved: { by: "owner", date: "2026-12-02" } }), cert()],
    })
    expect(both.models[0]).toMatchObject({ status: "certified", certificate: "vs-2026-12-sonnet" })
  })

  test("a malformed certificate never certifies", () => {
    const evidence = assess(chosen(SONNET), { certificates: [cert({ expires: "2027-09-01" })] })
    expect(evidence.models[0]!.status).toBe("unvetted")
  })

  test("retired: the provider retired the model, whatever the certificates say", () => {
    const evidence = assess(chosen(SONNET, { status: "deprecated" }))
    expect(evidence.models[0]!.status).toBe("retired")
    expect(modelEvidenceNotes(evidence)).toEqual([
      "`anthropic/claude-sonnet-4-5` is retired by its provider, so no evaluation applies to it. Choose a current model. Vector used it because --model names it, and does not switch a chosen model.",
    ])
  })

  test("rerouted: routers and presets, another route to a certified model, and replies from models not chosen", () => {
    expect(routedModel("vector/openrouter/free")).toBe(true)
    expect(routedModel("openrouter/openrouter/auto")).toBe(true)
    expect(routedModel("openrouter/@preset/reviews")).toBe(true)
    expect(routedModel("openrouter/anthropic/claude-sonnet-4.5")).toBe(false)
    expect(routedModel(SONNET)).toBe(false)

    const router = assess(chosen("vector/openrouter/free", { free: true }))
    expect(router.models[0]).toMatchObject({ status: "rerouted", rerouted: "router" })
    expect(modelEvidenceNotes(router)[0]).toStartWith(
      "`vector/openrouter/free` is a router: each request may be answered by a different model, so no evaluation applies to it.",
    )

    const route = assess(chosen("openrouter/anthropic/claude-sonnet-4.5"))
    expect(route.models[0]).toMatchObject({ status: "rerouted", rerouted: "route", evaluated: SONNET })
    expect(modelEvidenceNotes(route)[0]).toStartWith(
      "`openrouter/anthropic/claude-sonnet-4.5` has no VectorScope evaluation of its own. The one on record (`vs-2026-12-sonnet`) is of `anthropic/claude-sonnet-4-5`, which may be the same model through another provider or route, and does not cover `openrouter/anthropic/claude-sonnet-4.5`.",
    )

    const served = assess(chosen(SONNET), { served: [SONNET, "acme/other", "acme/other"] })
    expect(served.unexpected).toEqual(["acme/other"])
    expect(served.models[0]).toMatchObject({ status: "rerouted", rerouted: "served" })
    expect(modelEvidenceNotes(served)).toEqual([
      "Replies in this review came from `acme/other`, which it did not choose, so the VectorScope evaluation of `anthropic/claude-sonnet-4-5` does not cover them.",
    ])
    const unvetted = assess(chosen("openai/gpt-5.5"), { served: ["openai/gpt-5.5", "acme/other"] })
    expect(unvetted.models[0]!.status).toBe("unvetted")
    expect(modelEvidenceNotes(unvetted).at(-1)).toBe(
      "Replies in this review came from `acme/other`, which it did not choose.",
    )
  })

  test("private code: a free model that may train is said so; free or no-training is never evidence of quality", () => {
    const trainer = assess(
      chosen("vector/acme/coder:free", { free: true, freeModel: { source: "shared", dataPolicy: "may-train" } }),
    )
    expect(trainer.models[0]).toMatchObject({ status: "unvetted", mayTrain: true })
    expect(modelEvidenceNotes(trainer)).toEqual([
      `\`vector/acme/coder:free\` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Being free is not evidence of review quality. \`vector/acme/coder:free\` is labelled "${FREE_MODEL_TRAINING_LABEL}": its provider may log the code it is sent and use it to train models. Don't use it for private code. Vector used it because --model names it, and does not switch a chosen model.`,
    ])
    // A policy Vector has not reviewed counts as may-train, as everywhere else.
    expect(
      assess(chosen("vector/acme/new:free", { free: true, freeModel: { source: "shared", dataPolicy: "unreviewed" } }))
        .models[0]!.mayTrain,
    ).toBe(true)

    const safe = assess(
      chosen("vector/acme/coder:free", {
        free: true,
        freeModel: { source: "shared", dataPolicy: "no-training" },
        choice: { explicit: false, setting: 'an available free model not labelled "May train on your prompts"' },
      }),
    )
    expect(safe.models[0]).toMatchObject({ status: "unvetted", mayTrain: false })
    expect(modelEvidenceNotes(safe)).toEqual([
      '`vector/acme/coder:free` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Being free, and from a provider that does not train on prompts, is not evidence of review quality. No review model is set, so Vector used an available free model not labelled "May train on your prompts".',
    ])

    // A free model without Vector's reviewed record is only free: no label, and no claim that it does not train.
    const unrecorded = assess(chosen("openrouter/acme/coder:free", { free: true }))
    expect(unrecorded.models[0]).toMatchObject({ status: "unvetted", mayTrain: false })
    expect(modelEvidenceNotes(unrecorded)).toEqual([
      "`openrouter/acme/coder:free` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Being free is not evidence of review quality. Vector used it because --model names it, and does not switch a chosen model.",
    ])

    // A certified model is still flagged when its provider may train on the code.
    const certified = assess(chosen(SONNET, { free: true, freeModel: { source: "shared", dataPolicy: "may-train" } }))
    expect(certified.models[0]!.status).toBe("certified")
    expect(modelEvidenceNotes(certified)[0]).toStartWith(`\`${SONNET}\` is labelled "${FREE_MODEL_TRAINING_LABEL}"`)
  })

  test("a triage model is covered by its pipeline's certificate and speaks only when retired, routed or may train", () => {
    const triage = chosen("acme/cheap", { choice: { explicit: true, setting: "triageModel in .vector/review.json" } })
    const covered = assess(chosen(SONNET), {
      certificates: [cert({ triage: "acme/cheap" })],
      scope: { ...SCOPE, triage: "acme/cheap" },
      triage,
    })
    expect(covered.models.map((entry) => entry.status)).toEqual(["certified", "certified"])
    expect(modelEvidenceNotes(covered)).toEqual([])

    const retired = assess(chosen(SONNET), {
      certificates: [cert({ triage: "acme/cheap" })],
      scope: { ...SCOPE, triage: "acme/cheap" },
      triage: { ...triage, status: "deprecated" },
    })
    expect(retired.models.map((entry) => entry.status)).toEqual(["certified", "retired"])
    expect(modelEvidenceNotes(retired)).toEqual([
      "`acme/cheap` is retired by its provider, so no evaluation applies to it. Choose a current model. Vector used it because triageModel in .vector/review.json names it, and does not switch a chosen model.",
    ])
  })
})
