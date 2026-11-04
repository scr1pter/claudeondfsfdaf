import { expect, test, type Page } from "@playwright/test"

// WP A42 (contract: "e2e in CI with a virtual WebAuthn authenticator pairing and approving"). Settings → Remote on the
// desktop's real link and the phone app's real Pair and Approvals pages, in one page, meet through an in-memory relay
// (e2e/fixtures/remote-phone.jsx). Chromium's virtual authenticator makes the phone's passkey and signs its approvals;
// the desktop's verifier checks both with the origin exactly this page's. WebAuthn needs a domain, not an IP address,
// so the page is opened on localhost.

type Fixture = {
  link: () => string | undefined
  ask: (id: string, command: string) => void
  replies: () => { path: string; body: unknown }[]
  phones: () => string[]
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

test("a phone pairs with a passkey, both screens show the same six digits, and a request is allowed once", async ({
  page,
  baseURL,
}) => {
  const { cdp, authenticatorId } = await authenticator(page)
  const port = new URL(baseURL ?? "http://127.0.0.1:3000").port || "3000"
  await page.goto(`http://localhost:${port}/e2e/fixtures/remote-phone.html`)
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
