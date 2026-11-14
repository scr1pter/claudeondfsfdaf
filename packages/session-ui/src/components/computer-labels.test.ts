import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@vectordevai/sdk/v2"
import { Computer, ComputerApps, Hands } from "@vectordevai/core/computer/hands"
import { dict } from "@vectordevai/ui/i18n/en"
import {
  agentNote,
  computerLabel,
  computerRing,
  computerRun,
  computerRunTitle,
  computerShot,
  computerStepStatus,
  computerSteps,
  ringPoint,
  type ComputerStep,
  type Translate,
} from "./computer-labels"

// The English dictionary with the ui i18n context's template syntax. Unknown keys fail loudly.
const t: Translate = (key, params) => {
  const value = dict[key]
  if (value === undefined) throw new Error(`missing copy ${key}`)
  return value.replace(/{{\s*([^}]+?)\s*}}/g, (_, name: string) => String(params?.[name] ?? ""))
}

const NUMBERS = { key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }
const NOTEPAD = { key: "app:windows:aumid:microsoft.windowsnotepad", name: "Notepad" }
const SENTINEL = "SENTINEL-agent-words"

const completed = (
  metadata: Record<string, unknown>,
  input: Record<string, unknown> = {},
  time = { start: 0, end: 1000 },
): ToolPart["state"] => ({ status: "completed", input, output: SENTINEL, title: "", metadata, time })
const toolPart = (id: string, state: ToolPart["state"]): ToolPart => ({
  id,
  sessionID: "s1",
  messageID: "m1",
  type: "tool",
  callID: `call-${id}`,
  tool: Hands.ID,
  state,
})
const labels = (state: ToolPart["state"]) => computerSteps(state, t).map((step) => step.label)

const withApp = {
  screenshot: "Looked at Numbers",
  zoom: "Looked more closely at Numbers",
  cursor_position: "Checked the pointer",
  click: "Clicked “Save” in Numbers",
  double_click: "Double-clicked “Save” in Numbers",
  triple_click: "Triple-clicked “Save” in Numbers",
  right_click: "Right-clicked “Save” in Numbers",
  middle_click: "Middle-clicked “Save” in Numbers",
  mouse_move: "Moved the pointer in Numbers",
  drag: "Dragged in Numbers",
  mouse_down: "Held the mouse button in Numbers",
  mouse_up: "Released the mouse button in Numbers",
  scroll: "Scrolled in Numbers",
  type: "Typed “October receipts” in Numbers",
  key: "Pressed ⌘S",
  hold_key: "Held ⌘S",
  wait: "Waited 1 s",
  list_apps: "Looked at available apps",
  open_app: "Opened Numbers",
  focus_window: "Switched to Numbers",
  read_ui: "Read controls in Numbers",
  handoff: "Your turn in Numbers: sign in",
} satisfies Record<Computer.ToolAction, string>

const withoutApp = {
  screenshot: "Looked at the screen",
  zoom: "Looked more closely at the screen",
  cursor_position: "Checked the pointer",
  click: "Clicked in the app",
  double_click: "Double-clicked in the app",
  triple_click: "Triple-clicked in the app",
  right_click: "Right-clicked in the app",
  middle_click: "Middle-clicked in the app",
  mouse_move: "Moved the pointer in the app",
  drag: "Dragged in the app",
  mouse_down: "Held the mouse button in the app",
  mouse_up: "Released the mouse button in the app",
  scroll: "Scrolled in the app",
  type: "Typed text in the app",
  key: "Pressed keys in the app",
  hold_key: "Held keys in the app",
  wait: "Waited 1 s",
  list_apps: "Looked at available apps",
  open_app: "Opened the app",
  focus_window: "Switched to the app",
  read_ui: "Read controls in the app",
  handoff: "Your turn: finish this step yourself",
} satisfies Record<Computer.ToolAction, string>

