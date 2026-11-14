import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { OFF_IN_LOCAL } from "@vectordevai/schema/provider-unavailable"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// Vector Local in the app against a mocked engine standing for the fake model server: the setup wizard from Getting
// started's "Models you host" to a first session on the model it set up, the composer's pill and popover, the model
// picker's Off in Vector Local group, Settings > Vector Local's Add server asking before it loosens, the Allow dialog
// under a company lock, the Off in Vector Local labels where the features are, and a guest's view. The engine's side
// (the Local API, Egress, the checks against the fake LLM server) has its own tests; here its answers are recorded
// shapes of those routes. The provider list's shape for a server added in Vector is the engine's own:
// engine/test/server/local-app-models.test.ts adds one through the Local API and feeds GET /provider to the app's code.

const directory = "C:/Vector/VectorLocal"
const projectID = "proj_vector_local"
const sessionID = "ses_vector_local"
const title = "Local session"
const origin = "http://127.0.0.1:11434"

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

const server = {
  kind: "ollama",
  name: "Ollama",
  origin,
  baseURL: `${origin}/v1`,
  version: "0.12.3",
  class: "this-computer",
  encrypted: false,
  models: [
    { id: "qwen3:30b", context: 40960, tools: true, vision: false, loaded: true, size: 18e9, parameters: "30.5B" },
    { id: "qwen3:8b", context: 40960, tools: true, vision: false, size: 5.2e9, parameters: "8.2B" },
    { id: "gpt-oss:120b-cloud", tools: true, cloud: true, parameters: "120B" },
  ],
  pin: { kind: "ollama", version: "0.12.3", models: "9f2c" },
}

