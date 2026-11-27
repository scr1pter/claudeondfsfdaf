import { describe, expect, test } from "bun:test"
import type { EgressEvent, EgressSummary, LocalAddedServer, LocalStatus } from "@vectordevai/sdk/v2/client"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { EgressLogStore } from "@vectordevai/core/local-mode/log-store"
import { providerUnavailable } from "@vectordevai/schema/provider-unavailable"
import {
  ADMIN,
  AGENT,
  CHECK_RESULT,
  COST,
  COVERS_TITLE,
  DEFINITION,
  FORWARDING,
  GUEST,
  LOCKED,
  LOG_HELD,
  LOG_TITLE,
  LOOSENING,
  NOT_COVERED,
  NOT_ENCRYPTED,
  NO_VISION,
  OFF_STATE,
  PROGRAMS,
  RESTART,
  RESULTS,
  ROLES,
  SHARED_MACHINE,
  SUBTITLE,
  WEB_ACCESS,
  allowChoices,
  allowHosts,
  allowUpdate,
  blockedNotice,
  offWhy,
  checksFor,
  configRoles,
  exportName,
  identityChanged,
  logDescription,
  logRows,
  modelFacts,
  notCovered,
  offInLocal,
  offInLocalProviders,
  hostedServer,
  pillText,
  pillTitle,
  popoverLines,
  refusal,
  roleLocked,
  roleModels,
  rolesPatch,
  serverLabels,
  sourceName,
  suggestRoles,
} from "./local-model"

// The registry the engine serves in GET /local, so these tests read what the app will be sent.
const sources = LocalSources.SOURCES.map((source) => ({
  id: source.id,
  purpose: source.purpose,
  hosts: [...source.hosts],
  sends: source.sends,
  why: source.why,
  local: source.local,
  where: [...source.where],
  ...(source.note ? { note: source.note } : {}),
}))
const source = (id: string) => sources.find((item) => item.id === id)!

function status(
  input: { policy?: Partial<LocalStatus["policy"]>; locked?: string[]; agent?: boolean } = {},
): LocalStatus {
  return {
    policy: {
      ...LocalPolicy.OFF,
      enabled: true,
      endpoints: [],
      allow: [],
      warnings: [],
      ...input.policy,
    } as LocalStatus["policy"],
    locked: input.locked ?? [],
    log: { directory: "/tmp/vector/local", retain_days: 30 },
    agent: input.agent ?? false,
    sources,
  }
}

const summary = (input: Partial<EgressSummary> = {}): EgressSummary => ({
  requests: 0,
  helper_requests: 0,
  model_calls: {},
  pages: 0,
  hosts: 0,
  searches: 0,
  carried: { personal: 0, documents: 0, repository: 0 },
  blocked: {},
  ...input,
})

describe("the composer pill", () => {
  test("says Local, Local · your network or Local · no web, by Web access", () => {
    expect(pillText(status({ policy: { web: "ask" } }).policy)).toBe("Local")
    expect(pillText(status({ policy: { web: "network" } }).policy)).toBe("Local · your network")
    expect(pillText(status({ policy: { web: "none" } }).policy)).toBe("Local · no web")
  })

  test("a policy still being read reaches only this computer, so it says no web", () => {
    expect(pillText(status({ policy: { web: "ask", pending: true } }).policy)).toBe("Local · no web")
  })

  test("names the computer the engine runs on when it is another one", () => {
    expect(pillText(status({ policy: { web: "ask" } }).policy, "build-box")).toBe("Local on build-box")
    expect(pillText(status({ policy: { web: "none" } }).policy, "build-box")).toBe("Local on build-box · no web")
  })

  test("its title says when the company set it", () => {
    expect(pillTitle(status({ policy: { web: "network", lock: true } }).policy)).toContain(LOCKED)
    expect(pillTitle(status({ policy: { web: "network" } }).policy)).toContain("Web access: Your network only.")
    expect(pillTitle(status().policy)).not.toContain(LOCKED)
  })
})

