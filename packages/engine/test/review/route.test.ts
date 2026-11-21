import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { decideRoute, zdrRequestBody, type RouteDecision, type RouteRefusal } from "@vectordevai/core/review/privacy"
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
  // The registry is process-global: every session a case names is released after it, whatever the case does.
  const named: SessionID[] = []
  const session = (suffix: string) => {
    const id = SessionID.make(`ses_routetest${suffix}`)
    named.push(id)
    return id
  }
  afterEach(() => named.splice(0).forEach((id) => ReviewRoutes.release(id)))
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

// VS-23c (SF-12a): the transport backstop provider.ts calls in every model call's fetch: hold decides a call of a
// session registered under "zdr" again, on what admission decided on and what the transport sees, and sendBody checks
// or rewrites its final body. zdr-route.test.ts covers the same through provider.ts's fetches.
describe("ReviewRoutes.hold", () => {
  // The registry is process-global: every session a case names is released after it, whatever the case does.
  const named: SessionID[] = []
  const session = (suffix: string) => {
    const id = SessionID.make(`ses_holdtest${suffix}`)
    named.push(id)
    return id
  }
  afterEach(() => named.splice(0).forEach((id) => ReviewRoutes.release(id)))
  const local = model("lmstudio/test-model")
  const anthropic = model("anthropic/claude-sonnet-4-5", { npm: "@ai-sdk/anthropic" })
  const LOOPBACK_OPTIONS = { baseURL: "http://127.0.0.1:1234/v1" }
  const hold = (
    id: string | undefined,
    found: Provider.Model,
    options: Record<string, unknown> = {},
    destinations: string[] = [],
  ) =>
    ReviewRoutes.hold({
      session: () => (id === "none" ? undefined : { id }),
      model: found,
      options,
      destinations: () => destinations,
    })
  // A session registered from the real admission (decide), over a provider with these options.
  const admit = (id: SessionID, found: Provider.Model, policy: ReviewRoutes.Policy, options = {}, subject = {}) =>
    Effect.gen(function* () {
      const decided = yield* decide(
        `${found.providerID}/${found.id}`,
        policy,
        { models: [found], options, asked: [] },
        subject,
      )
      ReviewRoutes.register(id, { policy, ...decided })
      return decided
    })

  // A "zdr" session released earlier in this process (another case, or another file in the same process) makes hold
  // read the header, so only the destinations are asserted unread.
  test("no review registered: nothing is held and the call's destinations are never read", () => {
    const read: string[] = []
    const held = ReviewRoutes.hold({
      session: () => {
        read.push("header")
        return { id: "ses_whatever" }
      },
      model: local,
      options: LOOPBACK_OPTIONS,
      destinations: () => {
        read.push("destinations")
        return []
      },
    })
    expect(held).toBeUndefined()
    expect(read).not.toContain("destinations")
  })

  it.effect(
    "the owner's calls, unregistered and standard sessions are not held; a malformed header only under zdr",
    () =>
      Effect.gen(function* () {
        const standard = session("standard")
        ReviewRoutes.register(standard, { policy: { privacy: "standard", attested: [] } })
        expect(hold("none", local, LOOPBACK_OPTIONS)).toBeUndefined()
        expect(hold("ses_holdtestunregistered", local, LOOPBACK_OPTIONS)).toBeUndefined()
        expect(hold(standard, local, LOOPBACK_OPTIONS)).toBeUndefined()
        expect(hold(undefined, local, LOOPBACK_OPTIONS)).toBeUndefined()
        const id = session("zdr")
        yield* admit(id, local, zdr(), LOOPBACK_OPTIONS)
        expect(hold(undefined, local, LOOPBACK_OPTIONS)).toEqual({ refusal: "unattributed-request" })
        expect(hold(id, local, LOOPBACK_OPTIONS, ["http://127.0.0.1:1234/v1/chat/completions"])).toEqual({
          kind: "loopback",
        })
      }),
  )

  it.effect("SF-26 private card retries hold the original endpoint and final origin", () =>
    Effect.gen(function* () {
      const id = session("private-cards")
      const policy = zdr()
      const decided = yield* admit(id, local, policy, LOOPBACK_OPTIONS)
      ReviewRoutes.register(id, { policy, ...decided, pinDestinations: true })
      const url = "http://127.0.0.1:1234/v1/chat/completions"
      expect(hold(id, local, LOOPBACK_OPTIONS, [url])).toEqual({ kind: "loopback" })
      expect(hold(id, local, LOOPBACK_OPTIONS, [url.replace(":1234", ":1235")])).toEqual({
        refusal: "unknown-destination",
      })
      expect(hold(id, local, { ...LOOPBACK_OPTIONS, baseURL: "http://127.0.0.1:1234/other" }, [url])).toEqual({
        refusal: "unknown-destination",
      })
    }),
  )

  it.effect(
    "decide keeps what it decided on, and an attested provider holds only with admission's defaultOrigins",
    () =>
      Effect.gen(function* () {
        const id = session("attested")
        const decided = yield* admit(id, anthropic, zdr(["anthropic"]))
        expect(decided.decidedOn).toEqual(
          ReviewRoutes.routeModel({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-5",
            found: anthropic,
            options: {},
            line: undefined,
          }),
        )
        const sent = ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages"]
        expect(hold(id, anthropic, {}, sent)).toEqual({ kind: "attested-provider" })
        // Registered without what admission decided on, the provider's origins are unknown, so its attestation covers
        // no host.
        ReviewRoutes.register(id, { policy: zdr(["anthropic"]), key: decided.key, decision: decided.decision })
        expect(hold(id, anthropic, {}, sent)).toEqual({ refusal: "unattested-provider" })
      }),
  )

  it.effect("every origin either side saw must be allowed, and the transport's own decision comes first", () =>
    Effect.gen(function* () {
      const id = session("union")
      // Admission saw a plugin's preconnect origin off this computer, which a host attestation allows; the
      // transport no longer sees it, and the union still needs it allowed.
      const options = { ...LOOPBACK_OPTIONS, preconnect: "https://relay.example.invalid" }
      const decided = yield* admit(id, local, zdr(["relay.example.invalid"]), options)
      expect(decided.decision).toEqual({ allowed: true, kind: "attested-host" })
      expect(hold(id, local, LOOPBACK_OPTIONS)).toEqual({ kind: "attested-host" })
      ReviewRoutes.register(id, { ...ReviewRoutes.registered(id)!, policy: zdr() })
      expect(hold(id, local, LOOPBACK_OPTIONS)).toEqual({ refusal: "unattested-provider" })
      // The transport sees a destination admission did not.
      yield* admit(id, local, zdr(), LOOPBACK_OPTIONS)
      expect(hold(id, local, LOOPBACK_OPTIONS, ["http://gpu-box:8080/v1/chat/completions"])).toEqual({
        refusal: "unattested-network-server",
      })
      // A provider's own fetch now, or a model admission did not decide for.
      expect(hold(id, local, { ...LOOPBACK_OPTIONS, fetch: () => undefined })).toEqual({
        refusal: "unknown-destination",
      })
      expect(hold(id, { ...local, id: ModelV2.ID.make("other-model") }, LOOPBACK_OPTIONS)).toEqual({
        refusal: "unknown-destination",
      })
      // Codium and a free model name their own refusal, not the switch of model.
      expect(hold(id, model("vector-plan/vector-flash"), {})).toEqual({ refusal: "codium-unaccepted" })
      expect(hold(id, model("vector/acme/coder:free"), {})).toEqual({ refusal: "free-model" })
    }),
  )

  it.effect("a zdr session its review released is refused; a released standard one is unregistered", () =>
    Effect.gen(function* () {
      const id = session("released")
      const decided = yield* admit(id, local, zdr(), LOOPBACK_OPTIONS)
      const sent = ["http://127.0.0.1:1234/v1/chat/completions"]
      expect(hold(id, local, LOOPBACK_OPTIONS, sent)).toEqual({ kind: "loopback" })
      ReviewRoutes.release(id)
      // Nothing else is registered, and the released session is still refused.
      expect(hold(id, local, LOOPBACK_OPTIONS, sent)).toEqual({ refusal: "unknown-destination" })
      expect(hold("ses_holdtestneverregistered", local, LOOPBACK_OPTIONS, sent)).toBeUndefined()
      const standard = session("releasedstandard")
      ReviewRoutes.register(standard, { policy: { privacy: "standard", attested: [] } })
      ReviewRoutes.release(standard)
      expect(hold(standard, local, LOOPBACK_OPTIONS, sent)).toBeUndefined()
      // Registered again, it is held as decided.
      ReviewRoutes.register(id, { policy: zdr(), ...decided })
      expect(hold(id, local, LOOPBACK_OPTIONS, sent)).toEqual({ kind: "loopback" })
    }),
  )

  it.effect("an attestation that asks Vector to check the account is refused at the transport too", () =>
    Effect.gen(function* () {
      const id = session("verify")
      const decided = yield* admit(id, anthropic, zdr(["anthropic"]))
      const checked = { id: "anthropic", operator: "anthropic", verify: "api" as const }
      ReviewRoutes.register(id, { ...decided, policy: zdr([checked]) })
      expect(hold(id, anthropic, {}, ["https://api.anthropic.com/v1/messages"])).toEqual({
        refusal: "attestation-unverified",
      })
    }),
  )
})

