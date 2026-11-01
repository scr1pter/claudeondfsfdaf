import { describe, expect, test } from "bun:test"
import {
  buildModelSections,
  codiumBadge,
  contextLabel,
  contextTitle,
  isCodingModel,
  isNewRelease,
  matchRank,
  modelAccess,
  modelAriaLabel,
  modelDisplayName,
  modelTitle,
  pickerCurrentRow,
  pickerHeaderKey,
  pickerKeyAction,
  pickerKeys,
  pickerModelKey,
  pickerModelName,
  pickerNavigation,
  pickerRowKey,
  pickerSectionLabel,
  pickerSectionViews,
  pickModel,
  readOpenSections,
  releaseTitle,
  toggleOpenSection,
  writeOpenSections,
  type PickerModel,
} from "../utils/provider-brand"
import {
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODELS_SHARED_COPY,
  FREE_MODELS_SIGN_IN,
  FREE_MODELS_UNAVAILABLE,
  FREE_MODEL_TRAINING_CONSENT_REQUIRED,
  FREE_MODEL_UNLISTED,
  FREE_ROUTER_NAME,
  freeModelName,
  freeModelsLimitMessage,
  freeModelTrainingLabel,
} from "@vectordevai/core/free-model-choice"
import { FREE_MODEL_TRAINING_QUESTION } from "../utils/free-model-policy-notice"
import { offInLocalProviders } from "../features/local/local-model"
import { OFF_IN_LOCAL, providerUnavailable } from "@vectordevai/schema/provider-unavailable"

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 11)
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10)
const MARKER = "vector-oauth-dummy-key"

type Provider = PickerModel["provider"]
const gateway: Provider = {
  id: "unlisted-service",
  name: "Unlisted service",
  source: "api",
  options: { apiKey: "public" },
}
const unlistedKey: Provider = { id: "unlisted-service", name: "Unlisted service", source: "api", options: {} }
const chatgpt: Provider = { id: "openai", name: "OpenAI", source: "custom", options: { apiKey: MARKER } }
const openaiKey: Provider = { id: "openai", name: "OpenAI", source: "api", options: {} }
const anthropicKey: Provider = { id: "anthropic", name: "Anthropic", source: "api", options: {} }
const anthropicEnv: Provider = {
  id: "anthropic",
  name: "Anthropic",
  source: "env",
  env: ["ANTHROPIC_API_KEY"],
  options: {},
}
const copilot: Provider = { id: "github-copilot", name: "GitHub Copilot", source: "custom", options: { apiKey: "" } }
const copilotToken: Provider = { id: "github-copilot", name: "GitHub Copilot", source: "env", options: {} }
const supergrok: Provider = { id: "xai", name: "xAI", source: "custom", options: { apiKey: MARKER } }
const xaiKey: Provider = { id: "xai", name: "xAI", source: "api", options: {} }
const snowflake: Provider = { id: "snowflake-cortex", name: "Snowflake", source: "custom", options: { apiKey: MARKER } }
const local: Provider = { id: "lmstudio", name: "LM Studio", source: "config", options: {} }

function model(provider: Provider, id: string, name: string, extra: Partial<PickerModel> = {}): PickerModel {
  return {
    id,
    name,
    provider,
    release_date: "2025-01-01",
    capabilities: { reasoning: true },
    limit: { context: 200_000 },
    cost: { input: 1 },
    ...extra,
  }
}

const unlistedModel = (id: string, name: string, extra: Partial<PickerModel> = {}) =>
  model(gateway, id, name, { cost: { input: 0 }, ...extra })

