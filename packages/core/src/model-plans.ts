export * as ModelPlans from "./model-plans"

import path from "node:path"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { Egress } from "./local-mode/egress"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { ModelPlanStatus } from "./model-plan-status"
import { StartupHold } from "./startup-hold"

export const PROVIDER_ID = ModelPlanStatus.PROVIDER_ID
export const PROVIDER_NAME = "Vector Codium"
export const API_URL = ModelPlanStatus.API_URL
export const CATALOG_URL = `${API_URL}/models`
export const CHAT_URL = `${API_URL}/chat`
export const PURCHASE_URL = ModelPlanStatus.PURCHASE_URL
export const AUTO_ID = ModelPlanStatus.AUTO_ID
export const clientHeaders = ModelPlanStatus.clientHeaders
export const gatewayFailure = ModelPlanStatus.gatewayFailure
export type Failure = ModelPlanStatus.Failure

// Codium's catalog, status and offers come from vectordev.ai, labelled so Vector Local decides them (blocked unless
// allowed). Node callers hand it to ModelPlanStatus's requests, which the app also runs in the browser with its own fetch.
export const plansCatalog = (url: string, init: RequestInit) => Egress.fetch("plans-catalog", url, init)

// No prices: a Codium step spends the plan's usage, which Vector shows as a share and never in dollars.
const Base = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contextLength: Schema.Number,
  maxOutputTokens: Schema.Number,
})
export const LABS = ["deepseek", "anthropic", "openai", "moonshot", "google"] as const
const Locked = Schema.Struct({
  plan: Schema.String,
  name: Schema.String,
  previewUntil: Schema.optional(Schema.Number.check(Schema.isInt())),
})
const Roles = Schema.Struct({ floor: Schema.String, default: Schema.String, ceiling: Schema.String })
/**
 * One `/models` entry (§4.12). The four fields older Vector releases decode are checked strictly; the rest is read
 * leniently, so an unknown lab or role drops only that field.
 */
export type Model = typeof Base.Type & {
  lab?: (typeof LABS)[number]
  /** A public price ratio (DeepSeek = 1). */
  weight?: number
  role?: "floor" | "default" | "ceiling"
  /** Chosen only by name: never an Auto role, helper, default judge, swarm or routing target. */
  manualOnly?: true
  /** The account's plan cannot use it yet; `plan` is the cheapest plan that can. */
  locked?: typeof Locked.Type
  preview?: { until: number }
  /** Only on Codium Auto (AUTO_ID): the models it picks from. */
  auto?: typeof Roles.Type
}
/**
 * enabled: vectordev.ai offers Codium to this signed-in account. Each chat request checks the plan itself. `plan` is
 * null without a plan (Plus's locks and limits then apply) and missing from an older gateway.
 */
export type Catalog = {
  enabled: boolean
  models: readonly Model[]
  plan?: string | null
  limits?: { inFlight: number }
  /** Second-opinion judge for each worker model, from another lab. */
  judges?: Readonly<Record<string, string>>
  review?: { triage?: string; confirm?: string; panelJudge?: string }
}
const Stored = Schema.Struct({ enabled: Schema.Boolean, models: Schema.Array(Base) })
const OFF: Catalog = { enabled: false, models: [] }
// The last answer, kept on disk for the account it belongs to, so a fresh engine has a catalog before vectordev.ai
// answers. The digest identifies the account without storing its token.
const Saved = Schema.Struct({ account: Schema.String, catalog: Schema.Unknown })
const TTL = 60_000
// A refresh that got no answer is tried again sooner than an answered one.
const RETRY = 10_000
const MAX_ACCOUNTS = 32

export type CatalogOptions = {
  /**
   * Read vectordev.ai now and wait for its answer: a read that starts after something that can change the account's
   * models (a sign-in, a purchase), never one already under way. Until it answers, every read waits on it.
   */
  force?: boolean
  /** A chat request: wait for vectordev.ai when this account has no catalog yet, instead of answering OFF. */
  wait?: boolean
}

