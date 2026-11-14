import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"

// Reviewed against OpenRouter's /models and /endpoints/zdr on 2026-10-23.
// These are routing ceilings, not a promise that every provider has this price.
// The owner approved vendor-native precision for Kimi and the closed models; ZDR remains mandatory.
export const CODIUM_RUNTIME_CATALOG_UPDATED = "2026-10-23"
// The owner contract date (30 Oct: Sol in; Terra and Astra out). Captured provider evidence is tracked separately and
// is not implied by this date.
export const CODIUM_CATALOG_UPDATED = "2026-10-30"
export const CODIUM_MODELS = [
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    category: "everyday",
    description: "The default: fast, capable coding for everyday changes, tests and agent work.",
    contextLength: 262144,
    maxOutputTokens: 16384,
    inputPrice: 0.3,
    outputPrice: 1.2,
    quantizations: ["fp8", "bf16"],
    reasoningEffort: "high",
  },
  {
    id: "anthropic/claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    category: "everyday",
    description: "Fast, focused coding, tests and tool-assisted edits.",
    // Vector compacts once a step reaches this window less the reply: 48,000 tokens, which the gateway's window check
    // counts as 192,000 characters. That stays under the 196,000 ASCII characters the prompt bound below admits, so for
    // ASCII text the bound never refuses a full-reply request that the window check accepts.
    contextLength: 64000,
    maxOutputTokens: 16000,
    // Every endpoint bills a whole request at five times the price once its prompt reaches 100,000 tokens.
    promptTokenLimit: 100000,
    // Covers prompt-cache writes, which these endpoints bill at up to twice the 0.11 input price.
    inputPrice: 0.22,
    outputPrice: 0.55,
    reasoningEffort: "high",
    // Without explicit breakpoints these endpoints cache nothing, and all input bills at ten times the cached price.
    explicitCache: true,
    autoToolChoice: "forced",
    // Its endpoints take no sampling options, and with require_parameters any one of them would leave no endpoint.
    options: ["stop", "tools", "tool_choice", "response_format"],
  },
  {
    id: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    category: "everyday",
    description: "Efficient reasoning for focused fixes and everyday agent tasks.",
    contextLength: 128000,
    maxOutputTokens: 8192,
    promptTokenLimit: 272000,
    // Includes the regional Azure endpoint's 1.25x cache-write price below the long-prompt threshold.
    inputPrice: 0.1375,
    outputPrice: 0.55,
    reasoningEffort: "high",
    explicitCache: true,
    cacheStyle: "openai",
    outputTokenParameter: "max_completion_tokens",
    options: ["seed", "tools", "tool_choice", "response_format"],
  },
  {
    id: "moonshotai/kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    category: "advanced",
    description: "For demanding coding and multi-step reasoning. Uses credits faster than the everyday models.",
    contextLength: 128000,
    maxOutputTokens: 8192,
    inputPrice: 2,
    outputPrice: 10,
    quantizations: ["mxfp4"],
    reasoningEffort: "high",
    // Moonshot supports required/auto, but not forcing a particular named function.
    autoToolChoice: "named",
    options: ["stop", "frequency_penalty", "presence_penalty", "response_format", "tool_choice", "tools"],
  },
  {
    id: "google/gemini-4-argon",
    name: "Gemini 4 Argon",
    category: "advanced",
    description: "For complex coding and deeper analysis. Uses credits faster than the everyday models.",
    contextLength: 128000,
    maxOutputTokens: 8192,
    inputPrice: 2,
    outputPrice: 10,
    reasoningEffort: "high",
    explicitCache: true,
    options: ["temperature", "top_p", "seed", "response_format", "tools", "tool_choice", "stop"],
  },
] as const

/**
 * Owner-approved tier definitions, staged until tier admission/routing and provider acceptance are complete. GPT-6.1
 * Terra and GPT-6 Astra are not offered (owner, 30 Oct): Vector routes only through OpenRouter, and they are not ZDR
 * there. GPT-6.1 Sol stays staged; its `providerOnly` tag and request options are the 27 Oct hypothesis, unverified
 * until a captured OpenRouter ZDR endpoint record is committed.
 */
