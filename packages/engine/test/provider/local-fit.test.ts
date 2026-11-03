import { afterEach, expect, jest } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { streamText, tool } from "ai"
import z from "zod"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { Effect } from "effect"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { useManagedPolicyFixture } from "../fixture/managed-policy"
import { testEffect } from "../lib/effect"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { Config } from "@/config/config"
import { Global } from "@vectordevai/core/global"
import { ProviderTransform } from "@/provider/transform"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Model servers someone hosts, end to end through the provider: a fake OpenAI-compatible server on 127.0.0.1 counts
// how many requests it is answering at once and holds each reply until the test lets it go. Nothing leaves this
// computer; the strict guard checks.
const guard = NetworkGuard.use()
const managedFixture: { restore?: () => void } = {}

afterEach(async () => {
  managedFixture.restore?.()
  managedFixture.restore = undefined
  jest.useRealTimers()
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, ModelSlots.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

const LOCAL = ProviderV2.ID.make("local")
const OTHER = ProviderV2.ID.make("other")
const CLOUD = ProviderV2.ID.make("cloud")
const COMPANY = ProviderV2.ID.make("company")
const CLOUD_ORIGIN = "https://api.cloud.invalid"
const COMPANY_ORIGIN = "https://llm.corp.example.com"
const BIG = ProviderV2.ID.make("big")
const MODEL = ModelV2.ID.make("qwen")

it.live("two providers that point at one server share its permit", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const first = yield* turn(provider, LOCAL, "user", "first")
          const second = yield* turn(provider, OTHER, "user", "second")
          yield* until(() => server.seen.length === 1)
          // The second provider's request waits for the first one's permit instead of reaching the server.
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen.map(said)).toEqual(["first"])
          server.release()
          yield* until(() => server.seen.length === 2)
          server.release()
          expect(yield* Effect.promise(() => Promise.all([first, second]))).toEqual(["reply 1", "reply 2"])
          expect(server.most).toBe(1)
        }),
      // Only the first provider says the server takes one request at a time; the second shares that limit.
      { trusted: true, config: config(server.url, { other: true, concurrency: 1 }) },
    ),
  ),
)

it.live("four subagents on a server on this computer whose number nobody configured run one at a time", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const replies: Promise<string>[] = []
          for (const n of [1, 2, 3, 4]) {
            replies.push(yield* turn(provider, LOCAL, "subagent", `subagent ${n}`))
            yield* Effect.promise(() => server.idle(10))
          }
          // They wait in Vector's line, in the order they asked, instead of inside the server against their timeouts.
          for (const n of [1, 2, 3, 4]) {
            yield* until(() => server.seen.length === n)
            yield* Effect.promise(() => server.idle(20))
            expect(server.seen).toHaveLength(n)
            server.release()
          }
          yield* Effect.promise(() => Promise.all(replies))
          expect(server.seen.map(said)).toEqual(["subagent 1", "subagent 2", "subagent 3", "subagent 4"])
          expect(server.most).toBe(1)
        }),
      { trusted: true, config: config(server.url) },
    ),
  ),
)

it.live("a provider's concurrency lets that many requests reach its server at once", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const replies = yield* Effect.all([1, 2, 3].map((n) => turn(provider, LOCAL, "user", `ask ${n}`)))
          yield* until(() => server.seen.length === 2)
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen).toHaveLength(2)
          server.release()
          server.release()
          yield* until(() => server.seen.length === 3)
          server.release()
          yield* Effect.promise(() => Promise.all(replies))
          expect(server.most).toBe(2)
        }),
      { trusted: true, config: config(server.url, { concurrency: 2 }) },
    ),
  ),
)

it.live("helpers wait behind the user's turn, and a new prompt drops a waiting helper", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const slots = yield* ModelSlots.Service
          const user = yield* turn(provider, LOCAL, "user", "the user's turn")
          yield* until(() => server.seen.length === 1)
          // A model the session processor did not name is a helper, such as a title.
          const title = yield* turn(provider, LOCAL, undefined, "a title")
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen.map(said)).toEqual(["the user's turn"])
          slots.prompted()
          const dropped = yield* Effect.promise(() =>
            title.then(
              () => undefined,
              (error: unknown) => error,
            ),
          )
          expect(dropped).toMatchObject({ name: "AbortError" })
          // Another helper waits until the user's reply ends, then runs.
          const summary = yield* turn(provider, LOCAL, undefined, "a summary")
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen).toHaveLength(1)
          server.release()
          yield* until(() => server.seen.length === 2)
          expect(server.seen.map(said)).toEqual(["the user's turn", "a summary"])
          server.release()
          expect(yield* Effect.promise(() => Promise.all([user, summary]))).toEqual(["reply 1", "reply 2"])
        }),
      { trusted: true, config: config(server.url) },
    ),
  ),
)

