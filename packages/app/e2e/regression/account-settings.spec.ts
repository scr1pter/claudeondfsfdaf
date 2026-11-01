import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test"

type Fixture = {
  opened: string[]
  actions: string[]
  billing: unknown[]
  codiumReads: number
  modelReads: number
  confirm: () => void
  finish: () => void
  answer: () => void
}
const read = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { accountFixture: Fixture }).accountFixture
    return {
      opened: state.opened,
      actions: state.actions,
      billing: state.billing,
      codiumReads: state.codiumReads,
      modelReads: state.modelReads,
    }
  })
const opened = async (page: Page) => (await read(page)).opened
const actions = async (page: Page) => (await read(page)).actions
const billing = async (page: Page) => (await read(page)).billing
const monthlyOffers = async (offers: Locator) => {
  await expect(offers.getByRole("heading", { name: "Monthly plans", exact: true })).toBeVisible()
  for (const name of ["Plus", "Pro", "Max", "Ultra"])
    await expect(offers.getByText(name, { exact: true })).toBeVisible()
  await expect(offers.locator("[data-offer]")).toHaveCount(4)
  await expect(offers.locator("[data-offer^='codium-topup-']")).toHaveCount(0)
  await expect(offers.getByRole("heading", { name: "Top-ups", exact: true })).toHaveCount(0)
  await expect(offers.getByRole("button", { name: /^Buy, / })).toHaveCount(0)
  await expect(offers).not.toContainText(/\$\d+ once|credit top-up|Credits bought once|carry forward/i)
}
// The launch screen lifts over the page first, so a capture waits until it has gone.
const capture = async (page: Page, testInfo: TestInfo, name: string) => {
  await expect(page.locator("#vector-launch")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath(name) })
}

test("the Settings header names the person signed in, with their photo or initials, and Vector when no one is", async ({
  page,
}, testInfo) => {
  const header = page.locator(".settings-v2-brand-row")
  const box = async () => {
    const value = await header.boundingBox()
    return { width: value?.width, height: value?.height }
  }

  await page.goto("/e2e/fixtures/account-settings.html?account=signed-out")
  await expect(header).toHaveAttribute("data-identity", "vector")
  await expect(header.locator("img.settings-v2-brand-mark")).toHaveAttribute("src", "/vector-logo.png")
  await expect(header.locator(".settings-v2-brand-name")).toHaveText("Vector")
  await expect(header.locator(".settings-v2-brand-subtitle")).toHaveText("Settings")
  const vector = await box()
  await capture(page, testInfo, "settings-header-signed-out.png")

  await page.goto("/e2e/fixtures/account-settings.html?account=photo")
  await expect(header).toHaveAttribute("data-identity", "account")
  await expect(header.locator(".settings-v2-brand-name")).toHaveText("Ana Diaz")
  await expect(header.locator(".settings-v2-brand-subtitle")).toHaveText("Settings")
  const picture = header.locator("img.settings-v2-brand-avatar")
  await expect(picture).toHaveAttribute("referrerpolicy", "no-referrer")
  await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  // The photo takes the logo's place at the logo's size, so the header does not move when the account arrives.
  expect(await box()).toEqual(vector)
  await capture(page, testInfo, "settings-header-photo.png")

  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in")
  await expect(header.locator(".settings-v2-brand-avatar")).toHaveText("AD")
  await expect(header.locator(".settings-v2-brand-name")).toHaveText("Ana Diaz")
  expect(await box()).toEqual(vector)
  await capture(page, testInfo, "settings-header-initials.png")

  await page.goto("/e2e/fixtures/account-settings.html?account=broken")
  await expect(header.locator(".settings-v2-brand-avatar")).toHaveText("AD")
  await expect(header.locator("img.settings-v2-brand-avatar")).toHaveCount(0)

  await page.goto("/e2e/fixtures/account-settings.html?account=email")
  await expect(header.locator(".settings-v2-brand-name")).toHaveText("ana.diaz")
  await expect(header.locator(".settings-v2-brand-avatar")).toHaveText("AD")

  // Signing out puts Vector back.
  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(header).toHaveAttribute("data-identity", "vector")
  await expect(header.locator(".settings-v2-brand-name")).toHaveText("Vector")
})

