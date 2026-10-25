import { describe, expect, test } from "bun:test"
import { parseKeyPress } from "./browser-agent-keys"

describe("parseKeyPress", () => {
  test("reads modifiers by their usual names, and Mod as Meta on macOS and Control elsewhere", () => {
    expect(parseKeyPress("Ctrl+Option+Cmd+Shift+k", "linux")).toEqual({
      kind: "key",
      keyCode: "K",
      modifiers: ["control", "alt", "meta", "shift"],
      char: false,
      typesCharacter: false,
    })
    expect(parseKeyPress("Mod+Enter", "darwin")).toMatchObject({ keyCode: "Enter", modifiers: ["meta"] })
    expect(parseKeyPress("Mod+Enter", "win32")).toMatchObject({ keyCode: "Enter", modifiers: ["control"] })
    expect(parseKeyPress("Super+ArrowUp", "linux")).toMatchObject({ keyCode: "Up", modifiers: ["meta"] })
  })

  test("a combination with Control or Meta types nothing and sends no character", () => {
    expect(parseKeyPress("Control+Enter", "linux")).toEqual({
      kind: "key",
      keyCode: "Enter",
      modifiers: ["control"],
      char: false,
      typesCharacter: false,
    })
    // Alt and Shift still type a character, so the credential guard runs for them.
    expect(parseKeyPress("Alt+e", "darwin")).toMatchObject({ keyCode: "e", char: true, typesCharacter: true })
    expect(parseKeyPress("Shift+a", "linux")).toMatchObject({ keyCode: "A", char: true, typesCharacter: true })
    expect(parseKeyPress("Shift+Tab", "linux")).toMatchObject({ keyCode: "Tab", char: true, typesCharacter: false })
  })

  test("a single key is read as before: a letter's own case, named keys by Electron's names", () => {
    expect(parseKeyPress("A", "linux")).toMatchObject({ keyCode: "A", modifiers: [], char: true, typesCharacter: true })
    expect(parseKeyPress("Enter", "linux")).toMatchObject({ keyCode: "Enter", char: true, typesCharacter: false })
    expect(parseKeyPress("Return", "linux")).toMatchObject({ keyCode: "Enter", char: true })
    expect(parseKeyPress("ArrowDown", "linux")).toMatchObject({ keyCode: "Down", char: false, typesCharacter: false })
    expect(parseKeyPress(" ", "linux")).toMatchObject({ keyCode: "Space", char: true, typesCharacter: true })
    // A trailing + is the key itself.
    expect(parseKeyPress("+", "linux")).toMatchObject({ keyCode: "+", modifiers: [], typesCharacter: true })
    expect(parseKeyPress("Control++", "linux")).toMatchObject({ keyCode: "+", modifiers: ["control"] })
  })

  test("select all, undo and redo are commands; the clipboard's keys are refused", () => {
    expect(parseKeyPress("Mod+a", "darwin")).toEqual({ kind: "edit", edit: "selectAll" })
    expect(parseKeyPress("Meta+A", "darwin")).toEqual({ kind: "edit", edit: "selectAll" })
    expect(parseKeyPress("Ctrl+a", "linux")).toEqual({ kind: "edit", edit: "selectAll" })
    // Control+A on macOS moves to the start of the line, as the page reads it.
    expect(parseKeyPress("Control+a", "darwin")).toMatchObject({ kind: "key", modifiers: ["control"] })
    expect(parseKeyPress("Mod+z", "linux")).toEqual({ kind: "edit", edit: "undo" })
    expect(parseKeyPress("Mod+Shift+Z", "linux")).toEqual({ kind: "edit", edit: "redo" })
    expect(parseKeyPress("Mod+y", "darwin")).toEqual({ kind: "edit", edit: "redo" })
    for (const key of ["Mod+c", "Mod+x", "Mod+V", "Mod+Shift+v", "Shift+Insert", "Control+Insert"])
      expect({ key, press: parseKeyPress(key, "darwin") }).toEqual({ key, press: { kind: "clipboard" } })
    expect(parseKeyPress("Meta+c", "linux")).toMatchObject({ kind: "key" })
  })

  test("refuses a modifier it does not know, and modifiers with no key", () => {
    expect(() => parseKeyPress("Hyper+a", "linux")).toThrow("Vector does not know the modifier Hyper.")
    expect(() => parseKeyPress("Control+", "linux")).toThrow("Name a key to press after the modifiers.")
    expect(() => parseKeyPress("Control++a", "linux")).toThrow("Name a key to press after the modifiers.")
  })
})