it.live("the header timeout starts once a request holds its permit", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const first = yield* turn(provider, LOCAL, "user", "slow")
          yield* until(() => server.seen.length === 1)
          const second = yield* turn(provider, LOCAL, "user", "queued")
          // The queued request waits well past its header timeout for the permit, and still gets its reply.
          yield* Effect.promise(() => server.idle(2_500))
          server.release()
          yield* until(() => server.seen.length === 2)
          server.release()
          expect(yield* Effect.promise(() => Promise.all([first, second]))).toEqual(["reply 1", "reply 2"])
        }),
      { trusted: true, config: config(server.url, { headerTimeout: 1_000, concurrency: 1 }) },
    ),
  ),
)

it.live("four subagents on a single-slot server run one at a time, in the order they asked", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const replies: Promise<string>[] = []
          for (const n of [1, 2, 3, 4]) {
            replies.push(yield* turn(provider, LOCAL, "subagent", `subagent ${n}`))
            yield* Effect.promise(() => server.idle(10))
          }
          for (const n of [1, 2, 3, 4]) {
            yield* until(() => server.seen.length === n)
            yield* Effect.promise(() => server.idle(20))
            expect(server.seen).toHaveLength(n)
            server.release()
          }
          expect(yield* Effect.promise(() => Promise.all(replies))).toEqual([
            "reply 1",
            "reply 2",
            "reply 3",
            "reply 4",
          ])
          expect(server.seen.map(said)).toEqual(["subagent 1", "subagent 2", "subagent 3", "subagent 4"])
          expect(server.most).toBe(1)
        }),
      { trusted: true, config: config(server.url, { concurrency: 1 }) },
    ),
  ),
)

it.live("two providers that configure different counts for one server both hold to the smaller one", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          // The provider that says 3 still waits by the other's 1, so their requests never take turns lifting it.
          const replies = yield* Effect.all([
            turn(provider, OTHER, "user", "first"),
            turn(provider, LOCAL, "user", "second"),
            turn(provider, OTHER, "user", "third"),
          ])
          for (const n of [1, 2, 3]) {
            yield* until(() => server.seen.length === n)
            yield* Effect.promise(() => server.idle(30))
            expect(server.seen).toHaveLength(n)
            server.release()
          }
          yield* Effect.promise(() => Promise.all(replies))
          expect(server.most).toBe(1)
        }),
      { trusted: true, config: config(server.url, { other: true, concurrency: 1, otherConcurrency: 3 }) },
    ),
  ),
)

it.live("a request stopped while it holds the server's permit gives it back, so the next one runs", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const stop = new AbortController()
          const first = yield* turn(provider, LOCAL, "user", "stopped", stop.signal)
          yield* until(() => server.seen.length === 1)
          const second = yield* turn(provider, LOCAL, "subagent", "next")
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen).toHaveLength(1)
          stop.abort()
          const stopped = yield* Effect.promise(() =>
            first.then(
              () => undefined,
              (error: unknown) => error,
            ),
          )
          expect(stopped).toMatchObject({ name: "AbortError" })
          yield* until(() => server.seen.length === 2)
          expect(server.seen.map(said)).toEqual(["stopped", "next"])
          server.release()
          server.release()
          expect(yield* Effect.promise(() => second)).toBe("reply 2")
        }),
      { trusted: true, config: config(server.url, { concurrency: 1 }) },
    ),
  ),
)

