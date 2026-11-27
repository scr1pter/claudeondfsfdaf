import { expect, test, type Page } from "@playwright/test"

// WP A42 (contract: "e2e in CI with a virtual WebAuthn authenticator pairing and approving"). Settings → Remote on the
// desktop's real link and the phone app's real Pair and Approvals pages, in one page, meet through an in-memory relay
// (e2e/fixtures/remote-phone.jsx). Chromium's virtual authenticator makes the phone's passkey and signs its approvals;
// the desktop's verifier checks both with the origin exactly this page's. WebAuthn needs a domain, not an IP address,
// so the page is opened on localhost.

type Fixture = {
  link: () => string | undefined
  ask: (id: string, command: string) => void
  askFix: (id: string) => void
  replies: () => { path: string; body: unknown }[]
  phones: () => string[]
  engine: () => { method: string; path: string; query: Record<string, string>; body?: unknown }[]
  phoneTurn: () => boolean
  reviewHeld: () => boolean
  phone: (request: {
    method: string
    path: string
    directory?: string
    query?: Record<string, string>
    body?: unknown
  }) => { status: number; body: unknown }
}

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, authenticatorId }
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
  ) as Promise<ReturnType<Fixture[K]>>

/** Page parameters: `connect: "1"` reports connected tools on; `card: "1"` adds an agent's finished review. */
async function pair(page: Page, baseURL: string | undefined, params: Record<string, string> = {}) {
  const { cdp, authenticatorId } = await authenticator(page)
  const port = new URL(baseURL ?? "http://127.0.0.1:3000").port || "3000"
  const fixture = new URL(`http://localhost:${port}/e2e/fixtures/remote-phone.html`)
  for (const [name, value] of Object.entries(params)) fixture.searchParams.set(name, value)
  await page.goto(fixture.href)
  const desktop = page.locator("[data-pane='desktop']")
  const phone = page.locator("[data-pane='phone']")

  // The computer: turn Remote on and show the pairing QR code.
  await desktop.getByRole("button", { name: "Pair a phone" }).click()
  await expect(desktop.getByRole("img", { name: "Pairing code for Vector Remote" })).toBeVisible()
  const link = await call(page, "link")
  expect(link).toMatch(/^http:\/\/localhost:\d+\/phone\/pair#[A-Za-z0-9_-]+$/)

  // The phone: take the link (the camera's job on a real phone), then make the passkey on a tap.
  await phone.getByLabel("Or paste the pairing link").fill(link!)
  await phone.getByRole("button", { name: "Use this link" }).click()
  await phone.getByRole("button", { name: "Make a passkey and pair" }).click()

  // Both screens show the same six digits; the person confirms on the computer.
  const onPhone = phone.getByLabel("Pairing check code")
  const onDesktop = desktop.getByLabel("Pairing check code")
  await expect(onPhone).toHaveText(/^\d{3} \d{3}$/)
  await expect(onDesktop).toHaveText((await onPhone.textContent())!)
  await desktop.getByRole("button", { name: "They match" }).click()
  await expect(phone.getByText("Paired with Fixture Mac.")).toBeVisible()
  await expect(desktop.getByText("Fixture phone", { exact: true })).toBeVisible()
  expect(await call(page, "phones")).toEqual(["Fixture phone"])
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  expect(credentials).toHaveLength(1)
  expect(credentials[0]!.rpId).toBe("localhost")
  return { phone, cdp, authenticatorId, credentials }
}

test("a phone pairs with a passkey, both screens show the same six digits, and a request is allowed once", async ({
  page,
  baseURL,
}) => {
  const { phone, cdp, authenticatorId, credentials } = await pair(page, baseURL)

  // An agent asks; the phone allows it once with the passkey, which the computer verifies.
  await phone.getByRole("button", { name: "Phone: Approvals" }).click()
  await call(page, "ask", "per_1", "bun test")
  await expect(phone.getByText("bun test")).toBeVisible()
  await expect(phone.getByText(/allow always|always allow/i)).toHaveCount(0)
  await phone.getByRole("button", { name: "Allow once" }).click()
  await expect.poll(() => call(page, "replies")).toEqual([
    { path: "/permission/per_1/reply", body: { reply: "once" } },
  ])
  await expect(phone.getByText("bun test")).toHaveCount(0)
  const { credentials: after } = await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  expect(after[0]!.signCount).toBeGreaterThan(credentials[0]!.signCount)

  // A second request is denied: no passkey needed, and the engine hears a rejection.
  await call(page, "ask", "per_2", "rm -rf build")
  await expect(phone.getByText("rm -rf build")).toBeVisible()
  await phone.getByRole("button", { name: "Deny" }).click()
  await expect.poll(async () => (await call(page, "replies")).length).toBe(2)
  expect((await call(page, "replies"))[1]).toEqual({
    path: "/permission/per_2/reply",
    body: { reply: "reject" },
  })
})

test("a paired phone starts and cancels a connected branch review", async ({ page, baseURL }) => {
  const { phone, cdp, authenticatorId, credentials } = await pair(page, baseURL, { connect: "1" })
  const engine = () => call(page, "engine")

  await phone.getByRole("button", { name: "Open sessions" }).click()
  await phone.getByRole("button", { name: /^Fix the login/ }).click()
  const connected = phone.getByRole("region", { name: "Connected tools" })
  await expect(connected.getByText("No connected runs in this conversation yet.")).toBeVisible()
  expect(await engine()).toContainEqual({
    method: "GET",
    path: "/experimental/connect/runs",
    query: { sessionID: "ses_1", directory: "/repo" },
  })

  await connected.getByLabel("Changes to review").selectOption("branch")
  await connected.getByLabel("Compare with (optional)").fill("main")
  await connected.getByRole("button", { name: "Review changes" }).click()
  await expect(connected.getByText("VectorScope review", { exact: true })).toBeVisible()
  await expect(connected.getByText("Running", { exact: true })).toBeVisible()
  expect((await engine()).filter(({ path }) => path === "/experimental/session/ses_1/connect")).toEqual([
    expect.objectContaining({
      method: "POST",
      query: { directory: "/repo" },
      body: { to: "vectorscope", target: { kind: "branch", base: "main" }, background: true },
    }),
  ])
  const { credentials: after } = await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  expect(after[0]!.signCount).toBeGreaterThan(credentials[0]!.signCount)
  expect(await call(page, "phoneTurn")).toBe(false)
  expect(await call(page, "reviewHeld")).toBe(true)
  await expect(connected.getByRole("button", { name: /fix|dismiss|worktree/i })).toHaveCount(0)

  const cancel = connected.getByRole("button", { name: "Cancel", exact: true })
  await cancel.click()
  await expect(connected.getByText("Cancelled", { exact: true })).toBeVisible()
  await expect(cancel).toHaveCount(0)
  expect(await call(page, "reviewHeld")).toBe(false)
  expect((await engine()).filter(({ path }) => path.endsWith("/cancel"))).toEqual([
    {
      method: "POST",
      path: "/experimental/connect/runs/cr_phone_review/cancel",
      query: { sessionID: "ses_1", directory: "/repo" },
      body: {},
    },
  ])
})

test("an agent's connected review shows on the phone as a card read from the engine's run, as text only", async ({
  page,
  baseURL,
}) => {
  const { phone } = await pair(page, baseURL, { connect: "1", card: "1" })
  await phone.getByRole("button", { name: "Open sessions" }).click()
  await phone.getByRole("button", { name: /^Fix the login/ }).click()
  await expect(phone.getByText("I asked VectorScope to review the login changes.")).toBeVisible()

  // The part's saved copy still says running; the card reads the engine's run, which is done.
  const card = phone.locator(".phone-messages .phone-card")
  await expect(card).toHaveCount(1)
  await expect(card.getByText("VectorScope review", { exact: true })).toBeVisible()
  await expect(card.getByText("Done · Blocking findings", { exact: true })).toBeVisible()
  await expect(card.getByText("Code sent to: Your provider: anthropic", { exact: true })).toBeVisible()
  await expect(card.getByText("7 open findings: 1 blocking, 5 concerns, 1 nit", { exact: true })).toBeVisible()
  const lines = card.getByRole("listitem")
  await expect(lines).toHaveText([
    "blocking Unescaped <b>name</b> in the login form src/login.ts:12",
    "concern Session token kept after sign-out src/session.ts:40",
    "concern Password field allows paste of 10 MB src/login.ts:30",
    "concern Retry loop has no upper bound src/retry.ts:8",
    "concern Error text names the user src/login.ts:55",
  ])
  await expect(card.locator("b")).toHaveCount(0)
  await expect(card.getByText("The other findings are in Vector on your computer.")).toBeVisible()
  // The sixth open finding, and those already settled, are not on the phone.
  for (const hidden of ["Cookie lacks SameSite", "Spacing in the header", "Old token check", "Dead branch kept"])
    await expect(phone.getByText(hidden)).toHaveCount(0)
  await expect(card.getByText(/fix|dismiss|worktree/i)).toHaveCount(0)
  await expect(card.getByRole("button")).toHaveCount(0)
  await expect(phone).not.toContainText("PRIVATE")

  // The runs list shows the same run, finished, so it offers no Cancel.
  const connected = phone.getByRole("region", { name: "Connected tools" })
  await expect(connected.getByText("Done · Blocking findings", { exact: true })).toBeVisible()
  await expect(connected.getByRole("button", { name: /cancel|fix|dismiss|worktree/i })).toHaveCount(0)
  expect(await call(page, "engine")).toContainEqual({
    method: "GET",
    path: "/session/ses_1/message",
    query: { limit: "30", directory: "/repo" },
  })
})

test("a connected tool's fix asks on the phone with its change as text, and is allowed once with a passkey", async ({
  page,
  baseURL,
}) => {
  const { phone, cdp, authenticatorId, credentials } = await pair(page, baseURL, { connect: "1" })
  await call(page, "askFix", "per_fix")
  await phone.getByRole("button", { name: "Open sessions" }).click()
  await phone.getByRole("button", { name: /^Fix the login/ }).click()

  const connected = phone.getByRole("region", { name: "Connected tools" })
  const ask = connected.locator(".phone-card").filter({ hasText: "Change files with a connected tool's fix" })
  await expect(ask.locator("pre")).toHaveText(
    [
      "Apply VectorScope's fix for 1 finding.",
      "",
      "--- a/src/login.ts",
      "+++ b/src/login.ts",
      "@@ -12 +12 @@",
      "-  greet.innerHTML = name",
      "+  greet.textContent = name // <b>safe</b>",
    ].join("\n"),
  )
  await expect(ask.locator("b")).toHaveCount(0)
  await expect(ask.getByRole("button", { name: "Deny" })).toBeVisible()
  await expect(ask.getByText(/allow always|always allow/i)).toHaveCount(0)
  await expect(phone).not.toContainText("PRIVATE")

  await ask.getByRole("button", { name: "Allow once" }).click()
  await expect
    .poll(() => call(page, "replies"))
    .toEqual([{ path: "/permission/per_fix/reply", body: { reply: "once" } }])
  await expect(ask).toHaveCount(0)
  const { credentials: after } = await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  expect(after[0]!.signCount).toBeGreaterThan(credentials[0]!.signCount)
})

test("with connected tools off the phone shows no card and no runs, and a forced start is refused", async ({
  page,
  baseURL,
}) => {
  const { phone } = await pair(page, baseURL, { card: "1" })
  await phone.getByRole("button", { name: "Open sessions" }).click()
  await phone.getByRole("button", { name: /^Fix the login/ }).click()
  await expect(phone.getByText("I asked VectorScope to review the login changes.")).toBeVisible()
  // The agent's call is only its plain line: no card, no runs section, no review form.
  await expect(phone.getByText("Review with VectorScope · running", { exact: true })).toBeVisible()
  await expect(phone.locator(".phone-card")).toHaveCount(0)
  await expect(phone.getByText(/VectorScope review|Blocking findings|Code sent to/)).toHaveCount(0)
  await expect(phone.getByRole("region", { name: "Connected tools" })).toHaveCount(0)
  await expect(phone.getByRole("button", { name: "Review changes" })).toHaveCount(0)
  await expect
    .poll(async () => (await call(page, "engine")).some((item) => item.path === "/experimental/capabilities"))
    .toBe(true)

  // Sent straight through the client, a review start and a runs read are refused by the computer.
  const start = await call(page, "phone", {
    method: "POST",
    path: "/remote/approval",
    directory: "/repo",
    body: { review: { sessionID: "ses_1", target: { kind: "uncommitted" } } },
  })
  expect(start).toEqual({
    status: 403,
    body: { error: { code: "REMOTE_CONNECT_OFF", message: "Connected tools are off on this computer." } },
  })
  const runs = await call(page, "phone", {
    method: "GET",
    path: "/experimental/connect/runs",
    directory: "/repo",
    query: { sessionID: "ses_1" },
  })
  expect(runs).toMatchObject({ status: 403, body: { error: { code: "REMOTE_CONNECT_OFF" } } })
  expect((await call(page, "engine")).filter((item) => item.path.includes("/connect"))).toEqual([])
})

test("a pairing link read on another origin is refused on the phone, and nothing pairs", async ({ page, baseURL }) => {
  await authenticator(page)
  const port = new URL(baseURL ?? "http://127.0.0.1:3000").port || "3000"
  await page.goto(`http://localhost:${port}/e2e/fixtures/remote-phone.html`)
  const desktop = page.locator("[data-pane='desktop']")
  const phone = page.locator("[data-pane='phone']")
  await desktop.getByRole("button", { name: "Pair a phone" }).click()
  const link = (await call(page, "link"))!
  // The same offer read on another origin is not a pairing code for this phone app.
  await phone.getByLabel("Or paste the pairing link").fill(link.replace("localhost", "127.0.0.1"))
  await phone.getByRole("button", { name: "Use this link" }).click()
  await expect(phone.getByText("That is not a Vector Remote pairing code.")).toBeVisible()
  expect(await call(page, "phones")).toEqual([])
})