// VS-23c (SF-12b): what the session runtime (session/llm.ts) does with a model call (turn), and whether a session's
// calls are a "zdr" review's (zdr). zdr-route.test.ts covers the same through LLM.stream. Both take plain values, so
// what they read cannot be observed here; and a "zdr" session released earlier in this process (an earlier case, or
// another file in the same process) stays remembered, so these cases run past the first line, whose answer for every
// session but a "zdr" review's is the same.
describe("ReviewRoutes.turn and zdr (SF-12b)", () => {
  // The registry is process-global: every session a case names is released after it, whatever the case does.
  const named: SessionID[] = []
  const session = (suffix: string) => {
    const id = SessionID.make(`ses_turntest${suffix}`)
    named.push(id)
    return id
  }
  afterEach(() => named.splice(0).forEach((id) => ReviewRoutes.release(id)))
  const STANDARD = { privacy: "standard" as const, attested: [] }
  const REFUSED: ReviewRoutes.Turn = { refusal: "unknown-destination" }
  const call = (sessionID: string, overrides: Partial<Parameters<typeof ReviewRoutes.turn>[0]> = {}) =>
    ReviewRoutes.turn({ sessionID, agent: "review", ...overrides })

  test("every session but a zdr review's and its children's takes the path it took before", () => {
    const standard = session("standard")
    ReviewRoutes.register(standard, { policy: STANDARD, agent: "review" })
    // A zdr review registered beside them changes nothing for them.
    ReviewRoutes.register(session("beside"), { policy: zdr(), agent: "review" })
    for (const id of ["ses_turntestowner", standard]) {
      expect(ReviewRoutes.zdr(id)).toBe(false)
      expect(call(id)).toBeUndefined()
      expect(call(id, { agent: "title", small: true })).toBeUndefined()
      expect(call(id, { agent: "compaction" })).toBeUndefined()
      expect(call(id, { small: true })).toBeUndefined()
      expect(call(id, { parentSessionID: standard })).toBeUndefined()
      expect(call(id, { parentSessionID: "ses_turntestowner" })).toBeUndefined()
    }
  })

  test("a zdr session sends its pass's own turns, on the AI SDK runtime, and nothing else", () => {
    const id = session("own")
    ReviewRoutes.register(id, { policy: zdr(), agent: "review" })
    expect(ReviewRoutes.zdr(id)).toBe(true)
    expect(call(id)).toEqual({ runtime: "ai-sdk" })
    expect(call(id, { small: false })).toEqual({ runtime: "ai-sdk" })
    // Another agent (a title, the memory learner, a compaction summary, another pass's), or the pass's own small.
    for (const overrides of [
      { agent: "title", small: true },
      { agent: "brain.learn", small: true },
      { agent: "brain.skill", small: true },
      { agent: "compaction" },
      { agent: "judge" },
      { agent: "security" },
      { small: true },
    ])
      expect(call(id, overrides)).toEqual(REFUSED)
    // A child of the zdr session (a task or a subagent), unregistered itself, whatever its agent.
    expect(call("ses_turntestchild", { parentSessionID: id })).toEqual(REFUSED)
    expect(call("ses_turntestchild", { parentSessionID: id, agent: "explore" })).toEqual(REFUSED)
    // A registration with no agent sends no turn.
    const bare = session("bare")
    ReviewRoutes.register(bare, { policy: zdr() })
    expect(ReviewRoutes.zdr(bare)).toBe(true)
    expect(call(bare)).toEqual(REFUSED)
    // The agent Review.run registered is the one that is allowed.
    const security = session("security")
    ReviewRoutes.register(security, { policy: zdr(), agent: "security" })
    expect(call(security, { agent: "security" })).toEqual({ runtime: "ai-sdk" })
    expect(call(security)).toEqual(REFUSED)
  })

  test("a released zdr session and its children send nothing, with nothing registered, until it is registered again", () => {
    const id = session("released")
    ReviewRoutes.register(id, { policy: zdr(), agent: "review" })
    ReviewRoutes.release(id)
    // Nothing is registered now (every case releases what it named), and the released session is still a zdr review's.
    expect(ReviewRoutes.registered(id)).toBeUndefined()
    expect(ReviewRoutes.zdr(id)).toBe(true)
    expect(call(id)).toEqual(REFUSED)
    expect(call("ses_turntestreleasedchild", { parentSessionID: id })).toEqual(REFUSED)
    // A released standard session is an unregistered one's.
    const standard = session("releasedstandard")
    ReviewRoutes.register(standard, { policy: STANDARD, agent: "review" })
    ReviewRoutes.release(standard)
    expect(ReviewRoutes.zdr(standard)).toBe(false)
    expect(call(standard)).toBeUndefined()
    // Registered again, the session's own turns are sent.
    ReviewRoutes.register(id, { policy: zdr(), agent: "review" })
    expect(call(id)).toEqual({ runtime: "ai-sdk" })
  })
})

