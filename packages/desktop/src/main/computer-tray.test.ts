import { describe, expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { computerTrayItems, computerTrayState } from "./computer-tray"

const base: Computer.ComputerState = {
  phase: "working",
  backend: "local-macos",
  mode: "foreground",
  holder: { sessionID: "ses_a", directory: "/virtual/a", title: "Receipts", startedAt: 1, actions: 3 },
  apps: [
    { key: "app:macos:com.apple.calculator", name: "Calculator" },
    { key: "app:macos:com.apple.iwork.numbers", name: "Numbers" },
  ],
  step: "Clicking “Save” in Numbers",
  queue: [],
  escStops: true,
  stopChord: Hands.STOP_CHORD.darwin,
  lease: 1,
  reduceMotion: false,
}

describe("computerTrayItems", () => {
  test("a working foreground run reads Working in the app, then Take over and Stop", () => {
    expect(computerTrayItems(computerTrayState(base))).toEqual({
      tooltip: `Vector — ${Hands.BANNER}`,
      items: [
        { label: "Working in Numbers", enabled: false },
        { label: "Take over", enabled: true, command: "takeover" },
        { label: `Stop ${Hands.NAME}`, enabled: true, command: "stop" },
      ],
    })
  })

  test("a paused run offers Resume instead of Take over", () => {
    const view = computerTrayItems({ phase: "paused", app: "Numbers", mode: "foreground" })
    expect(view?.items.map((item) => item.command)).toEqual([undefined, "resume", "stop"])
  })

  test("background, asks and handoffs offer only Stop beside the status line", () => {
    for (const state of [
      { phase: "working", mode: "background" },
      { phase: "asking", mode: "foreground" },
      { phase: "handoff", mode: "foreground" },
    ] as const)
      expect(computerTrayItems({ ...state, app: "Numbers" })?.items.map((item) => item.label)).toEqual([
        "Working in Numbers",
        `Stop ${Hands.NAME}`,
      ])
  })

  test("without a verified app the status line says Working", () => {
    expect(computerTrayItems(computerTrayState({ ...base, apps: [] }))?.items[0]).toEqual({
      label: "Working",
      enabled: false,
    })
  })

  test("idle, ended and absent states leave the tray as it was", () => {
    for (const phase of ["off", "setup", "ready", "done", "stopped"] as const)
      expect(computerTrayItems({ phase, app: "Numbers" })).toBeUndefined()
    expect(computerTrayItems(undefined)).toBeUndefined()
  })

  test("the step line and the holder's title never reach the tray", () => {
    const view = JSON.stringify(computerTrayItems(computerTrayState({ ...base, step: "Typing “secret”" })))
    expect(view).not.toContain("secret")
    expect(view).not.toContain("Receipts")
    expect(view).not.toContain("Save")
  })
})
