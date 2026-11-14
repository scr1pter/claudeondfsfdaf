import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { dict } from "../../i18n/en"
import { ComputerMention } from "./mention"

type App = Awaited<ReturnType<Computer.ComputerPlatform["apps"]>>[number]
const policy = {
  enabled: true,
  defaultAccess: "ask",
  apps: new Map<string, "allow" | "deny">(),
} as const satisfies Pick<Computer.ComputerPolicy, "enabled" | "defaultAccess" | "apps">

function app(name: string, options: Partial<App> = {}): App {
  return { key: `app:macos:example.${name.toLowerCase()}`, name, running: false, ...options }
}

describe("computer mention options", () => {
  test("the feature search includes every brand name and natural-language keyword", () => {
    const row = ComputerMention.featureOption({ supported: true, ready: true })!
    expect(row.display).toBe(`@${Hands.MENTION}`)
    expect(row.description).toBe("computer.mention.description")
    expect(dict[row.description]).toBeDefined()
    for (const word of [
      Hands.NAME,
      Hands.SHORT,
      Hands.MENTION,
      ...Hands.MENTION_KEYWORDS,
      "comp",
      "screen",
      "hands",
      "use my computer",
    ])
      expect(row.search.toLowerCase()).toContain(word.toLowerCase())
    expect(typeof row.search).toBe("string")
  })

  test("no @Hands row when supported is false", () => {
    expect(ComputerMention.featureOption({ supported: false, ready: false })).toBeUndefined()
    expect(ComputerMention.featureOption({ supported: false, ready: true })).toBeUndefined()
    expect(ComputerMention.featureOption({ supported: true, ready: false })).toMatchObject({
      ready: false,
      description: "computer.mention.off",
    })
    // What setup cannot fix shows its fixed sentence instead of offering setup.
    expect(
      ComputerMention.featureOption({ supported: true, ready: false, blocked: "computer.availability.company" }),
    ).toMatchObject({ ready: false, description: "computer.availability.company" })
    expect(
      ComputerMention.featureOption({ supported: true, ready: true, blocked: "computer.availability.company" }),
    ).toMatchObject({ ready: true, description: "computer.mention.description" })
  })

  test("never and blocked apps stay absent even when company policy allows their keys", () => {
    const terminal = app("Terminal", { running: true, rule: "never" })
    const blocked = app("Trading", { running: true, rule: "blocked" })
    const notes = app("Notes")
    expect(
      ComputerMention.appOptions([terminal, blocked, notes], {
        ...policy,
        apps: new Map([
          [terminal.key, "allow"],
          [blocked.key, "allow"],
        ]),
      }).map((row) => row.name),
    ).toEqual(["Notes"])
  })

  test("company denials are disabled using existing localized copy", () => {
    const resolved = app("Resolved", { rule: "company-deny" })
    const denied = app("Denied")
    const allowed = app("Allowed")
    const rows = ComputerMention.appOptions([resolved, denied, allowed], {
      ...policy,
      apps: new Map([
        [resolved.key, "allow"],
        [denied.key, "deny"],
        [allowed.key, "allow"],
      ]),
    })
    expect(rows.map((row) => row.disabled)).toEqual([
      "computer.mention.companyDenied",
      "computer.mention.companyDenied",
      undefined,
    ])
    expect(dict[rows[0].disabled!]).toBe("Your company doesn't allow this app")
    expect(rows).toHaveLength(3)
  })

  test("company off and default-deny remain ceilings; an exact allow only permits selection", () => {
    const allowed = app("Allowed")
    const other = app("Other")
    const rules = new Map<string, "allow" | "deny">([[allowed.key, "allow"]])
    const rows = ComputerMention.appOptions([allowed, other], { ...policy, apps: rules, defaultAccess: "deny" })
    expect(rows.map((row) => row.disabled)).toEqual([undefined, "computer.mention.companyDenied"])
    expect(ComputerMention.appOptions([allowed], { ...policy, apps: rules, enabled: false })[0].disabled).toBe(
      "computer.mention.companyDenied",
    )
    expect(Object.keys(rows[0]).sort()).toEqual(["display", "key", "name", "running", "search", "type"])
  })

  test("running apps rank first before the eight-row cap without reordering ties or mutating input", () => {
    const apps = [
      app("Blocked", { running: true, rule: "blocked" }),
      ...Array.from({ length: 9 }, (_, i) => app(`Installed${i}`)),
      app("RunningFirst", { running: true }),
      app("RunningSecond", { running: true, rule: "company-deny" }),
    ]
    const before = structuredClone(apps)
    const rows = ComputerMention.appOptions(apps, policy)
    expect(rows.map((row) => row.name)).toEqual([
      "RunningFirst",
      "RunningSecond",
      "Installed0",
      "Installed1",
      "Installed2",
      "Installed3",
      "Installed4",
      "Installed5",
    ])
    expect(apps).toEqual(before)
    expect(policy.apps.size).toBe(0)
    rows[0].name = "Changed view"
    expect(apps).toEqual(before)
  })

  test("display names are safe but opaque identity keys are preserved exactly", () => {
    const key = "app:windows:exe:publisher|product|binary.exe"
    const rows = ComputerMention.appOptions(
      [
        app("No\u202e\u200b\u2066\ufefftes", { key, icon: "https://example.com/untrusted.png" }),
        app("\u200b\u202e"),
        app("x".repeat(300), { icon: "data:image/png;base64,aGVsbG8=" }),
      ],
      { ...policy, apps: new Map([[key, "deny"]]) },
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      key,
      name: "Notes",
      display: "@Notes",
      search: "Notes",
      disabled: "computer.mention.companyDenied",
    })
    expect(rows[0].icon).toBeUndefined()
    expect(rows[1].name).toHaveLength(256)
    expect(rows[1].icon).toBe("data:image/png;base64,aGVsbG8=")
    expect(rows[0].search).not.toContain(key)
  })
})