type Entry = {
  digest: string
  value?: Catalog
  expires: number
  pending?: Promise<Catalog>
  /** How many reads of this account have started; only the newest one's answer is kept. */
  reads: number
  restored: Promise<void>
}

export function createClient(
  input: {
    file?: string
    request?: (url: string, init: RequestInit) => Promise<Response>
    now?: () => number
    disabled?: () => boolean
    timeout?: number
  } = {},
) {
  const request = input.request ?? fetch
  const now = input.now ?? Date.now
  const accounts = new Map<string, Entry>()
  const account = (token: string) => {
    // Keyed by digest so the account token is never kept as a map key.
    const digest = createHash("sha256").update(token).digest("hex")
    const current = accounts.get(digest) ?? restore(digest)
    accounts.delete(digest)
    if (accounts.size >= MAX_ACCOUNTS) accounts.delete(accounts.keys().next().value!)
    accounts.set(digest, current)
    return current
  }
  // A restored catalog is stale from the start: it is served only until vectordev.ai answers.
  const restore = (digest: string): Entry => {
    const current: Entry = { digest, expires: 0, reads: 0, restored: Promise.resolve() }
    if (!input.file) return current
    current.restored = readFile(input.file, "utf8")
      .then((text) => Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Saved))(text)))
      .then((saved) => {
        if (saved?.account === digest) current.value ??= parse(saved.catalog)
      })
      .catch(() => undefined)
    return current
  }
  const save = async (file: string, saved: typeof Saved.Type) => {
    const temporary = `${file}.${randomUUID()}.tmp`
    // This optional cache must never fail or slow a catalog read.
    await mkdir(path.dirname(file), { recursive: true })
      .then(() => writeFile(temporary, JSON.stringify(saved), { mode: 0o600 }))
      .then(() => rename(temporary, file))
      .catch(() => rm(temporary, { force: true }).catch(() => undefined))
  }
  const load = (token: string, current: Entry) => {
    const read = ++current.reads
    const pending: Promise<Catalog> = request(CATALOG_URL, {
      headers: { ...clientHeaders(), Authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (response) =>
        response.status === 401 || response.status === 403
          ? OFF
          : response.ok
            ? parse(await response.json().catch(() => undefined))
            : undefined,
      )
      .catch(() => undefined)
      .then(async (answer) => {
        // A read that started before a newer one (a forced read after a purchase) may carry the models from before it,
        // so it never replaces the catalog: it settles with the newer read instead.
        if (read !== current.reads) return current.pending ?? current.value ?? OFF
        // Only an answer replaces the catalog: a refused token, enabled:false or a valid list. A slow, failed or
        // garbled refresh keeps serving the last catalog this account received, so a paid turn never fails on it.
        current.pending = undefined
        current.expires = now() + (answer ? TTL : RETRY)
        if (answer) current.value = answer
        if (answer && input.file) await save(input.file, { account: current.digest, catalog: answer })
        return current.value ?? OFF
      })
    return pending
  }
  const catalog = async (token: string | undefined, options: CatalogOptions = {}): Promise<Catalog> => {
    if (!token || input.disabled?.()) return OFF
    const current = account(token)
    await current.restored
    if (options.force) {
      // The kept catalog stops counting as fresh, so a plain read meanwhile joins this one as it would a lapsed entry.
      current.expires = 0
      current.pending = load(token, current)
      return current.pending
    }
    if (current.value && current.expires > now()) return current.value
    current.pending ??= load(token, current)
    if (options.wait && !current.value) return current.pending
    // Provider listing never waits long on vectordev.ai: it answers with the last catalog seen, here or on disk, or
    // OFF on a first read, and the refresh lands for the next caller.
    const fallback = Promise.withResolvers<Catalog>()
    // This deadline settles an awaited operation; keep it alive until the race finishes.
    const timer = setTimeout(() => fallback.resolve(current.value ?? OFF), input.timeout ?? 1_500)
    return Promise.race([current.pending, fallback.promise]).finally(() => clearTimeout(timer))
  }
  return { catalog }
}

// undefined: no usable answer. OFF: vectordev.ai says Codium is not offered to this account.
function parse(body: unknown): Catalog | undefined {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Stored)(body))
  if (!parsed) return undefined
  if (!parsed.enabled || !parsed.models.length) return OFF
  if (
    parsed.models.length > 100 ||
    parsed.models.some(
      (model) =>
        !model.id.trim() ||
        model.id.length > 256 ||
        /\s/.test(model.id) ||
        !model.name.trim() ||
        !Number.isSafeInteger(model.contextLength) ||
        model.contextLength < 1 ||
        !Number.isSafeInteger(model.maxOutputTokens) ||
        model.maxOutputTokens < 1 ||
        model.maxOutputTokens > model.contextLength,
    ) ||
    new Set(parsed.models.map((model) => model.id)).size !== parsed.models.length
  )
    return undefined
  const record = body as { models: unknown[] } & Record<string, unknown>
  const entries = parsed.models.map((model, index) => ({ ...model, ...extras(record.models[index]) }))
  // Auto stays listed only when it names three listed models a person can use; otherwise it is left out.
  const usable = (id: unknown) => entries.some((model) => model.id === id && usableModel(model))
  const models = entries.flatMap((model): Model[] => {
    if (model.id !== AUTO_ID) return [{ ...model, auto: undefined }]
    if (!model.auto || !usable(model.auto.floor) || !usable(model.auto.default) || !usable(model.auto.ceiling))
      return []
    return [{ ...model, locked: undefined, manualOnly: undefined }]
  })
  const listed = (id: unknown): id is string => typeof id === "string" && models.some((model) => model.id === id)
  const limits = Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.Struct({ inFlight: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)) }),
    )(record.limits),
  )
  const judges = object(record.judges)
  const review = object(record.review)
  return {
    enabled: true,
    models: models.map(defined),
    ...(record.plan === null || typeof record.plan === "string" ? { plan: record.plan } : {}),
    ...(limits ? { limits } : {}),
    ...(judges
      ? {
          judges: Object.fromEntries(
            Object.entries(judges).filter(([worker, judge]) => listed(worker) && listed(judge)),
          ) as Record<string, string>,
        }
      : {}),
    ...(review
      ? {
          review: Object.fromEntries(
            (["triage", "confirm", "panelJudge"] as const).flatMap((key) =>
              listed(review[key]) ? [[key, review[key]]] : [],
            ),
          ),
        }
      : {}),
  }
}