describe("computerLabel", () => {
  test("every action's label, with and without its app and target", () => {
    for (const action of Computer.ToolAction.literals) {
      const metadata = {
        action,
        app: NUMBERS,
        target: { role: "button", name: "Save" },
        text: { length: 16, preview: "October receipts" },
        keys: "cmd+s",
        ...(action === "handoff" ? { handoff: { reason: "sign_in" } } : {}),
      }
      expect(computerLabel(metadata, t)).toBe(withApp[action])
      expect(computerLabel({ action }, t)).toBe(withoutApp[action])
    }
  })

  // The lone-part renderer labels a call with computerLabel alone, so it must agree with the run card's first step.
  test("a recorded block, setup or handoff replaces the action, so nothing reads as done", () => {
    const typed = { action: "type", app: NUMBERS, text: { length: 16, preview: "October receipts" } }
    const outcomes = [
      { ...typed, code: "secure_field", handoff: { reason: "credential" } },
      { ...typed, code: "blocked", blocked: { reason: "passwords" } },
      { ...typed, code: "unavailable", setup: true },
      { ...typed, paused: { by: "input", ms: 1_000 }, handoff: { reason: "elevated" } },
    ]
    expect(outcomes.map((metadata) => computerLabel(metadata, t))).toEqual([
      `Your turn in Numbers: ${dict["ui.tool.computer.handoff.credential"]}`,
      `Couldn't use Numbers: ${Hands.NAME} can't use password managers or Keychain.`,
      `${Hands.NAME} needs to be set up first`,
      `Your turn in Numbers: ${dict["ui.tool.computer.handoff.elevated"]}`,
    ])
    for (const metadata of outcomes) {
      expect(computerLabel(metadata, t)).not.toContain("October")
      expect(computerLabel(metadata, t, { action: "type", actions: [{ action: "type" }, { action: "key" }] })).toBe(
        computerLabel(metadata, t),
      )
      expect(computerLabel(metadata, t)).toBe(labels(completed(metadata, { action: "type" }))[0])
    }
  })

  test("metadata.intent never appears in a label", () => {
    const input = {
      intent: SENTINEL,
      text: SENTINEL,
      reason: SENTINEL,
      query: SENTINEL,
      app: SENTINEL,
      window: SENTINEL,
      keys: SENTINEL,
    }
    const states = Computer.ToolAction.literals.flatMap((action): ToolPart["state"][] => [
      completed({ action, intent: SENTINEL, app: NUMBERS }, { action, ...input }),
      completed(
        { action, intent: SENTINEL, code: "stopped", paused: { by: "input", ms: 80_000 } },
        { action, ...input },
      ),
      { status: "running", input: { action, ...input }, time: { start: 0 } },
      { status: "pending", input: { action, ...input }, raw: SENTINEL },
      { status: "error", input: { action, ...input }, error: SENTINEL, time: { start: 0, end: 1 } },
    ])
    for (const state of states) {
      for (const label of labels(state)) expect(label).not.toContain(SENTINEL)
      expect(computerLabel(state.status === "pending" ? {} : state.metadata, t, state.input)).not.toContain(SENTINEL)
    }
    const parts = states.map((state, index) => toolPart(`p${index}`, state))
    expect(computerRunTitle(parts, t)).not.toContain(SENTINEL)
  })

  test("typed text is cut to 60 characters, stays within the schema bound and drops credentials", () => {
    const type = (preview: string) => computerLabel({ action: "type", app: NUMBERS, text: { length: 99, preview } }, t)
    const long = "x".repeat(80)
    expect(type(long)).toBe(`Typed “${"x".repeat(59)}…” in Numbers`)
    // An emoji straddling the cut is dropped whole, never split into half a surrogate pair.
    const emoji = type(`${"x".repeat(58)}😀😀`)
    expect(emoji).toBe(`Typed “${"x".repeat(58)}…” in Numbers`)
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(type("sk-test-AbCdEf1234567890abcdefghijk")).toBe("Typed text in Numbers")
    expect(type("4111 1111 1111 1111")).toBe("Typed text in Numbers")
    expect(type("   ")).toBe("Typed text in Numbers")
  })

  test("labels strip control, bidi and invisible characters and cap accessibility text", () => {
    expect(
      computerLabel(
        { action: "click", app: { ...NUMBERS, name: "Num\u200bbers" }, target: { name: "\u202eSave\u200b\n\u0085" } },
        t,
      ),
    ).toBe("Clicked “Save” in Numbers")
    expect(computerLabel({ action: "click", app: NUMBERS, target: { name: "A".repeat(60) } }, t)).toBe(
      `Clicked “${"A".repeat(39)}…” in Numbers`,
    )
    expect(computerLabel({ action: "click", app: NUMBERS, target: { name: "“Save”" } }, t)).toBe(
      'Clicked “"Save"” in Numbers',
    )
    expect(computerLabel({ action: "type", text: { length: 3, preview: "a\u2066b\u2069c" } }, t)).toBe(
      "Typed “abc” in the app",
    )
  })

  test("one malformed field leaves the rest of the label", () => {
    expect(computerLabel({ action: "click", app: NUMBERS, target: { name: 42 } }, t)).toBe("Clicked in Numbers")
    expect(computerLabel({ action: "click", app: "Numbers", target: { name: "Save" } }, t)).toBe(
      "Clicked “Save” in the app",
    )
    expect(computerLabel({ action: "bogus" }, t, { action: "open_app" })).toBe("Opened the app")
    expect(computerLabel({ action: "bogus" }, t, { action: "bogus" })).toBe(Hands.NAME)
    expect(computerLabel(null, t, "click")).toBe(Hands.NAME)
  })

  test("scroll and wait read only their validated non-text fields", () => {
    expect(computerLabel({ action: "scroll", app: NUMBERS }, t, { action: "scroll", direction: "down" })).toBe(
      "Scrolled down",
    )
    expect(computerLabel({ action: "scroll", app: NUMBERS }, t, { action: "scroll", direction: "sideways" })).toBe(
      "Scrolled in Numbers",
    )
    expect(computerLabel({ action: "wait" }, t, { action: "wait", seconds: 2 })).toBe("Waited 2 s")
    expect(computerLabel({ action: "wait" }, t, { action: "wait", seconds: 0.5 })).toBe("Waited 0.5 s")
  })

  test("a batch shows its first step without a target and how many steps follow", () => {
    const metadata = { action: "click", app: NUMBERS, target: { name: "Save" }, text: { length: 3, preview: "abc" } }
    const steps = (count: number) => [
      { action: "type", text: SENTINEL },
      ...Array.from({ length: count - 1 }, () => ({ action: "click" })),
    ]
    expect(computerLabel(metadata, t, { action: "click", actions: steps(3) })).toBe(
      "Typed text in Numbers +2 more steps",
    )
    expect(computerLabel(metadata, t, { action: "click", actions: steps(2) })).toBe(
      "Typed text in Numbers +1 more step",
    )
    // One step is that step, with the part's full metadata.
    expect(computerLabel({ ...metadata, action: "type" }, t, { action: "click", actions: [{ action: "type" }] })).toBe(
      "Typed “abc” in Numbers",
    )
  })

  test("keys use the engine's resolver, macOS glyphs, and fall back for anything unknown", () => {
    const keys = (value: string, app: Record<string, string> = NUMBERS) =>
      computerLabel({ action: "key", app, keys: value }, t)
    expect(keys("cmd+s")).toBe("Pressed ⌘S")
    expect(keys("command+shift+s")).toBe("Pressed ⇧⌘S")
    expect(keys("option+ctrl+left")).toBe("Pressed ⌃⌥←")
    expect(keys("⌘+return")).toBe("Pressed ⌘Enter")
    expect(keys("esc")).toBe("Pressed Esc")
    expect(keys("ctrl+shift+s", NOTEPAD)).toBe("Pressed Ctrl+Shift+S")
    expect(keys("super+e", NOTEPAD)).toBe("Pressed Win+E")
    expect(keys("controlleft+f5", NOTEPAD)).toBe("Pressed Ctrl+F5")
    expect(keys("ctrl+volumeup", NOTEPAD)).toBe("Pressed keys in Notepad")
    expect(keys("ctrl+KeyQ", NOTEPAD)).toBe("Pressed keys in Notepad")
    expect(keys("ctrl+ctrl+s", NOTEPAD)).toBe("Pressed keys in Notepad")
    expect(keys(`ctrl+${SENTINEL}`, NOTEPAD)).toBe("Pressed keys in Notepad")
  })
})

