import { describe, expect, test } from "bun:test"
import type { Computer } from "@vectordevai/schema/computer"
import type { Message, Part } from "@vectordevai/sdk/v2"
import { cardModel, holderRun, latestShot, workingLine, type CardModel } from "./computer-card-model"

const ROOT = "ses_root"
const OTHER = "ses_other"
const numbers = { key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }
const calculator = { key: "app:macos:com.apple.calculator", name: "Calculator" }

function state(patch: Partial<Computer.ComputerState> = {}): Computer.ComputerState {
  return {
    phase: "working",
    backend: "local-macos",
    mode: "foreground",
    holder: { sessionID: ROOT, directory: "/repo", title: "Receipts", startedAt: 1000, actions: 12 },
    apps: [calculator, numbers],
    step: "Clicking “Save” in Numbers",
    queue: [],
    escStops: true,
    stopChord: "⌘⇧Esc",
    lease: 3,
    reduceMotion: false,
    ...patch,
  }
}

describe("cardModel", () => {
  test("each holder phase has its status; off, setup and ready have no card", () => {
    const expected: [Computer.ComputerPhase, CardModel["status"] | undefined][] = [
      ["working", "computer.status.working"],
      ["waiting", "computer.status.working"],
      ["asking", "computer.status.needsYou"],
      ["handoff", "computer.status.needsYou"],
      ["paused", "computer.status.paused"],
      ["done", "computer.status.done"],
      ["stopped", "computer.status.stopped"],
      ["off", undefined],
      ["setup", undefined],
      ["ready", undefined],
    ]
    for (const [phase, status] of expected) expect(cardModel(state({ phase }), ROOT)?.status).toBe(status)
  })

  test("the holder card carries the step, apps, start, action count and queue length", () => {
    const card = cardModel(state({ queue: [{ sessionID: OTHER, title: "Taxes" }] }), ROOT)
    expect(card).toMatchObject({
      kind: "holder",
      step: "Clicking “Save” in Numbers",
      apps: [calculator, numbers],
      startedAt: 1000,
      actions: 12,
      waiting: 1,
      holder: { sessionID: ROOT, directory: "/repo" },
    })
  })

  test("another family's run has no card", () => {
    expect(cardModel(state(), OTHER)).toBeUndefined()
    expect(cardModel(state(), undefined)).toBeUndefined()
    expect(cardModel(undefined, ROOT)).toBeUndefined()
    expect(cardModel(state({ holder: undefined }), ROOT)).toBeUndefined()
  })

  test("a queued conversation's card names the holder and offers its own stop", () => {
    const card = cardModel(state({ queue: [{ sessionID: OTHER, title: "Taxes" }] }), OTHER)
    expect(card).toEqual({
      kind: "queued",
      status: "computer.tasks.waiting",
      title: "Receipts",
      holder: { sessionID: ROOT, directory: "/repo" },
      dot: false,
      stop: true,
    })
    const orphan = cardModel(state({ holder: undefined, queue: [{ sessionID: OTHER, title: "Taxes" }] }), OTHER)
    expect(orphan).toMatchObject({ kind: "queued", status: "computer.working.waiting", title: undefined })
  })

  test("Take over only in the foreground working phase; Resume only when paused", () => {
    const flags = (patch: Partial<Computer.ComputerState>) => {
      const card = cardModel(state(patch), ROOT)
      return card?.kind === "holder" ? { takeOver: card.takeOver, resume: card.resume } : undefined
    }
    expect(flags({})).toEqual({ takeOver: true, resume: false })
    expect(flags({ mode: "background" })).toEqual({ takeOver: false, resume: false })
    expect(flags({ phase: "asking" })).toEqual({ takeOver: false, resume: false })
    expect(flags({ phase: "waiting" })).toEqual({ takeOver: false, resume: false })
    expect(flags({ phase: "paused", pause: "input" })).toEqual({ takeOver: false, resume: true })
    expect(flags({ phase: "done" })).toEqual({ takeOver: false, resume: false })
  })

  test("a pointer wait offers Stop but never Resume, and every other pause reason offers both", () => {
    const pointer = cardModel(
      state({
        phase: "paused",
        pause: "pointer",
        ask: { requestID: "ptr_1", directory: "/repo", kind: "pointer", title: "", canAlways: false, shownAt: 5 },
      }),
      ROOT,
    )
    expect(pointer).toMatchObject({ kind: "holder", resume: false, stop: true, takeOver: false })
    const reasons: Computer.PauseReason[] = [
      "input",
      "button",
      "locked",
      "suspend",
      "away",
      "helper",
      "detection",
      "secure_input",
      "secure_desktop",
      "overlay",
    ]
    for (const pause of reasons)
      expect(cardModel(state({ phase: "paused", pause }), ROOT)).toMatchObject({ resume: true, stop: true })
  })

  test("the dot and Stop follow an active run; a finished run has neither", () => {
    for (const phase of ["working", "asking", "handoff", "paused", "waiting"] as const)
      expect(cardModel(state({ phase }), ROOT)).toMatchObject({ dot: true, stop: true })
    for (const phase of ["done", "stopped"] as const)
      expect(cardModel(state({ phase }), ROOT)).toMatchObject({ dot: false, stop: false })
  })

  test("each pause reason has its sentence, and secure typing names the app and explains", () => {
    const expected: [Computer.PauseReason, CardModel["status"]][] = [
      ["input", "computer.pause.control"],
      ["button", "computer.pause.control"],
      ["locked", "computer.pause.locked"],
      ["suspend", "computer.pause.locked"],
      ["away", "computer.checkIn.away"],
      ["helper", "computer.pause.helper"],
      ["detection", "computer.pause.inputDetection"],
      ["secure_desktop", "computer.pause.secureDesktop"],
      ["overlay", "computer.pause.overlay"],
      ["pointer", "computer.pointer.title"],
    ]
    for (const [reason, key] of expected) {
      const card = cardModel(state({ phase: "paused", pause: reason }), ROOT)
      expect(card?.kind === "holder" && card.pause).toEqual({ key })
    }
    const secure = cardModel(state({ phase: "paused", pause: "secure_input", secureInputHolder: "1Password" }), ROOT)
    expect(secure?.kind === "holder" && secure.pause).toEqual({
      key: "computer.pause.secureTyping",
      app: "1Password",
      detail: "computer.pause.secureTyping.description",
    })
    // A pause reason left over in another phase is not a pause.
    const working = cardModel(state({ phase: "working", pause: "input" }), ROOT)
    expect(working?.kind === "holder" && working.pause).toBeUndefined()
  })

  test("an ask passes through only while the run is active", () => {
    const ask = {
      requestID: "per_1",
      directory: "/repo",
      kind: "app" as const,
      title: "Allow Hands to use Numbers?",
      canAlways: true,
      shownAt: 5,
    }
    expect(cardModel(state({ phase: "asking", ask }), ROOT)).toMatchObject({ ask })
    const done = cardModel(state({ phase: "done", ask }), ROOT)
    expect(done?.kind === "holder" && done.ask).toBeUndefined()
  })
})