it.live("a tool call that asks the same single-slot server again gets its answer instead of waiting forever", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          server.auto = true
          const provider = yield* Provider.Service
          const model = Provider.withPriority(yield* provider.getModel(LOCAL, MODEL), "user")
          const inner = Provider.withPriority(model, "subagent")
          const language = yield* provider.getLanguage(model)
          const innerLanguage = yield* provider.getLanguage(inner)
          // The tool runs as soon as its call arrives, while the reply that made the call still holds the server's one
          // permit. The SDK reads that reply to its end meanwhile, which gives the permit to the tool's own request.
          const result = streamText({
            model: language,
            messages: [{ role: "user", content: "ask the helper" }],
            tools: {
              ask: tool({
                description: "Ask the model server again.",
                inputSchema: z.object({ question: z.string() }),
                execute: async (input) =>
                  streamText({ model: innerLanguage, messages: [{ role: "user", content: input.question }] }).text,
              }),
            },
          })
          const answers = yield* Effect.promise(() => Promise.resolve(result.toolResults))
          expect(answers.map((item) => item.output)).toEqual(["reply 2"])
          expect(server.seen.map(said)).toEqual(["ask the helper", "what is 2 + 2?"])
          expect(server.most).toBe(1)
        }),
      { trusted: true, config: config(server.url, { concurrency: 1 }) },
    ),
  ),
)

it.live("a reply stays inside the context the server has left after the prompt", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          server.auto = true
          const provider = yield* Provider.Service
          const small = Provider.withPriority(yield* provider.getModel(LOCAL, MODEL), "user")
          // No output limit is listed, so the reply gets a quarter of the 4,096-token context.
          expect(ProviderTransform.maxOutputTokens(small)).toBe(1_024)
          const listed = Provider.withPriority(yield* provider.getModel(OTHER, MODEL), "user")
          expect(ProviderTransform.maxOutputTokens(listed)).toBe(8_192)
          const ask = (model: Provider.Model, text: string) =>
            Effect.gen(function* () {
              const result = streamText({
                model: yield* provider.getLanguage(model),
                maxOutputTokens: ProviderTransform.maxOutputTokens(model),
                messages: [{ role: "user", content: text }],
              })
              return yield* Effect.promise(() => result.text)
            })
          yield* ask(small, "short")
          yield* ask(listed, "short")
          yield* ask(listed, "x".repeat(6_000))
          const sent = server.seen.map((body) => body.max_tokens)
          expect(sent[0]).toBe(1_024)
          // An 8,192-token reply cannot fit a 4,096-token context: it gets what the prompt leaves.
          expect(sent[1]).toBeGreaterThan(4_000)
          expect(sent[1]).toBeLessThan(4_096)
          expect(sent[2]).toBeGreaterThan(1_000)
          expect(sent[2]).toBeLessThan(4_096 - 1_500)
        }),
      { trusted: true, config: config(server.url, { other: true, output: 8_192 }) },
    ),
  ),
)

it.live("a model that lists no reply limit replies within what Check models would write, and a title within 512", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          server.auto = true
          const provider = yield* Provider.Service
          const big = Provider.withPriority(yield* provider.getModel(BIG, MODEL), "user")
          // Any reply limit the caller asks for, as the session asks for a quarter of a 128K context.
          expect(ProviderTransform.maxOutputTokens(big)).toBe(32_000)
          const ask = (model: Provider.Model) =>
            Effect.gen(function* () {
              const language = yield* provider.getLanguage(model)
              return yield* Effect.promise(
                () =>
                  streamText({
                    model: language,
                    maxOutputTokens: ProviderTransform.maxOutputTokens(model),
                    messages: [{ role: "user", content: "hi" }],
                  }).text,
              )
            })
          yield* ask(big)
          // A title or a name is brief, whatever the model's size.
          yield* ask(Provider.brief(big))
          expect(server.seen.map((body) => body.max_tokens)).toEqual([8_192, Provider.BRIEF_REPLY])
        }),
      { trusted: true, config: config(server.url, { big: true }) },
    ),
  ),
)

