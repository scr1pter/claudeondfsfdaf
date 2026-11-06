import { describe, expect, test } from "bun:test"
import { openRouterModelRouting } from "@vectordevai/core/free-model-catalog"
import {
  decideRoute,
  ROUTE_REFUSALS,
  zdrBodyRefusal,
  zdrRequestBody,
  type RouteModel,
  type RouteRefusal,
} from "@vectordevai/core/review/privacy"

// The zero data retention route rules (VS-23a). Nothing calls them yet; these pin each rule of contract §4 VS-23a.

const OLLAMA = "@ai-sdk/openai-compatible"
const OPENROUTER_NPM = "@openrouter/ai-sdk-provider"
const OPENROUTER_URL = "https://openrouter.ai/api/v1"

const local = (url: string, overrides: Partial<RouteModel> = {}): RouteModel => ({
  providerID: "ollama",
  modelID: "qwen3-coder:30b",
  npm: OLLAMA,
  destinations: [url],
  ...overrides,
})
const openRouter = (overrides: Partial<RouteModel> = {}): RouteModel => ({
  providerID: "openrouter",
  modelID: "anthropic/claude-sonnet-5",
  npm: OPENROUTER_NPM,
  destinations: [OPENROUTER_URL, undefined],
  price: { input: 3, output: 15 },
  ...overrides,
})
const anthropic = (overrides: Partial<RouteModel> = {}): RouteModel => ({
  providerID: "anthropic",
  modelID: "claude-sonnet-5",
  npm: "@ai-sdk/anthropic",
  destinations: ["https://api.anthropic.com/v1"],
  defaultOrigins: ["https://api.anthropic.com"],
  ...overrides,
})

const CODIUM: RouteModel = {
  providerID: "vector-plan",
  modelID: "auto",
  destinations: ["https://vectordev.ai/api/model-plans"],
}

// Every name and host a fixture below uses, attested at once.
const EVERYTHING = [
  "openrouter",
  "vector",
  "vector-plan",
  "anthropic",
  "amazon-bedrock",
  "ollama",
  "acme",
  "my-or",
  "127.0.0.1",
  "localhost",
  "10.0.0.5",
  "gpu-box",
  "vectordev.ai",
  "openrouter.ai",
  "api.anthropic.com",
  "proxy.example.com",
]

// The decision as one word: the kind it allows, or why it refuses.
function verdict(model: RouteModel, attested: readonly string[] = []) {
  const decision = decideRoute(model, { privacy: "zdr", attested })
  return decision.allowed ? decision.kind : decision.refusal
}

const FIXTURES: RouteModel[] = [
  local("http://127.0.0.1:11434/v1"),
  local("http://10.0.0.5:11434/v1"),
  local("http://gpu-box:8080/v1"),
  local("http://127.0.0.1:11434/v1", { modelID: "fable" }),
  local("http://127.0.0.1:11434/v1", { forwards: true }),
  openRouter(),
  openRouter({ modelID: "qwen/qwen3-coder:free" }),
  openRouter({ modelID: "openrouter/auto" }),
  openRouter({ modelID: "anthropic/claude-fable-5.1" }),
  openRouter({ destinations: [OPENROUTER_URL, "https://proxy.example.com/v1"] }),
  anthropic(),
  anthropic({ modelID: "claude-fable-5" }),
  CODIUM,
  { providerID: "vector", modelID: "qwen/qwen3-coder:free", destinations: ["https://vectordev.ai/api/free-models"] },
  { providerID: "acme", modelID: "coder", destinations: [] },
]

describe("the refusal vocabulary", () => {
  test("is exactly the contract's", () => {
    expect([...ROUTE_REFUSALS]).toEqual([
      "free-model",
      "router-or-preset",
      "fallback-models",
      "plugins",
      "unattested-provider",
      "unattested-openrouter",
      "unattested-network-server",
      "retention-required-model",
      "codium-unaccepted",
      "batch",
      "unreadable-body",
      "unattributed-request",
      "unknown-destination",
    ])
  })
})