test("Account shows who is signed in and that Codium is coming soon, and nothing can be bought", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=photo&codium=coming-soon")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.getByRole("tab", { name: "Account", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(settings.getByRole("heading", { name: "Ana Diaz", exact: true })).toBeVisible()
  await expect(settings.getByText("ana@example.com", { exact: true })).toBeVisible()
  await expect(settings.locator("img.settings-account-avatar")).toBeVisible()
  await expect(settings.locator(".settings-account-badge")).toHaveText("Coming soon")
  await expect(settings.getByRole("button", { name: "Manage billing and invoices" })).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "View usage" })).toBeVisible()

  await settings.getByRole("button", { name: "See plans" }).click()
  const offers = settings.locator("[data-component='codium-purchase']")
  await expect(offers.getByText("Nothing can be bought until Vector Codium goes on sale.")).toBeVisible()
  await monthlyOffers(offers)
  await expect(offers).not.toContainText(/Codium \d/)
  await expect(offers.getByText("$50 a month")).toBeVisible()
  // Every purchase button says Coming soon and none can be pressed.
  const soon = offers.getByRole("button", { name: /^Coming soon, / })
  await expect(soon).toHaveCount(4)
  for (const button of await soon.all()) await expect(button).toBeDisabled()
  await expect(offers.getByRole("button", { name: /^(Subscribe|Buy|Upgrade), / })).toHaveCount(0)
  // Prices only: no credits and no comparison between purchases.
  await expect(offers).not.toContainText(/credits? (of|worth)|\d+(\.\d+)?x|\$\d+(\.\d+)? (in|of) credit/)
  await capture(page, testInfo, "account-coming-soon.png")
  expect(await billing(page)).toEqual([])
  expect(await opened(page)).toEqual([])
})

test("Account shows the plan as a share of this month's usage and manages billing inside Vector", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.locator(".settings-account-avatar")).toHaveText("A")
  await expect(settings.locator(".settings-account-balance > div").first()).toHaveText("PlanPro")
  await expect(settings.getByText("64% of this month's usage left", { exact: true })).toBeVisible()
  await expect(settings.getByRole("meter", { name: "Share of this month's usage left" })).toHaveAttribute(
    "aria-valuenow",
    "64",
  )
  // Codium sells monthly plans only: no purchased credits, top-ups or credits anywhere on the page.
  await expect(settings.getByText("Purchased credits")).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Buy credits" })).toHaveCount(0)
  await expect(settings.locator("[data-component='settings-account-codium']")).not.toContainText(
    /credit|top-?up|purchased/i,
  )
  await expect(settings.locator("[data-component='settings-account-delete']")).not.toContainText(/credit|purchased/i)
  // Only the share and states reach the balance: no counts or dollar amounts.
  await expect(settings.locator(".settings-account-balance")).not.toContainText("$")
  await capture(page, testInfo, "account-plan.png")

  await settings.getByRole("button", { name: "Manage billing and invoices" }).click()
  await settings.getByRole("button", { name: "Cancel plan" }).click()
  await expect(
    settings.getByText("Your plan is cancelled. It keeps working until the end of this billing period."),
  ).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "portal" }, { kind: "portal", flow: "cancel" }])
  // Nothing went to the website.
  expect(await opened(page)).toEqual([])
})