export const CODIUM_TIER_MODELS = [
  { ...CODIUM_MODELS[0], minPlan: "vector-10", lab: "deepseek", weight: 1 },
  { ...CODIUM_MODELS[1], minPlan: "vector-10", lab: "anthropic", weight: (0.22 + 0.55) / 1.5 },
  { ...CODIUM_MODELS[2], contextLength: 256000, minPlan: "vector-10", lab: "openai", weight: (0.1375 + 0.55) / 1.5 },
  {
    ...CODIUM_MODELS[2],
    id: "openai/gpt-6.1-sol",
    name: "GPT-6.1 Sol High",
    description: "Higher-effort coding and reasoning.",
    inputPrice: 2.75,
    outputPrice: 11,
    minPlan: "vector-50",
    providerOnly: ["azure"],
    lab: "openai",
    weight: (2.75 + 11) / 1.5,
  },
  { ...CODIUM_MODELS[3], minPlan: "vector-50", lab: "moonshot", weight: (2 + 10) / 1.5 },
  { ...CODIUM_MODELS[4], minPlan: "vector-50", lab: "google", weight: (2 + 10) / 1.5 },
  {
    ...CODIUM_MODELS[3],
    id: "moonshotai/kimi-k3.1-pro:long",
    upstream: "moonshotai/kimi-k3.1-pro",
    name: "Kimi K3.1 Pro Long",
    contextLength: 256000,
    tierContext: { "vector-50": 256000, "vector-100": 512000, "vector-200": 768000 },
    minPlan: "vector-50",
    manualOnly: true,
    lab: "moonshot",
    weight: (2 + 10) / 1.5,
  },
  {
    ...CODIUM_MODELS[4],
    id: "google/gemini-4-argon:long",
    upstream: "google/gemini-4-argon",
    name: "Gemini 4 Argon Long",
    contextLength: 256000,
    tierContext: { "vector-50": 256000, "vector-100": 512000, "vector-200": 768000 },
    minPlan: "vector-50",
    manualOnly: true,
    lab: "google",
    weight: (2 + 10) / 1.5,
  },
  {
    ...CODIUM_MODELS[0],
    id: "deepseek/deepseek-v4.1-flash-1017:long",
    upstream: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash Long",
    contextLength: 512000,
    tierContext: { "vector-100": 512000, "vector-200": 768000 },
    minPlan: "vector-100",
    manualOnly: true,
    lab: "deepseek",
    weight: 1,
  },
  {
    id: "anthropic/claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    category: "advanced",
    description: "Careful coding and review across larger changes.",
    contextLength: 200000,
    maxOutputTokens: 16384,
    inputPrice: 2.75,
    outputPrice: 11,
    reasoningEffort: "high",
    explicitCache: true,
    autoToolChoice: "forced",
    options: ["stop", "tools", "tool_choice", "response_format"],
    providerOnly: ["amazon-bedrock", "google-vertex/global", "google-vertex/us", "google-vertex/europe"],
    minPlan: "vector-100",
    lab: "anthropic",
    weight: (2.75 + 11) / 1.5,
  },
  {
    ...CODIUM_MODELS[2],
    id: "openai/gpt-6.1-sol:deep",
    upstream: "openai/gpt-6.1-sol",
    name: "GPT-6.1 Sol Deep",
    description: "Extra-high effort for difficult coding and review.",
    maxOutputTokens: 16384,
    inputPrice: 2.75,
    outputPrice: 11,
    reasoningEffort: "xhigh",
    providerOnly: ["azure"],
    minPlan: "vector-100",
    lab: "openai",
    weight: (2.75 + 11) / 1.5,
  },
  {
    ...CODIUM_MODELS[3],
    id: "moonshotai/kimi-k3.1-pro:fast",
    upstream: "moonshotai/kimi-k3.1-pro",
    name: "Kimi K3.1 Pro Fast",
    inputPrice: 4,
    outputPrice: 20,
    providerOnly: ["moonshotai/highspeed"],
    manualOnly: true,
    minPlan: "vector-100",
    lab: "moonshot",
    weight: (4 + 20) / 1.5,
  },
  {
    ...CODIUM_MODELS[4],
    id: "google/gemini-4-argon:fast",
    upstream: "google/gemini-4-argon",
    name: "Gemini 4 Argon Fast",
    inputPrice: 3.6,
    outputPrice: 18,
    providerOnly: ["google-vertex/global/priority"],
    manualOnly: true,
    minPlan: "vector-100",
    lab: "google",
    weight: (3.6 + 18) / 1.5,
  },
  {
    id: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    category: "advanced",
    description: "The largest Claude option for demanding coding and review.",
    contextLength: 200000,
    maxOutputTokens: 32768,
    inputPrice: 5.5,
    outputPrice: 22,
    reasoningEffort: "high",
    explicitCache: true,
    autoToolChoice: "forced",
    options: ["stop", "tools", "tool_choice", "response_format"],
    providerOnly: [
      "amazon-bedrock",
      "amazon-bedrock/eu-west-1",
      "amazon-bedrock/us-east-1",
      "google-vertex/global",
      "google-vertex/us",
      "google-vertex/europe",
    ],
    minPlan: "vector-200",
    lab: "anthropic",
    weight: (5.5 + 22) / 1.5,
  },
  {
    ...CODIUM_MODELS[2],
    id: "openai/gpt-6.1-sol:deepest",
    upstream: "openai/gpt-6.1-sol",
    name: "GPT-6.1 Sol Deepest",
    description: "Maximum effort with a larger reasoning and reply window.",
    contextLength: 256000,
    maxOutputTokens: 32768,
    inputPrice: 2.75,
    outputPrice: 11,
    reasoningEffort: "max",
    providerOnly: ["azure"],
    minPlan: "vector-200",
    lab: "openai",
    weight: (2.75 + 11) / 1.5,
  },
] as const