describe("the session popover", () => {
  test("counts model calls by server, pages and the hosts they loaded, searches, memory sent and blocks", () => {
    const lines = popoverLines(
      summary({
        requests: 70,
        helper_requests: 3,
        model_calls: { "http://127.0.0.1:11434": 42 },
        pages: 6,
        hosts: 41,
        searches: 8,
        carried: { personal: 9, documents: 4, repository: 0 },
        blocked: { "model-catalog": 1, "usage-checkin": 1 },
      }),
      { policy: status({ policy: { pins: { "http://127.0.0.1:11434": { kind: "ollama" } } } }).policy, sources },
    )
    expect(lines.map((line) => line.text)).toEqual([
      "Model calls: 42 to 127.0.0.1:11434 (Ollama)",
      "Web: 6 pages, 41 other hosts they loaded, 8 searches",
      "Memory sent: 9 personal cards and 4 document passages, all to 127.0.0.1:11434",
      "Blocked: 2 (Model catalog refresh 1, Usage counts 1)",
      "Including 3 helper requests",
    ])
  })

  test("a session that sent nothing says so on every line, with no helper line", () => {
    expect(popoverLines(summary()).map((line) => line.text)).toEqual([
      "Model calls: none yet",
      "Web: nothing yet",
      "Memory sent: none",
      "Blocked: 0",
    ])
  })

  test("singular counts, several servers, and memory sent to more than one of them", () => {
    const lines = popoverLines(
      summary({
        model_calls: { "http://10.0.0.5:8000": 1, "http://127.0.0.1:11434": 3 },
        pages: 1,
        hosts: 1,
        searches: 1,
        carried: { personal: 1, documents: 0, repository: 2 },
        blocked: { github: 1 },
        helper_requests: 1,
      }),
    ).map((line) => line.text)
    expect(lines[0]).toBe("Model calls: 3 to 127.0.0.1:11434, 1 to 10.0.0.5:8000")
    expect(lines[1]).toBe("Web: 1 page, 1 other host they loaded, 1 search")
    expect(lines[2]).toBe("Memory sent: 1 personal card and 2 repository excerpts, to 2 model servers")
    expect(lines[3]).toBe("Blocked: 1 (GitHub pull requests 1)")
    expect(lines[4]).toBe("Including 1 helper request")
  })
})

describe("a block worth telling", () => {
  test("says what tried to reach where, and whether it can be allowed", () => {
    expect(blockedNotice({ source: "github", origin: "https://api.github.com" }, sources)).toEqual({
      title: "Vector Local blocked a request",
      description:
        "GitHub pull requests tried to reach api.github.com. It is outside the servers you listed. You can allow it in Settings > Vector Local.",
    })
    expect(blockedNotice({ source: "vector-free-models", origin: "https://vectordev.ai" }, sources).description).toBe(
      "Free models provided by Vector tried to reach vectordev.ai. It is outside the servers you listed, and Vector Local keeps it off.",
    )
  })

  test("a request no part of Vector labelled points at the network log", () => {
    expect(blockedNotice({ source: "unlabelled", origin: "https://198.51.100.7" }, sources).description).toBe(
      "A request no part of Vector labelled tried to reach 198.51.100.7, so Vector Local blocked it. The network log names the code that made it.",
    )
  })
})

