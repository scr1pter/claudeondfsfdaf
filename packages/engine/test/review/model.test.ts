import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@vectordevai/core/model"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"
import { assessReview, evidenceScope, modelEvidenceNotes } from "@vectordevai/core/review/model-evidence"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { ReviewModel } from "../../src/review/model"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const modalities = { text: true, audio: false, image: false, video: false, pdf: false }

function model(name: string, input: { context?: number; input?: number; output?: number; cacheRead?: number } = {}) {
  const ref = Provider.parseModel(name)
  return {
    id: ref.modelID,
    providerID: ref.providerID,
    api: { id: ref.modelID, url: "https://models.invalid/v1", npm: "@ai-sdk/openai-compatible" },
    name,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: modalities,
      output: modalities,
      interleaved: false,
    },
    cost: { input: input.input ?? 0, output: input.output ?? 0, cache: { read: input.cacheRead ?? 0, write: 0 } },
    limit: { context: input.context ?? 128_000, output: 8_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } satisfies Provider.Model
}

const MODELS = [
  model("acme/auto", { input: 1, output: 2 }),
  model("acme/json", { input: 1, output: 2 }),
  model("acme/env", { input: 1, output: 2 }),
  model("acme/flag", { input: 1, output: 2 }),
  model("acme/agent", { input: 1, output: 2 }),
  model("acme/default", { input: 1, output: 2 }),
  model("anthropic/sonnet", { input: 3, output: 15, cacheRead: 0.3 }),
  model("openai/gpt", { input: 1.25, output: 10, cacheRead: 0.125 }),
  model("local/unpriced"),
  model("ollama/qwen"),
  model("vector/acme/coder:free"),
  model("openrouter/acme/coder:free"),
  model("tiny/small", { context: 16_000, input: 1, output: 1 }),
  // Free models on a user's own OpenRouter account: one whose provider may train on prompts, and the free router.
  {
    ...model("openrouter/acme/learner:free"),
    freeModel: { source: "openrouter" as const, dataPolicy: "may-train" as const },
  },
  model("openrouter/openrouter/free"),
]

interface Setup {
  defaultModel?: string
  agent?: { model?: string; variant?: string }
  free?: boolean
  /** Free models listed ahead of the curated ones under Vector. */
  before?: Provider.Model[]
  oauth?: string[]
  vectorscope?: { model?: string; variant?: string; disable?: boolean }
  projectVectorscope?: { model?: string; variant?: string }
  globalModel?: string
  projectModel?: string
}

const services = (setup: Setup) =>
  Layer.mergeAll(
    Layer.mock(Provider.Service, {
      list: () =>
        Effect.succeed(
          setup.free
            ? {
                vector: {
                  id: ProviderV2.ID.make("vector"),
                  name: "Vector",
                  env: [],
                  source: "api" as const,
                  options: {},
                  models: Object.fromEntries(
                    [...(setup.before ?? []), ...MODELS.filter((item) => item.providerID === "vector")].map((item) => [
                      item.id,
                      item,
                    ]),
                  ),
                },
              }
            : {},
        ),
      // Only the ollama provider's server is one someone hosts: on this computer, so its steps have no per-token price.
      line: (model) =>
        Effect.succeed(
          model.providerID === "ollama" ? { origin: "http://127.0.0.1:11434", hosted: true, local: true } : undefined,
        ),
      getModel: (providerID, modelID) => {
        const found = MODELS.find((item) => item.providerID === providerID && item.id === modelID)
        return found ? Effect.succeed(found) : Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
      },
      defaultModel: () =>
        setup.defaultModel
          ? Effect.succeed(Provider.parseModel(setup.defaultModel))
          : Effect.fail(
              new Provider.ModelNotFoundError({
                providerID: ProviderV2.ID.make("none"),
                modelID: ModelV2.ID.make("none"),
              }),
            ),
    }),
    TestConfig.layer({
      get: () =>
        Effect.succeed({
          ...(setup.projectModel ? { model: setup.projectModel } : {}),
          agent: {
            ...(setup.agent ? { review: setup.agent } : {}),
            ...(setup.projectVectorscope ? { vectorscope: setup.projectVectorscope } : {}),
          },
        }),
      getGlobal: () =>
        Effect.succeed({
          ...(setup.globalModel ? { model: setup.globalModel } : {}),
          ...(setup.vectorscope ? { agent: { vectorscope: setup.vectorscope } } : {}),
        }),
    }),
    // The catalog lists acme and anthropic, whose key is not set in these tests; "retired" is in no catalog.
    Layer.mock(ModelCatalog.Service, {
      get: () =>
        Effect.succeed({
          acme: { id: "acme", name: "Acme", env: ["ACME_API_KEY"], models: {} },
          anthropic: {
            id: "anthropic",
            name: "Anthropic",
            env: ["ANTHROPIC_API_KEY"],
            models: {
              "claude-sonnet-4-5": { id: "claude-sonnet-4-5" },
              "claude-2": { id: "claude-2", status: "deprecated" },
            },
          },
        } as unknown as Record<string, ModelCatalog.Provider>),
    }),
    Layer.mock(Auth.Service, {
      get: (providerID) =>
        Effect.succeed(
          setup.oauth?.includes(providerID)
            ? new Auth.Oauth({
                type: "oauth",
                refresh: "refresh-placeholder",
                access: "access-placeholder",
                expires: 0,
              })
            : undefined,
        ),
    }),
  )