test("Change plan upgrades through /change, and the plan and models are read again at 5, 20 and 60 s", async ({
  page,
}) => {
  await page.clock.install()
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan")
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("button", { name: "Change plan" }).click()
  const offers = settings.locator("[data-component='codium-purchase']")
  await monthlyOffers(offers)
  // The subscriber's own plan is marked; a bigger one upgrades now, a smaller one switches at renewal.
  await expect(offers.locator("[data-offer='vector-50']")).toContainText("Current plan")
  await expect(offers.getByRole("button", { name: /^Subscribe, / })).toHaveCount(0)
  await expect(offers.getByRole("button", { name: "Upgrade, Max" })).toBeVisible()
  await expect(offers.getByRole("button", { name: "Upgrade, Ultra" })).toBeVisible()
  await expect(offers.getByRole("button", { name: "Switch at renewal, Plus" })).toBeVisible()
  await expect(offers.locator("[data-offer='vector-100']")).toContainText(
    "Upgrade to Max: $100 today, then monthly from today. Keeps what's left of this month.",
  )
  await expect(offers.getByText("$10 a month", { exact: true })).toBeVisible()
  await expect(offers.getByText("$200 a month", { exact: true })).toBeVisible()
  await expect(offers).not.toContainText(/credit|top-?up/i)

  await offers.getByRole("button", { name: "Upgrade, Max" }).click()
  await expect(
    settings.getByText("Your plan is upgraded. It shows here in a moment, with what was left of this month."),
  ).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "change", plan: "vector-100" }])
  expect(await opened(page)).toEqual([])
  // Stripe's notification can trail the window: the plan is read again at 5, 20 and 60 s, each time after the local
  // server has read the account's models from vectordev.ai instead of serving the list it keeps for a minute.
  const reads = async () => (await read(page)).codiumReads
  const modelReads = async () => (await read(page)).modelReads
  const after = await reads()
  expect(await modelReads()).toBe(0)
  for (const [ms, count] of [
    [5_000, 1],
    [15_000, 2],
    [40_000, 3],
  ] as const) {
    await page.clock.fastForward(ms)
    await expect.poll(modelReads).toBe(count)
    await expect.poll(reads).toBeGreaterThanOrEqual(after + count)
  }
})

test("Switch at renewal schedules the smaller plan, and Keep my plan drops a scheduled change", async ({ page }) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan")
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("button", { name: "Change plan" }).click()
  const offers = settings.locator("[data-component='codium-purchase']")
  await offers.getByRole("button", { name: "Switch at renewal, Plus" }).click()
  await expect(
    settings.getByText("Your plan switches to Plus on Nov 1, 2026. Until then it stays as it is."),
  ).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "change", plan: "vector-10" }])

  // A plan with Plus scheduled shows the switch and keeps every other change until the schedule is dropped.
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=scheduled")
  const scheduled = settings.locator("[data-component='settings-account-scheduled']")
  await expect(scheduled).toContainText("Switches to Plus on Nov 1, 2026.")
  await settings.getByRole("button", { name: "Change plan" }).click()
  await expect(offers.locator("[data-offer='vector-10']")).toContainText("Starts Nov 1, 2026")
  await expect(offers.getByRole("button", { name: /^(Upgrade|Switch at renewal), / })).toHaveCount(0)
  await expect(
    offers.getByText("A smaller plan is already scheduled. Keep your plan first to choose another change."),
  ).toBeVisible()
  await scheduled.getByRole("button", { name: "Keep my plan" }).click()
  await expect(settings.getByText("You are keeping your plan. Nothing changes at renewal.")).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "keep" }])
  expect(await opened(page)).toEqual([])
})

test("a paused plan offers Update card, or Confirm payment, in Stripe's portal inside Vector", async ({ page }) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=paused-card")
  const settings = page.locator(".settings-v2-workspace")
  await expect(
    settings.getByText("Your Codium plan is paused until its payment goes through. Update your card to continue."),
  ).toBeVisible()
  await settings.getByRole("button", { name: "Update card" }).click()
  await expect(
    settings.getByText("Your card is updated. Your plan picks up again once the payment goes through."),
  ).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "portal", flow: "payment_method_update" }])

  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=paused-confirm&billing=closed")
  await expect(settings.getByText("Your Codium plan is paused until you confirm its payment.")).toBeVisible()
  await expect(settings.getByRole("button", { name: "Update card" })).toHaveCount(0)
  await settings.getByRole("button", { name: "Confirm payment" }).click()
  expect(await billing(page)).toEqual([{ kind: "portal" }])
  // A paused plan cannot change until it is paid.
  await settings.getByRole("button", { name: "Change plan" }).click()
  await expect(
    settings
      .locator("[data-component='codium-purchase']")
      .getByRole("button", { name: /^(Upgrade|Switch at renewal), / }),
  ).toHaveCount(0)
  expect(await opened(page)).toEqual([])
})