describe("modelAccess", () => {
  test("zero costs, old sign-in markers and empty keys never establish a subscription", () => {
    for (const provider of [chatgpt, copilot, supergrok, snowflake, local, gateway]) {
      for (const input of [0, 2])
        expect(modelAccess(model(provider, "coding", "Coding", { cost: { input } })).kind).toBe("none")
    }
    expect(
      modelAccess(model({ id: "openai", source: "custom" }, "coding", "Coding", { cost: { input: 0 } })).kind,
    ).toBe("none")
  })

  test("known API sources report the user's key without inferring inclusion", () => {
    for (const provider of [anthropicKey, anthropicEnv, openaiKey, xaiKey]) {
      const access = modelAccess(model(provider, "coding", "Coding", { cost: { input: 2 } }))
      expect(access.kind).toBe("key")
      expect(access.label).toBe("API key")
      expect(access.title).toBe(`Uses your ${provider.name} API key`)
    }
    expect(modelAccess(model(openaiKey, "custom", "Custom", { cost: { input: 0 } })).kind).toBe("none")
  })

  test("Vector Codium models say they are included in the Codium plan in their tooltip, spoken label and search", () => {
    const codium: Provider = { id: "vector-plan", name: "Vector Codium", source: "custom", env: [], options: {} }
    const coder = model(codium, "qwen/qwen3-coder-next", "Qwen3 Coder Next", { cost: { input: 0.12 } })
    expect(modelAccess(coder)).toEqual({
      kind: "codium",
      label: "Codium",
      title: "Included in your Vector Codium plan",
      spoken: "included in your Codium plan",
    })
    expect(modelTitle(coder)).toContain("Included in your Vector Codium plan")
    expect(modelAriaLabel(coder, NOW)).toContain("included in your Codium plan")
    expect(matchRank(coder, "codium", NOW)).toBe(3)
    // Usage is a share of the plan: no row says credits.
    expect(`${modelTitle(coder)} ${modelAriaLabel(coder, NOW)}`).not.toMatch(/credit/i)
    expect(matchRank(coder, "credits", NOW)).toBeUndefined()
    // The header is the provider's name alone: how its models are paid for is never on it.
    expect(buildModelSections({ models: [coder], now: NOW })).toEqual([
      {
        id: "provider:vector-plan",
        kind: "provider",
        label: "Vector Codium",
        providerID: "vector-plan",
        items: [coder],
      },
    ])
  })

  test("Vector Codium keeps its catalog's order, led by DeepSeek V4.1 Flash, as the engine lists it", () => {
    const codium: Provider = { id: "vector-plan", name: "Vector Codium", source: "custom", env: [], options: {} }
    // Codium models list no release date and no price, as Provider.fromModelPlans builds them.
    const catalog = [
      ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 262_144],
      ["xiaomi/mimo-v2.6-flash", "Xiaomi MiMo V2.6 Flash", 262_144],
      ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5", 32_768],
    ] as const
    const names = (provider: Provider) =>
      buildModelSections({
        models: catalog.map(([id, name, context]) =>
          model(provider, id, name, { release_date: "", cost: { input: 0 }, limit: { context } }),
        ),
        now: NOW,
      })
        .find((section) => section.kind === "provider")
        ?.items.map((item) => item.name)
    expect(names(codium)).toEqual(["DeepSeek V4.1 Flash", "Xiaomi MiMo V2.6 Flash", "Claude Haiku 5.5"])
    // Undated models of any other provider still sort by name.
    expect(names(local)).toEqual(["Claude Haiku 5.5", "DeepSeek V4.1 Flash", "Xiaomi MiMo V2.6 Flash"])
  })

  test("Codium Auto leads Vector Codium, and models the plan does not include carry their plan's badge", () => {
    const codium: Provider = { id: "vector-plan", name: "Vector Codium", source: "custom", env: [], options: {} }
    const entry = (id: string, name: string, extra: Partial<PickerModel> = {}) =>
      model(codium, id, name, { release_date: "", cost: { input: 0 }, limit: { context: 131_072 }, ...extra })
    const deepseek = entry("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", { codium: { role: "default" } })
    // The engine lists Auto after DeepSeek, as /models answers.
    const auto = entry("vector/codium-auto", "Codium Auto", {
      codium: { auto: { floor: "openai/gpt-6-luna", default: deepseek.id, ceiling: "openai/gpt-6-sol" } },
    })
    const sonnet = entry("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", {
      codium: { locked: { plan: "vector-100", name: "Max" } },
    })
    const preview = entry("labs/next", "Next", {
      codium: { locked: { plan: "vector-200", name: "Ultra", previewUntil: NOW + 30 * DAY } },
    })
    const sections = buildModelSections({ models: [deepseek, auto, sonnet, preview], now: NOW })
    expect(sections.find((section) => section.kind === "provider")?.items.map((item) => item.name)).toEqual([
      "Codium Auto",
      "DeepSeek V4.1 Flash",
      "Claude Sonnet 5.5",
      "Next",
    ])
    // A search keeps Auto first among equally good matches.
    expect(
      buildModelSections({ models: [deepseek, auto], term: "codium", now: NOW })[0]?.items.map((item) => item.name),
    ).toEqual(["Codium Auto", "DeepSeek V4.1 Flash"])

    expect(codiumBadge(sonnet)).toEqual({ label: "Codium · Max", title: "Included in Max and above" })
    expect(codiumBadge(preview)).toEqual({ label: "Preview · Ultra", title: "Only in Ultra during its preview" })
    expect(codiumBadge(deepseek)).toBeUndefined()
    expect(codiumBadge(auto)).toBeUndefined()
    // The tooltip and the spoken label say which plan includes it, never that the account's plan does, a price or
    // credits.
    expect(modelTitle(sonnet)).toContain("Included in Max and above")
    expect(modelTitle(sonnet)).not.toContain("Included in your Vector Codium plan")
    expect(modelAriaLabel(sonnet, NOW)).toContain("included in max and above")
    expect(modelAriaLabel(sonnet, NOW)).not.toContain("included in your codium plan")
    expect(modelTitle(deepseek)).toContain("Included in your Vector Codium plan")
    expect(`${modelTitle(sonnet)} ${modelAriaLabel(preview, NOW)}`).not.toMatch(/credit|\$/i)
    // Another provider's model never reads a Codium badge, whatever it carries.
    expect(codiumBadge(model(openaiKey, "gpt", "GPT", { codium: { locked: { plan: "x", name: "Max" } } }))).toBe(
      undefined,
    )
  })

  test("choosing a Codium model the plan does not include opens Change plan and keeps the current model", () => {
    const codium: Provider = { id: "vector-plan", name: "Vector Codium", source: "custom", env: [], options: {} }
    const locked = model(codium, "anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", {
      codium: { locked: { plan: "vector-100", name: "Max" } },
    })
    const usable = model(codium, "deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash")
    const manual = model(codium, "moonshotai/kimi-k3:long", "Kimi Long", { codium: { manualOnly: true } })
    const other = model(openaiKey, "gpt", "GPT", { codium: { locked: { plan: "x", name: "Max" } } })
    const calls: string[] = []
    const actions = { set: (item: PickerModel) => calls.push(`set ${item.id}`), plans: () => calls.push("plans") }
    for (const item of [locked, usable, manual, other]) pickModel(item, actions)
    expect(calls).toEqual(["plans", "set deepseek/deepseek-v4.1-flash", "set moonshotai/kimi-k3:long", "set gpt"])
  })

  test("ambiguous environment credentials and unlisted providers claim no access method", () => {
    expect(modelAccess(model(copilotToken, "coding", "Coding", { cost: { input: 2 } })).kind).toBe("none")
    expect(modelAccess(model(unlistedKey, "coding", "Coding", { cost: { input: 2 } })).kind).toBe("none")
  })
})

describe("isCodingModel", () => {
  // As the server sends them, with every output flag set.
  const output = (flags: { text?: boolean; audio?: boolean; image?: boolean }) => ({
    text: false,
    audio: false,
    image: false,
    video: false,
    pdf: false,
    ...flags,
  })
  const image = model(openaiKey, "gpt-image-2", "GPT Image 2", {
    capabilities: { reasoning: false, toolcall: false, output: output({ image: true }) },
  })
  const realtime = model(openaiKey, "gpt-realtime-2.1", "GPT Realtime 2.1", {
    capabilities: { reasoning: false, toolcall: true, output: output({ text: true, audio: true }) },
  })
  const chat = model(openaiKey, "gpt-5.5", "GPT-5.5", {
    capabilities: { reasoning: true, toolcall: true, output: output({ text: true }) },
  })
  const bare = model(local, "llama", "Llama", { capabilities: undefined })

  test("keeps models that call tools and answer in text; drops image and voice models", () => {
    expect(isCodingModel(image)).toBe(false)
    expect(isCodingModel(realtime)).toBe(false)
    expect(isCodingModel(chat)).toBe(true)
  })

  test("a missing field never hides a model", () => {
    expect(isCodingModel(bare)).toBe(true)
    expect(isCodingModel(model(local, "llama", "Llama", { capabilities: { reasoning: true } }))).toBe(true)
    // A catalogue entry without modalities arrives with every output flag false: unknown, not "no text".
    expect(isCodingModel(model(openaiKey, "x", "X", { capabilities: { toolcall: true, output: output({}) } }))).toBe(
      true,
    )
  })

  test("without capabilities, tool_call and modalities.output decide", () => {
    const configured = (extra: Partial<PickerModel>) => model(local, "m", "M", { capabilities: undefined, ...extra })
    expect(isCodingModel(configured({ tool_call: false, modalities: { output: ["image"] } }))).toBe(false)
    // Audio output alone keeps a model; only a voice model by name goes.
    expect(isCodingModel(configured({ modalities: { output: ["text", "audio"] } }))).toBe(true)
    expect(
      isCodingModel(
        model(local, "custom-realtime", "Custom Realtime", {
          capabilities: undefined,
          modalities: { output: ["text", "audio"] },
        }),
      ),
    ).toBe(false)
    expect(isCodingModel(configured({ tool_call: false }))).toBe(false)
    expect(isCodingModel(configured({ tool_call: true, modalities: { output: ["text"] } }))).toBe(true)
    expect(isCodingModel(configured({ modalities: { output: [] } }))).toBe(true)
  })

  test("the picker leaves them out, in every section and in search", () => {
    const models = [image, realtime, chat, bare]
    const browse = buildModelSections({ models, currentKey: pickerModelKey(image), now: NOW })
    expect(new Set(pickerKeys(browse))).toEqual(new Set([pickerModelKey(chat), pickerModelKey(bare)]))
    expect(browse.some((section) => section.kind === "recent")).toBe(false)
    expect(pickerKeys(buildModelSections({ models, term: "gpt", now: NOW }))).toEqual([pickerModelKey(chat)])
  })
})