describe("decideRoute", () => {
  test('under "standard" no rule applies, as before VS-23', () => {
    for (const model of FIXTURES)
      for (const attested of [[], EVERYTHING])
        expect(decideRoute(model, { privacy: "standard", attested })).toEqual({ allowed: true, kind: "standard" })
  })

  test('under "zdr" no route is ever "standard"', () => {
    for (const model of FIXTURES)
      for (const attested of [[], EVERYTHING]) expect(verdict(model, attested)).not.toBe("standard")
  })

  test("a server on this computer is allowed, by LocalPolicy's rule", () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://127.8.9.10/v1",
      "http://localhost:1234/v1",
      "http://LOCALHOST./v1",
      "http://[::1]:8080/v1",
      "http://0.0.0.0:11434",
      "http://[::]:8080",
    ])
      expect(verdict(local(url))).toBe("loopback")
    // A name under localhost is not this computer by its name alone, so it is a host on the internet.
    expect(verdict(local("http://app.localhost:8080/v1"))).toBe("unattested-provider")
  })

  test("a server on your network is refused unless its host is attested", () => {
    for (const url of [
      "http://10.0.0.5:11434/v1",
      "http://172.16.0.2/v1",
      "http://172.31.255.1/v1",
      "http://192.168.1.20:8080/v1",
      "http://169.254.1.1/v1",
      "http://[fd00::1]:8080/v1",
      "http://[fe80::1]/v1",
      "http://gpu-box:8080/v1",
      "http://studio.local:1234/v1",
      "http://box.lan/v1",
      "http://models.internal/v1",
      "http://nas.home.arpa/v1",
      "http://gpu.tail1234.ts.net/v1",
    ])
      expect(verdict(local(url))).toBe("unattested-network-server")
    // Attested by host, in any case: alone for every port, or with a port for that port only. The provider ID never
    // covers a server on your network.
    expect(verdict(local("http://gpu-box:8080/v1"), ["GPU-Box"])).toBe("attested-host")
    expect(verdict(local("http://gpu-box:8080/v1"), ["GPU-Box:8080"])).toBe("attested-host")
    expect(verdict(local("http://gpu-box:8080/v1"), ["GPU-Box:9999"])).toBe("unattested-network-server")
    expect(verdict(local("http://gpu-box:4000/v1"), ["gpu-box:8080"])).toBe("unattested-network-server")
    expect(verdict(local("http://192.168.1.20:8080/v1"), ["192.168.1.20"])).toBe("attested-host")
    expect(verdict(local("http://[fd00::1]:8080/v1"), ["[FD00::1]:8080"])).toBe("attested-host")
    expect(verdict(local("http://[fd00::1]:8080/v1"), ["[FD00::1]:1"])).toBe("unattested-network-server")
    expect(verdict(local("http://[fd00::1]:8080/v1"), ["fd00:0::1"])).toBe("attested-host")
    // An origin without a port uses its scheme's own, which an entry may name.
    expect(verdict(local("http://gpu-box/v1"), ["gpu-box:80"])).toBe("attested-host")
    expect(verdict(local("http://gpu-box/v1"), ["gpu-box:443"])).toBe("unattested-network-server")
    expect(verdict(local("https://gpu-box/v1"), ["gpu-box:443"])).toBe("attested-host")
    expect(verdict(local("http://gpu-box:8080/v1"), ["ollama"])).toBe("unattested-network-server")
    expect(verdict(local("http://gpu-box:8080/v1"), ["http://gpu-box:8080"])).toBe("unattested-network-server")
    expect(verdict(local("http://gpu-box:8080/v1"), ["gpu-box2"])).toBe("unattested-network-server")
    // Shared ISP space (CGNAT) is the internet, not your network.
    expect(verdict(local("http://100.64.0.1/v1"))).toBe("unattested-provider")
  })

  test("a server that passes the model on to another service is refused, attested or not", () => {
    expect(verdict(local("http://127.0.0.1:11434/v1", { forwards: true }), EVERYTHING)).toBe("unknown-destination")
    expect(verdict(local("http://gpu-box:11434/v1", { forwards: true }), EVERYTHING)).toBe("unknown-destination")
  })

  test("OpenRouter needs the account attested, by the provider ID that holds it", () => {
    expect(verdict(openRouter())).toBe("unattested-openrouter")
    expect(verdict(openRouter(), ["openrouter"])).toBe("openrouter-attested")
    expect(verdict(openRouter(), [" openrouter "])).toBe("openrouter-attested")
    // A host never attests an account.
    expect(verdict(openRouter(), ["openrouter.ai", "eu.openrouter.ai"])).toBe("unattested-openrouter")
    // A provider of another name at OpenRouter holds its own key, so its own ID is attested.
    for (const url of [OPENROUTER_URL, "https://eu.openrouter.ai/api/v1"]) {
      const custom = openRouter({ providerID: "my-or", npm: OLLAMA, destinations: [url] })
      expect(verdict(custom, ["openrouter"])).toBe("unattested-openrouter")
      expect(verdict(custom, ["my-or"])).toBe("openrouter-attested")
      expect(verdict({ ...custom, defaultOrigins: [] }, ["my-or"])).toBe("openrouter-attested")
    }
    // OpenRouter's SDK package names OpenRouter wherever its base URL points.
    const sdk = openRouter({ providerID: "acme", destinations: ["http://127.0.0.1:4000/api/v1"] })
    expect(verdict(sdk)).toBe("unattested-openrouter")
    expect(verdict(sdk, ["acme"])).toBe("openrouter-attested")
    // A provider that reaches OpenRouter by default holds an account there under its own ID.
    const shipped = openRouter({ providerID: "acme", defaultOrigins: ["https://openrouter.ai"] })
    expect(verdict(shipped, ["acme"])).toBe("openrouter-attested")
  })

  test("a direct provider's attestation never covers an OpenRouter account", () => {
    // The owner attested Anthropic's own agreement, not an OpenRouter account's logging and retention settings.
    const moved = anthropic({ destinations: [OPENROUTER_URL] })
    expect(verdict(moved, ["anthropic"])).toBe("unattested-openrouter")
    expect(verdict(moved, ["anthropic", "openrouter.ai"])).toBe("unattested-openrouter")
    // OpenRouter's SDK package through a stand-in on this computer is OpenRouter too.
    const stand = anthropic({ npm: OPENROUTER_NPM, destinations: ["http://127.0.0.1:4000/api/v1"] })
    expect(verdict(stand, ["anthropic"])).toBe("unattested-openrouter")
    expect(verdict(anthropic({ destinations: [OPENROUTER_URL], defaultOrigins: [" "] }), ["anthropic"])).toBe(
      "unattested-openrouter",
    )
  })

  test("OpenRouter over plain http is a hop of its own, never the account's route", () => {
    for (const url of ["http://openrouter.ai/api/v1", "http://eu.openrouter.ai/api/v1"]) {
      expect(verdict(openRouter({ destinations: [url] }), ["openrouter"])).toBe("unattested-provider")
      expect(verdict({ providerID: "acme", modelID: "coder", destinations: [url] }, ["acme"])).toBe(
        "unattested-provider",
      )
    }
    // Beside the https route, a plain http copy still fails the whole model.
    expect(verdict(openRouter({ destinations: [OPENROUTER_URL, "http://openrouter.ai/api/v1"] }), ["openrouter"])).toBe(
      "unattested-provider",
    )
  })

  test("an OpenRouter provider sent elsewhere must also pass where it is sent", () => {
    // A stand-in on this computer (a local proxy or a test server) passes requests on to the account.
    const stand = openRouter({ destinations: [OPENROUTER_URL, "http://127.0.0.1:4000/api/v1"] })
    expect(verdict(stand)).toBe("unattested-openrouter")
    expect(verdict(stand, ["openrouter"])).toBe("openrouter-attested")
    // Any other hop needs its own host attested, and the account still needs its own attestation.
    const proxy = openRouter({ destinations: [OPENROUTER_URL, "https://proxy.example.com/v1"] })
    expect(verdict(proxy, ["openrouter"])).toBe("unattested-provider")
    expect(verdict(proxy, ["proxy.example.com"])).toBe("unattested-openrouter")
    expect(verdict(proxy, ["openrouter", "proxy.example.com"])).toBe("openrouter-attested")
    const lan = openRouter({ destinations: [OPENROUTER_URL, "http://10.0.0.5:4000/v1"] })
    expect(verdict(lan, ["openrouter"])).toBe("unattested-network-server")
    expect(verdict(lan, ["openrouter", "10.0.0.5:4000"])).toBe("openrouter-attested")
    const site = openRouter({ destinations: [OPENROUTER_URL, "https://vectordev.ai/api/free-models"] })
    expect(verdict(site, EVERYTHING)).toBe("codium-unaccepted")
  })

  test("free models are refused, however they are named or priced", () => {
    for (const model of [
      openRouter({ modelID: "qwen/qwen3-coder:free" }),
      openRouter({ modelID: "qwen/qwen3-coder:free:nitro" }),
      openRouter({ modelID: "qwen/qwen3-coder:FREE@2026-01" }),
      openRouter({ modelID: "openrouter/free" }),
      openRouter({ modelID: "stealth/sable" }),
      openRouter({ freeModel: true }),
      // A paid catalog name that sends a free ID.
      openRouter({ modelID: "acme/coder", apiID: "acme/coder:free" }),
      // A zero price on an OpenRouter route goes down the free route (sendsToOpenRouterFree, resolveSDK).
      openRouter({ modelID: "acme/zero", price: { input: 0, output: 0 } }),
      { providerID: "vector", modelID: "qwen/qwen3-coder", destinations: ["https://vectordev.ai/api/free-models"] },
      local("http://127.0.0.1:11434/v1", { modelID: "acme/coder:free" }),
    ])
      expect(verdict(model, EVERYTHING)).toBe("free-model")
    // A server on this computer lists no price, or a zero one; that is not a free OpenRouter model.
    expect(verdict(local("http://127.0.0.1:11434/v1", { price: { input: 0, output: 0 } }))).toBe("loopback")
  })

  test("routers and presets are refused, on any provider", () => {
    for (const model of [
      openRouter({ modelID: "openrouter/auto" }),
      openRouter({ modelID: "@preset/reviews" }),
      openRouter({ modelID: "acme/coder", apiID: "openrouter/auto" }),
      // A LiteLLM-style name on this computer is refused too: it reads as OpenRouter's router.
      local("http://127.0.0.1:4000/v1", { modelID: "openrouter/anthropic/claude-sonnet-5" }),
    ])
      expect(verdict(model, EVERYTHING)).toBe("router-or-preset")
  })

  test("the web plugin's :online variant is refused as a plugin", () => {
    for (const modelID of [
      "anthropic/claude-sonnet-5:online",
      "anthropic/claude-sonnet-5:online:nitro",
      "anthropic/claude-sonnet-5:nitro:online",
    ])
      expect(verdict(openRouter({ modelID }), EVERYTHING)).toBe("plugins")
    expect(verdict(openRouter({ modelID: "acme/online-coder" }), ["openrouter"])).toBe("openrouter-attested")
  })

  test("models whose provider requires retention are refused on every provider", () => {
    for (const model of [
      anthropic({ modelID: "claude-fable-5" }),
      anthropic({ modelID: "claude-fable5" }),
      anthropic({ modelID: "claude-mythos-5-1" }),
      openRouter({ modelID: "anthropic/claude-fable-5.1" }),
      openRouter({ modelID: "anthropic/claude-sonnet-5", apiID: "anthropic/claude-mythos-5" }),
      {
        providerID: "amazon-bedrock",
        modelID: "anthropic.claude-fable-5-1-v1:0",
        destinations: ["https://bedrock-runtime.us-east-1.amazonaws.com"],
      },
      local("http://127.0.0.1:4000/v1", { modelID: "fable" }),
    ])
      expect(verdict(model, EVERYTHING)).toBe("retention-required-model")
    expect(verdict(local("http://127.0.0.1:11434/v1", { modelID: "fabled-coder" }))).toBe("loopback")
    expect(verdict(anthropic(), ["anthropic"])).toBe("attested-provider")
  })

  test("Vector Codium and Vector's own site are refused, attested or not", () => {
    expect(verdict(CODIUM, EVERYTHING)).toBe("codium-unaccepted")
    for (const url of [
      "https://vectordev.ai/api/model-plans",
      "https://vectordev.ai/api/free-models",
      "https://api.vectordev.ai/v1",
    ])
      expect(verdict({ providerID: "acme", modelID: "coder", npm: OLLAMA, destinations: [url] }, EVERYTHING)).toBe(
        "codium-unaccepted",
      )
    // A look-alike name is just another host.
    expect(verdict({ providerID: "acme", modelID: "coder", destinations: ["https://vectordev.ai.example.com"] })).toBe(
      "unattested-provider",
    )
  })

  test("a direct provider is allowed at its own origin when attested, and anywhere else only by host", () => {
    expect(verdict(anthropic())).toBe("unattested-provider")
    expect(verdict(anthropic(), ["anthropic"])).toBe("attested-provider")
    expect(verdict(anthropic(), ["api.anthropic.com"])).toBe("attested-host")
    expect(verdict(anthropic(), ["API.Anthropic.com:443"])).toBe("attested-host")
    // A base URL set anywhere else does not inherit the provider's attestation.
    const moved = anthropic({ destinations: ["https://other.example/v1"] })
    expect(verdict(moved, ["anthropic"])).toBe("unattested-provider")
    expect(verdict(moved, ["anthropic", "other.example"])).toBe("attested-host")
    expect(verdict(anthropic({ defaultOrigins: undefined }), ["anthropic"])).toBe("unattested-provider")
    // Every destination must pass: the catalog's URL and a provider base URL that disagree with it.
    const split = anthropic({
      destinations: ["https://api.anthropic.com/v1", "http://10.0.0.5/v1"],
    })
    expect(verdict(split, ["anthropic"])).toBe("unattested-network-server")
    expect(verdict(split, ["anthropic", "10.0.0.5"])).toBe("attested-provider")
    // A company's server on a public name is a host on the internet.
    const company = { providerID: "acme", modelID: "coder", npm: OLLAMA, destinations: ["https://llm.acme.example/v1"] }
    expect(verdict(company)).toBe("unattested-provider")
    expect(verdict(company, ["acme"])).toBe("unattested-provider")
    expect(verdict(company, ["llm.acme.example"])).toBe("attested-host")
    // This computer beside an attested host is the attested host's route.
    const mixed = local("http://127.0.0.1:11434/v1", {
      destinations: ["http://127.0.0.1:11434", "https://llm.acme.example"],
    })
    expect(verdict(mixed, ["llm.acme.example"])).toBe("attested-host")
  })

  test("a destination nobody can tell is refused", () => {
    for (const destinations of [
      [],
      [undefined, "", "  "],
      // An SDK package is no place a request goes, and neither is a bare name: both read as URLs that are not.
      ["@ai-sdk/anthropic"],
      ["gpu-box"],
      ["localhost"],
      ["https://api.anthropic.com/v1", "gpu-box"],
      ["http://exa mple.com/v1"],
      ["ftp://models.example/v1"],
      ["file:///tmp/model"],
      ["localhost:11434"],
      ["${OLLAMA_HOST}/v1"],
      ["https://api.anthropic.com/v1", "ftp://models.example/v1"],
    ])
      expect(verdict(anthropic({ destinations }), EVERYTHING)).toBe("unknown-destination")
    // OpenRouter's SDK package alone does not say where it sends: the caller passes the SDK's own origin.
    expect(verdict(openRouter({ destinations: [undefined] }), EVERYTHING)).toBe("unknown-destination")
    // Values that are not text are unset, as a missing base URL is.
    expect(verdict(anthropic({ destinations: ["https://api.anthropic.com/v1", 42, null] }), ["anthropic"])).toBe(
      "attested-provider",
    )
  })

  test("no attestation overrides a model's own refusal", () => {
    const refusals: [RouteModel, RouteRefusal][] = [
      [CODIUM, "codium-unaccepted"],
      [openRouter({ modelID: "qwen/qwen3-coder:free" }), "free-model"],
      [openRouter({ modelID: "openrouter/auto" }), "router-or-preset"],
      [openRouter({ modelID: "anthropic/claude-sonnet-5:online" }), "plugins"],
      [anthropic({ modelID: "claude-fable-5" }), "retention-required-model"],
      [local("http://127.0.0.1:11434/v1", { forwards: true }), "unknown-destination"],
    ]
    for (const [model, refusal] of refusals) expect(verdict(model, EVERYTHING)).toBe(refusal)
  })

  test("an attestation entry that is not text attests nothing, and does not throw", () => {
    const attested = [42, null, { id: "anthropic" }, ["anthropic"]] as unknown as string[]
    expect(verdict(anthropic(), attested)).toBe("unattested-provider")
    expect(verdict(local("http://gpu-box:8080/v1"), attested)).toBe("unattested-network-server")
    expect(verdict(anthropic(), [...attested, "anthropic"])).toBe("attested-provider")
  })
})