describe("workingLine", () => {
  test("the holder uses the app it is on now; a queued session waits; others have no line", () => {
    expect(workingLine(state(), ROOT)).toEqual({ key: "computer.working.app", params: { app: "Numbers" } })
    expect(workingLine(state({ phase: "paused", pause: "input" }), ROOT)?.key).toBe("computer.working.app")
    expect(workingLine(state({ queue: [{ sessionID: OTHER, title: "Taxes" }] }), OTHER)).toEqual({
      key: "computer.working.waiting",
    })
    expect(workingLine(state(), OTHER)).toBeUndefined()
    expect(workingLine(state({ phase: "done" }), ROOT)).toBeUndefined()
    expect(workingLine(state({ apps: [] }), ROOT)).toBeUndefined()
    expect(workingLine(undefined, ROOT)).toBeUndefined()
  })
})

describe("holderRun", () => {
  const user = (id: string) => ({ id, role: "user", sessionID: ROOT }) as unknown as Message
  const assistant = (id: string, parentID: string) =>
    ({ id, role: "assistant", parentID, sessionID: ROOT }) as unknown as Message
  const computer = (id: string, messageID: string, image?: string, removed?: boolean) =>
    ({
      id,
      messageID,
      sessionID: ROOT,
      type: "tool",
      tool: "computer",
      callID: id,
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "",
        metadata: { action: "click", ...(removed ? { screenshotRemoved: true } : {}) },
        time: { start: 1, end: 2 },
        ...(image ? { attachments: [{ id: `${id}-file`, type: "file", mime: "image/jpeg", url: image }] } : {}),
      },
    }) as unknown as Part
  const text = (id: string, messageID: string, body: string) =>
    ({ id, messageID, sessionID: ROOT, type: "text", text: body }) as unknown as Part
  const step = (id: string, messageID: string) =>
    ({ id, messageID, sessionID: ROOT, type: "step-start" }) as unknown as Part
  const keep = (part: Part) => part.type !== "step-start"

  test("a run that spans several provider steps keeps every step of the latest turn", () => {
    const parts: Record<string, Part[]> = {
      a0: [computer("old", "a0", "data:old")],
      a1: [step("s1", "a1"), text("t1", "a1", "Opening Numbers"), computer("c1", "a1", "data:one")],
      a2: [step("s2", "a2"), text("t2", "a2", "Typing"), computer("c2", "a2", "data:two")],
      a3: [step("s3", "a3"), computer("c3", "a3")],
    }
    const messages = [
      user("u0"),
      assistant("a0", "u0"),
      user("u1"),
      assistant("a1", "u1"),
      assistant("a2", "u1"),
      assistant("a3", "u1"),
    ]
    const run = holderRun({ messages, parts: (id) => parts[id] ?? [], keep, working: true })
    expect(run?.map((part) => part.id)).toEqual(["c1", "t2", "c2", "c3"])
    expect(latestShot(run)?.image?.url).toBe("data:two")
  })

  test("only the last run of the turn, and nothing without a run", () => {
    const parts: Record<string, Part[]> = {
      a1: [computer("c1", "a1"), text("t1", "a1", "Done with Numbers")],
      a2: [
        { id: "bash", messageID: "a2", type: "tool", tool: "bash", state: { status: "completed" } } as unknown as Part,
      ],
      a3: [computer("c2", "a3", "data:two")],
    }
    const messages = [user("u1"), assistant("a1", "u1"), assistant("a2", "u1"), assistant("a3", "u1")]
    expect(holderRun({ messages, parts: (id) => parts[id] ?? [], keep, working: false })?.map((p) => p.id)).toEqual([
      "c2",
    ])
    expect(holderRun({ messages: [user("u1")], parts: () => [], keep, working: false })).toBeUndefined()
    expect(holderRun({ messages: [], parts: () => [], keep, working: false })).toBeUndefined()
  })

  test("a removed latest screenshot reads as removed", () => {
    const run = [computer("c1", "a1", "data:one"), computer("c2", "a1", undefined, true)]
    expect(latestShot(run)).toEqual({ removed: true })
    expect(latestShot(undefined)).toBeUndefined()
  })
})
