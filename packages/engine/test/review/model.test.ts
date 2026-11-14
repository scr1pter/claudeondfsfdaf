import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@vectordevai/core/model"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
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
  model("vector-plan/vector-flash"),
  model("vector-plan/vendor/coder", { input: 3, output: 15 }),
]

interface Setup {
  defaultModel?: string
  agent?: { model?: string; variant?: string }
  free?: boolean
  /** Free models listed ahead of the curated ones under Vector. */
  before?: Provider.Model[]
  oauth?: string[]
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
    TestConfig.layer({ get: () => Effect.succeed(setup.agent ? { agent: { review: setup.agent } } : {}) }),
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

  // Label plan §4.3 and C11: the review token stop and the Codium wording both read this kind.
  it.effect("a Vector Codium model is Codium whatever its listed price or sign-in", () =>
    Effect.gen(function* () {
      const workflow = yield* resolve({ trigger: "command", env: { MODEL: "vector-plan/vector-flash" } })
      expect(workflow.costKind).toBe("codium")
      expect(workflow.price).toBeUndefined()

      // A catalog price never makes Codium work a dollar review: no price, so no dollar cap and no estimate.
      const listed = yield* resolve({ trigger: "local", flag: "vector-plan/vendor/coder" })
      expect(listed.costKind).toBe("codium")
      expect(listed.price).toBeUndefined()

      // review.json's triageModel, resolved as `exact`, with an OAuth sign-in stored for the provider.
      const triage = yield* resolve({ trigger: "local", exact: "vector-plan/vector-flash" }, { oauth: ["vector-plan"] })
      expect(triage.costKind).toBe("codium")
      expect(triage.price).toBeUndefined()
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
