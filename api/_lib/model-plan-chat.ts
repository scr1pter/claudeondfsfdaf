import { createHash, randomInt } from "node:crypto"
import { once } from "node:events"
import { Option, Schema } from "effect"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"
import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { requireModelPlanCaller, requireModelPlanClient, type ModelPlanCaller } from "./model-plan-caller.js"
import { readModelPlanAccount, snapshotPoolCredential } from "./model-plan-account.js"
import { admitModelPlan, settleModelPlanDurably, type AdmissionTicket } from "./model-plan-admit.js"
import { gatewayPlanModels, verifiedGatewayModel, type ModelPlanCatalogOptions } from "./model-plan-catalog-policy.js"
import { beforeAdmit, afterSettle, type GatewayHookOptions } from "./model-plan-gateway-hooks.js"
import { requireEntitlement, requireUsableSnapshot, reconcileOnDemand } from "./codium-entitlements.js"
import { readDisabledSet } from "./codium-switches.js"
import { CODIUM_TIER_MODELS } from "./codium-catalog.js"
import { usdToMicroCeil } from "./codium-pool.js"
import { modelSpendStale } from "./codium-spend-ledger.js"
import {
  effectiveModel,
  modelAccess,
  modelPlanAttempts,
  MODEL_PLAN_OPTIONS,
  MODEL_PLAN_ROOT,
  modelPlanReservation,
  requireModelPlans,
  type ModelPlanModel,
} from "./model-plan-config.js"
import { stripeRecord } from "./model-plan-stripe.js"
import { ApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import { requireUnrevokedCliToken } from "./revocation.js"

const MAX_BYTES = 4_500_000
export async function requireModelPlanUser(request: ApiRequest, fetcher: typeof fetch = fetch, now = Date.now()) {
  const token = /^Bearer (vct_[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/.exec(String(request.headers.authorization ?? ""))?.[1]
  const account = await requireUnrevokedCliToken(token ?? "", fetcher, now)
  return { id: account.id, email: account.email }
}

export function modelPlanRequest(body: unknown, models: readonly ModelPlanModel[]) {
  if (!stripeRecord(body) || !Array.isArray(body.messages) || !body.messages.length)
    throw new ApiError(400, "MODEL_PLAN_REQUEST", "Include conversation messages and an available model.")
  const model = models.find((model) => model.id === body.model)
  if (!model) throw new ApiError(400, "MODEL_PLAN_MODEL", "Choose a model available in Vector Codium.")
  if (
    body.plugins !== undefined ||
    body.preset !== undefined ||
    body.modalities !== undefined ||
    body.models !== undefined
  )
    throw new ApiError(400, "MODEL_PLAN_ADDONS", "Vector Codium supports text and local tools without paid add-ons.")
  const messages = body.messages.map((message) => {
    if (!stripeRecord(message) || !["system", "developer", "user", "assistant", "tool"].includes(String(message.role)))
      throw new ApiError(400, "MODEL_PLAN_MESSAGE", "A conversation message is invalid.")
    if (
      message.content !== undefined &&
      message.content !== null &&
      typeof message.content !== "string" &&
      (!Array.isArray(message.content) ||
        message.content.some((part) => !stripeRecord(part) || part.type !== "text" || typeof part.text !== "string"))
    )
      throw new ApiError(400, "MODEL_PLAN_ATTACHMENT", "Vector Codium accepts text and local tool messages.")
    if (
      message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) ||
        message.tool_calls.some(
          (call) => !stripeRecord(call) || call.type !== "function" || !stripeRecord(call.function),
        ))
    )
      throw new ApiError(400, "MODEL_PLAN_TOOL", "A tool message is invalid.")
    // Vector's clients send earlier reasoning as reasoning_content, OpenRouter's alias for reasoning. Thinking models
    // such as DeepSeek refuse a tool-call turn whose reasoning is missing, and signed reasoning stays in its details.
    const reasoning = message.reasoning ?? message.reasoning_content
    if (
      (reasoning !== undefined && reasoning !== null && typeof reasoning !== "string") ||
      (message.reasoning_details !== undefined &&
        (!Array.isArray(message.reasoning_details) || !message.reasoning_details.every(stripeRecord)))
    )
      throw new ApiError(400, "MODEL_PLAN_MESSAGE", "A conversation message is invalid.")
    return {
      ...Object.fromEntries(
        Object.entries(message).filter(([key]) =>
          ["role", "content", "name", "tool_calls", "tool_call_id"].includes(key),
        ),
      ),
      // Only an assistant's own turn carries reasoning.
      ...(message.role === "assistant" && typeof reasoning === "string" ? { reasoning } : {}),
      ...(message.role === "assistant" && message.reasoning_details !== undefined
        ? { reasoning_details: message.reasoning_details }
        : {}),
      // A text part keeps only its text, so a client cannot add cache markers or other per-part options.
      ...(Array.isArray(message.content)
        ? { content: message.content.map((part) => ({ type: "text", text: String(part.text) })) }
        : {}),
    }
  })
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some(
        (tool) =>
          !stripeRecord(tool) ||
          tool.type !== "function" ||
          !stripeRecord(tool.function) ||
          typeof tool.function.name !== "string",
      ))
  )
    throw new ApiError(400, "MODEL_PLAN_TOOL", "Only local function tools are supported.")
  const maximum = body.max_tokens ?? body.max_completion_tokens ?? Math.min(8192, model.maxOutputTokens)
  if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1)
    throw new ApiError(400, "MODEL_PLAN_OUTPUT", "The requested response length is invalid.")
  // With require_parameters, OpenRouter routes only to endpoints that accept every option sent, so a model whose
  // endpoints refuse some options keeps only the ones they accept.
  const options = model.options ?? MODEL_PLAN_OPTIONS
  return {
    ...Object.fromEntries(Object.entries(body).filter(([key]) => options.some((option) => option === key))),
    // A tool keeps only its definition, so a client cannot add cache markers or other per-tool options.
    ...(Array.isArray(body.tools) && options.some((option) => option === "tools")
      ? {
          tools: body.tools.flatMap((tool) =>
            stripeRecord(tool) && stripeRecord(tool.function)
              ? [
                  {
                    type: "function",
                    function: {
                      name: String(tool.function.name),
                      ...(typeof tool.function.description === "string"
                        ? { description: tool.function.description }
                        : {}),
                      ...(stripeRecord(tool.function.parameters) ? { parameters: tool.function.parameters } : {}),
                      ...(typeof tool.function.strict === "boolean" ? { strict: tool.function.strict } : {}),
                    },
                  },
                ]
              : [],
          ),
        }
      : {}),
    model: model.upstream ?? model.id,
    messages: model.explicitCache ? cacheBreakpoints(messages, model.cacheStyle) : messages,
    ...(model.explicitCache && model.cacheStyle === "openai"
      ? { prompt_cache_options: { mode: "explicit", ttl: "30m" } }
      : {}),
    // Some endpoints refuse forced tools with reasoning, or cannot select one named tool. Normalize only those
    // unsupported choices; models that accept them retain the client's choice.
    ...((model.autoToolChoice === "forced" && body.tool_choice === "required") ||
    (model.autoToolChoice && stripeRecord(body.tool_choice))
      ? { tool_choice: "auto" }
      : {}),
    // Catalog policy owns effort; client overrides cannot silently increase spend or change reviewed quality.
    reasoning: model.reasoningEffort ? { effort: model.reasoningEffort } : undefined,
    ...(model.outputTokenParameter === "max_completion_tokens"
      ? { max_completion_tokens: Math.min(maximum, model.maxOutputTokens) }
      : { max_tokens: Math.min(maximum, model.maxOutputTokens) }),
    stream: true,
    stream_options: { include_usage: true },
    plugins: ["web", "file-parser", "response-healing", "context-compression", "auto-router", "pareto-router"].map(
      (id) => ({ id, enabled: false }),
    ),
    provider: {
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
      ...(model.providerOnly ? { only: [...model.providerOnly], allow_fallbacks: false } : {}),
      ...(model.quantizations ? { quantizations: model.quantizations } : {}),
      // Media and native add-ons are rejected above. An image-price filter would also remove Gemini's text route.
      max_price: { prompt: model.inputPrice, completion: model.outputPrice, request: 0 },
    },
  }
}

