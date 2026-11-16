import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { decideRoute, type RouteDecision, type RouteRefusal } from "@vectordevai/core/review/privacy"
import type { ZdrAttestedEntry } from "@vectordevai/core/review/types"
import { Provider } from "@/provider/provider"
import { ReviewRoutes } from "../../src/review/route"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// VS-23b (SF-11): what admission reads from the provider for the route rules (core privacy.ts), and the session
// registry Review.run admits each provider attempt against. The provider is a mock here; run.test.ts covers the real
// one inside Review.run.

const it = testEffect(Layer.empty)

const modalities = { text: true, audio: false, image: false, video: false, pdf: false }

function model(
  name: string,
  api: { url?: string; npm?: string; id?: string } = {},
  cost: Partial<Provider.Model["cost"]> = { input: 1, output: 2 },
): Provider.Model {
  const ref = Provider.parseModel(name)
  return {
    id: ref.modelID,
    providerID: ref.providerID,
    api: {
      id: api.id ?? ref.modelID,
      url: api.url ?? "",
      npm: api.npm ?? "@ai-sdk/openai-compatible",
    },
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
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, ...cost },
    limit: { context: 128_000, output: 8_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  }
}

const zdr = (attested: readonly ZdrAttestedEntry[] = []): ReviewRoutes.Policy => ({ privacy: "zdr", attested })
const decision = (input: Parameters<typeof ReviewRoutes.routeModel>[0], attested: readonly ZdrAttestedEntry[] = []) =>
  decideRoute(ReviewRoutes.routeModel(input), zdr(attested))
const refusal = (refusal: RouteRefusal): RouteDecision => ({ allowed: false, refusal })
const LOOPBACK = { origin: "http://127.0.0.1:1234", hosted: true, local: true }

describe("ReviewRoutes.policyOf", () => {
  test("reads privacy and zdrAttested, standard and none when unset", () => {
    expect(ReviewRoutes.policyOf({})).toEqual({ privacy: "standard", attested: [] })
    expect(ReviewRoutes.policyOf({ privacy: "zdr", zdrAttested: ["anthropic"] })).toEqual({
      privacy: "zdr",
      attested: ["anthropic"],
    })
  })
})

describe("ReviewRoutes.shippedOrigins", () => {
  const catalog = {
    acme: {
      id: "acme",
      name: "Acme",
      env: [],
      api: "https://api.acme.invalid/v1",
      models: { coder: { id: "coder" }, edge: { id: "edge", provider: { api: "https://edge.acme.invalid/v1" } } },
    },
    bare: { id: "bare", name: "Bare", env: [], models: { coder: { id: "coder" } } },
  } as unknown as Parameters<typeof ReviewRoutes.shippedOrigins>[0]["catalog"]
  const shipped = (providerID: string, modelID: string, configured: boolean, from = catalog) =>
    ReviewRoutes.shippedOrigins({ catalog: from, configured, providerID, modelID })

  test("a listed provider is shipped at its model's URL, else its own, else nowhere known", () => {
    expect(shipped("acme", "edge", true)).toEqual(["https://edge.acme.invalid/v1"])
    expect(shipped("acme", "coder", false)).toEqual(["https://api.acme.invalid/v1"])
    // A model the catalog does not list takes the provider's URL.
    expect(shipped("acme", "unlisted", false)).toEqual(["https://api.acme.invalid/v1"])
    expect(shipped("bare", "coder", true)).toBeUndefined()
  })

  test("only the configuration's word makes an unlisted provider one defined in configuration", () => {
    expect(shipped("mine", "coder", true)).toEqual([])
    // Only a plugin defines it, or nothing does.
    expect(shipped("mine", "coder", false)).toBeUndefined()
  })

  test("a catalog that did not load says nothing, configured or not", () => {
    expect(shipped("acme", "coder", true, {})).toBeUndefined()
    expect(shipped("mine", "coder", true, {})).toBeUndefined()
  })
})

