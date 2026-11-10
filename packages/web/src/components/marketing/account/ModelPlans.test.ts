import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { ModelPlans, type ModelPlansPreview } from "./ModelPlans"

const renewal = Date.UTC(2026, 10, 12)
const config: ModelPlansPreview["config"] = {
  enabled: true,
  currency: "usd",
  interval: "month",
  plans: CodiumPlan.PLANS.map((plan) => ({ ...plan, available: true })),
  models: [
    { id: "vendor/base", name: "Base model", plans: ["vector-10", "vector-50", "vector-100", "vector-200"] },
    { id: "vendor/pro", name: "Pro model", minPlan: "vector-50" },
    { id: "vendor/preview", name: "Ultra preview", plans: ["vector-200"], minPlan: "vector-100" },
  ],
}
const status: ModelPlansPreview["status"] = {
  active: true,
  access: true,
  plan: { id: "vector-10", name: "Plus", left: 0.64, renewsAt: renewal, cancelAtPeriodEnd: false },
}
function render(input: Partial<ModelPlansPreview> = {}) {
  return renderToStaticMarkup(createElement(ModelPlans, { accessToken: "", preview: { config, status, ...input } }))
}
function card(html: string, name: string) {
  return html.match(new RegExp(`<article[^>]*><h4>${name}</h4>[^]*?</article>`))?.[0] ?? ""
}