const resolve = (input: ReviewModel.ResolveInput, setup: Setup = {}) =>
  ReviewModel.resolveReviewModel(input).pipe(Effect.provide(services(setup)))

const chosen = (input: ReviewModel.ResolveInput, setup: Setup = {}) =>
  resolve(input, setup).pipe(Effect.map((resolved) => `${resolved.providerID}/${resolved.modelID}`))

describe("ReviewModel.resolveReviewModel order", () => {
  it.effect("automatic CI runs take REVIEW_AUTO_MODEL, then review.json, then MODEL", () =>
    Effect.gen(function* () {
      const env = { REVIEW_AUTO_MODEL: "acme/auto", MODEL: "acme/env" }
      expect(yield* chosen({ trigger: "auto", config: "acme/json", env })).toBe("acme/auto")
      expect(yield* chosen({ trigger: "auto", config: "acme/json", env: { MODEL: "acme/env" } })).toBe("acme/json")
      expect(yield* chosen({ trigger: "auto", env: { MODEL: "acme/env" } })).toBe("acme/env")
      // Project config and the user's default model play no part in CI.
      expect(
        (yield* resolve(
          { trigger: "auto", env: {} },
          { agent: { model: "acme/agent" }, defaultModel: "acme/default" },
        ).pipe(Effect.flip)).message,
      ).toContain("No review model is set")
    }),
  )

  it.effect("commands ignore REVIEW_AUTO_MODEL and agent.review.model", () =>
    Effect.gen(function* () {
      const env = { REVIEW_AUTO_MODEL: "acme/auto", MODEL: "acme/env" }
      expect(yield* chosen({ trigger: "command", env })).toBe("acme/env")
      expect(yield* chosen({ trigger: "command", config: "acme/json", env }, { agent: { model: "acme/agent" } })).toBe(
        "acme/json",
      )
      expect(
        (yield* resolve({ trigger: "command", env: { REVIEW_AUTO_MODEL: "acme/auto" } }).pipe(Effect.flip)).message,
      ).toContain("No review model is set")
    }),
  )

  it.effect("local runs take --model, review.json, agent.review.model, the default model", () =>
    Effect.gen(function* () {
      const env = { MODEL: "acme/env", REVIEW_AUTO_MODEL: "acme/auto" }
      const setup = { agent: { model: "acme/agent", variant: "high" }, defaultModel: "acme/default" }
      expect(yield* chosen({ trigger: "local", flag: "acme/flag", config: "acme/json", env }, setup)).toBe("acme/flag")
      expect(yield* chosen({ trigger: "local", config: "acme/json", env }, setup)).toBe("acme/json")
      const agent = yield* resolve({ trigger: "local", env }, setup)
      expect(`${agent.providerID}/${agent.modelID}`).toBe("acme/agent")
      expect(agent.variant).toBe("high")
      expect(yield* chosen({ trigger: "desktop", env }, { defaultModel: "acme/default" })).toBe("acme/default")
      expect((yield* resolve({ trigger: "local", env }).pipe(Effect.flip)).message).toContain("No review model is set")
    }),
  )
})