describe("the Allow dialog", () => {
  test("offers Always allow for a service Vector Local blocks, and Allow once only for the engine's own downloads", () => {
    expect(allowChoices(source("github"), status())).toEqual({ once: false, always: true })
    expect(allowChoices(source("lsp-install"), status())).toEqual({ once: true, always: true })
    expect(allowChoices(source("embedding-model"), status())).toEqual({ once: true, always: true })
    // The app's own windows download the dictation model, which desktop main decides; an engine grant cannot answer it.
    expect(allowChoices(source("dictation-model"), status())).toEqual({ once: false, always: true })
    // A manual update check asks each time by itself.
    expect(allowChoices(source("updates"), status())).toEqual({ once: false, always: true })
  })

  test("under a lock that keeps allow, Always allow is gone and the dialog says the company set it", () => {
    const locked = status({
      policy: { lock: true, user_may: [] },
      locked: ["enabled", "endpoints", "allow", "web_domains", "web"],
    })
    expect(allowChoices(source("github"), locked)).toEqual({ once: false, always: false, note: LOCKED })
    // Allow once still answers one download: it is never saved, so the lock's list is unchanged.
    expect(allowChoices(source("lsp-install"), locked)).toEqual({ once: true, always: false, note: LOCKED })
  })

  test("under a lock that leaves allow to the user, Always allow stays", () => {
    const open = status({
      policy: { lock: true, user_may: ["allow"] },
      locked: ["enabled", "endpoints", "web_domains", "web"],
    })
    expect(allowChoices(source("github"), open)).toEqual({ once: false, always: true })
  })

  test("a Vector the agent started can allow nothing, and says why", () => {
    expect(allowChoices(source("github"), status({ agent: true }))).toEqual({ once: false, always: false, note: AGENT })
  })

  test("never offers to allow what Vector Local keeps off for good, or what the app hides in this release", () => {
    for (const id of [
      "vector-free-models",
      "vector-codium",
      "cloud-inference",
      "chatgpt-signin",
      "help-assistant",
      "external-agents",
      "everywhere",
      "unlabelled",
    ])
      expect(allowChoices(source(id), status())).toEqual({ once: false, always: false })
  })

  test("Always allow writes an allow entry with the trimmed reason, confirmed by the owner's answer", () => {
    expect(allowUpdate(source("github"), "  Our pull requests  ")).toEqual({
      allow: { add: [{ source: "github", reason: "Our pull requests" }] },
      confirm: true,
      by: "app",
    })
  })
})

// An allow entry with no hosts covers every host its source reaches (LocalPolicy.allowEntry), and Always allow adds
// one, so the dialog and Settings never present the registry's usual hosts as the limit.
describe("where an allowed service may go", () => {
  test("an entry that names hosts goes only to those", () => {
    expect(allowHosts(["tools.example.org"], ["x.example"])).toBe("tools.example.org")
  })

  test("an entry with no hosts covers any host the service reaches, and names the usual ones", () => {
    expect(allowHosts(undefined, ["github.com", "api.github.com", "vectordev.ai"])).toBe(
      "Any host it reaches, usually github.com, api.github.com and vectordev.ai",
    )
    expect(allowHosts([], source("github").hosts)).toBe(
      "Any host it reaches, usually github.com, api.github.com and vectordev.ai",
    )
  })

  test("a service whose address the user or company sets has no usual hosts to name", () => {
    expect(allowHosts(undefined, [])).toBe("The addresses set for it")
  })
})

