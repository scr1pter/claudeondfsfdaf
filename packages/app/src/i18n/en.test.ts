import { describe, expect, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { dict } from "./en"

// These surfaces name the feature, rather than the computer or the app it is using.
const featureNames = [
  "computer.name",
  "computer.availability.desktop",
  "computer.availability.macos",
  "computer.availability.company",
  "computer.availability.mayTrain",
  "computer.availability.localNone",
  "computer.availability.interactive",
  "computer.availability.elevated",
  "computer.availability.wsl",
  "computer.availability.permissions",
  "computer.availability.disabled",
  "computer.availability.engine",
  "computer.availability.reader",
  "computer.onboarding.description",
  "computer.onboarding.turnOn",
  "computer.onboarding.macos.instruction",
  "computer.onboarding.macos.grantReset",
  "computer.onboarding.macos.mainAppGrant",
  "computer.onboarding.macos.recordingReminder",
  "computer.onboarding.helperFailed",
  "computer.onboarding.windows.description",
  "computer.mention.setupFirst",
  "computer.mention.shell",
  "computer.mention.command",
  "computer.mention.quick",
  "computer.mention.research",
  "computer.ask.app.title",
  "computer.ask.category.browser",
  "computer.ask.category.developer",
  "computer.ask.always.hint",
  "computer.ask.always.category",
  "computer.ask.sensitive.click",
  "computer.ask.sensitive.doubleClick",
  "computer.ask.sensitive.rightClick",
  "computer.ask.sensitive.type",
  "computer.ask.sensitive.key",
  "computer.ask.sensitive.keyUnknown",
  "computer.ask.sensitive.scroll",
  "computer.ask.sensitive.drag",
  "computer.ask.sensitive.useApp",
  "computer.ask.sensitive.runProgram",
  "computer.ask.sensitive.paste",
  "computer.pointer.title",
  "computer.checkIn.steps",
  "computer.checkIn.time",
  "computer.checkIn.away",
  "computer.working.foregroundFallback",
  "computer.pause.helper",
  "computer.finish.userStopped",
  "computer.timeline.title",
  "computer.tasks.title",
  "computer.settings.use",
  "computer.settings.keepAwake.description",
  "computer.settings.stop.description",
  "computer.settings.readFailed",
  "computer.settings.saveFailed",
  "computer.settings.company.description",
  "computer.settings.screenshots.confirm.description",
  "computer.settings.docs",
  "computer.share.help",
  "computer.community.description",
  "computer.community.installed",
  "computer.blocked.terminal",
  "computer.blocked.vector",
  "computer.blocked.passwords",
  "computer.blocked.security",
  "computer.blocked.remote",
  "computer.blocked.user",
  "computer.blocked.company",
] as const satisfies readonly (keyof typeof dict)[]

const parameterless = [
  "toast.permissions.autoaccept.on.description",
  "settings.permissions.tool.computer_app.title",
  "settings.permissions.tool.computer_app.description",
  "settings.permissions.tool.computer_sensitive.title",
  "settings.permissions.tool.computer_sensitive.description",
] as const

describe("computer English copy", () => {
  test("feature names stay injectable across onboarding, asks, status and settings", () => {
    for (const key of featureNames) {
      expect(dict[key]).toContain("{{name}}")
      expect(resolveTemplate(dict[key], { name: "Nimbus" })).toContain("Nimbus")
    }
    const fixedNames = [Hands.NAME, Hands.SHORT, `@${Hands.MENTION}`]
    const copy = Object.entries(dict).filter(([key]) => key.startsWith("computer."))
    expect(copy.filter(([, text]) => fixedNames.some((name) => text.includes(name)))).toEqual([])
  })

  test("renamed features, mentions and app names resolve through the renderer's template resolver", () => {
    expect(resolveTemplate(dict["computer.ask.app.title"], { name: "Nimbus", app: "Ledger" })).toBe(
      "Allow Nimbus to use Ledger?",
    )
    expect(resolveTemplate(dict["computer.ask.sensitive.click"], { name: "Nimbus", app: "Mail", label: "Send" })).toBe(
      "Nimbus wants to click “Send” in Mail",
    )
    expect(
      resolveTemplate(dict["computer.timeline.title"], {
        name: "Nimbus",
        apps: "Numbers, Calculator",
        count: 23,
        duration: "2m 10s",
      }),
    ).toBe("Nimbus · Numbers, Calculator · 23 actions · 2m 10s")
    expect(resolveTemplate(dict["computer.onboarding.example.receipts"], { mention: "Nimbus", app: "Numbers" })).toBe(
      "@Nimbus put my October receipts into a Numbers table",
    )
    expect(
      resolveTemplate(dict["computer.onboarding.example.simulator"], { mention: "Nimbus", app: "iOS Simulator" }),
    ).toBe("@Nimbus open the app you just built in the iOS Simulator and tap through sign-up")
    expect(
      resolveTemplate(dict["computer.onboarding.example.chart"], { app: "Excel", destinationApp: "PowerPoint" }),
    ).toBe("@Excel copy the Q3 chart into my PowerPoint deck")
    for (const key of [
      "computer.onboarding.example.receipts",
      "computer.onboarding.example.simulator",
      "computer.community.description",
    ] as const)
      expect(dict[key]).toContain("@{{mention}}")
  })

  test("availability explains the supported platform and each safety restriction", () => {
    const required = [
      ["computer.availability.desktop", "Vector desktop app on macOS and Windows"],
      ["computer.availability.desktop", "Open this conversation there to continue."],
      ["computer.availability.macos", "macOS 14 or later"],
      ["computer.availability.company", "Your company turned off"],
      ["computer.availability.mayTrain", "can't send your screen to a model that may train on it"],
      ["computer.availability.localNone", "Web access is None"],
      ["computer.availability.localNone", "could reach the network without Vector seeing it"],
      ["computer.availability.localNone", "Change Web access in Vector Local"],
      ["computer.availability.guest", "Only the owner of this computer"],
      ["computer.availability.interactive", "only available in a conversation you're in"],
      ["computer.availability.elevated", "running as administrator"],
      ["computer.availability.elevated", "Restart Vector normally"],
      ["computer.availability.wsl", "run on Windows, not inside WSL"],
      ["computer.availability.permissions", "Open Settings › {{name}} to finish setup"],
      ["computer.availability.disabled", "turned off for this conversation"],
      ["computer.availability.reader", "{{model}} can't see the screen"],
      ["computer.availability.reader", "will read app controls instead"],
      ["computer.availability.reader", "A model that can see images works best"],
      ["computer.status.linux", "Not available on Linux yet"],
      ["computer.mention.off", "Off — set it up"],
      ["computer.availability.engine", "not available on this engine"],
      ["computer.availability.engine", "current desktop engine, or remove the mention"],
      ["computer.mention.shell", "Shell commands can't use {{name}}"],
      ["computer.mention.command", "Slash commands can't use {{name}}"],
      ["computer.mention.quick", "Quick mode can't use {{name}}"],
      ["computer.mention.research", "Deep research can't use {{name}}"],
    ] as const
    for (const [key, text] of required) expect(dict[key]).toContain(text)
  })

  test("sensitive reasons describe the actual consequence and preserve full destination details", () => {
    const reasons = [
      ["computer.ask.reason.send", "This sends a message."],
      ["computer.ask.reason.delete", "This deletes something."],
      ["computer.ask.reason.buy", "This may spend money."],
      ["computer.ask.reason.submit", "This submits a form."],
      ["computer.ask.reason.account", "This changes an account or accepts terms."],
      ["computer.ask.reason.settings", "This changes a setting."],
      ["computer.ask.reason.disruptive", "This quits an app or logs you out."],
      ["computer.ask.reason.sensitiveDomain", "Watch this step closely."],
      [
        "computer.ask.reason.flaggedScreen",
        "Text on screen looks like instructions to an AI. Check that this step is what you asked for.",
      ],
    ] as const
    for (const [key, expected] of reasons) expect(dict[key]).toBe(expected)
    expect(
      resolveTemplate(dict["computer.ask.reason.runProgram"], {
        path: "/Applications/Example.app/Contents/MacOS/Example",
      }),
    ).toBe("This runs a program: /Applications/Example.app/Contents/MacOS/Example.")
    expect(resolveTemplate(dict["computer.ask.reason.paste"], { text: "Receipt total: $42" })).toBe(
      "This pastes what you copied: “Receipt total: $42”.",
    )
    expect(
      resolveTemplate(dict["computer.ask.reason.newDestination"], {
        destination: "https://example.test/full/path?item=42",
      }),
    ).toBe("It's typing an address you didn't give it: https://example.test/full/path?item=42.")
    expect(resolveTemplate(dict["computer.ask.reason.runCode"], { repo: "receipts-app" })).toBe(
      "This runs code in receipts-app.",
    )
    expect(
      resolveTemplate(dict["computer.ask.reason.provider"], {
        provider: "Provider",
        message: "Review the destination",
      }),
    ).toBe("Provider flagged this step: Review the destination")
    expect(dict["computer.action.allowOnce"]).toBe("Allow once")
    expect(dict["computer.action.deny"]).toBe("Deny")
  })

  test("onboarding explains visibility, prohibited apps, operating-system grants and stopping", () => {
    expect(dict["computer.onboarding.description"]).toContain("asks before it uses each app")
    expect(dict["computer.onboarding.description"]).toContain("again before anything you can't undo")
    expect(dict["computer.onboarding.screenPrivacy"]).toContain("goes to the model you picked")
    expect(dict["computer.onboarding.screenPrivacy"]).toContain("Other windows and notifications are blacked out")
    for (const limit of [
      "terminals",
      "Vector itself",
      "password managers",
      "security settings",
      "never types passwords",
    ])
      expect(dict["computer.onboarding.limits"]).toContain(limit)
    expect(dict["computer.onboarding.indicators"]).toContain(Hands.BANNER)
    expect(dict["computer.onboarding.indicators"]).toContain("Press Esc or Stop at any time")
    expect(dict["computer.onboarding.preview"]).toContain("isn't signed by its developer yet")
    expect(dict["computer.onboarding.preview"]).toContain("again after each update")
    expect(dict["computer.onboarding.macos.instruction"]).toBe("In each list, turn on {{name}}.")
    expect(dict["computer.onboarding.macos.grantReset"]).toContain("select {{name}}, click –, then turn it on again")
    expect(dict["computer.onboarding.macos.mainAppGrant"]).toContain("Turn it off for Vector in the same list")
    expect(dict["computer.onboarding.macos.recordingReminder"]).toContain("will pause and let you answer")
    expect(dict["computer.onboarding.helperFailed"]).toContain("Reinstall Vector, then try again")
    expect(dict["computer.onboarding.windows.description"]).toContain("can't use apps running as administrator")
    expect(dict["computer.onboarding.windows.description"]).toContain("Your PC has to stay unlocked")
    expect(dict["computer.onboarding.windows.captureBlocked"]).toContain("Open Privacy & security")
  })

  test("handoffs and pauses explain how the person regains and resumes control", () => {
    const reasons = {
      credential: ["computer.handoff.reason.credential", "enter your password or code"],
      sign_in: ["computer.handoff.reason.signIn", "sign in"],
      captcha: ["computer.handoff.reason.captcha", "complete the CAPTCHA"],
      payment_details: ["computer.handoff.reason.payment", "enter your payment details"],
      admin_prompt: ["computer.handoff.reason.adminPrompt", "answer the administrator prompt"],
      security_prompt: ["computer.handoff.reason.security", "answer the security prompt"],
      capture_confirm: ["computer.handoff.reason.recording", "answer the screen recording prompt"],
      elevated: ["computer.handoff.reason.elevated", "finish this step in the app running as administrator"],
      site_permission: ["computer.handoff.reason.sitePermission", "answer the site's permission prompt"],
      download: ["computer.handoff.reason.download", "decide whether to keep or open the download"],
      extension: ["computer.handoff.reason.extension", "decide whether to install the extension"],
      protocol_handler: ["computer.handoff.reason.protocolHandler", "decide whether to open the linked app"],
      macros: ["computer.handoff.reason.macros", "decide whether to enable the document's content or macros"],
      other: ["computer.handoff.reason.other", "finish this step yourself"],
    } as const satisfies Record<Computer.HandoffReason, readonly [keyof typeof dict, string]>
    for (const [key, reason] of Object.values(reasons)) {
      expect(dict[key]).toBe(reason)
      expect(resolveTemplate(dict["computer.handoff.title"], { app: "Numbers", reason: dict[key] })).toBe(
        `Your turn in Numbers: ${reason}. Press Continue when you're done.`,
      )
      expect(resolveTemplate(dict["computer.handoff.titleWithoutApp"], { reason: dict[key] })).toBe(
        `Your turn: ${reason}. Press Continue when you're done.`,
      )
    }
    expect(dict["computer.pause.control"]).toBe("Paused — you have control")
    expect(dict["computer.pause.inputDetection"]).toContain("can't tell whether you're using the mouse and keyboard")
    expect(dict["computer.pause.secureDesktop"]).toContain("Windows is showing a security screen")
    expect(dict["computer.pause.overlay"]).toBe("Paused — the screen indicator is unavailable")
    expect(dict["computer.pause.secureTyping.description"]).toContain("Vector can't hear Esc")
    expect(dict["computer.pause.secureTyping.description"]).toContain("then press Resume")
    expect(dict["computer.pause.locked"]).toBe("Paused while your computer was locked")
    expect(dict["computer.checkIn.away"]).toContain("paused so your computer can lock")
    expect(dict["computer.action.continue"]).toBe("Continue")
    expect(dict["computer.action.resume"]).toBe("Resume")
    expect(dict["computer.action.stop"]).toBe("Stop")
  })

  test("app approval, blocking, keep-awake and screenshot copy retain their safety limits", () => {
    expect(dict["computer.ask.app.body"]).toContain("until this task is done")
    expect(dict["computer.ask.unverified"]).toContain("can't confirm who made this app")
    expect(dict["computer.ask.category.browser"]).toContain("acts as you on sites where you're signed in")
    expect(dict["computer.ask.category.files"]).toContain("move, rename and delete your files")
    expect(dict["computer.ask.category.messaging"]).toContain("asks again before it sends anything")
    expect(dict["computer.ask.category.finance"]).toContain("every action that could move money")
    expect(dict["computer.ask.category.developer"]).toContain("asks before it runs or builds anything")
    expect(dict["computer.ask.localNetwork"]).toBe("Vector Local can't see what this app sends.")
    expect(dict["computer.ask.always.hint"]).toContain("Remove it in Settings › {{name}}")
    expect(dict["computer.ask.always.company"]).toContain("doesn't allow saved approvals")
    expect(dict["computer.ask.always.category"]).toContain(
      "always asks for browsers, file managers, finance apps and developer tools",
    )
    expect(dict["computer.ask.always.changed"]).toBe("{{app}} changed since you allowed it.")
    expect(dict["computer.blocked.terminal"]).toContain("Vector uses its own terminal instead")
    expect(dict["computer.blocked.vector"]).toContain("can't use Vector itself")
    expect(dict["computer.blocked.passwords"]).toContain("can't use password managers or Keychain")
    expect(dict["computer.blocked.security"]).toContain("can't approve security or administrator prompts")
    expect(dict["computer.blocked.security"]).toContain("Please do this step yourself")
    expect(dict["computer.blocked.remote"]).toContain("can't use remote desktop or virtual machine windows")
    expect(dict["computer.settings.keepAwake.description"]).toContain("your computer won't lock by itself")
    expect(dict["computer.settings.keepAwake.description"]).toContain("If you step away, lock it")
    expect(dict["computer.settings.company.description"]).toContain(
      "still asks before using an app your company allows",
    )
    expect(dict["computer.settings.screenshots.description"]).toContain(
      "on this computer and go only to the model you picked",
    )
    expect(dict["computer.settings.screenshots.confirm.description"]).toContain("This can't be undone")
    expect(dict["computer.share.automatic"]).toBe("Auto-shares never include screenshots.")
    expect(dict["computer.share.description"]).toContain("Only this manual share can include screenshots")
    expect(dict["computer.share.description"]).toContain("live share updates and invited guests never receive them")
  })

  test("parameterless permission callers receive the current name and keep the once-only rule", () => {
    for (const key of parameterless) {
      expect(dict[key]).toContain(Hands.NAME)
      expect(dict[key]).not.toContain("{{")
    }
    expect(dict["toast.permissions.autoaccept.on.description"]).toBe(
      "Permission requests are approved automatically. Vector Cloud account changes, sensitive browser actions, " +
        `${Hands.NAME} and repeated tool calls still ask.`,
    )
    expect(dict["settings.permissions.tool.computer_app.description"]).toContain("still asks before using each app")
    expect(dict["settings.permissions.tool.computer_sensitive.description"]).toContain("before every sensitive action")
    expect(dict["settings.permissions.tool.computer_sensitive.description"]).toContain("apply once and are never saved")
  })

  test("the Tasks card counts one action in the singular and links asks to the conversation", () => {
    expect(resolveTemplate(dict["computer.tasks.action"], { count: 1 })).toBe("1 action")
    expect(resolveTemplate(dict["computer.tasks.actions"], { count: 23 })).toBe("23 actions")
    expect(dict["computer.tasks.reviewAsk"]).toBe("Review in the conversation")
    expect(resolveTemplate(dict["computer.tasks.waiting"], { title: "Receipts" })).toBe(
      "Waiting for the computer: Receipts is using it",
    )
    expect(resolveTemplate(dict["computer.working.app"], { app: "Numbers" })).toBe("Using Numbers")
    expect(dict["computer.working.waiting"]).toBe("Waiting for the computer")
  })

  test("feature copy and permission descriptions do not reintroduce the old feature name", () => {
    const copy = [
      ...Object.entries(dict).filter(([key]) => key.startsWith("computer.")),
      ...parameterless.map((key) => [key, dict[key]] as const),
    ]
    expect(copy.filter(([, text]) => /computer use/i.test(text))).toEqual([])
  })
})
