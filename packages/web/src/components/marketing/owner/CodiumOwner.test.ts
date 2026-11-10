import { describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CodiumOwner } from "@vectordevai/schema/codium-owner"
// Match Astro's React-island compilation; the web package otherwise defaults to Solid JSX.
const react = new Bun.Transpiler({
  loader: "tsx",
  autoImportJSX: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } },
})
Bun.plugin({
  name: "owner React island",
  setup(build) {
    build.onLoad({ filter: /components\/marketing\/(owner|account)\/[^/]+\.tsx$/ }, async (args) => ({
      contents: react.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})
const {
  CodiumOwnerPage,
  CodiumOwnerRequestError,
  OWNER_REFRESH_MS,
  OwnerDashboard,
  RefundConfirmation,
  mutateCodiumOwner,
  ownerGate,
  readCodiumOwner,
  refundRequest,
  replaySince,
} = await import("./CodiumOwner")

const NOW = Date.UTC(2026, 9, 28, 12)
const DAY = 86_400_000
const ACCOUNT = "44444444-4444-4444-8444-444444444444"
const quote: CodiumOwner.Account = {
  account: ACCOUNT,
  state: "active",
  plan: "vector-100",
  periodEnd: NOW + 20 * DAY,
  blocked: false,
  openDisputes: 0,
  efw: 0,
  refundCharge: "ch_ownerfixture",
  refundCents: 10000,
  refundSubscription: "sub_ownerfixture",
  refundPeriodStart: NOW - 10 * DAY,
}
const summary: CodiumOwner.Dashboard = {
  generatedAt: NOW,
  sales: { enabled: true, reason: "The sales switch and funding check allow new subscriptions." },
  funding: {
    status: "open",
    checkedAt: NOW,
    balance: 125000,
    owed: 80000,
    reserved: 5000,
    required: 100000,
    runwayDays: 5.25,
    spendPerDay: 2500,
    spendPerHour: 104,
    lowWater: true,
    spike: false,
    watchdog: { threshold: 150000, since: NOW - 30 * 60_000, overdue: true },
  },
  history: [
    { checkedAt: NOW - DAY, balance: 128000, owed: 81000, reserved: 4000, required: 100000 },
    { checkedAt: NOW, balance: 125000, owed: 80000, reserved: 5000, required: 100000 },
  ],
  subscriptions: [
    { plan: "vector-10", count: 3, mrrCents: 3000 },
    { plan: "vector-50", count: 2, mrrCents: 10000 },
    { plan: "vector-100", count: 1, mrrCents: 10000 },
    { plan: "vector-200", count: 0, mrrCents: 0 },
  ],
  risk: { disputes30d: 1, efw30d: 1, paidInvoices30d: 100, ratio: 0.01 },
  health: {
    webhooks: { status: "healthy", detail: "No unresolved webhook errors.", checkedAt: NOW },
    outbox: { depth: 2, deadLetters: 1 },
    sweep: { status: "warning", detail: "One account needs reconciliation.", checkedAt: NOW },
    store: { status: "healthy", detail: "Store is reachable.", checkedAt: NOW },
  },
  budgets: [{ service: "OpenRouter", status: "healthy", detail: "Funding guard is configured." }],
  switches: [
    { name: "sales", value: "on", changedAt: NOW },
    { name: "codium", value: "on", changedAt: NOW },
    { name: "hosted", value: "no-new", changedAt: NOW },
  ],
  modelsOff: ["example/paused-model"],
  perksOff: ["remote"],
  accounts: [quote],
  accountsComplete: true,
  stripeChecklist: [
    {
      id: "webhook",
      title: "Webhook events",
      status: "owner-check",
      detail: "Confirm the enabled event list in Stripe.",
    },
  ],
  audit: [{ at: NOW, actor: ACCOUNT, action: "switch", account: ACCOUNT, outcome: "accepted" }],
}

const render = (value: CodiumOwner.Dashboard) =>
  renderToStaticMarkup(
    createElement(OwnerDashboard, {
      summary: value,
      onRefresh: () => undefined,
      onMutation: async () => undefined,
    }),
  )

describe("private Codium owner frontend", () => {
  test("the public shell includes no private data, server fetch or serialized preview", async () => {
    const html = renderToStaticMarkup(createElement(CodiumOwnerPage))
    expect(html).toContain("Checking your session")
    for (const secret of [ACCOUNT, "ch_ownerfixture", "$1,250", "Customer obligation"])
      expect(html).not.toContain(secret)
    const page = await Bun.file(new URL("../../../pages/owner/codium.astro", import.meta.url)).text()
    expect(page).toContain('client:only="react"')
    expect(page).toContain('description="Private." noindex')
    expect(page).not.toContain("fetch(")
    expect(page).not.toContain("preview=")
    expect(OWNER_REFRESH_MS).toBe(60_000)
    for (const file of ["../MarketingNav.astro", "../SiteFooter.astro", "../../Lander.astro"])
      expect(await Bun.file(new URL(file, import.meta.url)).text()).not.toContain("/owner/codium")
  })

  test("loads through the shared decoder using a session header and no cookies, cache or URL token", async () => {
    const calls: { input: string; init?: RequestInit }[] = []
    const loaded = await readCodiumOwner("fixture-session-token", (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ input: String(input), init })
      return Response.json({
        ...summary,
        ownerSecret: "must-not-survive",
        accounts: [{ ...quote, email: "private@example.test" }],
      })
    }) as typeof fetch)
    expect(loaded.accounts[0]).toEqual(quote)
    expect(JSON.stringify(loaded)).not.toContain("private@example.test")
    expect(JSON.stringify(loaded)).not.toContain("must-not-survive")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe("/api/owner/codium")
    expect(calls[0]?.init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store" })
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer fixture-session-token")
    expect(calls[0]?.init?.body).toBeUndefined()
  })

  test("missing sessions never make an owner request", async () => {
    const calls: unknown[] = []
    await expect(
      readCodiumOwner("", (async (input: unknown) => {
        calls.push(input)
        return Response.json(summary)
      }) as typeof fetch),
    ).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" })
    expect(calls).toEqual([])
  })

  test.each([
    [401, "SIGN_IN_REQUIRED", "signin", false],
    [401, "SESSION_INVALID", "signin", false],
    [403, "GOOGLE_SIGN_IN_REQUIRED", "signin", true],
    [403, "RECENT_SIGN_IN_REQUIRED", "signin", true],
    [403, "DESIGN_LAB_FORBIDDEN", "denied", undefined],
  ] as const)("maps %s %s to an auth gate without rendering upstream details", async (status, code, kind, fresh) => {
    const error = await readCodiumOwner("fixture-session", (async (_input: RequestInfo | URL) =>
      Response.json(
        { error: { code, message: "private@example.test must not appear" } },
        { status },
      )) as typeof fetch).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(CodiumOwnerRequestError)
    const gate = ownerGate(error)
    expect(gate.kind).toBe(kind)
    if (gate.kind === "signin" && fresh !== undefined) expect(gate.fresh).toBe(fresh)
    expect(gate.message).not.toContain("private@example.test")
  })

  test("an incomplete dashboard is refused rather than populated with made-up zeroes", async () => {
    await expect(
      readCodiumOwner("fixture-session", (async (_input: RequestInfo | URL) =>
        Response.json({ generatedAt: NOW, sales: summary.sales })) as typeof fetch),
    ).rejects.toMatchObject({ code: "OWNER_RESPONSE_INVALID" })
    const html = render({
      ...summary,
      funding: null,
      history: [],
      risk: { disputes30d: null, efw30d: null, paidInvoices30d: null, ratio: null },
    })
    const funding = html.slice(html.indexOf('id="owner-funding-title"'), html.indexOf('id="owner-subscriptions-title"'))
    expect(funding).toContain("No reading")
    expect(funding).toContain("Unavailable")
    expect(funding).not.toContain("$0.00")
    expect(html).toContain("Unknown")
  })

  test("a future-dated funding reading is shown as stale after a clock rollback", () => {
    if (!summary.funding) throw new Error("Missing fixture funding")
    const html = render({
      ...summary,
      funding: { ...summary.funding, checkedAt: NOW + 60_000 },
    })
    const funding = html.slice(html.indexOf('id="owner-funding-title"'), html.indexOf('id="owner-subscriptions-title"'))
    expect(funding).toContain("Reading stale")
    expect(funding).not.toContain(">Funded<")
  })

  test("renders private money, funding warnings, health and IDs only inside the authenticated view", () => {
    const html = render(summary)
    for (const label of [
      "Sales open",
      "$1,250.00",
      "5.25 days",
      "Above 0.5%",
      "Dead letters",
      "Runtime controls",
      "Stripe settings checklist",
      "Recent owner actions",
      "Owner check",
      "Required with margin",
      "Auto top-up threshold",
    ])
      expect(html).toContain(label)
    expect(html).toContain(ACCOUNT)
    expect(html).not.toContain("@")
    expect(html).not.toContain("ownerSecret")
    expect(html).toContain('role="img" aria-labelledby="owner-history-title"')
  })

  test("a bounded account list is labelled and unknown refund quotes disable the destructive action", () => {
    const html = render({
      ...summary,
      accountsComplete: false,
      accounts: [{ ...quote, refundCents: undefined, refundCharge: undefined }],
    })
    expect(html).toContain("This is a limited account list")
    expect(html).toContain("Use an account ID below")
    expect(html).toContain("Verified refund details unavailable")
    expect(html).toMatch(/<button[^>]*data-danger="true"[^>]*disabled=""/)
    expect(refundRequest({ ...quote, refundCents: undefined })).toBeUndefined()
    expect(refundRequest({ ...quote, refundPeriodStart: undefined })).toBeUndefined()
    expect(refundRequest({ ...quote, refundSubscription: undefined })).toBeUndefined()
  })

  test("refund confirmation names the account, amount, charge and full ending scope", () => {
    const html = renderToStaticMarkup(
      createElement(RefundConfirmation, { account: quote, cancel: () => undefined, confirm: () => undefined }),
    )
    expect(html).toContain('role="alertdialog" aria-modal="true"')
    for (const detail of [
      ACCOUNT,
      "$100.00",
      "ch_ownerfixture",
      "All Codium subscriptions and pending checkouts owned by this account will stop",
      "Codium access will end",
      "Cancel",
    ])
      expect(html).toContain(detail)
    const changed = renderToStaticMarkup(
      createElement(RefundConfirmation, {
        account: quote,
        changed: true,
        cancel: () => undefined,
        confirm: () => undefined,
      }),
    )
    expect(changed).toContain("refund details changed")
    expect(changed).toMatch(/<button[^>]*data-danger="true"[^>]*disabled=""/)
  })

  test("a verified zero refund can end subscriptions without promising a refund", () => {
    const zero = { ...quote, refundCents: 0, refundCharge: null }
    expect(refundRequest(zero)).toMatchObject({ expectedCharge: null, expectedRefundCents: 0 })
    const html = renderToStaticMarkup(
      createElement(RefundConfirmation, { account: zero, cancel: () => undefined, confirm: () => undefined }),
    )
    expect(html).toContain("No refund will be issued")
    expect(html).toContain("End all subscriptions")
    expect(html).not.toContain("Refund $0")
  })

  test("a refund request carries every quote fence and does not put account IDs or tokens in its URL", async () => {
    const calls: { input: string; init?: RequestInit }[] = []
    const body = refundRequest(quote)
    if (!body) throw new Error("Missing fixture quote")
    await mutateCodiumOwner("refund-end", "fixture-session-token", body, (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ input: String(input), init })
      return Response.json({ accepted: true })
    }) as typeof fetch)
    expect(calls[0]?.input).toBe("/api/owner/codium-refund-end")
    expect(calls[0]?.init).toMatchObject({ method: "POST", cache: "no-store", credentials: "omit" })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      account: ACCOUNT,
      expectedCharge: "ch_ownerfixture",
      expectedRefundCents: 10000,
      expectedSubscription: "sub_ownerfixture",
      expectedPeriodStart: NOW - 10 * DAY,
    })
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer fixture-session-token")
  })

  test.each([
    ["CODIUM_REFUND_PENDING", "still processing"],
    ["CODIUM_REFUND_FAILED", "did not complete"],
  ])("a %s refund keeps its distinct incomplete status", async (code, message) => {
    const error = await mutateCodiumOwner("refund-end", "fixture-session", { account: ACCOUNT }, (async (_input: RequestInfo | URL) =>
      Response.json({ error: { code } }, { status: 503 })) as typeof fetch).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(CodiumOwnerRequestError)
    expect(ownerGate(error)).toMatchObject({ kind: "failed", message: expect.stringContaining(message) })
  })

  test("stale refund and fresh-sign-in errors remain errors rather than accepted financial actions", async () => {
    await expect(
      mutateCodiumOwner("refund-end", "fixture-session", { account: ACCOUNT }, (async (_input: RequestInfo | URL) =>
        Response.json({ error: { code: "CODIUM_REFUND_CHANGED" } }, { status: 409 })) as typeof fetch),
    ).rejects.toMatchObject({ code: "CODIUM_REFUND_CHANGED" })
    await expect(
      mutateCodiumOwner("clear-risk", "fixture-session", { account: ACCOUNT }, (async (_input: RequestInfo | URL) =>
        Response.json({ error: { code: "RECENT_SIGN_IN_REQUIRED" } }, { status: 403 })) as typeof fetch),
    ).rejects.toMatchObject({ code: "RECENT_SIGN_IN_REQUIRED" })
    await expect(
      mutateCodiumOwner("reconcile", "fixture-session", { account: ACCOUNT }, (async (_input: RequestInfo | URL) =>
        Response.json({ accepted: false })) as typeof fetch),
    ).rejects.toMatchObject({ code: "OWNER_RESPONSE_INVALID" })
  })

  test("replay uses UTC Unix seconds and refuses future, old or malformed windows", () => {
    expect(replaySince("2026-10-27T12:00", NOW)).toBe((NOW - DAY) / 1000)
    for (const date of ["", "2026-02-31T12:00", "2026-10-29T12:00", "2026-09-01T12:00", "2026-10-27"])
      expect(() => replaySince(date, NOW)).toThrow("Choose a UTC time within the last 30 days")
  })
})