describe("Off in Vector Local", () => {
  test("lists every source Vector Local restricts, never one it lets through or one nobody labelled", () => {
    const items = offInLocal(status(), { everywhere: true })
    const ids = items.map((item) => item.source.id)
    const restricted = sources.filter(
      (item) =>
        ["blocked", "ask-once", "allow-with-reason", "not-allowable"].includes(item.local) &&
        item.purpose !== "unknown",
    )
    expect(ids).toEqual(restricted.map((item) => item.id))
    // With the everywhere block off, the only change is that Jobs for this computer are not named.
    expect(offInLocal(status()).map((item) => item.source.id)).toEqual(ids.filter((id) => id !== "everywhere"))
    expect(ids).not.toContain("local-inference")
    expect(ids).not.toContain("webfetch")
    expect(ids).not.toContain("unlabelled")
  })

  test("says why, what it sends and where, and whether it can be allowed", () => {
    const free = offInLocal(status()).find((item) => item.source.id === "vector-free-models")!
    expect(free.state).toBe("never")
    expect(free.allowable).toBe(false)
    expect(free.why).toBe(
      "Free models provided by Vector sends prompts and context to vectordev.ai and openrouter.ai. Vector Local blocks it because it is outside the servers you listed. It cannot be allowed while Vector Local is on.",
    )
    const lsp = offInLocal(status()).find((item) => item.source.id === "lsp-install")!
    expect(lsp.state).toBe("asks")
    expect(lsp.why).toContain("registry.npmjs.org, proxy.golang.org, rubygems.org and 1 more")
    expect(lsp.why.endsWith("Vector Local asks before each one.")).toBe(true)
    // The help assistant answers that it is off, and external agents are not started: neither is hidden, and neither
    // offers Allow… in this release.
    const help = offInLocal(status()).find((item) => item.source.id === "help-assistant")!
    expect(help.state).toBe("never")
    expect(OFF_STATE[help.state]).toBe("Off in Vector Local")
    expect(help.allowable).toBe(false)
    expect(help.why).toBe(
      "The help assistant sends your question to vectordev.ai, so it is off while Vector Local is on. The Vector docs answer most questions without it.",
    )
    const external = offInLocal(status()).find((item) => item.source.id === "external-agents")!
    expect(external.state).toBe("never")
    expect(external.allowable).toBe(false)
    expect(external.why).toContain("Vector does not start them while Vector Local is on.")
    // Jobs for this computer are absent while the everywhere block is off. With it on they are listed under their
    // neutral name, kept off with no Allow… in this release.
    expect(offInLocal(status()).some((item) => item.source.id === "everywhere")).toBe(false)
    expect(offInLocal(status(), { everywhere: false }).some((item) => item.source.id === "everywhere")).toBe(false)
    const jobs = offInLocal(status(), { everywhere: true }).find((item) => item.source.id === "everywhere")!
    expect(jobs.name).toBe("Jobs for this computer")
    expect(jobs.state).toBe("never")
    expect(jobs.allowable).toBe(false)
    expect(jobs.why).toBe(
      "Jobs for this computer come from vectordev.ai and report back to it, so this computer takes none while Vector Local is on.",
    )
    expect(Object.values(OFF_STATE).some((label) => label.includes("Hidden"))).toBe(false)
  })

  test("a source the user allowed shows as allowed, with their reason", () => {
    const allowed = { source: "github", reason: "Our pull requests", added_at: 1, added_by: "app" as const }
    const item = offInLocal(status({ policy: { allow: [allowed] } })).find((entry) => entry.source.id === "github")!
    expect(item.state).toBe("allowed")
    expect(item.allowed).toEqual(allowed)
  })

  test("what Vector Local does not reach is said plainly instead", () => {
    expect(notCovered(status()).map((item) => item.id)).toEqual(["chromium-network", "agent-programs"])
  })

  test("every source in the registry has a name of its own, so no label shows a bare id", () => {
    for (const item of sources) expect(sourceName(item.id)).not.toBe(item.id)
  })
})

describe("the model picker's Off in Vector Local group", () => {
  test("lists each provider Vector Local keeps off with the engine's reason, and nothing else", () => {
    const off = offInLocalProviders([
      providerUnavailable("openai", "off-in-local"),
      {
        id: "vector",
        reason: "off-in-local",
        message: "vector: off in Vector Local. Free models provided by Vector send your prompts through vectordev.ai.",
      },
      providerUnavailable("anthropic", "disabled"),
    ])
    expect(off.map((item) => item.id)).toEqual(["openai", "vector"])
    expect(off[0]!.why).toBe(
      "Its server is not on your list of model servers. Add the server to the list, or turn Vector Local off to use it.",
    )
    expect(off[1]!.why).toBe("Free models provided by Vector send your prompts through vectordev.ai.")
    expect(offInLocalProviders(undefined)).toEqual([])
  })
})

