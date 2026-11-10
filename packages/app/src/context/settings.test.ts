import { expect, test } from "bun:test"
import { readFollowup, readStopScope, restoredSettings } from "./settings"

// A store saved before the editor settings existed has no editor block at all.
const defaults = restoredSettings({} as Parameters<typeof restoredSettings>[0])

test("Restore default settings keeps Vector Tab off for someone who switched it off", () => {
  const restored = restoredSettings({ editor: { ...defaults.editor, aiAutocomplete: false, fontSize: 22 } })
  expect(restored.editor.aiAutocomplete).toBe(false)
  // Everything else really is the default again.
  expect(restored.editor.fontSize).toBe(defaults.editor.fontSize)
  expect({ ...restored, editor: { ...restored.editor, aiAutocomplete: true } }).toEqual(defaults)
})

test("Restore default settings leaves Vector Tab at its default, on, otherwise", () => {
  expect(defaults.editor.aiAutocomplete).toBe(true)
  expect(restoredSettings({ editor: { ...defaults.editor, aiAutocomplete: true } })).toEqual(defaults)
  // Keeping it off for one reset never changes the defaults the next reset uses.
  restoredSettings({ editor: { ...defaults.editor, aiAutocomplete: false } })
  expect(restoredSettings({} as Parameters<typeof restoredSettings>[0]).editor.aiAutocomplete).toBe(true)
})

test("Codium 80% notifications require opting in and reset to off", () => {
  expect(defaults.codium.alert80).toBe(false)
  const saved = { editor: defaults.editor, codium: { alert80: true } }
  expect(restoredSettings(saved).codium.alert80).toBe(false)
})

test("follow-ups steer and Stop stops only the main turn by default, and a reset puts both back", () => {
  expect(defaults.general.followup).toBe("steer")
  expect(defaults.general.stopScope).toBe("turn")
  const saved = { editor: defaults.editor, general: { ...defaults.general, followup: "queue", stopScope: "all" } }
  const restored = restoredSettings(saved as Parameters<typeof restoredSettings>[0])
  expect(restored.general.followup).toBe("steer")
  expect(restored.general.stopScope).toBe("turn")
})

test("a stored follow-up mode reads as saved, and the steer an earlier migration wrote still reads as steer", () => {
  // An earlier version's migration wrote "steer" for everyone who had "queue".
  expect(readFollowup("steer")).toBe("steer")
  expect(readFollowup("queue")).toBe("queue")
  // Nothing saved yet, or something this version does not know, is the default.
  for (const value of [undefined, null, "", "Queue", "interrupt", 1, true]) expect(readFollowup(value)).toBe("steer")
})

test("only an explicit all makes Stop include helpers", () => {
  expect(readStopScope("all")).toBe("all")
  expect(readStopScope("turn")).toBe("turn")
  for (const value of [undefined, null, "", "helpers", "ALL", 1]) expect(readStopScope(value)).toBe("turn")
})