test("someone without a plan subscribes in Vector, and a cancelled or failed checkout says so", async ({ page }) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=none&billing=cancelled")
  const settings = page.locator(".settings-v2-workspace")
  // Nothing bought yet: the account is on Free, with no billing to manage and no plan to cancel.
  await expect(settings.locator(".settings-account-balance > div").first()).toHaveText("PlanFree")
  await expect(settings.getByRole("button", { name: "Manage billing and invoices" })).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Cancel plan" })).toHaveCount(0)
  await settings.getByRole("button", { name: "See plans" }).click()
  const offers = settings.locator("[data-component='codium-purchase']")
  await monthlyOffers(offers)
  await expect(offers.getByRole("button", { name: /^Subscribe, / })).toHaveCount(4)
  await offers.getByRole("button", { name: "Subscribe, Max" }).click()
  await expect(settings.getByText("Checkout was cancelled. Nothing was charged.")).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "checkout", plan: "vector-100" }])

  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=none")
  await settings.getByRole("button", { name: "See plans" }).click()
  await offers.getByRole("button", { name: "Subscribe, Plus" }).click()
  await expect(settings.getByText("You are subscribed. Your plan shows here in a moment.")).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "checkout", plan: "vector-10" }])

  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=ended&billing=failed")
  await settings.getByRole("button", { name: "Change plan" }).click()
  // An ending plan has nothing left to cancel, and Stripe does not change a plan that is cancelling.
  await expect(settings.getByRole("button", { name: "Cancel plan" })).toHaveCount(0)
  await expect(settings.locator("[data-offer='vector-100']")).toContainText("Current plan")
  await expect(offers.getByRole("button", { name: /^(Upgrade|Switch at renewal), / })).toHaveCount(0)
  await settings.getByRole("button", { name: "Manage billing and invoices" }).click()
  await expect(settings.getByRole("alert")).toHaveText("Subscription management is temporarily unavailable.")

  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan&billing=website")
  await settings.getByRole("button", { name: "Manage billing and invoices" }).click()
  await expect(settings.getByText("This continues on vectordev.ai in your browser.")).toBeVisible()
})

test("while the Stripe window is open, the page says how it closes, and a second window is refused", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan&billing=pending")
  const settings = page.locator(".settings-v2-workspace")
  const finish = () => page.evaluate(() => (window as unknown as { accountFixture: Fixture }).accountFixture.finish())
  // The portal's home has no end, so the person closes the window themselves.
  await settings.getByRole("button", { name: "Manage billing and invoices" }).click()
  await expect(settings.getByText("Manage billing in the Stripe window, then close it.")).toBeVisible()
  await expect(settings.getByText("It closes by itself")).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Cancel plan" })).toBeDisabled()
  await finish()
  await expect(settings.getByText("Manage billing in the Stripe window, then close it.")).toHaveCount(0)
  // Stripe sends the person back from the cancel step, which closes the window.
  await settings.getByRole("button", { name: "Cancel plan" }).click()
  await expect(settings.getByText("Finish in the Stripe window. It closes by itself when you are done.")).toBeVisible()
  await finish()
  expect(await billing(page)).toEqual([{ kind: "portal" }, { kind: "portal", flow: "cancel" }])
  // An upgrade waits in Stripe's checkout for the person to pay, so the page never says it is saving by itself.
  await settings.getByRole("button", { name: "Change plan" }).click()
  await settings.getByRole("button", { name: "Upgrade, Max" }).click()
  await expect(settings.getByText("Finish in the Stripe window. It closes by itself when you are done.")).toBeVisible()
  await expect(settings.getByText("Saving your plan change…")).toHaveCount(0)
  await finish()
  expect((await billing(page)).at(-1)).toEqual({ kind: "change", plan: "vector-100" })

  // Another page or dialog asked while a window was open: the desktop brings that window forward instead.
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan&billing=busy")
  await settings.getByRole("button", { name: "Cancel plan" }).click()
  await expect(
    settings.getByText("A Stripe window is already open. Finish there or close it, then try again."),
  ).toBeVisible()
  await expect(settings.getByText("Your plan is cancelled.")).toHaveCount(0)
})