describe("VectorScope service model admission", () => {
  it.effect("uses the owner-only independent setting and ignores project and generic review overrides", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { trigger: "local", identity: "vectorscope" },
        {
          vectorscope: { model: "acme/agent", variant: "high" },
          projectVectorscope: { model: "acme/json", variant: "project-variant" },
          agent: { model: "acme/env", variant: "generic-variant" },
          defaultModel: "acme/default",
        },
      )
      expect(`${result.providerID}/${result.modelID}`).toBe("acme/agent")
      expect(result.variant).toBe("high")
      expect(result.subject?.choice).toEqual({ explicit: true, setting: "agent.vectorscope.model" })
    }),
  )

  it.effect("explicit and pinned models win without inheriting an agent variant for the same model ID", () =>
    Effect.gen(function* () {
      const setup = { vectorscope: { model: "acme/agent", variant: "high" } }
      for (const source of [{ flag: "acme/agent" }, { config: "acme/agent" }, { exact: "acme/agent" }]) {
        const result = yield* resolve({ trigger: "local", identity: "vectorscope", ...source }, setup)
        expect(`${result.providerID}/${result.modelID}`).toBe("acme/agent")
        expect(result.variant).toBeUndefined()
      }
    }),
  )

  it.effect("uses an owner default and refuses an ambient project default instead of silently selecting it", () =>
    Effect.gen(function* () {
      expect(
        yield* chosen(
          { trigger: "desktop", identity: "vectorscope" },
          { globalModel: "acme/default", projectModel: "acme/json" },
        ),
      ).toBe("acme/default")
      const refused = yield* resolve(
        { trigger: "local", identity: "vectorscope" },
        { projectModel: "acme/json", defaultModel: "acme/json" },
      ).pipe(Effect.flip)
      expect(refused.message).toContain("No VectorScope model is set")
      expect(yield* chosen({ trigger: "local", identity: "vectorscope" }, { defaultModel: "acme/default" })).toBe(
        "acme/default",
      )
    }),
  )

  it.effect("an explicit owner disable refuses before a selected model can run", () =>
    Effect.gen(function* () {
      const refused = yield* resolve(
        { trigger: "local", identity: "vectorscope", flag: "acme/flag" },
        { vectorscope: { disable: true } },
      ).pipe(Effect.flip)
      expect(refused.message).toBe("VectorScope is disabled in agent.vectorscope.")
    }),
  )
})

describe("ReviewModel.resolveReviewModel cost", () => {
  it.effect("tells subscription, unknown and priced models apart", () =>
    Effect.gen(function* () {
      const plan = yield* resolve({ trigger: "command", env: { MODEL: "anthropic/sonnet" } }, { oauth: ["anthropic"] })
      expect(plan.costKind).toBe("plan")
      expect(plan.price).toBeUndefined()

      const unknown = yield* resolve({ trigger: "command", env: { MODEL: "local/unpriced" } })
      expect(unknown.costKind).toBe("unknown")
      expect(unknown.price).toBeUndefined()

      const priced = yield* resolve({ trigger: "command", env: { MODEL: "openai/gpt" } })
      expect(priced.costKind).toBe("priced")
      expect(priced.price).toEqual({ input: 1.25, output: 10, cacheRead: 0.125 })
      expect(priced.context).toBe(128_000)

      // A server the provider counts as having no per-token price runs the review with no dollar checks.
      const local = yield* resolve({ trigger: "command", env: { MODEL: "ollama/qwen" } })
      expect(local.costKind).toBe("local")
      expect(local.price).toBeUndefined()
    }),
  )
})

describe("ReviewModel.resolveReviewModel refusals", () => {
  it.effect("refuses a model with less than 32k tokens of context", () =>
    Effect.gen(function* () {
      const error = yield* resolve({ trigger: "command", env: { MODEL: "tiny/small" } }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewModel.ReviewModelError)
      expect(error.message).toBe(
        "Vectorscope reviews need a model with at least 32k tokens of context; tiny/small has 16k.",
      )
    }),
  )

  it.effect("rejects a malformed or unavailable model instead of falling back", () =>
    Effect.gen(function* () {
      const malformed = yield* resolve({ trigger: "command", env: { MODEL: "nonsense" } }).pipe(Effect.flip)
      expect(malformed.message).toBe('Invalid model nonsense. Model must be in the format "provider/model".')
      const missing = yield* resolve({ trigger: "local", flag: "acme/missing" }).pipe(Effect.flip)
      expect(missing.message).toContain("acme/missing is not available")
    }),
  )
})

