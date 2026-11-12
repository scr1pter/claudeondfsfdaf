import { expect, test, type Locator, type Page, type Request } from "@playwright/test"
import { reply } from "../utils/mock-server"
import { port, provider, rootID, setup, type Setup } from "../utils/multiagent"

const card = (page: Page) => page.locator('[data-component="vectorscope-settings"]')
async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings).toBeVisible()
  await settings.getByRole("tab", { name: "Agents", exact: true }).click()
  return settings
}
async function disableReviews(settings: Locator) {
  const enabled = settings.getByRole("switch", { name: "Enable VectorScope reviews", exact: true })
  await expect(enabled).toBeChecked()
  // Kobalte's visible control covers its native input. Exercise the ordinary
  // keyboard interaction instead of forcing a pointer through that control.
  await enabled.focus()
  await expect(enabled).toBeFocused()
  await enabled.press("Space")
  await expect(enabled).not.toBeChecked()
}
function engine(extra: Setup = {}): Setup {
  return {
    capabilities: { vectorscopeSettings: true, subagentLimits: true, workDelegation: true },
    globalConfig: {
      experimental: { vectorscope: true },
      agent: {
        review: { model: "generic/reviewer", disable: true },
        vectorscope: { model: "missing/old", variant: "old", disable: false },
      },
    },
    workflow: (request) => (request.action === "saved" ? { workflows: [] } : undefined),
    ...extra,
  }
}
async function catalog(page: Page) {
  const data = provider()
  data.all[0]!.models["maker/text"]!.variants = { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } }
  await page.route(
    (url) => url.port === port && url.pathname === "/provider",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(data),
      }),
  )
}

for (const mode of ["default-off", "old-engine", "guest", "owner-check-error", "owner-check-malformed"] as const)
  test(`VectorScope settings stay hidden for ${mode}`, async ({ page }) => {
    let ownerProbes = 0
    const behavior = engine(
      mode === "default-off"
        ? { globalConfig: {} }
        : mode === "old-engine"
          ? { capabilities: { subagentLimits: true } }
          : mode === "guest"
            ? { workflow: () => reply(403, { name: "Forbidden", data: { message: "Owner only" } }) }
            : mode === "owner-check-error"
              ? { workflow: () => reply(500, { name: "UnknownError", data: { message: "Unavailable" } }) }
              : { workflow: () => ({ workflows: "malformed" }) },
    )
    const app = await setup(page, {
      ...behavior,
      workflow: (request) => {
        if (request.action === "saved") ownerProbes++
        return behavior.workflow?.(request)
      },
    })
    const checked = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.port === port && url.pathname === "/experimental/workflow/saved"
    })
    await app.open()
    const settings = await openSettings(page)
    await expect(settings.getByRole("heading", { name: "Subagents", exact: true })).toBeVisible()
    await (await checked).finished()
    // The mock's mutation capture intentionally excludes GET. Observe the
    // actual owner probe and let its response reach Solid before asserting a
    // negative gate, rather than passing while authorization is still pending.
    expect(ownerProbes).toBeGreaterThan(0)
    await page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
    )
    await expect(card(page)).toHaveCount(0)
    expect(app.capture.config).toEqual([])
  })

