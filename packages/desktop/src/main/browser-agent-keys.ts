// How the agent browser reads the key a press names: one key, alone or after modifiers joined by + (Control+Enter,
// Meta+a, Shift+Tab, Mod+z). Mod is Meta on macOS and Control elsewhere. It lives apart from browser-agent.ts, which
// pulls in Electron at module load, so it can be tested directly.

export type Modifier = "control" | "shift" | "alt" | "meta"

export type KeyPress =
  /** Copy, cut or paste: refused, the agent browser never touches the clipboard. */
  | { readonly kind: "clipboard" }
  /** Select all, undo and redo, which macOS runs from the app's menu and not from a key event: run as the command. */
  | { readonly kind: "edit"; readonly edit: "selectAll" | "undo" | "redo" }
  | {
      readonly kind: "key"
      /** The key as Electron's sendInputEvent names it. */
      readonly keyCode: string
      readonly modifiers: Modifier[]
      /** Whether a char event follows keyDown: never with Control or Meta, which type nothing. */
      readonly char: boolean
      /** Whether the key puts a character in the focused field, so the credential guard runs first. */
      readonly typesCharacter: boolean
    }

export const CLIPBOARD_REFUSED = "Vector never reads or changes the clipboard from the agent browser."

const MODIFIERS: Record<string, Modifier | "mod"> = {
  control: "control",
  ctrl: "control",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "meta",
  command: "meta",
  cmd: "meta",
  super: "meta",
  mod: "mod",
}

// Names Electron does not read, for keys it knows by another.
const ALIASES: Record<string, string> = {
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  return: "Enter",
  esc: "Escape",
  " ": "Space",
}

// Keys that navigate, submit, or edit without inserting a character. Anything
// absent from this list counts as typing, so an unfamiliar key code fails closed
// into the guard rather than around it.
const NON_TYPING_KEYS = new Set([
  "tab",
  "enter",
  "return",
  "escape",
  "esc",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "shift",
  "control",
  "ctrl",
  "alt",
  "option",
  "meta",
  "command",
  "cmd",
  "super",
  "capslock",
  "numlock",
  "scrolllock",
  "printscreen",
  "pause",
  ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`),
])

/** Reads a press's key. Throws for a modifier Vector does not know, or modifiers with no key after them. */
export function parseKeyPress(key: string, platform: string = process.platform): KeyPress {
  // A trailing + is the key itself (Control++), not a separator.
  const parts = key === "+" ? ["+"] : key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+")
  const base = parts.at(-1) ?? ""
  if (!base || parts.slice(0, -1).some((part) => !part)) throw new Error(`Name a key to press after the modifiers.`)
  const modifiers = parts.slice(0, -1).map((part) => {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (!modifier) throw new Error(`Vector does not know the modifier ${part}.`)
    if (modifier === "mod") return platform === "darwin" ? "meta" : "control"
    return modifier
  })
  const held = [...new Set(modifiers)]
  const mod = platform === "darwin" ? "meta" : "control"
  const name = base.toLowerCase()
  const only = (...expected: Modifier[]) =>
    held.length === expected.length && expected.every((modifier) => held.includes(modifier))
  // Chromium on Windows and Linux also runs Shift+Delete as Cut, Shift+Insert as Paste and Control+Insert as Copy.
  if (
    (held.includes(mod) && ["c", "x", "v"].includes(name)) ||
    (name === "insert" && (held.includes("shift") || held.includes("control"))) ||
    (platform !== "darwin" && ["delete", "del"].includes(name) && held.includes("shift"))
  )
    return { kind: "clipboard" }
  if (only(mod) && name === "a") return { kind: "edit", edit: "selectAll" }
  if (only(mod) && name === "z") return { kind: "edit", edit: "undo" }
  if ((only(mod, "shift") && name === "z") || (only(mod) && name === "y")) return { kind: "edit", edit: "redo" }
  const control = held.includes("control") || held.includes("meta")
  // Electron reads an upper-case letter as Shift with it, so with modifiers the letter's case follows Shift alone.
  const letter = base.length === 1 && /[a-z]/i.test(base) && held.length > 0
  const keyCode = ALIASES[name] ?? (letter ? (held.includes("shift") ? name.toUpperCase() : name) : base)
  return {
    kind: "key",
    keyCode,
    modifiers: held,
    char: !control && (base.length === 1 || ["Enter", "Tab", "Space"].includes(keyCode)),
    typesCharacter: !control && !NON_TYPING_KEYS.has(name),
  }
}
