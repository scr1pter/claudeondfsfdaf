import { afterAll, afterEach, expect } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { APICallError } from "ai"
import { Effect, Layer, Stream } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { RouteRefusal } from "@vectordevai/core/review/privacy"
import type { ZdrAttestedEntry } from "@vectordevai/core/review/types"
import { FREE_MODEL_FALLBACKS, type FreeModelInfo } from "@vectordevai/schema/free-model"
import { Provider } from "@/provider/provider"
import { ReviewRoutes } from "@/review/route"
import { SessionID } from "@/session/schema"
import { codiumCatalogV2, codiumGateway, codiumModel } from "../../../core/test/fixture/codium-gateway"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// VS-23c (SF-12a): the transport backstop in provider.ts. Every model call of a session a review registered under
// privacy "zdr" is decided again in its fetch, on the plan route, the free route and the generic V1 fetch, and its final
// body is checked or rewritten before anything is sent; every other call is sent exactly as before. Sessions are
// registered through the real admission (ReviewRoutes.decide); a case that shows the transport deciding on its own
// registers what an admission that saw other options decided. Every server here is a loopback fake, and the strict
// network guard sees no attempt to leave this computer.

const guard = NetworkGuard.use()

// A model server that records every request and answers none: the request is what the test reads.
type Hit = { method: string; path: string; headers: Record<string, string>; body: string }
const record = async (request: Request): Promise<Hit> => {
  const url = new URL(request.url)
  return {
    method: request.method,
    path: url.pathname + url.search,
    headers: Object.fromEntries(request.headers),
    body: await request.text(),
  }
}
const hits: Hit[] = []
const recorder = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    hits.push(await record(request))
    return Response.json({ error: { message: "The recorder answers nothing." } }, { status: 400 })
  },
})
const origin = recorder.url.origin
// A model server on another port that records every request and redirects it (307) to the same path at the recorder:
// an origin admission never saw.
const bounced: Hit[] = []
const redirector = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const hit = await record(request)
    bounced.push(hit)
    return new Response(null, { status: 307, headers: { location: `${origin}${hit.path}` } })
  },
})

const token = "vct_synthetic-private-account.token"
const gateway = codiumGateway(token)
afterAll(() => {
  recorder.stop(true)
  redirector.stop(true)
  gateway.stop()
})

// A free model whose provider may train on prompts: without the user's acceptance it is refused while it is built.
const laguna: FreeModelInfo = {
  id: "poolside/laguna-s-2.1:free",
  name: "Poolside: Laguna S 2.1",
  contextLength: 1_000_000,
  maxOutputTokens: 32768,
  providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" }],
}
// Every call the free route's resolution makes, so a case can show it never ran.
const freeCalls = { catalog: 0, forKey: 0, trainingConsent: 0, credential: 0 }
const freeCount = () => ({ ...freeCalls })

const it = testEffect(
  LayerNode.compile(Provider.node, [
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () =>
          Effect.sync(() => {
            freeCalls.catalog++
            return { enabled: true, updatedAt: 1, models: [...FREE_MODEL_FALLBACKS, laguna] }
          }),
        forKey: () => Effect.sync(() => (freeCalls.forKey++, [])),
        trainingConsent: () => Effect.sync(() => (freeCalls.trainingConsent++, false)),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
    ],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) => Effect.sync(() => (freeCalls.credential++, provider === "vector" ? token : undefined)),
      }),
    ],
    [
      ModelPlans.node,
      Layer.succeed(ModelPlans.Service, {
        catalog: (value) => Effect.succeed(value === token ? codiumCatalogV2 : { enabled: false, models: [] }),
        request: gateway.forward,
      }),
    ],
  ]),
)

afterEach(async () => {
  for (const id of registered.splice(0)) ReviewRoutes.release(SessionID.make(id))
  hits.length = 0
  bounced.length = 0
  await disposeAllInstances()
})

