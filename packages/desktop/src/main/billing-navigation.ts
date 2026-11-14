import type { BrowserWindowConstructorOptions } from "electron"

/**
 * Where Vector's Codium billing window may go. It shows only Stripe's own pages: Checkout, the customer portal and the
 * pages they use for card checks, invoices and receipts. Any other https page opens in the browser, and the window
 * closes itself when Stripe sends the person back to vectordev.ai. "busy" is a request that came while another
 * billing window was open, which is brought forward instead.
 */
export type BillingOutcome = "completed" | "cancelled" | "closed" | "failed" | "busy"

// In memory only (no "persist:" prefix), and cleared after each use, so no Stripe or Link sign-in outlives the window.
export const BILLING_PARTITION = "vector-billing"

/**
 * The billing window's settings. It has no preload, so the page can never reach Vector's IPC, and its own session,
 * so the main window's permission and header handlers do not apply to it and nothing it stores reaches the app. It is
 * a child of the app window but never modal: macOS shows a modal child as a sheet, which has no title bar to name the
 * Stripe host the card is typed into and no close button.
 */
export function billingWindowOptions(url: string, bounds?: { width: number; height: number }, packaged = true) {
  return {
    modal: false,
    width: Math.min(960, bounds?.width ?? 960),
    height: Math.min(760, bounds?.height ?? 760),
    minWidth: 420,
    minHeight: 480,
    show: false,
    title: billingTitle(url),
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      partition: BILLING_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      devTools: !packaged,
    },
  } satisfies BrowserWindowConstructorOptions
}

/**
 * What the billing window does with a navigation or a server redirect: load it, or keep it out, opening it in the
 * browser or finishing with how billing ended. Only the page itself is held to Stripe. Frames are not, because a
 * bank's 3D Secure check, Link and captchas run in frames on other hosts, often through server redirects, and a frame
 * kept out would fail the card check while its page opened in the browser.
 */
export function billingStep(
  url: string,
  origin: string,
  mainFrame = true,
): { load: true } | { load: false; finish?: ReturnOutcome; browser?: true; kept?: "external" | "block" } {
  if (!mainFrame) return { load: true }
  const back = billingReturn(url, origin)
  if (back === "external") return { load: false, browser: true }
  if (back) return { load: false, finish: back }
  const where = billingNavigation(url)
  if (where === "allow") return { load: true }
  return { load: false, kept: where, ...(where === "external" ? { browser: true as const } : {}) }
}

type ReturnOutcome = Exclude<BillingOutcome, "failed" | "busy">

/** A main-frame navigation: stay on Stripe, open another https page in the browser, or refuse it. */
export function billingNavigation(url: string) {
  const parsed = URL.parse(url)
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) return "block" as const
  return stripeHost(parsed.hostname) ? ("allow" as const) : ("external" as const)
}

/**
 * What a request to the site means. The return URLs are the ones api/_lib/model-plan-account.ts gives Stripe: a plan's
 * checkout and an upgrade's (with change=upgrade) return to /account?model_plan=success or cancelled, a card update or
 * a cancellation in the portal returns with model_plan=updated or ending, and the portal's own link back is the bare
 * /account. Codium sells no top-ups, so ?model_topup= means nothing here. Any other page of the site opens in the
 * browser; undefined means the URL is not the site's.
 */
export function billingReturn(url: string, origin: string): ReturnOutcome | "external" | undefined {
  const parsed = URL.parse(url)
  if (!parsed || parsed.origin !== origin) return undefined
  if (parsed.pathname !== "/account" && parsed.pathname !== "/account/") return "external"
  const plan = parsed.searchParams.get("model_plan")
  if (plan === "success" || plan === "updated" || plan === "ending") return "completed"
  if (plan === "cancelled") return "cancelled"
  return "closed"
}

/** The window has no address bar, so its title names the page's host. */
export function billingTitle(url: string) {
  const host = URL.parse(url)?.hostname
  return host ? `Vector Codium billing: ${host}` : "Vector Codium billing"
}

function stripeHost(host: string) {
  return (
    host === "stripe.com" ||
    host.endsWith(".stripe.com") ||
    host === "stripe.network" ||
    host.endsWith(".stripe.network")
  )
}
