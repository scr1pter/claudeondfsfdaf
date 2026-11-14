export * as FreeModels from "./free-models"

import path from "node:path"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import {
  type FreeDataPolicy,
  FreeModelCatalog,
  FreeModelInfo,
  FREE_MODELS_CONSENT_ACCEPTED,
  FREE_MODELS_CONSENT_HEADER,
  FREE_MODELS_DISCLOSURE,
  FREE_MODELS_DISCLOSURE_HEADER,
  FreeModelsLimitError,
  parseFreeModelLimit,
} from "@vectordevai/schema/free-model"
import { Integration } from "@vectordevai/schema/integration"
import { Credential } from "./credential"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { VectorAccount } from "./vector-account"
import { makeGlobalNode } from "./effect/app-node"
import { Egress } from "./local-mode/egress"
import { StartupHold } from "./startup-hold"
import {
  FreeModelMetadata,
  freeModelDataPolicy,
  freeModelInfo,
  isFreeModelID,
  isFreeRouter,
  offeredFreeModel,
} from "./free-model-catalog"
import { FREE_MODEL_TRAINING_BLOCKED, FREE_MODEL_UNLISTED, FREE_MODELS_SIGN_IN } from "./free-model-choice"

// The disclosure parameter tells vectordev.ai this client labels free models that may train and asks first.
export const CATALOG_URL = `https://vectordev.ai/api/free-models/models?disclosure=${FREE_MODELS_DISCLOSURE}`
export const SHARED_CHAT_URL = "https://vectordev.ai/api/free-models/chat"
export const OPENROUTER_ROOT = "https://openrouter.ai/api/v1"
export const OPENROUTER_CHAT_URL = `${OPENROUTER_ROOT}/chat/completions`
const OFF: FreeModelCatalog = { enabled: false, updatedAt: 0, models: [] }
const TTL = 5 * 60_000

const MetadataList = Schema.Struct({ data: Schema.Array(Schema.Unknown) })
const EndpointList = Schema.Struct({ data: Schema.Struct({ endpoints: Schema.Array(Schema.Unknown) }) })
const Consent = Schema.Struct({ version: Schema.Literal(1), training: Schema.Literal(true), acceptedAt: Schema.Number })

/** What provider state is built from: whether the catalog is on, its models and each one's data policy. */
function signature(catalog: FreeModelCatalog) {
  return JSON.stringify([catalog.enabled, catalog.models.map((model) => [model.id, freeModelDataPolicy(model)])])
}

