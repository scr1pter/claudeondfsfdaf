import { describe, expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { onCodiumChange, type VectorBillingRequest, type VectorBillingResult } from "@/vector-account"
import type { BillingNotice } from "./codium-billing"
import { codiumActions, codiumErrorText, codiumFix } from "./codium-error"

const status = { authenticated: false, pending: false }
// `result` is how the billing window ends, or what it throws.
const fixture = (account = true, billing = false, result: VectorBillingResult | Error = { outcome: "closed" }) => {
  const calls: string[] = []
  return {
    calls,
    platform: {
      openLink: (url: string) => void calls.push(`open ${url}`),
      vectorAccount: account
        ? {
            status: async () => status,
            start: async () => {
              calls.push("sign in")
              return status
            },
            cancel: async () => status,
            logout: async () => status,
            onChange: () => () => {},
            refreshModels: async () => void calls.push("models"),
            ...(billing
              ? {
                  billing: async (request: VectorBillingRequest) => {
                    calls.push(`billing ${JSON.stringify(request)}`)
                    if (result instanceof Error) throw result
                    return result
                  },
                }
              : {}),
          }
        : undefined,
    },
  }
}
// What a portal step from a failed turn told the person, and the waits of the later plan and model reads it started
// (each kept until the test passes it).
const observe = () => {
  const notices: BillingNotice[] = []
  const waits: { ms: number; pass: () => void }[] = []
  return {
    notices,
    waits,
    options: {
      notify: (notice: BillingNotice) => void notices.push(notice),
      wait: (ms: number) => new Promise<void>((pass) => waits.push({ ms, pass })),
    },
  }
}
const settle = async () => {
  for (const _ of [1, 2, 3, 4, 5, 6]) await Promise.resolve()
}

// What the engine stores for a failed turn: the gateway's answer as the engine words it (ModelPlanStatus.gatewayFailure),
// the three-valued action, and the code.
const failure = (status: number, code: string, action?: string) => {
  const answer = ModelPlanStatus.gatewayFailure(
    status,
    JSON.stringify({ error: { code, message: "Server message.", ...(action ? { action } : {}) } }),
  )!
  return { action: answer.action ?? "unavailable", text: answer.message, code: answer.code }
}
const press = async (actions: { label: string; onClick: () => void }[]) => {
  actions[0]?.onClick()
  await Promise.resolve()
}

describe("codiumFix", () => {
  test("each gateway answer gets its fix, from the code in a toast and from the message alone in the timeline", () => {
    const cases = [
      [failure(402, "MODEL_PLAN_REQUIRED"), "plans", "plans"],
      // A subscriber's month used up: the code says so; the card, with only the text, asks whether there is a plan.
      [failure(402, "MODEL_PLAN_EXHAUSTED"), "change-plan", "plans"],
      [failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "update-card"), "update-card", "update-card"],
      [failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "confirm-payment"), "confirm-payment", "confirm-payment"],
      [failure(403, "MODEL_PLAN_UPGRADE_REQUIRED"), "change-plan", "change-plan"],
      [failure(409, "MODEL_PLAN_EXISTS"), "manage-plan", "manage-plan"],
      [failure(401, "CODIUM_SIGN_IN_REQUIRED"), "sign-in", "sign-in"],
      // Daily, run and Brain limits never offer anything to buy, nor does Codium being unavailable.
      [failure(429, "MODEL_PLAN_DAILY_LIMIT"), undefined, undefined],
      [failure(429, "MODEL_PLAN_RUN_LIMIT"), undefined, undefined],
      [failure(429, "MODEL_PLAN_BRAIN_SHARE"), undefined, undefined],
      [failure(503, "MODEL_PLAN_MODEL_UNAVAILABLE"), undefined, undefined],
      [failure(403, "MODEL_PLAN_BLOCKED"), undefined, undefined],
    ] as const
    for (const [input, toast, card] of cases) {
      expect({ code: input.code, fix: codiumFix(input) }).toEqual({ code: input.code, fix: toast })
      expect({ code: input.code, fix: codiumFix({ action: input.action, text: input.text }) }).toEqual({
        code: input.code,
        fix: card,
      })
    }
    // The card reads the account: with a plan, a used-up month is Change plan; without one, See plans.
    const exhausted = failure(402, "MODEL_PLAN_EXHAUSTED")
    expect(codiumFix({ action: exhausted.action, text: exhausted.text, subscribed: true })).toBe("change-plan")
    expect(codiumFix({ action: exhausted.action, text: exhausted.text, subscribed: false })).toBe("plans")
    // A payment step in the message wins over a plan.
    const card = failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "update-card")
    expect(codiumFix({ action: card.action, text: card.text, subscribed: true })).toBe("update-card")
    // A turn stored before Codium stopped selling top-ups still offers the plans.
    expect(codiumFix({ action: "credits", text: `Out. Buy credits at ${ModelPlanStatus.PURCHASE_URL}` })).toBe("plans")
  })
})

