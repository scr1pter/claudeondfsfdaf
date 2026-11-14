export * as ProviderPolicy from "./provider-policy"

import { Billing } from "./billing"

// Re-enabling Copilot requires a Vector-owned registration and provider approval.
export const COPILOT_SIGN_IN = false

export function providerEnabled(id: string) {
  return !id.startsWith("github-copilot") || COPILOT_SIGN_IN
}

/** Presentation hint from the trusted runtime catalog; never a credential authorization. */
export function providerRuntimeEnabled(id: string, provider?: { options?: { vectorOAuthPlugin?: unknown } }) {
  return (
    providerEnabled(id) ||
    (typeof provider?.options?.vectorOAuthPlugin === "string" &&
      /^[a-f0-9]{64}$/.test(provider.options.vectorOAuthPlugin))
  )
}

// Supported providers are frozen from the reviewed Vector release catalog.
// Additions require an explicit review; catalog refreshes cannot enable new providers.
export const SUPPORTED_PROVIDER_IDS = [
  "302ai",
  "abacus",
  "abliteration-ai",
  "above",
  "agentrouter",
  "agnes",
  "ai-router",
  "ai21",
  "aiand",
  "aihubmix",
  "ainetcafe",
  "aixy",
  "aki-io",
  "alibaba",
  "alibaba-cn",
  "alibaba-coding-plan",
  "alibaba-coding-plan-cn",
  "alibaba-token-plan",
  "alibaba-token-plan-cn",
  "amazon-bedrock",
  "ambient",
  "amd",
  "anthropic",
  "anyapi",
  "arcee",
  "atomic-chat",
  "auriko",
  "azure",
  "azure-cognitive-services",
  "bailing",
  "baseten",
  "berget",
  "blueclaw",
  "bothub",
  "cerebras",
  "chutes",
  "clarifai",
  "claudinio",
  "cline-pass",
  "cloudferro-sherlock",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "cohere",
  "coralbricks",
  "cortecs",
  "crof",
  "crossmodel",
  "crusoe",
  "daoxe",
  "databricks",
  "deepinfra",
  "deepseek",
  "digitalocean",
  "dinference",
  "drun",
  "ebcloud",
  "echo",
  "edenai",
  "empiriolabs",
  "evroc",
  "fastrouter",
  "fireworks-ai",
  "freemodel",
  "friendli",
  "frogbot",
  ...(COPILOT_SIGN_IN ? (["github-copilot"] as const) : []),
  "gitlab",
  "gmicloud",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "greenpt",
  "groq",
  "helicone",
  "hetzner",
  "hpc-ai",
  "huggingface",
  "hyper",
  "iflowcn",
  "impossibl",
  "inception",
  "inceptron",
  "inco",
  "infer",
  "inference",
  "inferx",
  "infomaniak",
  "io-net",
  "iteracompute",
  "jalapeno",
  "jiekou",
  "kenari",
  "kilo",
  "kimi-code-plan-cn",
  "kimi-code-plan-global",
  "klokintegration",
  "kosmik",
  "kuae-cloud-coding-plan",
  "lilac",
  "llama",
  "llmgateway",
  "llmgateway-providers",
  "llmtech",
  "llmtr",
  "lmstudio",
  "longcat",
  "lucidquery",
  "lynkr",
  "meganova",
  "melious",
  "merge-gateway",
  "meta",
  "minimax",
  "minimax-cn",
  "minimax-cn-coding-plan",
  "minimax-coding-plan",
  "mistral",
  "mixlayer",
  "moark",
  "modal",
  "model-oracle-ai",
  "modelis",
  "modelscope",
  "moonshotai",
  "moonshotai-cn",
  "morph",
  "nan",
  "nano-gpt",
  "nearai",
  "nebius",
  "neon",
  "neosmith",
  "neuralwatt",
  "nova",
  "novita-ai",
  "nvidia",
  "oci",
  "ofox",
  "ollama-cloud",
  "openai",
  "openreason",
  "openrouter",
  "opper",
  "orcarouter",
  "ovhcloud",
  "pendra",
  "perplexity",
  "perplexity-agent",
  "pioneer",
  "poe",
  "poolside",
  "privatemode-ai",
  "qihang-ai",
  "qiniu-ai",
  "qvac",
  "regolo-ai",
  "requesty",
  "routing-run",
  "runinfra",
  "sakana",
  "sap-ai-core",
  "sarvam",
  "scaleway",
  "scnet-token-plan",
  "scx-ai",
  "sensenova",
  "siliconflow",
  "siliconflow-cn",
  "snowflake-cortex",
  "stackit",
  "standardcompute",
  "stepfun",
  "stepfun-ai",
  "stepfun-ai-step-plan",
  "stepfun-step-plan",
  "subconscious",
  "submodel",
  "synthetic",
  "tempr",
  "tencent-coding-plan",
  "tencent-token-plan",
  "tencent-tokenhub",
  "tensorx",
  "the-grid-ai",
  "thinkingmachines",
  "tinfoil",
  "togetherai",
  "tokengo",
  "tokenrouter",
  "trustedrouter",
  "umans-ai",
  "umans-ai-coding-plan",
  "unorouter",
  "upstage",
  "v0",
  "vancine",
  "vector",
  // Vector Codium: managed coding models included in the account's Codium plan, served through vectordev.ai.
  Billing.CODIUM_PROVIDER_ID,
  "venice",
  "vercel",
  "vispark",
  "vivgrid",
  "volcengine",
  "volcengine-coding-plan",
  "vultr",
  "wafer.ai",
  "wallaby",
  "wandb",
  "watsonx",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "xpersona",
  "zai",
  "zai-coding-plan",
  "zeldoc",
  "zenifra",
  "zenmux",
  "zhipuai",
  "zhipuai-coding-plan",
] as const