describe("computerSteps", () => {
  test("every action and blocked reason has its label", () => {
    for (const action of Computer.ToolAction.literals)
      expect(computerSteps(completed({ action, app: NUMBERS }), t)).toEqual([
        { label: computerLabel({ action, app: NUMBERS }, t), state: "done" },
      ])
    const blocked = {
      terminal: `Couldn't use Numbers: ${Hands.NAME} can't use Numbers. Vector uses its own terminal instead.`,
      vector: `Couldn't use Numbers: ${Hands.NAME} can't use Vector itself.`,
      security: `Couldn't use Numbers: ${Hands.NAME} can't approve security or administrator prompts. Please do this step yourself.`,
      passwords: `Couldn't use Numbers: ${Hands.NAME} can't use password managers or Keychain.`,
      remote: `Couldn't use Numbers: ${Hands.NAME} can't use remote desktop or virtual machine windows.`,
      user: `Couldn't use Numbers: Numbers is blocked in Settings › ${Hands.NAME}.`,
      company: `Couldn't use Numbers: Your company doesn't allow ${Hands.NAME} to use Numbers.`,
      denied: "Couldn't use Numbers: The user said no to Numbers for this conversation.",
    } satisfies Record<ComputerApps.BlockReason, string>
    for (const reason of ComputerApps.BlockReason.literals)
      expect(
        computerSteps(completed({ action: "click", app: NUMBERS, code: "blocked", blocked: { reason } }), t),
      ).toEqual([{ label: blocked[reason], state: "failed" }])
    expect(labels(completed({ action: "click", code: "blocked", blocked: { reason: "passwords" } }))).toEqual([
      `Couldn't use the app: ${Hands.NAME} can't use password managers or Keychain.`,
    ])
    expect(computerSteps(completed({ action: "screenshot", code: "unavailable", setup: true }), t)).toEqual([
      { label: `${Hands.NAME} needs to be set up first`, state: "failed" },
    ])
  })

  test("every take-over and pause is labeled with its length, then resumed", () => {
    for (const by of Computer.PauseReason.literals) {
      const expected = by === "input" || by === "button" ? "You took over (1m 20s)" : "Paused (1m 20s)"
      // The pause may have come before the click reached the app, so the click is unconfirmed.
      expect(
        computerSteps(
          completed({ action: "click", app: NUMBERS, target: { name: "Save" }, paused: { by, ms: 80_000 } }),
          t,
        ),
      ).toEqual([
        { label: "Clicked “Save” in Numbers", state: "unconfirmed" },
        { label: expected, state: "done" },
        { label: "Resumed", state: "done" },
      ])
    }
    expect(computerSteps(completed({ action: "click", paused: { by: "input", ms: 4_400 } }), t)).toEqual([
      { label: "Clicked in the app", state: "unconfirmed" },
      { label: "You took over (4s)", state: "done" },
      { label: "Resumed", state: "done" },
    ])
    expect(computerSteps(completed({ action: "click", paused: { by: "nap", ms: 4_400 } }), t)).toEqual([
      { label: "Clicked in the app", state: "unconfirmed" },
    ])
  })

  test("every handoff reason has its sentence, with or without the app", () => {
    for (const reason of Computer.HandoffReason.literals) {
      const sentence = dict[`ui.tool.computer.handoff.${reason}`]
      expect(sentence).toBeTruthy()
      expect(labels(completed({ action: "handoff", app: NUMBERS, handoff: { reason } }))).toEqual([
        `Your turn in Numbers: ${sentence}`,
        "Resumed",
      ])
      expect(labels(completed({ action: "type", handoff: { reason } }))).toEqual([`Your turn: ${sentence}`, "Resumed"])
    }
  })

  test("every error code marks the step: stopped leaves it unconfirmed and adds Stopped, any other code fails it", () => {
    for (const code of Computer.ComputerErrorCode.literals) {
      const steps = computerSteps(completed({ action: "click", app: NUMBERS, code }), t)
      // A stop may come before or after the click reached the app, so the click is unconfirmed.
      if (code === "stopped")
        expect(steps).toEqual([
          { label: "Clicked in Numbers", state: "unconfirmed" },
          { label: "Stopped", state: "stopped" },
        ])
      else expect(steps).toEqual([{ label: "Clicked in Numbers", state: "failed" }])
    }
    // The handoff itself happened before the user stopped.
    expect(computerSteps(completed({ action: "handoff", handoff: { reason: "sign_in" }, code: "stopped" }), t)).toEqual(
      [
        { label: "Your turn: sign in", state: "done" },
        { label: "Stopped", state: "stopped" },
      ],
    )
    expect(
      computerSteps(completed({ action: "click", paused: { by: "input", ms: 1000 }, code: "needs_foreground" }), t),
    ).toEqual([
      { label: "Clicked in the app", state: "failed" },
      { label: "You took over (1s)", state: "done" },
    ])
  })

  // The engine records no executed count (D8.9): a stopped or paused call may have ended before its input reached the
  // app, for example at a check-in, a sensitive confirmation, or a pointer wait, so the card never claims it ran.
  test("a stopped or paused call's action may not have run, so it is never marked done or shows its text", () => {
    const mail = { key: "app:macos:com.apple.mail", name: "Mail" }
    const typed = { action: "type", app: mail, text: { length: 18, preview: "Dear Bob, I resign" } }
    const send = { action: "click", app: mail, target: { name: "Send" } }
    expect(computerSteps(completed(typed), t)).toEqual([{ label: "Typed “Dear Bob, I resign” in Mail", state: "done" }])
    expect(computerSteps(completed({ ...typed, code: "stopped" }), t)).toEqual([
      { label: "Typed text in Mail", state: "unconfirmed" },
      { label: "Stopped", state: "stopped" },
    ])
    expect(computerSteps(completed({ ...send, paused: { by: "pointer", ms: 3_000 } }), t)).toEqual([
      { label: "Clicked “Send” in Mail", state: "unconfirmed" },
      { label: "Paused (3s)", state: "done" },
      { label: "Resumed", state: "done" },
    ])
    expect(computerSteps(completed({ ...typed, paused: { by: "input", ms: 5_000 }, code: "stopped" }), t)).toEqual([
      { label: "Typed text in Mail", state: "unconfirmed" },
      { label: "You took over (5s)", state: "done" },
      { label: "Stopped", state: "stopped" },
    ])
    // A malformed pause is still a pause the header does not count.
    expect(computerSteps(completed({ ...send, paused: { by: "nap", ms: 1 } }), t)).toEqual([
      { label: "Clicked “Send” in Mail", state: "unconfirmed" },
    ])
    expect(computerLabel({ ...typed, code: "stopped" }, t)).toBe("Typed text in Mail")
    expect(computerLabel({ ...typed, paused: { by: "input", ms: 1 } }, t)).toBe("Typed text in Mail")
  })

  // The engine writes the preview before the sensitive-action check, so a declined confirmation or any other refusal
  // before input leaves the proposed text in the part although none of it was typed.
  test("a refused call never shows the text it proposed as typed", () => {
    const bank = { key: "app:macos:com.example.bank", name: "Bank" }
    const typed = { action: "type", app: bank, text: { length: 22, preview: "Transfer $5,000 to 1234" } }
    for (const code of ["denied", "changed", "needs_foreground", "not_granted"]) {
      expect(computerSteps(completed({ ...typed, code }), t)).toEqual([
        { label: "Typed text in Bank", state: "failed" },
      ])
      expect(computerLabel({ ...typed, code }, t)).toBe("Typed text in Bank")
    }
  })

  // Each step's action is a closed-vocabulary literal, so every step gets a label without reading any model text.
  test("a batch lists each of its steps, marked as the header counts the call", () => {
    const mail = { key: "app:macos:com.apple.mail", name: "Mail" }
    const input = {
      action: "click",
      actions: [
        { action: "click", x: 10, y: 10 },
        { action: "type", text: SENTINEL },
        { action: "key", text: SENTINEL },
        { action: "scroll", direction: "down" },
        { action: "wait", seconds: 2 },
      ],
    }
    // The metadata's target, text and keys belong to one group of steps, so no step reads them.
    const metadata = {
      action: "click",
      app: mail,
      target: { name: "Reply" },
      text: { length: 3, preview: "abc" },
      keys: "cmd+enter",
    }
    const entries = ["Clicked in Mail", "Typed text in Mail", "Pressed keys in Mail", "Scrolled down", "Waited 2 s"]
    const marked = (state: ComputerStep["state"]) => entries.map((label) => ({ label, state }))
    const steps = (outcome: Record<string, unknown>) => computerSteps(completed({ ...metadata, ...outcome }, input), t)
    expect(steps({})).toEqual(marked("done"))
    expect(computerRun([toolPart("c1", completed(metadata, input))]).actions).toBe(5)
    expect(steps({ paused: { by: "input", ms: 2_000 } })).toEqual([
      ...marked("unconfirmed"),
      { label: "You took over (2s)", state: "done" },
      { label: "Resumed", state: "done" },
    ])
    expect(steps({ code: "stopped" })).toEqual([...marked("unconfirmed"), { label: "Stopped", state: "stopped" }])
    expect(steps({ code: "changed" })).toEqual(marked("failed"))
    // A later step can be handed off or blocked after earlier ones ran, so the steps stay listed before it.
    expect(steps({ handoff: { reason: "credential" } })).toEqual([
      ...marked("unconfirmed"),
      { label: `Your turn in Mail: ${dict["ui.tool.computer.handoff.credential"]}`, state: "done" },
      { label: "Resumed", state: "done" },
    ])
    expect(steps({ code: "blocked", blocked: { reason: "passwords" } })).toEqual([
      ...marked("failed"),
      { label: `Couldn't use Mail: ${Hands.NAME} can't use password managers or Keychain.`, state: "failed" },
    ])
    for (const outcome of [{}, { code: "stopped" }, { handoff: { reason: "credential" } }])
      for (const step of steps(outcome)) expect(step.label).not.toContain(SENTINEL)
    // The lone-part subtitle keeps the summary.
    expect(computerLabel(metadata, t, input)).toBe("Clicked in Mail +4 more steps")
  })

  test("the first step is done exactly when the header counts the call", () => {
    const variants = [
      {},
      { paused: { by: "input", ms: 1 } },
      { paused: { by: "nap", ms: 1 } },
      { handoff: { reason: "sign_in" } },
      { handoff: { reason: "sign_in" }, code: "stopped" },
      { blocked: { reason: "user" }, code: "blocked" },
      { setup: true, code: "unavailable" },
      { code: "unknown_code" },
      ...Computer.ComputerErrorCode.literals.map((code) => ({ code })),
      ...Computer.ComputerErrorCode.literals.map((code) => ({ code, paused: { by: "input", ms: 1 } })),
    ]
    for (const variant of variants) {
      const state = completed({ action: "click", app: NUMBERS, ...variant }, { action: "click" })
      const first = computerSteps(state, t)[0]!
      // A handoff's label is the handoff itself, which did happen; the header counts no action for it.
      const done = first.state === "done" && !("handoff" in variant)
      expect({ variant, done }).toEqual({ variant, done: computerRun([toolPart("c1", state)]).actions > 0 })
    }
  })

  test("a step's status marks what its label alone cannot say", () => {
    expect(computerStepStatus("failed", t)).toBe("Failed")
    expect(computerStepStatus("unconfirmed", t)).toBe("May not have run")
    for (const state of ["running", "done", "stopped"] as const) expect(computerStepStatus(state, t)).toBeUndefined()
  })

  test("a call in flight or cut off is labeled from its validated input, never its raw error", () => {
    expect(computerSteps({ status: "pending", input: {}, raw: "" }, t)).toEqual([
      { label: Hands.NAME, state: "running" },
    ])
    expect(
      computerSteps(
        { status: "running", input: { action: "scroll", direction: "up", text: SENTINEL }, time: { start: 0 } },
        t,
      ),
    ).toEqual([{ label: "Scrolled up", state: "running" }])
    expect(
      computerSteps(
        {
          status: "error",
          input: { action: "open_app", app: SENTINEL },
          error: "Tool execution aborted",
          time: { start: 0, end: 1 },
        },
        t,
      ),
    ).toEqual([{ label: "Opened the app", state: "failed" }])
  })
})

