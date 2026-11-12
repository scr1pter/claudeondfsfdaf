import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Option, Schema } from "effect"
import { configuredPlanModels, MODEL_PLAN_OPTIONS, type ModelPlanModel } from "../../../api/_lib/model-plan-config"

const CatalogModel = Schema.Struct({
  id: Schema.String,
  context_length: Schema.Number,
  supported_parameters: Schema.Array(Schema.String),
  expiration_date: Schema.optional(Schema.NullOr(Schema.String)),
})
const CatalogEndpoint = Schema.Struct({
  model_id: Schema.String,
  provider_name: Schema.String,
  tag: Schema.String,
  context_length: Schema.Number,
  max_completion_tokens: Schema.NullOr(Schema.Number),
  pricing: Schema.Record(Schema.String, Schema.Unknown),
  supported_parameters: Schema.Array(Schema.String),
  status: Schema.Number,
  quantization: Schema.optional(Schema.String),
})

// Separate reviewed evidence, never a field invented on a captured OpenRouter API record.
const ProviderEffortEvidence = Schema.Struct({
  model: Schema.String,
  tag: Schema.String,
  efforts: Schema.Array(Schema.String),
  source: Schema.String,
  capturedAt: Schema.String,
})
export type ProviderEffortEvidence = typeof ProviderEffortEvidence.Type
const CapturedCatalog = Schema.Struct({
  checkedAt: Schema.String,
  sources: Schema.Array(Schema.String),
  models: Schema.Array(Schema.Unknown),
  endpoints: Schema.Array(Schema.Unknown),
})
const AuditManifest = Schema.Struct({
  targetDate: Schema.String,
  capturedAt: Schema.String,
  snapshot: Schema.String,
  snapshotSha256: Schema.String,
  providerEfforts: Schema.Array(ProviderEffortEvidence),
  unverified: Schema.Array(Schema.Unknown),
})

// Audit the configured catalog without substituting models or changing deployment settings.
export function auditModelPlanCatalog(
  configured: readonly ModelPlanModel[],
  models: readonly unknown[],
  endpoints: readonly unknown[],
  now = Date.now(),
  providerEfforts: readonly ProviderEffortEvidence[] = [],
) {
  return configured.map((configured) => {
    const upstream = configured.upstream ?? configured.id
    const contextLength = Math.max(configured.contextLength, ...Object.values(configured.tierContext ?? {}))
    const decoded = Schema.decodeUnknownOption(CatalogModel)(
      models.find((model) => record(model) && model.id === upstream),
    )
    const failures: string[] = []
    if (Option.isNone(decoded)) failures.push("Model is missing or its catalog metadata is invalid.")
    if (Option.isSome(decoded)) {
      if (!supportsTools(decoded.value.supported_parameters)) failures.push("Model does not advertise tool calling.")
      if (!Number.isSafeInteger(decoded.value.context_length) || decoded.value.context_length < contextLength)
        failures.push("Model context is below the configured limit.")
      if (decoded.value.expiration_date && !(Date.parse(decoded.value.expiration_date) > now))
        failures.push("Model has expired or its expiration date is invalid.")
    }
    const rejected: string[] = []
    const providers = endpoints.flatMap((item) => {
      if (!record(item) || item.model_id !== upstream) return []
      const decoded = Schema.decodeUnknownOption(CatalogEndpoint)(item)
      if (Option.isNone(decoded)) {
        rejected.push("An endpoint has invalid metadata.")
        return []
      }
      const endpoint = decoded.value
      const reasons = [
        ...(endpoint.status !== 0 ? ["unavailable"] : []),
        ...(configured.quantizations && !configured.quantizations.some((value) => value === endpoint.quantization)
          ? ["quantization is outside the configured allowlist"]
          : []),
        ...(!endpoint.tag.trim() || !endpoint.provider_name.trim() ? ["missing provider identity"] : []),
        ...(configured.providerOnly && !configured.providerOnly.includes(endpoint.tag)
          ? ["provider is outside the configured exact-tag allowlist"]
          : []),
        ...(!supportsTools(endpoint.supported_parameters) ? ["missing tools/tool_choice"] : []),
        ...(!endpoint.supported_parameters.includes(configured.outputTokenParameter ?? "max_tokens")
          ? ["missing the configured output-token parameter"]
          : []),
        ...(configured.reasoningEffort && !endpoint.supported_parameters.includes("reasoning")
          ? ["missing pinned reasoning support"]
          : []),
        ...((configured.reasoningEffort === "xhigh" || configured.reasoningEffort === "max") &&
        !providerEfforts.some(
          (evidence) =>
            evidence.model === upstream &&
            evidence.tag === endpoint.tag &&
            evidence.efforts.includes(configured.reasoningEffort!) &&
            evidence.source.trim() &&
            Number.isFinite(Date.parse(evidence.capturedAt)) &&
            Date.parse(evidence.capturedAt) <= now,
        )
          ? [`pinned ${configured.reasoningEffort} effort is unverified for this exact model/provider`]
          : []),
        ...(configured.explicitCache &&
        (rate(endpoint.pricing.input_cache_read) === undefined ||
          rate(endpoint.pricing.input_cache_write) === undefined)
          ? ["missing explicit-cache pricing"]
          : []),
        // The gateway requires every option it forwards, so an endpoint missing one is never routed a request that
        // sets it. Without its own list a model forwards the gateway's default options.
        ...((configured.options ?? MODEL_PLAN_OPTIONS).some((option) => !endpoint.supported_parameters.includes(option))
          ? ["missing a forwarded request option"]
          : []),
        ...(!Number.isSafeInteger(endpoint.context_length) || endpoint.context_length < contextLength
          ? ["context below configured limit"]
          : []),
        ...(endpoint.max_completion_tokens === null ||
        !Number.isSafeInteger(endpoint.max_completion_tokens) ||
        endpoint.max_completion_tokens < configured.maxOutputTokens
          ? ["output limit is unknown or below configured limit"]
          : []),
        ...(!withinPricingLimits(endpoint.pricing, { ...configured, contextLength })
          ? ["pricing exceeds ceilings or has unsupported fees"]
          : []),
      ]
      if (reasons.length) {
        rejected.push(`${endpoint.tag}: ${reasons.join(", ")}.`)
        return []
      }
      return [
        {
          id: endpoint.tag,
          name: endpoint.provider_name,
          contextLength: endpoint.context_length,
          maxOutputTokens: endpoint.max_completion_tokens,
          inputPrice: Number(endpoint.pricing.prompt) * 1_000_000,
          outputPrice: Number(endpoint.pricing.completion) * 1_000_000,
        },
      ]
    })
    if (!providers.length) failures.push("No available ZDR endpoint satisfies every configured limit.", ...rejected)
    return { model: configured.id, ok: !failures.length, providers, failures }
  })
}