describe("codiumActions", () => {
  test("See plans and Change plan stay in Vector where the desktop can bill", async () => {
    for (const [input, label] of [
      [failure(402, "MODEL_PLAN_REQUIRED"), "See plans"],
      [failure(402, "MODEL_PLAN_EXHAUSTED"), "Change plan"],
      [failure(403, "MODEL_PLAN_UPGRADE_REQUIRED"), "Change plan"],
      [failure(409, "MODEL_PLAN_EXISTS"), "Manage plan"],
    ] as const) {
      const app = fixture(true, true)
      const actions = codiumActions(input, app.platform, () => app.calls.push("plans"))
      expect(actions.map((action) => action.label)).toEqual([label])
      await press(actions)
      expect(app.calls).toEqual(["plans"])
    }
  })

  test("without the desktop's billing, a plan step opens the website", async () => {
    for (const app of [fixture(true, false), fixture(false)]) {
      await press(codiumActions(failure(402, "MODEL_PLAN_REQUIRED"), app.platform, () => app.calls.push("plans")))
      await press(codiumActions(failure(402, "MODEL_PLAN_EXHAUSTED"), app.platform, () => app.calls.push("plans")))
      await press(codiumActions(failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "update-card"), app.platform))
      expect(app.calls).toEqual([
        `open ${ModelPlanStatus.PURCHASE_URL}`,
        `open ${ModelPlanStatus.MANAGE_URL}`,
        `open ${ModelPlanStatus.MANAGE_URL}`,
      ])
    }
  })

  test("a paused plan's card is updated, or its payment confirmed, in Stripe's portal inside Vector", async () => {
    const update = fixture(true, true)
    const actions = codiumActions(
      failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "update-card"),
      update.platform,
      undefined,
      observe().options,
    )
    expect(actions.map((action) => action.label)).toEqual(["Update card"])
    await press(actions)
    expect(update.calls).toEqual([`billing ${JSON.stringify({ kind: "portal", flow: "payment_method_update" })}`])

    const confirm = fixture(true, true)
    const next = codiumActions(
      failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "confirm-payment"),
      confirm.platform,
      undefined,
      observe().options,
    )
    expect(next.map((action) => action.label)).toEqual(["Confirm payment"])
    await press(next)
    expect(confirm.calls).toEqual([`billing ${JSON.stringify({ kind: "portal" })}`])
  })

  test("a card updated from a failed turn says so and reads the plan and models again at 5, 20 and 60 s", async () => {
    const app = fixture(true, true, { outcome: "completed" })
    const seen = observe()
    const reads: string[] = []
    const stop = onCodiumChange(() => reads.push("read"))
    await press(
      codiumActions(failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "update-card"), app.platform, undefined, seen.options),
    )
    await settle()
    expect(seen.notices).toEqual([
      { kind: "done", text: "Your card is updated. Your plan picks up again once the payment goes through." },
    ])
    // Read once when the window closes, then on the purchase schedule, the local server's models first each time.
    expect(reads).toEqual(["read"])
    for (const ms of [5_000, 15_000, 40_000]) {
      expect(seen.waits.map((item) => item.ms)).toEqual([ms])
      seen.waits.shift()!.pass()
      await settle()
    }
    expect(app.calls.filter((call) => call === "models")).toHaveLength(3)
    expect(reads).toEqual(["read", "read", "read", "read"])
    stop()
  })

  test("closing the portal opened to confirm a payment reads again later, since only the plan says it was paid", async () => {
    const confirm = observe()
    await press(
      codiumActions(
        failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "confirm-payment"),
        fixture(true, true, { outcome: "closed" }).platform,
        undefined,
        confirm.options,
      ),
    )
    await settle()
    expect(confirm.notices).toEqual([])
    expect(confirm.waits.map((item) => item.ms)).toEqual([5_000])
    // Closing the card step without updating it changes nothing to read again later.
    const update = observe()
    await press(
      codiumActions(
        failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "update-card"),
        fixture(true, true, { outcome: "closed" }).platform,
        undefined,
        update.options,
      ),
    )
    await settle()
    expect(update.waits).toEqual([])
  })

  test("a portal step that fails from a failed turn says why, and starts no later reads", async () => {
    for (const [result, text] of [
      [
        { outcome: "failed", message: "Vector could not reach vectordev.ai. Check your connection and try again." },
        "Vector could not reach vectordev.ai. Check your connection and try again.",
      ],
      [new Error("IPC closed"), "Vector could not open billing. Try again."],
    ] as const) {
      const seen = observe()
      await press(
        codiumActions(
          failure(402, "MODEL_PLAN_PAYMENT_REQUIRED", "update-card"),
          fixture(true, true, result).platform,
          undefined,
          seen.options,
        ),
      )
      await settle()
      expect(seen.notices).toEqual([{ kind: "error", text }])
      expect(seen.waits).toEqual([])
    }
  })

  test("a lost sign-in offers Sign in to Vector where the app can sign in", () => {
    const app = fixture()
    const [signIn] = codiumActions(failure(401, "CODIUM_SIGN_IN_REQUIRED"), app.platform)
    expect(signIn?.label).toBe("Sign in to Vector")
    signIn?.onClick()
    expect(app.calls).toEqual(["sign in"])
    expect(codiumActions(failure(401, "CODIUM_SIGN_IN_REQUIRED"), fixture(false).platform)).toEqual([])
  })

  test("daily, run and Brain limits and Codium being unavailable need no button", () => {
    for (const code of ["MODEL_PLAN_DAILY_LIMIT", "MODEL_PLAN_RUN_LIMIT", "MODEL_PLAN_BRAIN_SHARE"])
      expect(codiumActions(failure(429, code), fixture(true, true).platform, () => undefined)).toEqual([])
    expect(codiumActions(failure(503, "CODIUM_UNAVAILABLE"), fixture().platform)).toEqual([])
  })
})