describe("free review defaults", () => {
  it.effect("uses an available free model for CI without MODEL or provider credentials", () =>
    Effect.gen(function* () {
      const result = yield* resolve({ trigger: "auto", env: { VECTOR_CLI_TOKEN: "test-only" } }, { free: true })
      expect(result.providerID).toBe(ProviderV2.ID.make("vector"))
      expect(result.modelID).toBe(ModelV2.ID.make("acme/coder:free"))
      expect(result.costKind).toBe("free")
      expect(result.price).toBeUndefined()
      expect(yield* chosen({ trigger: "auto", env: { MODEL: "acme/env" } }, { free: true })).toBe("acme/env")
    }),
  )
  it.effect("a workflow's model names the secret it is missing, or the model its provider does not have", () =>
    Effect.gen(function* () {
      const missingKey = yield* resolve({ trigger: "auto", env: { MODEL: "anthropic/claude-sonnet-4-5" } }).pipe(
        Effect.flip,
      )
      expect(missingKey.message).toBe(
        "anthropic/claude-sonnet-4-5 needs ANTHROPIC_API_KEY. Add it as a repository secret and pass it to the Review step in .github/workflows/vector.yml.",
      )
      const freeWithoutToken = yield* resolve({ trigger: "auto", env: { MODEL: "vector/acme/missing:free" } }).pipe(
        Effect.flip,
      )
      expect(freeWithoutToken.message).toBe(
        "vector/acme/missing:free needs the repository secret VECTOR_CLI_TOKEN. Create one at vectordev.ai/auth/cli.",
      )
      const freeNotOffered = yield* resolve({
        trigger: "auto",
        env: { MODEL: "vector/acme/missing:free", VECTOR_CLI_TOKEN: "test-only" },
      }).pipe(Effect.flip)
      expect(freeNotOffered.message).toBe(
        "vectordev.ai did not offer vector/acme/missing:free to this workflow. Check that the VECTOR_CLI_TOKEN secret is current, or set MODEL in .github/workflows/vector.yml to another model.",
      )
      const missingModel = yield* resolve({ trigger: "command", env: { MODEL: "acme/missing" } }).pipe(Effect.flip)
      expect(missingModel.message).toBe(
        "Acme has no model missing. Set MODEL in .github/workflows/vector.yml to one of its models, or run vector github install again.",
      )
    }),
  )
  it.effect("a workflow whose key is set is never told to add it", () =>
    Effect.gen(function* () {
      const key = { ANTHROPIC_API_KEY: "test-only" }
      const retired = yield* resolve({ trigger: "auto", env: { MODEL: "anthropic/claude-2", ...key } }).pipe(
        Effect.flip,
      )
      expect(retired.message).toBe(
        "Anthropic has retired claude-2. Set MODEL in .github/workflows/vector.yml to one of its current models.",
      )
      // A retired model stays retired whether or not its key is passed in.
      const retiredWithoutKey = yield* resolve({ trigger: "auto", env: { MODEL: "anthropic/claude-2" } }).pipe(
        Effect.flip,
      )
      expect(retiredWithoutKey.message).toBe(retired.message)
      const unloaded = yield* resolve({
        trigger: "auto",
        env: { MODEL: "anthropic/claude-sonnet-4-5", ...key },
      }).pipe(Effect.flip)
      expect(unloaded.message).toBe(
        "Vector could not load anthropic/claude-sonnet-4-5 in this workflow, although ANTHROPIC_API_KEY is set. Set MODEL in .github/workflows/vector.yml to another model.",
      )
      // An empty secret is a missing one: GitHub passes an unset secret as an empty string.
      const empty = yield* resolve({
        trigger: "auto",
        env: { MODEL: "anthropic/claude-sonnet-4-5", ANTHROPIC_API_KEY: " " },
      }).pipe(Effect.flip)
      expect(empty.message).toContain("needs ANTHROPIC_API_KEY. Add it as a repository secret")
    }),
  )
  it.effect("a workflow's refusal names the setting that chose the model", () =>
    Effect.gen(function* () {
      const fromConfig = yield* resolve({
        trigger: "command",
        config: "anthropic/claude-2",
        env: { MODEL: "anthropic/claude-sonnet-4-5" },
      }).pipe(Effect.flip)
      expect(fromConfig.message).toBe(
        "Anthropic has retired claude-2. Set model in .vector/review.json to one of its current models.",
      )
      const fromAuto = yield* resolve({
        trigger: "auto",
        env: { REVIEW_AUTO_MODEL: "acme/missing", MODEL: "anthropic/claude-sonnet-4-5" },
      }).pipe(Effect.flip)
      expect(fromAuto.message).toBe(
        "Acme has no model missing. Set REVIEW_AUTO_MODEL in .github/workflows/vector.yml to one of its models.",
      )
      const freeFromConfig = yield* resolve({
        trigger: "command",
        config: "vector/acme/missing:free",
        env: { VECTOR_CLI_TOKEN: "test-only" },
      }).pipe(Effect.flip)
      expect(freeFromConfig.message).toBe(
        "vectordev.ai did not offer vector/acme/missing:free to this workflow. Check that the VECTOR_CLI_TOKEN secret is current, or set model in .vector/review.json to another model.",
      )
      // Reinstalling the workflow rewrites MODEL only, so it is no fix for a model review.json chose.
      const unlisted = yield* resolve({ trigger: "command", config: "retired/model" }).pipe(Effect.flip)
      expect(unlisted.message).toBe(
        "Vector does not list the provider of retired/model. Set model in .vector/review.json to a current model.",
      )
    }),
  )
  it.effect("an unattended review never picks a free model whose provider may train on prompts", () =>
    Effect.gen(function* () {
      const trainer = {
        ...model("vector/acme/trainer:free"),
        freeModel: { source: "shared" as const, dataPolicy: "may-train" as const },
      }
      const result = yield* resolve(
        { trigger: "auto", env: { VECTOR_CLI_TOKEN: "test-only" } },
        { free: true, before: [trainer] },
      )
      expect(result.modelID).toBe(ModelV2.ID.make("acme/coder:free"))
    }),
  )
  it.effect("marks direct OpenRouter free variants free and explains obsolete workflow models", () =>
    Effect.gen(function* () {
      expect((yield* resolve({ trigger: "local", flag: "openrouter/acme/coder:free" })).costKind).toBe("free")
      expect((yield* resolve({ trigger: "command", env: { MODEL: "retired/model" } }).pipe(Effect.flip)).message).toBe(
        "This workflow was set up by an older Vector; run vector github install again.",
      )
    }),
  )
})

