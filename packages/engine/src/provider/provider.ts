import {
  activeOAuthApproval,
  pluginCredentialAllowed,
  requirePluginDestination,
} from "@vectordevai/core/plugin/oauth-approval"
import { ProviderSDK } from "@vectordevai/core/provider-sdk"
import { FreeModels } from "@vectordevai/core/free-models"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionID } from "@vectordevai/schema/session-id"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { CodiumAuto } from "@vectordevai/core/codium-auto"
import { TaskSize } from "@vectordevai/core/task-size"
import { freeModelRequest, serializeFreeModelRequest } from "@vectordevai/core/free-model-request"
import {
  FREE_MODEL_FALLBACKS,
  FREE_ROUTER_ID,
  FreeDataPolicy,
  isFreeModel,
  isFreeModelRef,
  type FreeModelCatalog,
  type FreeModelInfo,
} from "@vectordevai/schema/free-model"
import {
  denyDataCollection,
  freeModelDataPolicy,
  isOpenRouterFreeModel,
  isOpenRouterURL,
  openRouterModelRouting,
  sendsToOpenRouterFree,
} from "@vectordevai/core/free-model-catalog"
import {
  FREE_MODEL_UNLISTED,
  FREE_MODELS_SIGN_IN,
  FREE_MODELS_SIGN_IN_TERMINAL,
  freeModelCatalogName,
  freeModelMayTrain,
} from "@vectordevai/core/free-model-choice"
import {
  OFF_IN_LOCAL,
  ProviderUnavailable,
  providerRetired,
  providerUnavailable,
} from "@vectordevai/schema/provider-unavailable"
import { renamedModel } from "@vectordevai/schema/provider-policy"
import {
  providerAllowed,
  providerCredentialAllowed,
  providerCredentialUnavailable,
  providerEnabled,
  providerEnvironmentAllowed,
  providerUsable,
  requireGitlabOAuthEndpoint,
} from "@vectordevai/core/provider-policy"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import os from "os"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import fuzzysort from "fuzzysort"
import { Config } from "@/config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Npm } from "@vectordevai/core/npm"
import { Hash } from "@vectordevai/core/util/hash"
import { Plugin } from "../plugin"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { type LanguageModelV3, type LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { OAUTH_DUMMY_KEY } from "@/auth"
import { Auth } from "../auth"
import { Env } from "../env"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { iife } from "@/util/iife"
import { Global } from "@vectordevai/core/global"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Option, Schema, Stream, Types } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { EffectPromise } from "@/effect/promise"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Redaction } from "@vectordevai/core/redaction"
import { isRecord } from "@/util/record"
import { optional } from "@vectordevai/core/schema"
import { ProviderTransform } from "./transform"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { ModelStatus } from "./model-status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderError } from "./error"
import { ResponseTerminal } from "./response-terminal"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { LocalProbe } from "@vectordevai/core/local-mode/probe"
import type { LocalMode } from "@vectordevai/schema/local-mode"

const OPENAI_HEADER_TIMEOUT_DEFAULT = 10_000
// A server someone hosts may load the model before it answers, which can take minutes on the first request, and a
// large prompt can keep it busy between chunks. A provider's own headerTimeout or chunkTimeout replaces these.
export const LOCAL_HEADER_TIMEOUT = 600_000
export const LOCAL_CHUNK_TIMEOUT = 120_000

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new ProviderError.ResponseStreamError("SSE read timed out")
          ctl.abort(err)
          void reader.cancel(err)
          reject(err)
        }, ms)

        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}

// A provider's base URL from its options or the catalog, with variables from its loader and the environment filled in.
function resolveBaseURL(
  model: Model,
  options: Record<string, unknown>,
  loader: CustomVarsLoader | undefined,
  envs: Record<string, string | undefined>,
) {
  const url = typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
  if (!url) return
  return Object.entries(loader ? loader(options) : {})
    .reduce((current, [key, value]) => current.replaceAll("${" + key + "}", value), url)
    .replace(/\$\{([^}]+)\}/g, (item, key) => envs[String(key)] ?? item)
}

// Where these SDKs send requests when neither configuration nor the catalog names a base URL.
const SDK_ORIGINS: Record<string, string> = {
  "@ai-sdk/openai": "https://api.openai.com",
  "@ai-sdk/anthropic": "https://api.anthropic.com",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com",
}

// The origins a model's requests count as going to, first the one they wait in line for: the origin of the base URL
// the SDK sends to (variables filled in, or the SDK's own), and, before it, the one a plugin that sends them elsewhere
// names in the `preconnect` option (ChatGPT sign-in's Codex endpoint). Config can set `preconnect` too, so it only adds
// an address: a model counts as on a server someone hosts, or on the list, only when every address is, and a base URL
// nobody can tell leaves none. A repository therefore cannot make a cloud API on the user's key count as a free local
// server, or as one on the list, by naming a loopback `preconnect`.
function requestOrigins(
  model: Model,
  options: Record<string, unknown>,
  loader: CustomVarsLoader | undefined,
  envs: Record<string, string | undefined>,
) {
  const origin = (url: string | undefined) => {
    if (!url || !URL.canParse(url)) return
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined
  }
  const sent = origin(resolveBaseURL(model, options, loader, envs) ?? SDK_ORIGINS[model.api.npm])
  if (!sent) return []
  const named = typeof options["preconnect"] === "string" ? origin(options["preconnect"]) : undefined
  return named && named !== sent ? [named, sent] : [sent]
}

// The registry source a model call to `target` naming `models` is decided as (LocalSources): an Ollama cloud model,
// which the server passes on to ollama.com (known by its name, or by the remote fields the server gave when it was
// checked), a cloud AI service by its host (listed by a company or not), or a model server someone hosts, listed or
// not.
function inferenceSource(models: readonly string[], target: string, policy: LocalMode.Policy, holds: LocalProbe.Holds) {
  if (holds.passesOn(target, models, policy)) return "ollama-cloud-models"
  return LocalSources.inference(target)
}

// The model a model call's JSON body names (`model`, as OpenAI-compatible and Ollama requests send it): model and
// provider options can replace the one the SDK was made for.
function bodyModel(body: unknown) {
  if (typeof body !== "string") return undefined
  const sent = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body))
  return isRecord(sent) && typeof sent.model === "string" ? sent.model : undefined
}

// The notice for a model Vector Local keeps off, or undefined when its requests go to a model server on the list. It
// reads where the requests go as the fetch below sends them (a plugin's `preconnect`, variables filled in), and decides
// without logging: the network log records requests, not lists. The saved credential stays, so no notice says to remove
// it.
function offInLocal(
  model: Model,
  options: Record<string, unknown>,
  loader: CustomVarsLoader | undefined,
  envs: Record<string, string | undefined>,
  policy: LocalMode.Policy,
  holds: LocalProbe.Holds,
): ProviderUnavailable | undefined {
  const notice = (why: string) => ({
    id: model.providerID,
    reason: "off-in-local" as const,
    message: `${model.providerID}: off in Vector Local. ${why}`,
  })
  if (model.providerID === ProviderV2.ID.vector || model.providerID === ModelPlans.PROVIDER_ID || model.freeModel)
    return notice(OFF_IN_LOCAL.vector)
  const origins = requestOrigins(model, options, loader, envs)
  if (origins.length === 0) return notice(OFF_IN_LOCAL.unknown)
  // The first address Vector Local would not let a model call reach decides the notice.
  const refused = origins.flatMap((origin) => {
    const source = inferenceSource([model.api.id], origin, policy, holds)
    if (source === "ollama-cloud-models") return [notice(OFF_IN_LOCAL.ollama)]
    const verdict = LocalPolicy.decide(policy, { purpose: "inference", url: origin, source })
    if (verdict.decision === "allow") return []
    if (verdict.rule === "not-allowable") return [notice(OFF_IN_LOCAL.cloud(origin))]
    return [providerUnavailable(model.providerID, "off-in-local")]
  })
  return refused[0]
}

// The lane a model's requests take in a server's line. The session processor names the user's turn and its
// subagents, and a title or a name is brief; any other request, such as a summary or a generated agent, is a helper.
const lanes = new WeakMap<Model, { readonly priority: ModelSlots.Priority; readonly brief?: boolean }>()

/** A copy of `model` whose requests to a model server someone hosts wait in line as `priority`. */
export function withPriority(model: Model, priority: ModelSlots.Priority): Model {
  const copy = { ...model }
  lanes.set(copy, { priority })
  return copy
}

/** The lane `model`'s requests wait in at a server's line: a helper unless the session processor named it. */
export function priorityOf(model: Model): ModelSlots.Priority {
  return lanes.get(model)?.priority ?? "helper"
}

/**
 * A copy of `model` for a title or a name: a helper whose reply from a model server someone hosts stays within
 * BRIEF_REPLY tokens, so it never holds a single-slot server through a long answer while the user's next step waits.
 */
export function brief(model: Model): Model {
  const copy = { ...model }
  lanes.set(copy, { priority: "helper", brief: true })
  return copy
}

/** The most a title or a name may reply with on a model server someone hosts. */
export const BRIEF_REPLY = 512

// The most a model that lists no reply limit of its own may reply with on a model server someone hosts: what Check
// models writes for a model (LocalProbe.output), so a model replies the same whether or not it was checked.
const HOSTED_REPLY = 8_192

/** The line a model's requests wait in at a model server. */
export type Line = {
  /** The server's origin, which every provider pointing at it shares. */
  readonly origin: string
  /**
   * Whether someone hosts the server: it is on this computer, on the user's network or on the model server list. Such a
   * server gets the slower timeouts, the context checks, a reply that fits its context and the fixes for its errors. A
   * cloud API whose provider configures `concurrency` has a line too, and none of the rest.
   */
  readonly hosted: boolean
  /** The smallest `concurrency` this provider or another one pointing at the same server configures. */
  readonly permits?: number
  /** Whether its steps have no per-token price (ModelSlots.local). */
  readonly local: boolean
}

// The most a reply from a model server someone hosts may take: a title's or a name's few hundred tokens, and for a
// model that lists no reply limit of its own what Check models would write for its context.
function hostedCeiling(model: Model, brief: boolean) {
  if (brief) return BRIEF_REPLY
  if (model.limit.output > 0) return undefined
  if (model.limit.context <= 0) return HOSTED_REPLY
  return Math.max(1, Math.min(HOSTED_REPLY, Math.floor(model.limit.context / 4)))
}

// Holds each request to a model server to a permit, and on a server someone hosts keeps its reply inside the server's
// context and within the reply limits above. The permit is taken before the SDK calls fetch, where the header timeout
// starts, and given back when the reply ends, fails, is cancelled or its request is aborted. `context` is 0 for a server
// whose context is not known, or a cloud API that configures `concurrency`: neither has its reply fitted to it.
function fitted(
  language: LanguageModelV3,
  input: {
    readonly slots: ModelSlots.Interface
    readonly origin: string
    readonly permits: number | undefined
    readonly priority: ModelSlots.Priority
    readonly context: number
    /** The most the reply may take, or undefined to leave the caller's limit. */
    readonly ceiling: number | undefined
  },
): LanguageModelV3 {
  const acquire = (options: LanguageModelV3CallOptions) =>
    input.slots.acquire({
      origin: input.origin,
      permits: input.permits,
      priority: input.priority,
      signal: options.abortSignal,
    })
  const clamp = (options: LanguageModelV3CallOptions) => {
    const asked =
      input.ceiling === undefined
        ? options.maxOutputTokens
        : Math.min(options.maxOutputTokens ?? input.ceiling, input.ceiling)
    if (asked === undefined) return options
    const room = input.context > 0 ? input.context - promptTokens(options) : 0
    // A request that does not fit at all keeps its limit; the server's refusal starts compaction.
    const limit = room >= 1 ? Math.min(asked, room) : asked
    return limit === options.maxOutputTokens ? options : { ...options, maxOutputTokens: limit }
  }
  // Everything else, such as the model's name and supported URLs, reads through to the SDK's own model.
  const wrapped: LanguageModelV3 = Object.create(language)
  return Object.assign(wrapped, {
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      const release = await acquire(options)
      return Promise.resolve(language.doGenerate(clamp(options))).finally(release)
    },
    doStream: async (options: LanguageModelV3CallOptions) => {
      const held = await acquire(options)
      // The release stops listening for the abort, so a signal that outlives the reply keeps nothing of it.
      const release = () => {
        options.abortSignal?.removeEventListener("abort", release)
        held()
      }
      options.abortSignal?.addEventListener("abort", release, { once: true })
      const result = await Promise.resolve(language.doStream(clamp(options))).catch((error: unknown) => {
        release()
        throw error
      })
      return { ...result, stream: releasing(result.stream, release) }
    },
  })
}

// Prompts with code and JSON run nearer three characters a token than four, so this leans high: a reply cut a little
// short is better than a request the server refuses. File contents are left out; they are not sent as text.
function promptTokens(options: LanguageModelV3CallOptions) {
  const text = JSON.stringify([options.prompt, options.tools ?? []], (key, value) =>
    value instanceof Uint8Array || value instanceof URL || (key === "data" && typeof value === "string") ? "" : value,
  )
  return Math.ceil(text.length / 3)
}