/**
 * What a picker shows of a catalog entry (ModelV2.Codium): its lab, role, locks and Auto's models, never its weight. Only
 * the fields that are set: an unset one is left out, not kept as undefined.
 */
export function listing(
  model: Model,
): Partial<Pick<Model, "lab" | "role" | "manualOnly" | "locked" | "preview" | "auto">> {
  return defined({
    lab: model.lab,
    role: model.role,
    manualOnly: model.manualOnly,
    locked: model.locked,
    preview: model.preview,
    auto: model.auto,
  })
}

/** A model a person can use on the current plan without naming it: listed, not locked and not manual-only. */
export function usableModel(model: Model) {
  return model.id !== AUTO_ID && !model.locked && !model.manualOnly
}

// The fields added for current clients, each read on its own: an unknown or malformed value is dropped.
function extras(value: unknown): Omit<Model, keyof typeof Base.Type> {
  const record = object(value)
  if (!record) return {}
  const field = <S extends Schema.Decoder<unknown>>(schema: S, item: unknown) =>
    Option.getOrUndefined(Schema.decodeUnknownOption(schema)(item)) as S["Type"] | undefined
  const until = field(Schema.Struct({ until: Schema.Number.check(Schema.isInt()) }), record.preview)
  return {
    lab: LABS.find((lab) => lab === record.lab),
    weight:
      typeof record.weight === "number" && Number.isFinite(record.weight) && record.weight > 0
        ? record.weight
        : undefined,
    role: (["floor", "default", "ceiling"] as const).find((role) => role === record.role),
    manualOnly: record.manualOnly === true ? true : undefined,
    locked: field(Locked, record.locked),
    preview: until,
    auto: field(Roles, record.auto),
  }
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

export class Service extends Context.Service<
  Service,
  {
    readonly catalog: (token: string | undefined, options?: CatalogOptions) => Effect.Effect<Catalog>
    /** The HTTP transport to the Codium gateway; createFetch fixes its destination and credential. */
    readonly request: (url: string, init: RequestInit) => Promise<Response>
  }
>()("@vector/ModelPlans") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.sync(Service, () => {
    const client = createClient({
      file: path.join(Global.Path.cache, "codium-models.json"),
      // Vector Local keeps Vector Codium off, so its plans are not read either. A desktop first run's hold
      // (StartupHold) keeps them back until the person has chosen how to run models; nothing is kept while it holds,
      // so the next read after it reaches vectordev.ai.
      disabled: () => Flag.VECTOR_DISABLE_MODELS_FETCH || Egress.policy().enabled || StartupHold.held(),
      request: plansCatalog,
    })
    return Service.of({
      catalog: (token, options) => Effect.promise(() => client.catalog(token, options)),
      // A Codium model call is decided as one: refused while Vector Local is on.
      request: (url, init) => Egress.fetch("vector-codium", url, init),
    })
  }),
  deps: [],
})