test("the private owner shell survives production pruning and is removed from the sitemap", async () => {
  const root = await mkdtemp(join(tmpdir(), "vector-owner-prune-"))
  try {
    const dist = join(root, "packages/web/dist")
    await mkdir(join(root, "script"), { recursive: true })
    await mkdir(join(dist, "owner/codium"), { recursive: true })
    await Bun.write(join(dist, "index.html"), "<html>Home</html>")
    await Bun.write(
      join(dist, "owner/codium/index.html"),
      '<html><head><meta name="robots" content="noindex, nofollow"></head><body>Checking your session</body></html>',
    )
    await Bun.write(
      join(dist, "sitemap-0.xml"),
      "<urlset><url><loc>https://vectordev.ai/</loc></url><url><loc>https://vectordev.ai/owner/codium/</loc></url></urlset>",
    )
    await cp(
      new URL("../../../../../../script/prune-vector-site.mjs", import.meta.url),
      join(root, "script/prune-vector-site.mjs"),
    )
    const child = Bun.spawn(["node", join(root, "script/prune-vector-site.mjs")], { stdout: "pipe", stderr: "pipe" })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, stdout, stderr }).toMatchObject({ status: 0 })
    expect(await Bun.file(join(dist, "owner/codium/index.html")).exists()).toBe(true)
    const sitemap = await Bun.file(join(dist, "sitemap-0.xml")).text()
    expect(sitemap).not.toContain("/owner/codium")
    expect(sitemap).toContain("https://vectordev.ai/</loc>")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