describe("codiumErrorText", () => {
  test("drops every step the engine ends with where the app offers it as a button", () => {
    const app = fixture(true, true).platform
    for (const [status, code, action] of [
      [402, "MODEL_PLAN_REQUIRED"],
      [402, "MODEL_PLAN_EXHAUSTED"],
      [402, "MODEL_PLAN_PAYMENT_REQUIRED", "update-card"],
      [402, "MODEL_PLAN_PAYMENT_REQUIRED", "confirm-payment"],
      [403, "MODEL_PLAN_UPGRADE_REQUIRED"],
      [409, "MODEL_PLAN_EXISTS"],
    ] as const)
      expect(codiumErrorText(failure(status, code, action).text, app)).toBe("Server message.")
    expect(
      codiumErrorText(`Your Codium credits are used up. Buy credits at ${ModelPlanStatus.PURCHASE_URL}`, app),
    ).toBe("Your Codium credits are used up.")
    // A daily limit's message has no step to drop.
    expect(codiumErrorText(failure(429, "MODEL_PLAN_DAILY_LIMIT").text, app)).toBe("Server message.")
  })

  test("keeps the link where the app cannot bill", () => {
    const text = failure(402, "MODEL_PLAN_REQUIRED").text
    expect(text).toEndWith(`See plans at ${ModelPlanStatus.PURCHASE_URL}`)
    expect(codiumErrorText(text, fixture(true, false).platform)).toBe(text)
    expect(codiumErrorText(text, fixture(false).platform)).toBe(text)
  })
})