export function createClient(
  input: {
    file?: string
    /** Where the one-time "may train on your prompts" acceptance is remembered. */
    consentFile?: string
    request?: (url: string, init: RequestInit) => Promise<Response>
    now?: () => number
    disabled?: () => boolean
    /**
     * A desktop first run's hold (StartupHold): nothing is fetched while it holds, and once it is released the catalog
     * is read again and every listener hears it, so free models (the user's own OpenRouter key's included) are listed
     * in the same engine, with no restart.
     */
    hold?: Pick<typeof StartupHold, "held" | "onRelease">
    /**
     * Whether Vector Local is on: free models send prompts through vectordev.ai and openrouter.ai to the services that
     * run them, outside the servers the user lists, so the catalog is OFF and nothing is fetched.
     */
    local?: () => boolean
    /** How long a non-forced catalog read waits for vectordev.ai before answering without it. */
    wait?: number
  } = {},
) {
  const now = input.now ?? Date.now
  const request = input.request ?? fetch
  const off = () => input.disabled?.() === true || input.hold?.held() === true
  // `stamp` is the cache file's modification time as this client last read or wrote it.
  const state: { value?: FreeModelCatalog; expires: number; pending?: Promise<FreeModelCatalog>; stamp?: number } = {
    expires: 0,
  }
  const modified = (file: string) =>
    stat(file).then(
      (info) => info.mtimeMs,
      () => undefined,
    )
  const users = new Map<string, { expires: number; models: FreeModelInfo[] }>()
  const listeners = new Set<(catalog: FreeModelCatalog) => void>()
  // The last answer any caller received, which provider state may have been built from.
  const served: { value?: FreeModelCatalog } = {}
  const serve = (value: FreeModelCatalog) => {
    served.value = value
    return value
  }
  const catalog = async (force = false): Promise<FreeModelCatalog> => {
    if (input.local?.()) return serve(OFF)
    // The desktop engine, the terminal and "vector models" share the cache file: when another of them wrote a newer
    // catalog, this client reads that instead of serving its own copy until it expires.
    if (input.file && state.value && !state.pending) {
      const stamp = await modified(input.file)
      if (stamp !== undefined && stamp !== state.stamp) {
        state.value = undefined
        state.expires = 0
      }
    }
    if (!force && state.value && state.expires > now()) return serve(state.value)
    if (input.file && !state.value) state.stamp = await modified(input.file)
    const saved =
      state.value ??
      (input.file
        ? await readFile(input.file, "utf8")
            .then((text) =>
              Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(FreeModelCatalog))(text)),
            )
            .catch(() => undefined)
        : undefined)
    const refresh = state.pending ?? load(saved)
    if (force) return refresh.then(serve)
    // Provider loading and every free-model chat wait here, so they must never stall on vectordev.ai.
    // A known OFF answer is served at once while the refresh lands for the next caller. Otherwise the
    // wait is short and then serves the last catalog seen, stale, or OFF on a first run. Subscribers
    // hear when the refresh differs from what was served.
    if (saved && !saved.enabled) return serve(OFF)
    const fallback = Promise.withResolvers<FreeModelCatalog>()
    // This deadline settles an awaited operation; keep it alive until the race finishes.
    const timer = setTimeout(() => fallback.resolve(saved ?? OFF), input.wait ?? 1_500)
    return Promise.race([refresh, fallback.promise])
      .then(serve)
      .finally(() => clearTimeout(timer))
  }
  const load = (saved: FreeModelCatalog | undefined) => {
    const pending = (async () => {
      const response = off()
        ? undefined
        : await request(CATALOG_URL, {
            redirect: "error",
            signal: AbortSignal.timeout(8_000),
            headers: { accept: "application/json" },
          }).catch(() => undefined)
      const parsed = response?.ok
        ? Option.getOrUndefined(
            Schema.decodeUnknownOption(FreeModelCatalog)(await response.json().catch(() => undefined)),
          )
        : undefined
      const valid =
        parsed &&
        (!parsed.enabled ||
          parsed.models.every(
            (model) =>
              isFreeModelID(model.id) &&
              Number.isSafeInteger(model.contextLength) &&
              model.contextLength > 0 &&
              Number.isSafeInteger(model.maxOutputTokens) &&
              model.maxOutputTokens > 0 &&
              model.providers.length > 0 &&
              model.providers.every((provider) => !!provider.id.trim()),
          ))
      const value = valid ? (parsed.enabled ? parsed : OFF) : unreachable(saved, !!response)
      state.value = value
      state.expires = now() + TTL
      // Provider state built from an earlier answer, such as a cached OFF served at startup, must rebuild when the
      // catalog turns on, off or changes models; otherwise it stays stale for the rest of the app session. A first
      // answer that callers are still waiting for needs no rebuild.
      if (served.value && signature(served.value) !== signature(value)) listeners.forEach((listener) => listener(value))
      if (input.file && valid) {
        const file = input.file
        const temporary = `${file}.${randomUUID()}.tmp`
        // This optional cache must not block provider startup or discard an explicit OFF response.
        await mkdir(path.dirname(file), { recursive: true })
          .then(() => writeFile(temporary, JSON.stringify(value), { mode: 0o600 }))
          .then(() => rename(temporary, file))
          .then(async () => {
            state.stamp = await modified(file)
          })
          .catch(() => rm(temporary, { force: true }).catch(() => undefined))
      }
      return value
    })().finally(() => {
      state.pending = undefined
    })
    state.pending = pending
    return pending
  }
  const forKey = async (key: string, force = false) => {
    if (!key || off() || input.local?.()) return []
    const digest = createHash("sha256").update(key).digest("hex")
    const cached = users.get(digest)
    if (!force && cached && cached.expires > now()) return cached.models
    // Personal access depends only on OpenRouter, not the optional hosted shared allowance.
    const read = async <T>(url: string, schema: Schema.Decoder<T>, authenticated = false) => {
      const response = await request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
        headers: authenticated
          ? {
              Authorization: `Bearer ${key}`,
              "HTTP-Referer": "https://vectordev.ai/",
              "X-OpenRouter-Title": "Vector",
            }
          : { accept: "application/json" },
      }).catch(() => undefined)
      return response?.ok
        ? Option.getOrUndefined(Schema.decodeUnknownOption(schema)(await response.json().catch(() => undefined)))
        : undefined
    }
    const available = await read(`${OPENROUTER_ROOT}/models/user`, MetadataList, true)
    const candidates = (available?.data ?? []).flatMap((value) => {
      const model = Schema.decodeUnknownOption(FreeModelMetadata)(value)
      return Option.isSome(model) && offeredFreeModel(model.value, now()) ? [model.value] : []
    })
    // The user's own account lists every free model it can route under its privacy settings, including ones Vector
    // has not reviewed yet. Each endpoint carries its reviewed policy, or "may-train" when Vector has not reviewed it;
    // the account's own settings decide whether may-train endpoints are listed at all.
    // The free router has no endpoint list of its own.
    const endpoints = await Promise.all(
      candidates.map((model) =>
        isFreeRouter(model.id) ? undefined : read(`${OPENROUTER_ROOT}/models/${model.id}/endpoints`, EndpointList),
      ),
    )
    // A rejected key must never revive stale models.
    if (!available) {
      users.delete(digest)
      return []
    }
    // An unreadable endpoint list leaves that model without endpoints, which drops only that model.
    const models = candidates
      .map((model, index) => freeModelInfo(model, endpoints[index]?.data.endpoints ?? []))
      .filter((model): model is FreeModelInfo => model !== undefined)
      .sort((a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id))
    users.set(digest, { expires: now() + TTL, models })
    return models
  }
  // Read on every request, never cached: the desktop engine, the TUI and "vector models --accept-training" share the
  // file, and a withdrawal must take effect on the next prompt. A missing or unreadable file is no consent.
  const trainingConsent = async () => {
    const text = input.consentFile ? await readFile(input.consentFile, "utf8").catch(() => undefined) : undefined
    return text !== undefined && Option.isSome(Schema.decodeUnknownOption(Schema.fromJsonString(Consent))(text))
  }
  const setTrainingConsent = async (accepted: boolean) => {
    if (!input.consentFile) return false
    if (!accepted) {
      await rm(input.consentFile, { force: true })
      return false
    }
    const temporary = `${input.consentFile}.${randomUUID()}.tmp`
    await mkdir(path.dirname(input.consentFile), { recursive: true })
    await writeFile(temporary, JSON.stringify({ version: 1, training: true, acceptedAt: now() }), { mode: 0o600 })
    await rename(temporary, input.consentFile)
    return true
  }
  const subscribe = (listener: (catalog: FreeModelCatalog) => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  // Every listener hears the catalog read after the hold, once, even one that did not change: the models built while
  // it held left out the user's own key's. A catalog that changed is told by load() itself.
  input.hold?.onRelease(() => {
    const before = served.value
    void catalog(true).then((value) => {
      if (before && signature(before) !== signature(value)) return
      listeners.forEach((listener) => listener(value))
    })
  })
  return { catalog, forKey, trainingConsent, setTrainingConsent, subscribe }
}