// A model of a server added in Vector, as GET /provider sends it: the provider holds the base URL and the model's own
// address is empty, so only the list's `hosted` says that its requests go to a server someone hosts.
const hosted = (id: string, name: string) => ({
  id,
  name,
  providerID: "ollama",
  api: { id, url: "", npm: "@ai-sdk/openai-compatible" },
  limit: { context: 40960, output: 8192 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  variants: {},
  capabilities: { toolcall: true, input: { text: true, image: false }, output: { text: true } },
  modalities: { input: ["text"], output: ["text"] },
  tool_call: true,
})

function policy(input: Partial<LocalMode.Policy> = {}): LocalMode.Policy {
  return { ...LocalPolicy.OFF, ...input }
}

async function setup(
  page: Page,
  input: {
    policy?: LocalMode.Policy
    locked?: string[]
    added?: boolean
    guest?: boolean
    onboarding?: boolean
    /** Envelopes on the global event stream, such as local.blocked. */
    events?: unknown[]
  } = {},
) {
  const state = {
    policy: input.policy ?? policy(),
    locked: input.locked ?? [],
    added: input.added ?? false,
    config: {} as Record<string, unknown>,
    updates: [] as Record<string, unknown>[],
    servers: [] as Record<string, unknown>[],
    checks: [] as Record<string, unknown>[],
    configs: [] as Record<string, unknown>[],
    prompts: [] as { model?: { providerID: string; modelID: string }; executionMode?: string }[],
  }
  const status = () => ({
    policy: state.policy,
    locked: state.locked,
    log: { directory: "/home/me/.local/share/vector/local", retain_days: 30 },
    agent: false,
    sources,
  })
  // The engine lists every provider it knows in `all`; Vector Local leaves the ones it keeps off out of `connected` and
  // says why in `unavailable`.
  const catalog = () => ({
    all: [
      { id: "openai", name: "OpenAI", source: "api", models: {} },
      ...(state.added
        ? [
            {
              id: "ollama",
              name: "Ollama",
              source: "config",
              options: { baseURL: `${origin}/v1` },
              models: { "qwen3:30b": hosted("qwen3:30b", "Qwen3 30B"), "qwen3:8b": hosted("qwen3:8b", "Qwen3 8B") },
            },
          ]
        : []),
    ],
    connected: state.added ? ["ollama"] : [],
    default: state.added ? { ollama: "qwen3:30b" } : {},
    ...(state.added
      ? {
          hosted: ["qwen3:30b", "qwen3:8b"].map((modelID) => ({ providerID: "ollama", modelID, origin, local: true })),
        }
      : {}),
    ...(state.policy.enabled
      ? {
          unavailable: [
            { id: "openai", reason: "off-in-local", message: `openai: off in Vector Local. ${OFF_IN_LOCAL.listed}` },
          ],
        }
      : {}),
  })
  await mockVectorServer(page, {
    agents: [
      { name: "build", mode: "primary" },
      { name: "research", mode: "primary" },
    ],
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "Vector Local",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: catalog(),
    sessions: [{ id: sessionID, slug: "local", projectID, directory, title, time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
    events: () => input.events ?? [],
  })
  const owner =
    (body: () => unknown, status = 200) =>
    (route: Route) =>
      input.guest
        ? route.fulfill({
            status: 403,
            json: { name: "ForbiddenError", data: { message: "Only the owner of this server" } },
          })
        : route.fulfill({ status, json: body() })
  await page.route(/\/provider(?:\?|$)/, (route) => route.fulfill({ json: catalog() }))
  await page.route(/\/(?:global\/)?config(?:\?|$)/, async (route) => {
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON() as Record<string, unknown>
      state.configs.push(patch)
      state.config = { ...state.config, ...patch }
    }
    return route.fulfill({ json: state.config })
  })
  await page.route(/\/local(?:\?|$)/, async (route) => {
    if (input.guest) return owner(status)(route)
    if (route.request().method() !== "PATCH") return route.fulfill({ json: status() })
    const update = route.request().postDataJSON() as Record<string, unknown>
    state.updates.push(update)
    if (update.enabled === true) state.policy = { ...state.policy, enabled: true }
    if (typeof update.web === "string") state.policy = { ...state.policy, web: update.web as LocalMode.Web }
    const allow = (update.allow as { add?: { source: string; reason: string }[] } | undefined)?.add ?? []
    state.policy = {
      ...state.policy,
      allow: [...state.policy.allow, ...allow.map((entry) => ({ ...entry, added_at: 1, added_by: "app" as const }))],
    }
    return route.fulfill({ json: status() })
  })
  await page.route(
    /\/local\/detect(?:\?|$)/,
    owner(() => [server]),
  )
  await page.route(/\/local\/servers(?:\?|$)/, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    state.servers.push(body)
    // With Vector Local on, putting a server on the list loosens it, so the engine asks first.
    if (state.policy.enabled && body.confirm !== true)
      return route.fulfill({
        status: 409,
        json: {
          name: "LocalConfirmError",
          data: {
            message: "This change would loosen Vector Local. Apply it?",
            changes: [`lists ${body.url} as a model server`],
          },
        },
      })
    state.added = true
    const at = LocalPolicy.origin(String(body.url))!
    state.policy = {
      ...state.policy,
      endpoints: [...state.policy.endpoints.filter((item) => item.origin !== at), { origin: at, from: "user" }],
      pins: { ...state.policy.pins, [at]: server.pin },
    }
    return route.fulfill({
      json: {
        provider: "ollama",
        models: ["qwen3:30b", "qwen3:8b"],
        server: { ...server, origin: at },
        status: status(),
      },
    })
  })
  await page.route(/\/local\/check(?:\?|$)/, (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>
    state.checks.push(body)
    return route.fulfill({
      json: {
        enabled: state.policy.enabled,
        result: state.policy.enabled ? "pass" : "off",
        rows: [{ layer: "switch", status: "pass", title: "Vector Local is on" }],
        ...(body.model
          ? {
              model: {
                model: body.model,
                result: "works",
                ttft_ms: 900,
                requests: 3,
                checked_at: 1,
                server_version: "0.12.3",
              },
            }
          : {}),
      },
    })
  })
  await page.route(
    /\/local\/egress\/summary(?:\?|$)/,
    owner(() => ({
      requests: 4,
      helper_requests: 1,
      model_calls: { [origin]: 2 },
      pages: 0,
      hosts: 0,
      searches: 0,
      carried: { personal: 3, documents: 0, repository: 0 },
      blocked: { "model-catalog": 1 },
    })),
  )
  await page.route(
    /\/local\/egress(?:\?|$)/,
    owner(() => [
      {
        id: "egr_0",
        time: Date.UTC(2026, 9, 23, 9, 31),
        source: "local-inference",
        purpose: "inference",
        class: "listed",
        origin,
        method: "POST",
        bytes_out: 18_432,
        bytes_in: 2_048,
        decision: "allow",
        rule: "listed",
        reason: "This model server is on your list.",
        session_id: sessionID,
        root_session_id: sessionID,
        carried: { personal: 3, documents: 0, repository: 0 },
      },
      {
        id: "egr_1",
        time: Date.UTC(2026, 9, 23, 9, 30),
        source: "model-catalog",
        purpose: "catalog",
        class: "internet",
        origin: "https://vectordev.ai",
        method: "GET",
        decision: "block",
        rule: "vector-service",
        reason: "Vector Local blocks requests to Vector's own services unless you allow one.",
        carried: { personal: 0, documents: 0, repository: 0 },
      },
    ]),
  )
  await page.route(/\/session\/[^/]+\/prompt_async(?:\?|$)/, (route) => {
    state.prompts.push(route.request().postDataJSON())
    return route.fulfill({ status: 204, body: "" })
  })
  await page.addInitScript(
    (setup) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      if (!setup.onboarding)
        localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
      localStorage.setItem(
        "vector.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: setup.directory, expanded: true }] },
          lastProject: { local: setup.directory },
        }),
      )
    },
    { directory, onboarding: input.onboarding ?? false },
  )
  return state
}