describe("zdrRequestBody", () => {
  const MODEL = "anthropic/claude-sonnet-5"
  const preferences = {
    order: ["anthropic", "amazon-bedrock"],
    only: ["anthropic"],
    ignore: ["deepinfra"],
    allow_fallbacks: false,
    sort: "price",
    max_price: { prompt: 3, completion: 15 },
    quantizations: ["fp8"],
    preferred_max_latency: 2,
    options: { anthropic: { cache: true } },
    require_parameters: true,
  }
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: "Review this." }],
    temperature: 0.2,
    provider: preferences,
  }

  test("asks for ZDR endpoints that collect nothing and keeps everything else", () => {
    expect(zdrRequestBody(body, MODEL)).toStrictEqual({
      ...body,
      provider: { ...preferences, zdr: true, data_collection: "deny" },
    })
    expect(zdrBodyRefusal(body, MODEL)).toBeUndefined()
  })

  test("never adds require_parameters", () => {
    // Strict, so a require_parameters key set to undefined would fail too.
    expect(zdrRequestBody({ model: MODEL, messages: [] }, MODEL)).toStrictEqual({
      model: MODEL,
      messages: [],
      provider: { zdr: true, data_collection: "deny" },
    })
  })

  test("never lowers a setting, and replaces a provider that is not an object", () => {
    expect(zdrRequestBody({ provider: { zdr: false, data_collection: "allow", sort: "price" } }, MODEL)).toEqual({
      provider: { zdr: true, data_collection: "deny", sort: "price" },
    })
    for (const provider of ["anthropic", ["anthropic"], null])
      expect(zdrRequestBody({ model: MODEL, provider }, MODEL)).toEqual({
        model: MODEL,
        provider: { zdr: true, data_collection: "deny" },
      })
  })

  test("does not change its input", () => {
    const copy = structuredClone(body)
    zdrRequestBody(body, MODEL)
    expect(body).toEqual(copy)
  })

  test("refuses routing, plugins, a refused body model and anything it cannot read", () => {
    const web = { model: MODEL, plugins: [{ id: "web" }] }
    // The web plugin keeps the model, so the routing check allows it; it still sends the query to a search provider.
    expect(openRouterModelRouting(web, MODEL)).toEqual([])
    const cases: [unknown, string, RouteRefusal][] = [
      [{ model: MODEL, models: [MODEL, "acme/other"] }, MODEL, "fallback-models"],
      [{ model: MODEL, route: "fallback" }, MODEL, "fallback-models"],
      [{ model: MODEL, preset: "reviews" }, MODEL, "router-or-preset"],
      [{ model: MODEL, models: [MODEL], preset: "reviews" }, MODEL, "router-or-preset"],
      [{ model: "@preset/reviews" }, "@preset/reviews", "router-or-preset"],
      [{ model: "openrouter/auto" }, MODEL, "router-or-preset"],
      [{ model: "acme/coder:free" }, MODEL, "free-model"],
      [{ model: "anthropic/claude-fable-5" }, MODEL, "retention-required-model"],
      [{ model: `${MODEL}:online` }, MODEL, "plugins"],
      [web, MODEL, "plugins"],
      [{ model: MODEL, plugins: [{ id: "file-parser" }] }, MODEL, "plugins"],
      [{ model: MODEL, plugins: [{ id: "web", enabled: false }] }, MODEL, "plugins"],
      [{ model: MODEL, plugins: [] }, MODEL, "plugins"],
      [{ model: MODEL, web_search_options: { search_context_size: "low" } }, MODEL, "plugins"],
      ["{}", MODEL, "unreadable-body"],
      [[{ model: MODEL }], MODEL, "unreadable-body"],
      [null, MODEL, "unreadable-body"],
      [3, MODEL, "unreadable-body"],
      [undefined, MODEL, "unreadable-body"],
    ]
    for (const [input, modelID, refusal] of cases) {
      expect(zdrBodyRefusal(input, modelID)).toBe(refusal)
      expect(zdrRequestBody(input, modelID)).toBeUndefined()
    }
  })
})
