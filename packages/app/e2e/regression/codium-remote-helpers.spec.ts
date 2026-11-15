import { expect, test, type Page } from "@playwright/test"

// Track B B09 (codium-build-spec.md, Track B B09; the checkpoint's "Actual paired desktop/phone browser check"). On A42's
// fixture (e2e/fixtures/remote-phone.jsx): a phone paired with a passkey opens a session's Tasks view and stops it
// including its helpers, and a helper's waiting and interrupted states reach it as alerts. Every phone request goes
// through the desktop's real forwarder (desktop remote-link.ts → remote-routes.ts) to a fake engine that records what
// it is asked. The full route inventory is desktop remote-routes-combined.test.ts; the refused routes here are only
// examples of real engine routes a phone may not reach.

type PhoneRequest = {
  method: "GET" | "POST"
  path: string
  directory?: string
  query?: Record<string, string>
  body?: unknown
}
type EngineCall = { method: string; path: string; query: Record<string, string>; body?: unknown }
type Alert = {
  url: string
  sent: Record<string, unknown>
  sealed: Record<string, unknown>
  shown: { title: string; options: Record<string, unknown> }
}
type Fixture = {
  link: () => string | undefined
  phones: () => string[]
  engine: () => EngineCall[]
  phone: (request: PhoneRequest) => Promise<{ status: number; body: unknown }>
  helper: (state: "waiting" | "interrupted") => void
  asked: () => unknown[]
  alerts: () => Promise<Alert[]>
}

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  const added = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, authenticatorId: added.authenticatorId }
}