// VS-23d (SF-15): the engine server's own hold on the review sessions no Review.run registered (the desktop's): the
// server's policy from the user config's review block alone, whether a review holds a session, and the adoption the
// HTTP prompt makes.
describe("ReviewRoutes.serverPolicy, known and adopt (SF-15)", () => {
  // The registry is process-global: every session a case names is released after it, whatever the case does.
  const named: SessionID[] = []
  const session = (suffix: string) => {
    const id = SessionID.make(`ses_adopttest${suffix}`)
    named.push(id)
    return id
  }
  afterEach(() => named.splice(0).forEach((id) => ReviewRoutes.release(id)))
  const local = model("lmstudio/test-model")
  const acme = model("acme/coder", { url: "https://models.invalid/v1" })
  const setup = { models: [local, acme], asked: [] as string[] }
  const adopt = (
    id: SessionID,
    policy: ReviewRoutes.Policy,
    input: { agent?: string; name?: string; options?: Record<string, unknown>; catalogOrigins?: string[] } = {},
  ) =>
    Effect.gen(function* () {
      const service = yield* Provider.Service
      const ref = input.name ? Provider.parseModel(input.name) : undefined
      return yield* ReviewRoutes.adopt(service, {
        sessionID: id,
        policy,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(ref
          ? {
              subject: {
                providerID: ref.providerID,
                modelID: ref.modelID,
                ...(input.catalogOrigins ? { catalogOrigins: input.catalogOrigins } : {}),
              },
            }
          : {}),
      })
    }).pipe(Effect.provide(provider({ ...setup, options: input.options ?? {} })))

  test("the server's policy is the user config's block alone: standard without one, zdr from it, read loosely", () => {
    const standard: ReviewRoutes.Policy = { privacy: "standard", attested: [] }
    expect(ReviewRoutes.serverPolicy(undefined)).toEqual(standard)
    expect(ReviewRoutes.serverPolicy({})).toEqual(standard)
    expect(ReviewRoutes.serverPolicy({ privacy: "standard", holdback: "secrets" })).toEqual(standard)
    expect(ReviewRoutes.serverPolicy({ privacy: "zdr" })).toEqual({ privacy: "zdr", attested: [] })
    // A value that is not a level reads as the strictest.
    expect(ReviewRoutes.serverPolicy({ privacy: 1 }).privacy).toBe("zdr")
    expect(ReviewRoutes.serverPolicy({ privacy: " ZDR " }).privacy).toBe("zdr")
    // The user config is the trusted source of attestations, whatever the privacy; an unreadable entry is dropped.
    expect(ReviewRoutes.serverPolicy({ zdrAttested: ["acme", "a b", 3] })).toEqual({
      privacy: "standard",
      attested: ["acme"],
    })
    expect(ReviewRoutes.serverPolicy({ privacy: "zdr", zdrAttested: [{ id: "acme", operator: "acme" }] })).toEqual({
      privacy: "zdr",
      attested: [{ id: "acme", operator: "acme" }],
    })
    // No environment is read: the desktop reads none either.
    const previous = process.env.REVIEW_PRIVACY
    process.env.REVIEW_PRIVACY = "zdr"
    try {
      expect(ReviewRoutes.serverPolicy(undefined)).toEqual(standard)
    } finally {
      if (previous === undefined) delete process.env.REVIEW_PRIVACY
      else process.env.REVIEW_PRIVACY = previous
    }
  })

  test("a session is known while registered, and after its release only when it was a zdr one", () => {
    const zdrID = session("zdr")
    const standardID = session("standard")
    expect(ReviewRoutes.known(zdrID)).toBe(false)
    ReviewRoutes.register(zdrID, { policy: zdr(), agent: "review" })
    ReviewRoutes.register(standardID, { policy: { privacy: "standard", attested: [] }, agent: "review" })
    expect(ReviewRoutes.known(zdrID)).toBe(true)
    expect(ReviewRoutes.known(standardID)).toBe(true)
    ReviewRoutes.release(zdrID)
    ReviewRoutes.release(standardID)
    expect(ReviewRoutes.known(zdrID)).toBe(true)
    expect(ReviewRoutes.known(standardID)).toBe(false)
    expect(ReviewRoutes.known("ses_adopttestnever")).toBe(false)
  })

  it.effect("adopts a session for the prompt's agent and the decision for its model", () =>
    Effect.gen(function* () {
      // A server on this computer: allowed, and the transport then sends the pass's own turns of that model only.
      const loopback = session("loopback")
      const entry = yield* adopt(loopback, zdr(), {
        agent: "review",
        name: "lmstudio/test-model",
        options: { baseURL: "http://127.0.0.1:1234/v1" },
      })
      expect(entry).toMatchObject({ policy: zdr(), agent: "review", decision: { allowed: true, kind: "loopback" } })
      expect(ReviewRoutes.registered(loopback)).toEqual(entry)
      expect(ReviewRoutes.attempt(loopback, local)).toBeUndefined()
      expect(ReviewRoutes.attempt(loopback, { ...local, id: ModelV2.ID.make("other-model") })).toBe(
        "unknown-destination",
      )
      expect(ReviewRoutes.turn({ sessionID: loopback, agent: "review" })).toEqual({ runtime: "ai-sdk" })
      expect(ReviewRoutes.turn({ sessionID: loopback, agent: "title", small: true })).toEqual({
        refusal: "unknown-destination",
      })

      // An unattested provider is registered refused, so every call is refused before anything is sent.
      const unattested = session("unattested")
      const refused = yield* adopt(unattested, zdr(), { agent: "review", name: "acme/coder" })
      expect(refused.decision).toEqual(refusal("unattested-provider"))
      expect(ReviewRoutes.attempt(unattested, acme)).toBe("unattested-provider")
      expect(
        ReviewRoutes.hold({
          session: () => ({ id: unattested }),
          model: acme,
          options: {},
          destinations: () => ["https://models.invalid"],
        }),
      ).toEqual({ refusal: "unattested-provider" })

      // Attested in the user config, where the catalog ships the provider, it is allowed.
      const attested = session("attested")
      const allowed = yield* adopt(attested, zdr(["acme"]), {
        agent: "review",
        name: "acme/coder",
        catalogOrigins: ["https://models.invalid/v1"],
      })
      expect(allowed.decision).toEqual({ allowed: true, kind: "attested-provider" })
      // Without the catalog's word, the attestation of the provider ID covers no host.
      const unknown = session("unknown")
      expect((yield* adopt(unknown, zdr(["acme"]), { agent: "review", name: "acme/coder" })).decision).toEqual(
        refusal("unattested-provider"),
      )
    }),
  )

  it.effect("Codium and free models are refused before any lookup, and no model leaves the session undecided", () =>
    Effect.gen(function* () {
      setup.asked.length = 0
      for (const [name, why] of [
        ["vector-plan/vector-flash", "codium-unaccepted"],
        ["vector/acme/coder:free", "free-model"],
      ] as const) {
        const id = session(why)
        expect((yield* adopt(id, zdr(), { agent: "review", name })).decision).toEqual(refusal(why))
      }
      expect(setup.asked).toEqual([])
      // No model: nothing was decided, so every call of the session is refused.
      const bare = session("bare")
      const entry = yield* adopt(bare, zdr(), { agent: "review" })
      expect(entry).toEqual({ policy: zdr(), agent: "review" })
      expect(ReviewRoutes.attempt(bare, local)).toBe("unknown-destination")
      // No agent: no turn is sent.
      const agentless = session("agentless")
      yield* adopt(agentless, zdr(), {
        name: "lmstudio/test-model",
        options: { baseURL: "http://127.0.0.1:1234/v1" },
      })
      expect(ReviewRoutes.turn({ sessionID: agentless, agent: "review" })).toEqual({ refusal: "unknown-destination" })
    }),
  )

  it.effect("past ADOPTED_LIMIT adoptions the oldest is released, and a call that still names it is refused", () =>
    Effect.gen(function* () {
      const service = yield* Provider.Service
      const ids = Array.from({ length: ReviewRoutes.ADOPTED_LIMIT + 1 }, (_, index) => session(`bound${index}`))
      for (const id of ids) yield* ReviewRoutes.adopt(service, { sessionID: id, policy: zdr(), agent: "review" })
      const [oldest, next] = ids
      expect(ReviewRoutes.registered(oldest!)).toBeUndefined()
      expect(ReviewRoutes.known(oldest!)).toBe(true)
      expect(
        ReviewRoutes.hold({ session: () => ({ id: oldest }), model: local, options: {}, destinations: () => [] }),
      ).toEqual({ refusal: "unknown-destination" })
      expect(ReviewRoutes.turn({ sessionID: oldest!, agent: "review" })).toEqual({ refusal: "unknown-destination" })
      expect(ReviewRoutes.registered(next!)).toEqual({ policy: zdr(), agent: "review" })
      expect(ReviewRoutes.registered(ids.at(-1)!)).toEqual({ policy: zdr(), agent: "review" })
      // A session released by its own review leaves the count, so the next adoption evicts nothing.
      ReviewRoutes.release(next!)
      yield* ReviewRoutes.adopt(service, { sessionID: session("bound-after"), policy: zdr(), agent: "review" })
      expect(ReviewRoutes.registered(ids[2]!)).toEqual({ policy: zdr(), agent: "review" })
    }).pipe(Effect.provide(provider({ ...setup, options: {} }))),
  )
})