describe("account model plans", () => {
  test("loading and signed-out views never offer checkout before status is known", () => {
    const loading = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "pending-session" }))
    expect(loading).toContain("Loading model plans")
    expect(loading).toContain('aria-busy="true"')
    expect(loading).not.toContain("<button")
    const signedOut = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "" }))
    expect(signedOut).toContain("Sign in to view your model plan")
    expect(signedOut).not.toContain("Loading model plans")
  })

  test("disabled sales keep canonical prices but no purchase request", () => {
    const html = render({ config: { ...config, enabled: false }, status: { active: false } })
    for (const amount of [10, 50, 100, 200]) expect(html).toContain(`$${amount}`)
    expect(html).toContain("Purchasing is not available yet")
    expect(html.match(/<button[^>]*disabled=""[^>]*>Coming soon<\/button>/g)).toHaveLength(4)
    expect(html).not.toContain("Choose Plus")
  })

  test("active subscribers can still switch down at renewal while all new sales are unavailable", () => {
    const html = render({
      config: { ...config, enabled: false, plans: config.plans.map((plan) => ({ ...plan, available: false })) },
      status: { ...status, enabled: false, plan: { ...status.plan!, id: "vector-100", name: "Max", state: "active" } },
    })
    expect(card(html, "Pro")).toContain("Switch at renewal")
    expect(card(html, "Pro")).toContain("Pro starts on your renewal date")
    expect(card(html, "Max")).toContain("Current plan")
    expect(card(html, "Ultra")).toContain("Coming soon")
    expect(html).not.toContain("Upgrade to")
    expect(html).not.toContain("Choose Plus")
  })

  test("an old-shaped active status shows plan, left meter, renewal and management", () => {
    const html = render()
    expect(html).toContain("<h3>Plan · Plus</h3>")
    expect(html).toContain("36% used · 64% left")
    expect(html).toContain('aria-label="This month left"')
    expect(html).toContain('aria-valuenow="64"')
    expect(html).toContain('aria-valuetext="36% used · 64% left"')
    expect(html).toContain("Active")
    expect(html).toContain("Renews")
    expect(html).toContain("Nov 12, 2026")
    expect(html).toContain("Manage subscription")
    expect(html).toContain("Current plan")
    expect(html).toContain('href="/codium"')
  })

  test("month rounding derives used from rounded left and preserves both endpoints", () => {
    for (const [left, expected] of [
      [0.644, 64],
      [0.645, 65],
      [0, 0],
      [1, 100],
    ] as const) {
      const html = render({ status: { ...status, plan: { ...status.plan!, left } } })
      expect(html).toContain(`${100 - expected}% used · ${expected}% left`)
      expect(html).toContain(`aria-valuenow="${expected}"`)
    }
  })

  test("missing usage stays unknown and ending access never promises renewal", () => {
    const html = render({ status: { ...status, plan: { ...status.plan!, left: undefined, cancelAtPeriodEnd: true } } })
    expect(html).toContain("Usage temporarily unavailable")
    expect(html).toContain("Ending this period")
    expect(html).toContain("Access ends")
    expect(html).not.toContain("Renews")
    expect(html).not.toContain("<meter")
    expect(html).not.toContain("Upgrade to")
  })

  test("Today is a daily-limit share, with UTC reset and reached notice", () => {
    const html = render({
      status: { ...status, plan: { ...status.plan!, today: { used: 0.75, resetsAt: renewal, reached: true } } },
    })
    expect(html).toContain("<dt>Today</dt>")
    expect(html).toContain('aria-label="Today left"')
    expect(html).toContain('aria-valuetext="75% used · 25% left"')
    expect(html).toContain("Today&#x27;s limit is reached")
    expect(html).toContain("Resets Nov 12, 2026")
    expect(html).toContain("UTC")
    expect(render()).not.toContain("<dt>Today</dt>")
    expect(
      render({
        status: {
          ...status,
          plan: {
            ...status.plan!,
            id: "vector-200",
            name: "Ultra",
            today: { used: 0.75, resetsAt: renewal, reached: true },
          },
        },
      }),
    ).not.toContain("<dt>Today</dt>")
  })

  test("listed meters distinguish GitHub agents from computers Vector hosts", () => {
    const html = render({
      status: {
        ...status,
        plan: { ...status.plan!, id: "vector-100", name: "Max" },
        listed: ["github-agents", "computer", "vault", "brain", "remote"],
        meters: {
          cloudAgents: { used: 0.3, exhausted: false },
          hosted: { used: 0.6 },
          vault: { usedBytes: 5e9, quotaBytes: 25e9 },
          brain: { used: 0.03, cap: 0.1 },
          remote: { computers: 2, limit: 5 },
        },
      },
    })
    for (const label of [
      "Codium agent time",
      "Cloud computer hours",
      "Vault storage",
      "Brain helpers",
      "Vector Remote",
    ])
      expect(html).toContain(`<dt>${label}</dt>`)
    expect(html).toContain('aria-label="Codium agent time left"')
    expect(html).toContain("30% used · 70% left")
    expect(html).toContain("60% used · 40% left")
    expect(html).toContain("20% used · 80% left")
    expect(html).toContain("5 GB used of 25 GB")
    expect(html).toContain("2 of 5 computers paired")
    expect(html).toContain("in your own repo, on your own Actions minutes")
    expect(html).toContain("a computer Vector runs for you")
    expect(html).not.toContain("Vector Labs")
  })

  test("unlisted or inapplicable meters stay hidden even when their cached figures exist", () => {
    const usage = {
      hosted: { used: 0.7 },
      cloudAgents: { used: 0.6, exhausted: false },
      vault: { usedBytes: 1e9, quotaBytes: 10e9 },
    }
    const hidden = render({
      config: { ...config, listed: ["computer", "github-agents", "vault"] },
      status: { ...status, listed: [], meters: usage },
    })
    for (const text of ["Cloud computer hours", "Codium agent time", "Vault storage", "GB used"])
      expect(hidden).not.toContain(text)
    const plus = render({ status: { ...status, listed: ["computer", "vault"], meters: usage } })
    expect(plus).not.toContain("Cloud computer hours")
    expect(plus).not.toContain("Vault storage")
    const unknown = render({ status: { ...status, listed: ["github-agents", "brain"] } })
    expect(unknown.match(/Usage temporarily unavailable/g)).toHaveLength(2)
    expect(unknown.match(/<meter/g)).toHaveLength(1)
  })

  test("Velocity remains Coming, planned 550B+, outside today's purchase and only on Max or Ultra", () => {
    const html = render({
      status: {
        ...status,
        velocity: "coming",
        plan: { ...status.plan!, id: "vector-100", name: "Max", forecastDate: "2026-11-07", ramp: { until: renewal } },
      },
    })
    expect(html).toContain("Vector Velocity")
    expect(html).toContain("Coming")
    expect(html).toContain("planned 550B+")
    expect(html).toContain("if it launches; no date")
    expect(html).toContain("not part of today&#x27;s purchase")
    expect(html).toContain("<dt>Forecast</dt>")
    expect(html).toContain("Nov 7, 2026")
    expect(html).toContain("New Max and Ultra plans")
    const plus = render({
      status: { ...status, velocity: "coming", plan: { ...status.plan!, ramp: { until: renewal } } },
    })
    expect(plus).not.toContain("Vector Velocity")
    expect(plus).not.toContain("Starting limits")
  })

  test("upgrade states the full new price today and downgrade switches at renewal", () => {
    const html = render({ status: { ...status, plan: { ...status.plan!, id: "vector-50", name: "Pro" } } })
    expect(card(html, "Max")).toContain(
      "Upgrade to Max: $100 today, then monthly from today. Keeps what&#x27;s left of this month.",
    )
    expect(card(html, "Plus")).toContain("Switch at renewal")
    expect(card(html, "Plus")).toContain("Plus starts on your renewal date")
    expect(card(html, "Pro")).toContain("Current plan")
    expect(card(html, "Pro")).not.toContain("Upgrade to")
    expect(render({ status: { active: false } })).toContain("Choose Plus")
  })

  test("scheduled downgrades offer Keep my plan and no second charge", () => {
    const html = render({
      status: {
        ...status,
        plan: {
          ...status.plan!,
          id: "vector-100",
          name: "Max",
          state: "active",
          scheduled: { id: "vector-50", name: "Pro", at: renewal },
        },
      },
    })
    expect(html).toContain("Pro starts Nov 12, 2026")
    expect(html).toContain("Keep my plan")
    expect(card(html, "Pro")).toContain("Scheduled at renewal")
    expect(card(html, "Max")).toContain("Current plan")
    expect(html).not.toContain("Upgrade to Ultra")
    expect(html).not.toContain("Switch at renewal")
  })

  test("paused payment failure shows only recovery, without the offer grid or Keep action", () => {
    const html = render({
      status: {
        ...status,
        plan: {
          ...status.plan!,
          state: "paused",
          reason: "payment_failed",
          action: "update-card",
          scheduled: { id: "vector-50", name: "Pro", at: renewal },
        },
      },
    })
    expect(html).toContain("Payment failed")
    expect(html).toContain("Update payment method")
    expect(html).toContain("plan and its perks are paused")
    expect(html).toContain("billing period has not been extended")
    expect(html.match(/<button/g)).toHaveLength(1)
    for (const text of ["Monthly subscriptions", "Manage subscription", "Keep my plan", "Upgrade to", "Choose"])
      expect(html).not.toContain(text)
  })

  test("bank confirmation and pending payments use accurate recovery wording", () => {
    const confirmation = render({
      status: {
        ...status,
        plan: { ...status.plan!, state: "paused", reason: "action_required", action: "confirm-payment" },
      },
    })
    expect(confirmation).toMatch(/<button[^>]*>Confirm payment<\/button>/)
    expect(confirmation).not.toContain("Update payment method")
    expect(confirmation).not.toContain("Payment failed")
    const pending = render({
      status: { ...status, plan: { ...status.plan!, state: "paused", reason: "payment_pending" } },
    })
    expect(pending).toContain("Payment pending")
    expect(pending).not.toContain("Payment failed")
  })

  test("frozen and unknown states retain management without plan-change actions", () => {
    for (const state of ["frozen", "unknown"] as const) {
      const html = render({ status: { ...status, plan: { ...status.plan!, state } } })
      expect(html).toContain(state === "frozen" ? "On hold" : "Plan status unavailable")
      expect(html).toContain("Manage subscription")
      expect(html).not.toContain("Upgrade to")
      expect(html).not.toContain("Switch at renewal")
    }
  })

  test("existing subscribers and billing customers retain management when sales are closed", () => {
    for (const current of [status, { active: false, customer: true }]) {
      const html = render({ config: { ...config, enabled: false }, status: current })
      expect(html).toContain("New Codium purchases are not available")
      expect(html).toContain("Manage subscription")
      expect(html).not.toContain("Choose Plus")
    }
  })

  test("only qualified models and their own matching task estimate appear on each tier", () => {
    const html = render({
      config: {
        ...config,
        models: [config.models![2]!, config.models![0]!, config.models![1]!],
        plans: config.plans.map((plan) => ({
          ...plan,
          tasks: [
            [91234, 99999],
            [60, 550],
            [40, 200],
          ],
        })),
      },
    })
    const plus = card(html, "Plus")
    expect(plus).toContain("About 60–550 typical tasks a month with Base model")
    expect(plus).not.toContain("91234")
    expect(plus).not.toContain("Pro model")
    expect(plus).not.toContain("Ultra preview")
    expect(card(html, "Pro")).toContain("Base model, Pro model")
    expect(card(html, "Max")).not.toContain("Ultra preview")
    expect(card(html, "Ultra")).toContain("Ultra preview")
    expect(html).not.toContain("All Codium models included")
    expect(html).not.toContain("same catalog")
    expect(
      render({ config: { ...config, models: [{ id: "vendor/legacy", name: "Unqualified legacy model" }] } }),
    ).not.toContain("Unqualified legacy model")
  })

  test("retired fields never render even in a legacy response with a balance or pack", () => {
    const html = render({
      config: {
        ...config,
        topups: [{ id: "legacy-pack", name: "Retired pack", price: 777, available: true }],
        plans: config.plans.map((plan) => ({ ...plan, credits: 4321 })),
      },
      status: { ...status, purchased: { bought: true, state: "available" } },
    })
    for (const text of ["purchased", "top-up", "topup", "credit", "Retired pack", "$777", "4321", "tokens", "markup"])
      expect(html.toLowerCase()).not.toContain(text.toLowerCase())
    expect(html).toContain("free models keep working")
    expect(html).toContain('href="/legal/terms#codium"')
  })

  test("preview with a session disables every billing action and does not offer Refresh", () => {
    for (const current of [
      status,
      { active: false },
      { ...status, plan: { ...status.plan!, state: "paused" as const } },
    ]) {
      const html = renderToStaticMarkup(
        createElement(ModelPlans, { accessToken: "preview-session", preview: { config, status: current } }),
      )
      const buttons = html.match(/<button[^>]*>/g) ?? []
      expect(buttons.length).toBeGreaterThan(0)
      for (const button of buttons) expect(button).toContain('disabled=""')
      expect(html).not.toContain("Refresh plan and usage")
    }
    const empty = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "", preview: true }))
    expect(empty).toContain("Vector Codium is coming soon")
    expect(empty).not.toContain("Loading model plans")
    expect(empty).not.toContain("<button")
  })
})