export const CODIUM_AUTO_ROLES = {
  "vector-10": {
    floor: "openai/gpt-6-luna",
    default: "deepseek/deepseek-v4.1-flash-1017",
    ceiling: "deepseek/deepseek-v4.1-flash-1017",
  },
  "vector-50": {
    floor: "openai/gpt-6-luna",
    default: "deepseek/deepseek-v4.1-flash-1017",
    ceiling: "openai/gpt-6.1-sol",
  },
  "vector-100": {
    floor: "openai/gpt-6-luna",
    default: "deepseek/deepseek-v4.1-flash-1017",
    ceiling: "openai/gpt-6.1-sol:deep",
  },
  "vector-200": {
    floor: "openai/gpt-6-luna",
    default: "deepseek/deepseek-v4.1-flash-1017",
    ceiling: "openai/gpt-6.1-sol:deepest",
  },
} as const
export const CODIUM_REVIEW_PAIRS = {
  "vector-10": {
    triage: "deepseek/deepseek-v4.1-flash-1017",
    confirm: "openai/gpt-6-luna",
    panelJudge: "anthropic/claude-haiku-5.5",
  },
  "vector-50": {
    triage: "deepseek/deepseek-v4.1-flash-1017",
    confirm: "openai/gpt-6.1-sol",
    panelJudge: "google/gemini-4-argon",
  },
  "vector-100": {
    triage: "deepseek/deepseek-v4.1-flash-1017",
    confirm: "openai/gpt-6.1-sol:deep",
    panelJudge: "anthropic/claude-sonnet-5.5",
  },
  "vector-200": {
    triage: "deepseek/deepseek-v4.1-flash-1017",
    confirm: "openai/gpt-6.1-sol:deepest",
    panelJudge: "anthropic/claude-opus-5.5",
  },
} as const
export const CODIUM_JUDGES = {
  "vector-10": {},
  "vector-50": {
    "deepseek/deepseek-v4.1-flash-1017": "openai/gpt-6.1-sol",
    "anthropic/claude-haiku-5.5": "openai/gpt-6.1-sol",
    "openai/gpt-6-luna": "google/gemini-4-argon",
    "openai/gpt-6.1-sol": "google/gemini-4-argon",
    "moonshotai/kimi-k3.1-pro": "openai/gpt-6.1-sol",
    "google/gemini-4-argon": "openai/gpt-6.1-sol",
    "moonshotai/kimi-k3.1-pro:long": "openai/gpt-6.1-sol",
    "google/gemini-4-argon:long": "openai/gpt-6.1-sol",
  },
  "vector-100": judges("vector-100", "openai/gpt-6.1-sol:deep", "anthropic/claude-sonnet-5.5"),
  "vector-200": judges("vector-200", "openai/gpt-6.1-sol:deepest", "anthropic/claude-opus-5.5"),
} as const
function judges(plan: CodiumPlan.PlanId, anthropic: string, other: string) {
  return Object.fromEntries(
    CODIUM_TIER_MODELS.filter((model) => CodiumPlan.rank(model.minPlan) <= CodiumPlan.rank(plan)).map((model) => [
      model.id,
      model.lab === "anthropic" ? anthropic : other,
    ]),
  )
}
