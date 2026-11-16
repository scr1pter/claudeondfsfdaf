import { describe, expect, test } from "bun:test"
import type { Computer } from "@vectordevai/schema/computer"
import { createFakeComputer, type FakeComputerScript } from "./fake-platform"
import { ComputerMentionLookup } from "./mention-lookup"

type App = Awaited<ReturnType<Computer.ComputerPlatform["apps"]>>[number]

const numbers: App = { key: "app:macos:com.apple.iwork.numbers", name: "Numbers", running: true }
const notes: App = { key: "app:macos:com.apple.notes", name: "Notes", running: false }
const excel: App = {
  key: "app:macos:com.microsoft.excel@UBF8T346G9",
  name: "Excel",
  running: false,
  rule: "company-deny",
}
const terminal: App = { key: "app:macos:com.apple.terminal", name: "Terminal", running: true, rule: "never" }

/** Manual timers: a test decides when the 150 ms pause ends. */
function clock() {
  const pending = new Map<number, { run: () => void; ms: number }>()
  let next = 0
  return {
    pending,
    timers: {
      set: (run: () => void, ms: number) => {
        pending.set(++next, { run, ms })
        return next
      },
      clear: (handle: unknown) => {
        pending.delete(handle as number)
      },
    },
    fire() {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, timer] of due) timer.run()
    },
  }
}