/** Calls one of the fixture's helpers in the page. */
const call = <K extends keyof Fixture>(page: Page, name: K, ...args: Parameters<Fixture[K]>) =>
  page.evaluate(
    ([key, values]) =>
      (
        (window as unknown as { remoteFixture: Record<string, (...items: unknown[]) => unknown> }).remoteFixture[
          key as string
        ] as (...items: unknown[]) => unknown
      )(...(values as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<Fixture[K]>>>

/** Pairs the phone with a passkey, as A42's spec does, and returns the two panes. */
async function pair(page: Page, baseURL: string | undefined) {
  const auth = await authenticator(page)
  const port = new URL(baseURL ?? "http://127.0.0.1:3000").port || "3000"
  await page.goto(`http://localhost:${port}/e2e/fixtures/remote-phone.html`)
  const desktop = page.locator("[data-pane='desktop']")
  const phone = page.locator("[data-pane='phone']")
  await desktop.getByRole("button", { name: "Pair a phone" }).click()
  await expect(desktop.getByRole("img", { name: "Pairing code for Vector Remote" })).toBeVisible()
  const link = await call(page, "link")
  expect(link).toMatch(/^http:\/\/localhost:\d+\/phone\/pair#[A-Za-z0-9_-]+$/)
  await phone.getByLabel("Or paste the pairing link").fill(link!)
  await phone.getByRole("button", { name: "Use this link" }).click()
  await phone.getByRole("button", { name: "Make a passkey and pair" }).click()
  const onPhone = phone.getByLabel("Pairing check code")
  await expect(onPhone).toHaveText(/^\d{3} \d{3}$/)
  await expect(desktop.getByLabel("Pairing check code")).toHaveText((await onPhone.textContent())!)
  await desktop.getByRole("button", { name: "They match" }).click()
  await expect(phone.getByText("Paired with Fixture Mac.")).toBeVisible()
  await expect.poll(() => call(page, "phones")).toEqual(["Fixture phone"])
  const stored = await auth.cdp.send("WebAuthn.getCredentials", { authenticatorId: auth.authenticatorId })
  expect(stored.credentials).toHaveLength(1)
  expect(stored.credentials[0]!.rpId).toBe("localhost")
  return { desktop, phone }
}

test("a paired phone shows helper and background-job states, stops including helpers with exactly {helpers: true}, and reaches no other route", async ({
  page,
  baseURL,
}) => {
  const phone = (await pair(page, baseURL)).phone

  // The session's Tasks view, from the fake engine's task board through the phone's projection.
  await phone.getByRole("button", { name: "Open sessions" }).click()
  await phone.getByRole("button", { name: /^Fix the login/ }).click()
  const tasks = phone.getByRole("region", { name: "Tasks", exact: true })
  const row = (title: string) => tasks.getByRole("listitem").filter({ hasText: title })
  await expect(row("Check the login form")).toContainText("Waiting for you")
  await expect(row("Check the login form")).toContainText("Waiting for your approval.")
  await expect(row("Update the changelog")).toContainText("Working")
  await expect(row("Rebuild the icons")).toContainText("Stopped")
  await expect(row("Rebuild the icons")).toContainText("Interrupted. Continue this task from Vector on your computer.")
  await expect(row("Index the docs")).toContainText("Disconnected · last known state")
  await expect(row("Unit tests")).toContainText("Working")
  await expect(tasks.getByRole("listitem")).toHaveCount(5)
  // The Stop button shows only once the capabilities answer arrived, so both reads are in the engine's log.
  const stop = phone.getByRole("button", { name: "Stop including helpers", exact: true })
  await expect(stop).toBeVisible()
  await expect(phone).not.toContainText("PRIVATE")
  await expect(phone).not.toContainText("98765")
  const reads = (await call(page, "engine"))
    .filter((entry) => entry.path.startsWith("/experimental/"))
    .sort((a, b) => a.path.localeCompare(b.path))
  expect(reads).toEqual([
    { method: "GET", path: "/experimental/capabilities", query: { directory: "/repo" } },
    {
      method: "GET",
      path: "/experimental/session/ses_1/tasks",
      query: { descendants: "true", shells: "true", limit: "100", directory: "/repo" },
    },
  ])

  // Stop including helpers: exactly one Stop with exactly {helpers: true}, then the board read again.
  const before = (await call(page, "engine")).length
  await stop.click()
  await expect(row("Update the changelog")).toContainText("Stopped")
  await expect(row("Check the login form")).toContainText("Stopped")
  await expect(row("Unit tests")).toContainText("Stopped")
  await expect(stop).toHaveCount(0)
  const all = await call(page, "engine")
  // GET /project is the desktop's lazy 30 s directory cache (remote-link.ts), refilled when a request names a folder.
  expect(all.slice(before).filter((entry) => !(entry.method === "GET" && entry.path === "/project"))).toEqual([
    {
      method: "POST",
      path: "/experimental/session/ses_1/stop",
      query: { directory: "/repo" },
      body: { helpers: true },
    },
    {
      method: "GET",
      path: "/experimental/session/ses_1/tasks",
      query: { descendants: "true", shells: "true", limit: "100", directory: "/repo" },
    },
  ])
  expect(all.filter((entry) => entry.path === "/session/ses_1/abort")).toEqual([])

  // Routes the phone may not reach are refused on the desktop, before any folder check, and never reach the engine.
  const mark = (await call(page, "engine")).length
  const refused = [
    { method: "POST", path: "/experimental/session/ses_1/tasks/stop", directory: "/repo", body: { all: true } },
    { method: "GET", path: "/experimental/session/ses_1/tasks/tsk_wait", directory: "/repo" },
    { method: "POST", path: "/session/ses_1/shell", directory: "/repo", body: { agent: "build", command: "ls" } },
  ] satisfies PhoneRequest[]
  for (const request of refused)
    expect(await call(page, "phone", request)).toMatchObject({
      status: 403,
      body: { error: { code: "REMOTE_ROUTE_REFUSED" } },
    })
  expect((await call(page, "engine")).slice(mark)).toEqual([])
  // Stop with any field but helpers is refused too; only the folder check may have read the project list.
  const next = (await call(page, "engine")).length
  expect(
    await call(page, "phone", {
      method: "POST",
      path: "/experimental/session/ses_1/stop",
      directory: "/repo",
      body: { helpers: true, sessionID: "ses_other" },
    }),
  ).toMatchObject({ status: 400, body: { error: { code: "REMOTE_BODY_REFUSED" } } })
  expect(
    (await call(page, "engine")).slice(next).filter((entry) => !(entry.method === "GET" && entry.path === "/project")),
  ).toEqual([])
})

test("a waiting and an interrupted helper reach the paired phone as title-only alerts", async ({ page, baseURL }) => {
  await pair(page, baseURL)

  // A wait alerts only once it still stands after the 3 s settle; an interruption sent sooner would replace it.
  await call(page, "helper", "waiting")
  await expect.poll(async () => (await call(page, "alerts")).length, { timeout: 15_000 }).toBe(1)
  await call(page, "helper", "interrupted")
  await expect.poll(async () => (await call(page, "alerts")).length, { timeout: 15_000 }).toBe(2)

  const titles = ["A helper needs you: Fix the login", "A helper was interrupted: Fix the login"]
  // What the app handed the desktop: the event, the conversation's title and the route, nothing else.
  expect(await call(page, "asked")).toEqual(titles.map((title) => ({ event: "needsYou", title, route: "sessions" })))
  const alerts = await call(page, "alerts")
  // The phone opened each with the key it stored at pairing, so neither is the "Open Vector to see this alert" notice.
  expect(alerts.map((alert) => alert.shown.title)).toEqual(titles)
  for (const [index, alert] of alerts.entries()) {
    expect(alert.url).toBe("https://vectordev.ai/api/notify/send")
    // On the wire: ciphertext, which key opens it, and urgency; no title.
    expect(Object.keys(alert.sent).sort()).toEqual(["ciphertext", "key", "urgency"])
    expect(alert.sent.urgency).toBe("high")
    expect(JSON.stringify(alert.sent)).not.toContain("Fix the login")
    // Sealed inside: only the title and the route. openAlert keeps only those fields, so this is read before it.
    expect(alert.sealed).toEqual({ v: 1, title: titles[index], route: "sessions" })
    // What the service worker shows: the title, no body, opening Sessions.
    expect(alert.shown.options).not.toHaveProperty("body")
    expect(alert.shown.options).toMatchObject({ tag: "sessions", data: { url: "/phone/sessions" } })
    for (const text of [JSON.stringify(alert.sealed), JSON.stringify(alert.shown)])
      for (const hidden of ["PRIVATE", "Check the login form", "subagent"]) expect(text).not.toContain(hidden)
  }
})
