import { describe, expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { createComputerNotify, type ComputerNotification, type ComputerNotifyTarget } from "./computer-notify"

const A = { sessionID: "ses_a", directory: "/virtual/a" }
const B = { sessionID: "ses_b", directory: "/virtual/b" }
const idle: Computer.ComputerState = {
  phase: "ready",
  backend: "local-macos",
  mode: "foreground",
  apps: [],
  queue: [],
  escStops: false,
  stopChord: Hands.STOP_CHORD.darwin,
  lease: 0,
  reduceMotion: false,
}

function working(target = A, extra: Partial<Computer.ComputerState> = {}, startedAt = 1): Computer.ComputerState {
  return {
    ...idle,
    phase: "working",
    lease: 1,
    escStops: true,
    holder: { ...target, title: "A title the model wrote", startedAt, actions: 0 },
    apps: [{ key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }],
    step: "Typing in Numbers",
    ...extra,
  }
}

function fixture(options: { enabled?: boolean; focused?: boolean } = {}) {
  const clock = { now: 1_000 }
  const flags = { enabled: options.enabled ?? true, focused: options.focused ?? false }
  const shown: (ComputerNotification & { click(): void })[] = []
  const opened: ComputerNotifyTarget[] = []
  const fronts: number[] = []
  const notify = createComputerNotify({
    show: (message, onClick) => shown.push({ ...message, click: onClick }),
    enabled: () => flags.enabled,
    focused: () => flags.focused,
    open: (target) => opened.push(target),
    front: () => fronts.push(clock.now),
    now: () => clock.now,
  })
  return { notify, clock, flags, shown, opened, fronts, bodies: () => shown.map((item) => item.body) }
}

describe("computer notifications (INV-T6)", () => {
  test("the start notification is throttled to one per conversation per 5 minutes", () => {
    const f = fixture()
    f.notify.state(working(A))
    f.notify.state(working(A, { holder: { ...A, title: "x", startedAt: 1, actions: 4 } }))
    expect(f.bodies()).toEqual([`${Hands.BANNER}. Press Esc or Stop to stop it.`])
    expect(f.shown[0]!.title).toBe(Hands.NAME)
    // The same conversation starts a new run within 5 minutes: no second start notification.
    f.notify.state({ ...idle, phase: "done" })
    f.clock.now += 4 * 60_000
    f.notify.state(working(A, {}, 2))
    expect(f.bodies().filter((body) => body.includes("Press Esc"))).toHaveLength(1)
    // Another conversation is not throttled by the first.
    f.notify.state({ ...idle, phase: "done" })
    f.notify.state(working(B, {}, 3))
    expect(f.bodies().filter((body) => body.includes("Press Esc"))).toHaveLength(2)
    // Five minutes after the first start, the first conversation is told again.
    f.notify.state({ ...idle, phase: "done" })
    f.clock.now += 60_000
    f.notify.state(working(A, {}, 4))
    expect(f.bodies().filter((body) => body.includes("Press Esc"))).toHaveLength(3)
  })

  test("needs you is sent once per ask, only while Vector is not focused", () => {
    const f = fixture({ focused: true })
    f.notify.state(working(A))
    const ask = {
      requestID: "per_1",
      directory: A.directory,
      kind: "app" as const,
      title: `Allow ${Hands.NAME} to use Numbers?`,
      canAlways: false,
      shownAt: 1,
    }
    f.notify.state(working(A, { phase: "asking", ask }))
    expect(f.shown.map((item) => item.title)).not.toContain(`${Hands.NAME} needs you`)
    f.flags.focused = false
    // The same ask republished is not a new ask.
    f.notify.state(working(A, { phase: "asking", ask }))
    expect(f.shown.map((item) => item.title)).not.toContain(`${Hands.NAME} needs you`)
    f.notify.state(
      working(A, { phase: "handoff", ask: { ...ask, requestID: "que_2", kind: "handoff", title: "Your turn" } }),
    )
    f.notify.state(
      working(A, { phase: "handoff", ask: { ...ask, requestID: "que_2", kind: "handoff", title: "Your turn" } }),
    )
    const needs = f.shown.filter((item) => item.title === `${Hands.NAME} needs you`)
    expect(needs.map((item) => item.body)).toEqual(["Your turn"])
    needs[0]!.click()
    expect(f.opened).toEqual([A])
  })

  test("check-ins leave the single needs-you notification to the renderer", () => {
    const f = fixture()
    f.notify.state(working(A))
    const ask = {
      requestID: "que_check_in",
      directory: A.directory,
      kind: "check_in" as const,
      title: "Keep going?",
      canAlways: false,
      shownAt: 1,
    }
    for (const phase of ["asking", "handoff", "paused"] as const) f.notify.state(working(A, { phase, ask }))
    expect(f.shown.map((item) => item.title)).toEqual([Hands.NAME])
    // A later app ask is still desktop main's responsibility.
    f.notify.state(working(A, { phase: "asking", ask: { ...ask, requestID: "per_app", kind: "app" } }))
    expect(f.shown.map((item) => item.title)).toEqual([Hands.NAME, `${Hands.NAME} needs you`])
  })

  test("the three end texts: finished with its count and apps, stopped, and couldn't finish", () => {
    const f = fixture()
    f.notify.state(working(A))
    f.notify.state(
      working(A, {
        holder: { ...A, title: "x", startedAt: 1, actions: 23 },
        apps: [
          { key: "app:macos:com.apple.iwork.numbers", name: "Numbers" },
          { key: "app:macos:com.apple.calculator", name: "Calculator" },
        ],
      }),
    )
    f.notify.state({ ...idle, phase: "done" })
    f.notify.state(working(A, {}, 2))
    f.notify.state({ ...idle, phase: "stopped" })
    f.notify.state(working(A, {}, 3))
    f.notify.fail(A, "error")
    f.notify.state({ ...idle, phase: "stopped" })
    // An engine disconnect returns straight to idle, without the Done or Stopped flash.
    f.notify.state(working(A, {}, 4))
    f.notify.state(idle)
    expect(f.bodies().filter((body) => !body.includes("Press Esc"))).toEqual([
      `${Hands.NAME} finished. 23 actions in Numbers and Calculator.`,
      `${Hands.NAME} stopped.`,
      `${Hands.NAME} couldn't finish: the conversation ended with an error`,
      `${Hands.NAME} couldn't finish: Vector's engine stopped`,
    ])
    // A failure recorded for another conversation does not change this one's end.
    f.notify.state(working(A, {}, 5))
    f.notify.fail(B, "error")
    f.notify.state({ ...idle, phase: "stopped" })
    expect(f.bodies().at(-1)).toBe(`${Hands.NAME} stopped.`)
    // Clicking an end notification opens the conversation the run belonged to.
    f.shown.at(-1)!.click()
    expect(f.opened).toEqual([A])
  })

  test("a foreground run brings Vector back at the end; a background run does not", () => {
    const f = fixture()
    f.notify.state(working(A))
    f.notify.state({ ...idle, phase: "done" })
    expect(f.fronts).toHaveLength(1)
    f.notify.state(working(A, { mode: "background" }, 2))
    f.notify.state({ ...idle, phase: "done" })
    f.notify.state(working(A, {}, 3))
    f.notify.state(idle)
    expect(f.fronts).toHaveLength(1)
  })

  test("nothing is sent while notify is off, and closing stops every notification", () => {
    const f = fixture({ enabled: false })
    f.notify.state(working(A))
    f.notify.state(
      working(A, {
        phase: "asking",
        ask: { requestID: "per_1", directory: A.directory, kind: "app", title: "Allow?", canAlways: false, shownAt: 1 },
      }),
    )
    f.notify.state({ ...idle, phase: "done" })
    expect(f.shown).toEqual([])
    f.flags.enabled = true
    f.notify.close()
    f.notify.state(working(B))
    f.notify.state({ ...idle, phase: "done" })
    expect(f.shown).toEqual([])
  })

  test("session titles, step lines and model text never appear in a notification", () => {
    const f = fixture()
    f.notify.state(working(A))
    f.notify.state(
      working(A, {
        phase: "asking",
        ask: {
          requestID: "per_1",
          directory: A.directory,
          kind: "app",
          title: "Allow?",
          detail: "The agent says hi",
          canAlways: false,
          shownAt: 1,
        },
      }),
    )
    f.notify.state({ ...idle, phase: "done" })
    const text = JSON.stringify(f.shown)
    expect(text).not.toContain("A title the model wrote")
    expect(text).not.toContain("Typing in Numbers")
    expect(text).not.toContain("The agent says")
  })
})