/** The real fake platform; each apps() answer waits until the test settles it, so answers can arrive out of order. */
function platform(
  script: FakeComputerScript = { prefs: { enabled: true, consentedAt: 1 }, apps: [numbers, notes, excel, terminal] },
) {
  const fake = createFakeComputer(script)
  const reads = { prefs: 0, status: 0, state: 0, permissions: 0, recheck: 0 }
  const answers: { query?: string; resolve: () => void; reject: (error: Error) => void }[] = []
  const computer: Computer.ComputerPlatform = {
    ...fake,
    supported: fake.supported,
    prefs: () => (reads.prefs++, fake.prefs()),
    status: () => (reads.status++, fake.status()),
    state: () => (reads.state++, fake.state()),
    permissions: () => (reads.permissions++, fake.permissions()),
    recheck: () => (reads.recheck++, fake.recheck()),
    apps: (query) =>
      new Promise((resolve, reject) => {
        answers.push({ query, resolve: () => void fake.apps(query).then(resolve), reject })
      }),
  }
  return { computer, reads, answers }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function lookup(local = platform()) {
  const time = clock()
  const published: ComputerMentionLookup.State[] = []
  const instance = ComputerMentionLookup.create({
    computer: local.computer,
    publish: (state) => published.push(state),
    timers: time.timers,
  })
  return { instance, time, published, local }
}

describe("computer mention lookup", () => {
  test("opening reads readiness at once without a permission probe; a bare @ looks up no apps", async () => {
    const { instance, time, local } = lookup()
    expect(instance.state.readiness).toBeUndefined()
    instance.open()
    instance.query("")
    await settle()
    expect(instance.state.readiness).toMatchObject({ ready: true })
    expect(local.reads).toEqual({ prefs: 1, status: 1, state: 1, permissions: 0, recheck: 0 })
    expect(time.pending.size).toBe(0)
    expect(local.answers).toEqual([])
    expect(instance.state.apps).toEqual([])
  })

  test("a burst of keystrokes waits 150 ms and makes one apps() call for the last query", async () => {
    const { instance, time, local } = lookup()
    instance.open()
    for (const query of ["N", "Nu", "Num"]) instance.query(query)
    expect(time.pending.size).toBe(1)
    expect([...time.pending.values()][0].ms).toBe(ComputerMentionLookup.DELAY)
    time.fire()
    expect(local.answers.map((answer) => answer.query)).toEqual(["Num"])
    local.answers[0].resolve()
    await settle()
    expect(instance.state.apps.map((app) => app.name)).toEqual(["Numbers"])
    expect(local.reads.permissions).toBe(0)
  })

  test("the newest query wins even when an older answer arrives last", async () => {
    const { instance, time, local } = lookup()
    instance.open()
    instance.query("N")
    time.fire()
    instance.query("Not")
    time.fire()
    expect(local.answers.map((answer) => answer.query)).toEqual(["N", "Not"])
    local.answers[1].resolve()
    await settle()
    expect(instance.state.apps.map((app) => app.name)).toEqual(["Notes"])
    local.answers[0].resolve()
    await settle()
    expect(instance.state.apps.map((app) => app.name)).toEqual(["Notes"])
  })

  test("never-listed apps stay hidden and company-denied apps stay disabled", async () => {
    const { instance, time, local } = lookup()
    instance.open()
    instance.query("e")
    time.fire()
    local.answers[0].resolve()
    await settle()
    expect(instance.state.apps.map((app) => [app.name, app.disabled])).toEqual([
      ["Numbers", undefined],
      ["Notes", undefined],
      ["Excel", "computer.mention.companyDenied"],
    ])
    expect(instance.state.apps.some((app) => app.name === "Terminal")).toBe(false)
  })

  test("answers after the popover closes are dropped, and closing clears stored apps", async () => {
    const { instance, time, local } = lookup()
    instance.open()
    instance.query("Num")
    time.fire()
    local.answers[0].resolve()
    await settle()
    expect(instance.state.apps).toHaveLength(1)
    instance.query("Not")
    time.fire()
    instance.close()
    expect(instance.state.apps).toEqual([])
    local.answers[1].resolve()
    await settle()
    expect(instance.state.apps).toEqual([])
    // A pending pause is cancelled too.
    instance.open()
    instance.query("Num")
    instance.close()
    expect(time.pending.size).toBe(0)
  })

  test("a reopened popover shows no apps from its last opening and keeps the last readiness while it rereads", async () => {
    const { instance, time, local } = lookup()
    instance.open()
    instance.query("Num")
    time.fire()
    local.answers[0].resolve()
    await settle()
    instance.close()
    instance.open()
    expect(instance.state.apps).toEqual([])
    expect(instance.state.readiness).toMatchObject({ ready: true })
    await settle()
    expect(local.reads.prefs).toBe(2)
  })

  test("answers after disposal are dropped and publish nothing", async () => {
    const { instance, time, local, published } = lookup()
    instance.open()
    instance.query("Num")
    time.fire()
    instance.dispose()
    const count = published.length
    local.answers[0].resolve()
    await settle()
    expect(published).toHaveLength(count)
    instance.query("Not")
    expect(time.pending.size).toBe(0)
    expect(await instance.refresh()).toEqual({ ready: false })
  })

  test("a failed lookup clears the app rows without crashing and keeps readiness", async () => {
    const { instance, time, local } = lookup()
    instance.open()
    instance.query("Num")
    time.fire()
    local.answers[0].resolve()
    await settle()
    instance.query("Nu")
    time.fire()
    local.answers[1].reject(new Error("ipc"))
    await settle()
    expect(instance.state.apps).toEqual([])
    expect(instance.state.readiness).toMatchObject({ ready: true })
  })

  test("a not-set-up platform still lists apps, and the row reads as not ready", async () => {
    const { instance, time, local } = lookup(platform({ apps: [numbers] }))
    instance.open()
    instance.query("Num")
    time.fire()
    local.answers[0].resolve()
    await settle()
    expect(instance.state.readiness).toMatchObject({ ready: false })
    expect(instance.state.apps.map((app) => app.name)).toEqual(["Numbers"])
  })

  test("company off disables every app row", async () => {
    const { instance, time, local } = lookup(
      platform({ prefs: { enabled: true, consentedAt: 1 }, policy: { enabled: false }, apps: [numbers] }),
    )
    instance.open()
    instance.query("Num")
    time.fire()
    local.answers[0].resolve()
    await settle()
    expect(instance.state.readiness).toMatchObject({ ready: false, blocked: "computer.availability.company" })
    expect(instance.state.apps.map((app) => app.disabled)).toEqual(["computer.mention.companyDenied"])
  })

  test("an answer that changes nothing the rows show publishes nothing, so the list keeps its selection", async () => {
    const { instance, time, local, published } = lookup()
    instance.open()
    await settle()
    expect(published).toHaveLength(1)
    // No app matches: an empty list replacing an empty list is no change.
    instance.query("Zzz")
    time.fire()
    local.answers[0].resolve()
    await settle()
    expect(published).toHaveLength(1)
    instance.query("Num")
    time.fire()
    local.answers[1].resolve()
    await settle()
    expect(published).toHaveLength(2)
    // A longer query with the same answer, and a reopening whose readiness read is unchanged, publish nothing.
    instance.query("Numb")
    time.fire()
    local.answers[2].resolve()
    await settle()
    expect(published).toHaveLength(2)
    instance.close()
    expect(published).toHaveLength(3)
    instance.open()
    await settle()
    expect(local.reads.prefs).toBe(2)
    expect(published).toHaveLength(3)
    expect(published.at(-1)).toMatchObject({ apps: [], readiness: { ready: true } })
  })
})