test("See plans on a Codium turn that needs a plan opens monthly checkout in Vector", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=none&view=codium-error")
  const card = page.locator("[data-codium-error]")
  // The engine's "See plans at <url>" is the button here: the card shows the server's message alone.
  await expect(card).toContainText("Choose a Vector Codium plan to use this model.")
  await expect(card).not.toContainText("vectordev.ai")
  await card.getByRole("button", { name: "See plans" }).click()
  const dialog = page.getByRole("dialog", { name: "Vector Codium plans" })
  await expect(dialog).toBeVisible()
  const offers = dialog.locator("[data-component='codium-purchase']")
  await monthlyOffers(offers)
  await expect(offers.getByRole("button", { name: /^Subscribe, / })).toHaveCount(4)
  await capture(page, testInfo, "codium-purchase-dialog.png")
  await offers.getByRole("button", { name: "Subscribe, Pro" }).click()
  await expect(dialog.getByText("You are subscribed. Your plan shows here in a moment.")).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "checkout", plan: "vector-50" }])
  expect(await opened(page)).toEqual([])
})

test("an exhausted subscriber's card offers Change plan, which upgrades through /change, never a portal change", async ({
  page,
}) => {
  await page.goto(
    "/e2e/fixtures/account-settings.html?account=signed-in&codium=exhausted&view=codium-error&error=exhausted",
  )
  const card = page.locator("[data-codium-error]")
  await expect(card).not.toContainText("vectordev.ai")
  await card.getByRole("button", { name: "Change plan" }).click()
  const dialog = page.getByRole("dialog", { name: "Vector Codium plans" })
  await expect(dialog).toBeVisible()
  const offers = dialog.locator("[data-component='codium-purchase']")
  await monthlyOffers(offers)
  await expect(offers.locator("[data-offer='vector-50']")).toContainText("Current plan")
  await expect(offers.getByRole("button", { name: /^Subscribe, / })).toHaveCount(0)
  await offers.getByRole("button", { name: "Upgrade, Max" }).click()
  await expect(
    dialog.getByText("Your plan is upgraded. It shows here in a moment, with what was left of this month."),
  ).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "change", plan: "vector-100" }])
  expect(await opened(page)).toEqual([])
})

test("the plans dialog offers nothing until the account's plan is read, and says so when the read fails", async ({
  page,
}) => {
  // The status read has not answered: the plans show, but a subscriber is never offered Subscribe meanwhile.
  await page.goto(
    "/e2e/fixtures/account-settings.html?account=signed-in&codium=exhausted&view=codium-error&error=exhausted&status=pending",
  )
  const card = page.locator("[data-codium-error]")
  const dialog = page.getByRole("dialog", { name: "Vector Codium plans" })
  const offers = dialog.locator("[data-component='codium-purchase']")
  await card.getByRole("button", { name: "See plans" }).click()
  await monthlyOffers(offers)
  await expect(offers.getByText("Reading your plan…")).toBeVisible()
  await expect(offers.getByRole("button")).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { accountFixture: Fixture }).accountFixture.answer())
  await expect(offers.locator("[data-offer='vector-50']")).toContainText("Current plan")
  await expect(offers.getByRole("button", { name: "Upgrade, Max" })).toBeVisible()
  await expect(offers.getByRole("button", { name: /^Subscribe, / })).toHaveCount(0)
  await expect(offers.getByText("Reading your plan…")).toHaveCount(0)

  // A read that fails offers nothing either, and says so.
  await page.goto(
    "/e2e/fixtures/account-settings.html?account=signed-in&codium=exhausted&view=codium-error&error=exhausted&status=failed",
  )
  await card.getByRole("button", { name: "See plans" }).click()
  await monthlyOffers(offers)
  await expect(offers.getByRole("alert")).toHaveText("Vector could not load your Codium plan. Try again shortly.")
  await expect(offers.getByRole("button")).toHaveCount(0)
  expect(await billing(page)).toEqual([])
})

