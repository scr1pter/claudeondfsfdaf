import { describe, expect, test } from "bun:test"
import { openRouterModelRouting } from "@vectordevai/core/free-model-catalog"
import {
  decideRoute,
  extendedCacheOnly,
  readZdrAttestation,
  ROUTE_REFUSALS,
  zdrBodyRefusal,
  zdrFeatureRefusal,
  zdrRequestBody,
  type RouteModel,
  type RouteRefusal,
} from "@vectordevai/core/review/privacy"
import type { ZdrAttestation, ZdrAttestedEntry } from "@vectordevai/core/review/types"

// The zero data retention route rules (VS-23a, and addendum A's VS-33). Nothing calls them yet; these pin each rule of
// contract §4 VS-23a and of VS-33's Now part.

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
function verdict(model: RouteModel, attested: readonly ZdrAttestedEntry[] = []) {
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
      "server-tool",
      "provider-options",
      "extended-cache-unattested",
      "grounding-tool",
      "durable-cache",
      "anthropic-non-zdr-feature",
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

  test("an attestation entry the rules cannot read attests nothing, and does not throw", () => {
    const attested = [
      42,
      null,
      { id: "anthropic" },
      ["anthropic"],
      // VS-33: an attestation object with any problem readZdrAttestation names.
      { id: "anthropic", operator: " " },
      { id: "anthropic", operator: "anthropic", regoin: "eu" },
      { id: "anthropic", operator: "anthropic", extendedCache: "yes" },
      { id: "gpu-box", operator: "me", verify: "never" },
      { id: "https://gpu-box:8080", operator: "me" },
      { id: 7, operator: "anthropic" },
      JSON.parse('{"id": "anthropic", "operator": "anthropic", "__proto__": {"x": 1}}'),
    ] as unknown as ZdrAttestedEntry[]
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
    // VS-33: an empty `options` is kept; any other is "provider-options" (below).
    options: {},
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

// VS-33's Now part: attestation objects in decideRoute, the region pin, extended caching and the `attestations` a
// decision lists.

const openAI = (overrides: Partial<RouteModel> = {}): RouteModel => ({
  providerID: "openai",
  modelID: "gpt-5.5",
  npm: "@ai-sdk/openai",
  destinations: ["https://api.openai.com/v1"],
  defaultOrigins: ["https://api.openai.com"],
  ...overrides,
})
const bedrock = (overrides: Partial<RouteModel> = {}): RouteModel => ({
  providerID: "amazon-bedrock",
  modelID: "anthropic.claude-sonnet-5-v1:0",
  npm: "@ai-sdk/amazon-bedrock",
  destinations: ["https://bedrock-runtime.us-east-1.amazonaws.com"],
  defaultOrigins: ["https://bedrock-runtime.us-east-1.amazonaws.com"],
  ...overrides,
})
const zdr = (model: RouteModel, attested: readonly ZdrAttestedEntry[]) =>
  decideRoute(model, { privacy: "zdr", attested })

describe("decideRoute with attestation objects (VS-33)", () => {
  test("an attestation object attests as its text would, and the decision lists it", () => {
    const provider = { id: "anthropic", operator: "anthropic" }
    expect(zdr(anthropic(), [provider])).toStrictEqual({
      allowed: true,
      kind: "attested-provider",
      attestations: [provider],
    })
    const host = { id: "gpu-box:8080", operator: "me" }
    expect(zdr(local("http://gpu-box:8080/v1"), [host])).toStrictEqual({
      allowed: true,
      kind: "attested-host",
      attestations: [host],
    })
    expect(verdict(local("http://gpu-box:4000/v1"), [host])).toBe("unattested-network-server")
    const account: ZdrAttestation = { id: "openrouter", operator: "openrouter", verify: "attest" }
    expect(zdr(openRouter(), [account])).toStrictEqual({
      allowed: true,
      kind: "openrouter-attested",
      attestations: [account],
    })
    // Read through readZdrAttestation: trimmed, and new objects, never the caller's.
    const spaced = { id: " anthropic ", operator: " anthropic ", project: " org-1 " }
    const decision = zdr(anthropic(), [spaced])
    expect(decision).toStrictEqual({
      allowed: true,
      kind: "attested-provider",
      attestations: [{ id: "anthropic", operator: "anthropic", project: "org-1" }],
    })
    expect(decision.allowed && decision.attestations?.[0]).not.toBe(spaced)
    expect(spaced.id).toBe(" anthropic ")
    // Under "standard" no rule applies and nothing is listed.
    expect(decideRoute(anthropic(), { privacy: "standard", attested: [provider] })).toStrictEqual({
      allowed: true,
      kind: "standard",
    })
  })

  test("a decision from text alone lists no attestations, as before VS-33", () => {
    const cases: [RouteModel, string[]][] = [
      [anthropic(), ["anthropic"]],
      [anthropic(), ["api.anthropic.com"]],
      [local("http://gpu-box:8080/v1"), ["gpu-box"]],
      [openRouter(), ["openrouter"]],
      [local("http://127.0.0.1:11434/v1"), EVERYTHING],
    ]
    for (const [model, attested] of cases) {
      const decision = zdr(model, attested)
      expect(decision.allowed).toBe(true)
      expect(Object.hasOwn(decision, "attestations")).toBe(false)
    }
  })

  test("the decision lists every attestation that attests the route, whichever entry decided it", () => {
    // A host text entry decides the route, and the provider's object that would attest it too is still listed, so
    // admission sees its `verify: "api"`.
    const checked: ZdrAttestation = { id: "anthropic", operator: "anthropic", verify: "api" }
    expect(zdr(anthropic(), ["api.anthropic.com", checked])).toStrictEqual({
      allowed: true,
      kind: "attested-host",
      attestations: [checked],
    })
    // A route only a `verify: "api"` object attests is allowed here and lists it. Refusing it until a verifier exists
    // (Q20) is VS-23b's admission, whose tests must include this route, refused.
    const aws: ZdrAttestation = { id: "amazon-bedrock", operator: "aws", project: "123456789012", verify: "api" }
    expect(zdr(bedrock(), [aws])).toStrictEqual({ allowed: true, kind: "attested-provider", attestations: [aws] })
    // An object that attests none of the destinations is not listed: a provider's ID covers only its own origins.
    const moved = anthropic({ destinations: ["https://other.example/v1"] })
    expect(zdr(moved, [checked, "other.example"])).toStrictEqual({ allowed: true, kind: "attested-host" })
    // Each once, in destination order: one object attesting two destinations is listed once.
    const acme = { id: "llm.acme.example", operator: "acme" }
    const proxy = { id: "proxy.example.com", operator: "proxy" }
    const both = {
      providerID: "acme",
      modelID: "coder",
      destinations: ["https://proxy.example.com/v1", "https://llm.acme.example/v1", "https://llm.acme.example:8443/v1"],
    }
    expect(zdr(both, [acme, proxy])).toStrictEqual({
      allowed: true,
      kind: "attested-host",
      attestations: [proxy, acme],
    })
    // OpenRouter: the account's entries, then each hop's.
    const hop = openRouter({ destinations: [OPENROUTER_URL, "https://proxy.example.com/v1"] })
    const account = { id: "openrouter", operator: "openrouter" }
    expect(zdr(hop, [proxy, account])).toStrictEqual({
      allowed: true,
      kind: "openrouter-attested",
      attestations: [account, proxy],
    })
    // A server on this computer attests nothing.
    expect(zdr(local("http://127.0.0.1:11434/v1"), [{ id: "ollama", operator: "me" }])).toStrictEqual({
      allowed: true,
      kind: "loopback",
    })
  })

  test("a region pins an OpenRouter account to that region's host", () => {
    const eu: ZdrAttestation = { id: "openrouter", operator: "openrouter", region: "eu" }
    const us: ZdrAttestation = { id: "openrouter", operator: "openrouter", region: "us" }
    const at = (...destinations: string[]) => openRouter({ destinations })
    expect(zdr(at("https://eu.openrouter.ai/api/v1"), [eu])).toStrictEqual({
      allowed: true,
      kind: "openrouter-attested",
      attestations: [eu],
    })
    expect(verdict(at("https://us.openrouter.ai/api/v1"), [us])).toBe("openrouter-attested")
    // The host as an origin reads it: a fully qualified name's dot and any case.
    expect(verdict(at("https://eu.openrouter.ai./api/v1"), [eu])).toBe("openrouter-attested")
    expect(verdict(at("https://EU.OpenRouter.ai/api/v1"), [eu])).toBe("openrouter-attested")
    // The regional hosts are OpenRouter, so text attests them as before.
    for (const url of ["https://eu.openrouter.ai/api/v1", "https://us.openrouter.ai/api/v1"]) {
      expect(verdict(at(url))).toBe("unattested-openrouter")
      expect(verdict(at(url), ["openrouter"])).toBe("openrouter-attested")
    }
    // Any other OpenRouter host is not the attested account. The refusal reuses "unattested-openrouter"; its note's
    // wording for a listed account on the wrong host is VS-23b's.
    for (const url of [OPENROUTER_URL, "https://us.openrouter.ai/api/v1", "https://api.openrouter.ai/api/v1"])
      expect(verdict(at(url), [eu])).toBe("unattested-openrouter")
    expect(verdict(at("https://eu.openrouter.ai/api/v1", OPENROUTER_URL), [eu])).toBe("unattested-openrouter")
    // Strictest across entries: two regions never hold, and text beside a pin keeps the pin.
    for (const url of ["https://eu.openrouter.ai/api/v1", "https://us.openrouter.ai/api/v1"])
      expect(verdict(at(url), [eu, us])).toBe("unattested-openrouter")
    expect(verdict(at(OPENROUTER_URL), ["openrouter", eu])).toBe("unattested-openrouter")
    expect(verdict(at("https://eu.openrouter.ai/api/v1"), ["openrouter", eu])).toBe("openrouter-attested")
    // A stand-in on this computer alone cannot show the region; beside the regional host it passes requests on.
    expect(verdict(at("http://127.0.0.1:4000/api/v1"), ["openrouter"])).toBe("openrouter-attested")
    expect(verdict(at("http://127.0.0.1:4000/api/v1"), [eu])).toBe("unattested-openrouter")
    expect(verdict(at("https://eu.openrouter.ai/api/v1", "http://127.0.0.1:4000/api/v1"), [eu])).toBe(
      "openrouter-attested",
    )
    // A provider of another name at OpenRouter pins its own account.
    const custom = openRouter({ providerID: "my-or", npm: OLLAMA, destinations: ["https://eu.openrouter.ai/api/v1"] })
    expect(verdict(custom, [{ ...eu, id: "my-or" }])).toBe("openrouter-attested")
    expect(verdict(custom, [eu])).toBe("unattested-openrouter")
  })

  test("a region attests nothing but an OpenRouter account", () => {
    expect(verdict(anthropic(), [{ id: "anthropic", operator: "anthropic", region: "eu" }])).toBe("unattested-provider")
    expect(verdict(anthropic(), [{ id: "api.anthropic.com", operator: "anthropic", region: "us" }])).toBe(
      "unattested-provider",
    )
    expect(verdict(local("http://gpu-box:8080/v1"), [{ id: "gpu-box", operator: "me", region: "eu" }])).toBe(
      "unattested-network-server",
    )
    // Nor an OpenRouter hop's host.
    const proxy = openRouter({ destinations: [OPENROUTER_URL, "https://proxy.example.com/v1"] })
    expect(verdict(proxy, ["openrouter", { id: "proxy.example.com", operator: "proxy", region: "eu" }])).toBe(
      "unattested-provider",
    )
  })

  test("an OpenAI model with only extended prompt caching needs every entry for its route to accept it", () => {
    const flagged: ZdrAttestation = { id: "openai", operator: "openai", extendedCache: true }
    // Text, the legacy form, never accepts it, and neither does an object that does not say so.
    for (const attested of [
      ["openai"],
      ["api.openai.com"],
      [{ id: "openai", operator: "openai" }],
      [{ ...flagged, extendedCache: false }],
    ])
      expect(verdict(openAI(), attested)).toBe("extended-cache-unattested")
    expect(zdr(openAI(), [flagged])).toStrictEqual({
      allowed: true,
      kind: "attested-provider",
      attestations: [flagged],
    })
    // Strictest across entries: text or an object without the flag beside it still refuses.
    expect(verdict(openAI(), ["openai", flagged])).toBe("extended-cache-unattested")
    expect(verdict(openAI(), [flagged, "api.openai.com"])).toBe("extended-cache-unattested")
    expect(verdict(openAI(), [flagged, { id: "api.openai.com", operator: "openai", extendedCache: true }])).toBe(
      "attested-host",
    )
    // An entry that attests none of its destinations does not count.
    expect(verdict(openAI(), [flagged, "gpu-box", "anthropic"])).toBe("attested-provider")
    // Earlier models keep today's rule.
    for (const modelID of ["gpt-5.4", "gpt-5", "gpt-4o", "gpt-54-pro", "o3"])
      expect(verdict(openAI({ modelID }), ["openai"])).toBe("attested-provider")
    // The ID sent counts as the catalog's does.
    expect(verdict(openAI({ modelID: "prod", apiID: "gpt-6" }), ["openai"])).toBe("extended-cache-unattested")
    // Over OpenRouter the account's entries decide, and a hop's count too.
    const routed = openRouter({ modelID: "openai/gpt-5.5" })
    expect(verdict(routed, ["openrouter"])).toBe("extended-cache-unattested")
    expect(verdict(routed, [{ id: "openrouter", operator: "openrouter", extendedCache: true }])).toBe(
      "openrouter-attested",
    )
    const hop = openRouter({
      modelID: "openai/gpt-5.5",
      destinations: [OPENROUTER_URL, "https://proxy.example.com/v1"],
    })
    expect(verdict(hop, [{ id: "openrouter", operator: "openrouter", extendedCache: true }, "proxy.example.com"])).toBe(
      "extended-cache-unattested",
    )
    // A server on this computer attests nothing, so the rule does not apply there.
    expect(verdict(local("http://127.0.0.1:4000/v1", { modelID: "gpt-5.5" }))).toBe("loopback")
    expect(verdict(openAI({ destinations: ["http://127.0.0.1:4000/v1"] }), ["openai"])).toBe("loopback")
    // An ID that hides the model, such as an Azure deployment name, is not caught here: admission metadata (VS-23b).
    expect(verdict(openAI({ modelID: "prod" }), ["openai"])).toBe("attested-provider")
  })

  test("models whose provider requires retention are refused under Bedrock and Vertex IDs", () => {
    for (const modelID of [
      "anthropic.claude-fable-5-1-v1:0",
      "us.anthropic.claude-mythos-5-v1:0",
      "global.anthropic.claude-fable-5-v1:0",
      // A system-defined inference profile's ARN carries the model's name.
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-fable-5-1-v1:0",
    ])
      expect(verdict(bedrock({ modelID }), [{ id: "amazon-bedrock", operator: "aws" }])).toBe(
        "retention-required-model",
      )
    const vertex = (modelID: string): RouteModel => ({
      providerID: "google-vertex-anthropic",
      modelID,
      destinations: ["https://us-east5-aiplatform.googleapis.com/v1"],
    })
    for (const modelID of ["claude-fable-5@20261001", "claude-mythos-5-1@20261015"])
      expect(verdict(vertex(modelID), EVERYTHING)).toBe("retention-required-model")
    // An application inference profile's ARN names no model, so the ID table cannot see a Covered Model behind it:
    // admission metadata (VS-23b and VS-23c, Q20).
    const opaque = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6"
    expect(verdict(bedrock({ modelID: opaque }), [{ id: "amazon-bedrock", operator: "aws" }])).toBe("attested-provider")
  })
})

describe("readZdrAttestation", () => {
  test("reads an attestation object into a new, trimmed one with only the keys set", () => {
    const input = {
      id: " amazon-bedrock ",
      operator: " aws ",
      project: " 123456789012 ",
      region: undefined,
      extendedCache: false,
      verify: "api",
    }
    const read = readZdrAttestation(input)
    expect(read).toStrictEqual({
      attestation: {
        id: "amazon-bedrock",
        operator: "aws",
        project: "123456789012",
        extendedCache: false,
        verify: "api",
      },
    })
    expect("attestation" in read && read.attestation).not.toBe(input)
    expect(input.id).toBe(" amazon-bedrock ")
    expect(readZdrAttestation({ id: "openai", operator: "openai" })).toStrictEqual({
      attestation: { id: "openai", operator: "openai" },
    })
    const full: ZdrAttestation = {
      id: "openrouter",
      operator: "openrouter",
      project: "team",
      region: "eu",
      extendedCache: true,
      verify: "attest",
    }
    expect(readZdrAttestation(full)).toStrictEqual({ attestation: full })
    // A host with a port is an `id` too, as in text.
    expect(readZdrAttestation({ id: "[fd00::1]:8080", operator: "me" })).toStrictEqual({
      attestation: { id: "[fd00::1]:8080", operator: "me" },
    })
  })

  test("names the first problem, as a phrase after the entry", () => {
    const noOperator = 'has no "operator", the platform operator that processes the data'
    const notAName = 'has an "id" that names neither a provider ID nor a host'
    const cases: [unknown, string][] = [
      [null, "is not an attestation object"],
      ["openai", "is not an attestation object"],
      [["openai"], "is not an attestation object"],
      [3, "is not an attestation object"],
      [{ id: "openai", operator: "openai", regoin: "eu" }, 'has the unknown key "regoin"'],
      [JSON.parse('{"id": "openai", "operator": "openai", "__proto__": {}}'), 'has the unknown key "__proto__"'],
      // An unknown key comes first, so a misspelt restriction never reads as a smaller one.
      [{ operator: "openai", extended_cache: true }, 'has the unknown key "extended_cache"'],
      [{ operator: "openai" }, 'has no "id"'],
      [{ id: " ", operator: "openai" }, 'has no "id"'],
      [{ id: 3, operator: "openai" }, 'has no "id"'],
      [{ id: "https://api.openai.com", operator: "openai" }, notAName],
      [{ id: "open ai", operator: "openai" }, notAName],
      [{ id: "user@host", operator: "openai" }, notAName],
      [{ id: "open\u0000ai", operator: "openai" }, notAName],
      [{ id: "openai" }, noOperator],
      [{ id: "openai", operator: "  " }, noOperator],
      [{ id: "openai", region: "global" }, noOperator],
      [{ id: "openai", operator: 3 }, 'has an "operator" that is not text'],
      [{ id: "openai", operator: null }, 'has an "operator" that is not text'],
      [{ id: "openai", operator: "open\nai" }, 'has an "operator" that is not text'],
      [{ id: "openai", operator: "openai", project: "" }, 'has a "project" that is not text'],
      [{ id: "openai", operator: "openai", project: 12 }, 'has a "project" that is not text'],
      [{ id: "openai", operator: "openai", region: "EU" }, 'has a "region" other than "eu" or "us"'],
      [{ id: "openai", operator: "openai", region: "global" }, 'has a "region" other than "eu" or "us"'],
      [{ id: "openai", operator: "openai", extendedCache: "true" }, 'has an "extendedCache" other than true or false'],
      [{ id: "openai", operator: "openai", verify: "API" }, 'has a "verify" other than "attest" or "api"'],
      [{ id: "openai", operator: "openai", verify: null }, 'has a "verify" other than "attest" or "api"'],
    ]
    for (const [value, problem] of cases) {
      const read = readZdrAttestation(value)
      expect("problem" in read && read.problem).toBe(problem)
    }
    // The ID comes back when it is readable, so a note can name the entry, and never when it is not.
    expect(readZdrAttestation({ id: " openai ", operator: "openai", region: "x" })).toStrictEqual({
      problem: 'has a "region" other than "eu" or "us"',
      id: "openai",
    })
    expect(readZdrAttestation({ id: "https://api.openai.com", operator: "openai" })).toStrictEqual({
      problem: notAName,
    })
  })
})

describe("extendedCacheOnly", () => {
  test("is gpt-5.5 and every later OpenAI model, however it is written", () => {
    for (const id of [
      "gpt-5.5",
      "GPT-5.5",
      " gpt-5.5-pro ",
      "openai/gpt-5.5",
      "chatgpt-5.5",
      "gpt-5.10",
      "gpt-6",
      "gpt-6.1-sol",
      "gpt-55",
      "azure/gpt-55-mini",
      "gpt-100",
      // Deployment and alias spellings: no separator, an underscore, or a minor after a hyphen.
      "gpt5.5",
      "gpt_5.5",
      "gpt55",
      "gpt-5-5",
      "gpt5-5",
      "gpt_5_5",
      "my-gpt5-5-deploy",
      // From 10 to 29 a two-digit run is the major version, which leans to refusal.
      "gpt-10",
      "gpt-12.1",
      "gpt-20-mini",
    ])
      expect(extendedCacheOnly([id])).toBe(true)
    for (const id of [
      "gpt-5",
      "gpt-5.4",
      "gpt-5-2025-08-07",
      "gpt-5-mini-2025-08-07",
      "gpt-54-pro",
      "openai-gpt-54-pro",
      "gpt-35-turbo",
      "gpt-45-preview",
      "gpt-4o",
      "gpt-4-0613",
      "gpt-4-1106-preview",
      "gpt-4-32k",
      "gpt5.4",
      "gpt-5-4",
      "gpt_5_4",
      "gpt2",
      "gpt-j-6b",
      "gpt-oss-120b",
      "o3",
      "claude-sonnet-5",
      "",
      "prod",
    ])
      expect(extendedCacheOnly([id])).toBe(false)
    expect(extendedCacheOnly([undefined, 5, null, { id: "gpt-6" }])).toBe(false)
    expect(extendedCacheOnly(["gpt-5.4", undefined, "gpt-5.5"])).toBe(true)
    expect(extendedCacheOnly([])).toBe(false)
  })
})

describe("zdrBodyRefusal: tools, stored files and provider options (VS-33)", () => {
  const MODEL = "anthropic/claude-sonnet-5"
  const fn = { type: "function", function: { name: "read", parameters: { type: "object" } } }
  const body = (extra: Record<string, unknown> = {}) => ({
    model: MODEL,
    messages: [{ role: "user", content: "Review this." }],
    ...extra,
  })
  const refused = (input: unknown, refusal: RouteRefusal) => {
    expect(zdrBodyRefusal(input, MODEL)).toBe(refusal)
    expect(zdrRequestBody(input, MODEL)).toBeUndefined()
  }

  test("allows function tools and the tools OpenRouter returns to the caller", () => {
    for (const tools of [
      undefined,
      null,
      [],
      [fn],
      // Responses' function and freeform tools, and a Messages tool, which has no type.
      [{ type: "function", name: "read", parameters: {} }],
      [{ type: "custom", name: "apply_patch" }],
      [{ name: "read", input_schema: { type: "object" } }],
      // Anthropic's bash tool runs on the caller's side unless OpenRouter's own shape asks for its sandbox.
      [{ type: "bash_20250124", name: "bash" }],
    ]) {
      expect(zdrBodyRefusal(body({ tools }), MODEL)).toBeUndefined()
      expect(zdrRequestBody(body({ tools }), MODEL)).toEqual({
        ...body({ tools }),
        provider: { zdr: true, data_collection: "deny" },
      })
    }
    for (const tool_choice of [
      undefined,
      null,
      "auto",
      "none",
      "required",
      "any",
      { type: "function", function: { name: "read" } },
      { type: "function", name: "read" },
      { type: "tool", name: "read" },
      { type: "auto" },
      { type: "any" },
    ])
      expect(zdrBodyRefusal(body({ tools: [fn], tool_choice }), MODEL)).toBeUndefined()
  })

  test("refuses every other tool, by any spelling OpenRouter accepts", () => {
    for (const type of [
      "openrouter:web_search",
      "openrouter:web_fetch",
      "openrouter:fusion",
      "openrouter:bash",
      "openrouter:shell",
      "openrouter:files",
      "openrouter:advisor",
      "openrouter:tool_search",
      "openrouter:datetime",
      "OPENROUTER:web_search",
      " openrouter:web_search",
      // The aliases of OpenRouter's server tools, and hosted tools it passes on to a provider.
      "web_search",
      "web_search_preview",
      "web_search_20250305",
      "web_fetch_20250910",
      "tool_search",
      "tool_search_tool_regex_20251119",
      "code_interpreter",
      "file_search",
      "mcp",
      "image_generation",
      "computer_use_preview",
      "shell",
      "local_shell",
      "apply_patch",
      "text_editor_20250728",
      "Function",
      "",
      3,
      null,
    ])
      refused(body({ tools: [fn, { type, name: "x" }] }), "server-tool")
    refused(
      body({ tools: [{ type: "bash_20250124", name: "bash", parameters: { engine: "openrouter" } }] }),
      "server-tool",
    )
    refused(body({ tools: [{ type: "bash_20250124", name: "bash", engine: "openrouter" }] }), "server-tool")
    // A tool choice that forces a server tool by its own type, or picks tools by any other rule.
    for (const tool_choice of [
      { type: "openrouter:web_search" },
      { type: "web_search_preview" },
      { type: "allowed_tools", mode: "auto", tools: [] },
      {},
      "openrouter:web_search",
      "web_search",
    ])
      refused(body({ tools: [fn], tool_choice }), "server-tool")
    // OpenRouter's deferred-tool search.
    refused(body({ tools: [fn], deferred_tools: { protocol: "v1", profile: "portable" } }), "server-tool")
  })

  test("refuses a stored file, wherever the request refers to one", () => {
    for (const input of [
      body({ messages: [{ role: "user", content: [{ type: "file", file: { file_id: "or_file_011" } }] }] }),
      { model: MODEL, input: [{ type: "input_file", file_id: "or_file_011" }] },
      { model: MODEL, input: [{ role: "user", content: [{ type: "input_file", file_id: "or_file_011" }] }] },
      {
        model: MODEL,
        input: [{ type: "function_call_output", call_id: "c1", output: [{ type: "input_file", file_id: "f" }] }],
      },
      body({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: [{ type: "document", source: { type: "file" } }] },
            ],
          },
        ],
      }),
      body({ messages: [{ role: "user", content: [{ type: "container_upload", file_id: "f" }] }] }),
      // A custom-content document's own list may hold a file-sourced image.
      body({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "content", content: [{ type: "image", source: { type: "file", file_id: "f" } }] },
              },
            ],
          },
        ],
      }),
    ])
      refused(input, "server-tool")
    // Inline content is not stored, and text that mentions a file is text.
    for (const content of [
      [{ type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AAAA" } }],
      [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      [{ type: "text", text: '{"file_id": "or_file_011"}' }],
      [{ type: "file", file: { file_id: " " } }],
      [{ type: "document", source: { type: "content", content: [{ type: "text", text: "x" }] } }],
    ])
      expect(zdrBodyRefusal(body({ messages: [{ role: "user", content }] }), MODEL)).toBeUndefined()
    expect(zdrBodyRefusal({ model: MODEL, input: "Review this." }, MODEL)).toBeUndefined()
  })

  test("refuses the Anthropic Messages features zero data retention does not cover, as zdrFeatureRefusal does", () => {
    // OpenRouter serves Anthropic's Messages API, and zdrBodyRefusal is that route's only body check.
    for (const extra of [
      { thread: { id: "t" } },
      { thread: null },
      { mcp_servers: [{ type: "url", url: "https://mcp.example/sse", name: "docs" }] },
      { mcp_servers: [] },
      { container: "c" },
      { container: { skills: [{ type: "anthropic", skill_id: "pptx", version: "latest" }] } },
      // A tool that code execution may call is programmatic tool calling.
      { tools: [{ name: "read", input_schema: { type: "object" }, allowed_callers: ["code_execution_20250825"] }] },
      { tools: [{ type: "custom", name: "read", allowed_callers: ["direct", "code_execution_20250825"] }] },
      { tools: [{ type: "bash_20250124", name: "bash", allowed_callers: [] }] },
      { tools: [{ ...fn, allowed_callers: "direct" }] },
      { tools: [{ ...fn, allowed_callers: null }] },
    ])
      refused({ model: MODEL, messages: [], ...extra }, "anthropic-non-zdr-feature")
    for (const extra of [
      { tools: [{ name: "read", input_schema: { type: "object" }, allowed_callers: ["direct"] }] },
      { tools: [{ ...fn, allowed_callers: undefined }] },
      { thread: undefined, mcp_servers: undefined, container: undefined },
    ])
      expect(zdrBodyRefusal({ model: MODEL, messages: [], ...extra }, MODEL)).toBeUndefined()
    // A server tool is still "server-tool", whatever else the body sets.
    expect(zdrBodyRefusal(body({ tools: [{ type: "openrouter:web_search" }], thread: { id: "t" } }), MODEL)).toBe(
      "server-tool",
    )
  })

  test("refuses per-provider options, and keeps an empty one", () => {
    for (const options of [{ anthropic: { cache: true } }, null, [], "anthropic", 0, false])
      refused(body({ provider: { sort: "price", options } }), "provider-options")
    expect(zdrRequestBody(body({ provider: { sort: "price", options: {} } }), MODEL)).toStrictEqual({
      ...body(),
      provider: { sort: "price", options: {}, zdr: true, data_collection: "deny" },
    })
    expect(zdrBodyRefusal(body({ provider: { options: undefined } }), MODEL)).toBeUndefined()
    // A provider that is not an object is replaced, as before, so it carries no options.
    expect(zdrBodyRefusal(body({ provider: "anthropic" }), MODEL)).toBeUndefined()
  })

  test("cannot read a tool list that is not a list of objects, or content nested past any request", () => {
    for (const tools of ["read", { type: "function" }, [fn, 1], [null], 3]) refused(body({ tools }), "unreadable-body")
    refused(body({ tools: [fn], tool_choice: 3 }), "unreadable-body")
    const deep = Array.from({ length: 40 }).reduce<unknown[]>(
      (inner) => [{ type: "tool_result", content: inner }],
      [{ type: "text", text: "x" }],
    )
    refused(body({ messages: [{ role: "user", content: deep }] }), "unreadable-body")
    // Routing and plugins come first, as before VS-33.
    expect(zdrBodyRefusal({ model: MODEL, plugins: [], tools: "read" }, MODEL)).toBe("plugins")
  })

  test("does not change its input", () => {
    const input = body({ tools: [fn, { type: "openrouter:web_search" }], provider: { options: { a: 1 } } })
    const copy = structuredClone(input)
    zdrBodyRefusal(input, MODEL)
    zdrRequestBody(input, MODEL)
    expect(input).toEqual(copy)
  })
})

