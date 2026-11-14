import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { dict } from "@vectordevai/ui/i18n/en"
import { dict as appDict } from "../../i18n/en"
import { ComputerMainCopy } from "./main-copy"

const samples = [
  ["banner", () => ComputerMainCopy.banner(), Hands.BANNER],
  ["bannerEnd", () => ComputerMainCopy.bannerEnd({ reason: "done" }), "Done — your computer is yours again"],
  ["trayTooltip", () => ComputerMainCopy.trayTooltip(), `Vector — ${Hands.BANNER}`],
  ["trayStop", () => ComputerMainCopy.trayStop(), `Stop ${Hands.NAME}`],
  ["working", () => ComputerMainCopy.working({ app: "Numbers" }), "Working in Numbers"],
  ["workingBehind", () => ComputerMainCopy.workingBehind({ app: "Numbers" }), "Working in Numbers behind your windows"],
  [
    "waitingForTyping",
    () => ComputerMainCopy.waitingForTyping({ app: "Numbers" }),
    "Waiting while you type in Numbers",
  ],
  [
    "foregroundFallback",
    () => ComputerMainCopy.foregroundFallback({ app: "Numbers" }),
    `Numbers needs the screen; ${Hands.NAME} will ask before using your mouse.`,
  ],
  ["queued", () => ComputerMainCopy.queued({ count: 1 }), "+1 waiting"],
  ["notificationStart", () => ComputerMainCopy.notificationStart(), `${Hands.BANNER}. Press Esc or Stop to stop it.`],
  ["notificationNeedsYou", () => ComputerMainCopy.notificationNeedsYou(), `${Hands.NAME} needs you`],
  [
    "notificationFinished",
    () => ComputerMainCopy.notificationFinished({ count: 23, app: "Numbers and Calculator" }),
    `${Hands.NAME} finished. 23 actions in Numbers and Calculator.`,
  ],
  ["notificationStopped", () => ComputerMainCopy.notificationStopped(), `${Hands.NAME} stopped.`],
  [
    "notificationFailed",
    () => ComputerMainCopy.notificationFailed({ reason: "the app closed" }),
    `${Hands.NAME} couldn't finish: the app closed`,
  ],
  ["chord", () => ComputerMainCopy.chord(Hands.STOP_CHORD.darwin, "macos"), "⌘⇧Esc"],
  ["pause", () => ComputerMainCopy.pause({ reason: "input" }), "Paused — you have control"],
  [
    "secureTypingDetail",
    () => ComputerMainCopy.secureTypingDetail({ app: "Mail" }),
    "Mail turned on secure keyboard entry, so Vector can't hear Esc. Finish typing your password or turn it off, then press Resume.",
  ],
  [
    "checkIn",
    () => ComputerMainCopy.checkIn({ reason: "actions", count: 300 }),
    `${Hands.NAME} has taken 300 steps on this task. Keep going?`,
  ],
  [
    "handoff",
    () => ComputerMainCopy.handoff({ reason: "sign_in", app: "Numbers" }),
    "Your turn in Numbers: sign in. Press Continue when you're done.",
  ],
  [
    "step",
    () => ComputerMainCopy.step({ action: "click", app: "Numbers", label: "Save" }),
    "Clicking “Save” in Numbers",
  ],
  ["askApp", () => ComputerMainCopy.askApp({ app: "Numbers" }), `Allow ${Hands.NAME} to use Numbers?`],
  [
    "askSensitive",
    () => ComputerMainCopy.askSensitive({ action: "click", why: "send", app: "Mail", label: "Send" }),
    `${Hands.NAME} wants to click “Send” in Mail`,
  ],
  ["failure", () => ComputerMainCopy.failure({ reason: "engine" }), "Vector's engine stopped"],
] as const

const pauses = {
  input: "Paused — you have control",
  button: "Paused — you have control",
  locked: "Paused while your computer was locked",
  suspend: "Paused while your computer was locked",
  away: `Still there? ${Hands.NAME} paused so your computer can lock.`,
  helper: `Paused — ${Hands.NAME}' helper stopped`,
  detection: "Paused — Vector can't tell whether you're using the mouse and keyboard",
  secure_input: "Paused — secure typing is on in Mail",
  secure_desktop: "Paused — Windows is showing a security screen",
  overlay: "Paused — the screen indicator is unavailable",
  pointer: `${Hands.NAME} needs the mouse for a moment`,
} satisfies Record<Computer.PauseReason, string>

const handoffs = {
  credential: "enter your password or code",
  sign_in: "sign in",
  captcha: "complete the CAPTCHA",
  payment_details: "enter your payment details",
  admin_prompt: "answer the administrator prompt",
  security_prompt: "answer the security prompt",
  capture_confirm: "answer the screen recording prompt",
  elevated: "finish this step in the app running as administrator",
  site_permission: "answer the site's permission prompt",
  download: "decide whether to keep or open the download",
  extension: "decide whether to install the extension",
  protocol_handler: "decide whether to open the linked app",
  macros: "decide whether to enable the document's content or macros",
  other: "finish this step yourself",
} satisfies Record<Computer.HandoffReason, string>

