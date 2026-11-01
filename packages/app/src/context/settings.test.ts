import { expect, test } from "bun:test"
import { restoredSettings } from "./settings"

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