describe("ReviewRoutes.routeModel with the route rules", () => {
  test("a server on this computer is allowed as loopback, wherever the catalog ships the provider", () => {
    const found = model("lmstudio/test-model")
    const input = { providerID: "lmstudio", modelID: "test-model", found, line: LOOPBACK }
    expect(decision({ ...input, options: { baseURL: "http://127.0.0.1:1234/v1" } })).toEqual({
      allowed: true,
      kind: "loopback",
    })
    expect(decision({ ...input, options: { baseURL: "http://localhost:1234/v1" }, catalogOrigins: [] })).toEqual({
      allowed: true,
      kind: "loopback",
    })
  })

  test("an SDK's own origin is the provider's: an attested provider is allowed there, and nowhere else", () => {
    const found = model("anthropic/claude-sonnet-4-5", { npm: "@ai-sdk/anthropic" }, { input: 3, output: 15 })
    const input = { providerID: "anthropic", modelID: "claude-sonnet-4-5", found }
    expect(ReviewRoutes.routeModel(input)).toMatchObject({
      destinations: ["https://api.anthropic.com"],
      defaultOrigins: ["https://api.anthropic.com"],
    })
    expect(decision(input, ["anthropic"])).toEqual({ allowed: true, kind: "attested-provider" })
    expect(decision(input)).toEqual(refusal("unattested-provider"))
    // A base URL configured anywhere else needs its own host attested.
    const moved = { ...input, options: { baseURL: "https://proxy.example.invalid/v1" } }
    expect(decision(moved, ["anthropic"])).toEqual(refusal("unattested-provider"))
    expect(decision(moved, ["anthropic", "proxy.example.invalid"])).toEqual({ allowed: true, kind: "attested-host" })
  })

  test("the catalog's shipped URL is the provider's origin; unknown, the provider attests no host", () => {
    const found = model("acme/coder", { url: "https://api.acme.invalid/v1" })
    const input = { providerID: "acme", modelID: "coder", found }
    expect(decision({ ...input, catalogOrigins: ["https://api.acme.invalid/v1"] }, ["acme"])).toEqual({
      allowed: true,
      kind: "attested-provider",
    })
    expect(decision(input, ["acme"])).toEqual(refusal("unattested-provider"))
    expect(decision(input, ["api.acme.invalid"])).toEqual({ allowed: true, kind: "attested-host" })
    const moved = {
      ...input,
      catalogOrigins: ["https://api.acme.invalid/v1"],
      options: { baseURL: "https://x.invalid" },
    }
    expect(decision(moved, ["acme"])).toEqual(refusal("unattested-provider"))
  })

  test("a direct provider moved to OpenRouter holds no OpenRouter account unless it is one defined in configuration", () => {
    const found = model("deepseek/chat", { url: "https://api.deepseek.invalid/v1" })
    const input = {
      providerID: "deepseek",
      modelID: "chat",
      found,
      options: { baseURL: "https://openrouter.ai/api/v1" },
    }
    // The shipped origin unknown (a model from the eval, the GitHub job, connect or the runner's own picks).
    expect(decision(input, ["deepseek"])).toEqual(refusal("unattested-openrouter"))
    // Shipped elsewhere.
    expect(decision({ ...input, catalogOrigins: ["https://api.deepseek.invalid/v1"] }, ["deepseek"])).toEqual(
      refusal("unattested-openrouter"),
    )
    // Not in the catalog: a provider defined in configuration, whose attestation is the owner's OpenRouter account.
    expect(decision({ ...input, catalogOrigins: [] }, ["deepseek"])).toEqual({
      allowed: true,
      kind: "openrouter-attested",
    })
  })

  test("a server on your network needs its host attested", () => {
    const found = model("gpu/qwen")
    const input = { providerID: "gpu", modelID: "qwen", found, options: { baseURL: "http://gpu-box:8080/v1" } }
    expect(decision(input)).toEqual(refusal("unattested-network-server"))
    expect(decision(input, ["gpu-box"])).toEqual({ allowed: true, kind: "attested-host" })
    // An Ollama cloud model passes requests on to ollama.com, attested host or not.
    const cloud = { ...input, found: model("gpu/gpt-oss:120b-cloud"), modelID: "gpt-oss:120b-cloud" }
    expect(decision(cloud, ["gpu-box"])).toEqual(refusal("unknown-destination"))
  })

  test("what admission cannot read is an unknown destination: a variable URL, a provider's own fetch, a forwarding server", () => {
    const azure = model("azure/gpt", { url: "https://${AZURE_RESOURCE_NAME}.openai.azure.com/openai" })
    const template = ["https://${AZURE_RESOURCE_NAME}.openai.azure.com/openai"]
    expect(
      decision({ providerID: "azure", modelID: "gpt", found: azure, catalogOrigins: template }, ["azure"]),
    ).toEqual(refusal("unknown-destination"))
    const found = model("lmstudio/test-model")
    const local = { providerID: "lmstudio", modelID: "test-model", found }
    expect(decision({ ...local, options: { baseURL: "http://127.0.0.1:1234/v1", fetch: () => undefined } })).toEqual(
      refusal("unknown-destination"),
    )
    expect(decision({ ...local, options: { baseURL: "http://127.0.0.1:1234/v1", forwards: true } })).toEqual(
      refusal("unknown-destination"),
    )
    // A server on this computer whose steps are not free is one Check models found passes requests on.
    expect(
      decision({ ...local, options: { baseURL: "http://127.0.0.1:1234/v1" }, line: { ...LOOPBACK, local: false } }),
    ).toEqual(refusal("unknown-destination"))
    // A model with no URL and an SDK that names none.
    const bedrock = model("amazon-bedrock/claude", { npm: "@ai-sdk/amazon-bedrock" })
    expect(decision({ providerID: "amazon-bedrock", modelID: "claude", found: bedrock }, ["amazon-bedrock"])).toEqual(
      refusal("unknown-destination"),
    )
  })

  test("a plugin's preconnect origin is a destination too", () => {
    const found = model("lmstudio/test-model")
    expect(
      decision({
        providerID: "lmstudio",
        modelID: "test-model",
        found,
        options: { baseURL: "http://127.0.0.1:1234/v1", preconnect: "https://chatgpt.com" },
        line: LOOPBACK,
      }),
    ).toEqual(refusal("unattested-provider"))
  })

  test("the model's own refusals need no provider: free, Codium, a router, a Covered Model", () => {
    const policy = zdr(["openrouter", "anthropic", "acme"])
    expect(ReviewRoutes.modelRefusal({ providerID: "acme", modelID: "coder", costKind: "free" }, policy)).toBe(
      "free-model",
    )
    expect(ReviewRoutes.modelRefusal({ providerID: "vector", modelID: "acme/coder:free" }, policy)).toBe("free-model")
    expect(ReviewRoutes.modelRefusal({ providerID: "openrouter", modelID: "acme/coder:free" }, policy)).toBe(
      "free-model",
    )
    expect(ReviewRoutes.modelRefusal({ providerID: "vector-plan", modelID: "vector-flash" }, policy)).toBe(
      "codium-unaccepted",
    )
    expect(ReviewRoutes.modelRefusal({ providerID: "openrouter", modelID: "openrouter/auto" }, policy)).toBe(
      "router-or-preset",
    )
    expect(ReviewRoutes.modelRefusal({ providerID: "anthropic", modelID: "claude-fable-5" }, policy)).toBe(
      "retention-required-model",
    )
    // Only where its requests go can decide the rest, and "standard" decides nothing.
    expect(ReviewRoutes.modelRefusal({ providerID: "acme", modelID: "coder" }, policy)).toBeUndefined()
    expect(
      ReviewRoutes.modelRefusal({ providerID: "vector", modelID: "x:free" }, { privacy: "standard", attested: [] }),
    ).toBeUndefined()
  })

  test("a zero-priced model on OpenRouter is a free one", () => {
    const found = model("openrouter/acme/coder", { url: "https://openrouter.ai/api/v1" }, { input: 0, output: 0 })
    expect(decision({ providerID: "openrouter", modelID: "acme/coder", found }, ["openrouter"])).toEqual(
      refusal("free-model"),
    )
    const priced = model("openrouter/acme/coder", { url: "https://openrouter.ai/api/v1" })
    expect(decision({ providerID: "openrouter", modelID: "acme/coder", found: priced }, ["openrouter"])).toEqual({
      allowed: true,
      kind: "openrouter-attested",
    })
  })
})