/**
 * The catalog to use when vectordev.ai gives no usable answer. An answer that refuses, such as a 503 while the catalog
 * is not refreshed, is OFF: the shared chat would refuse every prompt too. A network failure keeps the last catalog
 * vectordev.ai served, but only one that listed models.
 */
function unreachable(saved: FreeModelCatalog | undefined, answered: boolean): FreeModelCatalog {
  if (answered || !saved?.enabled || !saved.models.length) return OFF
  return saved
}

export class Service extends Context.Service<
  Service,
  {
    readonly catalog: (force?: boolean) => Effect.Effect<FreeModelCatalog>
    readonly forKey: (key: string, force?: boolean) => Effect.Effect<FreeModelInfo[]>
    /** Whether the user accepted, once, that free models whose providers may train on prompts may receive them. */
    readonly trainingConsent: () => Effect.Effect<boolean>
    readonly setTrainingConsent: (accepted: boolean) => Effect.Effect<boolean>
    /** Each catalog that differs from the one before it in enablement, models or data policy. */
    readonly changes: Stream.Stream<FreeModelCatalog>
  }
>()("@vector/FreeModels") {}

export function fromClient(client: ReturnType<typeof createClient>) {
  return Service.of({
    catalog: (force) => Effect.promise(() => client.catalog(force)),
    forKey: (key, force) => Effect.promise(() => client.forKey(key, force)),
    trainingConsent: () => Effect.promise(() => client.trainingConsent()),
    setTrainingConsent: (accepted) => Effect.promise(() => client.setTrainingConsent(accepted)),
    changes: Stream.callback<FreeModelCatalog>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => client.subscribe((catalog) => Queue.offerUnsafe(queue, catalog))),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    ),
  })
}

