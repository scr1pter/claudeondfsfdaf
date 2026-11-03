import { describe, expect, test } from "bun:test"
import { filterSettingsGroups, isSettingsTab, settingsGroups, settingsItemCount } from "./settings-registry"

describe("settings registry", () => {
  test("keeps every settings page reachable", () => {
    expect(settingsItemCount(settingsGroups)).toBe(16)
    expect(settingsGroups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "account",
      "roadmap",
      "general",
      "memory",
      "local",
      "usage",
      "spend",
      "subagents",
      "providers",
      "models",
      "servers",
      "trust",
      "shortcuts",
      "notifications",
      "accessibility",
      "about",
    ])
  })

  test("puts Keyboard shortcuts in the Workspace group, found by what people call them", () => {
    const workspace = settingsGroups.find((group) => group.title === "Workspace")
    expect(workspace?.items.find((item) => item.value === "shortcuts")?.label).toBe("Keyboard shortcuts")
    for (const query of ["shortcuts", "keyboard", "keybindings", "keybinds", "hotkeys", "command palette"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toEqual([
        "shortcuts",
      ])
    expect(isSettingsTab("shortcuts")).toBe(true)
  })

  test("finds the Terminal shell picker under General", () => {
    for (const query of ["shell", "terminal", "bash", "zsh", "PowerShell"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toEqual(["general"])
  })

  test("has no Project rules, Appearance, Editor, Chat, Voice or Personalization page", () => {
    const items = settingsGroups.flatMap((group) => group.items)
    for (const removed of ["rules", "appearance", "editor", "chat", "voice", "personalization"]) {
      expect(isSettingsTab(removed)).toBe(false)
      expect(items.some((item) => item.value === removed)).toBe(false)
    }
    for (const label of ["Project rules", "Appearance", "Editor", "Chat", "Voice", "Personalization"])
      expect(items.some((item) => item.label === label)).toBe(false)
    // Their old vocabulary finds nothing rather than a page that is gone.
    for (const query of ["theme", "wrap", "spacing", "microphone", "instructions"])
      expect(filterSettingsGroups(query)).toEqual([])
  })

  test("searches labels, categories, and feature vocabulary", () => {
    expect(filterSettingsGroups("BYOK").flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "providers",
    ])
    expect(filterSettingsGroups("update").flatMap((group) => group.items.map((item) => item.value))).toEqual(["about"])
    expect(filterSettingsGroups("memory").flatMap((group) => group.items.map((item) => item.value))).toEqual(["memory"])
  })

  test("finds Deep research's runs, reports and sources under Memory", () => {
    for (const query of ["research", "Deep research", "reports", "sources", "citations"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toEqual(["memory"])
  })

  test("finds the Memory page, which replaced the rules page and the Local memory card, by what people call them", () => {
    for (const query of ["rules", "RULES.md", "MEMORY.md", "forget", "remember", "brain"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toEqual(["memory"])
  })

  test("puts Vector Local in the Personal group, found by what people call models they host and the network log", () => {
    expect(settingsGroups[0]!.items.find((item) => item.value === "local")?.label).toBe("Vector Local")
    for (const query of ["Vector Local", "ollama", "models you host", "network log", "what Vector sent", "web access"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toEqual(["local"])
    expect(isSettingsTab("local")).toBe(true)
  })

  test("finds spend limits by budget vocabulary", () => {
    expect(filterSettingsGroups("budget").flatMap((group) => group.items.map((item) => item.value))).toEqual(["spend"])
    expect(isSettingsTab("spend")).toBe(true)
  })

  test("finds the account page by sign-in and billing vocabulary", () => {
    for (const query of ["sign out", "profile", "billing", "Codium", "delete"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toContain("account")
    expect(isSettingsTab("account")).toBe(true)
  })

  test("finds repository trust by what people call it", () => {
    expect(settingsGroups.flatMap((group) => group.items).find((item) => item.value === "trust")?.label).toBe(
      "Repository trust",
    )
    for (const query of ["trust", "vector.json", "repository settings", "project settings"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toEqual(["trust"])
    expect(isSettingsTab("trust")).toBe(true)
  })

  test("finds the Roadmap vote by what people call it, right after Account (WP A34)", () => {
    const personal = settingsGroups[0]!.items.map((item) => item.value)
    expect(personal.indexOf("roadmap")).toBe(personal.indexOf("account") + 1)
    expect(settingsGroups[0]!.items.find((item) => item.value === "roadmap")?.label).toBe("Roadmap vote")
    for (const query of ["roadmap", "vote", "ballot", "nominate"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toEqual(["roadmap"])
    expect(isSettingsTab("roadmap")).toBe(true)
  })

  test("returns the complete registry for whitespace", () => {
    expect(filterSettingsGroups("   ")).toBe(settingsGroups)
  })

  test("validates tab values before navigation", () => {
    expect(isSettingsTab("providers")).toBe(true)
    expect(isSettingsTab("canvas")).toBe(false)
  })
})