function releasing<T>(stream: ReadableStream<T>, release: () => void) {
  const reader = stream.getReader()
  return new ReadableStream<T>({
    async pull(controller) {
      const part = await reader.read().catch((error: unknown) => {
        release()
        throw error
      })
      if (part.done) {
        release()
        controller.close()
        return
      }
      controller.enqueue(part.value)
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
}

// Opens the connection a model's first request will use, so its DNS lookup and TCP and TLS handshakes overlap the
// work before that request instead of following it. Nothing is sent. Behind a proxy the connection would not be the one
// the request uses, so nothing is opened.
function preconnectOrigin(origin: string, envs: Record<string, string | undefined>) {
  if (typeof fetch.preconnect !== "function") return
  if (["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"].some((name) => envs[name] || envs[name.toLowerCase()])) return
  // Bun ignores a preconnect made before its HTTP client has started. A fetch aborted before it begins starts the
  // client without resolving, connecting or sending anything.
  void fetch(origin, { signal: AbortSignal.abort() }).catch(() => undefined)
  fetch.preconnect(origin)
}

function googleVertexAnthropicBaseURL(project: string | undefined, location: string | undefined) {
  if (!project) return
  if (location !== "eu" && location !== "us") return
  // Continental multi-regions require Regional Endpoint Platform domains.
  return `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`
}

type BundledSDK = {
  languageModel(modelId: string): LanguageModelV3
  chat?: (modelId: string) => LanguageModelV3
  responses?: (modelId: string) => LanguageModelV3
}

const BUNDLED_PROVIDERS: Record<string, () => Promise<(opts: any) => BundledSDK>> = {
  "ai-gateway-provider": () => ProviderSDK.load("ai-gateway-provider"),
  "@jerome-benoit/sap-ai-provider": () => ProviderSDK.load("@jerome-benoit/sap-ai-provider"),
  "@aihubmix/ai-sdk-provider": () => ProviderSDK.load("@aihubmix/ai-sdk-provider"),
  "merge-gateway-ai-sdk-provider": () => ProviderSDK.load("merge-gateway-ai-sdk-provider"),
  "watsonx-ai-provider": () => ProviderSDK.load("watsonx-ai-provider"),
  "@qvac/ai-sdk-provider": () => ProviderSDK.load("@qvac/ai-sdk-provider"),
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock),
  "@ai-sdk/amazon-bedrock/mantle": () => import("@ai-sdk/amazon-bedrock/mantle").then((m) => m.createBedrockMantle),
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  "@ai-sdk/azure": () => import("@ai-sdk/azure").then((m) => m.createAzure),
  "@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex),
  "@ai-sdk/google-vertex/anthropic": () =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic),
  "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible),
  "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter),
  "@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai),
  "@ai-sdk/mistral": () => import("@ai-sdk/mistral").then((m) => m.createMistral),
  "@ai-sdk/groq": () => import("@ai-sdk/groq").then((m) => m.createGroq),
  "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra),
  "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras").then((m) => m.createCerebras),
  "@ai-sdk/cohere": () => import("@ai-sdk/cohere").then((m) => m.createCohere),
  "@ai-sdk/gateway": () => import("@ai-sdk/gateway").then((m) => m.createGateway),
  "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI),
  "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity").then((m) => m.createPerplexity),
  "@ai-sdk/vercel": () => import("@ai-sdk/vercel").then((m) => m.createVercel),
  "@ai-sdk/alibaba": () => import("@ai-sdk/alibaba").then((m) => m.createAlibaba),
  "gitlab-ai-provider": () => import("gitlab-ai-provider").then((m) => m.createGitLab),
  "@ai-sdk/github-copilot": () =>
    import("@vectordevai/core/github-copilot/copilot-provider").then((m) => m.createOpenaiCompatible),
  "venice-ai-sdk-provider": () => import("venice-ai-sdk-provider").then((m) => m.createVenice),
}

type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>, model?: Model) => Promise<any>
type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
type CustomDiscoverModels = () => Promise<Record<string, Model>>
type CustomProvider = Pick<Info, "id" | "source" | "options"> & {
  hasModel: (id: string) => boolean
  // Already in the provider list when the loader runs, so its result is kept even without autoload.
  configured: boolean
}
type CustomLoader = (provider: CustomProvider) => Effect.Effect<{
  autoload: boolean
  getModel?: CustomModelLoader
  vars?: CustomVarsLoader
  options?: Record<string, any>
  discoverModels?: CustomDiscoverModels
}>

type CustomDep = {
  auth: (id: string) => Effect.Effect<Auth.Info | undefined>
  config: () => Effect.Effect<ConfigV1.Info>
  env: () => Effect.Effect<Record<string, string | undefined>>
  get: (key: string) => Effect.Effect<string | undefined>
}

function selectAzureLanguageModel(sdk: any, modelID: string, useChat: boolean) {
  if (useChat && sdk.chat) return sdk.chat(modelID)
  if (sdk.responses) return sdk.responses(modelID)
  if (sdk.messages) return sdk.messages(modelID)
  if (sdk.chat) return sdk.chat(modelID)
  return sdk.languageModel(modelID)
}

function selectBedrockMantleLanguageModel(sdk: BundledSDK, modelID: string) {
  if (modelID === "openai.gpt-oss-safeguard-20b" || modelID === "openai.gpt-oss-safeguard-120b")
    return sdk.chat?.(modelID) ?? sdk.languageModel(modelID)
  return sdk.responses?.(modelID) ?? sdk.languageModel(modelID)
}

function custom(dep: CustomDep): Record<string, CustomLoader> {
  return {
    anthropic: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }),
    openai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: { headerTimeout: OPENAI_HEADER_TIMEOUT_DEFAULT },
      }),
    xai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      }),
    "github-copilot": () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>, model?: Model) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          if (model && "endpoint" in model.api) {
            if (model.api.endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
            if (model.api.endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
          }
          const match = /^gpt-(\d+)/.exec(modelID)
          if (match && Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")) return sdk.responses(modelID)
          return sdk.chat(modelID)
        },
        options: {},
      }),
    azure: Effect.fnUntraced(function* (provider: CustomProvider) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(provider.id)
      const resource = iife(() => {
        return [
          provider.options?.resourceName,
          auth?.type === "api" ? auth.metadata?.resourceName : undefined,
          env["AZURE_RESOURCE_NAME"],
        ].find((name) => typeof name === "string" && name.trim() !== "")
      })

      if (!resource && !provider.options?.baseURL) {
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "AZURE_RESOURCE_NAME is missing, set it using env var or reconnecting the azure provider and setting it",
            )
          },
        }
      }

      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          resourceName: resource,
        },
        vars(_options): Record<string, string> {
          if (resource) {
            return {
              AZURE_RESOURCE_NAME: resource,
            }
          }
          return {}
        },
      }
    }),
    "azure-cognitive-services": Effect.fnUntraced(function* () {
      const resourceName = yield* dep.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    }),
    "amazon-bedrock": Effect.fnUntraced(function* () {
      const providerConfig = (yield* dep.config()).provider?.["amazon-bedrock"]
      const auth = yield* dep.auth("amazon-bedrock")
      const env = yield* dep.env()

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = env["AWS_REGION"]
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = env["AWS_PROFILE"]
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = env["AWS_ACCESS_KEY_ID"]
      const configApiKey = providerConfig?.options?.apiKey

      // TODO: Using process.env directly because Env.set only updates a process.env shallow copy,
      // until the scope of the Env API is clarified (test only or runtime?)
      const awsBearerToken = iife(() => {
        const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
        if (envToken) return envToken
        if (auth?.type === "api") {
          process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = env["AWS_WEB_IDENTITY_TOKEN_FILE"]

      const containerCreds = Boolean(
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      )

      if (
        !profile &&
        !awsAccessKeyId &&
        !awsBearerToken &&
        !configApiKey &&
        !awsWebIdentityTokenFile &&
        !containerCreds
      )
        return { autoload: false }

      const { fromNodeProviderChain } = yield* Effect.promise(() => import("@aws-sdk/credential-providers"))

      const providerOptions: Record<string, any> = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken && !configApiKey) {
        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        vars(options: Record<string, any>) {
          return { AWS_REGION: options.region ?? defaultRegion }
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>, model?: Model) {
          if (model?.api.npm === "@ai-sdk/amazon-bedrock/mantle") return selectBedrockMantleLanguageModel(sdk, modelID)

          // Skip region prefixing if model already has a cross-region inference profile prefix
          // Catalog models may already include prefixes like us., eu., global., etc.
          const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
          if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from vector.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    }),
    llmgateway: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-Title": "Vector",
            "X-Source": "vector",
          },
        },
      }),
    openrouter: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-OpenRouter-Title": "Vector",
          },
        },
      }),
    nvidia: (provider) =>
      Effect.succeed({
        autoload: provider.source === "config",
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-Title": "Vector",
            "X-BILLING-INVOKE-ORIGIN": "Vector",
          },
        },
      }),
    vercel: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://vectordev.ai/",
            "x-title": "Vector",
          },
        },
      }),
    "google-vertex": Effect.fnUntraced(function* (provider: CustomProvider) {
      const env = yield* dep.env()
      // The catalog advertises GOOGLE_VERTEX_PROJECT for Vertex; keep the wider
      // Google Cloud project env names as fallbacks for existing ADC setups.
      const project =
        provider.options?.project ??
        env["GOOGLE_VERTEX_PROJECT"] ??
        env["GOOGLE_CLOUD_PROJECT"] ??
        env["GCP_PROJECT"] ??
        env["GCLOUD_PROJECT"]

      const location = String(
        provider.options?.location ??
          env["GOOGLE_VERTEX_LOCATION"] ??
          env["GOOGLE_CLOUD_LOCATION"] ??
          env["VERTEX_LOCATION"] ??
          "us-central1",
      )

      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        vars(_options: Record<string, any>) {
          const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
          return {
            ...(project && { GOOGLE_VERTEX_PROJECT: project }),
            GOOGLE_VERTEX_LOCATION: location,
            GOOGLE_VERTEX_ENDPOINT: endpoint,
          }
        },
        options: {
          project,
          location,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const { GoogleAuth } = await import("google-auth-library")
            const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
            const client = await auth.getClient()
            const token = await client.getAccessToken()

            const headers = new Headers(init?.headers)
            headers.set("Authorization", `Bearer ${token.token}`)

            return fetch(input, { ...init, headers })
          },
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "google-vertex-anthropic": Effect.fnUntraced(function* () {
      const env = yield* dep.env()
      const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCP_PROJECT"] ?? env["GCLOUD_PROJECT"]
      const location = env["GOOGLE_CLOUD_LOCATION"] ?? env["VERTEX_LOCATION"] ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      const baseURL = googleVertexAnthropicBaseURL(project, location)
      return {
        autoload: true,
        options: {
          project,
          location,
          ...(baseURL && { baseURL }),
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "sap-ai-core": Effect.fnUntraced(function* () {
      const auth = yield* dep.auth("sap-ai-core")
      const env = yield* dep.env()
      const serviceKey = env.AICORE_SERVICE_KEY ?? (auth?.type === "api" ? auth.key : undefined)
      return {
        autoload: !!serviceKey,
        options: { serviceKey, deploymentId: env.AICORE_DEPLOYMENT_ID, resourceGroup: env.AICORE_RESOURCE_GROUP },
      }
    }),
    zenmux: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-Title": "Vector",
          },
        },
      }),
    gitlab: Effect.fnUntraced(function* (input: CustomProvider) {
      const instanceUrl = (yield* dep.get("GITLAB_INSTANCE_URL")) || "https://gitlab.com"

      const auth = yield* dep.auth(input.id)
      const apiKey = auth?.type === "oauth" ? auth.access : auth?.type === "api" ? auth.key : undefined
      const token = apiKey ?? (yield* dep.get("GITLAB_TOKEN"))

      // Without a token, and with GitLab not already in the provider list, the caller discards this result. The
      // catalog lists GitLab for everyone, so loading its SDK here (with its own OpenAI and Anthropic clients) cost
      // every start that had a catalog.
      if (!token && !input.configured) return { autoload: false }

      const {
        VERSION: GITLAB_PROVIDER_VERSION,
        isWorkflowModel,
        discoverWorkflowModels,
      } = yield* Effect.promise(() => import("gitlab-ai-provider"))

      const providerConfig = (yield* dep.config()).provider?.["gitlab"]
      const directory = yield* InstanceState.directory

      const aiGatewayHeaders = {
        "User-Agent": `vector/${InstallationVersion} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        "anthropic-beta": "context-1m-2025-08-07",
        ...providerConfig?.options?.aiGatewayHeaders,
      }

      const featureFlags = {
        duo_agent_platform_agentic_chat: true,
        duo_agent_platform: true,
        ...providerConfig?.options?.featureFlags,
      }

      return {
        autoload: !!token,
        options: {
          instanceUrl,
          apiKey: token,
          aiGatewayHeaders,
          featureFlags,
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (modelID.startsWith("duo-workflow-")) {
            const workflowRef = typeof options?.workflowRef === "string" ? options.workflowRef : undefined
            // Use the static mapping if it exists, otherwise use duo-workflow with selectedModelRef
            const sdkModelID = isWorkflowModel(modelID) ? modelID : "duo-workflow"
            const workflowDefinition =
              typeof options?.workflowDefinition === "string" ? options.workflowDefinition : undefined
            const model = sdk.workflowChat(sdkModelID, {
              featureFlags,
              workflowDefinition,
            })
            if (workflowRef) {
              model.selectedModelRef = workflowRef
            }
            return model
          }
          return sdk.agenticChat(modelID, {
            aiGatewayHeaders,
            featureFlags,
          })
        },
        async discoverModels(): Promise<Record<string, Model>> {
          if (!apiKey) {
            return {}
          }

          try {
            const token = apiKey
            const getHeaders = (): Record<string, string> =>
              auth?.type === "api" ? { "PRIVATE-TOKEN": token } : { Authorization: `Bearer ${token}` }

            const result = await discoverWorkflowModels({ instanceUrl, getHeaders }, { workingDirectory: directory })

            if (!result.models.length) {
              return {}
            }

            const models: Record<string, Model> = {}
            for (const m of result.models) {
              if (!input.hasModel(m.id)) {
                models[m.id] = {
                  id: ModelV2.ID.make(m.id),
                  providerID: ProviderV2.ID.make("gitlab"),
                  name: `Agent Platform (${m.name})`,
                  family: "",
                  api: {
                    id: m.id,
                    url: instanceUrl,
                    npm: "gitlab-ai-provider",
                  },
                  status: "active",
                  headers: {},
                  options: { workflowRef: m.ref },
                  cost: { ...UNPRICED },
                  limit: { context: m.context, output: m.output },
                  capabilities: {
                    temperature: false,
                    reasoning: true,
                    attachment: true,
                    toolcall: true,
                    input: {
                      text: true,
                      audio: false,
                      image: true,
                      video: false,
                      pdf: true,
                    },
                    output: {
                      text: true,
                      audio: false,
                      image: false,
                      video: false,
                      pdf: false,
                    },
                    interleaved: false,
                  },
                  release_date: "",
                  variants: {},
                }
              }
            }

            return models
          } catch (e) {
            return {}
          }
        },
      }
    }),
    "cloudflare-workers-ai": Effect.fnUntraced(function* (input: CustomProvider) {
      // When baseURL is already configured (e.g. corporate config routing through a proxy/gateway),
      // skip the account ID check because the URL is already fully specified.
      if (input.options?.baseURL) return { autoload: false }

      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      if (!accountId)
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "CLOUDFLARE_ACCOUNT_ID is missing. Set it with: export CLOUDFLARE_ACCOUNT_ID=<your-account-id>",
            )
          },
        }

      const apiKey = env["CLOUDFLARE_API_KEY"] || (auth?.type === "api" ? auth.key : undefined)

      return {
        autoload: !!apiKey,
        options: {
          apiKey,
          headers: {
            "User-Agent": `vector/${InstallationVersion} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
          },
        },
        async getModel(sdk: any, modelID: string) {
          return sdk.languageModel(modelID)
        },
        vars(_options) {
          return {
            CLOUDFLARE_ACCOUNT_ID: accountId,
          }
        },
      }
    }),
    "cloudflare-ai-gateway": Effect.fnUntraced(function* (input: CustomProvider) {
      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId =
        input.options?.accountId ??
        env.CLOUDFLARE_ACCOUNT_ID ??
        (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      const gatewayId =
        input.options?.gatewayId ??
        input.options?.gateway ??
        env.CLOUDFLARE_GATEWAY_ID ??
        (auth?.type === "api" ? auth.metadata?.gatewayId : undefined)
      const apiKey =
        input.options?.apiKey ??
        env.CLOUDFLARE_API_TOKEN ??
        env.CF_AIG_TOKEN ??
        (auth?.type === "api" ? auth.key : undefined)
      return { autoload: !!(accountId && gatewayId && apiKey), options: { accountId, gatewayId, apiKey } }
    }),
    cerebras: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "vector",
          },
        },
      }),
    kilo: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-Title": "Vector",
          },
        },
      }),
    "snowflake-cortex": Effect.fnUntraced(function* (input: CustomProvider) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(input.id)

      const account =
        env["SNOWFLAKE_ACCOUNT"] ??
        (auth?.type === "api" ? auth.metadata?.account : undefined) ??
        (auth?.type === "oauth" ? auth.accountId : undefined) ??
        input.options?.account

      const envToken = env["SNOWFLAKE_CORTEX_TOKEN"] ?? env["SNOWFLAKE_CORTEX_PAT"]
      const apiKeyToken = auth?.type === "api" ? auth.key : undefined
      const oauthToken = auth?.type === "oauth" ? auth.access : undefined
      const configToken = input.options?.token ?? input.options?.apiKey

      const token = envToken ?? apiKeyToken ?? oauthToken ?? configToken

      if (!account || !token) {
        const missing = [!account && "SNOWFLAKE_ACCOUNT", !token && "SNOWFLAKE_CORTEX_TOKEN"].filter(Boolean).join(", ")
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              `Snowflake Cortex: missing credentials (${missing}). Provide a bearer token (OAuth, JWT, or PAT) via env var, vector auth, or provider options.`,
            )
          },
        }
      }

      const baseURL = `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`

      const options: Record<string, any> = { baseURL, apiKey: token }

      // Only skip provider-level fetch when the token is from OAuth with no override.
      // For OAuth tokens, the plugin auth loader's combined fetch handles
      // OAuth refresh + snowflake transformations in one place.
      // For env/config/API-key tokens, the provider fetch applies snowflake
      // transformations directly.
      const useOAuthHandler =
        oauthToken !== undefined && envToken === undefined && apiKeyToken === undefined && configToken === undefined
      if (!useOAuthHandler) {
        options.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.body && typeof init.body === "string") {
            try {
              const body = JSON.parse(init.body)
              if ("max_tokens" in body) {
                body.max_completion_tokens = body.max_tokens
                delete body.max_tokens
                init = { ...init, body: JSON.stringify(body) }
              }
            } catch {}
          }

          const response = await fetch(url, init)

          if (!response.ok && response.status === 400) {
            try {
              const errorData = await response.clone().json()
              const errorMessage = String(errorData.message || errorData.error || "")
              if (errorMessage.toLowerCase().includes("conversation complete")) {
                return new Response(
                  JSON.stringify({
                    choices: [{ finish_reason: "stop", message: { content: "", role: "assistant" } }],
                  }),
                  { status: 200, headers: new Headers({ "content-type": "application/json" }) },
                )
              }
            } catch {}
          }

          if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
            const reader = response.body.getReader()
            const encoder = new TextEncoder()
            const decoder = new TextDecoder()
            const stream = new ReadableStream({
              async pull(ctrl) {
                const { done, value } = await reader.read()
                if (done) {
                  ctrl.close()
                  return
                }
                const text = decoder.decode(value, { stream: true })
                ctrl.enqueue(encoder.encode(text.replace(/"role"\s*:\s*""/g, '"role":"assistant"')))
              },
              cancel() {
                reader.cancel()
              },
            })
            return new Response(stream, { headers: response.headers, status: response.status })
          }

          return response
        }
      }

      return {
        autoload: input.source === "config",
        options,
      }
    }),
  }
}

const ProviderApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
})

const ProviderModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const ProviderInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
  }),
])

const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: ProviderModalities,
  output: ProviderModalities,
  interleaved: ProviderInterleaved,
})

const ProviderCacheCost = Schema.Struct({
  read: Schema.Finite,
  write: Schema.Finite,
})

const ProviderCostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const ProviderCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tiers: optional(Schema.Array(ProviderCostTier)),
  experimentalOver200K: optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache: ProviderCacheCost,
    }),
  ),
  // No price is listed for the model: the zero rates mean unknown, not free, and its steps are recorded as unpriced.
  unpriced: optional(Schema.Boolean),
  // The plan of the account signed in pays for the model's steps, such as a ChatGPT plan, so the zero rates mean
  // nothing is billed per token.
  plan: optional(Schema.Boolean),
})

const ProviderLimit = Schema.Struct({
  context: Schema.Finite,
  input: optional(Schema.Finite),
  output: Schema.Finite,
})

export const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  api: ProviderApiInfo,
  name: Schema.String,
  freeModel: optional(
    Schema.Struct({
      source: Schema.Literals(["shared", "openrouter"]),
      // A model that is not "no-training" carries the "May train on your prompts" label and needs one-time consent.
      dataPolicy: optional(FreeDataPolicy),
      // "optional" when Vector may switch the model's reasoning off for a greeting.
      reasoning: optional(Schema.Literals(["optional", "mandatory"])),
    }),
  ),
  family: optional(Schema.String),
  capabilities: ProviderCapabilities,
  cost: ProviderCost,
  limit: ProviderLimit,
  status: ModelStatus,
  options: Schema.Record(Schema.String, Schema.Any),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  variants: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
  // Vector Codium's listing facts: lab, Auto role, locks and Codium Auto's models.
  codium: optional(ModelV2.Codium),
}).annotate({ identifier: "Model" })
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export const Info = Schema.Struct({
  id: ProviderV2.ID,
  name: Schema.String,
  source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String),
  key: optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any),
  models: Schema.Record(Schema.String, Model),
}).annotate({ identifier: "Provider" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

const DefaultModelIDs = Schema.Record(Schema.String, Schema.String)

// A connected model whose requests go to a model server someone hosts (this computer, the user's network or the model
// server list), read the way the engine sends them (Provider.line): a server added in Vector sets the provider's base
// URL and leaves the model's `api.url` empty, so a client cannot tell this from the model alone.
export const HostedModel = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  /** The server's origin. */
  origin: Schema.String,
  /**
   * Whether the run guard counts its steps as `local`, with no per-token price: a server on this computer or a private
   * one on the list, that passes nothing on, for a model with no price set. Otherwise dollar caps apply to it.
   */
  local: Schema.Boolean,
}).annotate({ identifier: "HostedModel" })
export type HostedModel = Types.DeepMutable<Schema.Schema.Type<typeof HostedModel>>

export const ListResult = Schema.Struct({
  all: Schema.Array(Info),
  default: DefaultModelIDs,
  connected: Schema.Array(Schema.String),
  unavailable: Schema.optional(Schema.Array(ProviderUnavailable)),
  hosted: Schema.optional(Schema.Array(HostedModel)),
})
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

export const ConfigProvidersResult = Schema.Struct({
  providers: Schema.Array(Info),
  default: DefaultModelIDs,
  unavailable: Schema.optional(Schema.Array(ProviderUnavailable)),
})
export type ConfigProvidersResult = Types.DeepMutable<Schema.Schema.Type<typeof ConfigProvidersResult>>

export function toPublicInfo(provider: Info): Info {
  return JSON.parse(
    JSON.stringify(provider, (_, value) => {
      if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined
      if (typeof value === "bigint") return value.toString()
      return value
    }),
  )
}

// These sign-in placeholders contain no credentials. All other key values stay private.
const CLIENT_VISIBLE_API_KEYS = new Set<string>(["", OAUTH_DUMMY_KEY])

/**
 * The provider record as a client may see it. The provider list and config
 * endpoints used to send toPublicInfo(), which still carries `key`, the user's
 * stored API key, to every client of the server, including guests invited with
 * `vector invite`. Clients need to know how a provider is connected, never the
 * credential itself. Model options, headers and variants can carry keys too.
 */
export function toClientInfo(provider: Info): Info {
  const { key: _key, ...info } = toPublicInfo(provider)
  const apiKey = info.options?.apiKey
  const options = Redaction.omit(info.options ?? {})
  if (typeof apiKey === "string" && CLIENT_VISIBLE_API_KEYS.has(apiKey)) options.apiKey = apiKey
  const models = mapValues(info.models ?? {}, (model) => ({
    ...model,
    options: Redaction.omit(model.options ?? {}),
    headers: Redaction.omit(model.headers ?? {}),
    variants: Redaction.omit(model.variants),
  }))
  return { ...info, options, models }
}

export function defaultModelIDs<
  T extends {
    models: Record<
      string,
      {
        id: string
        freeModel?: { source: "shared" | "openrouter"; dataPolicy?: FreeDataPolicy }
        codium?: { role?: string; manualOnly?: boolean; locked?: unknown; auto?: unknown }
      }
    >
  },
>(providers: Record<string, T>) {
  return Object.fromEntries(
    Object.entries(providers).flatMap(([id, item]) => {
      // Vector Codium's default is the model its catalog gives the default role, else the first it lists that the
      // plan can use; never Codium Auto, a locked or a manual-only entry.
      const codium = Object.values(item.models).filter(
        (model) => !model.codium?.auto && !model.codium?.locked && !model.codium?.manualOnly,
      )
      const model =
        id === ModelPlans.PROVIDER_ID
          ? (codium.find((model) => model.codium?.role === "default") ?? codium[0])
          : automaticModels(
              Object.values(item.models).filter(
                (model) => id !== "openrouter" || model.freeModel?.source === "openrouter",
              ),
            )[0]
      return model ? [[id, model.id]] : []
    }),
  )
}