// Model servers in the configuration, each a provider of one or two models.
const listed = (id: string) => ({
  id,
  name: id,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100_000, output: 10_000 },
  cost: { input: 1, output: 2 },
  options: {},
})
const server = (baseURL: string, npm = "@ai-sdk/openai-compatible", models = ["coder"]) => ({
  name: "Server",
  env: [],
  npm,
  models: Object.fromEntries(models.map((id) => [id, listed(id)])),
  options: { apiKey: "synthetic-not-a-key", baseURL, concurrency: 64 },
})
const config = {
  provider: {
    loop: server(`${origin}/v1`, "@ai-sdk/openai-compatible", ["coder", "other"]),
    files: server(`${origin}/v1/files/f-1`),
    bounce: server(`${redirector.url.origin}/v1`),
    acme: server("https://api.acme.invalid/v1"),
    // A provider defined in configuration on the OpenRouter SDK, at a stand-in on this computer whose path is Batch's.
    orbatch: server(`${origin}/api/v1/batches`, "@openrouter/ai-sdk-provider", ["acme/coder"]),
    openrouter: { options: { apiKey: "sk-or-synthetic-not-a-key", baseURL: `${origin}/api/v1` } },
    anthropic: { options: { apiKey: "sk-ant-synthetic-not-a-key", baseURL: `${origin}/v1` } },
    google: { options: { apiKey: "synthetic-not-a-key", baseURL: `${origin}/v1beta` } },
  },
}
const options = { trusted: true, config }

const PROMPT: LanguageModelV3CallOptions["prompt"] = [
  { role: "user", content: [{ type: "text", text: "Review src/list.ts" }] },
]
const zdr = (attested: readonly ZdrAttestedEntry[] = []): ReviewRoutes.Policy => ({ privacy: "zdr", attested })
const STANDARD: ReviewRoutes.Policy = { privacy: "standard", attested: [] }

// The sessions a case registered, released after it.
const registered: string[] = []
const sessionIDs = { next: 0 }
const fresh = () => {
  const id = `ses_zdrroute${String(++sessionIDs.next).padStart(4, "0")}`
  registered.push(id)
  return SessionID.make(id)
}

const model = (providerID: string, modelID: string) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    return yield* provider.getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))
  })

// A session registered as Review.run registers it, from the real admission's decision for `found`.
const admitted = (found: Provider.Model, policy: ReviewRoutes.Policy, subject: Partial<ReviewRoutes.Subject> = {}) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const decided = yield* ReviewRoutes.decide(
      provider,
      { ...subject, providerID: found.providerID, modelID: found.id, found },
      policy,
    )
    const id = fresh()
    ReviewRoutes.register(id, { policy, ...decided })
    return { id, decided }
  })

// A session registered from an admission that saw the provider on this computer (these options), as one whose options
// changed after it was decided would be: what the transport refuses, it refuses on what it sees itself.
const admittedOnLoopback = (found: Provider.Model, policy: ReviewRoutes.Policy) =>
  Effect.gen(function* () {
    const mock = yield* Provider.Service
    const decided = yield* ReviewRoutes.decide(mock, { providerID: found.providerID, modelID: found.id, found }, policy)
    expect(decided.decision).toEqual({ allowed: true, kind: "loopback" })
    const id = fresh()
    ReviewRoutes.register(id, { policy, ...decided })
    return id
  }).pipe(
    Effect.provide(
      Layer.mock(Provider.Service, {
        getProvider: (providerID) =>
          Effect.succeed({
            id: providerID,
            name: providerID,
            source: "config" as const,
            env: [],
            options: { baseURL: `${origin}/v1` },
            models: {},
          }),
        line: () => Effect.succeed(undefined),
      }),
    ),
  )

// One streamed call through the SDK the provider built, as the session processor makes it; the error it ended with.
const send = (
  found: Provider.Model,
  call: Partial<Pick<LanguageModelV3CallOptions, "headers" | "providerOptions" | "tools">> = {},
) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const language = yield* provider.getLanguage(found)
    return yield* Effect.promise(() =>
      language.doStream({ prompt: PROMPT, ...call }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
  })

// The fetch the provider gave the SDK, for a call the SDK itself never makes (another body type, a `Request`).
const sdkFetch = (found: Provider.Model) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const language: LanguageModelV3 = yield* provider.getLanguage(found)
    // The SDK keeps the fetch it was given on the language model's `config` in @ai-sdk/openai-compatible 2.0.41, the
    // version packages/engine pins; a rename in an upgrade fails here, not as an undefined call in a case below.
    const fetcher = (language as unknown as { config: { fetch?: unknown } }).config.fetch
    expect(typeof fetcher).toBe("function")
    return fetcher as typeof fetch
  })