describe("row text", () => {
  test("context labels", () => {
    expect(contextLabel(400_000)).toBe("400K")
    expect(contextLabel(262_144)).toBe("262K")
    expect(contextLabel(128_000)).toBe("128K")
    expect(contextLabel(1_048_576)).toBe("1M")
    expect(contextLabel(1_050_000)).toBe("1M")
    expect(contextLabel(1_500_000)).toBe("1.5M")
    expect(contextLabel(2_000_000)).toBe("2M")
    expect(contextLabel(0)).toBe("")
    expect(contextLabel(undefined)).toBe("")
    expect(contextTitle(400_000)).toBe("400,000-token context window")
  })

  test("new means released in the last 60 days", () => {
    expect(isNewRelease({ release_date: daysAgo(59) }, NOW)).toBe(true)
    expect(isNewRelease({ release_date: daysAgo(60) }, NOW)).toBe(true)
    expect(isNewRelease({ release_date: daysAgo(61) }, NOW)).toBe(false)
    expect(isNewRelease({ release_date: daysAgo(-3) }, NOW)).toBe(false)
    expect(isNewRelease({ release_date: "not a date" }, NOW)).toBe(false)
    expect(isNewRelease({}, NOW)).toBe(false)
  })

  test("release dates are shown in UTC", () => {
    expect(releaseTitle({ release_date: "2026-08-14" })).toBe("Released Aug 14, 2026")
    expect(releaseTitle({ release_date: "" })).toBe("")
  })

  test("aria-label reads the whole row", () => {
    const astra = model(chatgpt, "gpt-6-astra", "GPT-6 Astra", {
      release_date: "2026-09-04",
      cost: { input: 0 },
      limit: { context: 1_050_000 },
    })
    expect(modelAriaLabel(astra, NOW)).toBe("GPT-6 Astra, OpenAI, 1M context, reasoning, new")
    expect(modelAriaLabel(unlistedModel("sample-coder", "Sample Coder"), NOW)).toBe(
      "Sample Coder, Unlisted service, 200K context, reasoning",
    )
  })

  test("the row tooltip carries what the row leaves out", () => {
    const astra = model(chatgpt, "gpt-6-astra", "GPT-6 Astra", {
      release_date: "2026-09-04",
      cost: { input: 0 },
      limit: { context: 1_050_000 },
    })
    expect(modelTitle(astra)).toBe(
      "GPT-6 Astra\nOpenAI · Reasoning\n1,050,000-token context window\nReleased Sep 4, 2026",
    )
    const lightning = unlistedModel("sample-lightning", "Sample Lightning", {
      release_date: "2026-08-11",
      limit: { context: 262_144 },
      capabilities: { reasoning: false },
    })
    expect(modelTitle(lightning)).toBe(
      "Sample Lightning\nUnlisted service\n262,144-token context window\nReleased Aug 11, 2026",
    )
    const bare = model(local, "llama", "Llama", { capabilities: undefined, limit: undefined, release_date: "" })
    expect(modelTitle(bare)).toBe("Llama\nLM Studio")
  })
})