const steps = {
  screenshot: "Looking at Numbers",
  zoom: "Looking more closely at Numbers",
  cursor_position: "Checking the pointer",
  click: "Clicking “Save” in Numbers",
  double_click: "Double-clicking “Save” in Numbers",
  triple_click: "Triple-clicking “Save” in Numbers",
  right_click: "Right-clicking “Save” in Numbers",
  middle_click: "Middle-clicking “Save” in Numbers",
  mouse_move: "Moving the pointer in Numbers",
  drag: "Dragging “Save” in Numbers",
  mouse_down: "Holding the mouse button in Numbers",
  mouse_up: "Releasing the mouse button in Numbers",
  scroll: "Scrolling in Numbers",
  type: "Typing in Numbers",
  key: "Pressing keys in Numbers",
  hold_key: "Holding keys in Numbers",
  wait: "Waiting",
  list_apps: "Looking at available apps",
  open_app: "Opening Numbers",
  focus_window: "Switching to Numbers",
  read_ui: "Reading controls in Numbers",
  handoff: "Your turn",
} satisfies Record<Computer.ToolAction, string>

describe("desktop main copy", () => {
  for (const [name, render, expected] of samples) {
    test(`${name} uses the specified copy`, () => expect(render()).toBe(expected))
  }

  test("every exported function has a sample and the banner is the exact fixed sentence", () => {
    expect(
      Object.entries(ComputerMainCopy)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => name)
        .sort(),
    ).toEqual(samples.map(([name]) => name).sort())
    expect(ComputerMainCopy.banner()).toBe(Hands.BANNER)
    expect(ComputerMainCopy.banner()).toBe("Vector is using your computer")
  })

  test("completion and check-ins handle singular, plural and absent app names", () => {
    expect(ComputerMainCopy.bannerEnd({ reason: "stopped" })).toBe("Stopped — your computer is yours again")
    expect(ComputerMainCopy.notificationFinished({ count: 1, app: "Numbers" })).toBe(
      `${Hands.NAME} finished. 1 action in Numbers.`,
    )
    expect(ComputerMainCopy.notificationFinished({ count: 0 })).toBe(`${Hands.NAME} finished. 0 actions.`)
    expect(ComputerMainCopy.checkIn({ reason: "minutes", count: 45 })).toBe(
      `${Hands.NAME} has been working for 45 minutes on this task. Keep going?`,
    )
    expect(ComputerMainCopy.checkIn({ reason: "minutes", count: 1 })).toBe(
      `${Hands.NAME} has been working for 1 minute on this task. Keep going?`,
    )
    expect(ComputerMainCopy.checkIn({ reason: "actions", count: 1 })).toBe(
      `${Hands.NAME} has taken 1 step on this task. Keep going?`,
    )
    expect(ComputerMainCopy.queued({ count: 3 })).toBe("+3 waiting")
  })

  test("stop shortcut labels keep the accelerator's order on each platform", () => {
    expect(ComputerMainCopy.chord(Hands.STOP_CHORD.darwin, "macos")).toBe("⌘⇧Esc")
    expect(ComputerMainCopy.chord(Hands.STOP_CHORD.win32, "windows")).toBe("Ctrl+Alt+Shift+Esc")
    expect(ComputerMainCopy.chord("Control+Shift+K", "macos")).toBe("⌃⇧K")
    expect(ComputerMainCopy.chord("Control+Shift+K", "windows")).toBe("Ctrl+Shift+K")
    expect(ComputerMainCopy.chord("Command+Option+F5", "macos")).toBe("⌘⌥F5")
    expect(ComputerMainCopy.chord("Super+Alt+K", "windows")).toBe("Win+Alt+K")
    expect(ComputerMainCopy.chord("Control+\u202eK", "windows")).toBe("Ctrl+K")
  })

  test("every pause reason has explicit copy", () => {
    for (const reason of Object.keys(pauses) as Computer.PauseReason[]) {
      expect(ComputerMainCopy.pause({ reason, app: "Mail" })).toBe(pauses[reason])
    }
    expect(ComputerMainCopy.pause({ reason: "secure_input" })).toBe("Paused — secure typing is on in another app")
  })

  test("every handoff reason is fixed copy, with or without an app", () => {
    for (const reason of Object.keys(handoffs) as Computer.HandoffReason[]) {
      expect(ComputerMainCopy.handoff({ reason, app: "Numbers" })).toBe(
        `Your turn in Numbers: ${handoffs[reason]}. Press Continue when you're done.`,
      )
    }
    expect(ComputerMainCopy.handoff({ reason: "other" })).toBe(
      "Your turn: finish this step yourself. Press Continue when you're done.",
    )
  })

  test("the banner's ask titles match the dock's and carry only verified facts", () => {
    const fill = (text: string, params: Record<string, string>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => params[key] ?? "")
    const params = { name: Hands.NAME, app: "Mail", label: "Send" }
    expect(ComputerMainCopy.askApp({ app: "Mail" })).toBe(fill(appDict["computer.ask.app.title"], params))
    const cases = [
      [{ action: "click", why: "send", label: "Send" }, "computer.ask.sensitive.click"],
      [{ action: "click", why: "send" }, "computer.ask.sensitive.useApp"],
      [{ action: "type", why: "new_destination" }, "computer.ask.sensitive.type"],
      [{ action: "key", why: "disruptive" }, "computer.ask.sensitive.keyUnknown"],
      [{ action: "drag", why: "delete" }, "computer.ask.sensitive.drag"],
      [{ action: "open", why: "settings" }, "computer.ask.sensitive.useApp"],
      [{ action: "open", why: "run_program" }, "computer.ask.sensitive.runProgram"],
      [{ action: "key", why: "paste" }, "computer.ask.sensitive.paste"],
    ] as const
    for (const [input, key] of cases)
      expect(ComputerMainCopy.askSensitive({ app: "Mail", ...input })).toBe(fill(appDict[key], params))
    // A label is cleaned and cut like the step line's; no typed text or path field exists to pass.
    const long = ComputerMainCopy.askSensitive({
      action: "click",
      why: "send",
      app: "Mail",
      label: `a‮${"x".repeat(80)}`,
    })
    expect(long).toBe(`${Hands.NAME} wants to click “a${"x".repeat(Computer.LIMITS.labelChars - 1)}” in Mail`)
    expect(ComputerMainCopy.failure({ reason: "error" })).toBe("the conversation ended with an error")
  })

  test("the timeline's and the app's handoff sentences match the desktop's", () => {
    const appKeys = {
      credential: "credential",
      sign_in: "signIn",
      captcha: "captcha",
      payment_details: "payment",
      admin_prompt: "adminPrompt",
      security_prompt: "security",
      capture_confirm: "recording",
      elevated: "elevated",
      site_permission: "sitePermission",
      download: "download",
      extension: "extension",
      protocol_handler: "protocolHandler",
      macros: "macros",
      other: "other",
    } as const satisfies Record<Computer.HandoffReason, string>
    for (const reason of Object.keys(handoffs) as Computer.HandoffReason[]) {
      expect(dict[`ui.tool.computer.handoff.${reason}`]).toBe(handoffs[reason])
      expect(appDict[`computer.handoff.reason.${appKeys[reason]}`]).toBe(handoffs[reason])
    }
  })

  test("every live action uses a Vector-built label", () => {
    for (const action of Object.keys(steps) as Computer.ToolAction[]) {
      expect(ComputerMainCopy.step({ action, app: "Numbers", label: "Save" })).toBe(steps[action])
    }
    expect(ComputerMainCopy.step({ action: "click" })).toBe("Clicking")
    expect(ComputerMainCopy.step({ action: "screenshot" })).toBe("Looking at the approved apps")
    expect(ComputerMainCopy.step({ action: "zoom" })).toBe("Looking more closely")
    expect(ComputerMainCopy.step({ action: "open_app" })).toBe("Opening an app")
    expect(ComputerMainCopy.step({ action: "focus_window" })).toBe("Switching windows")
    expect(ComputerMainCopy.step({ action: "read_ui" })).toBe("Reading app controls")
  })

  test("live labels strip control characters and cap quoted accessibility text", () => {
    expect(ComputerMainCopy.step({ action: "click", app: "Numbers", label: "\u202eSave\u200b\n\u0085" })).toBe(
      "Clicking “Save” in Numbers",
    )
    expect(ComputerMainCopy.step({ action: "click", label: "A".repeat(60) })).toBe(`Clicking “${"A".repeat(40)}”`)
    expect(ComputerMainCopy.step({ action: "click", label: "“Save”" })).toBe('Clicking “"Save"”')
  })

  test("live labels drop everything the state schema refuses, as the run card does, and never split a character", () => {
    const step = (label: string) => ComputerMainCopy.step({ action: "click", app: "Numbers", label })
    expect(step("Pay؜ now ")).toBe("Clicking “Pay now” in Numbers")
    expect(step("Save\nAll")).toBe("Clicking “Save All” in Numbers")
    expect(step("Save​All﻿")).toBe("Clicking “SaveAll” in Numbers")
    // An astral character across the 40-unit cut goes whole, never as a lone high surrogate.
    expect(step(`${"A".repeat(39)}😀 tail`)).toBe(`Clicking “${"A".repeat(39)}” in Numbers`)
    expect(step(`${"A".repeat(38)}😀 tail`)).toBe(`Clicking “${"A".repeat(38)}😀” in Numbers`)
    // The desktop puts the step line in `ComputerState.step`, which refuses controls, separators and bidi marks.
    const unsafe = [
      ...Array.from({ length: 0x20 }, (_, code) => code),
      ...Array.from({ length: 0x21 }, (_, index) => 0x7f + index),
      0x061c,
      0x200e,
      0x200f,
      0x2028,
      0x2029,
      ...Array.from({ length: 5 }, (_, index) => 0x202a + index),
      ...Array.from({ length: 4 }, (_, index) => 0x2066 + index),
    ]
    const state = (line: string) => ({
      phase: "working",
      backend: "local-macos",
      mode: "foreground",
      apps: [],
      step: line,
      queue: [],
      escStops: true,
      stopChord: Hands.STOP_CHORD.darwin,
      lease: 1,
      reduceMotion: false,
    })
    expect(Schema.is(Computer.ComputerState)(state(step("Send")))).toBe(true)
    for (const code of unsafe) {
      const line = step(`Pay${String.fromCharCode(code)}now`)
      expect(Schema.is(Computer.ComputerState)(state(line))).toBe(true)
      expect(Schema.is(Computer.ComputerState)(state(`Clicking “Pay${String.fromCharCode(code)}now”`))).toBe(false)
    }
  })

  test("model intent, typed text and key payloads never enter live labels", () => {
    const input = {
      action: "type" as const,
      app: "Numbers",
      intent: "Agent-authored instruction",
      text: { preview: "Private text" },
      keys: "Private keys",
    }
    expect(ComputerMainCopy.step(input)).toBe("Typing in Numbers")
  })

  test("fixed controls and statuses use the specified labels", () => {
    expect(ComputerMainCopy.labels).toEqual({
      takeOver: "Take over",
      resume: "Resume",
      stop: "Stop",
      allow: "Allow",
      allowOnce: "Allow once",
      deny: "Deny",
      continue: "Continue",
      handOver: "Hand over",
      notNow: "Not now",
      keepGoing: "Keep going",
      working: "Working",
      needsYou: "Needs you",
      paused: "Paused",
      waiting: "Waiting for the computer",
      yourTurn: "Your turn",
      done: "Done",
      stopped: "Stopped",
    })
  })

  test("main and timeline copy never use the old feature phrase", () => {
    const outputs = [
      ...samples.map(([, render]) => render()),
      ...Object.values(ComputerMainCopy.labels),
      ...Object.keys(pauses).map((reason) => ComputerMainCopy.pause({ reason: reason as Computer.PauseReason })),
      ...Object.keys(handoffs).map((reason) => ComputerMainCopy.handoff({ reason: reason as Computer.HandoffReason })),
      ...Object.keys(steps).map((action) => ComputerMainCopy.step({ action: action as Computer.ToolAction })),
      ...Object.entries(dict).flatMap(([key, value]) => (key.startsWith("ui.tool.computer.") ? [value] : [])),
    ]
    for (const output of outputs) expect(output).not.toMatch(/computer use/i)
  })
})

