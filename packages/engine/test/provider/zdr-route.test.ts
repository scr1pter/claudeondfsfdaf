import { afterAll, afterEach, expect } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { APICallError } from "ai"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { RouteRefusal } from "@vectordevai/core/review/privacy"
import { PINNED_SESSION_PREFIX, VECTORSCOPE_AGENT } from "@vectordevai/core/review/prompt"
import { REVIEW_LENSES, type ZdrAttestedEntry } from "@vectordevai/core/review/types"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { LLMRequest } from "@vectordevai/llm"
import { LLMClient } from "@vectordevai/llm/route"
import { FREE_MODEL_FALLBACKS, type FreeModelInfo } from "@vectordevai/schema/free-model"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { ReviewRoutes } from "@/review/route"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
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
//
// VS-23c (SF-12b): the session runtime (session/llm.ts), through LLM.stream, in the cases at the end of this file.

const guard = NetworkGuard.use()

// The loopback model server records every request. Sessions in the wire audit receive a complete provider stream.
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
const success = new Set<string>()
const answer = "synthetic wire reply"

function completion(hit: Hit) {
  const { model } = JSON.parse(hit.body)
  const headers = { "content-type": "text/event-stream" }
  if (hit.path === "/v1/messages") {
    const frames = [
      {
        type: "message_start",
        message: {
          id: "msg_loop",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
    return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
      headers,
    })
  }
  if (hit.path === "/v1/chat/completions" || hit.path === "/api/v1/chat/completions") {
    const chunks = [
      { delta: { role: "assistant", content: answer }, finish_reason: null },
      { delta: {}, finish_reason: "stop" },
    ].map(
      (choice) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-loop",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, ...choice }],
        })}\n\n`,
    )
    return new Response(chunks.join("") + "data: [DONE]\n\n", { headers })
  }
  return new Response(null, { status: 404 })
}
const hits: Hit[] = []
const recorder = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const hit = await record(request)
    hits.push(hit)
    if (success.has(hit.headers["x-session-id"]!)) return completion(hit)
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

// The provider's catalogs and gateways, the same for both harnesses below.
const fakes = [
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
] as const
const it = testEffect(LayerNode.compile(Provider.node, fakes))

afterEach(async () => {
  for (const id of registered.splice(0)) ReviewRoutes.release(SessionID.make(id))
  hits.length = 0
  success.clear()
  bounced.length = 0
  nativeRequests.length = 0
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

// A session registered as Review.run registers it, with its pass's agent, from the real admission's decision for
// `found`.
const admitted = (
  found: Provider.Model,
  policy: ReviewRoutes.Policy,
  subject: Partial<ReviewRoutes.Subject> = {},
  agent = "review",
) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const decided = yield* ReviewRoutes.decide(
      provider,
      { ...subject, providerID: found.providerID, modelID: found.id, found },
      policy,
    )
    const id = fresh()
    ReviewRoutes.register(id, { policy, agent, ...decided })
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
    ReviewRoutes.register(id, { policy, agent: "review", ...decided })
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
  call: Partial<Pick<LanguageModelV3CallOptions, "headers" | "providerOptions" | "tools" | "prompt">> = {},
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
  "held OpenAI and compatible requests constrain storage and retention on the final SDK wire",
  () =>
    Effect.gen(function* () {
      const legacy = yield* model("loop", "gpt-5.4")
      const later = yield* model("loop", "gpt-5.5")
      const opaque = yield* model("loop", "coder")
      const official = yield* model("openai", "gpt-4.1")
      const requested = {
        store: true,
        prompt_cache_retention: "24h",
        prompt_cache_options: { ttl: "12h", mode: "implicit" },
      }
      for (const found of [legacy, later]) {
        const selected = yield* admitted(found, zdr())
        const options = { loop: requested }
        sentToRecorder(yield* send(found, { headers: header(selected.id), providerOptions: options }))
        const held = parsed(hits.at(-1))
        expect(held.store).toBe(false)
        expect(held.prompt_cache_retention).toBe(found === legacy ? "in_memory" : "24h")
        expect(held.prompt_cache_options).toEqual(
          found === legacy ? { mode: "implicit" } : requested.prompt_cache_options,
        )
        sentToRecorder(yield* send(found, { headers: header(fresh()), providerOptions: options }))
        expect(parsed(hits.at(-1))).toMatchObject(requested)
      }
      const chosen = yield* admitted(official, zdr())
      const options = { openai: { store: true, promptCacheRetention: "24h" } }
      sentToRecorder(yield* send(official, { headers: header(chosen.id), providerOptions: options }))
      expect(parsed(hits.at(-1))).toMatchObject({ store: false, prompt_cache_retention: "in_memory" })
      sentToRecorder(yield* send(official, { headers: header(fresh()), providerOptions: options }))
      expect(parsed(hits.at(-1))).toMatchObject({ store: true, prompt_cache_retention: "24h" })
      const unknown = yield* admitted(opaque, zdr())
      const oldCount = hits.length
      refusedAs(
        yield* send(opaque, { headers: header(unknown.id), providerOptions: { loop: requested } }),
        "durable-cache",
      )
      refusedAs(
        yield* send(legacy, {
          headers: header((yield* admitted(legacy, zdr())).id),
          providerOptions: { loop: { model: "gpt-5.5" } },
        }),
        "fallback-models",
      )
      expect(hits).toHaveLength(oldCount)
      expect(guard.outside()).toEqual([])
    }),
  {
    ...options,
    config: {
      ...config,
      provider: {
        ...config.provider,
        loop: server(origin + "/v1", "@ai-sdk/openai-compatible", ["coder", "gpt-5.4", "gpt-5.5"]),
        openai: { options: { apiKey: "synthetic", baseURL: origin + "/v1" } },
      },
    },
  },
)

it.instance(
  "held direct compatible requests refuse web search and plugins before the SDK sends anything",
  () =>
    Effect.gen(function* () {
      const found = yield* model("loop", "coder")
      const ordinary = yield* admitted(found, STANDARD)
      const held = yield* admitted(found, zdr())
      for (const extra of [
        { web_search_options: { search_context_size: "low" } },
        { plugins: [{ id: "web" }] },
      ]) {
        const providerOptions = { loop: extra }
        sentToRecorder(yield* send(found, { headers: header(fresh()), providerOptions }))
        const bytes = hits.at(-1)!.body
        expect(parsed(hits.at(-1))).toMatchObject(extra)
        sentToRecorder(yield* send(found, { headers: header(ordinary.id), providerOptions }))
        expect(hits.at(-1)!.body).toBe(bytes)
        const count = hits.length
        refusedAs(yield* send(found, { headers: header(held.id), providerOptions }), "plugins")
        expect(hits).toHaveLength(count)
      }
      expect(guard.outside()).toEqual([])
    }),
  options,
)

it.instance(
  "held direct Responses requests refuse provider-stored history before the SDK sends anything",
  () =>
    Effect.gen(function* () {
      const found = yield* model("openai", "gpt-4.1")
      const ordinary = yield* admitted(found, STANDARD)
      const held = yield* admitted(found, zdr())
      for (const history of [
        { sdk: { previousResponseId: "resp_fixture" }, wire: { previous_response_id: "resp_fixture" } },
        { sdk: { conversation: "conv_fixture" }, wire: { conversation: "conv_fixture" } },
      ]) {
        const providerOptions = { openai: { store: false, ...history.sdk } }
        sentToRecorder(yield* send(found, { headers: header(fresh()), providerOptions }))
        const recorded = hits.at(-1)!
        expect(recorded.path).toBe("/v1/responses")
        expect(parsed(recorded)).toMatchObject({ store: false, ...history.wire })
        sentToRecorder(yield* send(found, { headers: header(ordinary.id), providerOptions }))
        expect(hits.at(-1)!.body).toBe(recorded.body)
        const count = hits.length
        refusedAs(yield* send(found, { headers: header(held.id), providerOptions }), "provider-options")
        expect(hits).toHaveLength(count)
      }
      expect(guard.outside()).toEqual([])
    }),
  {
    ...options,
    config: {
      ...config,
      provider: {
        ...config.provider,
        openai: { options: { apiKey: "synthetic", baseURL: origin + "/v1" } },
      },
    },
  },
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
      // Provider.getLanguage uses the SDK's generateContent model. Only its separate Interactions API accepts store.
      expect(hits.at(-1)?.path).toBe("/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse")
      expect(parsed(hits.at(-1))).not.toHaveProperty("store")
      const search = { type: "provider" as const, id: "google.google_search" as const, name: "google_search", args: {} }
      refusedAs(yield* send(gemini, { headers: header(google.id), tools: [search] }), "grounding-tool")
      const file = new URL("/v1beta/files/synthetic", origin)
      const cached = { providerOptions: { google: { cachedContent: "cachedContents/synthetic" } } }
      const attachment: LanguageModelV3CallOptions["prompt"] = [
        { role: "user", content: [{ type: "file", mediaType: "text/plain", data: file }] },
      ]
      refusedAs(yield* send(gemini, { headers: header(google.id), ...cached }), "durable-cache")
      refusedAs(yield* send(gemini, { headers: header(google.id), prompt: attachment }), "batch")
      const googleFetch = yield* sdkFetch(gemini)
      for (const [path, reason] of [
        ["/v1beta/models/gemini:batchGenerateContent", "batch"],
        ["/upload/v1beta/files", "batch"],
        ["/v1beta/cachedContents/synthetic", "durable-cache"],
      ] as const) {
        const init = { method: "POST", headers: header(google.id), body: "{}" }
        refusedAs(yield* call(googleFetch, origin + path, init), reason)
      }
      expect(hits).toHaveLength(3)
      sentToRecorder(yield* send(gemini, { headers: header(fresh()), ...cached }))
      expect(parsed(hits.at(-1)).cachedContent).toBe("cachedContents/synthetic")
      sentToRecorder(yield* send(gemini, { headers: header(fresh()), prompt: attachment }))
      expect(parsed(hits.at(-1)).contents).toEqual([
        { role: "user", parts: [{ fileData: { mimeType: "text/plain", fileUri: file.toString() } }] },
      ])
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

// VS-23c (SF-12b): the session runtime (session/llm.ts). LLM.stream asks ReviewRoutes.turn before it reads anything
// or chooses a runtime: a "zdr" review session sends only its pass's own turns (the agent Review.run registered, at full
// size), and only on the AI SDK runtime, whose fetch is the one above; every other request of it, and every request of a
// session whose parent is one, is refused there with `site` "session", so neither the native client nor the fetch ever
// sees it. Every other session's request takes the path it took before. The native runtime is on in this harness, and
// its client records each request it is given and sends nothing; sessions are real ones in the harness's database, as
// the review memory fence needs.
const nativeRequests: LLMRequest[] = []
const llmIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([LLM.node, Provider.node, Database.node, EventV2Bridge.node, SessionProjector.node, Env.node]),
    [
      ...fakes,
      [Database.node, Database.layerFromPath(":memory:")],
      [
        LayerNodePlatform.llmClient,
        Layer.succeed(
          LLMClient.Service,
          LLMClient.Service.of({
            prepare: () => Effect.die(new Error("The recording client prepares nothing.")),
            stream: (request) => {
              nativeRequests.push(request)
              return Stream.empty
            },
            generate: () => Effect.die(new Error("The recording client generates nothing.")),
          }),
        ),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: true })],
    ],
  ),
)

// A real session in the harness's database, published as the app creates one (llm.test.ts), so the review memory fence
// (llm.ts `ordinary`) admits its requests.
const ordinarySession = Effect.fnUntraced(function* (value: string, internal?: string) {
  const sessionID = SessionID.make(value)
  const database = yield* Database.Service
  if (yield* database.db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
    return
  const instance = yield* InstanceRef
  if (!instance) return yield* Effect.die("InstanceRef not provided")
  yield* database.db
    .insert(ProjectTable)
    .values({ id: instance.project.id, worktree: AbsolutePath.make(instance.worktree), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  const events = yield* EventV2Bridge.Service
  yield* events.publish(SessionV1.Event.Created, {
    sessionID,
    info: SessionV1.SessionInfo.make({
      id: sessionID,
      projectID: instance.project.id,
      directory: instance.directory,
      ...(internal ? { internal } : {}),
      slug: "zdr-route-fixture",
      title: "ZDR route fixture",
      version: "test",
      time: { created: 1, updated: 1 },
    }),
  })
})

// The kinds of request a session's runtime is asked for, shaped as their callers shape them: a pass's own turn (the
// agent Review.run registers), the title (prompt.ts), the memory learner (prompt.ts modelLearn), a compaction summary
// (compaction.ts, the compaction agent with no cache breakpoints), and the pass's own agent at the small size.
type Shape = {
  readonly agent?: string
  readonly small?: true
  readonly purpose?: "title" | "brain"
  readonly cache?: false
  readonly text?: (part: string) => void
}
const TURN: Shape = {}
const TITLE: Shape = { agent: "title", small: true, purpose: "title" }
const LEARNER: Shape = { agent: "brain.learn", small: true, purpose: "brain" }
const SKILL_DRAFT: Shape = { agent: "brain.skill", small: true, purpose: "brain" }
const COMPACTION: Shape = { agent: "compaction", cache: false }
const SMALL_TURN: Shape = { small: true }
const SHAPES = [TURN, TITLE, LEARNER, COMPACTION, SMALL_TURN]

// One LLM.stream request of a session, drained as the processor drains it; the error it ended with, if any.
const streamed = (found: Provider.Model, sessionID: string, shape: Shape = TURN, parentSessionID?: string) =>
  Effect.gen(function* () {
    yield* ordinarySession(sessionID)
    const runtime = yield* LLM.Service
    const agent = shape.agent ?? "review"
    const exit = yield* runtime
      .stream({
        user: {
          id: MessageID.make("msg_zdrroute"),
          sessionID: SessionID.make(sessionID),
          role: "user",
          time: { created: 1 },
          agent,
          model: { providerID: found.providerID, modelID: found.id },
        },
        sessionID,
        ...(parentSessionID ? { parentSessionID } : {}),
        model: found,
        agent: { name: agent, mode: "primary", options: {}, permission: [] },
        system: ["Review the change you are given."],
        messages: [{ role: "user", content: "Review src/list.ts" }],
        tools: {},
        ...(shape.small ? { small: true } : {}),
        ...(shape.purpose ? { purpose: shape.purpose } : {}),
        ...(shape.cache === false ? { cache: false } : {}),
      })
      .pipe(
        Stream.runForEach((part) =>
          Effect.sync(() => {
            if (part.type === "text-delta") shape.text?.(part.text)
          }),
        ),
        Effect.exit,
      )
    return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
  })

// Refused by the session runtime before it chose a runtime or built a request (`site` "session"), not by the fetch.
const refusedInSession = (error: unknown) => {
  refusedAs(error, "unknown-destination")
  expect((error as ReviewRoutes.Refused).site).toBe("session")
}

// Production uses the pass marker for the session and the registered agent for each turn.
// A pinned desktop run can select the vectorscope agent for all passes. The CLI uses review/security.
llmIt.instance(
  "all VectorScope passes complete on held wire formats and refuse auxiliary, native, free and unaccepted plan routes",
  () =>
    Effect.gen(function* () {
      const anthropic = yield* model("anthropic", "claude-haiku-4-5")
      const router = yield* model("openrouter", "deepseek/deepseek-chat-v3.1")
      const direct = yield* model("loop", "coder")
      const codium = yield* model(ModelPlans.PROVIDER_ID, codiumModel.id)
      const free = yield* model("vector", laguna.id)
      const passes = ["review", "security", "verify", "judge", "repro", ...REVIEW_LENSES.map((lens) => `lens.${lens}`)]
      const policy = zdr(["openrouter", ModelPlans.PROVIDER_ID, "vector"])
      // The native-enabled harness can actually take this same Anthropic model native.
      expect(yield* streamed(anthropic, fresh())).toBeUndefined()
      expect(nativeRequests).toHaveLength(1)
      const gatewayBefore = gateway.seen.length
      for (const prefix of ["vectorscope.", PINNED_SESSION_PREFIX])
        for (const pass of passes) {
          const internal = prefix + pass
          const agent =
            prefix === PINNED_SESSION_PREFIX ? VECTORSCOPE_AGENT : pass === "security" ? "security" : "review"
          for (const [found, path] of [
            [anthropic, "/v1/messages"],
            [router, "/api/v1/chat/completions"],
            [direct, "/v1/chat/completions"],
          ] as const) {
            const { id, decided } = yield* admitted(found, policy, {}, agent)
            expect(decided.decision).toEqual({
              allowed: true,
              kind: found === router ? "openrouter-attested" : "loopback",
            })
            yield* ordinarySession(id, internal)
            success.add(id)
            const start = hits.length
            let reply = ""
            expect(
              yield* streamed(found, id, {
                agent,
                text: (part) => {
                  reply += part
                },
              }),
            ).toBeUndefined()
            expect(reply).toBe(answer)
            expect(hits).toHaveLength(start + 1)
            const hit = hits[start]!
            expect([hit.method, hit.path, hit.headers["x-session-id"]]).toEqual(["POST", path, id])
            const body = parsed(hit)
            expect(body.model).toBe(found.api.id)
            expect(body.stream).toBe(true)
            expect(JSON.stringify(body.messages)).toContain("Review src/list.ts")
            if (found === router) {
              expect(body.provider).toMatchObject({ zdr: true, data_collection: "deny" })
              for (const key of ["models", "route", "preset", "plugins"]) expect(body).not.toHaveProperty(key)
            }
            if (found === anthropic) {
              expect(hit.headers["anthropic-version"]).toBeDefined()
              for (const key of ["container", "thread", "mcp_servers"]) expect(body).not.toHaveProperty(key)
            }
            // Same registration and model, but these helpers cannot send on either runtime.
            for (const shape of [TITLE, LEARNER, SKILL_DRAFT, COMPACTION, { ...SMALL_TURN, agent }])
              refusedInSession(yield* streamed(found, id, shape))
            refusedInSession(yield* streamed(found, fresh(), { agent }, id))
            expect(hits).toHaveLength(start + 1)
          }
          for (const [found, refusal] of [
            [codium, "codium-unaccepted"],
            [free, "free-model"],
          ] as const) {
            const { id, decided } = yield* admitted(found, policy, {}, agent)
            expect(decided.decision).toEqual({ allowed: false, refusal })
            yield* ordinarySession(id, internal)
            const before = freeCount()
            // The provider SDK's own fetch also enforces refusal if a caller gets past admission.
            refusedAs(yield* send(found, { headers: header(id) }), refusal)
            expect(freeCount()).toEqual(before)
          }
        }
      expect(hits).toHaveLength(passes.length * 2 * 3)
      expect(gateway.seen).toHaveLength(gatewayBefore)
      expect(nativeRequests).toHaveLength(1)
      expect(guard.outside()).toEqual([])
    }),
  options,
  30_000,
)

llmIt.instance(
  "the native runtime: other sessions go native, and a zdr session's turn goes out on the held fetch, its header named",
  () =>
    Effect.gen(function* () {
      const claude = yield* model("anthropic", "claude-haiku-4-5")
      expect(yield* streamed(claude, fresh())).toBeUndefined()
      const standard = fresh()
      ReviewRoutes.register(standard, { policy: STANDARD, agent: "review" })
      expect(yield* streamed(claude, standard)).toBeUndefined()
      expect(nativeRequests).toHaveLength(2)
      expect(hits).toHaveLength(0)
      const { id, decided } = yield* admitted(claude, zdr())
      expect(decided.decision).toEqual({ allowed: true, kind: "loopback" })
      expect(yield* streamed(claude, id)).not.toBeInstanceOf(ReviewRoutes.Refused)
      expect(nativeRequests).toHaveLength(2)
      expect(hits.map((hit) => [hit.method, hit.path, hit.headers["x-session-id"]])).toEqual([
        ["POST", "/v1/messages", id],
      ])
      expect(guard.outside()).toEqual([])
    }),
  options,
)

llmIt.instance(
  "a zdr session's title, memory learner, compaction summary and small request are refused before either runtime",
  () =>
    Effect.gen(function* () {
      for (const found of [yield* model("anthropic", "claude-haiku-4-5"), yield* model("loop", "coder")]) {
        const { id } = yield* admitted(found, zdr())
        for (const shape of [TITLE, LEARNER, COMPACTION, SMALL_TURN])
          refusedInSession(yield* streamed(found, id, shape))
      }
      expect(nativeRequests).toEqual([])
      expect(hits).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  options,
)

llmIt.instance(
  "a child of a zdr session is refused at its first request, and a child of a standard one is sent",
  () =>
    Effect.gen(function* () {
      const claude = yield* model("anthropic", "claude-haiku-4-5")
      const loop = yield* model("loop", "coder")
      const { id } = yield* admitted(loop, zdr())
      for (const found of [claude, loop]) refusedInSession(yield* streamed(found, fresh(), TURN, id))
      expect(nativeRequests).toEqual([])
      expect(hits).toEqual([])
      const standard = fresh()
      ReviewRoutes.register(standard, { policy: STANDARD, agent: "review" })
      expect(yield* streamed(claude, fresh(), TURN, standard)).toBeUndefined()
      sentToRecorder(yield* streamed(loop, fresh(), TURN, standard))
      expect(nativeRequests).toHaveLength(1)
      expect(hits).toHaveLength(1)
      expect(guard.outside()).toEqual([])
    }),
  options,
)

llmIt.instance(
  "a released zdr session's own turn is refused before either runtime, and a released standard session's is sent",
  () =>
    Effect.gen(function* () {
      const claude = yield* model("anthropic", "claude-haiku-4-5")
      const loop = yield* model("loop", "coder")
      const { id } = yield* admitted(loop, zdr())
      ReviewRoutes.release(id)
      // Nothing is registered now: every case releases what it registered.
      for (const found of [claude, loop]) refusedInSession(yield* streamed(found, id))
      refusedInSession(yield* streamed(loop, fresh(), TURN, id))
      expect(nativeRequests).toEqual([])
      expect(hits).toEqual([])
      const standard = fresh()
      ReviewRoutes.register(standard, { policy: STANDARD, agent: "review" })
      ReviewRoutes.release(standard)
      expect(yield* streamed(claude, standard)).toBeUndefined()
      sentToRecorder(yield* streamed(loop, standard))
      expect(nativeRequests).toHaveLength(1)
      expect(hits).toHaveLength(1)
      expect(guard.outside()).toEqual([])
    }),
  options,
)

llmIt.instance(
  "a zdr session's GitLab Duo workflow model is refused: it sends on a connection of its own, which nothing holds",
  () =>
    Effect.gen(function* () {
      // GitLab Duo is loaded, and its workflow models built, only with a token. Nothing here sends one anywhere.
      const env = yield* Env.Service
      yield* env.set("GITLAB_TOKEN", "synthetic-not-a-token")
      const duo = yield* model("gitlab", "duo-workflow-zdr")
      expect(duo.api.npm).toBe("gitlab-ai-provider")
      // Registered as Review.run registers a pass. The route decision is admission's, which this check does not read.
      const id = fresh()
      ReviewRoutes.register(id, { policy: zdr(), agent: "review" })
      refusedInSession(yield* streamed(duo, id))
      expect(nativeRequests).toEqual([])
      expect(hits).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  {
    trusted: true,
    config: {
      provider: {
        ...config.provider,
        gitlab: { options: { instanceUrl: origin }, models: { "duo-workflow-zdr": listed("duo-workflow-zdr") } },
      },
    },
  },
)

// I-1 at the session runtime. The same requests of an unregistered session, a standard one, a released standard one and
// a child of a standard one, in every shape above, on the AI SDK runtime ("loop") and the native one ("anthropic"), are
// recorded with no zdr session registered and again beside two registered zdr sessions and a released one. The standard
// session registered below stays registered through both rounds, so both run past `turn`'s and `zdr`'s first line (no
// session registered and none released) whatever order the cases run in, `-t` alone included; their early return is
// taken by no case here.
llmIt.instance(
  "other sessions send the same requests on both runtimes whether or not zdr sessions are registered or released",
  () =>
    Effect.gen(function* () {
      const claude = yield* model("anthropic", "claude-haiku-4-5")
      const loop = yield* model("loop", "coder")
      const standard = fresh()
      ReviewRoutes.register(standard, { policy: STANDARD, agent: "review" })
      const released = fresh()
      ReviewRoutes.register(released, { policy: STANDARD, agent: "review" })
      ReviewRoutes.release(released)
      const callers: (readonly [string, string | undefined])[] = [
        [fresh(), undefined],
        [standard, undefined],
        [released, undefined],
        [fresh(), standard],
      ]
      const round = Effect.gen(function* () {
        hits.length = 0
        nativeRequests.length = 0
        for (const found of [loop, claude])
          for (const [id, parent] of callers) for (const shape of SHAPES) yield* streamed(found, id, shape, parent)
        // Two native requests built alike do not compare equal as objects (toEqual shows no printable difference), so
        // they are compared as the JSON they serialize to.
        return { sent: [...hits], native: nativeRequests.map((request) => JSON.stringify(request)) }
      })
      const alone = yield* round
      yield* admitted(loop, zdr())
      yield* admitted(claude, zdr())
      ReviewRoutes.release((yield* admitted(loop, zdr())).id)
      const beside = yield* round
      expect(alone.sent).toHaveLength(callers.length * SHAPES.length)
      expect(alone.native).toHaveLength(callers.length * SHAPES.length)
      for (const request of alone.native) expect(request).toContain("Review src/list.ts")
      expect(beside).toEqual(alone)
      expect(guard.outside()).toEqual([])
    }),
  options,
)