describe("computerRun", () => {
  const run = [
    toolPart(
      "c1",
      completed({ action: "screenshot", app: NUMBERS }, { action: "screenshot" }, { start: 1_000, end: 2_000 }),
    ),
    toolPart(
      "c2",
      completed(
        { action: "click", app: NUMBERS },
        { action: "click", actions: [{ action: "click" }, { action: "type" }, { action: "key" }] },
        {
          start: 3_000,
          end: 40_000,
        },
      ),
    ),
    toolPart(
      "c3",
      completed({ action: "open_app", app: { key: "app:macos:com.apple.calculator", name: "Calculator" } }),
    ),
    toolPart("c4", completed({ action: "click", app: NUMBERS, code: "denied" })),
    toolPart(
      "c5",
      completed(
        { action: "click", app: NUMBERS, paused: { by: "input", ms: 1 } },
        { action: "click", actions: [{}, {}] },
        {
          start: 50_000,
          end: 131_000,
        },
      ),
    ),
    toolPart("c6", completed({ action: "handoff", handoff: { reason: "sign_in" } }, {}, { start: 0, end: 2_000 })),
    toolPart("c7", {
      status: "error",
      input: { action: "click" },
      error: "aborted",
      time: { start: 5_000, end: 6_000 },
    }),
    toolPart("c8", { status: "running", input: { action: "click" }, time: { start: 200_000 } }),
  ]

  test("counts the actions known to have run, lists apps in order and spans start to latest end", () => {
    expect(computerRun(run)).toEqual({ apps: ["Numbers", "Calculator"], actions: 5, ms: 131_000 })
    expect(computerRunTitle(run, t)).toBe(`${Hands.NAME} · Numbers, Calculator · 5 actions · 2m 11s`)
  })

  test("a paused 10-step batch claims none of its steps", () => {
    const batch = { action: "click", actions: Array.from({ length: 10 }, () => ({ action: "click" })) }
    expect(
      computerRun([toolPart("c1", completed({ action: "click", paused: { by: "input", ms: 5 } }, batch))]).actions,
    ).toBe(0)
    expect(computerRun([toolPart("c1", completed({ action: "click" }, batch))]).actions).toBe(10)
  })

  test("singular, empty and unfinished runs", () => {
    expect(
      computerRunTitle([toolPart("c1", completed({ action: "list_apps" }, {}, { start: 0, end: 4_000 }))], t),
    ).toBe(`${Hands.NAME} · 1 action · 4s`)
    expect(computerRunTitle([toolPart("c1", { status: "pending", input: {}, raw: "" })], t)).toBe(
      `${Hands.NAME} · 0 actions`,
    )
  })

  test("the latest screenshot or its removal marker", () => {
    const image = {
      id: "f1",
      sessionID: "s1",
      messageID: "m1",
      type: "file" as const,
      mime: "image/png",
      url: "data:image/png;base64,AA",
    }
    expect(
      computerShot(
        toolPart("c1", { ...completed({ action: "screenshot" }), attachments: [image] } as ToolPart["state"]),
      ),
    ).toEqual({ removed: false, image })
    expect(
      computerShot(
        toolPart("c1", {
          ...completed({ action: "screenshot", screenshotRemoved: true }),
          attachments: [image],
        } as ToolPart["state"]),
      ),
    ).toEqual({ removed: true })
    expect(computerShot(toolPart("c1", completed({ action: "click" })))).toBeUndefined()
  })
})