describe("buildModelSections", () => {
  const astra = model(chatgpt, "gpt-6-astra", "GPT-6 Astra", {
    release_date: "2026-09-04",
    cost: { input: 0 },
    limit: { context: 1_050_000 },
  })
  const sol = model(chatgpt, "gpt-5.6-sol", "GPT-5.6 Sol", {
    release_date: "2026-07-09",
    cost: { input: 0 },
    limit: { context: 400_000 },
  })
  const gpt55 = model(chatgpt, "gpt-5.5", "GPT-5.5", {
    release_date: "2026-04-23",
    cost: { input: 0 },
    limit: { context: 400_000 },
  })
  const opus = model(anthropicKey, "claude-opus-5", "Claude Opus 5", {
    release_date: "2026-07-24",
    cost: { input: 5 },
    limit: { context: 1_000_000 },
  })
  const sonnet = model(anthropicKey, "claude-sonnet-5", "Claude Sonnet 5", {
    release_date: "2026-06-30",
    cost: { input: 2 },
  })
  const pickle = unlistedModel("sample-coder", "Sample Coder", { release_date: "2025-10-17" })
  const muse = unlistedModel("sample-spark", "Sample Spark", {
    release_date: "2026-09-02",
    limit: { context: 1_048_576 },
  })
  const lightning = unlistedModel("sample-lightning", "Sample Lightning", {
    release_date: "2026-08-11",
    limit: { context: 262_144 },
    capabilities: { reasoning: false },
  })
  const ultra = unlistedModel("sample-ultra", "Sample Ultra", {
    release_date: "2026-03-11",
    limit: { context: 1_000_000 },
  })
  const mimo = unlistedModel("sample-small", "Sample Small", { release_date: "2026-05-20" })

  // Deliberately in no useful order: the unlisted roster first, the frontier model last.
  const models = [pickle, muse, lightning, ultra, mimo, gpt55, sol, sonnet, opus, astra]
  const popular = ["unlisted-a", "unlisted-b", "unlisted-c", "anthropic", "github-copilot", "openai", "google"]
  const build = (term = "", extra: { currentKey?: string; recentKeys?: string[] } = {}) =>
    buildModelSections({
      models,
      term,
      now: NOW,
      popular,
      currentKey: pickerModelKey(astra),
      recentKeys: [pickerModelKey(pickle), pickerModelKey(astra)],
      ...extra,
    })
  const keysOf = (items: PickerModel[]) => items.map(pickerModelKey)

  test("new models stay in their own section, newest first; there is no separate new-releases section", () => {
    const sections = build("", { currentKey: undefined, recentKeys: [] })
    expect(sections.map((section) => section.id)).toEqual(["provider:anthropic", "provider:openai"])
    expect(keysOf(sections.find((section) => section.id === "provider:openai")?.items ?? [])).toEqual([
      "openai:gpt-6-astra",
      "openai:gpt-5.6-sol",
      "openai:gpt-5.5",
    ])
    expect(pickerKeys(sections).some((key) => key.startsWith("unlisted-"))).toBe(false)
  })

  test("rows run newest first within a provider, the one in Recently used included", () => {
    const sections = build()
    expect(keysOf(sections[0].items)).toEqual(["openai:gpt-6-astra"])
    const openai = sections.find((section) => section.id === "provider:openai")
    expect(keysOf(openai?.items ?? [])).toEqual(["openai:gpt-6-astra", "openai:gpt-5.6-sol", "openai:gpt-5.5"])
  })

  test("a header holds only its name, its provider's mark and its models: no access or policy caption", () => {
    const sections = build()
    for (const section of sections)
      expect(Object.keys(section).sort()).toEqual(
        section.kind === "provider" ? ["id", "items", "kind", "label", "providerID"] : ["id", "items", "kind", "label"],
      )
    // An API key pays for Anthropic's models; only each row's tooltip and spoken label say so.
    const anthropic = sections.find((section) => section.id === "provider:anthropic")
    expect(anthropic?.label).toBe("Anthropic")
    expect(modelTitle(opus)).toContain("Uses your Anthropic API key")
    expect(modelAriaLabel(opus, NOW)).toContain("uses your API key")
  })

  test("a header counts every model of its provider, Recently used included, as the rows it opens", () => {
    const anthropic = build().find((section) => section.id === "provider:anthropic")!
    expect(anthropic.items).toHaveLength(2)
    expect(pickerSectionLabel(anthropic)).toBe("Anthropic, 2 models")
    // GPT-6 Astra is the current model, in Recently used, and still one of OpenAI's three.
    const openai = build().find((section) => section.id === "provider:openai")!
    expect(pickerSectionLabel(openai)).toBe("OpenAI, 3 models")
    expect(pickerSectionLabel({ label: "OpenAI", items: [sol] })).toBe("OpenAI, 1 model")
  })

  test("keys are unique and are exactly the render order, and every model appears once under its provider", () => {
    for (const sections of [build(), build("gpt"), build("free"), build("", { recentKeys: [] })]) {
      const walk: string[] = []
      for (const section of sections) for (const item of section.items) walk.push(pickerRowKey(section, item))
      expect(pickerKeys(sections)).toEqual(walk)
      expect(new Set(walk).size).toBe(walk.length)
      expect(sections.every((section) => section.items.length > 0)).toBe(true)
      const below = sections.filter((section) => section.kind !== "recent").flatMap((section) => keysOf(section.items))
      expect(new Set(below).size).toBe(below.length)
    }
    const listed = keysOf(models.filter((model) => model.provider.id !== "unlisted-service"))
    const browse = build()
    expect(
      new Set(keysOf(browse.filter((section) => section.kind !== "recent").flatMap((section) => section.items))),
    ).toEqual(new Set(listed))
    // The top section's rows are the same models again, under keys of their own.
    expect(pickerKeys(browse).slice(0, 1)).toEqual(["recent:openai:gpt-6-astra"])
  })

  test("the highlight rests on the current model's row in Recently used, or under its provider without it", () => {
    const open = new Set(["provider:openai"])
    const browse = pickerNavigation(pickerSectionViews(build(), open, ""))
    expect(browse.keys.filter((key) => key.endsWith("openai:gpt-6-astra"))).toEqual([
      "recent:openai:gpt-6-astra",
      "openai:gpt-6-astra",
    ])
    expect(pickerCurrentRow(browse, pickerModelKey(astra))).toBe("recent:openai:gpt-6-astra")
    expect(browse.rows.get("openai:gpt-6-astra")).toBe(astra)
    const searching = pickerNavigation(pickerSectionViews(build("gpt"), open, "gpt"))
    expect(pickerCurrentRow(searching, pickerModelKey(astra))).toBe("openai:gpt-6-astra")
    expect(pickerCurrentRow(searching, undefined)).toBeUndefined()
    expect(pickerCurrentRow(searching, pickerModelKey(opus))).toBeUndefined()
  })

  test("the top section holds at most three, skips models that aren't listed, and works without recent", () => {
    const recent = build("", {
      recentKeys: ["openai:gone", pickerModelKey(pickle), pickerModelKey(sonnet), pickerModelKey(gpt55)],
    })[0]
    expect(keysOf(recent.items)).toEqual(["openai:gpt-6-astra", "anthropic:claude-sonnet-5", "openai:gpt-5.5"])
    // Parallel Workspaces has no recent list: the section is just the current model.
    const parallel = build("", { recentKeys: undefined })[0]
    expect(keysOf(parallel.items)).toEqual(["openai:gpt-6-astra"])
    // A current model that is hidden or disconnected is left out; the list still starts cleanly.
    const hidden = build("", { currentKey: "openai:gone", recentKeys: [] })
    expect(hidden[0].id).toBe("provider:anthropic")
  })

  test("the top section says Current model until one of its rows comes from recent history", () => {
    // Parallel Workspaces passes no history, and a new user's current model is a default.
    expect(build("", { recentKeys: undefined })[0].label).toBe("Current model")
    expect(build("", { recentKeys: [] })[0].label).toBe("Current model")
    expect(build("", { recentKeys: ["openai:gone"] })[0].label).toBe("Current model")
    expect(build("", { recentKeys: [pickerModelKey(astra)] })[0].label).toBe("Recently used")
    // The current model was never used, but a recent one sits below it.
    expect(build("", { recentKeys: [pickerModelKey(pickle)] })[0].label).toBe("Current model")
  })

  test("searching drops the top section and puts the best match first", () => {
    const sections = build("astra")
    expect(sections.some((section) => section.kind === "recent")).toBe(false)
    expect(pickerKeys(sections)[0]).toBe("openai:gpt-6-astra")
    expect(pickerKeys(build("  ASTRA "))).toEqual(["openai:gpt-6-astra"])
  })

  test("searching orders sections by their best match, then popularity, then A to Z", () => {
    const zed: Provider = { id: "zai", name: "Zed", source: "api", options: {} }
    const beta: Provider = { id: "azure", name: "Beta", source: "api", options: {} }
    // Anthropic is the most popular provider here, but its only match is weak.
    const supernova = model(anthropicKey, "claude-supernova", "Claude Supernova")
    const novaPro = model(openaiKey, "nova-pro", "Nova Pro")
    const novaMini = model(zed, "nova-mini", "Nova Mini")
    const novaMax = model(beta, "nova-max", "Nova Max")
    const novaLite = unlistedModel("nova-lite-free", "Nova Lite Free")
    const items = [supernova, novaPro, novaMini, novaMax, novaLite]
    expect(matchRank(supernova, "nova", NOW)).toBe(2)
    expect(buildModelSections({ models: items, now: NOW, popular }).map((section) => section.id)).toEqual([
      "provider:anthropic",
      "provider:openai",
      "provider:azure",
      "provider:zai",
    ])
    const sections = buildModelSections({ models: items, term: "nova", now: NOW, popular })
    expect(sections.map((section) => section.id)).toEqual([
      "provider:openai",
      "provider:azure",
      "provider:zai",
      "provider:anthropic",
    ])
    expect(pickerKeys(sections)[0]).toBe("openai:nova-pro")
    // An unlisted provider never enters the search results.
    const bigwig = model(anthropicKey, "claude-bigwig", "Claude Bigwig")
    expect(
      buildModelSections({ models: [bigwig, pickle], term: "big", now: NOW, popular }).map((section) => section.id),
    ).toEqual(["provider:anthropic"])
  })

  test("searching by spec: context, access and capability words", () => {
    expect(new Set(pickerKeys(build("1m")))).toEqual(new Set(keysOf([astra, opus])))
    expect(new Set(pickerKeys(build("openai")))).toEqual(new Set(keysOf([astra, sol, gpt55])))
    // Unlisted provider terms do not introduce unavailable models.
    for (const term of ["included", "vector", "free"]) {
      const includedOnly = build(term)
      expect(includedOnly).toEqual([])
      expect(pickerKeys(includedOnly)).toEqual([])
    }
    expect(pickerKeys(build("zzz"))).toEqual([])
  })

  test("match rank beats release date inside a section", () => {
    const provider: Provider = { id: "groq", name: "Acme", source: "api", options: {} }
    const supernova = model(provider, "supernova", "Supernova", { release_date: "2026-09-01" })
    const bigNova = model(provider, "big-nova", "Big Nova", { release_date: "2026-08-01" })
    const novaMini = model(provider, "nova-mini", "Nova Mini", { release_date: "2026-01-01" })
    expect(matchRank(novaMini, "nova", NOW)).toBe(0)
    expect(matchRank(bigNova, "nova", NOW)).toBe(1)
    expect(matchRank(supernova, "nova", NOW)).toBe(2)
    const sections = buildModelSections({ models: [supernova, bigNova, novaMini], term: "nova", now: NOW })
    expect(pickerKeys(sections)).toEqual(["groq:nova-mini", "groq:big-nova", "groq:supernova"])
  })

  test("providers follow the popular order, then the rest alphabetically; nothing listed means no sections", () => {
    const zed: Provider = { id: "zai", name: "Zed", source: "api", options: {} }
    const beta: Provider = { id: "azure", name: "Beta", source: "api", options: {} }
    const sections = buildModelSections({
      models: [model(zed, "z", "Z"), model(beta, "b", "B"), sonnet, gpt55],
      now: NOW,
      popular,
    })
    expect(sections.map((section) => section.id)).toEqual([
      "provider:anthropic",
      "provider:openai",
      "provider:azure",
      "provider:zai",
    ])
    expect(buildModelSections({ models: [], now: NOW, popular })).toEqual([])
  })
})

