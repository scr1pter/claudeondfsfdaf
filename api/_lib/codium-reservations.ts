import type { ModelPlanModel } from "./model-plan-config.js"

/** Historical bounds only: exact bytes are pinned by the A15 manifest. They do not certify live route acceptance. */
export const RESERVATION_CAPTURE = {
  date: "2026-10-23",
  sha256: "3c37e89169bc4ccb0a4792f5bbb65ce97340731fcf1dcf6018ee95d7805889e0",
} as const
export const CAPTURED_RESERVATIONS: Readonly<
  Record<
    string,
    {
      tag: string
      contextLength: number
      maxOutputTokens: number
      inputPrice: number
      outputPrice: number
    }
  >
> = {
  "deepseek/deepseek-v4.1-flash-1017": {
    tag: "nebius/fp8",
    contextLength: 1048576,
    maxOutputTokens: 943718,
    inputPrice: 0.3,
    outputPrice: 1.2,
  },
  "anthropic/claude-haiku-5.5": {
    tag: "amazon-bedrock",
    contextLength: 1000000,
    maxOutputTokens: 128000,
    inputPrice: 1,
    outputPrice: 2.5,
  },
  "openai/gpt-6-luna": {
    tag: "azure",
    contextLength: 1050000,
    maxOutputTokens: 128000,
    inputPrice: 0.25,
    outputPrice: 0.75,
  },
  "moonshotai/kimi-k3.1-pro": {
    tag: "moonshotai/mxfp4",
    contextLength: 1048576,
    maxOutputTokens: 943718,
    inputPrice: 2,
    outputPrice: 10,
  },
  "google/gemini-4-argon": {
    tag: "google-vertex/global",
    contextLength: 1048576,
    maxOutputTokens: 943718,
    inputPrice: 2,
    outputPrice: 10,
  },
}

/**
 * Full native input window plus the configured maximum reply, at the maximum of every captured base/override/cache
 * rate. Counting the full context as input deliberately leaves the reply inside that context uncredited. This avoids
 * deriving a money bound from the gateway's approximate token/framing estimate. Round up to whole micro-dollars.
 */
export function capturedReservationMicro(model: ModelPlanModel) {
  const captured = CAPTURED_RESERVATIONS[model.upstream ?? model.id]
  if (
    !captured ||
    !Number.isFinite(model.inputPrice) ||
    model.inputPrice <= 0 ||
    !Number.isFinite(model.outputPrice) ||
    model.outputPrice <= 0 ||
    (model.providerOnly && (model.providerOnly.length !== 1 || model.providerOnly[0] !== captured.tag)) ||
    !Number.isSafeInteger(model.maxOutputTokens) ||
    model.maxOutputTokens < 1 ||
    model.maxOutputTokens > captured.maxOutputTokens
  )
    return undefined
  const micro = Math.ceil(
    captured.contextLength * Math.max(captured.inputPrice, model.inputPrice) +
      model.maxOutputTokens * Math.max(captured.outputPrice, model.outputPrice),
  )
  return Number.isSafeInteger(micro) && micro > 0 ? micro : undefined
}

/**
 * Deliberately empty until an approved external acceptance artifact establishes every premise. Neither environment
 * configuration nor historical metadata can insert an acceptance. No provider call was made to populate this list.
 */
export const ROUTE_ACCEPTANCES: readonly {
  model: string
  tag: string
  captureSha256: string
  source: string
  acceptedAt: number
  nativeWindowEnforced: true
  outputIncludesReasoning: true
  exactTagWithZdr: true
  capturedRatesBoundCharges: true
}[] = []