describe("servers someone hosts", () => {
  // A server added in Vector, as GET /provider sends it: Add server and the setup wizard write the provider's base URL
  // and no model address, so the model's own api.url is empty, and the engine says where its requests go in `hosted`.
  // engine/test/server/local-app-models.test.ts reads this shape from the engine itself.
  const added = {
    id: "ollama",
    name: "Ollama (127.0.0.1:11434)",
    options: { baseURL: "http://127.0.0.1:11434/v1" },
    models: {
      "qwen3:30b": { id: "qwen3:30b", name: "qwen3:30b", api: { id: "qwen3:30b", url: "" } },
      "qwen3:8b": { id: "qwen3:8b", name: "qwen3:8b", api: { id: "qwen3:8b", url: "" } },
    },
  }
  const cloud = { id: "openai", name: "OpenAI", options: {}, models: { "gpt-5": { id: "gpt-5", name: "GPT-5" } } }
  const hosted = [
    { providerID: "ollama", modelID: "qwen3:30b", origin: "http://127.0.0.1:11434", local: true },
    { providerID: "ollama", modelID: "qwen3:8b", origin: "http://127.0.0.1:11434", local: true },
  ]

  test("a model counts as on a server someone hosts only where the engine says its requests go there", () => {
    expect(hostedServer(hosted, { providerID: "ollama", modelID: "qwen3:30b" })).toEqual(hosted[0])
    expect(hostedServer(hosted, { providerID: "openai", modelID: "gpt-5" })).toBeUndefined()
    // An engine that does not say leaves every model a cloud one, as before Vector Local.
    expect(hostedServer(undefined, { providerID: "ollama", modelID: "qwen3:30b" })).toBeUndefined()
  })

  test("Roles offers the connected models on a server someone hosts, even with an empty model address", () => {
    expect(roleModels({ providers: [added, cloud], connected: ["ollama", "openai"], hosted })).toEqual([
      { key: "ollama/qwen3:30b", label: "qwen3:30b (Ollama (127.0.0.1:11434))" },
      { key: "ollama/qwen3:8b", label: "qwen3:8b (Ollama (127.0.0.1:11434))" },
    ])
    // A provider that is not connected, or an engine that does not say, offers none.
    expect(roleModels({ providers: [added], connected: [], hosted })).toEqual([])
    expect(roleModels({ providers: [added], connected: ["ollama"] })).toEqual([])
  })

  test("labels where a server is, whether its prompts are encrypted and whether it forwards them", () => {
    expect(serverLabels({ class: "this-computer", encrypted: false, origin: "http://127.0.0.1:11434" })).toEqual([
      "This computer",
      SHARED_MACHINE,
    ])
    expect(
      serverLabels({ class: "your-network", encrypted: false, origin: "http://gpu-box:8000", forwards: "litellm" }),
    ).toEqual(["Your network", NOT_ENCRYPTED, FORWARDING])
  })

  test("a server that answers as another one says what changed", () => {
    expect(identityChanged("gpu-box", ["kind", "spki"])).toBe(
      "gpu-box now answers as a different server. Check it before sending prompts. Changed: the kind of server and its https key.",
    )
  })
})

describe("Local API errors", () => {
  test("a change that loosens Vector Local comes back with what it loosens", () => {
    expect(
      refusal({
        name: "LocalConfirmError",
        data: { message: "x", changes: ["turns Vector Local off"], identity: ["kind"] },
      }),
    ).toEqual({ type: "confirm", changes: ["turns Vector Local off"], identity: ["kind"] })
  })

  test("a refusal keeps the engine's reason, and anything else says Vector could not reach its engine", () => {
    expect(refusal({ name: "LocalError", data: { code: "locked", message: LOCKED } })).toEqual({
      type: "refused",
      code: "locked",
      message: LOCKED,
    })
    expect(refusal(new Error("socket closed"))).toEqual({ type: "error", message: "socket closed" })
    expect(refusal(undefined).type).toBe("error")
  })
})