export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()("ProviderModelNotFoundError", {
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  suggestions: Schema.optional(Schema.Array(Schema.String)),
  unavailable: Schema.optional(ProviderUnavailable),
  /** For Vector Codium: the action the person can take, offered with the session error. */
  codium: Schema.optional(Schema.Literals(["sign-in", "unavailable"])),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    if (this.unavailable) return `Model unavailable: ${this.providerID}/${this.modelID}. ${this.unavailable.message}`
    const suggestions = this.suggestions?.length ? ` Did you mean: ${this.suggestions.join(", ")}?` : ""
    return `Model not found: ${this.providerID}/${this.modelID}.${suggestions}`
  }

  static isInstance(input: unknown): input is ModelNotFoundError {
    return input instanceof ModelNotFoundError
  }
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("ProviderInitError", {
  providerID: ProviderV2.ID,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Failed to initialize provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is InitError {
    return input instanceof InitError
  }
}

export class NoProvidersError extends Schema.TaggedErrorClass<NoProvidersError>()("ProviderNoProvidersError", {
  /** Vector Codium is listed, but it is only used when the person chooses one of its models. */
  codium: Schema.optional(Schema.Boolean),
  /** Free models inside of Vector are on, and signing in to Vector would list them (Provider.freeSignIn). */
  signIn: Schema.optional(Schema.Boolean),
}) {
  override get message() {
    if (this.codium)
      return "Vector Codium is available, but Vector never chooses it for you. Choose a Codium model, for example with --model vector-plan/<model>."
    if (this.signIn)
      return `No providers are available. ${FREE_MODELS_SIGN_IN_TERMINAL} Or connect your own provider key with vector providers login.`
    return "No providers are available"
  }

  static isInstance(input: unknown): input is NoProvidersError {
    return input instanceof NoProvidersError
  }
}

export class NoModelsError extends Schema.TaggedErrorClass<NoModelsError>()("ProviderNoModelsError", {
  providerID: ProviderV2.ID,
}) {
  override get message() {
    return `No models are available for provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is NoModelsError {
    return input instanceof NoModelsError
  }
}

export type DefaultModelError = ModelNotFoundError | NoProvidersError | NoModelsError
export type Error = ModelNotFoundError | InitError | NoProvidersError | NoModelsError

export interface Interface {
  readonly list: () => Effect.Effect<Record<ProviderV2.ID, Info>>
  readonly unavailable: () => Effect.Effect<ProviderUnavailable[]>
  readonly getProvider: (providerID: ProviderV2.ID) => Effect.Effect<Info>
  readonly getModel: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<Model, ModelNotFoundError>
  readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV3, ModelNotFoundError>
  /**
   * The line the model's requests wait in at its server, as getLanguage holds them: undefined for a cloud API that
   * configures no `concurrency`, a free model and Vector Codium.
   */
  readonly line: (model: Model) => Effect.Effect<Line | undefined>
  /** Opens the connection the model's next request will use, so a session's first request does not wait for it. */
  readonly preconnect: (model: Model) => Effect.Effect<void>
  readonly closest: (
    providerID: ProviderV2.ID,
    query: string[],
  ) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: string } | undefined>
  readonly getSmallModel: (providerID: ProviderV2.ID, primaryID?: ModelV2.ID) => Effect.Effect<Model | undefined>
  /**
   * The Vector Codium model Codium Auto runs one user message on, from the message's size and the context it adds to
   * (CodiumAuto.resolve). Fails like getModel when Codium cannot run, and with a Codium notice when the account's plan
   * offers no usable Auto.
   */
  readonly codiumAuto: (input: {
    tier: TaskSize.Tier
    contextTokens: number
  }) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }, ModelNotFoundError>
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }, DefaultModelError>
  /** The model a saved choice names today: renamed providers map to their new ID, retired ones give undefined. */
  readonly savedModel: (model: {
    providerID: string
    modelID: string
  }) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined>
  /**
   * Whether Free models inside of Vector are on but this engine has neither a Vector sign-in nor an OpenRouter key to
   * list them, so signing in to Vector would.
   */
  readonly freeSignIn: () => Effect.Effect<boolean>
}

interface State {
  models: Map<string, LanguageModelV3>
  providers: Record<ProviderV2.ID, Info>
  unavailable: ProviderUnavailable[]
  // Models Vector Local keeps off, by "provider/model", with the notice choosing one fails with, and the policy that
  // decided it.
  withheld: Map<string, ProviderUnavailable>
  local: LocalMode.Policy
  // What the server checks had learned about the models servers pass on (Holds.revision) when it was decided.
  revision: number
  // Every provider ID configuration or a plugin names, whether or not it loaded.
  declared: Set<string>
  catalogIDs: Record<string, true>
  getCatalog: (providerID: string) => Info | undefined
  sdk: Map<string, BundledSDK>
  modelLoaders: Record<string, CustomModelLoader>
  varsLoaders: Record<string, CustomVarsLoader>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Provider") {}

export const use = serviceUse(Service)

// The cost of a model whose provider lists no price.
const UNPRICED: Model["cost"] = { input: 0, output: 0, cache: { read: 0, write: 0 }, unpriced: true }

// A mode that lists its own price replaces the base rates, and is priced even when its base model lists none. When
// it lists no long-context tiers of its own, the base model's follow at the mode's markup: priority pricing is a
// multiple of the standard rates, and the base tiers alone would price a long fast step below a short one.
function modeCost(base: Model["cost"], mode: Model["cost"]): Model["cost"] {
  if (base.unpriced) return mode
  const scale = (rate: number, from: number, to: number) => (from > 0 ? (rate * to) / from : rate)
  const scaled = <T extends Pick<Model["cost"], "input" | "output" | "cache">>(item: T): T => ({
    ...item,
    input: scale(item.input, base.input, mode.input),
    output: scale(item.output, base.output, mode.output),
    cache: {
      read: scale(item.cache.read, base.cache.read, mode.cache.read),
      write: scale(item.cache.write, base.cache.write, mode.cache.write),
    },
  })
  const tiers = mode.tiers ?? base.tiers?.map(scaled)
  const over200K = mode.experimentalOver200K ?? (base.experimentalOver200K && scaled(base.experimentalOver200K))
  return { ...mode, ...(tiers ? { tiers } : {}), ...(over200K ? { experimentalOver200K: over200K } : {}) }
}

function cost(c: ModelCatalog.Model["cost"]): Model["cost"] {
  if (!c) return { ...UNPRICED }
  const result: Model["cost"] = {
    input: c?.input ?? 0,
    output: c?.output ?? 0,
    cache: {
      read: c?.cache_read ?? 0,
      write: c?.cache_write ?? 0,
    },
  }
  if (c?.tiers) {
    result.tiers = c.tiers.map((item) => ({
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read ?? 0,
        write: item.cache_write ?? 0,
      },
      tier: item.tier,
    }))
  }
  if (c?.context_over_200k) {
    result.experimentalOver200K = {
      cache: {
        read: c.context_over_200k.cache_read ?? 0,
        write: c.context_over_200k.cache_write ?? 0,
      },
      input: c.context_over_200k.input,
      output: c.context_over_200k.output,
    }
  }
  return result
}

function fromModelCatalogModel(provider: ModelCatalog.Provider, model: ModelCatalog.Model): Model {
  const base: Model = {
    id: ModelV2.ID.make(model.id),
    providerID: ProviderV2.ID.make(provider.id),
    name: model.name,
    family: model.family,
    api: {
      id: model.id,
      url: model.provider?.api ?? provider.api ?? "",
      npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
    },
    status: model.status ?? "active",
    headers: {},
    options: {},
    cost: cost(model.cost),
    limit: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    capabilities: {
      temperature: model.temperature ?? false,
      reasoning: model.reasoning ?? false,
      attachment: model.attachment ?? false,
      toolcall: model.tool_call ?? true,
      input: {
        text: model.modalities?.input?.includes("text") ?? false,
        audio: model.modalities?.input?.includes("audio") ?? false,
        image: model.modalities?.input?.includes("image") ?? false,
        video: model.modalities?.input?.includes("video") ?? false,
        pdf: model.modalities?.input?.includes("pdf") ?? false,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? false,
        audio: model.modalities?.output?.includes("audio") ?? false,
        image: model.modalities?.output?.includes("image") ?? false,
        video: model.modalities?.output?.includes("video") ?? false,
        pdf: model.modalities?.output?.includes("pdf") ?? false,
      },
      interleaved: model.interleaved ?? false,
    },
    release_date: model.release_date ?? "",
    variants: {},
  }

  return {
    ...base,
    variants: mapValues(ProviderTransform.variants(base), (v) => v),
  }
}

export function fromModelCatalogProvider(provider: ModelCatalog.Provider): Info {
  const models: Record<string, Model> = {}
  for (const [key, model] of Object.entries(provider.models)) {
    models[key] = fromModelCatalogModel(provider, model)
    for (const [mode, opts] of Object.entries(model.experimental?.modes ?? {})) {
      if (!ModelCatalog.modeSupported(model.provider?.npm ?? provider.npm, model.id, opts.provider?.body)) continue
      const id = `${model.id}-${mode}`
      const base = fromModelCatalogModel(provider, model)
      models[id] = {
        ...base,
        id: ModelV2.ID.make(id),
        name: `${model.name} ${mode[0].toUpperCase()}${mode.slice(1)}`,
        cost: opts.cost ? modeCost(base.cost, cost(opts.cost)) : base.cost,
        options: opts.provider?.body
          ? Object.fromEntries(
              Object.entries(opts.provider.body).map(([k, v]) => [
                k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
                v,
              ]),
            )
          : base.options,
        headers: opts.provider?.headers ?? base.headers,
      }
    }
  }
  return {
    id: ProviderV2.ID.make(provider.id),
    source: "custom",
    name: provider.name,
    env: [...(provider.env ?? [])],
    options: {},
    models,
  }
}

/** What decides whether a model's requests reach OpenRouter's free endpoints: its names, destinations and price. */
function openRouterDestination(
  providerID: string,
  modelID: string,
  model: Pick<Model, "api" | "cost">,
  provider: Pick<Info, "options"> | undefined,
) {
  return {
    providerID,
    id: modelID,
    apiID: model.api.id,
    destinations: [model.api.url, model.api.npm, provider?.options?.baseURL],
    price: model.cost.unpriced ? undefined : model.cost,
  }
}

/**
 * What clients see of free models. With the shared catalog on, its models are listed under Vector. With it off, only
 * the shared allowance's own models lose their free tag: free models on the user's own OpenRouter account keep it,
 * or connecting OpenRouter would show no free section and select no model.
 */
export function applyFreeCatalog(providers: Record<string, Info>, catalog: FreeModelCatalog, vectorAllowed: boolean) {
  if (catalog.enabled && vectorAllowed && catalog.models.length) providers.vector ??= fromFreeModels(catalog.models)
  if (catalog.enabled) return providers
  delete providers.vector
  for (const provider of Object.values(providers))
    for (const model of Object.values(provider.models))
      if (model.freeModel && model.freeModel.source !== "openrouter") delete model.freeModel
  return providers
}

/**
 * What an invited guest is offered: no free model labelled "May train on your prompts". A guest's prompts run under
 * the owner's acceptance, which the guest never gave, so the engine also refuses a guest's prompt to one.
 */
export function withoutTrainingFreeModels(providers: Record<string, Info>) {
  for (const provider of Object.values(providers))
    for (const [id, model] of Object.entries(provider.models)) if (freeModelMayTrain(model)) delete provider.models[id]
  return providers
}

export function fromFreeModels(models: readonly FreeModelInfo[], providerID: "vector" | "openrouter" = "vector"): Info {
  // A catalog published before it said whether a model may reason without it says nothing; the reviewed fallback for
  // the same model fills that in, so switching reasoning off does not wait on a catalog deploy.
  const reasoning = (model: FreeModelInfo) => {
    const value = model.reasoning ?? FREE_MODEL_FALLBACKS.find((item) => item.id === model.id)?.reasoning
    return value === "optional" || value === "mandatory" ? { reasoning: value } : {}
  }
  return {
    id: ProviderV2.ID.make(providerID),
    name: providerID === "vector" ? "Vector" : "OpenRouter",
    source: "custom",
    env: [providerID === "vector" ? "VECTOR_CLI_TOKEN" : "OPENROUTER_API_KEY"],
    options: {},
    models: Object.fromEntries(
      models.map((model) => [
        model.id,
        {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(providerID),
          name: freeModelCatalogName(model),
          freeModel: {
            source: providerID === "vector" ? "shared" : "openrouter",
            dataPolicy: freeModelDataPolicy(model),
            ...reasoning(model),
          },
          api: {
            id: model.id,
            npm: "@ai-sdk/openai-compatible",
            url: providerID === "vector" ? "https://vectordev.ai/api/free-models" : FreeModels.OPENROUTER_ROOT,
          },
          status: "active",
          headers: {},
          options: {},
          release_date: "",
          variants: {},
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: model.contextLength, output: model.maxOutputTokens },
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
        },
      ]),
    ),
  }
}

/**
 * Vector Codium. Credentials are read at the fixed request boundary and never appear in provider info. Every catalog
 * entry is listed with its `codium` listing metadata, so the pickers, routing and swarms can tell Codium Auto, locked
 * and manual-only entries apart.
 */
export function fromModelPlans(models: readonly ModelPlans.Model[]): Info {
  return {
    id: ProviderV2.ID.make(ModelPlans.PROVIDER_ID),
    name: ModelPlans.PROVIDER_NAME,
    source: "custom",
    env: [],
    options: {},
    models: Object.fromEntries(
      // Every entry, with what its listing says: Codium Auto (resolved per user message), models the plan does not
      // include (choosing one opens Change plan) and manual-only lanes. Nothing automatic picks those (defaultModelIDs,
      // getSmallModel through CodiumAuto.helper, task and image routing, swarms).
      models.map((model) => [
        model.id,
        {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID),
          name: model.name,
          api: { id: model.id, npm: "@ai-sdk/openai-compatible", url: ModelPlans.API_URL },
          status: "active",
          headers: {},
          options: {},
          release_date: "",
          variants: {},
          // No dollar price: a Codium step spends credits, so it is recorded unpriced and left out of dollar totals.
          cost: { ...UNPRICED },
          limit: { context: model.contextLength, output: model.maxOutputTokens },
          codium: ModelPlans.listing(model),
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
        },
      ]),
    ),
  }
}

function modelSuggestions(provider: Info | undefined, modelID: ModelV2.ID) {
  const available = provider
    ? Object.keys(provider.models).filter((id) => provider.models[id].status !== "deprecated")
    : []
  const fuzzy = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 }).map((m) => m.target)
  if (fuzzy.length) return fuzzy
  const query = modelID
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1)
  return sortBy(
    available
      .map((id) => ({
        id,
        score: query.filter((part) => id.toLowerCase().includes(part)).length,
      }))
      .filter((item) => item.score > 0),
    [(item) => item.score, "desc"],
    [(item) => item.id, "asc"],
  )
    .slice(0, 3)
    .map((item) => item.id)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const env = yield* Env.Service
    const plugin = yield* Plugin.Service
    const modelCatalogSvc = yield* ModelCatalog.Service
    const runtimeFlags = yield* RuntimeFlags.Service
    const freeModels = yield* FreeModels.Service
    const modelPlans = yield* ModelPlans.Service
    const freeCredentials = yield* FreeModels.CredentialsService
    const guests = yield* FreeModelGuests.Service
    const events = yield* EventV2Bridge.Service
    const slots = yield* ModelSlots.Service
    // Servers whose identity changed since they were added: their model calls are refused until the user confirms them.
    const holds = yield* LocalProbe.HoldsService
    const runtimeBridge = yield* EffectBridge.make()
    const planID = ProviderV2.ID.make(ModelPlans.PROVIDER_ID)

    const state = yield* InstanceState.make<State>(() =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const cfg = yield* config.get()
        const loaded = yield* modelCatalogSvc.get()
        // Under Vector Local, a catalog provider's cloud address cannot be listed as one of the user's model servers.
        Config.localCatalog(loaded)
        const modelCatalog = Object.fromEntries(Object.entries(loaded).filter(([id]) => providerAllowed(id)))
        const catalogIDs = Object.fromEntries(Object.keys(modelCatalog).map((id) => [id, true as const]))
        const catalog = new Map<string, Info>()
        const freeCatalog = yield* freeModels.catalog()
        const vectorToken = yield* freeCredentials.get("vector")
        const planCatalog = yield* modelPlans.catalog(vectorToken)
        // Codium is a catalog provider like the free models, so the env loop and custom loaders walk it too.
        if (planCatalog.enabled) {
          catalogIDs[planID] = true
          catalog.set(planID, fromModelPlans(planCatalog.models))
        }
        if (freeCatalog.enabled && freeCatalog.models.length) {
          catalogIDs[ProviderV2.ID.vector] = true
          catalog.set(ProviderV2.ID.vector, fromFreeModels(freeCatalog.models))
        }
        const database = new Map<string, Info>()

        // Keep the catalog copy isolated from config/plugin mutations, but expand only providers that are used.
        function getCatalog(providerID: string) {
          const cached = catalog.get(providerID)
          if (cached) return cached
          if (!Object.hasOwn(modelCatalog, providerID)) return
          const raw = modelCatalog[providerID]
          const provider = fromModelCatalogProvider(raw)
          catalog.set(providerID, provider)
          return provider
        }

        function getDatabase(providerID: string) {
          const cached = database.get(providerID)
          if (cached) return cached
          const source = getCatalog(providerID)
          if (!source) return
          const provider = toPublicInfo(source)
          database.set(providerID, provider)
          return provider
        }

        const providers: Record<ProviderV2.ID, Info> = {} as Record<ProviderV2.ID, Info>
        const languages = new Map<string, LanguageModelV3>()
        const modelLoaders: {
          [providerID: string]: CustomModelLoader
        } = {}
        const varsLoaders: {
          [providerID: string]: CustomVarsLoader
        } = {}
        const sdk = new Map<string, BundledSDK>()
        const discoveryLoaders: {
          [providerID: string]: CustomDiscoverModels
        } = {}
        const dep = {
          auth: (id: string) =>
            auth.get(id).pipe(
              Effect.map((value) =>
                value && !providerCredentialAllowed(id, value, userProviders.has(id)) ? undefined : value,
              ),
              Effect.orDie,
            ),
          config: () => config.get(),
          env: () => env.all(),
          get: (key: string) => env.get(key),
        }

        function mergeProvider(providerID: ProviderV2.ID, provider: Partial<Info>) {
          if (!isProviderAllowed(providerID)) return
          const match = getDatabase(providerID)
          const value = providerAllowed(providerID) ? provider : { ...provider, source: match?.source ?? "custom" }
          const existing = providers[providerID]
          if (existing) {
            // @ts-expect-error
            providers[providerID] = mergeDeep(existing, value)
            return
          }
          if (!match) return
          // @ts-expect-error
          providers[providerID] = mergeDeep(match, value)
        }

        // load plugins first so config() hook runs before reading cfg.provider
        const plugins = yield* plugin.list()

        // Runtime consent markers cannot be supplied by project/global config or plugin config hooks.
        for (const provider of Object.values(cfg.provider ?? {}))
          if (provider.options) delete provider.options.vectorOAuthPlugin
        // now read config providers - includes any modifications from plugin config() hook
        const configProviders = Object.entries(cfg.provider ?? {}).filter(([id, provider]) =>
          providerUsable(id, provider),
        )
        const userProviders = new Set([
          ...configProviders.map(([id]) => id),
          ...plugins.flatMap((hook) => [hook.provider?.id, hook.auth?.provider].filter((id) => id !== undefined)),
        ])
        const disabled = new Set(cfg.disabled_providers ?? [])
        const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : null

        function isProviderAllowed(providerID: ProviderV2.ID): boolean {
          if (!providerEnabled(providerID)) return false
          if (!providerAllowed(providerID) && !userProviders.has(providerID)) return false
          if (enabled && !enabled.has(providerID)) return false
          if (disabled.has(providerID)) return false
          return true
        }

        for (const hook of plugins) {
          const p = hook.provider
          const models = p?.models
          if (!p || !models) continue

          const providerID = ProviderV2.ID.make(p.id)
          if (!isProviderAllowed(providerID)) continue

          const provider = getDatabase(providerID) ?? {
            id: providerID,
            name: providerID,
            env: [],
            options: {},
            source: "custom" as const,
            models: {},
          }
          database.set(providerID, provider)
          const storedPluginAuth = yield* auth.get(providerID).pipe(Effect.orDie)
          const pluginAuth =
            storedPluginAuth && providerCredentialAllowed(providerID, storedPluginAuth, userProviders.has(providerID))
              ? storedPluginAuth
              : undefined

          provider.models = yield* Effect.promise(async () => {
            const next = await models(toPublicInfo(provider), { auth: pluginAuth })
            return Object.fromEntries(
              Object.entries(next).map(([id, model]) => [
                id,
                {
                  ...model,
                  id: ModelV2.ID.make(id),
                  providerID,
                },
              ]),
            )
          })
          if (!Object.hasOwn(catalogIDs, providerID)) mergeProvider(providerID, { source: "custom" })
        }

        // extend database from config
        for (const [providerID, provider] of configProviders) {
          const existing = getDatabase(providerID)
          const parsed: Info = {
            id: ProviderV2.ID.make(providerID),
            name: provider.name ?? existing?.name ?? providerID,
            env: provider.env ?? existing?.env ?? [],
            options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
            source: "config",
            models: existing?.models ?? {},
          }

          for (const [modelID, model] of Object.entries(provider.models ?? {})) {
            const existingModel = parsed.models[model.id ?? modelID]
            const apiID = model.id ?? existingModel?.api.id ?? modelID
            const apiNpm =
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelCatalog[providerID]?.npm ??
              "@ai-sdk/openai-compatible"
            const name = iife(() => {
              if (model.name) return model.name
              if (model.id && model.id !== modelID) return modelID
              return existingModel?.name ?? modelID
            })
            const parsedModel: Model = {
              id: ModelV2.ID.make(modelID),
              api: {
                id: apiID,
                npm: apiNpm,
                url:
                  model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelCatalog[providerID]?.api ?? "",
              },
              status: model.status ?? existingModel?.status ?? "active",
              name,
              providerID: ProviderV2.ID.make(providerID),
              capabilities: {
                temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
                reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
                attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
                toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
                input: {
                  text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
                  audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
                  image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
                  video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
                  pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
                },
                output: {
                  text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
                  audio:
                    model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
                  image:
                    model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
                  video:
                    model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
                  pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
                },
                interleaved:
                  model.interleaved ??
                  existingModel?.capabilities.interleaved ??
                  (!existingModel && apiNpm === "@ai-sdk/openai-compatible" && apiID.includes("deepseek")
                    ? { field: "reasoning_content" }
                    : false),
              },
              // A config entry without a cost keeps the catalog's pricing whole, long-context tiers included; one
              // with a cost prices the model itself, and its context_over_200k is the long-context rate.
              cost: model.cost
                ? {
                    input: model.cost.input,
                    output: model.cost.output,
                    cache: {
                      read: model.cost.cache_read ?? existingModel?.cost?.cache.read ?? 0,
                      write: model.cost.cache_write ?? existingModel?.cost?.cache.write ?? 0,
                    },
                    ...(model.cost.context_over_200k
                      ? {
                          experimentalOver200K: {
                            input: model.cost.context_over_200k.input,
                            output: model.cost.context_over_200k.output,
                            cache: {
                              read: model.cost.context_over_200k.cache_read ?? 0,
                              write: model.cost.context_over_200k.cache_write ?? 0,
                            },
                          },
                        }
                      : {}),
                  }
                : (existingModel?.cost ?? { ...UNPRICED }),
              options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
              limit: {
                context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
                input: model.limit?.input ?? existingModel?.limit?.input,
                output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
              },
              headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
              family: model.family ?? existingModel?.family ?? "",
              release_date: model.release_date ?? existingModel?.release_date ?? "",
              variants: {},
            }
            const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
            parsedModel.variants = mapValues(
              pickBy(merged, (v) => !v.disabled),
              (v) => omit(v, ["disabled"]),
            )
            parsed.models[modelID] = parsedModel
          }
          database.set(providerID, parsed)
        }

        // load env
        const envs = yield* env.all()
        for (const id of Object.keys({ ...catalogIDs, ...Object.fromEntries(database) })) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) continue
          if (!providerEnvironmentAllowed(providerID)) continue
          const names = database.get(id)?.env ?? catalog.get(id)?.env ?? modelCatalog[id]?.env ?? []
          const apiKey = names.map((item) => envs[item]).find(Boolean)
          if (!apiKey) continue
          mergeProvider(providerID, {
            source: "env",
            key: names.length === 1 ? apiKey : undefined,
          })
        }

        // load apikeys
        const auths = yield* auth.all().pipe(Effect.orDie)
        for (const [id, provider] of Object.entries(auths)) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) continue
          if (
            provider.type === "api" &&
            providerCredentialAllowed(providerID, provider, userProviders.has(providerID))
          ) {
            mergeProvider(providerID, {
              source: "api",
              key: provider.key,
            })
          }
        }

        // plugin auth loader - database now has entries for config providers
        for (const plugin of plugins) {
          if (!plugin.auth) continue
          const providerID = ProviderV2.ID.make(plugin.auth.provider)
          if (!isProviderAllowed(providerID)) continue

          const stored = yield* auth.get(providerID).pipe(Effect.orDie)
          if (!stored) continue
          if (!providerCredentialAllowed(providerID, stored, userProviders.has(providerID))) continue
          if (!plugin.auth.loader) continue
          const provider = getDatabase(providerID)
          if (!provider) continue

          const options = yield* Effect.promise(() =>
            plugin.auth!.loader!(
              () => bridge.promise(auth.get(providerID).pipe(Effect.orDie)) as any,
              toPublicInfo(provider),
            ),
          )
          const opts = options ?? {}
          const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
          mergeProvider(providerID, patch)
        }

        for (const [id, fn] of Object.entries(custom(dep))) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) continue
          const data = database.get(providerID)
          if (!data && !Object.hasOwn(catalogIDs, providerID)) continue
          const result = yield* fn({
            id: data?.id ?? ProviderV2.ID.make(modelCatalog[providerID]?.id ?? providerID),
            source: data?.source ?? "custom",
            options: data?.options ?? {},
            hasModel: (id) => Boolean(getDatabase(providerID)?.models[id]),
            configured: Boolean(providers[providerID]),
          })
          if (result && (result.autoload || providers[providerID])) {
            if (result.getModel) modelLoaders[providerID] = result.getModel
            if (result.vars) varsLoaders[providerID] = result.vars
            if (result.discoverModels) discoveryLoaders[providerID] = result.discoverModels
            const opts = result.options ?? {}
            const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
            mergeProvider(providerID, patch)
          }
        }

        // load config - re-apply with updated data
        for (const [id, provider] of configProviders) {
          const providerID = ProviderV2.ID.make(id)
          const partial: Partial<Info> = { source: "config" }
          if (provider.env) partial.env = provider.env
          if (provider.name) partial.name = provider.name
          if (provider.options) partial.options = provider.options
          mergeProvider(providerID, partial)
        }

        // Built-in free credentials and destinations cannot be replaced by project configuration.
        const openRouterKey = yield* freeCredentials.get("openrouter")
        const ownedFree = openRouterKey ? yield* freeModels.forKey(openRouterKey) : []
        // OpenRouter models that run on free endpoints, zero-price ones and its free router included, return below
        // only as the free models the catalogs list. That holds under any provider pointed at openrouter.ai, and for a
        // model configured under another name, whose API ID is what is sent.
        delete providers[ProviderV2.ID.vector]
        for (const [providerID, item] of Object.entries(providers)) {
          for (const [modelID, model] of Object.entries(item.models)) {
            if (sendsToOpenRouterFree(openRouterDestination(providerID, modelID, model, item)))
              delete item.models[modelID]
          }
        }
        // Vector's provider is the shared allowance, signed in only. An OpenRouter key of the user's own lists that
        // account's copies under OpenRouter below and never replaces the shared models.
        if (freeCatalog.enabled && isProviderAllowed(ProviderV2.ID.vector) && vectorToken && freeCatalog.models.length)
          providers[ProviderV2.ID.vector] = fromFreeModels(freeCatalog.models)
        if (!freeCatalog.enabled) delete providers[ProviderV2.ID.vector]
        // Codium replaces every user or project override of its ID, so prices and destination stay Vector's.
        delete providers[planID]
        if (planCatalog.enabled && isProviderAllowed(planID)) providers[planID] = fromModelPlans(planCatalog.models)
        if (openRouterKey && isProviderAllowed(ProviderV2.ID.openrouter)) {
          providers[ProviderV2.ID.openrouter] ??= fromFreeModels([], "openrouter")
          Object.assign(providers[ProviderV2.ID.openrouter].models, fromFreeModels(ownedFree, "openrouter").models)
        }

        const gitlab = ProviderV2.ID.make("gitlab")
        if (discoveryLoaders[gitlab] && providers[gitlab] && isProviderAllowed(gitlab)) {
          yield* Effect.promise(async () => {
            try {
              const discovered = await discoveryLoaders[gitlab]()
              for (const [modelID, model] of Object.entries(discovered)) {
                if (!providers[gitlab].models[modelID]) {
                  providers[gitlab].models[modelID] = model
                }
              }
            } catch (e) {}
          })
        }

        for (const [id, provider] of Object.entries(providers)) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) {
            delete providers[providerID]
            continue
          }

          delete provider.options.vectorOAuthPlugin
          const approval = activeOAuthApproval(providerID)
          if (approval) provider.options.vectorOAuthPlugin = approval.id
          const configProvider = cfg.provider?.[providerID]

          for (const [modelID, model] of Object.entries(provider.models)) {
            model.api.id = model.api.id ?? model.id ?? modelID
            if (
              // These chat aliases are invalid for the special handling in the
              // built-in providers below, but custom providers may support them.
              (modelID === "gpt-5-chat-latest" &&
                (providerID === ProviderV2.ID.openai ||
                  providerID === ProviderV2.ID.githubCopilot ||
                  providerID === ProviderV2.ID.openrouter)) ||
              (providerID === ProviderV2.ID.openrouter && modelID === "openai/gpt-5-chat")
            )
              delete provider.models[modelID]
            // Every catalogue model is listed, alpha and beta included; only retired ones go.
            if (model.status === "deprecated") delete provider.models[modelID]
            if (
              (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
              (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
            )
              delete provider.models[modelID]

            if (!model.variants || Object.keys(model.variants).length === 0) {
              model.variants = mapValues(ProviderTransform.variants(model), (v) => v)
            }

            const configVariants = configProvider?.models?.[modelID]?.variants
            if (configVariants && model.variants) {
              const merged = mergeDeep(model.variants, configVariants)
              model.variants = mapValues(
                pickBy(merged, (v) => !v.disabled),
                (v) => omit(v, ["disabled"]),
              )
            }
          }

          // Keep a connected free account visible when discovery or filters leave it empty.
          // Otherwise downstream default selection could mistake a paid provider for the only choice.
          if (Object.keys(provider.models).length === 0 && !(providerID === "openrouter" && openRouterKey)) {
            delete providers[providerID]
            continue
          }
        }

        // Vector Local keeps every model call on the model servers on the list, read from the policy in effect, which
        // is resolved before any provider loads. A model whose requests would go anywhere else is not offered, and a
        // provider left with none is listed off-in-local with why, so choosing either fails before a stream starts.
        const policy = Config.local()
        const withheld = new Map<string, ProviderUnavailable>()
        if (policy.enabled)
          for (const [id, item] of Object.entries(providers)) {
            const providerID = ProviderV2.ID.make(id)
            for (const [modelID, model] of Object.entries(item.models)) {
              const notice = offInLocal(model, item.options, varsLoaders[providerID], envs, policy, holds)
              if (!notice) continue
              withheld.set(`${providerID}/${modelID}`, notice)
              delete item.models[modelID]
            }
            if (Object.keys(item.models).length === 0) delete providers[providerID]
          }
        const off = [...new Map([...withheld.values()].map((notice) => [notice.id, notice])).values()].filter(
          (notice) => !providers[ProviderV2.ID.make(notice.id)],
        )

        const unavailable = [
          ...Object.entries(auths).flatMap(([id, credential]) => {
            if (credential.type === "wellknown") return []
            const rejected = providerCredentialUnavailable(id, credential, userProviders.has(id))
            if (rejected) return [rejected]
            if (disabled.has(id) || (enabled && !enabled.has(id))) return [providerUnavailable(id, "disabled")]
            if (off.some((notice) => notice.id === id)) return []
            if (!providers[ProviderV2.ID.make(id)]) return [providerUnavailable(id, "no-models")]
            return []
          }),
          ...off,
        ]
        for (const notice of unavailable) yield* Effect.logWarning(notice.message)

        return {
          models: languages,
          providers,
          unavailable,
          withheld,
          local: policy,
          revision: holds.revision(),
          declared: new Set([
            ...Object.keys(cfg.provider ?? {}),
            ...(cfg.disabled_providers ?? []),
            ...(cfg.enabled_providers ?? []),
            ...userProviders,
          ]),
          catalogIDs,
          getCatalog,
          sdk,
          modelLoaders,
          varsLoaders,
        }
      }),
    )

    // The catalog's startup refresh runs after its first load, which building this state usually performs, so a
    // changed mirror arrives after the state was built from the cached copy, and an hourly refresh can change it at any
    // time. Rebuild each instance's state on its next read, as an instance reload would. A refresh that finds the
    // mirror unchanged publishes nothing.
    yield* events.subscribe(ModelCatalog.Event.Refreshed).pipe(
      Stream.runForEach(() => InstanceState.invalidateAll(state)),
      Effect.forkScoped({ startImmediately: true }),
    )
    // State built while the free catalog read OFF, such as a cached OFF served at startup, would hide free models for
    // the whole app session once vectordev.ai turns them on. Rebuild whenever the catalog changes.
    yield* freeModels.changes.pipe(
      Stream.runForEach(() => InstanceState.invalidateAll(state)),
      Effect.forkScoped({ startImmediately: true }),
    )
    // Which models Vector Local keeps off follows the policy in effect and what server checks learned about the models
    // servers pass on: state built under another policy, or before a check learned that a model is passed on, is built
    // again on its next read. With Vector Local off before and now, nothing is compared.
    const providerState = Effect.gen(function* () {
      const s = yield* InstanceState.get(state)
      const policy = Config.local()
      if (!s.local.enabled && !policy.enabled) return s
      if (JSON.stringify(policy) === JSON.stringify(s.local) && s.revision === holds.revision()) return s
      yield* InstanceState.invalidate(state)
      return yield* InstanceState.get(state)
    })

    // A plan bought, a sign-in or a sign-out must not require restarting the local engine.
    const refreshCodium = Effect.fn("Provider.refreshCodium")(function* (options?: ModelPlans.CatalogOptions) {
      const s = yield* providerState
      const current = yield* modelPlans.catalog(yield* freeCredentials.get("vector"), options)
      const cfg = yield* config.get()
      delete s.providers[planID]
      if (
        current.enabled &&
        !Config.local().enabled &&
        !cfg.disabled_providers?.includes(planID) &&
        (!cfg.enabled_providers || cfg.enabled_providers.includes(planID))
      )
        s.providers[planID] = fromModelPlans(current.models)
      return s.providers
    })

    const list = Effect.fn("Provider.list")(() => refreshCodium())

    const unavailable = Effect.fn("Provider.unavailable")(() => Effect.map(providerState, (s) => s.unavailable))

    // Every session request names its session (LLMRequestPrep), and so does every model call a guest can cause: prompts,
    // compaction, titles, summaries, subagents and retries all run inside one. A request with none, such as generating
    // an agent from the terminal, is the owner's own. Anything but one session ID, such as two joined by a second
    // spelling of the header, names no session that can be checked, so it is held to the guest rule.
    const guestRequest = (headers: RequestInit["headers"]) => {
      const header = new Headers(headers).get("x-session-id")
      const sessionID =
        header !== null && /^ses[\w-]*$/.test(header) ? Schema.decodeUnknownOption(SessionID)(header) : Option.none()
      return header !== null && Option.isNone(sessionID)
        ? Promise.resolve(true)
        : runtimeBridge.promise(guests.marked(Option.getOrUndefined(sessionID)))
    }

    async function resolveSDK(model: Model, s: State, envs: Record<string, string | undefined>) {
      try {
        const provider = s.providers[model.providerID]
        if (model.providerID === planID) {
          const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
          return createOpenAICompatible({
            name: ModelPlans.PROVIDER_ID,
            baseURL: ModelPlans.API_URL,
            // The account token is added inside fetch, at the fixed vectordev.ai destination.
            apiKey: "vector-request-credential",
            fetch: ModelPlans.createFetch({
              modelID: model.id,
              credential: () => runtimeBridge.promise(freeCredentials.get("vector")),
              catalog: (token) => runtimeBridge.promise(modelPlans.catalog(token, { wait: true })),
              request: modelPlans.request,
            }),
          })
        }
        if (
          model.providerID === "vector" ||
          model.freeModel ||
          sendsToOpenRouterFree(openRouterDestination(model.providerID, model.id, model, provider))
        ) {
          const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
          return createOpenAICompatible({
            name: model.providerID,
            baseURL: "https://vectordev.ai/api/free-models",
            apiKey: "vector-request-credential",
            fetch: Object.assign(
              async (_input: RequestInfo | URL, init?: RequestInit) => {
                const route = await FreeModels.resolveRoute({
                  provider: model.providerID === "vector" ? "vector" : "openrouter",
                  modelID: model.id,
                  catalog: () => runtimeBridge.promise(freeModels.catalog()),
                  forKey: (key) => runtimeBridge.promise(freeModels.forKey(key)),
                  credential: (provider) => runtimeBridge.promise(freeCredentials.get(provider)),
                  trainingConsent: () => runtimeBridge.promise(freeModels.trainingConsent()),
                  guest: () => guestRequest(init?.headers),
                })
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
                // Built before the request: a may-train model without the user's acceptance throws, and nothing is sent.
                const payload = serializeFreeModelRequest(
                  freeModelRequest({ ...body, model: model.id }, route.models, {
                    trainingConsent: route.trainingConsent,
                    guest: route.guest,
                  }),
                  route.url === FreeModels.SHARED_CHAT_URL,
                )
                return Egress.fetch("vector-free-models", route.url, {
                  method: "POST",
                  redirect: "error",
                  signal: init?.signal,
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${route.key}`,
                    "HTTP-Referer": "https://vectordev.ai/",
                    "X-OpenRouter-Title": "Vector",
                    ...route.headers,
                  },
                  body: payload,
                })
                  .then((response) => {
                    const chosen = route.models.find((item) => item.id === model.id)
                    return route.source === "openrouter" && chosen
                      ? FreeModels.explainPolicyRefusal(response, freeModelDataPolicy(chosen))
                      : response
                  })
                  .then(FreeModels.preserveLimit)
              },
              { preconnect: fetch.preconnect },
            ),
          })
        }
        const options = { ...provider.options }
        const credential = await runtimeBridge.promise(auth.get(model.providerID).pipe(Effect.orDie))
        const consentID = credential?.type !== "wellknown" ? credential?.metadata?.vector_plugin_oauth : undefined
        const consent = typeof consentID === "string" ? activeOAuthApproval(model.providerID, consentID) : undefined
        if (consentID && (!consent || !pluginCredentialAllowed(model.providerID, credential!)))
          throw new Error("Plugin OAuth approval changed. Reconnect to continue.")

        if (
          model.providerID === "google-vertex" &&
          model.api.npm === "@ai-sdk/google-vertex/anthropic" &&
          !options.baseURL
        ) {
          const baseURL = googleVertexAnthropicBaseURL(
            typeof options.project === "string" ? options.project : undefined,
            typeof options.location === "string" ? options.location : undefined,
          )
          if (baseURL) options.baseURL = baseURL
        }

        if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
          delete options.fetch
        }

        if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
          options["includeUsage"] = true
        }

        const baseURL = resolveBaseURL(model, options, s.varsLoaders[model.providerID], envs)
        // A base URL filled in from the environment can point any provider at openrouter.ai after the lists were built.
        if (
          sendsToOpenRouterFree({
            ...openRouterDestination(model.providerID, model.id, model, provider),
            destinations: [baseURL],
          })
        )
          throw new Error(FREE_MODEL_UNLISTED)

        if (baseURL !== undefined) options["baseURL"] = baseURL
        if (consent) requirePluginDestination(consent, baseURL)
        if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
        if (model.providerID === "gitlab") {
          if (credential?.type === "oauth" && !consent && options.apiKey === credential.access)
            options.instanceUrl = requireGitlabOAuthEndpoint(credential, options)
        }
        if (model.headers)
          options["headers"] = {
            ...options["headers"],
            ...model.headers,
          }

        // One SDK per model: its fetch below decides each call by the model it was made for.
        const key = Hash.fast(
          JSON.stringify({
            providerID: model.providerID,
            model: model.api.id,
            npm: model.api.npm,
            options,
          }),
        )
        const existing = s.sdk.get(key)
        if (existing) return existing

        const customFetch = options["fetch"]
        const hosted =
          ModelSlots.server(
            typeof options["preconnect"] === "string" ? options["preconnect"] : baseURL,
            Config.local(),
          ) !== undefined
        const chunkTimeout = options["chunkTimeout"] ?? (hosted ? LOCAL_CHUNK_TIMEOUT : undefined)
        const headerTimeout = options["headerTimeout"] ?? (hosted ? LOCAL_HEADER_TIMEOUT : undefined)
        delete options["chunkTimeout"]
        delete options["headerTimeout"]
        delete options["preconnect"]
        // Read by the model's line for the server's permits and its cost; the SDK has no use for them.
        delete options["concurrency"]
        delete options["forwards"]

        options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
          const fetchFn = customFetch ?? fetch
          const opts = { ...init }
          const body = ProviderTransform.reasoningContextBody(
            model.api.npm,
            runtimeFlags.experimentalReasoningContext,
            init?.body,
          )
          if (body !== undefined) opts.body = body
          // A request that reaches OpenRouter here skips every free-model check, so it must not name a free model.
          // Model and provider options can replace the model the SDK sends (`model` in them overrides it). Their
          // fallbacks, presets and plugins still go out, but where they could let OpenRouter answer from another
          // model's endpoints, a free one or one that may train on prompts included (openRouterModelRouting), the
          // request asks OpenRouter to deny data collection unless the user accepted the "May train on your prompts"
          // notice in a session no invited guest has worked in.
          if (isOpenRouterURL(input instanceof Request ? input.url : String(input))) {
            const sent =
              typeof opts.body === "string"
                ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(opts.body))
                : undefined
            const sentModel = isRecord(sent) ? sent.model : undefined
            if (typeof sentModel === "string" && isOpenRouterFreeModel(sentModel, undefined))
              throw new Error(FREE_MODEL_UNLISTED)
            if (
              isRecord(sent) &&
              openRouterModelRouting(sent, sentModel).length &&
              ((await guestRequest(init?.headers)) || !(await runtimeBridge.promise(freeModels.trainingConsent())))
            )
              opts.body = JSON.stringify(denyDataCollection(sent))
          }
          if (consent) {
            requirePluginDestination(consent, input instanceof Request ? input.url : String(input))
            const current = await runtimeBridge.promise(auth.get(model.providerID).pipe(Effect.orDie))
            if (
              !current ||
              current.type === "wellknown" ||
              current.metadata?.vector_plugin_oauth !== consent.id ||
              !pluginCredentialAllowed(model.providerID, current)
            )
              throw new Error("Plugin OAuth approval or credential changed. Reconnect to continue.")
            opts.redirect = "error"
          }
          // With Vector Local on, a listed server is read before its first model call (and again once the policy
          // changes, a call names a model it did not list, or nothing answered): a pinned one is checked against its
          // pin, and no model call goes to a server whose identity changed since it was added until the user confirms
          // the server. The read also learns which of its models the server passes on, which the decision below
          // refuses by this model's name and by the one the request sends.
          const target = input instanceof Request ? input.url : String(input)
          const policy = Egress.policy()
          const sent = policy.enabled && ModelSlots.server(target, policy) ? bodyModel(opts.body) : undefined
          const names = sent === undefined || sent === model.api.id ? [model.api.id] : [model.api.id, sent]
          if (policy.enabled) {
            await holds.check(target, policy, names)
            holds.gate(target)
          }
          const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
          const headerTimeoutMs = headerTimeout === false ? undefined : headerTimeout
          const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
          const signals: AbortSignal[] = []

          if (opts.signal) signals.push(opts.signal)
          if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
          if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
          if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
            signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
          if (combined) opts.signal = combined

          // Vector Local decides every model call here, before a plugin's own fetch runs or its WebSocket opens (ChatGPT
          // sign-in's Responses transport starts inside that fetch): only a model server on the list gets it, and it
          // follows no redirect. With Vector Local off it goes to fetchFn as it is.
          const res = ResponseTerminal.wrap(
            await Egress.fetch(
              policy.enabled ? inferenceSource(names, target, policy, holds) : "local-inference",
              input,
              {
                ...opts,
                // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
                timeout: false,
              },
              fetchFn,
            )
              .then(
                (response) => {
                  // A proxy in front of the server could not reach it (Bad Gateway): it is read again, as below.
                  if (policy.enabled && response.status === 502) holds.recheck(target)
                  return response
                },
                (error: unknown) => {
                  // Nothing answered, so another server may take the port: it is read again before the next call.
                  if (policy.enabled && !combined?.aborted && !(error instanceof EgressGuard.EgressBlocked))
                    holds.recheck(target)
                  throw error
                },
              )
              .finally(() => headerTimeoutCtl?.clear()),
          )

          if (!chunkAbortCtl) return res
          return wrapSSE(res, chunkTimeout, chunkAbortCtl)
        }

        const bundledLoader = BUNDLED_PROVIDERS[model.api.npm]
        if (bundledLoader) {
          const factory = await bundledLoader()
          const loaded = factory({
            name: model.providerID,
            ...options,
          })
          s.sdk.set(key, loaded)
          return loaded as SDK
        }

        const installedPath = await (async () => {
          if (model.api.npm.startsWith("file://")) {
            return model.api.npm
          }
          // Under Vector Local, a package the config names (npm-plugins): a copy installed earlier loads, and a missing
          // one installs only when allowed, and the error says why.
          const item = await Npm.addAs("npm-plugins", model.api.npm)
          if (!item.entrypoint) throw new Error(`Package ${model.api.npm} has no import entrypoint`)
          return item.entrypoint
        })()

        // `installedPath` is a local entry path or an existing `file://` URL. Normalize
        // only path inputs so Node on Windows accepts the dynamic import.
        const importSpec = installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
        const mod = await import(importSpec)

        const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
        const loaded = fn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      } catch (e) {
        throw new InitError({ providerID: model.providerID, cause: e })
      }
    }

    const getProvider = Effect.fn("Provider.getProvider")((providerID: ProviderV2.ID) =>
      Effect.map(providerState, (s) => s.providers[providerID]),
    )

    const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderV2.ID, modelID: ModelV2.ID) {
      // Vector Local keeps Vector's own models off; that is the reason to give, not a sign-in or credits.
      if (Config.local().enabled && (providerID === planID || providerID === ProviderV2.ID.vector))
        return yield* new ModelNotFoundError({
          providerID,
          modelID,
          unavailable: {
            id: providerID,
            reason: "off-in-local",
            message: `${providerID}: off in Vector Local. ${OFF_IN_LOCAL.vector}`,
          },
        })
      // A turn waits for vectordev.ai's answer when this account has no Codium catalog yet.
      if (providerID === planID) yield* refreshCodium({ wait: true })
      const s = yield* providerState
      const withheld = s.withheld.get(`${providerID}/${modelID}`)
      if (withheld) return yield* new ModelNotFoundError({ providerID, modelID, unavailable: withheld })
      const provider = Object.hasOwn(s.providers, providerID) ? s.providers[providerID] : undefined
      // Never move a Codium conversation to another provider; say why it cannot run and what fixes it.
      if (!provider && providerID === planID) {
        const signedIn = (yield* freeCredentials.get("vector")) !== undefined
        return yield* new ModelNotFoundError({
          providerID,
          modelID,
          codium: signedIn ? "unavailable" : "sign-in",
          unavailable: {
            id: providerID,
            reason: "no-models",
            message: signedIn
              ? `Vector Codium is not available right now; see ${ModelPlans.PURCHASE_URL}. Choose another model to continue.`
              : "Sign in to Vector to use Vector Codium, or choose another model to continue.",
          },
        })
      }
      // A shared free model needs a Vector sign-in, even with an OpenRouter account connected, so say that.
      if (!provider && providerID === ProviderV2.ID.vector && (yield* freeSignIn()))
        return yield* new ModelNotFoundError({
          providerID,
          modelID,
          unavailable: { id: providerID, reason: "no-models", message: FREE_MODELS_SIGN_IN },
        })
      if (!provider) {
        const catalogProvider = s.getCatalog(providerID)
        const suggestions = catalogProvider
          ? modelSuggestions(catalogProvider, modelID)
          : fuzzysort
              .go(providerID, Object.keys({ ...s.catalogIDs, ...s.providers }), { limit: 3, threshold: -10000 })
              .map((m) => m.target)
        return yield* new ModelNotFoundError({
          providerID,
          modelID,
          suggestions,
          unavailable: s.unavailable.find((item) => item.id === providerID),
        })
      }

      const info = provider.models[modelID]
      if (!info) {
        const current = modelSuggestions(provider, modelID)
        const suggestions = current.length ? current : modelSuggestions(s.getCatalog(providerID), modelID)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }
      return info
    })

    const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
      const s = yield* providerState
      const envs = yield* env.all()
      const key = `${model.providerID}/${model.id}`
      const provider = s.providers[model.providerID]
      const language =
        s.models.get(key) ??
        (yield* EffectPromise.refineRejection(
          async () => {
            const sdk = await resolveSDK(model, s, envs)
            const loaded = s.modelLoaders[model.providerID]
              ? await s.modelLoaders[model.providerID](
                  sdk,
                  model.api.id,
                  {
                    ...provider.options,
                    ...model.options,
                  },
                  model,
                )
              : sdk.languageModel(model.api.id)
            s.models.set(key, loaded)
            return loaded
          },
          (cause) =>
            cause instanceof NoSuchModelError
              ? new ModelNotFoundError({ modelID: model.id, providerID: model.providerID, cause })
              : undefined,
        ))
      const at = lineOf(model, s, envs)
      if (!at) return language
      return fitted(language, {
        slots,
        origin: at.origin,
        permits: at.permits,
        priority: priorityOf(model),
        context: at.hosted ? model.limit.context : 0,
        ceiling: at.hosted ? hostedCeiling(model, lanes.get(model)?.brief === true) : undefined,
      })
    })

    // Where a model's requests wait, as getLanguage holds them and the session processor, Vectorscope and the
    // document reader read it: undefined for a cloud API that configures no `concurrency`, a free model and Vector
    // Codium. It reads the request's own origin (a plugin's `preconnect`, variables filled in) and the server list.
    const lineOf = (model: Model, s: State, envs: Record<string, string | undefined>): Line | undefined => {
      const provider = s.providers[model.providerID]
      // Free models and Vector Codium choose their route per request and are never on a server someone hosts.
      if (!provider || model.providerID === "vector" || model.providerID === planID || model.freeModel) return undefined
      const origins = requestOrigins(model, provider.options, s.varsLoaders[model.providerID], envs)
      const origin = origins[0]
      if (!origin) return undefined
      const policy = Config.local()
      const hosted = ModelSlots.server(origin, policy)
      // How many requests the server takes: the smallest concurrency this provider or any other provider pointing at
      // the same server configures, since they share it. Undefined when none does.
      const counts = Object.values(s.providers).flatMap((item) => {
        const value = item.options["concurrency"]
        if (typeof value !== "number") return []
        if (item === provider) return [value]
        const other =
          typeof item.options["baseURL"] === "string" ? LocalPolicy.origin(item.options["baseURL"]) : undefined
        return other && other === LocalPolicy.origin(origin) ? [value] : []
      })
      const permits = counts.length ? Math.min(...counts) : undefined
      // A cloud API is left as it is unless a provider configures how many requests it takes.
      if (!hosted && permits === undefined) return undefined
      return {
        origin: hosted ?? origin,
        hosted: hosted !== undefined,
        permits,
        // A model the server said it passes on (an Ollama cloud model, whatever its name) is never a free local one.
        local: origins.every((item) =>
          ModelSlots.local(item, {
            policy,
            model: model.api.id,
            forwards: provider.options["forwards"] === true || holds.forwards(item, model.api.id),
          }),
        ),
      }
    }

    const line = Effect.fn("Provider.line")(function* (model: Model) {
      const s = yield* providerState
      return lineOf(model, s, yield* env.all())
    })

    const preconnect = Effect.fn("Provider.preconnect")(function* (model: Model) {
      const s = yield* providerState
      const provider = s.providers[model.providerID]
      // Free models choose their route per request, so there is no one connection to open ahead of it.
      if (!provider || model.providerID === "vector" || model.freeModel) return
      const envs = yield* env.all()
      const origin = requestOrigins(model, provider.options, s.varsLoaders[model.providerID], envs)[0]
      // A speculative connection must never prevent the SDK from making its actual request.
      if (origin) yield* Effect.sync(() => preconnectOrigin(origin, envs)).pipe(Effect.catchDefect(() => Effect.void))
    })

    const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderV2.ID, query: string[]) {
      const s = yield* providerState
      const provider = s.providers[providerID]
      if (!provider) return undefined
      for (const item of query) {
        for (const modelID of Object.keys(provider.models)) {
          if (modelID.includes(item)) return { providerID, modelID }
        }
      }
      return undefined
    })

    // The model a Codium conversation's helper calls run on: Auto's floor, then its default, never a locked, manual-only
    // or Auto entry. Without either (signed out, Codium off, Vector Local, or a plan whose Auto is not usable) there is
    // no helper model and the helper is skipped.
    const codiumHelper = Effect.fnUntraced(function* () {
      const listed = (yield* refreshCodium({ wait: true }))[planID]
      const chosen = CodiumAuto.helper(yield* modelPlans.catalog(yield* freeCredentials.get("vector")))
      return chosen ? listed?.models[chosen.id] : undefined
    })

    const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (
      providerID: ProviderV2.ID,
      primaryID?: ModelV2.ID,
    ) {
      // An explicitly selected Codium conversation keeps helper calls on Codium. A helper agent set to Codium Auto asks
      // with the provider alone and may run beside a conversation on another provider, so the listing is read here.
      if (providerID === planID) return yield* codiumHelper()
      const s = yield* providerState
      const provider = s.providers[providerID]
      if (!provider) return undefined
      const primary = primaryID ? provider.models[primaryID] : undefined
      // Background calls must not turn a free conversation into paid inference, even with a small-model override.
      if (primary && isFreeModel(primary)) return primary
      // A helper call never moves a conversation onto a free model whose provider may train on prompts.
      if (providerID === "vector")
        return Object.values(provider.models).find((model) => isFreeModel(model) && !freeModelMayTrain(model))
      const cfg = yield* config.get()

      if (cfg.small_model) {
        const parsed = parseModel(cfg.small_model)
        // Codium Auto is a listing entry and never a model the gateway serves: as the small model it gives the model a
        // Codium conversation's helpers get.
        if (parsed.providerID === planID && parsed.modelID === ModelPlans.AUTO_ID) return yield* codiumHelper()
        const small = yield* getModel(parsed.providerID, parsed.modelID).pipe(
          Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)),
        )
        // A Codium model the plan no longer includes is listed, but every helper call to it would be refused: there is
        // no helper model then, as when it was not listed, and the caller falls back (a title runs on its own model).
        return parsed.providerID === planID && small?.codium?.locked ? undefined : small
      }

      const experimental = yield* plugin.trigger<"experimental.provider.small_model">(
        "experimental.provider.small_model",
        { provider: toPublicInfo(provider) },
        { model: undefined },
      )
      if (experimental.model) {
        return {
          ...experimental.model,
          id: ModelV2.ID.make(experimental.model.id),
          providerID: ProviderV2.ID.make(experimental.model.providerID),
        }
      }

      // ChatGPT sign-in does not establish access to every small model in the API catalog.
      // Reuse the selected route instead of inferring a sibling; explicit choices above still win.
      if (providerID === ProviderV2.ID.openai && (yield* auth.get(providerID).pipe(Effect.orDie))?.type === "oauth") {
        return primary
      }

      // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
      if (providerID === ProviderV2.ID.azure || providerID === ProviderV2.ID.make("azure-cognitive-services")) {
        return undefined
      }

      const priority = providerID.startsWith("github-copilot")
        ? ["gpt-mini", ...smallModelFamilyPriority]
        : smallModelFamilyPriority
      const models = sortBy(
        Object.values(provider.models),
        [(model) => model.release_date, "desc"],
        // OpenAI delivery modes share the base release date; a background call must not opt into a tier by ID order.
        [
          (model) =>
            Number(
              providerID === ProviderV2.ID.openai &&
                model.id !== model.api.id &&
                model.options.serviceTier !== undefined,
            ),
          "asc",
        ],
        [(model) => model.id, "desc"],
      )
      for (const family of priority) {
        const candidates = models.filter((model) => model.family === family)
        if (providerID === ProviderV2.ID.amazonBedrock) {
          const crossRegionPrefixes = ["global.", "us.", "eu."]

          const globalMatch = candidates.find((model) => model.id.startsWith("global."))
          if (globalMatch) return globalMatch

          const region = provider.options?.region
          if (region) {
            const regionPrefix = region.split("-")[0]
            if (regionPrefix === "us" || regionPrefix === "eu") {
              const regionalMatch = candidates.find((model) => model.id.startsWith(`${regionPrefix}.`))
              if (regionalMatch) return regionalMatch
            }
          }

          const unprefixed = candidates.find((model) => !crossRegionPrefixes.some((p) => model.id.startsWith(p)))
          if (unprefixed) return unprefixed
          continue
        }
        if (candidates[0]) return candidates[0]
      }

      return undefined
    })

    const codiumAuto = Effect.fn("Provider.codiumAuto")(function* (input: {
      tier: TaskSize.Tier
      contextTokens: number
    }) {
      const auto = ModelV2.ID.make(ModelPlans.AUTO_ID)
      // Signed out, Codium off for the account or Vector Local on: the same notice a chosen Codium model gets.
      const listed = (yield* refreshCodium({ wait: true }))[planID]
      if (!listed) return yield* getModel(planID, auto).pipe(Effect.as({ providerID: planID, modelID: auto }))
      const chosen = CodiumAuto.resolve({
        catalog: yield* modelPlans.catalog(yield* freeCredentials.get("vector"), { wait: true }),
        tier: input.tier,
        contextTokens: input.contextTokens,
      })
      if (chosen && listed.models[chosen.id]) return { providerID: planID, modelID: ModelV2.ID.make(chosen.id) }
      // An older gateway, or a plan whose Auto models are not all usable, offers no Auto: say so rather than pick one.
      return yield* new ModelNotFoundError({
        providerID: planID,
        modelID: auto,
        codium: "unavailable",
        unavailable: {
          id: planID,
          reason: "no-models",
          message: "Codium Auto is not available on your plan right now. Choose a Vector Codium model to continue.",
        },
      })
    })

    const savedModel = Effect.fn("Provider.savedModel")(function* (model: { providerID: string; modelID: string }) {
      const s = yield* providerState
      // A saved Vector model stays on the shared allowance, even when the user's own OpenRouter account lists it too.
      const current = renamedModel(model)
      if (providerRetired(current.providerID, (id) => s.declared.has(id) || id in s.providers)) return
      return { providerID: ProviderV2.ID.make(current.providerID), modelID: ModelV2.ID.make(current.modelID) }
    })

    const freeSignIn = Effect.fn("Provider.freeSignIn")(function* () {
      const cfg = yield* config.get()
      if (
        cfg.disabled_providers?.includes("vector") ||
        (cfg.enabled_providers && !cfg.enabled_providers.includes("vector"))
      )
        return false
      const catalog = yield* freeModels.catalog()
      if (!catalog.enabled || !catalog.models.length) return false
      // An OpenRouter key of the user's own lists only that account's copies, so it still needs the sign-in.
      return !(yield* freeCredentials.get("vector"))
    })

    const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
      const cfg = yield* config.get()
      const saved = cfg.model ? yield* savedModel(parseModel(cfg.model)) : undefined
      if (saved && providerEnabled(saved.providerID)) return saved

      const s = yield* providerState
      const recent = yield* fs.readJson(path.join(Global.Path.state, "model.json")).pipe(
        Effect.map((x): { providerID: ProviderV2.ID; modelID: ModelV2.ID }[] => {
          if (!isRecord(x) || !Array.isArray(x.recent)) return []
          return x.recent.flatMap((item) => {
            if (!isRecord(item)) return []
            if (typeof item.providerID !== "string") return []
            if (typeof item.modelID !== "string") return []
            const model = renamedModel({ providerID: item.providerID, modelID: item.modelID })
            return [{ providerID: ProviderV2.ID.make(model.providerID), modelID: ModelV2.ID.make(model.modelID) }]
          })
        }),
        Effect.catch(() => Effect.succeed([] as { providerID: ProviderV2.ID; modelID: ModelV2.ID }[])),
      )
      for (const entry of recent) {
        const provider = s.providers[entry.providerID]
        // A vanished free choice must fail as unavailable, never quietly select a paid model. With Vector Local on, free
        // models are off and every model left runs on a server on the list, so the next recent choice is taken.
        if (isFreeModelRef(entry) && !Config.local().enabled) return entry
        if (!provider) continue
        const model = provider.models[entry.modelID]
        if (!model) continue
        // A Codium model the plan no longer includes is listed (choosing it opens Change plan), but every turn on it
        // would be refused, so it is never the default, as the app and the TUI never restore it.
        if (entry.providerID === planID && model.codium?.locked) continue
        return { providerID: entry.providerID, modelID: entry.modelID }
      }

      const configured = Object.keys(cfg.provider ?? {})
      const providers = Object.values(s.providers).filter((p) => configured.length === 0 || configured.includes(p.id))
      const free = automaticModels(
        Object.values(s.providers).flatMap((provider) => Object.values(provider.models)),
      ).find((model) => model.freeModel?.source === "openrouter")
      if (free) return { providerID: free.providerID, modelID: free.id }
      if (s.providers[ProviderV2.ID.openrouter])
        return yield* new NoModelsError({ providerID: ProviderV2.ID.openrouter })
      // Codium spends the account's credits, so it is never chosen automatically; the person picks it.
      const automatic = providers.filter((p) => p.id !== planID)
      const provider = automatic.find((p) => p.id !== "vector") ?? automatic[0]
      if (!provider)
        return yield* new NoProvidersError({ codium: s.providers[planID] !== undefined, signIn: yield* freeSignIn() })
      const [model] = automaticModels(Object.values(provider.models))
      if (!model) return yield* new NoModelsError({ providerID: provider.id })
      return {
        providerID: provider.id,
        modelID: model.id,
      }
    })

    return Service.of({
      list,
      unavailable,
      getProvider,
      getModel,
      getLanguage,
      line,
      preconnect,
      closest,
      getSmallModel,
      codiumAuto,
      defaultModel,
      savedModel,
      freeSignIn,
    })
  }),
)