it.live("a server on this computer counts as local only for what it runs itself, not what it passes on", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const local = (providerID: string, modelID: string) =>
          provider
            .getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))
            .pipe(Effect.flatMap((model) => provider.line(model)))
        expect(yield* local("ollama", "qwen2.5-coder:7b")).toMatchObject({ hosted: true, local: true })
        // Ollama runs its cloud models on ollama.com; the daemon here only forwards the prompt.
        expect(yield* local("ollama", "gpt-oss:120b-cloud")).toMatchObject({ hosted: true, local: false })
        // A proxy Check models recorded as one that passes every prompt on, such as LiteLLM.
        expect(yield* local("proxy", "gpt-4.1")).toMatchObject({ hosted: true, local: false })
      }),
    {
      trusted: true,
      config: {
        provider: {
          ollama: {
            name: "Ollama",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "qwen2.5-coder:7b": { id: "qwen2.5-coder:7b", name: "qwen2.5-coder:7b", tool_call: true },
              "gpt-oss:120b-cloud": { id: "gpt-oss:120b-cloud", name: "gpt-oss:120b-cloud", tool_call: true },
            },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:11434/v1" },
          },
          proxy: {
            name: "LiteLLM",
            npm: "@ai-sdk/openai-compatible",
            models: { "gpt-4.1": { id: "gpt-4.1", name: "gpt-4.1", tool_call: true } },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:4000/v1", forwards: true },
          },
        },
      },
    },
  ),
)

it.live("a cloud API is left as it is: no line, so no permits and no reply limit of its own", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const cloud = yield* provider.getModel(CLOUD, MODEL)
        // The same language model comes back each time: nothing wraps it.
        expect(yield* provider.getLanguage(cloud)).toBe(yield* provider.getLanguage(cloud))
        expect(yield* provider.line(cloud)).toBeUndefined()
        const local = yield* provider.getModel(LOCAL, MODEL)
        expect(yield* provider.getLanguage(local)).not.toBe(yield* provider.getLanguage(local))
        expect(guard.outside()).toEqual([])
      }),
    { trusted: true, config: config("http://127.0.0.1:1/v1", { cloud: true }) },
  ),
)

// The actual provider and SDK run against controlled in-memory fetch responses. Advancing Bun's global fake clock
// by minutes while TCP or child-process events are outstanding can strand those events on Linux and Windows.
it.live(
  "a server someone hosts waits 10 minutes for headers and 2 between chunks, and a cloud API keeps the SDK's",
  () =>
    withStall((server) =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const localProvider = yield* provider.getProvider(LOCAL)
            const cloudProvider = yield* provider.getProvider(CLOUD)
            localProvider.options.fetch = server.fetch
            cloudProvider.options.fetch = server.fetch
            const hosted = yield* provider.getLanguage(
              Provider.withPriority(yield* provider.getModel(LOCAL, MODEL), "user"),
            )
            const cloud = yield* provider.getLanguage(yield* provider.getModel(CLOUD, MODEL))
            // Only Promise/ReadableStream work remains once the fake clock starts; the provider and SDK are real.
            yield* Effect.promise(async () => {
              const active: Promise<unknown>[] = []
              const follow = <T>(promise: PromiseLike<T>) => {
                active.push(Promise.resolve(promise).catch(() => undefined))
                return watch(promise)
              }
              jest.useFakeTimers()
              try {
                // No headers: a server someone hosts is given up on after ten minutes, and not before.
                const first = follow(hosted.doStream(call("first")))
                await ready(server.arrived(1), "first request arrival")
                jest.advanceTimersByTime(Provider.LOCAL_HEADER_TIMEOUT - 1)
                expect(await first.state()).toBe("pending")
                jest.advanceTimersByTime(1)
                await ready(
                  first.done().catch(() => undefined),
                  "header timeout propagation",
                )
                expect(await first.state()).toBe("failed")
                expect(ProviderError.unwrapTypedError(first.error())).toMatchObject({
                  ms: Provider.LOCAL_HEADER_TIMEOUT,
                })

                // Headers and the first chunk, then nothing: it is given up on after two minutes without a chunk.
                const second = follow(hosted.doStream(call("second")))
                await ready(server.arrived(2), "second request arrival")
                server.headers(1)
                const streaming = Promise.withResolvers<void>()
                const quiet = follow(
                  drain((await ready(second.done(), "second response headers")).stream, streaming.resolve),
                )
                // The decoder consumed the first text chunk and drain requested the next before time moves.
                await ready(streaming.promise, "first hosted text chunk")
                expect(await quiet.state()).toBe("pending")
                jest.advanceTimersByTime(Provider.LOCAL_CHUNK_TIMEOUT - 1)
                expect(await quiet.state()).toBe("pending")
                jest.advanceTimersByTime(1)
                await ready(
                  quiet.done().catch(() => undefined),
                  "chunk timeout propagation",
                )
                expect(await quiet.state()).toBe("failed")
                expect(ProviderError.unwrapTypedError(quiet.error())).toMatchObject({ message: "SSE read timed out" })

                // The cloud API has neither: it waits as long as the reply takes.
                const third = follow(cloud.doStream(call("third")))
                await ready(server.arrived(3), "cloud request arrival")
                jest.advanceTimersByTime(Provider.LOCAL_HEADER_TIMEOUT * 2)
                expect(await third.state()).toBe("pending")
                server.headers(2)
                const cloudStreaming = Promise.withResolvers<void>()
                const waited = follow(
                  drain((await ready(third.done(), "cloud response headers")).stream, cloudStreaming.resolve),
                )
                await ready(cloudStreaming.promise, "first cloud text chunk")
                expect(await waited.state()).toBe("pending")
                jest.advanceTimersByTime(Provider.LOCAL_CHUNK_TIMEOUT * 2)
                expect(await waited.state()).toBe("pending")
                server.end(2)
                expect(await ready(waited.done(), "cloud response completion")).toBe("done")
              } finally {
                try {
                  server.close()
                  await ready(Promise.all(active), "controlled request cleanup")
                } finally {
                  jest.useRealTimers()
                }
              }
            })
            expect(server.seen).toEqual(["first", "second", "third"])
            expect(guard.outside()).toEqual([])
          }),
        { trusted: true, config: config(server.url, { cloud: server.url }) },
      ),
    ),
)

