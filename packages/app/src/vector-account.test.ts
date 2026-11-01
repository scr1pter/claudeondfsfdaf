import { expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import {
  PURCHASE_REFRESH_MS,
  SUBSCRIBED_FOR_MS,
  accountChip,
  codiumChanged,
  codiumSubscribed,
  newestRead,
  onCodiumChange,
  refreshAfterPurchase,
  runBilling,
  type VectorBillingRequest,
  type VectorBillingResult,
} from "./vector-account"

const photo = "data:image/png;base64,iVBORw0KGgo="
const signedIn = { authenticated: true, pending: false, email: "ana@example.test", name: "Ana Diaz" }
// The Codium status as the desktop reads it from vectordev.ai.
const codium = (plan?: string) =>
  ModelPlanStatus.fromRemote({
    enabled: true,
    access: true,
    plan: plan
      ? { id: plan, name: "Answered by the site", renewsAt: 1_790_000_000_000, cancelAtPeriodEnd: false }
      : undefined,
    purchased: { bought: false },
    empty: false,
    low: false,
  })

test("the account chip shows the photo beside the name when the desktop has one", () => {
  expect(
    accountChip({ authenticated: true, pending: false, email: "ada@example.test", name: "Ada", avatar: photo }),
  ).toEqual({ label: "Ada", name: "Ada", plan: undefined, initial: "A", photo })
})

test("without a photo the chip falls back to the first letter, of the email when there is no name", () => {
  expect(accountChip({ authenticated: true, pending: false, email: "ada@example.test", name: "Ada" })).toMatchObject({
    label: "Ada",
    initial: "A",
    photo: undefined,
  })
  expect(accountChip({ authenticated: true, pending: false, email: "ada@example.test" })).toMatchObject({
    label: "ada@example.test",
    name: "ada@example.test",
    initial: "a",
    photo: undefined,
  })
  expect(accountChip({ authenticated: false, pending: false })).toMatchObject({
    label: "",
    initial: "",
    photo: undefined,
  })
})

test("the chip shows the first name, keeping the whole name for the button's accessible name", () => {
  expect(accountChip(signedIn)).toMatchObject({ label: "Ana", name: "Ana Diaz", initial: "A" })
  expect(accountChip({ ...signedIn, name: "  Ana   Maria Diaz " })).toMatchObject({
    label: "Ana",
    name: "Ana   Maria Diaz",
  })
})

test("beside the name the chip says Free without a Codium plan, else the plan's name", () => {
  expect(accountChip(signedIn, codium()).plan).toBe("Free")
  expect(
    ["vector-10", "vector-50", "vector-100", "vector-200"].map((plan) => accountChip(signedIn, codium(plan)).plan),
  ).toEqual(["Plus", "Pro", "Max", "Ultra"])
  // Nothing until the plan is read, and nothing when it could not be, rather than a Free that may be wrong.
  expect(accountChip(signedIn).plan).toBeUndefined()
  expect(
    accountChip(signedIn, { ...codium("vector-50"), error: "Vector could not load your Codium balance." }).plan,
  ).toBeUndefined()
  expect(accountChip(signedIn, { ...codium(), signedIn: false }).plan).toBeUndefined()
})

test("a billing window tells every screen showing the plan to read it again", () => {
  const reads: string[] = []
  const stop = onCodiumChange(() => reads.push("chip"))
  codiumChanged()
  stop()
  codiumChanged()
  expect(reads).toEqual(["chip"])
})

test("a purchase reads the plan and models again at 5, 20 and 60 s, and a newer purchase restarts that", async () => {
  // A controllable clock: each wait is kept until the test lets it pass.
  const waits: { ms: number; pass: () => void }[] = []
  const wait = (ms: number) => new Promise<void>((resolve) => waits.push({ ms, pass: resolve }))
  const settle = async () => {
    for (const _ of [1, 2, 3, 4, 5]) await Promise.resolve()
  }
  const next = async () => {
    waits.shift()!.pass()
    await settle()
  }
  const events: string[] = []
  const models = async () => {
    events.push("models")
  }
  const stop = onCodiumChange(() => events.push("read"))

  expect(PURCHASE_REFRESH_MS).toEqual([5_000, 20_000, 60_000])
  // Nothing holds the schedule but the module, so closing the dialog that started it does not stop it.
  const first = refreshAfterPurchase({ wait, models })
  await Promise.resolve()
  expect(waits.map((item) => item.ms)).toEqual([5_000])
  await next()
  // The local server reads the models from vectordev.ai before every screen reads them from it.
  expect(events).toEqual(["models", "read"])
  expect(waits.map((item) => item.ms)).toEqual([15_000])
  // A second purchase before the 20 s read: the first schedule stops and the new one starts from 5 s.
  const second = refreshAfterPurchase({ wait, models })
  await Promise.resolve()
  await next()
  await first
  expect(events).toEqual(["models", "read"])
  for (const ms of [5_000, 15_000, 40_000]) {
    expect(waits.map((item) => item.ms)).toEqual([ms])
    await next()
  }
  await second
  expect(events).toEqual(["models", "read", "models", "read", "models", "read", "models", "read"])
  expect(waits).toEqual([])
  stop()
})

test("a failed models read still announces, and one a newer purchase overtook announces nothing", async () => {
  const waits: (() => void)[] = []
  const wait = () => new Promise<void>((resolve) => waits.push(resolve))
  const settle = async () => {
    for (const _ of [1, 2, 3, 4, 5]) await Promise.resolve()
  }
  const reads: string[] = []
  const stop = onCodiumChange(() => reads.push("read"))
  const failing = refreshAfterPurchase({ wait, models: () => Promise.reject(new Error("local server stopped")) })
  await settle()
  waits.shift()!()
  await settle()
  expect(reads).toEqual(["read"])

  // The next purchase's 5 s models read is still under way when a newer purchase lands: the newer schedule announces.
  const slow = Promise.withResolvers<void>()
  const overtaken = refreshAfterPurchase({ wait, models: () => slow.promise })
  await settle()
  // Passing the first schedule's 20 s wait ends it, since a newer purchase started; the second reaches its models read.
  waits.splice(0).forEach((pass) => pass())
  await Promise.all([failing, settle()])
  const newer = refreshAfterPurchase({ wait, models: async () => {} })
  slow.resolve()
  await settle()
  expect(reads).toEqual(["read"])
  await overtaken
  for (const _ of [1, 2, 3]) {
    await settle()
    waits.shift()!()
  }
  await newer
  expect(reads).toEqual(["read", "read", "read", "read"])
  stop()
})

// The desktop's account bridge, one object for the app's whole life: it reads the plan of whoever is signed in now.
const bridge = (plans: Record<string, string | undefined>) => {
  const reads: string[] = []
  const desktop = {
    reads,
    // Who is signed in now, if anyone.
    email: "ana@example.test" as string | undefined,
    status: async () =>
      desktop.email ? { ...signedIn, email: desktop.email } : { authenticated: false, pending: false },
    codium: async () => {
      const plan = desktop.email ? plans[desktop.email] : undefined
      reads.push(plan ?? "none")
      return codium(plan)
    },
  }
  return desktop
}

test("every failed turn's card shares one read of whether the account has a plan", async () => {
  codiumChanged()
  const pro = bridge({ "ana@example.test": "vector-50" })
  const now = 1_000_000
  // Many cards mounting at once, or again as the timeline scrolls, ask vectordev.ai once.
  expect(await Promise.all([codiumSubscribed(pro, now), codiumSubscribed(pro, now + 10)])).toEqual([true, true])
  expect(await codiumSubscribed(pro, now + SUBSCRIBED_FOR_MS - 1)).toBe(true)
  expect(pro.reads).toEqual(["vector-50"])
  // A minute on, and after a billing window or Refresh (codiumChanged), the next card reads again.
  expect(await codiumSubscribed(pro, now + SUBSCRIBED_FOR_MS)).toBe(true)
  codiumChanged()
  expect(await codiumSubscribed(pro, now + SUBSCRIBED_FOR_MS + 1)).toBe(true)
  expect(pro.reads).toEqual(["vector-50", "vector-50", "vector-50"])
  // A platform without the desktop's reader answers no plan.
  expect(await codiumSubscribed({ status: pro.status })).toBe(false)
  expect(await codiumSubscribed(undefined)).toBe(false)
})

test("the shared answer belongs to the account signed in: signing out, or in as someone else, reads again", async () => {
  codiumChanged()
  const desktop = bridge({ "ana@example.test": "vector-50", "ben@example.test": undefined })
  const now = 2_000_000
  expect(await codiumSubscribed(desktop, now)).toBe(true)
  // Ana signs out and Ben, who has no plan, signs in on the same bridge within the minute.
  desktop.email = undefined
  expect(await codiumSubscribed(desktop, now + 1)).toBe(false)
  desktop.email = "ben@example.test"
  expect(await codiumSubscribed(desktop, now + 2)).toBe(false)
  expect(await codiumSubscribed(desktop, now + 3)).toBe(false)
  desktop.email = "ana@example.test"
  expect(await codiumSubscribed(desktop, now + 4)).toBe(true)
  expect(desktop.reads).toEqual(["vector-50", "none", "none", "vector-50"])
})

test("a failed read answers no plan for the cards waiting on it, and the next card asks again", async () => {
  codiumChanged()
  const desktop = bridge({ "ana@example.test": "vector-50" })
  const failures = [
    () => Promise.reject(new Error("offline")),
    // The desktop's reader answers a failed read as a status with an error and no plan.
    async () => ({ ...codium(), signedIn: true, error: "Vector could not load your Codium usage. Try again shortly." }),
  ]
  const now = 3_000_000
  for (const [index, failure] of failures.entries()) {
    const read = desktop.codium
    desktop.codium = failure
    expect(await Promise.all([codiumSubscribed(desktop, now + index), codiumSubscribed(desktop, now + index)])).toEqual(
      [false, false],
    )
    desktop.codium = read
    expect(await codiumSubscribed(desktop, now + index + 1)).toBe(true)
    codiumChanged()
  }
  expect(desktop.reads).toEqual(["vector-50", "vector-50"])
})

test("overlapping plan reads after a purchase show the newest answer, never an older one that answered last", async () => {
  // The desktop's status reads, each answered when the test says: the first started as the window closed, before
  // Stripe's notification, and the second at the 5 s read, after it.
  const pending: PromiseWithResolvers<ModelPlanStatus.Status>[] = []
  const desktop = {
    codium: () => {
      const answer = Promise.withResolvers<ModelPlanStatus.Status>()
      pending.push(answer)
      return answer.promise
    },
  }
  // A page showing the plan, as Settings Account and Usage and the plans dialog read it on codiumChanged().
  const shown: (string | undefined)[] = []
  const reads = newestRead()
  const refresh = async () => {
    const newest = reads()
    const status = await desktop.codium()
    if (newest()) shown.push(status.plan?.id)
  }
  const stop = onCodiumChange(() => void refresh())
  codiumChanged()
  codiumChanged()
  pending[1]!.resolve(codium("vector-50"))
  pending[0]!.resolve(codium())
  await Promise.all(pending.map((item) => item.promise))
  await Promise.resolve()
  expect(shown).toEqual(["vector-50"])
  // The next read answers as usual.
  codiumChanged()
  pending[2]!.resolve(codium("vector-50"))
  await pending[2]!.promise
  await Promise.resolve()
  expect(shown).toEqual(["vector-50", "vector-50"])
  stop()
})

test("a billing request reads the plan and models again later when it finished, or closed a payment to confirm", async () => {
  const run = async (
    result: VectorBillingResult | Error,
    request: VectorBillingRequest = { kind: "portal", flow: "payment_method_update" },
    paying?: boolean,
  ) => {
    const waits: number[] = []
    const answer = await runBilling(
      {
        billing: async () => {
          if (result instanceof Error) throw result
          return result
        },
      },
      request,
      { paying, wait: (ms) => new Promise<void>(() => void waits.push(ms)) },
    )
    for (const _ of [1, 2, 3]) await Promise.resolve()
    return { answer, waits }
  }
  for (const request of [
    { kind: "checkout", plan: "vector-10" },
    { kind: "change", plan: "vector-100" },
    { kind: "portal", flow: "payment_method_update" },
  ] as const)
    expect((await run({ outcome: "completed" }, request)).waits).toEqual([5_000])
  // The portal's home ends as closed: only the one opened to confirm a payment reads again later.
  expect((await run({ outcome: "closed" }, { kind: "portal" }, true)).waits).toEqual([5_000])
  expect((await run({ outcome: "closed" }, { kind: "portal" })).waits).toEqual([])
  for (const outcome of ["cancelled", "website", "busy", "kept"] as const)
    expect((await run({ outcome })).waits).toEqual([])
  expect((await run({ outcome: "failed", message: "Offline." }, { kind: "portal" }, true)).waits).toEqual([])
  // A request that throws, and a platform that cannot bill, read as failed.
  expect(await run(new Error("IPC closed"))).toEqual({
    answer: { outcome: "failed", message: "Vector could not open billing. Try again." },
    waits: [],
  })
  expect(await runBilling({}, { kind: "portal" })).toEqual({
    outcome: "failed",
    message: "Vector could not open billing. Try again.",
  })
})

test("the chip never loads a URL or a non-raster image, whatever the status carries", () => {
  for (const avatar of [
    "https://lh3.googleusercontent.com/a/photo",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,PGh0bWw+",
    `${photo}"><script>`,
    "",
  ])
    expect(accountChip({ authenticated: true, pending: false, name: "Ada", avatar }).photo).toBeUndefined()
})