// The provider as decide asks it: one model list, one provider's options, and no line.
const provider = (input: { models: Provider.Model[]; options?: Record<string, unknown>; asked: string[] }) =>
  Layer.mock(Provider.Service, {
    getModel: (providerID, modelID) => {
      input.asked.push(`${providerID}/${modelID}`)
      const found = input.models.find((item) => item.providerID === providerID && item.id === modelID)
      return found ? Effect.succeed(found) : Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
    },
    getProvider: (providerID) =>
      Effect.succeed({
        id: providerID,
        name: providerID,
        source: "config" as const,
        env: [],
        options: input.options ?? {},
        models: {},
      }),
    line: () => Effect.succeed(undefined),
  })
const decide = (
  name: string,
  policy: ReviewRoutes.Policy,
  setup: { models: Provider.Model[]; options?: Record<string, unknown>; asked: string[] },
  subject: Partial<ReviewRoutes.Subject> = {},
) =>
  Effect.gen(function* () {
    const service = yield* Provider.Service
    const ref = Provider.parseModel(name)
    return yield* ReviewRoutes.decide(service, { ...subject, providerID: ref.providerID, modelID: ref.modelID }, policy)
  }).pipe(Effect.provide(provider(setup)))

describe("ReviewRoutes.decide", () => {
  const anthropic = model("anthropic/claude-sonnet-4-5", { npm: "@ai-sdk/anthropic" })

  it.effect("decides the model's own refusals without asking the provider for it", () =>
    Effect.gen(function* () {
      const asked: string[] = []
      const setup = { models: [], asked }
      expect((yield* decide("vector-plan/vector-flash", zdr(), setup)).decision).toEqual(refusal("codium-unaccepted"))
      expect((yield* decide("vector/acme/coder:free", zdr(), setup)).decision).toEqual(refusal("free-model"))
      expect((yield* decide("acme/coder", zdr(), setup, { costKind: "free" })).decision).toEqual(refusal("free-model"))
      expect((yield* decide("anthropic/claude-mythos-5", zdr(["anthropic"]), setup)).decision).toEqual(
        refusal("retention-required-model"),
      )
      // Under "standard" nothing is asked either.
      expect(
        (yield* decide("anthropic/claude-sonnet-4-5", { privacy: "standard", attested: [] }, setup)).decision,
      ).toEqual({ allowed: true, kind: "standard" })
      expect(asked).toEqual([])
    }),
  )

  it.effect("a model the provider does not have is an unknown destination, decided for no model", () =>
    Effect.gen(function* () {
      const asked: string[] = []
      const decided = yield* decide("acme/missing", zdr(["acme"]), { models: [], asked })
      expect(decided).toEqual({ decision: refusal("unknown-destination") })
      expect(asked).toEqual(["acme/missing"])
    }),
  )

  it.effect("an attestation that asks Vector to check the account is refused until a verifier exists (Q20)", () =>
    Effect.gen(function* () {
      const setup = { models: [anthropic], asked: [] }
      const checked = { id: "anthropic", operator: "anthropic", verify: "api" as const }
      expect((yield* decide("anthropic/claude-sonnet-4-5", zdr([checked]), setup)).decision).toEqual(
        refusal("attestation-unverified"),
      )
      // An OpenAI attestation with `verify: "api"` gets the same refusal.
      const openai = model("openai/gpt-5", { npm: "@ai-sdk/openai" })
      expect(
        (yield* decide("openai/gpt-5", zdr([{ id: "openai", operator: "openai", verify: "api" }]), {
          models: [openai],
          asked: [],
        })).decision,
      ).toEqual(refusal("attestation-unverified"))
      // The owner's own statement, as text or as an object, is allowed, with the objects it rests on listed.
      const attested = { id: "anthropic", operator: "anthropic" }
      expect((yield* decide("anthropic/claude-sonnet-4-5", zdr([attested]), setup)).decision).toEqual({
        allowed: true,
        kind: "attested-provider",
        attestations: [attested],
      })
      const text = yield* decide("anthropic/claude-sonnet-4-5", zdr(["anthropic"]), setup)
      expect(text.decision).toEqual({ allowed: true, kind: "attested-provider" })
      expect(text.key).toBeString()
    }),
  )

  it.effect("reads the provider's options: a base URL moved elsewhere, and a provider's own fetch", () =>
    Effect.gen(function* () {
      const moved = { models: [anthropic], options: { baseURL: "https://proxy.example.invalid" }, asked: [] }
      expect((yield* decide("anthropic/claude-sonnet-4-5", zdr(["anthropic"]), moved)).decision).toEqual(
        refusal("unattested-provider"),
      )
      const fetching = { models: [anthropic], options: { fetch: () => undefined }, asked: [] }
      expect((yield* decide("anthropic/claude-sonnet-4-5", zdr(["anthropic"]), fetching)).decision).toEqual(
        refusal("unknown-destination"),
      )
    }),
  )
})

