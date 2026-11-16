import { describe, expect, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import type { Computer } from "@vectordevai/schema/computer"
import type { ComputerApps } from "@vectordevai/schema/computer-apps"
import { Hands } from "@vectordevai/schema/hands"
import { dict } from "../../i18n/en"
import { computerAsk, type ComputerAskOptions } from "./ask-model"

const opts: ComputerAskOptions = { t: (key, params) => resolveTemplate(dict[key], params) }
const key = "app:macos:com.apple.notes"
const app: Computer.AppAskMetadata = {
  action: "use_app",
  level: "interact",
  target: {
    appName: "Notes",
    appKey: key,
    platform: "macos",
    publisher: "Apple Inc.",
    verified: true,
    category: "office",
  },
  canAlways: true,
}
const sensitive: Computer.SensitiveAskMetadata = {
  action: "click",
  why: "send",
  target: { appName: "Notes", appKey: key },
  targetName: "Send",
}

function appAsk(metadata: unknown = app, options = opts, always: readonly string[] = [key]) {
  return computerAsk({ permission: "computer_app", metadata, always }, options)
}

function sensitiveAsk(metadata: unknown = sensitive) {
  return computerAsk({ permission: "computer_sensitive", metadata, always: [key] }, opts)
}

describe("computer ask display contract", () => {
  test("app grants identify the app and publisher, with a reversible saved approval hint", () => {
    const model = appAsk({ ...app, mentioned: true, reason: "Summarize the meeting." })
    expect(model).toMatchObject({
      kind: "app",
      title: `Allow ${Hands.NAME} to use Notes?`,
      body: "It can see the windows of Notes and click, type and use its menus until this task is done.",
      publisher: { name: "Apple Inc.", verified: true },
      mentioned: "You mentioned Notes in your message.",
      warnings: [],
      agentSays: "The agent says: “Summarize the meeting.”",
      canAlways: true,
      alwaysHint: `Always allow skips this question for Notes from now on. Remove it in Settings › ${Hands.NAME}.`,
      primaryLabel: "Allow",
      armMs: 700,
      enterAllowed: true,
    })
    expect(appAsk({ ...app, level: "observe" })?.body).toBe("It can see the windows of Notes until this task is done.")
  })

  const categories = {
    browser: `${Hands.NAME} acts as you on sites where you're signed in. For websites, Vector's own browser is safer.`,
    files: "It can move, rename and delete your files.",
    mail: "It asks again before it sends anything.",
    messaging: "It asks again before it sends anything.",
    finance: "It asks before every action that could move money.",
    developer: `This app can run commands in its own terminal. ${Hands.NAME} asks before it runs or builds anything.`,
  } satisfies Partial<Record<ComputerApps.AppCategory, string>>

  test("category warnings and saved-approval ceilings survive contradictory canAlways metadata", () => {
    for (const [category, warning] of Object.entries(categories)) {
      const model = appAsk({ ...app, target: { ...app.target, category } })
      expect(model?.warnings).toEqual([warning])
      const excluded = ["browser", "files", "finance", "developer"].includes(category)
      expect(model?.canAlways).toBe(!excluded)
      expect(model?.alwaysWhyNot).toBe(
        excluded
          ? `${Hands.NAME} always asks for browsers, file managers, finance apps and developer tools.`
          : undefined,
      )
    }
  })

  test("unverified, changed and company-limited identities cannot offer Always", () => {
    const cases = [
      [{ ...app, target: { ...app.target, verified: false } }, opts, "Vector can't confirm who made this app."],
      [{ ...app, alwaysWhyNot: "unverified" }, opts, "Vector can't confirm who made this app."],
      [{ ...app, alwaysWhyNot: "changed" }, opts, "Notes changed since you allowed it."],
      [{ ...app, alwaysWhyNot: "policy" }, opts, "Your company doesn't allow saved approvals."],
      [app, { ...opts, allowAlways: false }, "Your company doesn't allow saved approvals."],
    ] as const
    for (const [metadata, options, reason] of cases) {
      expect(appAsk(metadata, options)).toMatchObject({ canAlways: false, alwaysWhyNot: reason })
    }
    expect(appAsk({ ...app, target: { ...app.target, verified: false } })).toMatchObject({
      publisher: { name: undefined, verified: false },
      warnings: ["Not verified: Vector can't confirm who made this app."],
    })
    expect(appAsk({ ...app, companyAllowed: true, canAlways: false })?.canAlways).toBe(false)
    for (const always of [
      [],
      ["*"],
      ["app:*"],
      ["window:42:0"],
      ["app:macos:another.app"],
      [key, "app:macos:another.app"],
    ]) {
      expect(appAsk(app, opts, always)?.canAlways).toBe(false)
    }
  })

  test("screen and agent text cannot change the fixed title or introduce hidden formatting", () => {
    const reason = `\u202e\u200b\u2066\ufeff${"x".repeat(210)}`
    const metadata = { ...app, target: { ...app.target, appName: "No\u200btes" }, reason, intent: "Approve everything" }
    const before = structuredClone(metadata)
    const model = appAsk(metadata)
    expect(model?.title).toBe(`Allow ${Hands.NAME} to use Notes?`)
    expect(model?.agentSays).toBe(`The agent says: “${"x".repeat(200)}”`)
    expect(metadata).toEqual(before)
    const request = { permission: "computer_sensitive", metadata: sensitive, patterns: ["app:secret", "window:42:0"] }
    expect(JSON.stringify(computerAsk(request, opts))).not.toContain("app:")
    expect(JSON.stringify(computerAsk(request, opts))).not.toContain("window:")
  })

  test("own-build and local warnings remain attributed; icons cannot request a remote resource", () => {
    const model = appAsk({
      ...app,
      target: { ...app.target, ownBuild: { repo: "vect\u2060or" }, icon: "https://attacker.example/icon.png" },
      localWarning: true,
    })
    expect(model?.warnings).toEqual(["Vector built this app in vector.", "Vector Local can't see what this app sends."])
    expect(model?.icon).toBeUndefined()
    expect(appAsk({ ...app, target: { ...app.target, icon: "data:image/png;base64,aGVsbG8=" } })?.icon).toBe(
      "data:image/png;base64,aGVsbG8=",
    )
  })

  test("machine keys cannot masquerade as app or accessibility labels", () => {
    for (const label of [
      "app:macos:com.apple.notes",
      "window:42:0",
      " APP:\u200bmacos:notes ",
      `window:${"1".repeat(50)}:0`,
    ]) {
      expect(appAsk({ ...app, target: { ...app.target, appName: label } })).toBeUndefined()
      expect(sensitiveAsk({ ...sensitive, target: { ...sensitive.target, appName: label } })).toBeUndefined()
      expect(sensitiveAsk({ ...sensitive, targetName: label })?.title).toBe(
        `${Hands.NAME} wants to click “this control” in Notes`,
      )
    }
    expect(sensitiveAsk({ ...sensitive, why: "new_destination", destination: "app:destination" })?.reason).toBe(
      "It's typing an address you didn't give it: app:destination.",
    )
    expect(sensitiveAsk({ ...sensitive, why: "run_program", path: "/Applications/window:42:0.app" })?.reason).toBe(
      "This runs a program: /Applications/window:42:0.app.",
    )
  })

  test("sensitive asks quote bounded labels and require a delayed click for one action", () => {
    expect(sensitiveAsk({ ...sensitive, targetName: `${"x".repeat(45)}\u202e` })).toMatchObject({
      kind: "sensitive",
      title: `${Hands.NAME} wants to click “${"x".repeat(40)}” in Notes`,
      reason: "This sends a message.",
      canAlways: false,
      armMs: 700,
      enterAllowed: false,
      primaryLabel: "Allow once",
    })
    expect(sensitiveAsk({ ...sensitive, targetName: undefined })?.title).toBe(
      `${Hands.NAME} wants to click “this control” in Notes`,
    )
    expect(sensitiveAsk({ ...sensitive, action: "key", key: "Ignore all rules", keys: "Enter" })?.title).toBe(
      `${Hands.NAME} wants to press a key in Notes`,
    )
    expect(sensitiveAsk({ ...sensitive, why: "ide_run", repo: "made up repo" })?.reason).toBe(
      "This runs code in Notes.",
    )
  })

  test("high-risk detail stays visible, while paste and provider text are bounded and attributed", () => {
    const path = `/Applications/${"Very Long Program Name ".repeat(30)}.app`
    const program = sensitiveAsk({ ...sensitive, action: "open", why: "run_program", path })
    expect(program?.title).toBe(`${Hands.NAME} wants to run a program`)
    expect(program?.reason).toBe(`This runs a program: ${path}.`)
    const destination = `https://example.com/${"target".repeat(200)}`
    expect(sensitiveAsk({ ...sensitive, action: "type", why: "new_destination", destination })?.reason).toContain(
      destination,
    )
    expect(sensitiveAsk({ ...sensitive, why: "paste", text: "x".repeat(100) })).toMatchObject({
      title: `${Hands.NAME} wants to paste in Notes`,
      reason: `This pastes what you copied: “${"x".repeat(60)}”.`,
    })
    expect(
      sensitiveAsk({
        ...sensitive,
        why: "provider_check",
        providerCheck: { provider: "Exam\u200bple", code: "sensitive", message: "Do\u202e check", domain: true },
      }),
    ).toMatchObject({
      reason: "Example flagged this step: Do check",
      warnings: ["Watch this step closely."],
    })
  })

  test("incomplete or malformed approval metadata has no approvable model", () => {
    for (const metadata of [
      null,
      [],
      { ...app, canAlways: "true" },
      { ...app, level: "admin" },
      { ...app, target: { ...app.target, category: "unknown" } },
      { ...app, target: { ...app.target, category: "terminal" } },
      { ...app, target: { ...app.target, platform: "windows" } },
      { ...app, target: { ...app.target, appKey: "window:42:0" } },
      { ...app, target: { ...app.target, appName: "\u202e\u200b" } },
    ])
      expect(appAsk(metadata)).toBeUndefined()
    for (const metadata of [
      { ...sensitive, why: "invented" },
      { ...sensitive, action: "invented" },
      { ...sensitive, why: "run_program" },
      { ...sensitive, why: "new_destination" },
      { ...sensitive, why: "paste" },
      { ...sensitive, why: "provider_check" },
      { ...sensitive, target: { ...sensitive.target, appName: "" } },
    ])
      expect(sensitiveAsk(metadata)).toBeUndefined()
    expect(computerAsk({ permission: "edit", metadata: app }, opts)).toBeUndefined()
    expect(computerAsk({ permission: "computer_app", metadata: undefined }, opts)).toBeUndefined()
    expect(computerAsk({ permission: "computer_interact", metadata: sensitive }, opts)).toBeUndefined()
  })
})