test("the plans dialog shows a smaller plan already scheduled, with Keep my plan, as Settings does", async ({
  page,
}) => {
  await page.goto(
    "/e2e/fixtures/account-settings.html?account=signed-in&codium=scheduled&view=codium-error&error=exhausted",
  )
  await page.locator("[data-codium-error]").getByRole("button", { name: "Change plan" }).click()
  const dialog = page.getByRole("dialog", { name: "Vector Codium plans" })
  const scheduled = dialog.locator("[data-component='codium-purchase-scheduled']")
  await expect(scheduled).toContainText("Switches to Plus on Nov 1, 2026.")
  const offers = dialog.locator("[data-component='codium-purchase']")
  await expect(offers.locator("[data-offer='vector-10']")).toContainText("Starts Nov 1, 2026")
  await expect(offers.getByRole("button", { name: /^(Subscribe|Upgrade|Switch at renewal), / })).toHaveCount(0)
  await expect(
    offers.getByText("A smaller plan is already scheduled. Keep your plan first to choose another change."),
  ).toBeVisible()
  await scheduled.getByRole("button", { name: "Keep my plan" }).click()
  await expect(dialog.getByText("You are keeping your plan. Nothing changes at renewal.")).toBeVisible()
  expect(await billing(page)).toEqual([{ kind: "keep" }])
  expect(await opened(page)).toEqual([])
})

test("a Codium turn's buttons follow the answer: Update card or Confirm payment, and nothing for a daily limit", async ({
  page,
}) => {
  const card = page.locator("[data-codium-error]")
  await page.goto(
    "/e2e/fixtures/account-settings.html?account=signed-in&codium=paused-card&view=codium-error&error=update-card",
  )
  await expect(card).toContainText("Your last Vector Codium payment did not go through.")
  await expect(card).not.toContainText("vectordev.ai")
  await card.getByRole("button", { name: "Update card" }).click()
  await expect.poll(() => billing(page)).toEqual([{ kind: "portal", flow: "payment_method_update" }])

  await page.goto(
    "/e2e/fixtures/account-settings.html?account=signed-in&codium=paused-confirm&view=codium-error&error=confirm-payment",
  )
  await card.getByRole("button", { name: "Confirm payment" }).click()
  await expect.poll(() => billing(page)).toEqual([{ kind: "portal" }])

  // A daily limit offers nothing to buy.
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan&view=codium-error&error=daily")
  await expect(card).toContainText("Your Codium daily limit has been reached. Try again tomorrow.")
  await expect(card.getByRole("button")).toHaveCount(0)
  expect(await billing(page)).toEqual([])
  expect(await opened(page)).toEqual([])
})

test("a failed turn's card never suspends the page around it while it asks whether the account has a plan", async ({
  page,
}) => {
  await page.goto(
    "/e2e/fixtures/account-settings.html?account=signed-in&codium=exhausted&view=codium-error&error=exhausted&status=pending",
  )
  const card = page.locator("[data-codium-error]")
  // vectordev.ai has not answered: the card, and the page around it, stay up and offer the plans meanwhile.
  await expect(card.getByRole("button", { name: "See plans" })).toBeVisible()
  await expect(page.locator("[data-suspended]")).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { accountFixture: Fixture }).accountFixture.answer())
  await expect(card.getByRole("button", { name: "Change plan" })).toBeVisible()
  await expect(page.locator("[data-suspended]")).toHaveCount(0)
  expect((await read(page)).codiumReads).toBe(1)
})

test("a card updated from a failed turn, or a payment confirmed in Settings, reads the plan and models again later", async ({
  page,
}) => {
  const modelReads = async () => (await read(page)).modelReads
  await page.clock.install()
  await page.goto(
    "/e2e/fixtures/account-settings.html?account=signed-in&codium=paused-card&view=codium-error&error=update-card",
  )
  await page.locator("[data-codium-error]").getByRole("button", { name: "Update card" }).click()
  await expect.poll(() => billing(page)).toEqual([{ kind: "portal", flow: "payment_method_update" }])
  expect(await modelReads()).toBe(0)
  for (const [ms, count] of [
    [5_000, 1],
    [15_000, 2],
    [40_000, 3],
  ] as const) {
    await page.clock.fastForward(ms)
    await expect.poll(modelReads).toBe(count)
  }

  // The portal's home ends as closed, though the bank's confirmation may have gone through there.
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=paused-confirm&billing=closed")
  await page.locator(".settings-v2-workspace").getByRole("button", { name: "Confirm payment" }).click()
  await expect.poll(() => billing(page)).toEqual([{ kind: "portal" }])
  await page.clock.fastForward(5_000)
  await expect.poll(modelReads).toBe(1)
})

