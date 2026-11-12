import { describe, expect, test } from "bun:test"
import {
  altGraphHeld,
  commandKeymap,
  formatKeybind,
  keydownCommand,
  matchKeybind,
  parseKeybind,
  type CommandOption,
} from "./command"

/**
 * A keydown as a browser reports it. happy-dom says AltGraph is held whenever Alt is; a browser says so only for the
 * AltGr key (which Windows also reports as Ctrl+Alt), so a plain Ctrl+Alt press here reports no AltGraph.
 */
function keydown(init: KeyboardEventInit & { altGraph?: boolean }) {
  const { altGraph = false, ...rest } = init
  const event = new KeyboardEvent("keydown", rest)
  const state = event.getModifierState.bind(event)
  Object.defineProperty(event, "getModifierState", {
    value: (key: string) => (key === "AltGraph" ? altGraph : state(key)),
  })
  return event
}

describe("command keybind helpers", () => {
  test("parseKeybind handles aliases and multiple combos", () => {
    const keybinds = parseKeybind("control+option+k, mod+shift+comma")

    expect(keybinds).toHaveLength(2)
    expect(keybinds[0]).toEqual({
      key: "k",
      ctrl: true,
      meta: false,
      shift: false,
      alt: true,
    })
    expect(keybinds[1]?.shift).toBe(true)
    expect(keybinds[1]?.key).toBe("comma")
    expect(Boolean(keybinds[1]?.ctrl || keybinds[1]?.meta)).toBe(true)
  })

  test("parseKeybind treats none and empty as disabled", () => {
    expect(parseKeybind("none")).toEqual([])
    expect(parseKeybind("")).toEqual([])
  })

  test("matchKeybind normalizes punctuation keys", () => {
    const keybinds = parseKeybind("ctrl+comma, shift+plus, meta+space")

    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: ",", ctrlKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: "+", shiftKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: " ", metaKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, keydown({ key: ",", ctrlKey: true, altKey: true }))).toBe(false)
  })

  test("matchKeybind supports bracket keys", () => {
    const keybinds = parseKeybind("mod+alt+[, mod+alt+]")
    const prev = keybinds[0]
    const next = keybinds[1]

    expect(matchKeybind(keybinds, keydown({ key: "[", ctrlKey: prev?.ctrl, metaKey: prev?.meta, altKey: true }))).toBe(
      true,
    )
    expect(matchKeybind(keybinds, keydown({ key: "]", ctrlKey: next?.ctrl, metaKey: next?.meta, altKey: true }))).toBe(
      true,
    )
  })

  test("formatKeybind returns human readable output", () => {
    const display = formatKeybind("ctrl+alt+arrowup")

    expect(display).toContain("↑")
    expect(display.includes("Ctrl") || display.includes("⌃")).toBe(true)
    expect(display.includes("Alt") || display.includes("⌥")).toBe(true)
    expect(formatKeybind("none")).toBe("")
  })

  test("formatKeybind prefers the first combo", () => {
    const display = formatKeybind("mod+k,mod+p")

    expect(display.includes("K") || display.includes("k")).toBe(true)
    expect(display.includes("P") || display.includes("p")).toBe(false)
  })

  test("AltGraph+B does not fire a ctrl+alt+b binding, and Ctrl+Alt+B does", () => {
    const keybinds = parseKeybind("ctrl+alt+b")
    // Windows reports AltGr as Ctrl+Alt with AltGraph held.
    const altGr = keydown({ key: "b", ctrlKey: true, altKey: true, altGraph: true })
    const ctrlAlt = keydown({ key: "b", ctrlKey: true, altKey: true })
    expect(matchKeybind(keybinds, altGr)).toBe(false)
    expect(matchKeybind(keybinds, ctrlAlt)).toBe(true)

    // The command keymap the palette and shortcuts share skips it too, before anything runs.
    let ran = 0
    const promote: CommandOption = {
      id: "backgroundTasks.promote",
      title: "Move to background",
      keybind: "ctrl+alt+b",
      onSelect: () => ran++,
    }
    const keymap = commandKeymap([promote])
    expect(keydownCommand(altGr, { palette: new Set(), keymap })).toBeUndefined()
    expect(keydownCommand(ctrlAlt, { palette: new Set(), keymap })).toBe(promote)
    expect(ran).toBe(0)
  })

  test("AltGr is never treated as held on a Mac, where Option is Alt", () => {
    const option = keydown({ key: "b", ctrlKey: true, altKey: true, altGraph: true })
    expect(altGraphHeld(option, false)).toBe(true)
    // Firefox on macOS reports Option as AltGraph; Ctrl+Option+B still runs its binding there.
    expect(altGraphHeld(option, true)).toBe(false)
    expect(altGraphHeld(keydown({ key: "b", ctrlKey: true, altKey: true }), false)).toBe(false)
  })
})