/** How long writing the account credential waits for that account's catalog; a slower answer still lands. */
export const CREDENTIAL_READ = Duration.seconds(2)

/**
 * After the account credential is written (a sign-in, an account switch, or the desktop's reads after a purchase):
 * reads that account's catalog from vectordev.ai now, so the next model list names what its plan includes instead of
 * the catalog kept for up to a minute. It waits at most CREDENTIAL_READ; a slower answer still replaces the kept
 * catalog when it lands, since the read is the client's and not this wait's. Vector Local, a desktop first run's hold
 * and VECTOR_DISABLE_MODELS_FETCH keep it off vectordev.ai, as they do every catalog read.
 */
export const credentialWritten = Effect.fn("ModelPlans.credentialWritten")(function* (token: string | undefined) {
  const plans = yield* Service
  yield* plans.catalog(token, { force: true }).pipe(Effect.timeout(CREDENTIAL_READ), Effect.ignore)
})

/**
 * The account token and catalog model for one chat request. When the request cannot be sent, it returns the answer
 * the gateway would give instead, so every caller reports a pre-request failure exactly like a gateway answer.
 */
export async function resolveRoute(input: {
  modelID: string
  credential: () => Promise<string | undefined>
  /** The chat path's catalog: the account's last known one, or vectordev.ai's answer awaited in full. */
  catalog: (token: string) => Promise<Catalog>
  /**
   * "default": a Codium Auto request goes to Auto's default model (Core V2, which has no per-message choice yet).
   * Without it Auto is refused: an engine session resolves Auto for each user message before any request.
   */
  auto?: "default"
}) {
  // Codium Auto is a listing entry, and the gateway serves no model by that name.
  if (input.modelID === AUTO_ID && input.auto !== "default") return { refused: localAnswer(400, "CODIUM_AUTO") }
  const token = await input.credential()
  if (!token) return { refused: localAnswer(401, "SIGN_IN_REQUIRED") }
  const catalog = await input.catalog(token)
  if (!catalog.enabled) return { refused: localAnswer(503, "CODIUM_UNAVAILABLE") }
  // A catalog keeps Auto only while its three models are usable (parse), so its default can be sent as it is.
  const id =
    input.modelID === AUTO_ID ? catalog.models.find((model) => model.id === AUTO_ID)?.auto?.default : input.modelID
  const model = catalog.models.find((model) => model.id === id && model.id !== AUTO_ID)
  if (!model) return { refused: localAnswer(400, input.modelID === AUTO_ID ? "CODIUM_AUTO" : "MODEL_PLAN_MODEL") }
  // A missing plan or balance is left to the gateway: a purchase made a moment ago must work at once.
  return { token, model }
}