describe("edge cases from review", () => {
  const audioToo = { text: true, image: true, audio: true, video: false, pdf: false }

  test("a coding model that can also answer in audio stays, and voice models still go", () => {
    const azure: Provider = { id: "azure", name: "Azure", source: "env", env: ["AZURE_API_KEY"], options: {} }
    const codex = model(azure, "gpt-5.1-codex", "GPT-5.1 Codex", {
      capabilities: { reasoning: true, toolcall: true, output: audioToo },
    })
    const voice = model(azure, "gpt-realtime-2.1", "GPT Realtime 2.1", {
      capabilities: { reasoning: false, toolcall: true, output: audioToo },
    })
    expect(isCodingModel(codex)).toBe(true)
    expect(isCodingModel(voice)).toBe(false)
  })

  test("an env var counts as a key only when it is the provider's single var", () => {
    const vertex: Provider = {
      id: "google-vertex",
      name: "Vertex",
      source: "env",
      env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
      options: {},
    }
    expect(modelAccess(model(vertex, "gemini-3-pro", "Gemini 3 Pro", { cost: { input: 2 } })).kind).toBe("none")
    expect(
      modelAccess(model(anthropicEnv, "claude-fable-5-1", "Claude Fable 5.1", { cost: { input: 10 } })).label,
    ).toBe("API key")
  })

  test("a sign-in that isn't a known plan claims nothing, even with a key env var set", () => {
    const xaiBoth: Provider = {
      id: "xai",
      name: "xAI",
      source: "env",
      env: ["XAI_API_KEY"],
      options: { apiKey: MARKER },
    }
    expect(modelAccess(model(xaiBoth, "grok-4.6", "Grok 4.6", { cost: { input: 2 } })).kind).toBe("none")
  })
})

test("retired providers are excluded from current, recent, provider and search sections", () => {
  const retired = ["unlisted-a", "unlisted-b", "unlisted-c", "unlisted-d"].map((id) =>
    model({ id, source: "api", options: { apiKey: "test-only" } }, "coding", "Coding model", { cost: { input: 3 } }),
  )
  const available = model(anthropicKey, "claude", "Claude")
  for (const term of ["", "coding", "vector"]) {
    const sections = buildModelSections({
      models: [...retired, available],
      term,
      currentKey: pickerModelKey(retired[0]),
      recentKeys: retired.map(pickerModelKey),
      now: NOW,
    })
    expect(sections.flatMap((section) => section.items).some((item) => item.provider.id.startsWith("unlisted-"))).toBe(
      false,
    )
  }
  for (const item of retired) expect(modelAccess(item).kind).toBe("none")
})

test("custom providers remain available in current, recent and searched model choices", () => {
  const custom = model({ id: "ollama", name: "Ollama", source: "config" }, "coder", "Local Coder")
  for (const term of ["", "local", "ollama"]) {
    expect(
      pickerKeys(
        buildModelSections({
          models: [custom],
          term,
          currentKey: pickerModelKey(custom),
          recentKeys: [pickerModelKey(custom)],
          now: NOW,
        }),
      ),
    ).toEqual(term ? [pickerModelKey(custom)] : [`recent:${pickerModelKey(custom)}`, pickerModelKey(custom)])
  }
})

test("paused Copilot models from an older server never enter selectable sections", () => {
  const sections = buildModelSections({
    models: [
      model(copilot, "coding", "Copilot Coding"),
      model(copilotToken, "coding", "Copilot Coding"),
      model(openaiKey, "coding", "OpenAI Coding"),
    ],
    now: Date.now(),
    popular: ["github-copilot", "openai"],
  })
  expect(sections.flatMap((section) => section.items).map((item) => item.provider.id)).toEqual(["openai"])
})

test("only the server-marked approved plugin makes a paused provider selectable", () => {
  const approved = model({ ...copilot, options: { vectorOAuthPlugin: "a".repeat(64) } }, "coding", "Plugin Coding")
  expect(pickerKeys(buildModelSections({ models: [approved], now: NOW }))).toEqual(["github-copilot:coding"])
  for (const value of [undefined, "approved", "A".repeat(64)]) {
    const unapproved = { ...approved, provider: { ...copilot, options: { vectorOAuthPlugin: value } } }
    expect(pickerKeys(buildModelSections({ models: [unapproved], now: NOW }))).toEqual([])
  }
})