test("timeline copy includes every required step and uses the name placeholder", () => {
  const required = {
    looked: "Looked at {{app}}",
    clicked: "Clicked “{{target}}” in {{app}}",
    doubleClicked: "Double-clicked “{{target}}” in {{app}}",
    rightClicked: "Right-clicked “{{target}}” in {{app}}",
    typed: "Typed “{{text}}” in {{app}}",
    pressed: "Pressed {{keys}}",
    scrolled: "Scrolled {{direction}}",
    dragged: "Dragged in {{app}}",
    opened: "Opened {{app}}",
    switched: "Switched to {{app}}",
    read: "Read controls in {{app}}",
    waited: "Waited {{seconds}} s",
    yourTurn: "Your turn in {{app}}: {{reason}}",
    tookOver: "You took over ({{duration}})",
    resumed: "Resumed",
    blocked: "Couldn't use {{app}}: {{reason}}",
    screenshotRemoved: "Screenshot removed",
  }
  for (const [key, value] of Object.entries(required)) expect(dict[`ui.tool.computer.${key}`]).toBe(value)
  for (const key of [
    "name",
    "run",
    "blocked.terminal",
    "blocked.vector",
    "blocked.password",
    "blocked.security",
    "blocked.remote",
    "blocked.user",
    "blocked.company",
  ])
    expect(dict[`ui.tool.computer.${key}`]).toContain("{{name}}")
  for (const [key, value] of Object.entries(dict)) {
    if (key.startsWith("ui.tool.computer.")) expect(value).not.toContain(Hands.NAME)
  }
})