describe("ReviewRoutes.sendBody", () => {
  const send = (input: Partial<Parameters<typeof ReviewRoutes.sendBody>[0]> & { body: unknown }) =>
    ReviewRoutes.sendBody({
      kind: "loopback",
      npm: "@ai-sdk/openai-compatible",
      url: "http://127.0.0.1:1234/v1/chat/completions",
      request: false,
      modelID: "coder",
      ...input,
    })
  const chat = { model: "coder", messages: [{ role: "user", content: "Review the change in requests.ts" }] }

  test("a body that is not a JSON string beside the URL is unreadable", () => {
    expect(send({ body: new TextEncoder().encode(JSON.stringify(chat)) })).toEqual({ refusal: "unreadable-body" })
    expect(send({ body: undefined })).toEqual({ refusal: "unreadable-body" })
    expect(send({ body: JSON.stringify(chat), request: true })).toEqual({ refusal: "unreadable-body" })
    expect(send({ body: "{not json" })).toEqual({ refusal: "unreadable-body" })
    expect(send({ body: "[]" })).toEqual({ refusal: "unreadable-body" })
  })

  test("a compatible non-OpenAI model with no retention request preserves every byte", () => {
    const spaced = '{ "model":"coder",  "messages": [] }'
    expect(send({ body: spaced })).toEqual({ body: spaced })
    expect(send({ body: spaced, kind: "attested-host" })).toEqual({ body: spaced })
  })

  test("OpenAI, Azure and Mantle enforce cache and storage after provider options are merged", () => {
    const body = { model: "gpt-4.1", store: true, prompt_cache_options: { ttl: "30m" } }
    for (const npm of [
      "@ai-sdk/openai",
      "@ai-sdk/azure",
      "@ai-sdk/amazon-bedrock/mantle",
      "@ai-sdk/openai-compatible",
    ]) {
      expect(send({ npm, modelID: body.model, body: JSON.stringify(body) })).toEqual({
        body: JSON.stringify({ model: body.model, store: false, prompt_cache_retention: "in_memory" }),
      })
      expect(send({ npm, modelID: body.model, kind: "standard", body: JSON.stringify(body) })).toEqual({
        body: JSON.stringify(body),
      })
      expect(send({ npm, modelID: body.model, body: JSON.stringify({ ...body, prompt_cache_options: [] }) })).toEqual({
        refusal: "unreadable-body",
      })
    }
  })

  test("OpenRouter's route sends zdrRequestBody, after its path, and refuses what zdrBodyRefusal names", () => {
    const openrouter = { kind: "openrouter-attested" as const, npm: "@openrouter/ai-sdk-provider" }
    const url = "https://openrouter.ai/api/v1/chat/completions"
    expect(send({ ...openrouter, url, body: JSON.stringify(chat) })).toEqual({
      body: JSON.stringify(zdrRequestBody(chat, "coder")),
    })
    expect(send({ ...openrouter, url, body: JSON.stringify({ ...chat, plugins: [] }) })).toEqual({
      refusal: "plugins",
    })
    expect(send({ ...openrouter, url, body: JSON.stringify({ ...chat, models: ["acme/other"] }) })).toEqual({
      refusal: "fallback-models",
    })
    expect(send({ ...openrouter, url: "https://openrouter.ai/api/v1/batches", body: JSON.stringify(chat) })).toEqual({
      refusal: "batch",
    })
  })

  test("direct OpenAI-compatible routes refuse Batch and Files paths and bodies (runner-wiring R1)", () => {
    expect(send({ url: "http://127.0.0.1:1234/v1/files/f-1", body: JSON.stringify(chat) })).toEqual({
      refusal: "batch",
    })
    expect(send({ url: "http://127.0.0.1:1234/v1/batches", body: JSON.stringify(chat) })).toEqual({ refusal: "batch" })
    expect(send({ body: JSON.stringify({ ...chat, callback_url: "https://hook.invalid" }) })).toEqual({
      refusal: "batch",
    })
    expect(send({ body: JSON.stringify({ requests: [] }) })).toEqual({ refusal: "batch" })
  })

  test("an Anthropic request needs a Messages path and no feature zero data retention does not cover", () => {
    const anthropic = { npm: "@ai-sdk/anthropic", url: "http://127.0.0.1:1234/v1/messages" }
    const messages = JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] })
    expect(send({ ...anthropic, body: messages })).toEqual({ body: messages })
    expect(
      send({ ...anthropic, body: JSON.stringify({ ...JSON.parse(messages), mcp_servers: [{ name: "x" }] }) }),
    ).toEqual({ refusal: "anthropic-non-zdr-feature" })
    expect(send({ ...anthropic, url: "http://127.0.0.1:1234/v1/messages/batches", body: messages })).toEqual({
      refusal: "batch",
    })
    expect(send({ ...anthropic, url: "http://127.0.0.1:1234/v1/complete", body: messages })).toEqual({
      refusal: "anthropic-non-zdr-feature",
    })
  })

  test("a Google request may call functions only", () => {
    const google = { npm: "@ai-sdk/google", url: "http://127.0.0.1:1234/v1beta/models/gemini:streamGenerateContent" }
    const functions = JSON.stringify({ contents: [], tools: [{ functionDeclarations: [{ name: "read" }] }] })
    expect(send({ ...google, body: functions })).toEqual({ body: functions })
    expect(send({ ...google, body: JSON.stringify({ contents: [], tools: [{ googleSearch: {} }] }) })).toEqual({
      refusal: "grounding-tool",
    })
  })
})
