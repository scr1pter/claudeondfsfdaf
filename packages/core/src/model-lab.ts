export * as ModelLab from "./model-lab"

// Which lab made a model, from its vendor (WP A35). Second opinion and Vectorscope's second-lab line need a lab they can
// name for every model they compare; a model whose lab this cannot tell gets none, and Vector then claims no second
// lab. Pure and browser-safe, so the engine, the app and the review core read a model the same way.

export const LABS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "moonshot",
  "xai",
  "mistral",
  "alibaba",
  "zhipu",
  "minimax",
  "meta",
] as const
export type Lab = (typeof LABS)[number]

const NAMES: Record<Lab, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  moonshot: "Moonshot AI",
  xai: "xAI",
  mistral: "Mistral",
  alibaba: "Alibaba",
  zhipu: "Zhipu",
  minimax: "MiniMax",
  meta: "Meta",
}

// A vendor's own path segment, as OpenRouter, Vector Codium and other routers name a model ("anthropic/claude-…").
const VENDORS: Record<string, Lab> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  deepseek: "deepseek",
  moonshotai: "moonshot",
  moonshot: "moonshot",
  "x-ai": "xai",
  xai: "xai",
  mistralai: "mistral",
  mistral: "mistral",
  qwen: "alibaba",
  alibaba: "alibaba",
  "z-ai": "zhipu",
  zhipuai: "zhipu",
  minimax: "minimax",
  "meta-llama": "meta",
  meta: "meta",
}

// A model family, read from the model's own name. Earlier entries win, so a DeepSeek model distilled onto Llama or
// Qwen weights stays DeepSeek's.
const FAMILIES: [RegExp, Lab][] = [
  [/claude/, "anthropic"],
  [/deepseek/, "deepseek"],
  [/(^|[^a-z])(gpt|chatgpt|codex)([^a-z]|$)|(^|[^a-z0-9])o[134](-|$)/, "openai"],
  [/gemini|gemma/, "google"],
  [/kimi|moonshot/, "moonshot"],
  [/grok/, "xai"],
  [/mistral|mixtral|codestral|devstral|magistral|ministral|pixtral/, "mistral"],
  [/qwen|qwq/, "alibaba"],
  [/(^|[^a-z])glm([^a-z]|$)/, "zhipu"],
  [/minimax/, "minimax"],
  [/llama/, "meta"],
]

// Providers that serve only their own lab's models. A router, a cloud or a local server (OpenRouter, Bedrock, Vertex,
// Azure, Vector's free models, LM Studio) serves many labs, so its id says nothing.
const FIRST_PARTY: Record<string, Lab> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  deepseek: "deepseek",
  moonshotai: "moonshot",
  xai: "xai",
  mistral: "mistral",
}

/** A lab id as a known lab, or undefined: the Codium catalog's `lab` field, say. */
export function known(value: string | undefined): Lab | undefined {
  return LABS.find((lab) => lab === value)
}

/**
 * The lab behind `name` ("provider/model", the model id possibly holding a vendor segment). `hint` is a lab a catalog
 * states for the model, which wins when it names a known lab. Undefined when the vendor cannot be told.
 */
export function labOf(name: string, hint?: string): Lab | undefined {
  const stated = known(hint?.trim().toLowerCase())
  if (stated) return stated
  const segments = name.trim().toLowerCase().split("/").filter(Boolean)
  if (!segments.length) return undefined
  const [provider, ...rest] = segments
  // A vendor segment inside the model id ("openrouter/anthropic/claude-…", "vector-plan/deepseek/…").
  for (const segment of rest.slice(0, -1)) {
    const vendor = VENDORS[segment]
    if (vendor) return vendor
  }
  const model = rest.at(-1) ?? provider!
  for (const [pattern, lab] of FAMILIES) if (pattern.test(model)) return lab
  return rest.length ? FIRST_PARTY[provider!] : undefined
}

/** A lab's name as copy shows it. */
export function labName(lab: Lab): string {
  return NAMES[lab]
}