it.live("a company endpoint on the model server list is fitted like a server someone hosts, and still priced", () =>
  withServer((server) =>
    listed([COMPANY_ORIGIN], () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            server.auto = true
            const provider = yield* Provider.Service
            const company = Provider.withPriority(yield* provider.getModel(COMPANY, MODEL), "user")
            const elsewhere = Provider.withPriority(yield* provider.getModel(CLOUD, MODEL), "user")
            // Its name looks like any internet host's, but it is on the list: it is fitted, and its steps stay unpriced
            // rather than local, so a dollar cap still stops them.
            expect(yield* provider.line(company)).toMatchObject({ hosted: true, local: false })
            expect(yield* provider.line(elsewhere)).toBeUndefined()
            const ask = (model: Provider.Model) =>
              Effect.gen(function* () {
                const language = yield* provider.getLanguage(model)
                return yield* Effect.promise(
                  () =>
                    streamText({ model: language, maxOutputTokens: 4_000, messages: [{ role: "user", content: "hi" }] })
                      .text,
                )
              })
            yield* ask(company)
            yield* ask(elsewhere)
            // The listed endpoint's reply fits its 4,096-token context, at what Check models would write for it; a
            // cloud API nobody listed is left as the caller asked.
            expect(server.seen.map((body) => body.max_tokens)).toEqual([1_024, 4_000])
            expect(guard.outside()).toEqual([])
          }),
        {
          trusted: true,
          config: config(server.url, { company: true, cloud: server.url }),
        },
      ),
    ),
  ),
)