describe("computer mention markers", () => {
  test("feature and app markers are exact hints with no grant fields", () => {
    const feature = {
      content: `@${Hands.MENTION}`,
      start: 0,
      end: 6,
      approved: true,
      permission: "allow",
      app: undefined,
    }
    expect(ComputerMention.marker(feature)).toEqual({ [Hands.MARKER]: { kind: "feature" } })
    const input = {
      content: "@Notes",
      grant: { always: true },
      app: { key: "app:macos:com.apple.notes", name: "Notes", approved: true, access: "allow", teamId: "spoofed" },
    }
    const metadata = ComputerMention.marker(input)
    expect(metadata).toEqual({ [Hands.MARKER]: { kind: "app", key: input.app.key, name: "Notes" } })
    expect(Schema.is(Computer.MentionMarker)(metadata[Hands.MARKER])).toBe(true)
    input.app.name = "Changed later"
    expect(metadata[Hands.MARKER]).toEqual({ kind: "app", key: "app:macos:com.apple.notes", name: "Notes" })
  })

  test("app marker sanitizes only the name and retains the exact opaque key", () => {
    const key = "app:windows:exe:microsoft corporation|notes|notes.exe"
    expect(ComputerMention.marker({ app: { key, name: `No\u202etes${"x".repeat(300)}` } })).toEqual({
      [Hands.MARKER]: { kind: "app", key, name: `Notes${"x".repeat(251)}` },
    })
  })
})

describe("computer mention examples", () => {
  const resolve = (template: string, params: Record<string, string>) =>
    template.replace(/{{(\w+)}}/g, (_, key: string) => params[key] ?? "")

  test("a leading exact @Hands becomes one feature pill with the rest as text at the right offsets", () => {
    const text = resolve(dict["computer.onboarding.example.receipts"], { mention: Hands.MENTION, app: "Numbers" })
    const parts = ComputerMention.examplePrompt(text)
    const mention = `@${Hands.MENTION}`
    expect(parts).toEqual([
      { type: "computer", content: mention, start: 0, end: mention.length },
      { type: "text", content: text.slice(mention.length), start: mention.length, end: text.length },
    ])
    expect(parts.map((part) => ("content" in part ? part.content : "")).join("")).toBe(text)
    expect(parts.some((part) => part.type === "computer" && "app" in part)).toBe(false)
    expect(ComputerMention.examplePrompt(mention)).toEqual([
      { type: "computer", content: mention, start: 0, end: mention.length },
    ])
  })

  test("app names, other words and a mention that is not leading stay plain text", () => {
    for (const text of [
      resolve(dict["computer.onboarding.example.chart"], { app: "Excel", destinationApp: "PowerPoint" }),
      `@${Hands.MENTION}ome open Numbers`,
      `@${Hands.MENTION}_x open Numbers`,
      `@${Hands.MENTION.toLowerCase()} open Numbers`,
      `please @${Hands.MENTION} open Numbers`,
      "",
    ])
      expect(ComputerMention.examplePrompt(text)).toEqual([{ type: "text", content: text, start: 0, end: text.length }])
  })
})