/**
 * Explicit breakpoints (five minutes for cache_control, 30 minutes for OpenAI): the end of the system prompt, which tools
 * and instructions share across a session, the latest user message, and the end of the conversation, which moves
 * with every tool result. When the system prompt comes as several messages, Vector's stable block of tools and
 * instructions first, the end of that first message is marked too, so a new session reads it from the cache. Four
 * is the most a request may mark, and the gateway drops every client marker, including any on tools.
 */
function cacheBreakpoints(messages: Record<string, unknown>[], style?: "openai") {
  const text = (message: Record<string, unknown>) =>
    typeof message.content === "string"
      ? message.content.length > 0
      : Array.isArray(message.content) && message.content.some((part) => part.text.length > 0)
  const leading = messages.findIndex((message) => message.role !== "system" && message.role !== "developer")
  const system = leading === -1 ? messages.length : leading
  const marked = [
    ...(system > 1 ? [0] : []),
    system - 1,
    messages.findLastIndex((message) => message.role === "user" && text(message)),
    messages.findLastIndex(text),
  ].filter((index) => index >= 0 && text(messages[index]!))
  return messages.map((message, index) => {
    if (!marked.includes(index)) return message
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content) }]
    const last = content.findLastIndex((part) => part.text.length > 0)
    return {
      ...message,
      content: content.map((part, partIndex) =>
        partIndex === last
          ? {
              ...part,
              ...(style === "openai"
                ? { prompt_cache_breakpoint: { mode: "explicit" } }
                : { cache_control: { type: "ephemeral" } }),
            }
          : part,
      ),
    }
  })
}