const sessionPath = `/${base64Encode(directory)}/session/${sessionID}`

// Opens the session; the app moves its address to the server's own route first, which mounts the page again.
async function openSession(page: Page) {
  await page.goto(sessionPath)
  await page.waitForURL(/\/server\/[^/]+\/session\//)
  await expectSessionTitle(page, title)
}
const composer = (page: Page) => page.locator('[data-component="prompt-input"]').filter({ visible: true }).first()
const pill = (page: Page) => page.locator('[data-action="prompt-local-pill"]').filter({ visible: true }).first()

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Vector Local", exact: true }).click()
  return settings.locator('[data-component="settings-local"]')
}

test("the setup wizard goes from Models you host to a first Local session on the model it set up", async ({ page }) => {
  const state = await setup(page, { onboarding: true })
  await page.goto("/")
  const card = page.locator('[data-component="onboarding-models-you-host"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText("Models you host (Vector Local)")
  await card.getByRole("button", { name: "Set up" }).click()

  const wizard = page.locator(".vector-local-setup")
  // Find servers: this computer only, then the server it found, chosen.
  await expect(wizard).toContainText("It never scans your network")
  const found = wizard.locator(`[data-origin="${origin}"]`)
  await expect(found).toContainText("Ollama 0.12.3")
  await expect(found).toContainText("3 models")
  await expect(found).toContainText("Another user on this computer could run a server on this port.")
  await page.screenshot({ path: test.info().outputPath("01-wizard-servers.png"), animations: "disabled" })
  await wizard.getByRole("button", { name: "Add server" }).click()

  // Models: tools, context and images for each, and Ollama's cloud model marked as off.
  await expect(wizard.locator('tr[data-model="qwen3:30b"]')).toContainText("40,960-token context")
  await expect(wizard.locator('tr[data-model="qwen3:30b"]')).toContainText("Calls tools")
  await expect(wizard.locator('tr[data-model="qwen3:30b"]')).toContainText("Text only")
  await expect(wizard.locator('tr[data-model="gpt-oss:120b-cloud"]')).toContainText(
    "Ollama cloud model: off in Vector Local",
  )
  expect(state.servers).toEqual([{ url: `${origin}/v1` }])
  await page.screenshot({ path: test.info().outputPath("02-wizard-models.png"), animations: "disabled" })
  await wizard.getByRole("button", { name: "Next" }).click()

  // Roles: pre-filled with the largest model that calls tools.
  for (const role of ["Main agent", "Subagents", "Judge", "Vectorscope", "Titles and summaries", "Deep research"])
    await expect(wizard.getByLabel(role, { exact: true })).toHaveValue("ollama/qwen3:30b")
  await wizard.getByRole("button", { name: "Next" }).click()

  // Check: nothing runs until Check models is pressed, then the model is checked for every role it fills, since each
  // role sends its own prompt and tools. Titles and summaries send none, so they are not checked.
  await expect(wizard.getByRole("button", { name: "Skip checks" })).toBeVisible()
  expect(state.checks).toEqual([])
  await wizard.getByRole("button", { name: "Check models" }).click()
  await expect(wizard.locator('[data-model="ollama/qwen3:30b"] [data-slot="local-check-result"]')).toHaveText(
    Array.from({ length: 5 }, () => "Works with Vector's tools"),
  )
  expect(state.checks).toEqual(
    ["agent", "subagent", "judge", "review", "research"].map((role) => ({ model: "ollama/qwen3:30b", role })),
  )
  await page.screenshot({ path: test.info().outputPath("03-wizard-check.png"), animations: "disabled" })
  await wizard.getByRole("button", { name: "Next" }).click()

  await wizard.getByText("Your network only", { exact: true }).click()
  await wizard.getByRole("button", { name: "Next" }).click()
  await expect(wizard).toContainText("use only the model servers on your list")
  await wizard.getByRole("button", { name: "Turn on Vector Local" }).click()
  await expect(wizard).toContainText("Vector Local is on")
  await expect(wizard).toContainText("Model calls go only to the 1 server on your list. Web access: Your network only.")
  // Turning it on only tightens, so it applied with no confirmation; the roles went to the user's config.
  expect(state.updates).toEqual([{ enabled: true, web: "network", by: "app" }])
  expect(state.configs).toEqual([
    {
      model: "ollama/qwen3:30b",
      small_model: "ollama/qwen3:30b",
      agent: {
        general: { model: "ollama/qwen3:30b" },
        judge: { model: "ollama/qwen3:30b" },
        review: { model: "ollama/qwen3:30b" },
        research: { model: "ollama/qwen3:30b" },
      },
    },
  ])
  await page.screenshot({ path: test.info().outputPath("04-wizard-done.png"), animations: "disabled" })
  await wizard.getByRole("button", { name: "Done" }).click()

  // The first Local session: the pill, no Fast for a model on a server you host, and the prompt on that model.
  await openSession(page)
  await expect(pill(page)).toHaveText("Local · your network")
  await page.locator('[data-action="prompt-execution-mode"]').filter({ visible: true }).first().click()
  const menu = page.locator('[data-component="prompt-mode-menu"]')
  await expect(menu).toBeVisible()
  const labels = await menu
    .locator("button")
    .evaluateAll((items) => items.map((item) => item.querySelector("span span")?.textContent?.trim() ?? ""))
  expect(labels).toEqual(["Normal", "Quick", "Deep researchPreview"])
  await page.keyboard.press("Escape")

  await pill(page).click()
  const popover = page.locator('[data-component="local-popover"]')
  await expect(popover).toContainText("This session, with its subagents and helpers")
  await expect(popover.locator('[data-line="models"]')).toHaveText("Model calls: 2 to 127.0.0.1:11434 (Ollama)")
  await expect(popover.locator('[data-line="memory"]')).toHaveText(
    "Memory sent: 3 personal cards, all to 127.0.0.1:11434",
  )
  await expect(popover.locator('[data-line="blocked"]')).toHaveText("Blocked: 1 (Model catalog refresh 1)")
  await expect(popover.locator('[data-line="helpers"]')).toHaveText("Including 1 helper request")
  await page.screenshot({ path: test.info().outputPath("05-session-popover.png"), animations: "disabled" })
  await popover.getByRole("button", { name: "What Vector sent" }).click()
  // The log opens on this session: its model call, where it went, its sizes and the memory it carried.
  const log = page.locator(".vector-local-log-dialog")
  await expect(log.locator("tbody tr")).toHaveCount(1)
  await expect(log.locator("tbody tr")).toContainText("Model servers on your list")
  await expect(log.locator("tbody tr")).toContainText("127.0.0.1:11434")
  await expect(log.locator("tbody tr")).toContainText("18.0 KB")
  await expect(log.locator("tbody tr")).toContainText("Carried 3 personal cards")
  // Every request, the blocked catalog refresh outside any session included.
  await log.getByLabel("This session only").uncheck()
  await expect(log.locator("tbody tr")).toHaveCount(2)
  await expect(log.locator("tbody tr").first()).toContainText(title)
  await log.getByRole("button", { name: "Blocked or asked" }).click()
  await expect(log.locator("tbody tr")).toHaveCount(1)
  await expect(log.locator("tbody tr")).toContainText("Model catalog refresh")
  await expect(log.locator("tbody tr")).toContainText("vectordev.ai")
  await expect(log.locator("tbody tr")).toContainText("Blocked")
  await page.screenshot({ path: test.info().outputPath("06-network-log.png"), animations: "disabled" })
  await page.keyboard.press("Escape")
  await expect(log).toHaveCount(0)

  await composer(page).click()
  await page.keyboard.type("Summarize this repository")
  await page.keyboard.press("Enter")
  await expect.poll(() => state.prompts.length).toBe(1)
  expect(state.prompts[0]).toMatchObject({
    model: { providerID: "ollama", modelID: "qwen3:30b" },
    executionMode: "normal",
  })
})

test("Getting started says free models are off while Vector Local is on, beside Models you host", async ({ page }) => {
  await setup(page, { onboarding: true, policy: policy({ enabled: true, web: "ask" }) })
  await page.goto("/")
  const card = page.locator('[data-component="onboarding-models-you-host"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  const off = card.locator('[data-component="local-off"][data-source="vector-free-models"]')
  await expect(off).toContainText("Off in Vector Local")
  await expect(off).toContainText("Free models provided by Vector")
  await expect(off.getByRole("button", { name: "Allow…" })).toHaveCount(0)
  await off.getByRole("button", { name: "Why" }).click()
  await expect(off).toContainText("It cannot be allowed while Vector Local is on.")
})

test("the model picker keeps what Vector Local turned off in a collapsed group that says why", async ({ page }) => {
  await setup(page, {
    added: true,
    policy: policy({
      enabled: true,
      web: "ask",
      endpoints: [{ origin, from: "user" }],
      pins: { [origin]: server.pin },
    }),
  })
  await openSession(page)
  await expect(pill(page)).toHaveText("Local")
  await page.locator('[data-action="prompt-model"]').filter({ visible: true }).first().click()
  const group = page.locator('[data-component="model-off-in-local"]').filter({ visible: true }).first()
  await expect(group).toContainText("Off in Vector Local (1)")
  await expect(group).not.toContainText(OFF_IN_LOCAL.listed)
  await group.getByRole("button", { name: /Off in Vector Local/ }).click()
  await expect(group).toContainText("OpenAI")
  await expect(group).toContainText(OFF_IN_LOCAL.listed)
  await page.screenshot({ path: test.info().outputPath("07-picker-off-in-local.png"), animations: "disabled" })
})

test("a block the engine says is worth telling shows once and opens the network log", async ({ page }) => {
  await setup(page, {
    added: true,
    policy: policy({ enabled: true, web: "ask", endpoints: [{ origin, from: "user" }] }),
    events: [
      {
        directory: "global",
        payload: { type: "local.blocked", properties: { source: "github", origin: "https://api.github.com" } },
      },
    ],
  })
  await openSession(page)
  const toast = page.getByText("Vector Local blocked a request")
  await expect(toast).toHaveCount(1)
  await expect(
    page.getByText(
      "GitHub pull requests tried to reach api.github.com. It is outside the servers you listed. You can allow it in Settings > Vector Local.",
    ),
  ).toBeVisible()
  // The stream delivers it again on every reconnect; the app still shows it once.
  await page.waitForTimeout(1_500)
  await expect(toast).toHaveCount(1)
  await page.getByRole("button", { name: "What Vector sent" }).click()
  await expect(page.locator(".vector-local-log-dialog")).toBeVisible()
})

test("Settings > Vector Local asks before Add server loosens it, and lists every server's labels", async ({ page }) => {
  const state = await setup(page, {
    added: true,
    policy: policy({
      enabled: true,
      web: "network",
      endpoints: [{ origin, from: "user" }],
      pins: { [origin]: server.pin },
    }),
  })
  await openSession(page)
  const pane = await openSettings(page)
  await expect(pane.getByRole("switch", { name: "Vector Local" })).toBeChecked()
  // Roles offers the models on the server added in Vector, though their own address is empty.
  const agent = pane.locator('[data-section="roles"]').getByLabel("Main agent", { exact: true })
  await expect(agent.locator("option")).toHaveText([
    "Same as the session's model",
    "Qwen3 30B (Ollama)",
    "Qwen3 8B (Ollama)",
  ])
  const servers = pane.locator('[data-section="servers"]')
  await expect(servers.locator(`[data-origin="${origin}"]`)).toContainText("Answers as Ollama 0.12.3")
  await expect(servers.locator(`[data-origin="${origin}"]`)).toContainText("This computer")

  await servers.getByLabel("Server address").fill("http://gpu-box:8000")
  await servers.getByRole("button", { name: "Add server" }).click()
  const confirm = page.locator(".vector-local-confirm-dialog")
  await expect(confirm).toContainText("This change would loosen Vector Local. Apply it?")
  await expect(confirm).toContainText("It lists http://gpu-box:8000 as a model server.")
  expect(state.servers).toEqual([{ url: "http://gpu-box:8000" }])
  await confirm.getByRole("button", { name: "Apply" }).click()
  // Settings stays inert while the confirmation closes, and what is typed into it before then is lost.
  await expect(confirm).toHaveCount(0)
  await expect(servers.locator('[data-origin="http://gpu-box:8000"]')).toContainText(
    "Not encrypted: prompts to this server travel in plain text on your network.",
  )
  expect(state.servers).toEqual([{ url: "http://gpu-box:8000" }, { url: "http://gpu-box:8000", confirm: true }])

  // Cancelling sends nothing more. The field empties once the server is added, before it is typed in again.
  await expect(servers.getByLabel("Server address")).toHaveValue("")
  // The dialog stack drops a closed confirmation 100 ms after it closes, and Settings stays inert until then. The
  // confirmation can leave the page and the field can read empty before that, while what is typed still goes nowhere
  // and Add server stays disabled, so type again until Add server takes it.
  const addServer = servers.getByRole("button", { name: "Add server" })
  await expect(async () => {
    await servers.getByLabel("Server address").fill("http://other-box:8000")
    await expect(addServer).toBeEnabled({ timeout: 1_000 })
  }).toPass()
  await addServer.click()
  await page.locator(".vector-local-confirm-dialog").getByRole("button", { name: "Cancel" }).click()
  await expect(pane).toContainText("Nothing changed.")
  expect(state.servers).toHaveLength(3)
  await page.screenshot({ path: test.info().outputPath("08-settings-local.png"), animations: "disabled" })
})

test("under a company lock the Allow dialog offers no Always allow, and the switch says who set it", async ({
  page,
}) => {
  const state = await setup(page, {
    added: true,
    policy: policy({
      enabled: true,
      lock: true,
      web: "network",
      endpoints: [{ origin, from: "managed" }],
      user_may: ["web"],
    }),
    locked: ["enabled", "endpoints", "allow", "web_domains"],
  })
  await openSession(page)
  await expect(pill(page)).toHaveAttribute("data-locked", "")
  const pane = await openSettings(page)
  await expect(pane.getByRole("switch", { name: "Vector Local" })).toBeDisabled()
  await expect(pane.locator('[data-section="switch"]')).toContainText(
    "Set by your company. Ask your administrator to change it.",
  )
  await expect(pane.getByRole("radio", { name: /^Ask/ })).toBeDisabled()
  await expect(pane.getByRole("radio", { name: /^None/ })).toBeEnabled()

  const github = pane.locator('[data-component="local-off"][data-source="github"]')
  await github.getByRole("button", { name: "Why" }).click()
  await expect(github).toContainText("GitHub pull requests sends")
  await github.getByRole("button", { name: "Allow…" }).click()
  const allow = page.locator(".vector-local-allow-dialog")
  await expect(allow).toContainText("Allow GitHub pull requests?")
  await expect(allow).toContainText("github.com, api.github.com and vectordev.ai")
  await expect(allow).toContainText("Set by your company. Ask your administrator to change it.")
  await expect(allow.getByRole("button", { name: "Always allow" })).toHaveCount(0)
  await expect(allow.getByRole("button", { name: "Allow once" })).toHaveCount(0)
  await allow.getByRole("button", { name: "Cancel" }).click()
  expect(state.updates).toEqual([])

  // A download the engine makes still has Allow once, which is never saved.
  const lsp = pane.locator('[data-component="local-off"][data-source="lsp-install"]')
  await lsp.getByRole("button", { name: "Allow…" }).click()
  await expect(page.locator(".vector-local-allow-dialog").getByRole("button", { name: "Allow once" })).toBeVisible()
  await expect(page.locator(".vector-local-allow-dialog").getByRole("button", { name: "Always allow" })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("09-allow-under-lock.png"), animations: "disabled" })
})

test("without a lock, Always allow saves the service with the owner's reason", async ({ page }) => {
  const state = await setup(page, {
    added: true,
    policy: policy({ enabled: true, web: "ask", endpoints: [{ origin, from: "user" }] }),
  })
  await openSession(page)
  const pane = await openSettings(page)
  await pane
    .locator('[data-component="local-off"][data-source="github"]')
    .getByRole("button", { name: "Allow…" })
    .click()
  const allow = page.locator(".vector-local-allow-dialog")
  await allow.getByLabel("Reason").fill("Our pull requests")
  await allow.getByRole("button", { name: "Always allow" }).click()
  await expect(allow).toHaveCount(0)
  expect(state.updates).toEqual([
    { allow: { add: [{ source: "github", reason: "Our pull requests" }] }, confirm: true, by: "app" },
  ])
  const allowed = pane.locator('[data-section="allowed"] [data-source="github"]')
  await expect(allowed).toContainText("Reason: Our pull requests")
  await expect(pane.locator('[data-component="local-off"][data-source="github"]')).toContainText("Allowed")
})

test("a guest sees whose Vector Local this is, no network log and no pill", async ({ page }) => {
  await setup(page, { guest: true, added: true })
  await openSession(page)
  await expect(composer(page)).toBeVisible()
  await expect(page.locator('[data-action="prompt-local-pill"]')).toHaveCount(0)
  const pane = await openSettings(page)
  await expect(pane).toContainText("Vector Local and its network log are visible to the owner of this Vector.")
  await expect(pane.getByRole("button", { name: "Open" })).toHaveCount(0)
  await expect(pane.locator('[data-section="log"]')).toHaveCount(0)
})

test("the places Vector Local keeps a feature off say so: outside agents, Providers & keys, and Updates & about", async ({
  page,
}) => {
  await setup(page, {
    added: true,
    policy: policy({ enabled: true, web: "ask", endpoints: [{ origin, from: "user" }] }),
  })
  await openSession(page)

  // The shared Host locally tile stays visible, with the Local refusal and no Allow….
  await page.getByRole("button", { name: "New workspace", exact: true }).click()
  const launcher = page.getByRole("dialog", { name: "New isolated agent" })
  await expect(launcher).toBeVisible()
  await expect(launcher.getByRole("button", { name: /^Host locally:/ })).toBeVisible()
  const external = launcher.locator('[data-component="local-off"][data-source="external-agents"]')
  await expect(external).toContainText("Off in Vector Local")
  await expect(external.getByRole("button", { name: "Allow…" })).toHaveCount(0)
  await external.getByRole("button", { name: "Why" }).click()
  await expect(external).toContainText("Vector does not start them while Vector Local is on.")
  await expect(launcher).not.toContainText("Needs setup on this computer")
  await page.screenshot({ path: test.info().outputPath("10-external-agents-off.png"), animations: "disabled" })
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Providers & keys", exact: true }).click()
  const cloud = settings.locator('[data-component="local-off"][data-source="cloud-inference"]')
  await expect(cloud).toContainText("Off in Vector Local")
  await expect(cloud).toContainText("Cloud AI services")
  await expect(settings.locator('[data-component="local-off"][data-source="chatgpt-signin"]')).toContainText(
    "ChatGPT sign-in",
  )

  await settings.getByRole("tab", { name: "Updates & about", exact: true }).click()
  await expect(settings.locator('[data-component="local-off"][data-source="updates"]')).toContainText("Asks first")
  const notes = settings.locator('[data-component="local-off"][data-source="release-notes"]')
  await expect(notes).toContainText("Off in Vector Local")
  await expect(notes.getByRole("button", { name: "Allow…" })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("11-updates-off.png"), animations: "disabled" })
})