test("the owner saves a separate model, variant and disable setting only after confirming running work", async ({
  page,
}, info) => {
  const app = await setup(page, engine({ status: { [rootID]: { type: "busy" } } }))
  let phase = "before-app-open"
  let pageErrors = 0
  let consoleErrors = 0
  const errors: { type: string; phase: string; message: string; stack?: string }[] = []
  const seenErrors = new Set<string>()
  const recordError = (type: string, message: string, stack?: string) => {
    const key = `${type}:${message}`
    if (seenErrors.has(key) || errors.filter((record) => record.type === type).length >= 4) return
    seenErrors.add(key)
    const record = { type, phase, message: message.slice(0, 1_000), ...(stack ? { stack: stack.slice(0, 3_500) } : {}) }
    errors.push(record)
    console.log("SCOPE_PICKER_BROWSER_ERROR", JSON.stringify(record))
  }
  page.on("pageerror", (error) => {
    pageErrors++
    recordError("pageerror", error.message, error.stack)
  })
  const pendingRequests = new Map<Request, { method: string; url: string; status?: number; eventStream?: boolean }>()
  page.on("request", (request) => {
    const url = new URL(request.url())
    pendingRequests.set(request, { method: request.method(), url: url.origin + url.pathname })
  })
  page.on("response", (response) => {
    const pending = pendingRequests.get(response.request())
    if (!pending) return
    pending.status = response.status()
    pending.eventStream = response.headers()["content-type"]?.includes("text/event-stream") ?? false
  })
  page.on("requestfinished", (request) => pendingRequests.delete(request))
  page.on("requestfailed", (request) => pendingRequests.delete(request))
  page.on("console", (message) => {
    if (message.text().startsWith("SCOPE_PICKER_REACTIVITY")) console.log(message.text())
    if (message.type() === "error") {
      consoleErrors++
      recordError("consoleerror", message.text())
    }
  })
  const hostSnapshot = () =>
    page.evaluate(() =>
      (
        globalThis as typeof globalThis & { scopeSettingsTrace?: { snapshot?: () => unknown } }
      ).scopeSettingsTrace?.snapshot?.(),
    )
  await catalog(page)
  await app.open()
  phase = "app-open"
  console.log("SCOPE_SETTINGS_HOST", JSON.stringify({ phase, records: await hostSnapshot() }))
  phase = "opening-settings"
  await openSettings(page)
  const settings = card(page)
  await expect(settings).toBeVisible()
  phase = "settings-mounted"
  console.log("SCOPE_SETTINGS_HOST", JSON.stringify({ phase, records: await hostSnapshot() }))
  await expect(settings.getByRole("button", { name: "VectorScope model", exact: true })).toContainText(
    "Unavailable: missing/old",
  )
  phase = "opening-popup"
  await settings.getByRole("button", { name: "VectorScope model", exact: true }).click()
  const picker = page.locator(".vector-model-popover")
  await expect(picker).toBeVisible()
  phase = "popup-open"
  console.log("SCOPE_SETTINGS_HOST", JSON.stringify({ phase, records: await hostSnapshot() }))
  const anthropic = picker.locator("button[data-model-section-toggle]").filter({ hasText: "Anthropic" })
  await expect(anthropic).toHaveAttribute("aria-expanded", "false")
  await anthropic.evaluate((header) => {
    const key = "vector.model-picker.open-sections.v1"
    const diagnostic = {
      nativeClicks: 0,
      writes: [] as string[],
      before: localStorage.getItem(key),
      lifetimeBefore: undefined as unknown,
    }
    const trace = (
      globalThis as unknown as {
        scopePickerTrace?: {
          armed: boolean
          sequence: number
          toggle: number
          lifecycle: number
          render: number
          each: number
          cleanup: number
          pending?: () => boolean
          snapshot?: () => unknown
        }
      }
    ).scopePickerTrace
    if (!trace) throw new Error("The focused picker diagnostic hook is unavailable")
    // Capture arms collection immediately before the real component click handler, after initial rendering.
    const click = () => {
      diagnostic.nativeClicks++
      diagnostic.lifetimeBefore = trace.snapshot?.()
      Object.assign(trace, { armed: true, sequence: 0, toggle: 0, lifecycle: 0, render: 0, each: 0, cleanup: 0 })
    }
    const write = Storage.prototype.setItem
    header.addEventListener("click", click, true)
    Storage.prototype.setItem = function (this: Storage, name, value) {
      if (name === key) diagnostic.writes.push(value)
      return write.call(this, name, value)
    }
    ;(window as unknown as { scopePickerDiagnostic: () => unknown }).scopePickerDiagnostic = () => {
      header.removeEventListener("click", click, true)
      Storage.prototype.setItem = write
      return {
        ...diagnostic,
        after: localStorage.getItem(key),
        headerConnected: header.isConnected,
        transitionPending: trace.pending?.(),
        lifetimeAfter: trace.snapshot?.(),
      }
    }
  })
  phase = "header-click"
  await anthropic.click()
  console.log(
    "SCOPE_PICKER_CLICK_DIAGNOSTIC",
    JSON.stringify(
      await page.evaluate(() =>
        (window as unknown as { scopePickerDiagnostic: () => unknown }).scopePickerDiagnostic(),
      ),
    ),
  )
  await expect(anthropic)
    .toHaveAttribute("aria-expanded", "true")
    .finally(async () => {
      console.log("SCOPE_PICKER_TRANSITION_DIAGNOSTIC", {
        pending: await page.evaluate(() =>
          (
            globalThis as typeof globalThis & { scopePickerTrace?: { pending?: () => boolean } }
          ).scopePickerTrace?.pending?.(),
        ),
        requests: [...pendingRequests.values()].slice(0, 30),
      })
      console.log("SCOPE_PICKER_BROWSER_ERRORS", JSON.stringify({ pageErrors, consoleErrors, errors }))
      console.log("SCOPE_SETTINGS_HOST", JSON.stringify({ phase, records: await hostSnapshot() }))
    })
  expect(pageErrors).toBe(0)
  const chosen = picker.locator('[data-option-key="anthropic:maker/text"]')
  await expect(chosen).toContainText("Maker Text")
  await chosen.click()
  await expect(settings.getByRole("button", { name: "VectorScope model", exact: true })).toContainText("Maker Text")
  await settings.locator('[data-component="select-v2"]').click()
  await page.getByRole("option", { name: "high", exact: true }).click()
  await disableReviews(settings)
  expect(app.capture.config).toEqual([])
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  const confirm = page.getByRole("dialog", { name: "Save VectorScope settings?", exact: true })
  await expect(confirm).toBeVisible()
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(app.capture.config).toEqual([])
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  await confirm.getByRole("button", { name: "Save anyway", exact: true }).click()
  await expect(settings.getByRole("status")).toHaveText("VectorScope settings saved.")
  expect(app.capture.config).toEqual([
    { agent: { vectorscope: { model: "anthropic/maker/text", variant: "high", disable: true } } },
  ])
  await expect(settings.getByRole("button", { name: "Save VectorScope settings", exact: true })).toBeDisabled()
  expect(pageErrors).toBe(0)
  await page.screenshot({ path: info.outputPath("vectorscope-settings-saved.png") })
})