/**
 * Where the one-time "may train on your prompts" acceptance lives for this user: a fixed path under the home
 * directory, not Global.Path.state. The desktop engine runs with XDG_STATE_HOME inside the app's own data folder
 * (prepareSidecarEnv in packages/desktop/src/main/sidecar.ts), so a state-directory file would be a different one for
 * the terminal, and "vector models --decline-training" would not stop the desktop app.
 */
export function trainingConsentFile() {
  return path.join(Global.Path.home, ".local", "state", "vector", "free-model-training-consent.json")
}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.sync(Service, () =>
    fromClient(
      createClient({
        // v2: catalogs cached before 1.99.109 carry no data policy, and an OFF cached then must not hide a live catalog.
        file: path.join(Global.Path.cache, "free-models-v2.json"),
        consentFile: trainingConsentFile(),
        disabled: () => Flag.VECTOR_DISABLE_MODELS_FETCH,
        hold: StartupHold,
        local: () => Egress.policy().enabled,
        // Read only with Vector Local off (local, above), so OpenRouter's lists never need a source of their own.
        request: (url, init) => Egress.fetch("free-models-catalog", url, init),
      }),
    ),
  ),
  deps: [],
})

export class CredentialsService extends Context.Service<
  CredentialsService,
  {
    readonly get: (provider: "vector" | "openrouter") => Effect.Effect<string | undefined>
  }
>()("@vector/FreeModelCredentials") {}

export const credentialsNode = makeGlobalNode({
  service: CredentialsService,
  layer: Layer.effect(
    CredentialsService,
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      return CredentialsService.of({
        get: Effect.fn("FreeModels.credential")(function* (provider) {
          const environment = process.env[provider === "vector" ? "VECTOR_CLI_TOKEN" : "OPENROUTER_API_KEY"]
          if (environment) return environment
          const stored = (yield* credentials.list(Integration.ID.make(provider))).find(
            (item) => item.value.type === "key",
          )
          if (stored?.value.type === "key") return stored.value.key
          if (provider === "vector") return yield* Effect.promise(() => VectorAccount.readVectorToken())
          return undefined
        }),
      })
    }),
  ),
  deps: [Credential.node],
})