function localAnswer(status: number, code: string) {
  return {
    status,
    body: JSON.stringify({ error: { code, message: "Vector did not send this request." } }),
  }
}

// Discard SDK/project routing and billing overrides at the last client boundary. The server also validates the body.
export function serializeRequest(body: unknown, model: Model) {
  const record = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(body)
  if (Option.isNone(record) || !Array.isArray(record.value.messages) || !record.value.messages.length)
    throw new Error("Include conversation messages in the model request.")
  const requested =
    record.value.max_tokens ?? record.value.max_completion_tokens ?? Math.min(8192, model.maxOutputTokens)
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1)
    throw new Error("The requested response length is invalid.")
  const text = JSON.stringify({
    ...Object.fromEntries(
      Object.entries(record.value).filter(([key]) =>
        [
          "messages",
          "temperature",
          "top_p",
          "stop",
          "seed",
          "tools",
          "tool_choice",
          "parallel_tool_calls",
          "frequency_penalty",
          "presence_penalty",
          "reasoning",
          "response_format",
        ].includes(key),
      ),
    ),
    model: model.id,
    max_tokens: Math.min(requested, model.maxOutputTokens),
    stream: true,
    stream_options: { include_usage: true },
  })
  if (new TextEncoder().encode(text).byteLength > 4_500_000)
    throw new Error("Context too large for Vector Codium. Compact this conversation before continuing.")
  return text
}

export function createFetch(input: {
  modelID: string
  credential: () => Promise<string | undefined>
  catalog: (token: string) => Promise<Catalog>
  request?: (url: string, init: RequestInit) => Promise<Response>
}) {
  return Object.assign(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const route = await resolveRoute(input)
      // Nothing is sent; the SDK reads this answer as the gateway's, so the turn gets the same message and action. It
      // passes the same boundary as a gateway answer, so a final one (Codium switched off) is never retried.
      if (route.refused)
        return finalAnswer(
          new Response(route.refused.body, {
            status: route.refused.status,
            headers: { "content-type": "application/json" },
          }),
        )
      const body =
        typeof init?.body === "string"
          ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(init.body))
          : undefined
      // Destination, headers and credential are fixed here; SDK or project headers never reach the gateway. Only the
      // request's purpose passes, and only as one of the known purposes.
      const response = await (input.request ?? fetch)(CHAT_URL, {
        method: "POST",
        redirect: "error",
        signal: init?.signal,
        headers: {
          ...clientHeaders(),
          "X-Vector-Purpose": ModelPlanStatus.purpose(new Headers(init?.headers).get("x-vector-purpose")),
          "Content-Type": "application/json",
          Authorization: `Bearer ${route.token}`,
        },
        body: serializeRequest(body, route.model),
      })
      return finalAnswer(response)
    },
    { preconnect: fetch.preconnect },
  )
}

/**
 * The AI SDK retries 408, 409, 429 and 5xx answers on its own before the session sees them. A final Codium answer
 * (§4.10) must fail the call at once, so it arrives as a client error; its code still says what it was.
 */
export async function finalAnswer(response: Response) {
  if (![408, 409, 429].includes(response.status) && response.status < 500) return response
  const body = await response.clone().text()
  const answer = gatewayFailure(response.status, body)
  if (!answer || answer.retry) return response
  return new Response(body, { status: 400, statusText: "Bad Request", headers: response.headers })
}

const GatewayCode = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })

export function contextFailure(body: string | undefined) {
  if (!body) return false
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(GatewayCode))(body)
  return Option.isSome(parsed) && parsed.value.error.code === "MODEL_PLAN_CONTEXT"
}