describe("ReviewRoutes session registry", () => {
  const session = (suffix: string) => SessionID.make(`ses_routetest${suffix}`)
  const found = model("lmstudio/test-model")
  const local = { models: [found], options: { baseURL: "http://127.0.0.1:1234/v1" }, asked: [] }

  test("registers, reads and releases a session's entry", () => {
    const id = session("a")
    const entry = { policy: zdr(), key: "key", decision: { allowed: true as const, kind: "loopback" as const } }
    ReviewRoutes.register(id, entry)
    expect(ReviewRoutes.registered(id)).toEqual(entry)
    ReviewRoutes.release(id)
    expect(ReviewRoutes.registered(id)).toBeUndefined()
  })

  it.effect("admits an attempt only on the model its session was decided for", () =>
    Effect.gen(function* () {
      const decided = yield* decide("lmstudio/test-model", zdr(), local)
      expect(decided.decision).toEqual({ allowed: true, kind: "loopback" })
      const id = session("b")
      ReviewRoutes.register(id, { policy: zdr(), key: decided.key, decision: decided.decision })
      expect(ReviewRoutes.attempt(id, found)).toBeUndefined()
      // A switch of model, URL, SDK or provider is not the model the session was decided for.
      expect(ReviewRoutes.attempt(id, { ...found, id: ModelV2.ID.make("other-model") })).toBe("unknown-destination")
      expect(ReviewRoutes.attempt(id, { ...found, api: { ...found.api, url: "https://moved.invalid/v1" } })).toBe(
        "unknown-destination",
      )
      expect(ReviewRoutes.attempt(id, { ...found, api: { ...found.api, npm: "@ai-sdk/openai" } })).toBe(
        "unknown-destination",
      )
      expect(ReviewRoutes.attempt(id, { ...found, providerID: ProviderV2.ID.make("other") })).toBe(
        "unknown-destination",
      )
      ReviewRoutes.release(id)
    }),
  )

  it.effect(
    "a refused decision gives its refusal; an unregistered or undecided session is unknown; standard admits",
    () =>
      Effect.gen(function* () {
        const elsewhere = { ...local, options: { baseURL: "https://elsewhere.example.invalid/v1" } }
        const decided = yield* decide("lmstudio/test-model", zdr(), elsewhere)
        expect(decided.decision).toEqual(refusal("unattested-provider"))
        const id = session("c")
        ReviewRoutes.register(id, { policy: zdr(), key: decided.key, decision: decided.decision })
        expect(ReviewRoutes.attempt(id, found)).toBe("unattested-provider")
        ReviewRoutes.register(id, { policy: zdr() })
        expect(ReviewRoutes.attempt(id, found)).toBe("unknown-destination")
        ReviewRoutes.register(id, { policy: { privacy: "standard", attested: [] } })
        expect(ReviewRoutes.attempt(id, found)).toBeUndefined()
        ReviewRoutes.release(id)
        expect(ReviewRoutes.attempt(id, found)).toBe("unknown-destination")
      }),
  )
})