const supported = new Set<string>(SUPPORTED_PROVIDER_IDS)

// Providers the reviewed catalog renamed, mapped to the provider that serves the same endpoint.
// 1.99.8 saved Kimi For Coding (api.kimi.com/coding/v1) as "kimi-for-coding"; the catalog now calls it
// "kimi-code-plan-cn", so credentials saved under the old ID carry over.
export const RENAMED_PROVIDER_IDS: Readonly<Record<string, string>> = { "kimi-for-coding": "kimi-code-plan-cn" }

// A saved model choice moved to the provider ID that serves it now, so choices follow their credentials.
export function renamedModel<T extends { providerID: string }>(model: T): T {
  const providerID = RENAMED_PROVIDER_IDS[model.providerID]
  return providerID ? { ...model, providerID } : model
}

// Link to each provider's verified general documentation, rather than a client-specific integration guide.
const documentation: Record<string, string> = {
  infer: "https://infer.flow7.org/docs",
  pendra: "https://pendra.ai/docs/",
  agentrouter: "https://agentrouter.org/docs/index.html",
}

export function providerAllowed(id: string) {
  return supported.has(id)
}

/** Runtime providers may also come from explicit user configuration or installed plugins. */
export function providerUsable(
  id: string,
  provider?: {
    id?: string
    source?: string
    npm?: string
    api?: string
    options?: { baseURL?: unknown; vectorOAuthPlugin?: unknown }
  },
) {
  if (!providerRuntimeEnabled(id, provider)) return false
  return (
    !providerEnabled(id) ||
    providerAllowed(id) ||
    provider?.source === "config" ||
    provider?.source === "custom" ||
    Boolean(provider?.npm?.trim() || provider?.api?.trim()) ||
    (typeof provider?.options?.baseURL === "string" && provider.options.baseURL.trim().length > 0)
  )
}

export function filterProviderCatalog<T extends { id?: string }>(catalog: Record<string, T>) {
  return Object.fromEntries(
    Object.entries(catalog)
      .filter(([id, provider]) => providerAllowed(id) && (!provider.id || provider.id === id))
      .map(([id, provider]): [string, T] => [
        id,
        documentation[id] ? { ...provider, doc: documentation[id] } : provider,
      ]),
  )
}