const priority = ["gpt-5", "claude-sonnet-4", "gemini-3-pro"]
const smallModelFamilyPriority = ["gemini-flash", "gpt-nano", "claude-haiku"]
type Sortable = {
  id: string
  freeModel?: { source: "shared" | "openrouter"; dataPolicy?: FreeDataPolicy }
  limit?: { context: number }
}
export function sort<T extends Sortable>(models: T[]) {
  return sortBy(
    models,
    // OpenRouter's free router picks a model at random, so lists show it last.
    [(model) => (model.id === FREE_ROUTER_ID ? 1 : 0), "asc"],
    [(model) => (model.freeModel?.source === "openrouter" ? 0 : 1), "asc"],
    // A model whose provider may train on prompts is never chosen automatically ahead of a no-training one.
    [(model) => (model.freeModel?.dataPolicy && model.freeModel.dataPolicy !== "no-training" ? 1 : 0), "asc"],
    [(model) => (model.freeModel?.source === "openrouter" ? (model.limit?.context ?? 0) : 0), "desc"],
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.id, "desc"],
  )
}

/**
 * The models Vector may choose for someone, best first. OpenRouter's free router picks a model at random, so it is
 * never chosen automatically, even as a provider's only model; it runs only when someone picks it.
 */
export function automaticModels<T extends Sortable>(models: T[]) {
  return sort(models.filter((model) => model.id !== FREE_ROUTER_ID))
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ModelV2.ID.make(rest.join("/")),
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    FSUtil.node,
    Config.node,
    Auth.node,
    Env.node,
    Plugin.node,
    ModelCatalog.node,
    RuntimeFlags.node,
    FreeModels.node,
    ModelPlans.node,
    FreeModels.credentialsNode,
    FreeModelGuests.node,
    EventV2Bridge.node,
    ModelSlots.node,
    LocalProbe.holdsNode,
  ],
})

export * as Provider from "./provider"
