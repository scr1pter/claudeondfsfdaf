import { describe, expect, test } from "bun:test"
import { FREE_MODEL_TRAINING_LABEL } from "@vectordevai/core/free-model-choice"
import { DEFAULT_GATE, gateDigest } from "@vectordevai/core/review/eval-report"
import {
  assessReview,
  certificateProblems,
  certify,
  evidenceScope,
  MAX_CERTIFICATE_DAYS,
  MODEL_EVIDENCE,
  modelEvidenceNotes,
  policyDigest,
  promptsDigest,
  REVIEW_PIPELINE_REVISION,
  routedModel,
  type EvidenceScope,
  type ModelCertificate,
  type ModelSubject,
} from "@vectordevai/core/review/model-evidence"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"

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
    expect(evidenceScope({ adapter: "desktop", config: DEFAULT_REVIEW_CONFIG, triage: "acme/cheap" })).toMatchObject({
      adapter: "desktop",
      triage: "acme/cheap",
    })
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
    ])
      expect(policyDigest({ ...DEFAULT_REVIEW_CONFIG, ...change })).toBe(base)
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
