import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { FoundingMember, readFoundingView } from "../src/components/marketing/account/FoundingMember"
import { readFoundersPage } from "../src/components/marketing/founders/FoundersPage"
import { readModelPlanStatus } from "../src/lib/model-plans"

// WP A31 on the website: the account status's founding number, the account page's founding block and the founders
// page's decoder. The server decides membership, numbers and names; these only refuse what is not in its shape.

const page = "https://vectordev.ai/founders#AAAAAAAAAAAAAAAAAAAAAA"
const plan = { id: "vector-50", name: "Pro", left: 0.5, renewsAt: Date.UTC(2026, 10, 12), cancelAtPeriodEnd: false }

describe("founding on the website", () => {
  test("the status keeps a founding number only beside a plan, and only a whole positive one", () => {
    expect(readModelPlanStatus({ active: true, plan, founding: { number: 12 } }).founding).toEqual({ number: 12 })
    for (const founding of [{ number: 0 }, { number: 1.5 }, { number: "12" }, "12", null, { number: 12, boost: 1.1 }]) {
      const read = readModelPlanStatus({ active: true, plan, founding })
      if (founding && typeof founding === "object" && founding.number === 12)
        expect(read.founding).toEqual({ number: 12 })
      else expect(read.founding).toBeUndefined()
    }
    expect(readModelPlanStatus({ active: false, founding: { number: 12 } }).founding).toBeUndefined()
  })

  test("the founding view and the founders page keep only the server's shape", () => {
    expect(readFoundingView({ member: true, number: 3, listed: true, name: "Ada", page })).toEqual({
      member: true,
      number: 3,
      listed: true,
      name: "Ada",
      page,
    })
    for (const view of [
      { member: false },
      { member: true, number: 0, listed: true, page },
      { member: true, number: 3, listed: "yes", page },
      { member: true, number: 3, listed: true, page: "javascript:alert(1)" },
      { member: true, number: 3, listed: true, page, name: "<b>" },
    ])
      expect(readFoundingView(view)).toBeUndefined()
    expect(
      readFoundersPage({
        public: false,
        founders: [{ number: 1, name: "Ada" }, { number: 2, name: "<x>" }, { number: -1 }],
      }),
    ).toEqual({ public: false, founders: [{ number: 1, name: "Ada" }, { number: 2 }] })
    expect(readFoundersPage({ founders: [] })).toBeUndefined()
  })

  test("the account page's block names the number and the lock before anything is read", () => {
    const html = renderToStaticMarkup(createElement(FoundingMember, { accessToken: "session", number: 7 }))
    expect(html).toContain("Founding member #7")
    expect(html).toContain("Your price won&#x27;t go up while you stay subscribed.")
    // The opt-in appears only once the server confirmed the membership.
    expect(html).not.toContain("founders page")
    expect(html).not.toMatch(/\$|usd|credit|boost|10%/i)
  })
})