/**
 * Rejects a request the model's context window cannot hold and returns its estimated input tokens. The credit check
 * does not use them: it holds the model's largest request (modelPlanRequestCredits), so a refusal never depends on the
 * request's size. The gateway has no tokenizer, so it estimates tokens as Vector's clients do, at four bytes of
 * content per token. A JSON escape stands for one character the model reads, so only the bytes it adds are left out:
 * one for \n, \" or \\, five for \u0001. Counting each byte as a token rejected conversations at about a quarter of
 * the window the catalog lists.
 */
export function requireModelPlanContext<T extends { max_tokens?: number; max_completion_tokens?: number }>(
  body: T,
  model: ModelPlanModel,
) {
  const text = JSON.stringify(body)
  const bytes = Buffer.byteLength(text)
  const escapes = (text.match(/\\(?:u[0-9a-fA-F]{4}|.)/g) ?? []).reduce((total, escape) => total + escape.length - 1, 0)
  const inputTokens = Math.ceil((bytes - escapes) / 4)
  const output = body.max_tokens ?? body.max_completion_tokens
  if (output === undefined || inputTokens + output > model.contextLength) throw contextError()
  if (model.promptTokenLimit !== undefined && promptBound(text, bytes, escapes) >= model.promptTokenLimit)
    throw contextError()
  return inputTokens
}

/**
 * A conservative count of a prompt's tokens for a model priced by prompt length, without the provider's tokenizer.
 * ASCII counts one token per two characters: code, prose, JSON and tool output average more than that, though text
 * as dense as long random hashes could not. Any other character counts one token per UTF-8 byte, the most a
 * byte-level tokenizer can produce, and a fixed allowance covers the framing a provider adds around messages and tools.
 */
function promptBound(text: string, bytes: number, escapes: number) {
  const ascii = text.length - (text.match(/[^\x00-\x7f]/g)?.length ?? 0)
  return Math.ceil((ascii - escapes) / 2) + bytes - ascii + 2_000
}

/**
 * Streams the provider's answer to Vector. Once the answer finishes it returns what the provider said it charged; when
 * Vector goes away first it returns nothing, since the provider may still be producing, and billing, the answer.
 * `signal` is the request's deadline: a client that stops reading but keeps its connection open would otherwise hold
 * the wait for `drain` until the platform kills the function, and a killed function settles nothing.
 */