describe("zdrFeatureRefusal", () => {
  const messages = [{ role: "user", content: "Review this." }]
  const claude = (body: Record<string, unknown> = {}, path: string | undefined = "/v1/messages") =>
    zdrFeatureRefusal({
      format: "anthropic",
      body: { model: "claude-sonnet-5", max_tokens: 1024, messages, ...body },
      path,
    })
  const gemini = (tools: unknown) =>
    zdrFeatureRefusal({ format: "google", body: { contents: [{ role: "user", parts: [{ text: "Hi" }] }], tools } })
  const custom = { name: "read", input_schema: { type: "object" } }
  const VERTEX = "https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5"
  const BEDROCK = "https://bedrock-runtime.us-east-1.amazonaws.com"

  test("allows Anthropic's Messages and token counting endpoints, wherever the base URL puts them, and Claude's on Vertex and Bedrock", () => {
    for (const path of [
      "/v1/messages",
      "/v1/messages/",
      "/v1/messages/count_tokens",
      "https://api.anthropic.com/v1/messages?beta=true",
      "https://openrouter.ai/api/v1/messages",
      "/api/v1/messages",
      "https://gateway.example/anthropic/v1/messages#x",
      // As @ai-sdk/google-vertex/anthropic and @ai-sdk/amazon-bedrock/anthropic build them.
      `${VERTEX}/publishers/anthropic/models/claude-sonnet-5@20261001:rawPredict`,
      `${VERTEX}/publishers/anthropic/models/claude-sonnet-5@20261001:streamRawPredict`,
      `${BEDROCK}/model/us.anthropic.claude-sonnet-5-v1%3A0/invoke`,
      `${BEDROCK}/model/us.anthropic.claude-sonnet-5-v1%3A0/invoke-with-response-stream`,
    ])
      expect(claude({}, path)).toBeUndefined()
    // Without a path, the body alone is checked.
    expect(claude({}, undefined)).toBeUndefined()
  })

  test("refuses every other Anthropic endpoint, and Batch as batch", () => {
    for (const path of [
      "/v1/files",
      "/v1/files/file_1/content",
      "/v1/skills",
      "/v1/tunnels",
      "/v1/agents",
      "/v1/sessions/s1/events",
      "/v1/environments",
      "/v1/vaults",
      "/v1/credentials",
      "/v1/user_profiles",
      "/v1/messages/abc",
      "/v1/messagesx",
      "/V1/Messages",
      "",
      "/",
      "https://api.anthropic.com",
      // Other Vertex and Bedrock methods, Bedrock's own Converse format, which this check does not read, and a model
      // ARN left unencoded, which the SDK encodes.
      `${VERTEX}/publishers/anthropic/models/claude-sonnet-5:predict`,
      `${VERTEX}/publishers/google/models/gemini-3-pro:rawPredict`,
      `${BEDROCK}/model/us.anthropic.claude-sonnet-5-v1%3A0/converse`,
      `${BEDROCK}/model/arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.x/invoke`,
    ])
      expect(claude({}, path)).toBe("anthropic-non-zdr-feature")
    for (const path of [
      "/v1/messages/batches",
      "/v1/messages/batches/b1/results",
      "https://api.anthropic.com/v1/messages/batches?x=1",
      `${VERTEX}/batchPredictionJobs`,
      `${VERTEX}/batchPredictionJobs/123:cancel`,
      "https://bedrock.us-east-1.amazonaws.com/model-invocation-job",
      "https://bedrock.us-east-1.amazonaws.com/model-invocation-job/j1/stop",
      "https://bedrock.us-east-1.amazonaws.com/model-invocation-jobs",
    ])
      expect(claude({}, path)).toBe("batch")
  })

  test("allows the tools Anthropic lists as eligible", () => {
    for (const tool of [
      custom,
      { ...custom, type: "custom" },
      { ...custom, allowed_callers: ["direct"] },
      { type: "bash_20250124", name: "bash" },
      { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
      { type: "memory_20250818", name: "memory" },
      { type: "computer_20251124", name: "computer" },
      { type: "computer_toolset_20260801" },
      { type: "browser_toolset_20260801", allowed_callers: ["direct"] },
      { type: "advisor_20260301", name: "advisor" },
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      { type: "tool_search_tool_bm25" },
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_fetch_20250910", name: "web_fetch" },
      // The filtering versions, with filtering off.
      { type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"] },
      { type: "web_fetch_20260318", name: "web_fetch", allowed_callers: ["direct"] },
    ])
      expect(claude({ tools: [tool] })).toBeUndefined()
  })

  test("refuses every other Anthropic tool, and any tool code execution may call", () => {
    for (const tool of [
      { type: "mcp_toolset", mcp_server_name: "docs" },
      { type: "code_execution_20250825", name: "code_execution" },
      { type: "code_execution_20260120", name: "code_execution" },
      { type: "web_search_20260209", name: "web_search" },
      { type: "web_fetch_20260209", name: "web_fetch", allowed_callers: ["code_execution_20260120"] },
      { type: "web_search_20260318", allowed_callers: ["direct", "code_execution_20260120"] },
      // Not a version Anthropic lists, and a type newer than this file.
      { type: "web_search_20251001", name: "web_search" },
      { type: "foo_20270101", name: "foo" },
      { type: "bash", name: "bash" },
      { type: "openrouter:web_search" },
      { type: 3 },
      { ...custom, allowed_callers: ["code_execution_20260120"] },
      { ...custom, allowed_callers: [] },
      { ...custom, allowed_callers: "direct" },
    ])
      expect(claude({ tools: [custom, tool] })).toBe("anthropic-non-zdr-feature")
  })

  test("refuses the MCP connector, containers, message threads and stored files", () => {
    for (const body of [
      { mcp_servers: [{ type: "url", url: "https://mcp.example/sse", name: "docs" }] },
      { mcp_servers: [] },
      { container: { skills: [{ type: "anthropic", skill_id: "pptx", version: "latest" }] } },
      { container: "container_1" },
      { thread: { id: "thread_1" } },
      { thread: null },
      { messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "file_1" } }] }] },
      { messages: [{ role: "user", content: [{ type: "image", source: { file_id: "file_1" } }] }] },
      { messages: [{ role: "user", content: [{ type: "container_upload", file_id: "file_1" }] }] },
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "image", source: { type: "file", file_id: "file_1" } }],
              },
            ],
          },
        ],
      },
      // A custom-content document's own list may hold a file-sourced image (the beta Files API types).
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "content", content: [{ type: "image", source: { type: "file", file_id: "f" } }] },
              },
            ],
          },
        ],
      },
    ])
      expect(claude(body)).toBe("anthropic-non-zdr-feature")
    // Inline content is not stored, and fields the table marks eligible stay allowed.
    for (const body of [
      {
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }],
          },
        ],
      },
      { messages: [{ role: "user", content: [{ type: "document", source: { type: "text", data: "x" } }] }] },
      {
        messages: [
          {
            role: "user",
            content: [{ type: "document", source: { type: "content", content: [{ type: "text", text: "x" }] } }],
          },
        ],
      },
      {
        thinking: { type: "enabled", budget_tokens: 1024 },
        context_management: { edits: [] },
        speed: "fast",
        inference_geo: "us",
        mcp_servers: undefined,
      },
    ])
      expect(claude(body)).toBeUndefined()
  })

  test("allows only Google's function calling", () => {
    for (const tools of [
      undefined,
      [],
      [{ functionDeclarations: [{ name: "read" }] }],
      [{ function_declarations: [] }],
      [{ type: "function", function: { name: "read" } }],
      [{ functionDeclarations: [{ name: "a" }] }, { function_declarations: [{ name: "b" }] }],
    ])
      expect(gemini(tools)).toBeUndefined()
    for (const tool of [
      { googleSearch: {} },
      { googleSearchRetrieval: {} },
      { googleMaps: {} },
      { urlContext: {} },
      { enterpriseWebSearch: {} },
      { parallelAiSearch: { enableZeroDataRetention: true } },
      { exaAiSearch: {} },
      { retrieval: { vertexAiSearch: {} } },
      { codeExecution: {} },
      { computerUse: {} },
      {},
      { functionDeclarations: [{ name: "read" }], googleSearch: {} },
      { functionDeclarations: "read" },
      { type: "function", function: { name: "read" }, googleSearch: {} },
      { type: "google_search" },
    ])
      expect(gemini([tool])).toBe("grounding-tool")
    // Only Anthropic paths are checked; a Google request's path is the transport's (VS-23c).
    expect(zdrFeatureRefusal({ format: "google", body: {}, path: "/v1/files" })).toBeUndefined()
  })

  test("cannot read a body or tool list that is not one, and does not change its input", () => {
    for (const format of ["anthropic", "google"] as const) {
      for (const body of [null, "{}", [], 3]) expect(zdrFeatureRefusal({ format, body })).toBe("unreadable-body")
      expect(zdrFeatureRefusal({ format, body: { tools: "read" } })).toBe("unreadable-body")
      expect(zdrFeatureRefusal({ format, body: { tools: [null] } })).toBe("unreadable-body")
    }
    const body = { messages, tools: [{ type: "mcp_toolset" }], mcp_servers: [], container: { skills: [] } }
    const copy = structuredClone(body)
    zdrFeatureRefusal({ format: "anthropic", body, path: "/v1/files" })
    zdrFeatureRefusal({ format: "anthropic", body })
    zdrFeatureRefusal({ format: "google", body })
    expect(body).toEqual(copy)
  })
})