describe("the network log", () => {
  const event = (input: Partial<EgressEvent> & { id: string; time: number }): EgressEvent => ({
    source: "local-inference",
    purpose: "inference",
    class: "listed",
    origin: "http://127.0.0.1:11434",
    method: "POST",
    decision: "allow",
    rule: "listed",
    reason: "This model server is on your list.",
    carried: { personal: 0, documents: 0, repository: 0 },
    ...input,
  })
  const events = [
    event({
      id: "e1",
      time: 1_000,
      session_id: "ses_a",
      root_session_id: "ses_a",
      bytes_out: 2048,
      bytes_in: 512,
      carried: { personal: 2, documents: 0, repository: 0 },
    }),
    event({
      id: "e2",
      time: 3_000,
      source: "model-catalog",
      purpose: "catalog",
      class: "internet",
      origin: "https://vectordev.ai",
      method: "GET",
      decision: "block",
      rule: "vector-service",
      reason: "Vector Local blocks requests to Vector's own services unless you allow one.",
    }),
    event({
      id: "e3",
      time: 2_000,
      source: "agent-browser",
      purpose: "browser",
      class: "internet",
      origin: "https://cdn.example.com",
      session_id: "ses_child",
      root_session_id: "ses_a",
      resource: "subresource",
      method: "GET",
      rule: "web-ask",
      reason: "Web access is set to Ask; the usual approval still applies.",
    }),
  ]

  test("names the code behind a blocked request no part of Vector labelled, as the toast says it does", () => {
    const unlabelled = event({
      id: "e4",
      time: 4_000,
      source: "unlabelled",
      purpose: "unknown",
      class: "internet",
      origin: "https://198.51.100.7",
      method: "GET",
      decision: "block",
      rule: "unlabelled",
      reason: "No part of Vector labelled this request.",
      frame: "packages/engine/src/plugin/example.ts:42:7",
    })
    const [row] = logRows([unlabelled], { filter: { result: "all", text: "" }, sources })
    expect(row?.code).toBe("Made by packages/engine/src/plugin/example.ts:42:7")
    expect(logRows(events, { filter: { result: "all", text: "" }, sources }).some((item) => item.code)).toBe(false)
  })

  test("says the view holds the engine's latest requests, and that Export has everything kept", () => {
    expect(LOG_HELD).toBe(EgressLogStore.RING_SIZE)
    expect(logDescription(30)).toBe(
      "The latest 2,000 requests Vector decided while Vector Local was on: where each went, never what it said. Export includes every request kept on this computer. Kept for 30 days on this computer.",
    )
  })

  test("lists the newest first, with what, where, the sizes, the result and the rule's reason", () => {
    const rows = logRows(events, { filter: { result: "all", text: "" }, sources })
    expect(rows.map((row) => row.id)).toEqual(["e2", "e3", "e1"])
    expect(rows[0]).toMatchObject({
      what: "Model catalog refresh",
      host: "vectordev.ai",
      where: "Internet",
      result: "Blocked",
    })
    expect(rows[1]).toMatchObject({
      what: "The agent's browser (loaded by a page)",
      host: "cdn.example.com",
      session: "ses_a",
    })
    expect(rows[2]).toMatchObject({
      sent: "2.0 KB",
      received: "512 B",
      where: "On your list",
      carried: "Carried 2 personal cards",
    })
    expect(rows[0]!.sent).toBe("–")
  })

  test("filters by result, by session (its subagents included) and by host or service", () => {
    const ids = (filter: Parameters<typeof logRows>[1]["filter"]) =>
      logRows(events, { filter, sources }).map((row) => row.id)
    expect(ids({ result: "blocked", text: "" })).toEqual(["e2"])
    expect(ids({ result: "allowed", text: "" })).toEqual(["e3", "e1"])
    expect(ids({ result: "all", session: "ses_a", text: "" })).toEqual(["e3", "e1"])
    expect(ids({ result: "all", text: "catalog" })).toEqual(["e2"])
    expect(ids({ result: "all", text: "CDN.EXAMPLE" })).toEqual(["e3"])
  })

  test("exports under a dated name", () => {
    expect(exportName("csv", Date.UTC(2026, 9, 23))).toBe("vector-network-log-2026-10-23.csv")
    expect(exportName("jsonl", Date.UTC(2026, 9, 23))).toBe("vector-network-log-2026-10-23.jsonl")
  })
})