function supportsTools(parameters: readonly string[]) {
  return parameters.includes("tools") && parameters.includes("tool_choice")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rate(value: unknown) {
  return (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
    ? Number(value)
    : undefined
}

function withinPricingLimits(pricing: Readonly<Record<string, unknown>>, configured: ModelPlanModel): boolean {
  if (rate(pricing.prompt) === undefined || rate(pricing.completion) === undefined) return false
  return Object.entries(pricing).every(([key, value]) => {
    if (key === "overrides") {
      if (!Array.isArray(value)) return false
      return value.every((override: unknown) => {
        if (
          !record(override) ||
          !Number.isSafeInteger(override.min_prompt_tokens) ||
          Number(override.min_prompt_tokens) < 0
        )
          return false
        // An explicit prompt cap is the actual exclusion bound. The estimated context must not narrow it.
        if (Number(override.min_prompt_tokens) >= (configured.promptTokenLimit ?? configured.contextLength)) return true
        return withinPricingLimits(
          Object.fromEntries(
            Object.entries({ ...pricing, ...override }).filter(
              ([key]) => key !== "overrides" && key !== "min_prompt_tokens",
            ),
          ),
          configured,
        )
      })
    }
    const price = rate(value)
    if (price === undefined) return false
    // The gateway rejects media and native add-ons; these rates cannot apply to its text/function-tool requests.
    if (["web_search", "image", "audio", "input_audio_cache"].includes(key)) return true
    if (key === "discount") return price <= 1
    if (key === "prompt" || key.startsWith("input_cache_")) return price * 1_000_000 <= configured.inputPrice
    if (key === "completion" || key === "internal_reasoning") return price * 1_000_000 <= configured.outputPrice
    return price === 0
  })
}

/** Offline command boundary: a manifest pins captured bytes; an explicit snapshot retains its real capture date. */
export async function auditModelPlanCatalogCommand(
  argv: readonly string[] = [],
  options: { configured?: readonly ModelPlanModel[]; now?: number } = {},
) {
  const now = options.now ?? Date.now()
  if (argv.length && (argv.length !== 2 || argv[0] !== "--snapshot" || !argv[1]?.trim()))
    throw new Error("Usage: model-plan-catalog.ts [--snapshot <captured JSON or manifest path>]. No network is used.")
  const filename = argv.length
    ? path.resolve(argv[1]!)
    : fileURLToPath(new URL("../test/fixtures/codium-endpoints-2026-10-30.json", import.meta.url))
  const text = await Bun.file(filename).text()
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Union([AuditManifest, CapturedCatalog])))(text)
  const manifest = "snapshot" in input ? input : undefined
  if (
    manifest &&
    (!manifest.snapshot.endsWith(".json") ||
      path.basename(manifest.snapshot) !== manifest.snapshot ||
      !/^[a-f0-9]{64}$/.test(manifest.snapshotSha256))
  )
    throw new Error("The audit manifest must pin a sibling JSON snapshot and its SHA-256.")
  const raw = manifest ? await Bun.file(path.join(path.dirname(filename), manifest.snapshot)).text() : text
  const digest = createHash("sha256").update(raw).digest("hex")
  if (manifest && digest !== manifest.snapshotSha256)
    throw new Error("Captured snapshot SHA-256 does not match the committed audit manifest.")
  const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(CapturedCatalog))(raw)
  if (manifest && manifest.capturedAt !== snapshot.checkedAt)
    throw new Error("The audit manifest capture date does not match its captured snapshot.")
  if (
    !Number.isFinite(Date.parse(snapshot.checkedAt)) ||
    Date.parse(snapshot.checkedAt) > now ||
    !snapshot.sources.includes("https://openrouter.ai/api/v1/models") ||
    !snapshot.sources.includes("https://openrouter.ai/api/v1/endpoints/zdr")
  )
    throw new Error("The snapshot must identify its real capture date and public model/ZDR sources.")
  const configured = options.configured ?? configuredPlanModels({ tiered: true })
  if (!configured.length) throw new Error("No Codium models are configured. The catalog was not changed.")
  return {
    ...(manifest ? { targetDate: manifest.targetDate } : {}),
    capturedAt: snapshot.checkedAt,
    snapshotSha256: digest,
    offline: true,
    unverified: manifest?.unverified ?? [],
    models: auditModelPlanCatalog(configured, snapshot.models, snapshot.endpoints, now, manifest?.providerEfforts),
  }
}

if (import.meta.main) {
  const report = await auditModelPlanCatalogCommand(process.argv.slice(2))
  console.log(JSON.stringify(report, null, 2))
  if (report.models.some((result) => !result.ok)) process.exitCode = 1
}