test("failed saves retain the draft and retry without showing an unsaved choice as committed", async ({ page }) => {
  const app = await setup(page, engine())
  let failures = 0
  await page.route(
    (url) => url.port === port && url.pathname === "/global/config",
    async (route) => {
      if (route.request().method() !== "PATCH" || failures) return route.fallback()
      failures++
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ name: "UnknownError", data: { message: "The fixture refused the save." } }),
      })
    },
  )
  await app.open()
  await openSettings(page)
  const settings = card(page)
  await disableReviews(settings)
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  await expect(settings.getByRole("alert")).toBeVisible()
  await expect(settings.getByRole("status")).toHaveCount(0)
  await expect(settings.getByRole("switch", { name: "Enable VectorScope reviews", exact: true })).not.toBeChecked()
  await expect(settings.getByRole("button", { name: "Save VectorScope settings", exact: true })).toBeEnabled()
  expect(app.capture.config).toEqual([])
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  await expect(settings.getByRole("status")).toHaveText("VectorScope settings saved.")
  expect(failures).toBe(1)
  expect(app.capture.config).toHaveLength(1)
})

test("discarding a draft writes nothing and default-model reset clears its variant without enabling reviews", async ({
  page,
}) => {
  const app = await setup(
    page,
    engine({
      globalConfig: {
        experimental: { vectorscope: true },
        agent: { vectorscope: { model: "anthropic/maker/text", variant: "high", disable: true } },
      },
    }),
  )
  await catalog(page)
  await app.open()
  await openSettings(page)
  const settings = card(page)
  await settings.getByRole("button", { name: "Use default model", exact: true }).click()
  await settings.getByRole("button", { name: "Discard changes", exact: true }).click()
  await expect(settings.getByRole("button", { name: "VectorScope model", exact: true })).toContainText("Maker Text")
  expect(app.capture.config).toEqual([])
  await settings.getByRole("button", { name: "Use default model", exact: true }).click()
  await settings.getByRole("button", { name: "Save VectorScope settings", exact: true }).click()
  await expect(settings.getByRole("status")).toHaveText("VectorScope settings saved.")
  expect(app.capture.config).toEqual([{ agent: { vectorscope: { model: "", variant: "", disable: true } } }])
})

test("organization-managed VectorScope fields cannot be changed", async ({ page }) => {
  const app = await setup(
    page,
    engine({
      globalConfig: {
        experimental: { vectorscope: true },
        agent: { vectorscope: { model: "anthropic/maker/text" } },
        locked: ["agent.vectorscope.model"],
      },
    }),
  )
  await app.open()
  await openSettings(page)
  await expect(card(page)).toContainText("Your organization manages these settings.")
  await expect(card(page).getByRole("button", { name: "VectorScope model", exact: true })).toBeDisabled()
  await expect(card(page).getByRole("switch", { name: "Enable VectorScope reviews", exact: true })).toBeDisabled()
  expect(app.capture.config).toEqual([])
})
