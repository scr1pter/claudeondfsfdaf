import { expect, test } from "bun:test"
import {
  BILLING_PARTITION,
  billingNavigation,
  billingReturn,
  billingStep,
  billingTitle,
  billingWindowOptions,
} from "./billing-navigation"

const site = "https://vectordev.ai"

test("Stripe's return to the account page says how billing ended", () => {
  expect(billingReturn(`${site}/account?model_plan=success`, site)).toBe("completed")
  // An upgrade's checkout, from /change, returns with change=upgrade.
  expect(billingReturn(`${site}/account?model_plan=success&change=upgrade`, site)).toBe("completed")
  // A card update (payment_method_update) or a cancellation finished in the portal.
  expect(billingReturn(`${site}/account?model_plan=updated`, site)).toBe("completed")
  expect(billingReturn(`${site}/account?model_plan=ending`, site)).toBe("completed")
  expect(billingReturn(`${site}/account?model_plan=cancelled`, site)).toBe("cancelled")
  // Codium sells no top-ups: a top-up return is only the account page, never a finished purchase.
  expect(billingReturn(`${site}/account?model_topup=success`, site)).toBe("closed")
  expect(billingReturn(`${site}/account?model_topup=cancelled`, site)).toBe("closed")
  // The portal's own link back.
  expect(billingReturn(`${site}/account`, site)).toBe("closed")
  expect(billingReturn(`${site}/account/`, site)).toBe("closed")
  expect(billingReturn(`${site}/account?model_plan=other`, site)).toBe("closed")
})

test("other pages of the site open in the browser, and other sites are not taken for it", () => {
  expect(billingReturn(`${site}/legal/privacy`, site)).toBe("external")
  expect(billingReturn(`${site}/codium?model_plan=success`, site)).toBe("external")
  for (const url of [
    "https://vectordev.ai.evil.example/account?model_plan=success",
    "http://vectordev.ai/account?model_plan=success",
    "https://checkout.stripe.com/c/pay/cs_fixture",
    "not a url",
  ])
    expect(billingReturn(url, site)).toBeUndefined()
})

test("the window stays on Stripe, sends other https pages to the browser and refuses anything else", () => {
  for (const url of [
    "https://checkout.stripe.com/c/pay/cs_fixture",
    "https://billing.stripe.com/p/session/fixture",
    "https://hooks.stripe.com/3d_secure_2/hosted",
    "https://invoice.stripe.com/i/acct_fixture",
    "https://m.stripe.network/inner.html",
  ])
    expect(billingNavigation(url)).toBe("allow")
  for (const url of [
    "https://stripe.com.evil.example/c/pay",
    "https://evilstripe.com/",
    "https://www.example.com/terms",
  ])
    expect(billingNavigation(url)).toBe("external")
  for (const url of [
    "http://checkout.stripe.com/c/pay",
    "https://user:secret@checkout.stripe.com/c/pay",
    "javascript:alert(1)",
    "file:///etc/hosts",
    "vector://auth/callback",
    "not a url",
  ])
    expect(billingNavigation(url)).toBe("block")
})

test("the title names the page's host, since the window has no address bar", () => {
  expect(billingTitle("https://checkout.stripe.com/c/pay/cs_fixture#secret")).toBe(
    "Vector Codium billing: checkout.stripe.com",
  )
  expect(billingTitle("not a url")).toBe("Vector Codium billing")
})

test("only the page itself is held to Stripe: a frame's redirect to a bank's card check loads in its frame", () => {
  // A 3D Secure challenge: Stripe's frame posts to the bank's server, which redirects to its own challenge page.
  const bank = "https://acs.bank.example/challenge?transaction=fixture"
  expect(billingStep(bank, site, false)).toEqual({ load: true })
  expect(billingStep(`${site}/account?model_plan=success`, site, false)).toEqual({ load: true })
  // The same address as the page's own redirect goes to the browser instead.
  expect(billingStep(bank, site, true)).toEqual({ load: false, kept: "external", browser: true })
  expect(billingStep("javascript:alert(1)", site)).toEqual({ load: false, kept: "block" })
  expect(billingStep("https://checkout.stripe.com/c/pay/cs_fixture", site)).toEqual({ load: true })
  expect(billingStep(`${site}/account?model_plan=success`, site)).toEqual({ load: false, finish: "completed" })
  expect(billingStep(`${site}/account`, site)).toEqual({ load: false, finish: "closed" })
  expect(billingStep(`${site}/legal/terms`, site)).toEqual({ load: false, browser: true })
})

test("the billing window is a titled child window with no access to Vector, never a macOS sheet", () => {
  const options = billingWindowOptions("https://checkout.stripe.com/c/pay/cs_fixture", { width: 800, height: 600 })
  // A modal child is a sheet on macOS: no title bar to name the Stripe host, and no close button.
  expect(options.modal).toBe(false)
  expect(options.title).toBe("Vector Codium billing: checkout.stripe.com")
  expect([options.width, options.height]).toEqual([800, 600])
  expect(options.webPreferences).toEqual({
    partition: BILLING_PARTITION,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
    devTools: false,
  })
  expect(options.webPreferences).not.toHaveProperty("preload")
  // In memory only, so no Stripe or Link sign-in outlives the window.
  expect(BILLING_PARTITION).not.toStartWith("persist:")
  expect(billingWindowOptions("https://billing.stripe.com/p/session/fixture", undefined, false)).toMatchObject({
    width: 960,
    height: 760,
    webPreferences: { devTools: true },
  })
})