export async function resolveRoute(input: {
  provider: "vector" | "openrouter"
  modelID: string
  catalog: () => Promise<FreeModelCatalog>
  forKey: (key: string) => Promise<FreeModelInfo[]>
  credential: (provider: "vector" | "openrouter") => Promise<string | undefined>
  trainingConsent: () => Promise<boolean>
  /** Whether an invited guest has worked in the requesting session (FreeModelGuests), whoever sends this request. */
  guest: () => Promise<boolean>
}) {
  // A model configured under another name, or one OpenRouter serves on free endpoints that is not itself a free model
  // ID, is never sent: the free-model checks below judge the model by this ID.
  if (!isFreeModelID(input.modelID)) throw new Error(FREE_MODEL_UNLISTED)
  // The owner's acceptance never carries a guest's input: such a session gets no-training models only.
  const guest = await input.guest()
  const trainingConsent = !guest && (await input.trainingConsent())
  // The selection names the account: a Vector selection always runs on the shared allowance, even with an OpenRouter
  // key stored, and the user's own key serves only the copies listed under OpenRouter.
  const ownKey = input.provider === "openrouter" ? await input.credential("openrouter") : undefined
  if (ownKey) {
    if (ownKey.startsWith("vrt_")) throw new Error("Codium run credentials cannot authorize shared free models.")
    const models = await input.forKey(ownKey)
    if (!models.some((model) => model.id === input.modelID)) {
      // A may-train model listed by the shared catalog but missing from the user's own account is one the account's
      // privacy settings hide, so say which setting to change.
      const shared = await input.catalog()
      const listed = shared.enabled ? shared.models.find((model) => model.id === input.modelID) : undefined
      if (listed && freeModelDataPolicy(listed) !== "no-training") throw new Error(FREE_MODEL_TRAINING_BLOCKED)
      throw new Error(
        "This free model is unavailable for your OpenRouter account or privacy settings. Choose another free model.",
      )
    }
    return {
      url: OPENROUTER_CHAT_URL,
      key: ownKey,
      models,
      source: "openrouter" as const,
      trainingConsent,
      guest,
      headers: {},
    }
  }
  // Every other free request runs on Vector's shared allowance, including an OpenRouter selection made while an
  // OpenRouter account was connected, once that key is gone, when the shared catalog lists the model.
  const catalog = await input.catalog()
  if (!catalog.enabled || !catalog.models.some((model) => model.id === input.modelID))
    throw new Error("That free model is unavailable. Choose another model in Vector.")
  const token = await input.credential("vector")
  if (token?.startsWith("vrt_")) throw new Error("Codium run credentials cannot authorize shared free models.")
  if (!token) throw new Error(FREE_MODELS_SIGN_IN)
  return {
    url: SHARED_CHAT_URL,
    key: token,
    models: catalog.models,
    source: "shared" as const,
    trainingConsent,
    guest,
    // The shared allowance serves a may-train model only to a client that discloses it, after the user accepted.
    headers: {
      [FREE_MODELS_DISCLOSURE_HEADER]: FREE_MODELS_DISCLOSURE,
      ...(trainingConsent ? { [FREE_MODELS_CONSENT_HEADER]: FREE_MODELS_CONSENT_ACCEPTED } : {}),
    },
  }
}

/**
 * OpenRouter answers 404 "No endpoints found matching your data policy" when no endpoint a request may use passes
 * both the user's own privacy settings and the request's data_collection. Replace that with what to do, keeping the
 * status. A may-train model, one Vector has not reviewed included, was sent "allow", so the user's settings are the
 * cause. A no-training model keeps OpenRouter's own answer.
 */
export async function explainPolicyRefusal(response: Response, policy: FreeDataPolicy) {
  if (response.status !== 404 || policy === "no-training") return response
  const text = await response
    .clone()
    .text()
    .catch(() => "")
  if (!/data policy|privacy|training/i.test(text)) return response
  return Response.json({ error: { message: FREE_MODEL_TRAINING_BLOCKED, code: 404 } }, { status: 404 })
}

/** Preserve quota metadata before compatible SDKs reduce an SSE error to its message string. */
export function preserveLimit(response: Response) {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
    return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const state = { pending: "" }
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const emit = (frame: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    const limit = parseFreeModelLimit(data)
    if (limit) throw new FreeModelsLimitError({ reason: limit.reason, resetAt: limit.resetAt, message: limit.message })
    controller.enqueue(encoder.encode(frame))
  }
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          state.pending += decoder.decode(chunk, { stream: true })
          if (state.pending.length > 4_500_000) throw new Error("The free model returned an oversized stream event.")
          const frames = state.pending.split(/(\r?\n\r?\n)/)
          state.pending = frames.pop() ?? ""
          for (let index = 0; index < frames.length; index += 2) emit(frames[index] + frames[index + 1], controller)
        },
        flush(controller) {
          state.pending += decoder.decode()
          if (state.pending) emit(state.pending, controller)
        },
      }),
    ),
    { status: response.status, statusText: response.statusText, headers },
  )
}
