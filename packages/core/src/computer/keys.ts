export * as ComputerKeys from "./keys"

export type Modifier = "control" | "alt" | "shift" | "meta" | "altgraph"
export type LayoutKey =
  | string
  | {
      readonly key: string
      readonly shift?: string
      readonly altGraph?: string
      readonly shiftAltGraph?: string
    }
export type Layout = {
  readonly platform: "macos" | "windows"
  /** Physical codes, such as KeyQ or Digit4, mapped using the active layout. Missing levels refuse. */
  readonly keys?: Readonly<Record<string, LayoutKey>>
}
export type MenuShortcut = {
  readonly combo: readonly string[]
  /** The focused app's observed menu label, so a custom macro binding is still refused. */
  readonly label: string
}
export type Resolved = { readonly key: string; readonly modifiers: readonly Modifier[] }

const MODIFIERS: Readonly<Record<string, Modifier>> = {
  ctrl: "control",
  control: "control",
  controlleft: "control",
  controlright: "control",
  alt: "alt",
  option: "alt",
  altleft: "alt",
  altright: "alt",
  shift: "shift",
  shiftleft: "shift",
  shiftright: "shift",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  win: "meta",
  windows: "meta",
  metaleft: "meta",
  metaright: "meta",
  altgr: "altgraph",
  altgraph: "altgraph",
  "⌘": "meta",
  "⌥": "alt",
  "⌃": "control",
  "⇧": "shift",
}
const NAMED: Readonly<Record<string, string>> = {
  return: "enter",
  esc: "escape",
  del: "delete",
  spacebar: "space",
  " ": "space",
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
  pgup: "pageup",
  pgdn: "pagedown",
  page_down: "pagedown",
  page_up: "pageup",
}
const NAVIGATION = new Set([
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "home",
  "end",
  "pageup",
  "pagedown",
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "insert",
])
const TEXT_NAVIGATION = new Set([
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "home",
  "end",
  "pageup",
  "pagedown",
  "backspace",
  "delete",
])
const EDITING = new Set(["a", "c", "v", "x", "y", "z"])
const SYSTEM_KEYS = new Set([
  "printscreen",
  "snapshot",
  "power",
  "sleep",
  "wake",
  "eject",
  "capslock",
  "numlock",
  "scrolllock",
  "pause",
  "fn",
  "fnlock",
  "contextmenu",
  "apps",
  "help",
  "launchapp1",
  "launchapp2",
  "launchmail",
  "browserhome",
  "volumemute",
  "volumeup",
  "volumedown",
  "mediaplaypause",
  "medianexttrack",
  "mediaprevioustrack",
  "mediastop",
])
const PHYSICAL =
  /^(?:Key[A-Z]|Digit\d|Numpad\w+|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/i
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/u
const FORBIDDEN_MENU =
  /\b(?:macros?|scripts?|scripting|javascript|visual\s+basic|vb\s+editor|terminal|console|powershell|shell|developer|devtools|services|web\s+inspector|inspect\s+element|task\s+manager|mission\s+control|screen\s*capture|screenshots?|lock\s+screen|switch\s+user|enable\s+content)\b/i

/** The complete native-observed ancestry, including the item. Empty paths are read-only menu roots. */
export function forbiddenMenu(path: readonly string[], shortcut?: readonly string[]) {
  if (
    path.length < 1 ||
    path.length > 30 ||
    Array.from(path).some((label) => typeof label !== "string" || label.length > 256 || UNSAFE.test(label))
  )
    return true
  const normalized = path.map((label) => label.normalize("NFKC"))
  return (
    normalized.some(
      (value) => !value.trim() || UNSAFE.test(value) || value.length > 256 || FORBIDDEN_MENU.test(value),
    ) ||
    FORBIDDEN_MENU.test(normalized.join(" ")) ||
    (shortcut !== undefined &&
      !allowedCombo(shortcut, [{ combo: shortcut, label: path.at(-1)! }], { platform: "macos" }))
  )
}

export function pasteCombo(combo: readonly string[], layout?: Layout) {
  const key = resolve(combo, layout)
  return (
    !!key &&
    ((key.key === "v" && (key.modifiers.includes("control") || key.modifiers.includes("meta"))) ||
      (key.key === "insert" && key.modifiers.includes("shift")))
  )
}

/** An observed menu binding can edit a document even when its translated label has no English verb. */
export function menuTypesText(shortcut: readonly string[]) {
  // Validate semantic tokens only; forbiddenMenu separately binds the actual observed menu ancestry.
  if (!allowedCombo(shortcut, [{ combo: shortcut, label: "Menu action" }], { platform: "macos" })) return true
  const key = resolve(shortcut, { platform: "macos" })
  if (!key) return true
  return (
    pasteCombo(shortcut) ||
    ["backspace", "delete"].includes(key.key) ||
    (["x", "z", "y"].includes(key.key) && (key.modifiers.includes("control") || key.modifiers.includes("meta"))) ||
    (printable(key.key) && key.modifiers.every((modifier) => ["shift", "alt", "altgraph"].includes(modifier)))
  )
}

/** Resolve names and physical positions before both the key floor and the sensitive-action classifier inspect them. */
export function resolve(combo: readonly string[], layout?: Layout): Resolved | undefined {
  if (combo.length < 1 || combo.length > 8 || combo.some((key) => !key || key.length > 32 || UNSAFE.test(key))) return
  const values = combo.map((key) => key.toLowerCase())
  const modifiers = values.flatMap((key) => (Object.hasOwn(MODIFIERS, key) ? [MODIFIERS[key]] : []))
  if (new Set(modifiers).size !== modifiers.length) return
  const keys = combo.filter((key) => !Object.hasOwn(MODIFIERS, key.toLowerCase()))
  if (keys.length !== 1) return
  const key = keys[0]
  if (!PHYSICAL.test(key)) return { key: canonicalKey(key), modifiers: modifiers.sort() }
  const entry = Object.entries(layout?.keys ?? {}).find(([code]) => code.toLowerCase() === key.toLowerCase())?.[1]
  if (!entry) return
  const shift = modifiers.includes("shift")
  const altGraph = modifiers.includes("altgraph")
  const value =
    typeof entry === "string"
      ? altGraph || (shift && !/^\p{L}$/u.test(entry))
        ? undefined
        : entry
      : altGraph
        ? shift
          ? entry.shiftAltGraph
          : entry.altGraph
        : shift
          ? entry.shift
          : entry.key
  if (!value || UNSAFE.test(value) || ([...value].length !== 1 && !NAVIGATION.has(canonicalKey(value)))) return
  return { key: canonicalKey(value), modifiers: modifiers.sort() }
}

/** The helper repeats this check against the live focused app and layout before posting input (INV-S7). */
export function allowedCombo(
  combo: readonly string[],
  focusedMenuShortcuts: readonly MenuShortcut[] = [],
  layout?: Layout,
) {
  const resolved = resolve(combo, layout)
  if (!resolved || forbidden(resolved, layout?.platform)) return false
  if (!printable(resolved.key) && !NAVIGATION.has(resolved.key) && !/^f(?:[1-9]|1\d|2[0-4])$/.test(resolved.key))
    return false
  const mods = resolved.modifiers
  const matching = focusedMenuShortcuts.filter((shortcut) => {
    const menu = resolve(shortcut.combo, layout)
    return menu?.key === resolved.key && menu.modifiers.join("+") === mods.join("+")
  })
  if (matching.some((shortcut) => forbiddenMenu([shortcut.label]))) return false
  const text = printable(resolved.key)
  if ((mods.length === 0 || (mods.length === 1 && mods[0] === "shift")) && (text || NAVIGATION.has(resolved.key)))
    return true
  if (mods.includes("altgraph"))
    return (
      mods.every((modifier) => modifier === "shift" || modifier === "altgraph") &&
      layout?.platform === "windows" &&
      text &&
      combo.some((key) => PHYSICAL.test(key))
    )
  const primary = layout?.platform === "macos" ? "meta" : "control"
  if (mods.includes(primary) && mods.every((modifier) => modifier === primary || modifier === "shift")) {
    if (EDITING.has(resolved.key) || TEXT_NAVIGATION.has(resolved.key)) return true
    if (primary === "control" && resolved.key === "tab") return true
  }
  if (
    layout?.platform === "macos" &&
    mods.includes("alt") &&
    mods.every((modifier) => modifier === "alt" || modifier === "shift") &&
    ["arrowleft", "arrowright", "arrowup", "arrowdown", "backspace", "delete"].includes(resolved.key)
  )
    return true
  return matching.length > 0
}

function canonicalKey(value: string) {
  const lower = value.toLowerCase()
  if (Object.hasOwn(NAMED, lower)) return NAMED[lower]
  return [...value].length === 1 && !/^[A-Z]$/.test(value) ? value : lower
}

function printable(key: string) {
  return key === "space" || ([...key].length === 1 && !UNSAFE.test(key) && !/\s/u.test(key))
}

function forbidden(combo: Resolved, platform?: Layout["platform"]) {
  const key = combo.key
  const mods = combo.modifiers
  const control = mods.includes("control")
  const alt = mods.includes("alt")
  const meta = mods.includes("meta")
  const shift = mods.includes("shift")
  if (SYSTEM_KEYS.has(key) || key === "f12") return true
  if (meta && platform !== "macos") return true
  if (
    platform === "macos" &&
    control &&
    (["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key) || /^f[2-8]$/.test(key))
  )
    return true
  if (platform === "macos" && meta && alt && key === "d") return true
  if (mods.includes("altgraph") && (platform !== "windows" || control || alt || meta)) return true
  if ((alt || meta) && key === "tab") return true
  if (key === "space" && (control || alt || meta)) return true
  if (key === "escape" && (control || alt || meta || shift)) return true
  if (control && alt && ["delete", "end", "tab", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key))
    return true
  if (control && shift && ["i", "j", "c"].includes(key)) return true
  if (meta && alt && ["i", "j", "c"].includes(key)) return true
  if (alt && ["f8", "f11"].includes(key)) return true
  if (meta && shift && ["3", "4", "5", "6", "#", "$", "%", "^", "q"].includes(key)) return true
  if (meta && control && key === "q") return true
  return false
}