test("Delete account confirms the email, then a fresh sign-in, and deletes inside Vector", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=low")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.getByText("Less than 10% of this month's Codium usage is left.")).toBeVisible()
  await settings.getByRole("button", { name: "Delete account…" }).click()
  await expect(settings.locator("[data-component='settings-account-delete']")).toContainText("ends any Codium plan")
  const confirm = settings.getByRole("group", { name: "Confirm account deletion" })
  // Deleting cancels the account's Codium subscription and what is left of its month, so the confirmation says so.
  await expect(confirm).toContainText(
    "Any Vector Codium plan ends at once, and what is left of this month's Codium usage can no longer be used.",
  )
  const proceed = confirm.getByRole("button", { name: "Confirm with your Vector sign-in" })
  await expect(proceed).toBeDisabled()
  await confirm.getByLabel("Type ana@example.com to confirm").fill("ana@example.co")
  await expect(proceed).toBeDisabled()
  await confirm.getByLabel("Type ana@example.com to confirm").fill("Ana@Example.com")
  await confirm.scrollIntoViewIfNeeded()
  await capture(page, testInfo, "account-delete-confirm.png")
  await proceed.click()
  await expect(confirm).toContainText("Finish signing in to vectordev.ai in your browser.")
  expect(await actions(page)).toEqual(["confirmDeletion"])

  // The browser sign-in came back: the desktop holds the confirmation.
  await page.evaluate(() => (window as unknown as { accountFixture: Fixture }).accountFixture.confirm())
  await expect(confirm).toContainText("Confirmed. Delete ana@example.com now? This cannot be undone.")
  await capture(page, testInfo, "account-delete-confirmed.png")
  await confirm.getByRole("button", { name: "Delete my account" }).click()
  await expect(settings.getByRole("heading", { name: "Your Vector account was deleted" })).toBeVisible()
  expect(await actions(page)).toEqual(["confirmDeletion", "delete Ana@Example.com"])
  await expect(settings.locator("[data-component='settings-account-delete']")).toHaveCount(0)
  // Nothing was handed to the website.
  expect(await opened(page)).toEqual([])
})

test("Keep my account drops a deletion in progress", async ({ page }) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-in&codium=plan")
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("button", { name: "Delete account…" }).click()
  const confirm = settings.getByRole("group", { name: "Confirm account deletion" })
  await confirm.getByLabel("Type ana@example.com to confirm").fill("ana@example.com")
  await confirm.getByRole("button", { name: "Confirm with your Vector sign-in" }).click()
  await confirm.getByRole("button", { name: "Keep my account" }).click()
  await expect(confirm).toHaveCount(0)
  expect(await actions(page)).toEqual(["confirmDeletion", "cancelDeletion"])
  await expect(settings.getByRole("button", { name: "Delete account…" })).toBeVisible()
})

test("Signed out, Account offers Sign in to Vector and nothing else", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/account-settings.html?account=signed-out")
  const settings = page.locator(".settings-v2-workspace")
  await expect(settings.getByRole("heading", { name: "Not signed in" })).toBeVisible()
  await expect(settings.locator("[data-component='settings-account-codium']")).toHaveCount(0)
  await expect(settings.locator("[data-component='settings-account-delete']")).toHaveCount(0)
  await capture(page, testInfo, "account-signed-out.png")
  await settings.getByRole("button", { name: "Sign in to Vector" }).click()
  expect(await actions(page)).toEqual(["start"])
  await expect(settings.getByText("Finish signing in in your browser, then return to Vector.")).toBeVisible()
  await settings.getByRole("button", { name: "Cancel sign-in" }).click()
  await expect(settings.getByRole("button", { name: "Sign in to Vector" })).toBeVisible()
})