describe("Free models inside of Vector", () => {
  const shared = model({ id: "vector", name: "Vector", source: "custom" }, "maker/coder:free", "Maker Coder:free", {
    freeModel: { source: "shared" },
    cost: { input: 0, output: 0 },
  })
  const own = {
    ...shared,
    provider: { id: "openrouter", name: "OpenRouter", source: "api" },
    freeModel: { source: "openrouter" as const },
  }
  test("the section holds the free models Vector provides; a copy on the user's own account sits with its provider", () => {
    // Rows carry no source caption, so the two copies are told apart by where they are listed: Vector's copy under
    // Free models inside of Vector, the user's own under that provider, named "(free)" beside its paid models.
    const paid = model(own.provider, "maker/paid", "Maker Paid", { cost: { input: 2 } })
    for (const models of [
      [shared, own, paid],
      [paid, own, shared],
    ]) {
      const sections = buildModelSections({ models, now: NOW })
      expect(sections.map((section) => [section.label, section.items.map(pickerModelKey)])).toEqual([
        ["Free models inside of Vector", [pickerModelKey(shared)]],
        ["OpenRouter", expect.arrayContaining([pickerModelKey(own), pickerModelKey(paid)])],
      ])
      // The current one sits in Recently used, on top, and stays in its own section too.
      const recent = buildModelSections({
        models,
        now: NOW,
        currentKey: pickerModelKey(shared),
        recentKeys: [pickerModelKey(shared)],
      })
      expect(recent.map((section) => section.label)).toEqual([
        "Recently used",
        "Free models inside of Vector",
        "OpenRouter",
      ])
      expect(recent[0].items).toEqual([shared])
      expect(recent[1].items).toEqual([shared])
    }
    expect(modelDisplayName(own)).toBe("Maker Coder")
    expect(pickerModelName(own)).toBe("Maker Coder (free)")
    expect(pickerModelName(shared)).toBe("Maker Coder")
    expect(pickerModelName({ ...own, name: "Maker Coder (free)" })).toBe("Maker Coder (free)")
    expect(pickerModelName(paid)).toBe("Maker Paid")
    // The tooltip and the spoken label still say where each copy runs.
    expect(modelTitle(own)).toContain("Your OpenRouter account")
    expect(modelTitle(shared)).toContain("Provided by Vector")
    expect(modelAriaLabel(own, NOW)).toStartWith("Maker Coder (free), OpenRouter")
  })
  test('a model whose provider may train shows only "May train on your prompts", on its row, tooltip and spoken label', () => {
    const laguna = {
      ...own,
      id: "poolside/laguna-s-2.1:free",
      name: "Poolside: Laguna S 2.1",
      freeModel: { source: "openrouter" as const, dataPolicy: "may-train" as const },
    }
    const noTraining = { ...own, freeModel: { source: "openrouter" as const, dataPolicy: "no-training" as const } }
    // The header says nothing about training: each row that may train carries the label itself.
    const [mixed] = buildModelSections({ models: [noTraining, laguna], now: NOW })
    expect(Object.keys(mixed).sort()).toEqual(["id", "items", "kind", "label", "providerID"])
    expect(modelTitle(laguna)).toContain("May train on your prompts")
    expect(modelAriaLabel(laguna, NOW)).toContain("May train on your prompts")
    // No disclaimer paragraph anywhere in the row: the one-time acceptance question explains the label.
    for (const text of [modelTitle(laguna), modelAriaLabel(laguna, NOW)]) {
      expect(text).not.toContain("Vector itself never trains")
      expect(text).not.toContain("may log your prompts")
    }
    expect(FREE_MODEL_TRAINING_QUESTION.description).toContain("Vector itself never trains on your prompts.")
    expect(modelTitle(noTraining)).not.toContain("May train")
    expect(freeModelTrainingLabel(noTraining)).toBeUndefined()
    // An unreviewed model, and the free router, carry the same yellow label and nothing more.
    const unreviewed = { ...laguna, freeModel: { source: "openrouter" as const, dataPolicy: "unreviewed" as const } }
    expect(freeModelTrainingLabel(unreviewed)).toBe(FREE_MODEL_TRAINING_LABEL)
    expect(modelTitle(unreviewed)).not.toContain("has not reviewed")
    const router = { ...shared, id: "openrouter/free", name: "Free Models Router", freeModel: laguna.freeModel }
    expect(freeModelTrainingLabel(router)).toBe(FREE_MODEL_TRAINING_LABEL)
    expect(modelTitle(router)).not.toContain("at random")
  })
  test("every served model is listed, no-training ones first and the free router last, NVIDIA's and new ones too", () => {
    // Owner, 23 October 2026: all of OpenRouter's free models, NVIDIA's included, and new ones as they appear.
    const vector: Provider = { id: "vector", name: "Vector", source: "custom" }
    const free = (
      id: string,
      name: string,
      dataPolicy: "may-train" | "no-training",
      extra: Partial<PickerModel> = {},
    ) =>
      model(vector, id, name, {
        freeModel: { source: "shared", dataPolicy },
        cost: { input: 0, output: 0 },
        release_date: "",
        capabilities: { toolcall: true, output: { text: true } },
        ...extra,
      })
    const served = [
      free("openrouter/free", "Free Models Router", "may-train"),
      free("thinkingmachines/inkling:free", "Thinking Machines: Inkling", "may-train"),
      free("nvidia/nemotron-3.5-lightning:free", "NVIDIA: Nemotron 3.5 Lightning", "may-train"),
      free("recursive/flint-v1.0:free", "Recursive: Flint", "may-train"),
      free("xingchen-agi/xing4.0-29b-a4b:free", "XingChen: Xing4.0 29B A4B", "no-training"),
      free("cohere/north-mini-code:free", "Cohere: North Mini Code", "no-training"),
    ]
    const own = {
      ...served[2],
      provider: { id: "openrouter", name: "OpenRouter", source: "api" },
      freeModel: { source: "openrouter" as const, dataPolicy: "may-train" as const },
    }
    const sections = buildModelSections({ models: [...served, own], now: NOW })
    expect(sections.map((section) => section.label)).toEqual(["Free models inside of Vector", "OpenRouter"])
    expect(sections[0].items.map(pickerModelKey)).toEqual([
      "vector:cohere/north-mini-code:free",
      "vector:xingchen-agi/xing4.0-29b-a4b:free",
      "vector:nvidia/nemotron-3.5-lightning:free",
      "vector:recursive/flint-v1.0:free",
      "vector:thinkingmachines/inkling:free",
      "vector:openrouter/free",
    ])
    // Only the label marks the ones that may train; no-training rows carry nothing.
    expect(sections[0].items.map((item) => freeModelTrainingLabel(item) ?? "")).toEqual([
      "",
      "",
      ...Array(4).fill(FREE_MODEL_TRAINING_LABEL),
    ])
    expect(sections[1].items.map(pickerModelKey)).toEqual(["openrouter:nvidia/nemotron-3.5-lightning:free"])
    expect(pickerModelName(sections[1].items[0])).toBe("NVIDIA: Nemotron 3.5 Lightning (free)")
    for (const item of sections[0].items) expect(modelTitle(item)).not.toMatch(/NVIDIA's|trial|evaluation|reviewed/i)
  })
  test("OFF metadata removal hides the section; ordinary zero-price models do not recreate it", () => {
    const sections = buildModelSections({ models: [{ ...own, freeModel: undefined }], now: NOW })
    expect(sections.some((section) => section.kind === "free")).toBe(false)
  })

  test("no included model's row, label, notice or user-visible error names OpenRouter", () => {
    const vector: Provider = { id: "vector", name: "Vector", source: "custom" }
    const free = (id: string, name: string, dataPolicy: "may-train" | "no-training" | "unreviewed") =>
      model(vector, id, name, { freeModel: { source: "shared", dataPolicy }, cost: { input: 0, output: 0 } })
    const included = [
      free("openrouter/free", "Free Models Router", "may-train"),
      free("maker/prefixed:free", "OpenRouter: Maker Prefixed (free)", "may-train"),
      free("maker/suffixed:free", "Maker Suffixed (OpenRouter)", "unreviewed"),
      free("cohere/north-mini-code:free", "Cohere: North Mini Code", "no-training"),
    ]
    expect(modelDisplayName(included[0])).toBe(FREE_ROUTER_NAME)
    expect(FREE_ROUTER_NAME).toBe("Auto (free)")
    expect(modelDisplayName(included[1])).toBe("Maker Prefixed")
    expect(modelDisplayName(included[2])).toBe("Maker Suffixed")
    // An engine that already names the router "Auto (free)" keeps that name, suffix and all.
    expect(freeModelName({ name: FREE_ROUTER_NAME })).toBe(FREE_ROUTER_NAME)
    const sections = buildModelSections({
      models: included,
      now: NOW,
      currentKey: pickerModelKey(included[0]),
      recentKeys: [pickerModelKey(included[1])],
    })
    const shown = [
      ...sections.flatMap((section) => [section.label, pickerSectionLabel(section)]),
      ...included.flatMap((item) => [
        modelDisplayName(item),
        pickerModelName(item),
        modelTitle(item),
        modelAriaLabel(item, NOW),
        freeModelTrainingLabel(item) ?? "",
      ]),
      FREE_MODEL_TRAINING_QUESTION.title,
      FREE_MODEL_TRAINING_QUESTION.description,
      FREE_MODELS_SHARED_COPY,
      FREE_MODELS_SIGN_IN,
      FREE_MODELS_UNAVAILABLE,
      FREE_MODEL_TRAINING_CONSENT_REQUIRED,
      FREE_MODEL_UNLISTED,
      ...(["user_daily", "user_minute", "shared_daily", "upstream", "balance"] as const).flatMap((reason) => [
        freeModelsLimitMessage({ reason, resetAt: NOW }),
        freeModelsLimitMessage({ reason, resetAt: NOW }, { terminal: true }),
      ]),
    ]
    expect(shown.filter((text) => /openrouter/i.test(text))).toEqual([])
    // Owner, 23 October 2026: nor an allowance, nor shared with other people.
    expect(shown.filter((text) => /allowance|\bshared\b|\bpool(?:ed)?\b/i.test(text))).toEqual([])
  })
})

describe("Recently used on top", () => {
  const vector: Provider = { id: "vector", name: "Vector", source: "custom" }
  const free = model(vector, "maker/coder:free", "Maker Coder", {
    freeModel: { source: "shared", dataPolicy: "no-training" },
    cost: { input: 0, output: 0 },
  })
  const opus = model(anthropicKey, "claude-opus-5", "Claude Opus 5", { cost: { input: 5 } })
  const sonnet = model(anthropicKey, "claude-sonnet-5", "Claude Sonnet 5", { cost: { input: 2 } })
  const gpt = model(openaiKey, "gpt-5.5", "GPT-5.5", { cost: { input: 2 } })
  const models = [gpt, sonnet, opus, free]
  const popular = ["anthropic", "openai"]

  test("comes first, above every provider and above the free models, which still list its models", () => {
    const sections = buildModelSections({
      models,
      now: NOW,
      popular,
      currentKey: pickerModelKey(gpt),
      recentKeys: [pickerModelKey(free), pickerModelKey(opus)],
    })
    expect(sections.map((section) => section.id)).toEqual(["recent", "free", "provider:anthropic", "provider:openai"])
    expect(keysOfSection(sections[0])).toEqual([pickerModelKey(gpt), pickerModelKey(free), pickerModelKey(opus)])
    expect(keysOfSection(sections[1])).toEqual([pickerModelKey(free)])
    expect(keysOfSection(sections[2])).toEqual([pickerModelKey(opus), pickerModelKey(sonnet)])
    expect(keysOfSection(sections[3])).toEqual([pickerModelKey(gpt)])
    // With models left over, the free models follow the top section and lead the providers.
    const fewer = buildModelSections({ models, now: NOW, popular, currentKey: pickerModelKey(opus) })
    expect(fewer.map((section) => section.id)).toEqual(["recent", "free", "provider:anthropic", "provider:openai"])
    expect(fewer[0].label).toBe("Current model")
  })

  test("the top section is always open and first in keyboard order; the rest start closed", () => {
    const sections = buildModelSections({ models, now: NOW, popular, currentKey: pickerModelKey(opus) })
    const views = pickerSectionViews(sections, new Set(), "")
    expect(views.map((view) => [view.section.id, view.toggle, view.open])).toEqual([
      ["recent", false, true],
      ["free", true, false],
      ["provider:anthropic", true, false],
      ["provider:openai", true, false],
    ])
    expect(pickerNavigation(views).keys).toEqual([
      pickerRowKey({ kind: "recent" }, opus),
      "section:free",
      "section:provider:anthropic",
      "section:provider:openai",
    ])
  })

  function keysOfSection(section: { items: PickerModel[] }) {
    return section.items.map(pickerModelKey)
  }
})

describe("provider headers open and close their models", () => {
  const vector: Provider = { id: "vector", name: "Vector", source: "custom" }
  const free = model(vector, "maker/coder:free", "Maker Coder", {
    freeModel: { source: "shared", dataPolicy: "may-train" },
    cost: { input: 0, output: 0 },
  })
  const opus = model(anthropicKey, "claude-opus-5", "Claude Opus 5", { cost: { input: 5 } })
  const sonnet = model(anthropicKey, "claude-sonnet-5", "Claude Sonnet 5", { cost: { input: 2 } })
  const gpt = model(openaiKey, "gpt-5.5", "GPT-5.5", { cost: { input: 2 } })
  const sections = (term = "") =>
    buildModelSections({ models: [gpt, sonnet, opus, free], term, now: NOW, popular: ["anthropic", "openai"] })
  const anthropic = "provider:anthropic"

  test("clicking Anthropic shows its models, and clicking it again closes them", () => {
    const opened = toggleOpenSection(new Set(), anthropic)
    expect([...opened]).toEqual([anthropic])
    const views = pickerSectionViews(sections(), opened, "")
    expect(views.find((view) => view.section.id === anthropic)?.open).toBe(true)
    expect(pickerNavigation(views).keys).toEqual([
      "section:free",
      "section:provider:anthropic",
      pickerModelKey(opus),
      pickerModelKey(sonnet),
      "section:provider:openai",
    ])
    const closed = toggleOpenSection(opened, anthropic)
    expect([...closed]).toEqual([])
    expect(pickerNavigation(pickerSectionViews(sections(), closed, "")).keys).toEqual([
      "section:free",
      "section:provider:anthropic",
      "section:provider:openai",
    ])
    // Toggling makes a new set, so the remembered one is never changed under a picker.
    expect([...opened]).toEqual([anthropic])
  })

  test("while searching every section with a match is open, and clearing the search restores what was open", () => {
    const open = new Set([anthropic])
    const searching = pickerSectionViews(sections("5"), open, "5")
    expect(searching.every((view) => view.open && !view.toggle)).toBe(true)
    // Headers drop out of keyboard order while searching, so Enter selects the best match.
    const navigation = pickerNavigation(searching)
    expect(navigation.headers.size).toBe(0)
    expect(navigation.keys).toEqual(pickerKeys(sections("5")))
    const cleared = pickerSectionViews(sections(), open, "")
    expect(cleared.filter((view) => view.open).map((view) => view.section.id)).toEqual([anthropic])
  })

  test("a provider that is the only one with a header still opens and closes when clicked", () => {
    // Signed out with only Anthropic connected, there is no free-models section: clicking Anthropic must still work.
    const only = buildModelSections({ models: [opus, sonnet], now: NOW, currentKey: pickerModelKey(opus) })
    const view = (open: ReadonlySet<string>) =>
      pickerSectionViews(only, open, "").map((view) => [view.section.id, view.toggle, view.open])
    expect(view(new Set())).toEqual([
      ["recent", false, true],
      [anthropic, true, false],
    ])
    const opened = toggleOpenSection(new Set(), anthropic)
    expect(view(opened)).toEqual([
      ["recent", false, true],
      [anthropic, true, true],
    ])
    // Claude Opus 5 is in Recently used and under Anthropic, each row with its own key.
    expect(pickerNavigation(pickerSectionViews(only, opened, "")).keys).toEqual([
      "recent:anthropic:claude-opus-5",
      "section:provider:anthropic",
      pickerModelKey(opus),
      pickerModelKey(sonnet),
    ])
    expect(view(toggleOpenSection(opened, anthropic))).toEqual([
      ["recent", false, true],
      [anthropic, true, false],
    ])
  })

  test("the arrow keys move through visible headers and rows; Enter or Space on a header toggles it", () => {
    const views = pickerSectionViews(sections(), new Set([anthropic]), "")
    const visible = pickerNavigation(views)
    const navigation = { keys: [...visible.keys, "action:connect-provider"], headers: visible.headers }
    const header = pickerHeaderKey({ id: anthropic })
    expect(pickerKeyAction({ key: "ArrowDown" }, navigation, "section:free")).toEqual({ move: header })
    expect(pickerKeyAction({ key: "ArrowDown" }, navigation, header)).toEqual({ move: pickerModelKey(opus) })
    expect(pickerKeyAction({ key: "ArrowUp" }, navigation, header)).toEqual({ move: "section:free" })
    // Wraps at either end, through Connect provider.
    expect(pickerKeyAction({ key: "ArrowUp" }, navigation, "section:free")).toEqual({
      move: "action:connect-provider",
    })
    expect(pickerKeyAction({ key: "Enter" }, navigation, header)).toEqual({ toggle: anthropic })
    expect(pickerKeyAction({ key: " " }, navigation, header)).toEqual({ toggle: anthropic })
    expect(pickerKeyAction({ key: "Enter" }, navigation, pickerModelKey(opus))).toEqual({
      select: pickerModelKey(opus),
    })
    // Space on a row types into search; Enter while composing text does nothing.
    expect(pickerKeyAction({ key: " " }, navigation, pickerModelKey(opus))).toBeUndefined()
    expect(pickerKeyAction({ key: "Enter", isComposing: true }, navigation, header)).toBeUndefined()
    expect(pickerKeyAction({ key: "a" }, navigation, header)).toBeUndefined()
    // A provider whose id looks like a header's key is still a row.
    const lookalike = { keys: ["section:free"], headers: new Map<string, string>() }
    expect(pickerKeyAction({ key: "Enter" }, lookalike, "section:free")).toEqual({ select: "section:free" })
  })

  test("which sections are open is remembered, and blocked or unreadable storage still works", () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    expect([...readOpenSections(() => storage)]).toEqual([])
    writeOpenSections(new Set([anthropic, "free"]), () => storage)
    expect([...readOpenSections(() => storage)]).toEqual([anthropic, "free"])
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    expect([...readOpenSections(() => blocked)]).toEqual([])
    expect(() => writeOpenSections(new Set([anthropic]), () => blocked)).not.toThrow()
    expect([...readOpenSections(() => undefined)]).toEqual([])
    for (const value of ["not json", '{"a":1}', '[1, "free", null]']) {
      store.set([...store.keys()][0], value)
      expect([...readOpenSections(() => storage)]).toEqual(value.startsWith("[") ? ["free"] : [])
    }
  })
})