it.live(
  "a private server the company lists has no per-token price, and one an edit still held adds is off until confirmed",
  () => {
    const globalFile = path.join(Global.Path.config, "vector.json")
    const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
    // A repository's config may not point a provider at the user's network, so the user's own config does. Nothing is
    // sent: only the line is read.
    const server = (origin: string) => ({
      name: "Model server",
      npm: "@ai-sdk/openai-compatible",
      models: { qwen: { id: "qwen", name: "qwen", tool_call: true, cost: { input: 0, output: 0 } } },
      options: { apiKey: "test-key", baseURL: `${origin}/v1` },
    })
    const providers = { kimi: server("http://10.0.0.5:8000"), held: server("http://10.0.0.9:8000") }
    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          mkdirSync(managedDirectory, { recursive: true })
          writeFileSync(
            path.join(managedDirectory, "vector.json"),
            JSON.stringify({ local: { endpoints: ["http://10.0.0.5:8000"] } }),
          )
          managedFixture.restore = useManagedPolicyFixture(managedDirectory)
          writeFileSync(globalFile, JSON.stringify({ provider: providers, local: { enabled: true } }))
          Config.refreshLocal()
          writeFileSync(
            globalFile,
            JSON.stringify({ provider: providers, local: { enabled: true, endpoints: ["http://10.0.0.9:8000"] } }),
          )
          Config.refreshLocal()
          expect(Config.localPending()?.changes).toEqual(["adds the model server http://10.0.0.9:8000"])

          const provider = yield* Provider.Service
          const line = (providerID: string) =>
            provider
              .getModel(ProviderV2.ID.make(providerID), MODEL)
              .pipe(Effect.flatMap((model) => provider.line(model)))
          expect(yield* line("kimi")).toMatchObject({ hosted: true, local: true })
          // Until the owner confirms the edit, its server is not on the list in effect, so Vector Local keeps it off.
          const held = yield* line("held").pipe(Effect.flip)
          expect(held.unavailable?.reason).toBe("off-in-local")
          Config.confirmLocal()
          expect(yield* line("held")).toMatchObject({ hosted: true, local: true })
          expect(guard.outside()).toEqual([])
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              rmSync(globalFile, { force: true })
              rmSync(managedDirectory, { recursive: true, force: true })
              rmSync(Config.localConfirmedFile(), { force: true })
              Config.refreshLocal()
              Config.confirmLocal()
            }),
          ),
        ),
      { trusted: true },
    )
  },
)

it.live(
  "a cloud AI service in the model catalog stops being one of the user's model servers once providers load",
  () => {
    // In the test catalog (scaleway) and not in the registry's own list of cloud AI hosts.
    const scaleway = "https://api.scaleway.ai"
    const globalFile = path.join(Global.Path.config, "vector.json")
    expect(LocalPolicy.resolve({ global: { endpoints: [scaleway] } }).endpoints).toEqual([
      { origin: scaleway, from: "user" },
    ])
    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          writeFileSync(globalFile, JSON.stringify({ local: { endpoints: [scaleway] } }))
          Config.refreshLocal()
          const provider = yield* Provider.Service
          yield* provider.list()
          expect(Config.local().endpoints).toEqual([])
          expect(Config.local().warnings).toContain(
            `Ignored ${scaleway}: it is a cloud AI service, not a server you host. Your company's policy can list it.`,
          )
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              rmSync(globalFile, { force: true })
              Config.refreshLocal()
            }),
          ),
        ),
      { trusted: true },
    )
  },
)

// One streamed request through the provider; resolves with the reply's text. `priority` is what the session processor
// names; undefined is any other caller, a helper.
function turn(
  provider: Provider.Interface,
  providerID: ProviderV2.ID,
  priority: ModelSlots.Priority | undefined,
  text: string,
  signal?: AbortSignal,
) {
  return Effect.gen(function* () {
    const found = yield* provider.getModel(providerID, MODEL)
    const model = priority ? Provider.withPriority(found, priority) : found
    const failed: { error?: unknown } = {}
    const result = streamText({
      model: yield* provider.getLanguage(model),
      abortSignal: signal,
      onError: ({ error }) => {
        failed.error = error
      },
      messages: [{ role: "user", content: text }],
    })
    // The stream's own error, rather than the SDK's "no output" that follows it.
    return Promise.resolve(result.text).catch((error: unknown) => Promise.reject(failed.error ?? error))
  })
}

function said(body: Record<string, any>) {
  return body.messages.at(-1)?.content
}

const until = (check: () => boolean) =>
  Effect.promise(async () => {
    const stop = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > stop) throw new Error("timed out waiting for the model server")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })

