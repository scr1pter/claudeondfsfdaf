import { describe, expect, test } from "bun:test"
import { ComputerKeys } from "@vectordevai/core/computer/keys"

const macos: ComputerKeys.Layout = { platform: "macos" }
const windows: ComputerKeys.Layout = { platform: "windows" }
const azerty: ComputerKeys.Layout = {
  platform: "windows",
  keys: {
    KeyQ: "a",
    KeyA: "q",
    KeyW: "z",
    KeyZ: "w",
    Digit2: { key: "é", shift: "2", altGraph: "~" },
    Digit4: { key: "'", shift: "4", altGraph: "{" },
    Digit0: { key: "à", shift: "0", altGraph: "@" },
  },
}
const qwerty: ComputerKeys.Layout = {
  platform: "windows",
  keys: { KeyQ: "q", KeyA: "a", Digit4: { key: "4", shift: "$" } },
}

describe("computer key floor", () => {
  test("the complete observed menu ancestry shares the shortcut safety floor", () => {
    for (const path of [
      ["File", "Services", "Summarize"],
      ["Tools", "Run Macro", "Apply"],
      ["Tools", "Scripts", "Apply"],
      ["Window", "Terminal", "New"],
      ["Web", "Inspector"],
      ["Enable", "Content"],
      ["Task", "Manager"],
      ["File", "Ｓｅｒｖｉｃｅｓ", "Apply"],
      ["Tools", "αScripts", "Apply"],
    ])
      expect(ComputerKeys.forbiddenMenu(path), path.join(" > ")).toBe(true)
    for (const path of [
      ["File", "Save"],
      ["Product", "Run"],
      ["Product", "Build"],
      ["Product", "Debug"],
      ["View", "Manuscripts"],
      ["Help", "Terminalia"],
    ])
      expect(ComputerKeys.forbiddenMenu(path), path.join(" > ")).toBe(false)
  })

  test("menu mutation paths refuse roots, malformed labels and Unicode disguises", () => {
    for (const path of [
      [],
      [""],
      ["   "],
      ["File", "Save\n"],
      ["File", "Save\u202e"],
      ["File", "Save\u200b"],
      ["File", "Save\ue000"],
      ["File", "x".repeat(257)],
      Array(31).fill("File"),
      ["ﬃ".repeat(86)],
      ["🙂".repeat(129)],
    ])
      expect(ComputerKeys.forbiddenMenu(path), JSON.stringify(path)).toBe(true)
    expect(ComputerKeys.forbiddenMenu(Array(30).fill("File"))).toBe(false)
    expect(ComputerKeys.forbiddenMenu(Array<string>(1))).toBe(true)
    expect(ComputerKeys.forbiddenMenu(["x".repeat(256)])).toBe(false)
    expect(ComputerKeys.forbiddenMenu(["🙂".repeat(128)])).toBe(false)
  })

  test("localized menu shortcuts retain the actual key safety and text classification floors", () => {
    expect(ComputerKeys.forbiddenMenu(["Développement", "Inspecteur Web"], ["Command", "Alt", "i"])).toBe(true)
    expect(ComputerKeys.forbiddenMenu(["Fichier", "Enregistrer"], ["Command", "s"])).toBe(false)
    expect(ComputerKeys.forbiddenMenu(["Édition", "Coller"], ["Command", "v"])).toBe(false)
    expect(ComputerKeys.forbiddenMenu(["Fichier", "Quitter"], ["Command", "Shift", "q"])).toBe(true)
    expect(ComputerKeys.forbiddenMenu(["Fichier", "Enregistrer"], [])).toBe(true)
    expect(ComputerKeys.forbiddenMenu(["Fichier", "Enregistrer"], ["Command", "KeyS"])).toBe(true)
    for (const combo of [
      ["Command", "v"],
      ["Control", "v"],
      ["Shift", "Insert"],
    ])
      expect(ComputerKeys.pasteCombo(combo)).toBe(true)
    for (const combo of [
      ["Command", "v"],
      ["Shift", "Insert"],
      ["Command", "x"],
      ["Control", "y"],
      ["Meta", "z"],
      ["Backspace"],
      ["Delete"],
      ["a"],
      ["Alt", "e"],
      ["🙂"],
      ["Cmd", "UnknownKey"],
      ["Cmd", "KeyS"],
      [],
    ])
      expect(ComputerKeys.menuTypesText(combo), combo.join("+")).toBe(true)
    for (const combo of [
      ["Command", "s"],
      ["Command", "r"],
      ["Command", "b"],
      ["Meta", "c"],
      ["Meta", "a"],
      ["ArrowLeft"],
      ["Enter"],
      ["Tab"],
      ["F5"],
    ])
      expect(ComputerKeys.menuTypesText(combo), combo.join("+")).toBe(false)
  })

  test("only text, navigation, editing and focused-app menu shortcuts pass (INV-S7)", () => {
    for (const combo of [
      ["a"],
      ["A"],
      ["é"],
      ["中"],
      ["İ"],
      ["?"],
      ["Space"],
      [" "],
      ["Shift", "a"],
      ["ArrowLeft"],
      ["Right"],
      ["PageDown"],
      ["Enter"],
      ["Tab"],
      ["Escape"],
      ["Backspace"],
      ["Delete"],
      ["Shift", "Delete"],
      ["Shift", "ArrowRight"],
      ["Control", "ArrowLeft"],
      ["Control", "Shift", "End"],
      ["Ctrl", "a"],
      ["Ctrl", "c"],
      ["Ctrl", "v"],
      ["Ctrl", "x"],
      ["Ctrl", "y"],
      ["Ctrl", "z"],
    ])
      expect(ComputerKeys.allowedCombo(combo, [], windows), combo.join("+")).toBe(true)
    for (const combo of [
      ["Command", "a"],
      ["⌘", "c"],
      ["Meta", "v"],
      ["Command", "Shift", "z"],
      ["Option", "ArrowLeft"],
    ])
      expect(ComputerKeys.allowedCombo(combo, [], macos), combo.join("+")).toBe(true)
    const save = { combo: ["Control", "s"], label: "Save" }
    expect(ComputerKeys.allowedCombo(["Ctrl", "s"], [], windows)).toBe(false)
    expect(ComputerKeys.allowedCombo(["Ctrl", "s"], [save], windows)).toBe(true)
    expect(ComputerKeys.allowedCombo(["Ctrl", "p"], [save], windows)).toBe(false)
    expect(ComputerKeys.allowedCombo(["F5"], [{ combo: ["F5"], label: "Refresh" }], windows)).toBe(true)
    expect(ComputerKeys.allowedCombo(["Shift", "F5"], [{ combo: ["F5"], label: "Refresh" }], windows)).toBe(false)
    expect(ComputerKeys.allowedCombo(["Alt", "F4"], [{ combo: ["Alt", "F4"], label: "Close" }], windows)).toBe(true)
    expect(ComputerKeys.allowedCombo(["Command", "q"], [{ combo: ["Meta", "q"], label: "Quit" }], macos)).toBe(true)
  })

  test("system, launcher, developer-tool and macro hotkeys refuse even when a menu advertises them", () => {
    for (const combo of [
      ["Windows", "r"],
      ["Meta", "l"],
      ["Win", "x"],
      ["Super", "s"],
      ["Alt", "Tab"],
      ["Alt", "Space"],
      ["Control", "Escape"],
      ["Shift", "Escape"],
      ["Ctrl", "Alt", "Delete"],
      ["Ctrl", "Alt", "End"],
      ["Ctrl", "Alt", "ArrowLeft"],
      ["Ctrl", "Shift", "i"],
      ["Ctrl", "Shift", "j"],
      ["Ctrl", "Shift", "c"],
      ["Alt", "F8"],
      ["Alt", "F11"],
      ["Alt", "Shift", "F11"],
      ["F12"],
      ["PrintScreen"],
      ["Power"],
      ["Sleep"],
      ["VolumeUp"],
      ["CapsLock"],
    ])
      expect(ComputerKeys.allowedCombo(combo, [{ combo, label: "App action" }], windows), combo.join("+")).toBe(false)
    for (const combo of [
      ["Command", "Space"],
      ["Command", "Tab"],
      ["Control", "Space"],
      ["Control", "ArrowUp"],
      ["Control", "ArrowDown"],
      ["Control", "ArrowLeft"],
      ["Control", "ArrowRight"],
      ["Control", "F2"],
      ["Control", "F3"],
      ["Control", "F4"],
      ["Control", "F5"],
      ["Control", "F6"],
      ["Control", "F7"],
      ["Control", "F8"],
      ["Command", "Option", "d"],
      ["Command", "Option", "Escape"],
      ["Command", "Shift", "q"],
      ["Command", "Control", "q"],
      ["Command", "Option", "i"],
      ["Command", "Option", "j"],
      ["Command", "Option", "c"],
      ["Command", "Shift", "3"],
      ["Command", "Shift", "4"],
      ["Command", "Shift", "5"],
      ["Command", "Shift", "6"],
      ["Command", "Shift", "#"],
      ["Command", "Shift", "$"],
      ["Command", "Shift", "%"],
      ["Command", "Shift", "^"],
    ])
      expect(ComputerKeys.allowedCombo(combo, [{ combo, label: "App action" }], macos), combo.join("+")).toBe(false)
    expect(
      ComputerKeys.allowedCombo(["Control", "F2"], [{ combo: ["Control", "F2"], label: "App action" }], windows),
    ).toBe(true)
  })

  test("observed custom macro and system menu bindings override ordinary editing and text defaults", () => {
    for (const label of [
      "Run Macro",
      "Macros…",
      "Run Script",
      "JavaScript Console",
      "Visual Basic Editor",
      "Services",
      "Open Terminal",
      "Developer Tools",
      "Task Manager",
      "Enable Content",
    ])
      for (const combo of [["Control", "v"], ["F7"], ["a"], ["ArrowLeft"]])
        expect(ComputerKeys.allowedCombo(combo, [{ combo, label }], windows), `${label}: ${combo.join("+")}`).toBe(
          false,
        )
    expect(ComputerKeys.allowedCombo(["Control", "v"], [{ combo: ["Control", "v"], label: "Paste" }], windows)).toBe(
      true,
    )
    expect(ComputerKeys.allowedCombo(["F7"], [{ combo: ["F7"], label: "Spelling" }], windows)).toBe(true)
    expect(ComputerKeys.allowedCombo(["F7"], [{ combo: ["F7"], label: "" }], windows)).toBe(false)
    expect(ComputerKeys.allowedCombo(["F7"], [{ combo: ["F7"], label: "Run\u202e Macro" }], windows)).toBe(false)
  })

  test("AZERTY physical positions are judged by their current logical meaning", () => {
    expect(ComputerKeys.resolve(["Control", "KeyQ"], azerty)).toEqual({ key: "a", modifiers: ["control"] })
    expect(ComputerKeys.allowedCombo(["Control", "KeyQ"], [], azerty)).toBe(true)
    expect(ComputerKeys.allowedCombo(["Control", "KeyQ"], [], qwerty)).toBe(false)
    expect(ComputerKeys.allowedCombo(["Control", "KeyA"], [], azerty)).toBe(false)
    expect(ComputerKeys.allowedCombo(["Control", "KeyA"], [], qwerty)).toBe(true)
    const quit = { combo: ["Control", "q"], label: "Quit" }
    expect(ComputerKeys.allowedCombo(["Control", "KeyA"], [quit], azerty)).toBe(true)
    expect(ComputerKeys.allowedCombo(["Control", "KeyA"], [quit], qwerty)).toBe(true)
    expect(ComputerKeys.resolve(["Control", "q"], azerty)).toEqual({ key: "q", modifiers: ["control"] })
    expect(ComputerKeys.resolve(["Shift", "Digit2"], azerty)).toEqual({ key: "2", modifiers: ["shift"] })
    expect(ComputerKeys.resolve(["AltGr", "Digit0"], azerty)).toEqual({ key: "@", modifiers: ["altgraph"] })
    expect(ComputerKeys.allowedCombo(["AltGr", "Digit0"], [], azerty)).toBe(true)
    expect(ComputerKeys.allowedCombo(["Control", "Alt", "Digit0"], [], azerty)).toBe(false)
    expect(ComputerKeys.allowedCombo(["AltGr", "@"], [], azerty)).toBe(false)
    expect(ComputerKeys.allowedCombo(["AltGr", "Digit0"], [], qwerty)).toBe(false)
    expect(
      ComputerKeys.allowedCombo(
        ["Command", "Shift", "Digit4"],
        [{ combo: ["Command", "Shift", "4"], label: "App action" }],
        { ...azerty, platform: "macos" },
      ),
    ).toBe(false)
    expect(
      ComputerKeys.allowedCombo(
        ["Command", "Shift", "Digit4"],
        [{ combo: ["Command", "Shift", "$"], label: "App action" }],
        { ...qwerty, platform: "macos" },
      ),
    ).toBe(false)
  })

  test("unknown layouts, missing character levels and malformed combinations refuse", () => {
    for (const combo of [
      [],
      ["Control"],
      ["Control", "Ctrl", "c"],
      ["a", "b"],
      ["Fn", "s"],
      ["a\n"],
      ["a\u202e"],
      ["constructor"],
      ["__proto__"],
      ["Control+s"],
      ["KeyA"],
    ])
      expect(ComputerKeys.allowedCombo(combo), combo.join("+")).toBe(false)
    expect(ComputerKeys.allowedCombo(["Meta", "s"], [{ combo: ["Meta", "s"], label: "Save" }])).toBe(false)
    expect(ComputerKeys.allowedCombo(["Shift", "Digit4"], [], { platform: "windows", keys: { Digit4: "4" } })).toBe(
      false,
    )
    expect(
      ComputerKeys.allowedCombo(["Shift", "Digit4"], [], { platform: "windows", keys: { Digit4: { key: "4" } } }),
    ).toBe(false)
    expect(ComputerKeys.allowedCombo(["Control", "AltGraph", "Digit0"], [], azerty)).toBe(false)
    expect(ComputerKeys.allowedCombo(["InventedKey"], [{ combo: ["InventedKey"], label: "App action" }], windows)).toBe(
      false,
    )
    expect(ComputerKeys.allowedCombo(["Numpad1"], [], { platform: "windows", keys: { Numpad1: "End" } })).toBe(true)
    expect(ComputerKeys.resolve(["CTRL", "Return"], windows)).toEqual({ key: "enter", modifiers: ["control"] })
    expect(ComputerKeys.resolve(["⌘", "⇧", "Z"], macos)).toEqual({ key: "z", modifiers: ["meta", "shift"] })
  })
})