describe("ringPoint", () => {
  test("the ring scales from frame pixels", () => {
    const frame = { id: "f", width: 2000, height: 1000, hash: "0123456789abcdef" }
    expect(ringPoint({ x: 1000, y: 500 }, frame, 400)).toEqual({ x: 200, y: 100 })
    expect(ringPoint({ x: 0, y: 0 }, frame, 2000)).toEqual({ x: 0, y: 0 })
    expect(ringPoint({ x: 1999, y: 999 }, frame, 1000)).toEqual({ x: 999.5, y: 499.5 })
    for (const point of [
      { x: 2000, y: 10 },
      { x: 10, y: 1000 },
      { x: -1, y: 10 },
      { x: Number.NaN, y: 10 },
      { x: "10", y: 10 },
    ])
      expect(ringPoint(point, frame, 400)).toBeUndefined()
    expect(ringPoint({ x: 1, y: 1 }, { width: 0, height: 10 }, 400)).toBeUndefined()
    expect(ringPoint({ x: 1, y: 1 }, frame, 0)).toBeUndefined()
    expect(ringPoint(undefined, frame, 400)).toBeUndefined()
  })

  test("only a single call's point rings its screenshot", () => {
    const frame = { id: "f", width: 200, height: 100, hash: "0123456789abcdef" }
    const click = { action: "click", app: NUMBERS, point: { x: 50, y: 25 }, frame }
    const ring = { x: 50, y: 25, width: 200, height: 100 }
    expect(computerRing(toolPart("c1", completed(click, { action: "click", x: 50, y: 25 })))).toEqual(ring)
    // A batch of one is that single step.
    expect(computerRing(toolPart("c1", completed(click, { action: "click", actions: [{ action: "click" }] })))).toEqual(
      ring,
    )
    // A batch rewrites the point for each group of steps, so its last screenshot need not show where that step was.
    const batch = { action: "click", actions: [{ action: "click" }, { action: "type" }, { action: "key" }] }
    expect(computerRing(toolPart("c1", completed(click, batch)))).toBeUndefined()
    // A zoom (or any call without a point), a point outside its frame, and a call not completed have no ring.
    expect(
      computerRing(toolPart("c1", completed({ action: "zoom", app: NUMBERS, frame }, { action: "zoom" }))),
    ).toBeUndefined()
    expect(computerRing(toolPart("c1", completed({ ...click, point: { x: 200, y: 25 } })))).toBeUndefined()
    expect(
      computerRing(
        toolPart("c1", { status: "running", input: { action: "click" }, metadata: click, time: { start: 0 } }),
      ),
    ).toBeUndefined()
  })

  // A paused or handed-off call's screenshot is the frame captured after the user, while its point belongs to the
  // frame before, and its click may never have run; a stopped or refused click may not have run either.
  test("a click the header does not count has no ring", () => {
    const frame = { id: "f", width: 200, height: 100, hash: "0123456789abcdef" }
    const click = { action: "click", app: NUMBERS, point: { x: 50, y: 25 }, frame }
    const input = { action: "click", x: 50, y: 25 }
    for (const outcome of [
      { paused: { by: "pointer", ms: 2_000 } },
      { paused: { by: "input", ms: 2_000 } },
      { handoff: { reason: "security_prompt" } },
      { handoff: { reason: "elevated" }, code: "stopped" },
      { code: "stopped" },
      { code: "denied" },
    ]) {
      const part = toolPart("c1", completed({ ...click, ...outcome }, input))
      expect(computerRun([part]).actions).toBe(0)
      expect(computerRing(part)).toBeUndefined()
    }
  })
})

describe("agentNote", () => {
  test("keeps lines and strips control and bidi characters", () => {
    expect(agentNote("  Opening \u202eNumbers\u0007\r\nthen saving\u200b  ")).toBe("Opening Numbers\nthen saving")
    expect(agentNote(42)).toBe("")
  })
})