function config(
  url: string,
  options: {
    other?: boolean
    /**
     * A cloud API at https://api.cloud.invalid, or, given a server, one whose requests a plugin sends to that server
     * (`preconnect` names the cloud API's origin), so its requests reach a fake server while it counts as a cloud API.
     */
    cloud?: boolean | string
    /** A company endpoint at https://llm.corp.example.com, whose requests go to this server the same way. */
    company?: boolean
    /** A model with a 128K context on the same server. */
    big?: boolean
    concurrency?: number
    otherConcurrency?: number
    headerTimeout?: number
    output?: number
  } = {},
) {
  const provider = (baseURL: string, output = 0, concurrency?: number, context = 4_096, preconnect?: string) => ({
    name: "Model server",
    npm: "@ai-sdk/openai-compatible",
    models: {
      qwen: {
        id: "qwen",
        name: "qwen",
        tool_call: true,
        limit: { context, output },
        cost: { input: 0, output: 0 },
      },
    },
    options: {
      apiKey: "test-key",
      baseURL,
      ...(concurrency ? { concurrency } : {}),
      ...(options.headerTimeout ? { headerTimeout: options.headerTimeout } : {}),
      ...(preconnect ? { preconnect } : {}),
    },
  })
  return {
    formatter: false,
    lsp: false,
    provider: {
      local: provider(url, 0, options.concurrency),
      ...(options.other ? { other: provider(url, options.output, options.otherConcurrency) } : {}),
      ...(options.cloud
        ? {
            cloud:
              typeof options.cloud === "string"
                ? provider(options.cloud, 0, undefined, 4_096, CLOUD_ORIGIN)
                : provider(`${CLOUD_ORIGIN}/v1`),
          }
        : {}),
      ...(options.company ? { company: provider(url, 0, undefined, 4_096, COMPANY_ORIGIN) } : {}),
      ...(options.big ? { big: provider(url, 0, undefined, 131_072) } : {}),
    },
  }
}

type Server = {
  readonly url: string
  /** Request bodies in the order they arrived. */
  readonly seen: Record<string, any>[]
  /** The most requests the server answered at once. */
  readonly most: number
  /** Answers at once instead of holding each reply. */
  auto: boolean
  /** Finishes the oldest reply still held. */
  readonly release: () => void
  /** Waits a while so a request that is not going to arrive has had its chance. */
  readonly idle: (ms: number) => Promise<void>
}

function withServer<A, E, R>(body: (server: Server) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(() => modelServer()),
    (started) => body(started.server),
    (started) => Effect.sync(() => started.close()),
  )
}

async function modelServer() {
  const held: (() => void)[] = []
  const state = { running: 0, most: 0, replies: 0 }
  const server: Server = {
    url: "",
    seen: [],
    get most() {
      return state.most
    },
    auto: false,
    release: () => held.shift()?.(),
    idle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      server.seen.push(JSON.parse(Buffer.concat(chunks).toString()))
      state.running += 1
      state.most = Math.max(state.most, state.running)
      const body = server.seen.at(-1)!
      const reply = `reply ${++state.replies}`
      // A request that offers tools gets a call to the first one, the way a model asks for more.
      const call = body.tools?.[0]?.function?.name
      const chunk = call
        ? {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: call, arguments: JSON.stringify({ question: "what is 2 + 2?" }) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }
        : { choices: [{ delta: { content: reply } }] }
      // Headers go out at once, as a server does when it starts on a request; the reply comes when released.
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.flushHeaders()
      const finish = () => {
        state.running -= 1
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
      }
      if (server.auto) return finish()
      held.push(finish)
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (!address || typeof address === "string") throw new Error("the model server did not bind to a TCP port")
  Object.assign(server, { url: `http://127.0.0.1:${address.port}/v1` })
  return {
    server,
    close: () => {
      held.splice(0).forEach((finish) => finish())
      http.close()
    },
  }
}

// Puts origins on the model server list in the user's own config for `body`, then takes them off again. A loosening
// edit waits for the owner, who says yes here.
function listed<A, E, R>(origins: readonly string[], body: () => Effect.Effect<A, E, R>) {
  const file = path.join(Global.Path.config, "vector.json")
  const apply = () => {
    Config.refreshLocal()
    Config.confirmLocal()
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      writeFileSync(file, JSON.stringify({ local: { endpoints: origins.map((item) => new URL(item).origin) } }))
      apply()
    }),
    body,
    () =>
      Effect.sync(() => {
        rmSync(file, { force: true })
        apply()
        rmSync(Config.localConfirmedFile(), { force: true })
      }),
  )
}

// A request to a model as the SDK makes it.
function call(text: string): LanguageModelV3CallOptions {
  return { prompt: [{ role: "user", content: [{ type: "text", text }] }] }
}

// Reads a reply to its end.
async function drain(stream: ReadableStream<LanguageModelV3StreamPart>, streaming: () => void) {
  const reader = stream.getReader()
  while (true) {
    const part = await reader.read()
    if (part.done) return "done"
    if (part.value.type === "text-delta" && part.value.delta === "waiting") streaming()
  }
}