describe("Off in Vector Local", () => {
  // The engine lists a provider Vector Local keeps off as unavailable, with why; the picker's collapsed group shows it
  // under the models instead of letting it vanish.
  test("the group lists each provider kept off, with the engine's reason and nothing else", () => {
    const off = offInLocalProviders([
      providerUnavailable("openai", "off-in-local"),
      { id: "vector", reason: "off-in-local", message: `vector: off in Vector Local. ${OFF_IN_LOCAL.vector}` },
      { id: "ollama", reason: "off-in-local", message: `ollama: off in Vector Local. ${OFF_IN_LOCAL.ollama}` },
      providerUnavailable("anthropic", "no-models"),
      providerUnavailable("xai", "sign-in-paused"),
    ])
    expect(off).toEqual([
      { id: "ollama", why: OFF_IN_LOCAL.ollama },
      { id: "openai", why: OFF_IN_LOCAL.listed },
      { id: "vector", why: OFF_IN_LOCAL.vector },
    ])
  })

  test("with Vector Local off, or nothing kept off, the group is empty and the picker shows none", () => {
    expect(offInLocalProviders(undefined)).toEqual([])
    expect(offInLocalProviders([providerUnavailable("anthropic", "disabled")])).toEqual([])
  })
})

test("Gemma free rows announce the US only tag without changing model identity or enabling paid copies", () => {
  const gemma: PickerModel = {
    id: "google/gemma-4-31b-it:free",
    name: "Google: Gemma 4 31B (free)",
    provider: { id: "vector", name: "Vector" },
    freeModel: { source: "shared", dataPolicy: "no-training" },
  }
  expect(modelAriaLabel(gemma, NOW)).toContain("US only")
  expect(modelTitle(gemma)).toContain("US only")
  expect(pickerModelKey(gemma)).toBe("vector:google/gemma-4-31b-it:free")
  expect(modelTitle({ ...gemma, freeModel: undefined })).not.toContain("US only")
})