describe("model evidence (VS-07)", () => {
  const SCOPE = evidenceScope({ adapter: "engine", config: DEFAULT_REVIEW_CONFIG })
  const NOW = Date.parse("2026-11-04T12:00:00Z")

  it.effect("the resolver says which setting chose the model, or which default it fell back to", () =>
    Effect.gen(function* () {
      const env = { MODEL: "acme/env", REVIEW_AUTO_MODEL: "acme/auto" }
      const setup = { agent: { model: "acme/agent", variant: "high" }, defaultModel: "acme/default" }
      expect((yield* resolve({ trigger: "local", flag: "acme/flag", env }, setup)).subject).toEqual({
        model: "acme/flag",
        free: false,
        status: "active",
        choice: { explicit: true, setting: "--model" },
      })
      expect((yield* resolve({ trigger: "local", env }, setup)).subject).toEqual({
        model: "acme/agent",
        variant: "high",
        free: false,
        status: "active",
        choice: { explicit: true, setting: "agent.review.model" },
      })
      expect((yield* resolve({ trigger: "desktop", env }, { defaultModel: "acme/default" })).subject?.choice).toEqual({
        explicit: false,
        setting: "your default model",
      })
      expect((yield* resolve({ trigger: "auto", config: "acme/json", env })).subject?.choice).toEqual({
        explicit: true,
        setting: "REVIEW_AUTO_MODEL in .github/workflows/vector.yml",
      })
      expect((yield* resolve({ trigger: "command", config: "acme/json", env })).subject?.choice).toEqual({
        explicit: true,
        setting: "model in .vector/review.json",
      })
      expect((yield* resolve({ trigger: "local", exact: "acme/json", env })).subject?.choice).toEqual({
        explicit: true,
        setting: "triageModel in .vector/review.json",
      })
      // An unattended review without a model falls back to a free one that does not train on prompts, and says so.
      expect(
        (yield* resolve({ trigger: "auto", env: { VECTOR_CLI_TOKEN: "test-only" } }, { free: true })).subject,
      ).toEqual({
        model: "vector/acme/coder:free",
        free: true,
        status: "active",
        choice: { explicit: false, setting: 'an available free model not labelled "May train on your prompts"' },
      })
      // A free model's data policy comes from Vector's record, as everywhere else.
      expect((yield* resolve({ trigger: "local", flag: "openrouter/acme/learner:free" })).subject).toMatchObject({
        free: true,
        freeModel: { source: "openrouter", dataPolicy: "may-train" },
      })
    }),
  )

  it.effect("evidence changes no choice: every model resolves the same with it on, and none is replaced", () =>
    Effect.gen(function* () {
      const env = { MODEL: "acme/env", REVIEW_AUTO_MODEL: "acme/auto", VECTOR_CLI_TOKEN: "test-only" }
      const setup = { agent: { model: "acme/agent", variant: "high" }, defaultModel: "acme/default", free: true }
      const requests: ReviewModel.ResolveInput[] = [
        { trigger: "auto", env },
        { trigger: "auto", env: { VECTOR_CLI_TOKEN: "test-only" } },
        { trigger: "command", config: "acme/json", env },
        { trigger: "local", flag: "acme/flag", env },
        { trigger: "local", env },
        { trigger: "local", exact: "acme/json", env },
        { trigger: "local", flag: "openrouter/openrouter/free" },
        { trigger: "local", flag: "openrouter/acme/learner:free" },
      ]
      for (const request of requests)
        expect(yield* resolve({ ...request, evidence: true }, setup)).toEqual(yield* resolve(request, setup))
    }),
  )

  it.effect(
    "with evidence on, a local model its provider retired is refused as retired; off, the message is today's",
    () =>
      Effect.gen(function* () {
        const off = yield* resolve({ trigger: "local", flag: "anthropic/claude-2" }).pipe(Effect.flip)
        expect(off.message).toBe("anthropic/claude-2 is not available. Check the provider and its key.")
        const on = yield* resolve({ trigger: "local", flag: "anthropic/claude-2", evidence: true }).pipe(Effect.flip)
        expect(on.message).toBe("Anthropic has retired claude-2. Set --model to one of its current models.")
        const triage = yield* resolve({ trigger: "local", exact: "anthropic/claude-2", evidence: true }).pipe(
          Effect.flip,
        )
        expect(triage.message).toBe(
          "Anthropic has retired claude-2. Set triageModel in .vector/review.json to one of its current models.",
        )
        // A model that is only unavailable stays unavailable: nothing falls back to another model.
        const missing = yield* resolve({ trigger: "local", flag: "anthropic/claude-sonnet-4-5", evidence: true }).pipe(
          Effect.flip,
        )
        expect(missing.message).toBe("anthropic/claude-sonnet-4-5 is not available. Check the provider and its key.")
        // A workflow already says a model is retired, with or without evidence.
        const ci = yield* resolve({ trigger: "auto", env: { MODEL: "anthropic/claude-2" }, evidence: true }).pipe(
          Effect.flip,
        )
        expect(ci.message).toBe(
          "Anthropic has retired claude-2. Set MODEL in .github/workflows/vector.yml to one of its current models.",
        )
      }),
  )

  it.effect("what the resolved models' evidence says: unvetted, a router, and a free model that may train", () =>
    Effect.gen(function* () {
      const notes = (subject: ReviewModel.ResolvedModel["subject"]) =>
        modelEvidenceNotes(assessReview({ review: subject!, scope: SCOPE, now: NOW }))
      expect(notes((yield* resolve({ trigger: "local", flag: "acme/flag" })).subject)).toEqual([
        "`acme/flag` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Vector used it because --model names it, and does not switch a chosen model.",
      ])
      expect(notes((yield* resolve({ trigger: "local", flag: "openrouter/openrouter/free" })).subject)).toEqual([
        "`openrouter/openrouter/free` is a router: each request may be answered by a different model, so no evaluation applies to it. Vector used it because --model names it, and does not switch a chosen model.",
      ])
      expect(notes((yield* resolve({ trigger: "local", flag: "openrouter/acme/learner:free" })).subject)).toEqual([
        '`openrouter/acme/learner:free` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Being free is not evidence of review quality. `openrouter/acme/learner:free` is labelled "May train on your prompts": its provider may log the code it is sent and use it to train models. Don\'t use it for private code. Vector used it because --model names it, and does not switch a chosen model.',
      ])
      const fallback = yield* resolve({ trigger: "auto", env: { VECTOR_CLI_TOKEN: "test-only" } }, { free: true })
      expect(notes(fallback.subject)).toEqual([
        '`vector/acme/coder:free` has no VectorScope evaluation on record, so how well it reviews is unmeasured. Being free is not evidence of review quality. No review model is set, so Vector used an available free model not labelled "May train on your prompts".',
      ])
    }),
  )
})