// The controlled fetch and SDK settle through microtasks, so observation does not depend on I/O under fake time.
function watch<T>(promise: PromiseLike<T>) {
  const seen: { state: "pending" | "done" | "failed"; error?: unknown } = { state: "pending" }
  Promise.resolve(promise).then(
    () => Object.assign(seen, { state: "done" }),
    (error: unknown) => Object.assign(seen, { state: "failed", error }),
  )
  return {
    state: async () => {
      for (const _ of Array.from({ length: 50 })) {
        if (seen.state !== "pending") break
        await Promise.resolve()
      }
      return seen.state
    },
    error: () => seen.error,
    done: () => Promise.resolve(promise),
  }
}

// Every phase here uses in-memory promises. Bound its microtask turns so a broken SDK/fixture phase fails inside
// the test's finally, rather than leaving a coroutine alive after Bun's outer timeout restores real timers.
async function ready<T>(promise: PromiseLike<T>, phase: string): Promise<T> {
  const observed = watch(promise)
  for (const _ of Array.from({ length: 20 })) {
    if ((await observed.state()) !== "pending") return observed.done()
  }
  throw new Error(`In-memory response did not settle while waiting for ${phase}`)
}

type Stall = {
  readonly url: string
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  readonly close: () => void
  /** The last message of each request, in the order they arrived. */
  readonly seen: string[]
  /** Resolves once `count` requests have arrived. */
  readonly arrived: (count: number) => Promise<void>
  /** Sends the headers and an initial text chunk of the request at `index`, leaving the rest pending. */
  readonly headers: (index: number) => void
  /** Sends the rest of the reply of the request at `index`. */
  readonly end: (index: number) => void
}

// Controlled OpenAI-compatible responses: the real SDK still builds/parses them, while no TCP or child process has
// to make progress after a large fake-clock jump. Unanswered fetches honor the provider's header AbortSignal.
function withStall<A, E, R>(body: (server: Stall) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const requests: {
        readonly respond: (response: Response) => void
        readonly reject: (error: unknown) => void
        controller?: ReadableStreamDefaultController<Uint8Array>
        closed: boolean
      }[] = []
      const waits: { readonly count: number; readonly resolve: () => void }[] = []
      const seen: string[] = []
      const encoder = new TextEncoder()
      const lifecycle = { closed: false }
      const stall: Stall = {
        url: "http://127.0.0.1:1/v1",
        fetch: async (_input, init) => {
          if (lifecycle.closed) throw new Error("controlled response disposed")
          if (typeof init?.body !== "string") throw new Error("SDK did not send a JSON request body")
          const response = Promise.withResolvers<Response>()
          const payload = JSON.parse(init.body) as { messages: { content: string }[] }
          const signal = init.signal
          const aborted = () => response.reject(signal?.reason)
          const waiting = { respond: response.resolve, reject: response.reject, closed: false }
          seen.push(payload.messages.at(-1)?.content ?? "")
          requests.push(waiting)
          signal?.addEventListener("abort", aborted, { once: true })
          if (signal?.aborted) aborted()
          waits.filter((wait) => requests.length >= wait.count).forEach((wait) => wait.resolve())
          return response.promise.finally(() => signal?.removeEventListener("abort", aborted))
        },
        close: () => {
          lifecycle.closed = true
          requests.forEach((request) => {
            request.reject(new Error("controlled response disposed"))
            if (request.closed) return
            request.closed = true
            request.controller?.close()
          })
        },
        seen,
        arrived: (count) =>
          requests.length >= count
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                waits.push({ count, resolve })
              }),
        headers: (index) => {
          const request = requests[index]
          request.respond(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  request.controller = controller
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "waiting" } }] })}\n\n`),
                  )
                },
                cancel() {
                  request.closed = true
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
          )
        },
        end: (index) => {
          const request = requests[index]
          if (request.closed || !request.controller) return
          request.closed = true
          request.controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\n` +
                "data: [DONE]\n\n",
            ),
          )
          request.controller.close()
        },
      }
      return { stall, requests }
    }),
    (started) => body(started.stall),
    (started) => Effect.sync(() => started.stall.close()),
  )
}