const call = (fetcher: typeof fetch, input: RequestInfo | URL, init?: RequestInit) =>
  Effect.promise(() =>
    fetcher(input, init).then(
      () => undefined,
      (error: unknown) => error,
    ),
  )

const header = (id: string) => ({ "x-session-id": id })
const refusedAs = (error: unknown, refusal: RouteRefusal) => {
  expect(error).toBeInstanceOf(ReviewRoutes.Refused)
  expect((error as ReviewRoutes.Refused).refusal).toBe(refusal)
  expect(String(error)).toContain("Nothing was sent")
}
// Sent, and answered by the recorder's refusal.
const sentToRecorder = (error: unknown) => {
  expect(error).not.toBeInstanceOf(ReviewRoutes.Refused)
  expect(APICallError.isInstance(error)).toBe(true)
}
// A recorded request without its session header, to compare two sessions' requests.
const unnamed = (hit: Hit) => ({ ...hit, headers: { ...hit.headers, "x-session-id": undefined } })
const parsed = (hit: Hit | undefined) => JSON.parse(hit?.body ?? "null") as Record<string, unknown>

it.instance(
  "generic fetch: an attested OpenRouter account's request goes out with the ZDR body, and routing or plugins never",
  () =>
    Effect.gen(function* () {
      const found = yield* model("openrouter", "deepseek/deepseek-chat-v3.1")
      const unregistered = yield* send(found, { headers: header(fresh()) })
      sentToRecorder(unregistered)
      const { id, decided } = yield* admitted(found, zdr(["openrouter"]))
      expect(decided.decision).toEqual({ allowed: true, kind: "openrouter-attested" })
      sentToRecorder(yield* send(found, { headers: header(id) }))
      expect(hits).toHaveLength(2)
      const [before, after] = hits.map(parsed)
      // Everything the SDK sent, plus OpenRouter's ZDR preferences, and no routing or plugin field.
      expect(after).toEqual({ ...before, provider: { zdr: true, data_collection: "deny" } })
      for (const key of ["models", "route", "preset", "plugins"]) expect(Object.hasOwn(after, key)).toBe(false)
      expect(unnamed(hits[1]!).path).toBe("/api/v1/chat/completions")

      // A plugin list or fallback models in the call's provider options are refused before the fetch.
      refusedAs(
        yield* send(found, { headers: header(id), providerOptions: { openrouter: { plugins: [] } } }),
        "plugins",
      )
      refusedAs(
        yield* send(found, { headers: header(id), providerOptions: { openrouter: { models: ["acme/other"] } } }),
        "fallback-models",
      )
      expect(hits).toHaveLength(2)
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "generic fetch: a zdr session on a model server on this computer sends exactly the unregistered request",
  () =>
    Effect.gen(function* () {
      const found = yield* model("loop", "coder")
      const { id, decided } = yield* admitted(found, zdr())
      expect(decided.decision).toEqual({ allowed: true, kind: "loopback" })
      const other = fresh()
      sentToRecorder(yield* send(found, { headers: header(other) }))
      sentToRecorder(yield* send(found, { headers: header(id) }))
      expect(hits).toHaveLength(2)
      expect(unnamed(hits[1]!)).toEqual(unnamed(hits[0]!))
      expect(hits[1]!.headers["x-session-id"]).toBe(id)
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "plan route: a zdr session's Codium call is refused before the gateway, a Request's header included",
  () =>
    Effect.gen(function* () {
      const found = yield* model(ModelPlans.PROVIDER_ID, codiumModel.id)
      const { id, decided } = yield* admitted(found, zdr(["openrouter", ModelPlans.PROVIDER_ID]))
      expect(decided.decision).toEqual({ allowed: false, refusal: "codium-unaccepted" })
      const seen = gateway.seen.length
      refusedAs(yield* send(found, { headers: header(id) }), "codium-unaccepted")
      // The SDK's fetch called with a `Request` that carries the header, and no init.
      const fetcher = yield* sdkFetch(found)
      refusedAs(
        yield* call(
          fetcher,
          new Request(`${ModelPlans.API_URL}/chat/completions`, {
            method: "POST",
            headers: header(id),
            body: JSON.stringify({ model: codiumModel.id, messages: [] }),
          }),
        ),
        "codium-unaccepted",
      )
      expect(gateway.seen.length).toBe(seen)
      // The control: an unregistered session's call reaches the gateway.
      expect(yield* send(found, { headers: header(fresh()) })).toBeUndefined()
      expect(gateway.seen.slice(seen).map((item) => item.path)).toEqual(["/api/model-plans/chat"])
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "free route: a zdr session's free-model call is refused before resolution reads the catalog, credentials or consent",
  () =>
    Effect.gen(function* () {
      const found = yield* model("vector", laguna.id)
      const { id, decided } = yield* admitted(found, zdr(["openrouter", "vector"]))
      expect(decided.decision).toEqual({ allowed: false, refusal: "free-model" })
      const fetcher = yield* sdkFetch(found)
      const before = freeCount()
      refusedAs(yield* send(found, { headers: header(id) }), "free-model")
      refusedAs(
        yield* call(
          fetcher,
          new Request("https://vectordev.ai/api/free-models/chat/completions", {
            method: "POST",
            headers: header(id),
            body: JSON.stringify({ model: laguna.id, messages: [] }),
          }),
        ),
        "free-model",
      )
      expect(freeCount()).toEqual(before)
      // While a zdr review is registered, a header that names no one session is refused before resolution too.
      refusedAs(yield* send(found, { headers: { "x-session-id": "ses_first, ses_second" } }), "unattributed-request")
      expect(freeCount()).toEqual(before)
      // The control: an unregistered session's call resolves its route, and the missing acceptance refuses it.
      const control = yield* send(found, { headers: header(fresh()) })
      expect(control).not.toBeInstanceOf(ReviewRoutes.Refused)
      expect(String(control)).toContain("Nothing was sent")
      expect(freeCount().trainingConsent).toBeGreaterThan(before.trainingConsent)
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "generic fetch: a zdr session's body that is not a string, or that sits inside a Request, is refused",
  () =>
    Effect.gen(function* () {
      const found = yield* model("loop", "coder")
      const { id } = yield* admitted(found, zdr())
      const fetcher = yield* sdkFetch(found)
      const url = `${origin}/v1/chat/completions`
      const body = JSON.stringify({ model: "coder", messages: [{ role: "user", content: "Review src/list.ts" }] })
      const bytes = () => new TextEncoder().encode(body)
      refusedAs(yield* call(fetcher, url, { method: "POST", headers: header(id), body: bytes() }), "unreadable-body")
      const request = (session: string) => new Request(url, { method: "POST", headers: header(session), body })
      refusedAs(yield* call(fetcher, request(id)), "unreadable-body")
      // A `Request` input refuses even a string body beside it: the transport cannot tell which body is sent.
      refusedAs(yield* call(fetcher, request(id), { method: "POST", headers: header(id), body }), "unreadable-body")
      // A string that is not JSON names nothing the checks can read.
      refusedAs(
        yield* call(fetcher, url, { method: "POST", headers: header(id), body: "{not json" }),
        "unreadable-body",
      )
      expect(hits).toHaveLength(0)
      // The controls: the same calls of an unregistered session are sent as they are.
      const other = fresh()
      yield* call(fetcher, url, { method: "POST", headers: header(other), body: bytes() })
      yield* call(fetcher, request(other))
      expect(hits.map((hit) => hit.body)).toEqual([body, body])
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "a malformed session header is refused while a zdr review is registered, and sent as it is otherwise",
  () =>
    Effect.gen(function* () {
      const found = yield* model("loop", "coder")
      const malformed = { "x-session-id": "ses_a, ses_b" }
      sentToRecorder(yield* send(found, { headers: malformed }))
      // A standard review registered: still sent.
      ReviewRoutes.register(fresh(), { policy: STANDARD })
      sentToRecorder(yield* send(found, { headers: malformed }))
      expect(hits).toHaveLength(2)
      yield* admitted(found, zdr())
      refusedAs(yield* send(found, { headers: malformed }), "unattributed-request")
      // A request with no header is the owner's own, and is sent.
      sentToRecorder(yield* send(found))
      expect(hits).toHaveLength(3)
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "an unattested provider and a server on your network are refused before any connection, whatever admission saw",
  () =>
    Effect.gen(function* () {
      const acme = yield* model("acme", "coder")
      refusedAs(yield* send(acme, { headers: header(yield* admittedOnLoopback(acme, zdr())) }), "unattested-provider")
      // The provider list drops a provider this test's configuration puts on your network, so the live provider's base
      // URL is moved there instead, as a configuration change after admission would move it.
      const provider = yield* Provider.Service
      const info = yield* provider.getProvider(ProviderV2.ID.make("loop"))
      info.options.baseURL = "http://192.168.1.50:8080/v1"
      const lan = yield* model("loop", "coder")
      refusedAs(
        yield* send(lan, { headers: header(yield* admittedOnLoopback(lan, zdr())) }),
        "unattested-network-server",
      )
      expect(hits).toHaveLength(0)
      // Not even a connection was tried.
      expect(guard.attempts().filter((item) => ["api.acme.invalid", "192.168.1.50"].includes(item.host))).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "Batch and Files paths are refused on OpenRouter and OpenAI-compatible routes",
  () =>
    Effect.gen(function* () {
      const orbatch = yield* model("orbatch", "acme/coder")
      // A provider defined in configuration: its attestation is the owner's OpenRouter account (defaultOrigins []).
      const batch = yield* admitted(orbatch, zdr(["orbatch"]), { catalogOrigins: [] })
      expect(batch.decided.decision).toEqual({ allowed: true, kind: "openrouter-attested" })
      refusedAs(yield* send(orbatch, { headers: header(batch.id) }), "batch")
      const files = yield* model("files", "coder")
      const stored = yield* admitted(files, zdr())
      expect(stored.decided.decision).toEqual({ allowed: true, kind: "loopback" })
      refusedAs(yield* send(files, { headers: header(stored.id) }), "batch")
      expect(hits).toHaveLength(0)
      // The controls: unregistered, both go out to their paths.
      yield* send(orbatch, { headers: header(fresh()) })
      yield* send(files, { headers: header(fresh()) })
      expect(hits.map((hit) => hit.path)).toEqual([
        "/api/v1/batches/chat/completions",
        "/v1/files/f-1/chat/completions",
      ])
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "a direct OpenAI-compatible body shaped as a Batch request is refused (runner-wiring R1)",
  () =>
    Effect.gen(function* () {
      const found = yield* model("loop", "coder")
      const { id } = yield* admitted(found, zdr())
      refusedAs(
        yield* send(found, {
          headers: header(id),
          providerOptions: { loop: { callback_url: "https://hook.invalid" } },
        }),
        "batch",
      )
      refusedAs(yield* send(found, { headers: header(id), providerOptions: { loop: { requests: [] } } }), "batch")
      expect(hits).toHaveLength(0)
      // The control: the provider options really are spread into the body.
      yield* send(found, { headers: header(fresh()), providerOptions: { loop: { requests: [] } } })
      expect(parsed(hits[0]).requests).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "Anthropic and Google requests are checked for features zero data retention does not cover",
  () =>
    Effect.gen(function* () {
      const claude = yield* model("anthropic", "claude-haiku-4-5")
      const anthropic = yield* admitted(claude, zdr())
      expect(anthropic.decided.decision).toEqual({ allowed: true, kind: "loopback" })
      sentToRecorder(yield* send(claude, { headers: header(fresh()) }))
      sentToRecorder(yield* send(claude, { headers: header(anthropic.id) }))
      expect(hits).toHaveLength(2)
      expect(hits[1]!.path).toBe("/v1/messages")
      expect(unnamed(hits[1]!)).toEqual(unnamed(hits[0]!))
      const execution = {
        type: "provider" as const,
        id: "anthropic.code_execution_20250522" as const,
        name: "code_execution",
        args: {},
      }
      refusedAs(yield* send(claude, { headers: header(anthropic.id), tools: [execution] }), "anthropic-non-zdr-feature")

      const gemini = yield* model("google", "gemini-2.5-flash")
      const google = yield* admitted(gemini, zdr())
      expect(google.decided.decision).toEqual({ allowed: true, kind: "loopback" })
      sentToRecorder(yield* send(gemini, { headers: header(google.id) }))
      const search = { type: "provider" as const, id: "google.google_search" as const, name: "google_search", args: {} }
      refusedAs(yield* send(gemini, { headers: header(google.id), tools: [search] }), "grounding-tool")
      expect(hits).toHaveLength(3)
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "a zdr session's call follows no redirect, and every other call follows it as before",
  () =>
    Effect.gen(function* () {
      const found = yield* model("bounce", "coder")
      const { id, decided } = yield* admitted(found, zdr())
      expect(decided.decision).toEqual({ allowed: true, kind: "loopback" })
      const error = yield* send(found, { headers: header(id) })
      expect(error).not.toBeInstanceOf(ReviewRoutes.Refused)
      expect((error as { code?: unknown }).code).toBe("UnexpectedRedirect")
      // The origin the call was held for got it; the origin it was redirected to got nothing.
      expect(bounced).toHaveLength(1)
      expect(hits).toHaveLength(0)
      // The controls: an unregistered session's call and the owner's own follow the redirect as before, and the
      // recorder gets the same body the redirector did.
      sentToRecorder(yield* send(found, { headers: header(fresh()) }))
      sentToRecorder(yield* send(found))
      expect(bounced).toHaveLength(3)
      expect(new Set(bounced.map((hit) => hit.body)).size).toBe(1)
      expect(hits.map((hit) => [hit.method, hit.path, hit.body])).toEqual([
        ["POST", "/v1/chat/completions", bounced[0]!.body],
        ["POST", "/v1/chat/completions", bounced[0]!.body],
      ])
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "a zdr session its review released is refused, though no review is registered, and a standard one is sent",
  () =>
    Effect.gen(function* () {
      const found = yield* model("loop", "coder")
      const { id, decided } = yield* admitted(found, zdr())
      ReviewRoutes.release(id)
      expect(ReviewRoutes.registered(id)).toBeUndefined()
      refusedAs(yield* send(found, { headers: header(id) }), "unknown-destination")
      expect(hits).toHaveLength(0)
      // A released standard session's call is an unregistered session's, and is sent.
      const standard = fresh()
      ReviewRoutes.register(standard, { policy: STANDARD })
      ReviewRoutes.release(standard)
      sentToRecorder(yield* send(found, { headers: header(standard) }))
      // Registered again, the session is held as it was decided, and sent.
      ReviewRoutes.register(id, { policy: zdr(), ...decided })
      sentToRecorder(yield* send(found, { headers: header(id) }))
      expect(hits).toHaveLength(2)
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "a call on another model than its session was decided for is an unknown destination",
  () =>
    Effect.gen(function* () {
      const coder = yield* model("loop", "coder")
      const other = yield* model("loop", "other")
      const { id } = yield* admitted(coder, zdr())
      refusedAs(yield* send(other, { headers: header(id) }), "unknown-destination")
      sentToRecorder(yield* send(coder, { headers: header(id) }))
      expect(hits).toHaveLength(1)
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "the owner's own calls, unregistered and standard sessions send the same bytes whether or not a zdr review runs",
  () =>
    Effect.gen(function* () {
      const loop = yield* model("loop", "coder")
      const codium = yield* model(ModelPlans.PROVIDER_ID, codiumModel.id)
      const standard = fresh()
      ReviewRoutes.register(standard, { policy: STANDARD })
      const unregistered = fresh()
      const callers = [undefined, header(unregistered), header(standard)]
      // Each caller's requests on the generic and the plan route, the gateway's view of a request without its clock.
      const round = Effect.gen(function* () {
        hits.length = 0
        const seen = gateway.seen.length
        for (const headers of callers) {
          yield* send(loop, headers ? { headers } : {})
          yield* send(codium, headers ? { headers } : {})
        }
        return { generic: [...hits], plan: gateway.seen.slice(seen) }
      })
      const alone = yield* round
      yield* admitted(loop, zdr())
      yield* admitted(codium, zdr())
      const beside = yield* round
      expect(alone.generic).toHaveLength(3)
      expect(alone.plan).toHaveLength(3)
      expect(beside).toEqual(alone)
      expect(guard.outside()).toEqual([])
    }),
  options,
)
