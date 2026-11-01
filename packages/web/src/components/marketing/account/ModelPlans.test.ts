import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { publicModelPlans } from "../../../../../../api/_lib/model-plan-config"
import { readModelPlanConfig } from "../../../lib/model-plans"
import { ModelPlans, type ModelPlansPreview } from "./ModelPlans"

const config: ModelPlansPreview["config"] = {
  enabled: true,
  currency: "usd",
  interval: "month",
  plans: [{ id: "vector-10", name: "Plus", price: 10, available: true }],
}
const status: ModelPlansPreview["status"] = {
  active: true,
  access: true,
  plan: { id: "vector-10", name: "Plus", left: 0.25, renewsAt: Date.UTC(2026, 10, 1), cancelAtPeriodEnd: false },
  purchased: { bought: false },
}

describe("account model plans", () => {
  test("loading and signed-out views never offer checkout before subscription status is known", () => {
    const loading = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "pending-session" }))
    expect(loading).toContain("Loading model plans")
    expect(loading).toContain('aria-busy="true"')
    expect(loading).not.toContain("<button")
    const signedOut = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "" }))
    expect(signedOut).toContain("Sign in to view your model plan")
    expect(signedOut).not.toContain("Loading model plans")
  })

  test("disabled purchase configuration shows the price and offers nothing to buy", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: {
          config: { ...config, enabled: false, plans: [{ ...config.plans[0]!, available: false }] },
          status: { active: false },
        },
      }),
    )
    expect(html).toContain("$10")
    expect(html).toContain("Purchasing is not available yet")
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Coming soon<\/button>/)
    expect(html).not.toContain("Choose Plus")
  })

  test("active subscriptions show the share of credits remaining, renewal and management", () => {
    const html = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "", preview: { config, status } }))
    expect(html).toContain("<h3>Monthly allowance · Plus</h3>")
    expect(html).toContain("<strong>25%</strong> of this month&#x27;s Codium credits")
    expect(html).toContain('value="25" max="100"')
    expect(html).not.toContain("Purchased credits")
    expect(html).toContain("Renews")
    expect(html).toContain("Manage subscription")
    expect(html).toContain("Current plan")
  })

  test("missing usage stays unknown and cancellation does not promise renewal", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: {
          config,
          status: { ...status, plan: { ...status.plan!, left: undefined, cancelAtPeriodEnd: true } },
        },
      }),
    )
    expect(html).toContain("Usage temporarily unavailable")
    expect(html).toContain("Ending this period")
    expect(html).toContain("Access ends")
    expect(html).not.toContain("Renews")
    expect(html).not.toContain("<progress")
  })

  test("the account design preview never enables a billing action", () => {
    const html = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "", preview: true }))
    expect(html).toContain("Vector Codium is coming soon")
    expect(html).not.toContain("Loading model plans")
    expect(html).not.toContain("<button")
  })

  test("existing subscribers and billing customers can still find management while purchases are disabled", () => {
    for (const subscription of [status, { active: false as const, customer: true }]) {
      const html = renderToStaticMarkup(
        createElement(ModelPlans, {
          accessToken: "",
          preview: { config: { ...config, enabled: false }, status: subscription },
        }),
      )
      expect(html).toContain("Purchasing is not available yet")
      expect(html).toContain("Manage subscription")
      expect(html).not.toContain("Choose Plus")
    }
  })

  test("each offer shows typical tasks on the default model, never credits or token estimates", () => {
    // As an older config answer carried it. 4321 is a made-up figure, not a real allowance.
    const allowance = { credits: 4321 }
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: {
          config: {
            ...config,
            enabled: false,
            product: "Vector Codium",
            plans: [{ ...config.plans[0]!, ...allowance, name: "Plus", available: false, tasks: [[60, 550], null] }],
            models: [
              { id: "vendor/coder", name: "Coding Model", category: "everyday", description: "Routine coding tasks." },
              { id: "vendor/hard", name: "Hard Model", category: "advanced" },
            ],
          },
          status: { active: false },
        },
      }),
    )
    expect(html).toContain("Monthly subscriptions")
    expect(html).not.toContain("One-time credit packs")
    expect(html).toContain("About 60–550 typical tasks a month with Coding Model")
    expect(html).not.toContain("credit top-up")
    expect(html).not.toContain("buy credits when you need them")
    expect(html).toContain("do not roll over")
    expect(html).toContain("No automatic overage charges or top-ups")
    expect(html).toContain("Everyday")
    expect(html).toContain("reasoning affect usage")
    expect(html).toContain("repeated context also counts")
    expect(html).toContain("not a guarantee")
    expect(html).toContain('href="/legal/terms#codium"')
    expect(html).toContain("Cancel any time")
    for (const leak of ["Codium credits /", "4321", "tokens", "80% input", "markup"]) expect(html).not.toContain(leak)
  })

  test("only monthly Plus, Pro, Max and Ultra plans are offered, as the server names them", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: {
          config: readModelPlanConfig(publicModelPlans()),
          status: { active: false, access: false, purchased: { bought: false } },
        },
      }),
    )
    for (const name of ["Plus", "Pro", "Max", "Ultra"]) expect(html).toContain(`<h4>${name}</h4>`)
    expect(html).not.toContain("credit top-up")
    expect(html).not.toContain("One-time credit packs")
    expect(html).not.toMatch(/Codium \d/)
  })

  test("monthly and purchased balances remain distinct, including unknown purchased usage", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: { config, status: { ...status, purchased: { bought: true, state: "available" } } },
      }),
    )
    expect(html).toContain("Monthly allowance")
    expect(html).toContain("<strong>25%</strong> of this month&#x27;s Codium credits")
    // Purchased credits pool every top-up ever bought, so they read as a state, not a share of that pool.
    expect(html).toContain("Purchased Codium credits available")
    expect(html).not.toMatch(/\d+%<\/strong> of your purchased/)
    const state = (value: "available" | "low" | "used") =>
      renderToStaticMarkup(
        createElement(ModelPlans, {
          accessToken: "",
          preview: { config, status: { active: false, access: true, purchased: { bought: true, state: value } } },
        }),
      )
    expect(state("available")).toContain("Purchased Codium credits available")
    expect(state("low")).toContain("Your purchased Codium credits are running low")
    expect(state("used")).toContain("Your purchased Codium credits are used up")
    const standalone = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: { config, status: { active: false, access: true, purchased: { bought: true } } },
      }),
    )
    expect(standalone).toContain("Purchased credits")
    expect(standalone).toContain("Usage temporarily unavailable")
    expect(standalone).not.toContain("Monthly allowance")
    expect(standalone).not.toContain("Renews")
  })
})