export async function streamModelPlanResponse(
  upstream: Response,
  response: ApiResponse,
  onByte?: () => void,
  signal?: AbortSignal,
) {
  if (upstream.status === 402 || upstream.status === 429) {
    const retry = upstream.headers.get("retry-after")
    if (retry && /^\d+$/.test(retry) && Number(retry) > 0)
      response.setHeader("retry-after", String(Math.min(Number(retry), 300)))
  }
  if (upstream.status === 402)
    throw new ApiError(
      402,
      "MODEL_PLAN_CAPACITY",
      "Your Codium credits or provider capacity are currently unavailable. Check your balance or retry later.",
    )
  if (upstream.status === 429)
    throw new ApiError(429, "MODEL_PLAN_BUSY", "This model is busy. Retry shortly or choose another included model.")
  // The four-bytes-per-token estimate can undercount a provider's tokenizer. When the provider refuses the context,
  // answer as the gateway's own check does, so Vector compacts the conversation instead of retrying a request that
  // can never fit. The provider's wording is only matched, never passed on.
  if (upstream.status === 413 || (upstream.status === 400 && contextRefused(await upstream.text().catch(() => ""))))
    throw contextError()
  if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream"))
    throw new ApiError(503, "MODEL_PLAN_UPSTREAM", "This model is temporarily unavailable.")
  response.statusCode = 200
  response.setHeader("content-type", "text/event-stream; charset=utf-8")
  response.setHeader("cache-control", "no-store, no-transform")
  response.setHeader("x-accel-buffering", "no")
  response.flushHeaders()
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const controller = new AbortController()
  const cancel = () => {
    controller.abort()
    void reader.cancel().catch(() => undefined)
  }
  const state = { pending: "", charge: undefined as number | undefined }
  response.once("close", cancel)
  try {
    while (!response.destroyed) {
      const part = await reader.read()
      if (part.value?.byteLength) onByte?.()
      state.pending += decoder.decode(part.value, { stream: !part.done })
      if (state.pending.length > 1_000_000)
        throw new ApiError(503, "MODEL_PLAN_STREAM", "The model returned an invalid response stream.")
      const frames = state.pending.split(/\r?\n\r?\n/)
      state.pending = frames.pop() ?? ""
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data === "[DONE]") {
          response.end("data: [DONE]\n\n")
          return { charge: state.charge }
        }
        if (!data) continue
        const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(data)
        if (Option.isNone(parsed) || !stripeRecord(parsed.value))
          throw new ApiError(503, "MODEL_PLAN_STREAM", "The model returned an invalid response stream.")
        if (parsed.value.error)
          throw new ApiError(
            503,
            "MODEL_PLAN_STREAM",
            "The model stopped responding. Your account shows any usage charged by the provider.",
          )
        const cost = stripeRecord(parsed.value.usage) ? parsed.value.usage.cost : undefined
        if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) state.charge = cost
        if (!response.write(`data: ${JSON.stringify(forwardedChunk(parsed.value))}\n\n`))
          await once(response, "drain", {
            signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
          })
      }
      if (part.done) throw new ApiError(503, "MODEL_PLAN_STREAM", "The model response ended before completion.")
    }
    return undefined
  } finally {
    response.off("close", cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

// The provider reports each request's charge in USD, which is exactly what comes off the credits. Beside the share of
// a plan it used, that amount would reveal the plan's allowance, so it stays on the server and Vector counts Codium
// steps by their tokens. The provider that served the request, its fingerprint and its own finish reason stay too:
// with them a client could look up that provider's published price and work the charge out from the tokens.
function forwardedChunk(chunk: Record<string, unknown>) {
  return {
    ...Object.fromEntries(
      Object.entries(chunk).filter(([key]) => ["id", "object", "created", "model", "choices"].includes(key)),
    ),
    ...(Array.isArray(chunk.choices)
      ? {
          choices: chunk.choices.map((choice) =>
            stripeRecord(choice)
              ? Object.fromEntries(Object.entries(choice).filter(([key]) => key !== "native_finish_reason"))
              : choice,
          ),
        }
      : {}),
    ...(stripeRecord(chunk.usage)
      ? {
          usage: Object.fromEntries(
            Object.entries(chunk.usage).filter(([key]) => !["cost", "cost_details", "is_byok"].includes(key)),
          ),
        }
      : {}),
  }
}

function contextError() {
  return new ApiError(
    400,
    "MODEL_PLAN_CONTEXT",
    "This request may exceed the model context limit. Shorten the conversation or requested response.",
  )
}

// How OpenAI-compatible providers word a context-window refusal.
function contextRefused(body: string) {
  return /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long/i.test(body.slice(0, 8_192))
}

/** Explicit trusted dependencies for local fakes; production uses the captured active catalog and qualification. */
export type ModelPlanGatewayOptions = GatewayHookOptions & ModelPlanCatalogOptions

export async function handleModelPlanChat(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  options: ModelPlanGatewayOptions = {},
) {
  const controller = new AbortController()
  const close = () => controller.abort()
  const startedAt = Date.now()
  const state = {
    caller: undefined as ModelPlanCaller | undefined,
    snapshot: undefined as EntitlementSnapshot | undefined,
    model: undefined as ModelPlanModel | undefined,
    ticket: undefined as AdmissionTicket | undefined,
    streamed: false,
    dispatched: false,
    dispatchedAttempts: 0,
    attemptMicro: 0,
    uncertainAttempts: 0,
    finished: undefined as { charge?: number } | undefined,
  }
  response.once("close", close)
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, MAX_BYTES)
    requireModelPlans()
    // A misconfigured gateway refuses at the enabled gate, before any credential, provider or store call.
    const limits = globalAdmissionLimits()
    requireModelPlanClient(request)
    const caller = await requireModelPlanCaller(request, fetcher, Date.now(), options.runVerifiers)
    state.caller = caller
    const catalog = options.models ?? gatewayPlanModels()
    const qualify = options.qualify ?? verifiedGatewayModel
    const raw = await readJson<unknown>(request, MAX_BYTES)
    const selected = stripeRecord(raw) && typeof raw.model === "string" ? raw.model : ""
    const model = catalog.find((model) => model.id === selected)
    // A staged candidate is not served yet; anything else outside the catalog is an invalid request (400).
    if (!model && CODIUM_TIER_MODELS.some((candidate) => candidate.id === selected)) throw modelUnavailable()
    const body = modelPlanRequest(raw, catalog)
    const disabled = await readDisabledSet("models-off", fetcher)
    // A switched-off or unqualified route (ROUTE_ACCEPTANCES is empty until external acceptance) is unavailable before
    // the snapshot, so it costs no Stripe, credential, hold or provider call.
    if (!model || disabled.has(selected) || (model.upstream && disabled.has(model.upstream)) || !qualify(model))
      throw modelUnavailable()
    state.model = model
    const snapshot = await requireEntitlement(caller.account.id, "codium", fetcher)
    state.snapshot = snapshot
    if (!snapshot.plan || !CodiumPlan.isPlanId(snapshot.plan))
      throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Vector Codium plan to use this model.")
    await enforceRateLimit(request, response, {
      scope: "model-plan-minute",
      identifier: caller.account.id,
      limit: snapshot.caps.perMinute,
      windowSeconds: 60,
      requirePersistent: true,
    })
    const current = await refreshLockedModel(caller, snapshot, model, fetcher)
    state.snapshot = current
    if (!current.plan || !CodiumPlan.isPlanId(current.plan))
      throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Vector Codium plan to use this model.")
    if (!modelAccess(model, current.plan)) throw modelUpgradeRequired(model)
    const effective = effectiveModel(model, current.plan)
    // A tier variant is its own route: it is qualified again before anything is reserved for it.
    if (!qualify(effective)) throw modelUnavailable()
    state.model = effective
    requireModelPlanContext(body, effective)
    const toolNames =
      stripeRecord(raw) && Array.isArray(raw.tools)
        ? raw.tools.flatMap((tool: unknown) =>
            stripeRecord(tool)
              ? [tool.type, stripeRecord(tool.function) ? tool.function.name : undefined].filter(
                  (name): name is string => typeof name === "string",
                )
              : [],
          )
        : []
    await beforeAdmit(caller, { snapshot: current, model: effective, toolNames }, options)
    if (controller.signal.aborted) throw new ApiError(499, "MODEL_PLAN_CANCELLED", "The request was cancelled.")
    const reservation = (options.reservation ?? modelPlanReservation)(effective, current.plan)
    if (
      !Number.isSafeInteger(reservation.attemptMicro) ||
      reservation.attemptMicro < 1 ||
      reservation.attempts !== modelPlanAttempts(current.plan) ||
      reservation.requiredMicro !== reservation.attempts * reservation.attemptMicro ||
      !Number.isSafeInteger(reservation.requiredMicro)
    )
      throw new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
    state.attemptMicro = reservation.attemptMicro
    // M4: the credential comes from the snapshot and one OpenRouter read, never from Stripe. A key that is not ready
    // gets one on-demand reconcile (at most one a minute per account); a newer snapshot means the caller starts again.
    const funding =
      (await snapshotPoolCredential(caller.account.id, current, fetcher)) ??
      (await reconcileOnDemand(caller.account.id, fetcher).then((fresh) =>
        fresh && requireUsableSnapshot(fresh).version === current.version
          ? snapshotPoolCredential(caller.account.id, fresh, fetcher)
          : undefined,
      ))
    if (!funding) throw modelSpendStale()
    // The admission deadline starts after every credential wait.
    const admittedAt = Date.now()
    if (caller.run && caller.run.deadline <= admittedAt)
      throw new ApiError(
        401,
        "MODEL_PLAN_RUN_EXPIRED",
        "This run is no longer authorized. Save your work and finish the run.",
      )
    if (controller.signal.aborted) throw new ApiError(499, "MODEL_PLAN_CANCELLED", "The request was cancelled.")
    state.ticket = await admitModelPlan(
      {
        snapshot: current,
        funding,
        requiredMicro: reservation.requiredMicro,
        purpose: caller.purpose,
        run: caller.run,
        ...limits,
      },
      fetcher,
      admittedAt,
    )
    const deadline = Math.min(admittedAt + 600_000, caller.run?.deadline ?? Infinity)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
    const send = async () => {
      if (signal.aborted || Date.now() >= deadline)
        throw new ApiError(503, "MODEL_PLAN_UNAVAILABLE", "This model request timed out. Try again shortly.")
      state.dispatched = true
      state.dispatchedAttempts++
      return fetcher(`${MODEL_PLAN_ROOT}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${funding.key}`,
          "content-type": "application/json",
          "HTTP-Referer": "https://vectordev.ai/",
          "X-OpenRouter-Title": "Vector",
        },
        body: JSON.stringify({ ...body, user: createHash("sha256").update(caller.account.id).digest("hex") }),
      })
    }
    const first = await send()
    const retry = CodiumPlan.rank(current.plan) >= 3 && (first.status === 429 || first.status === 503)
    if (retry) {
      state.uncertainAttempts++
      await first.body?.cancel().catch(() => undefined)
    }
    const upstream = retry ? await send() : first
    // A refusal or transport failure after dispatch can still have cost. The fixed reserve covers both possible attempts.
    state.finished = await streamModelPlanResponse(
      upstream,
      response,
      () => {
        state.streamed = true
      },
      signal,
    )
  } catch (error) {
    if (response.destroyed) return
    const code = error instanceof ApiError ? error.code : "MODEL_PLAN_UNAVAILABLE"
    const payload = {
      error: {
        ...(error instanceof ApiError ? error.detail : {}),
        code,
        message: error instanceof ApiError ? error.message : "Model access is temporarily unavailable.",
        // Every attempt sent to the provider is committed in full below (unknown outcomes are charged), so an answer
        // given after one says so, whatever its code: a client that resent it by itself would commit another whole
        // reservation each time. A context refusal is not resent as it is; the client compacts the conversation first.
        ...(state.dispatched && code !== "MODEL_PLAN_CONTEXT" ? { dispatched: true } : {}),
      },
    }
    if (response.headersSent) {
      response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`)
      return
    }
    if (error instanceof ApiError && error.code === "BILLING_MUTATION_BUSY") {
      response.setHeader("retry-after", "1")
      json(response, 429, payload)
      return
    }
    if (error instanceof ApiError && error.retryAfterSeconds !== undefined)
      response.setHeader("retry-after", String(Math.max(1, Math.ceil(error.retryAfterSeconds))))
    if (error instanceof ApiError && error.code === "MODEL_PLAN_CONCURRENCY")
      response.setHeader("retry-after-ms", String(randomInt(1500, 4001)))
    json(response, error instanceof ApiError ? error.statusCode : 503, payload)
  } finally {
    request.resume()
    response.off("close", close)
    controller.abort()
    if (state.ticket) {
      const outcome = state.finished
        ? {
            kind: "complete" as const,
            chargeMicro:
              (state.finished.charge === undefined ? state.attemptMicro : usdToMicroCeil(state.finished.charge)) +
              state.uncertainAttempts * state.attemptMicro,
          }
        : state.dispatched
          ? { kind: "broken" as const, chargeMicro: state.dispatchedAttempts * state.attemptMicro }
          : { kind: "cancel" as const }
      // Settlement is idempotent. A lost response gets one retry, then the outbox retries the same known outcome.
      await settleModelPlanDurably(state.ticket, outcome, fetcher)
      // Every admitted request reaches the services' hooks once, after its known outcome is recorded or queued (or,
      // when even the queue failed, left counting in full): a lost settle answer must not hide a request from them.
      if (state.caller && state.snapshot && state.model)
        await afterSettle(
          state.caller,
          {
            snapshot: state.snapshot,
            model: state.model,
            charge: state.finished?.charge,
            startedAt,
            endedAt: Date.now(),
            streamed: state.streamed,
          },
          options,
        ).catch(() => undefined)
    }
  }
}

function modelUnavailable() {
  return new ApiError(
    503,
    "MODEL_PLAN_MODEL_UNAVAILABLE",
    "This model is temporarily unavailable. Choose another included model.",
  )
}
function modelUpgradeRequired(model: ModelPlanModel) {
  const plan =
    model.previewUntil !== undefined && Date.now() < model.previewUntil ? "vector-200" : (model.minPlan ?? "vector-10")
  return new ApiError(403, "MODEL_PLAN_UPGRADE_REQUIRED", "Change your Codium plan to use this model.", {
    detail: {
      plan,
      planName: CodiumPlan.name(plan),
      ...(model.previewUntil ? { previewUntil: model.previewUntil } : {}),
    },
  })
}
async function refreshLockedModel(
  caller: ModelPlanCaller,
  snapshot: EntitlementSnapshot,
  model: ModelPlanModel,
  fetcher: typeof fetch,
) {
  if (!snapshot.plan || modelAccess(model, snapshot.plan)) return snapshot
  const account = await readModelPlanAccount(caller.account.id, fetcher)
  const checkout = account?.checkout
  if (!checkout || checkout.expires - 30 * 60_000 < Date.now() - 60 * 60_000) return snapshot
  const fresh = await reconcileOnDemand(caller.account.id, fetcher)
  // A reconciled snapshot gets the same state answers as the first one (402, 403, 409), never a retryable 503.
  return fresh ? requireUsableSnapshot(fresh) : snapshot
}
function globalAdmissionLimits() {
  const configured = process.env.MODEL_PLAN_GLOBAL_INFLIGHT?.trim()
  const reserve = process.env.MODEL_PLAN_PRIORITY_RESERVE?.trim()
  const globalLimit = configured ? Number(configured) : undefined
  const priorityReserve = reserve ? Number(reserve) : 0.2
  if (
    (globalLimit !== undefined && (!Number.isSafeInteger(globalLimit) || globalLimit < 1 || globalLimit > 100000)) ||
    !Number.isFinite(priorityReserve) ||
    priorityReserve < 0 ||
    priorityReserve >= 1
  )
    throw new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
  return { globalLimit, priorityReserve }
}