describe("roles and the setup wizard", () => {
  const added: LocalAddedServer = {
    provider: "ollama",
    models: ["qwen3:8b", "qwen3:30b", "llama3.2:1b"],
    server: {
      kind: "ollama",
      name: "Ollama",
      origin: "http://127.0.0.1:11434",
      baseURL: "http://127.0.0.1:11434/v1",
      class: "this-computer",
      encrypted: false,
      models: [
        { id: "qwen3:8b", context: 40960, tools: true, parameters: "8.2B", size: 5.2e9 },
        { id: "qwen3:30b", context: 40960, tools: true, parameters: "30.5B", size: 18e9, loaded: true },
        { id: "llama3.2:1b", context: 131072, tools: false, parameters: "1.2B", size: 1.3e9 },
        { id: "gpt-oss:120b-cloud", tools: true, cloud: true, parameters: "120B" },
      ],
      pin: { kind: "ollama", version: "0.12.3" },
    },
    status: status(),
  }

  test("pre-fills every role with the largest model that calls tools, and never a cloud model", () => {
    const roles = suggestRoles([added])
    expect(roles).toEqual({
      agent: "ollama/qwen3:30b",
      subagent: "ollama/qwen3:30b",
      judge: "ollama/qwen3:30b",
      review: "ollama/qwen3:30b",
      small: "ollama/qwen3:30b",
      research: "ollama/qwen3:30b",
    })
  })

  test("titles and summaries take a smaller model only when both fit in this computer's memory", () => {
    expect(suggestRoles([added], 20e9).small).toBe("ollama/llama3.2:1b")
    expect(suggestRoles([added], 10e9).small).toBe("ollama/qwen3:30b")
  })

  test("roles write to the config keys the agents read, and read back the same", () => {
    const roles = {
      agent: "ollama/qwen3:30b",
      small: "ollama/llama3.2:1b",
      review: "ollama/qwen3:8b",
      research: "ollama/qwen3:30b",
    }
    const patch = rolesPatch(roles)
    expect(patch).toEqual({
      model: "ollama/qwen3:30b",
      small_model: "ollama/llama3.2:1b",
      agent: { review: { model: "ollama/qwen3:8b" }, research: { model: "ollama/qwen3:30b" } },
    })
    expect(configRoles(patch)).toEqual({ ...roles, subagent: undefined, judge: undefined })
  })

  test("Check models checks each model for every role it fills, since the engine measures each role's needs", () => {
    expect(
      checksFor({ agent: "a/x", subagent: "a/x", judge: "a/y", review: "a/y", research: "a/z", small: "a/w" }),
    ).toEqual([
      { model: "a/x", role: "agent" },
      { model: "a/x", role: "subagent" },
      { model: "a/y", role: "judge" },
      { model: "a/y", role: "review" },
      { model: "a/z", role: "research" },
    ])
    // Titles and summaries send no tools, so there is nothing to check for them.
    expect(checksFor({ small: "a/w" })).toEqual([])
  })

  test("a company lock that keeps model or small_model, or agent, keeps the roles they set", () => {
    const lock = { lock: true, locked_keys: ["model", "agent"] }
    expect(ROLES.filter((role) => roleLocked(role.id, lock)).map((role) => role.id)).toEqual([
      "agent",
      "subagent",
      "judge",
      "review",
      "research",
    ])
    expect(roleLocked("small", { lock: true, locked_keys: ["small_model"] })).toBe(true)
    // Without a lock, locked_keys means nothing.
    expect(roleLocked("agent", { lock: false, locked_keys: ["model"] })).toBe(false)
  })

  test("says each model's context, tools and images, and marks Ollama's cloud models", () => {
    expect(modelFacts(added.server.models[1]!)).toMatchObject({
      context: "40,960-token context",
      tools: "Calls tools",
      vision: "Text only",
      loaded: "Loaded",
    })
    expect(modelFacts(added.server.models[3]!)).toMatchObject({
      context: "Context unknown until checked",
      cloud: "Ollama cloud model: off in Vector Local",
    })
    expect(modelFacts({ id: "m", context: "NaN" }).context).toBe("Context unknown until checked")
    expect(modelFacts({ id: "m" }).tools).toBe("Tools unknown until checked")
  })
})

describe("copy", () => {
  // The honest-copy rules (plan section 17): no absolute claims, and "repository", never "project".
  const copy: unknown[] = [
    ADMIN,
    AGENT,
    CHECK_RESULT,
    COST,
    COVERS_TITLE,
    DEFINITION,
    FORWARDING,
    GUEST,
    LOCKED,
    LOG_TITLE,
    LOOSENING,
    NOT_COVERED,
    NOT_ENCRYPTED,
    NO_VISION,
    OFF_STATE,
    PROGRAMS,
    RESTART,
    RESULTS,
    ROLES,
    SHARED_MACHINE,
    SUBTITLE,
    WEB_ACCESS,
    sources.map((item) => [sourceName(item.id), offWhy(item)]),
  ]
  const strings = copy.flatMap(function collect(value: unknown): string[] {
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.flatMap(collect)
    if (value && typeof value === "object") return Object.values(value).flatMap(collect)
    return []
  })

  test("makes no absolute claims and never says project", () => {
    expect(strings.length).toBeGreaterThan(40)
    for (const text of strings)
      for (const banned of [
        /\bexactly\b/i,
        /never exceeds/i,
        /absolute privacy/i,
        /controlled only by you/i,
        /\bprojects?\b/i,
      ])
        expect(text).not.toMatch(banned)
  })
})
