import path from "node:path"
import { createHash } from "node:crypto"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { WebFence } from "../research/fence"
import { ComputerCredential } from "./credential"
import { ComputerKeys } from "./keys"

/** App launches use the same classifier even though they are separate bridge commands, not input steps. */
export type Step = Computer.Step | { readonly kind: "open"; readonly path: string }

/** Binds a once-only ask to the exact proposed input, independently of object-property insertion order. */
export function digest(step: Step) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(step)))
    .digest("hex")
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

export type Result =
  | { readonly kind: "refuse"; readonly code: Computer.ComputerErrorCode; readonly description: string }
  | { readonly kind: "ask"; readonly why: Computer.SensitiveWhy; readonly description: string }

export interface Context {
  readonly layout?: ComputerKeys.Layout
  readonly focusedMenuShortcuts?: readonly ComputerKeys.MenuShortcut[]
  /** Canonical paths and directories supplied by the engine or desktop; never model assertions. */
  readonly protectedPaths?: readonly string[]
  readonly protectedDirectories?: readonly string[]
  readonly resolvedDocument?: string
  /** Includes the caller's SessionMemory.source and configured instruction-path checks. */
  readonly documentProtected?: boolean
  readonly unvouched?: readonly { readonly kind?: string; readonly value: string }[]
  readonly providerCheck?: Computer.SensitiveAskMetadata["providerCheck"]
  readonly screenText?: string
  readonly clipboardText?: string
  /** Resolved executable or script path observed at the actual target, never a model's proposed label. */
  readonly programPath?: string
  readonly repository?: string
  readonly launcher?: boolean
  readonly settings?: boolean
}

const REASONS: Record<
  Exclude<Computer.SensitiveWhy, "run_program" | "paste" | "new_destination" | "ide_run" | "provider_check">,
  string
> = {
  send: "This sends a message.",
  delete: "This deletes something.",
  buy: "This may spend money.",
  submit: "This submits a form.",
  account: "This changes an account or accepts terms.",
  settings: "This changes a setting.",
  disruptive: "This quits an app or logs you out.",
  flagged: PermissionPolicy.FLAGGED_SCREEN_REASON,
}

/** Pure preflight shared by the engine and desktop; native live gates remain authoritative at the point of input. */
export function classify(step: Step, inspect: Computer.InspectResult, ctx: Context = {}): Result | undefined {
  if (step.kind === "wait")
    return inspect.scope === "app-menu" && inspect.menuPath.length === 0 ? undefined : caution(ctx, inspect)
  if (ComputerApps.isNever(inspect.category)) return refuse("blocked", "This app cannot be operated with computer use.")
  if (inspect.elevated) return refuse("elevated", "Use handoff for this administrator window.")
  if (ComputerCredential.field(inspect.element) || (step.kind === "type" && ComputerCredential.secret(step.text)))
    return refuse("secure_field", "Use handoff so the user can enter credentials or payment details.")
  const menuPath = inspect.scope === "app-menu" ? inspect.menuPath : inspect.menu?.path
  const menuShortcut = inspect.scope === "app-menu" ? inspect.menuShortcut : inspect.menu?.shortcut
  const menuLayout: ComputerKeys.Layout = { platform: inspect.app.platform === "windows" ? "windows" : "macos" }
  if (
    inspect.scope !== "app-menu" &&
    inspect.app.platform === "windows" &&
    inspect.element?.role === "MenuItem" &&
    !inspect.menu
  )
    return refuse("blocked", "The menu action needs complete observed menu facts.")
  if (menuPath && ComputerKeys.forbiddenMenu(menuPath, menuShortcut, menuLayout))
    return refuse("blocked", "This menu route is not permitted for computer use.")
  if (menuPath && step.kind === "type") return refuse("blocked", "Menu items cannot receive typed text.")
  if (
    ctx.documentProtected ||
    [inspect.document, ctx.resolvedDocument].some((file) => file && protectedDocument(file, ctx))
  )
    return refuse("blocked", "Computer use cannot edit Vector's instructions, memory, permissions or configuration.")
  const key = step.kind === "key" ? ComputerKeys.resolve(step.combo, ctx.layout) : undefined
  const menuKey = menuShortcut ? ComputerKeys.resolve(menuShortcut, menuLayout) : undefined
  const menuEdits = menuShortcut !== undefined && ComputerKeys.menuTypesText(menuShortcut, menuLayout)
  const menu =
    key &&
    ctx.focusedMenuShortcuts?.find((item) => {
      const candidate = ComputerKeys.resolve(item.combo, ctx.layout)
      return (
        candidate &&
        candidate.key === key.key &&
        candidate.modifiers.length === key.modifiers.length &&
        candidate.modifiers.every((m) => key.modifiers.includes(m))
      )
    })
  const label = WebFence.clean(menu?.label ?? menuPath?.at(-1) ?? inspect.element?.label ?? "")
    .normalize("NFKC")
    .trim()
  const activating =
    step.kind === "click" ||
    step.kind === "down" ||
    step.kind === "up" ||
    !!menu ||
    key?.key === "enter" ||
    key?.key === "space"
  const paste =
    (activating && /^paste\b/i.test(label)) ||
    (activating && menuShortcut !== undefined && ComputerKeys.pasteCombo(menuShortcut, menuLayout)) ||
    (step.kind === "key" && ComputerKeys.pasteCombo(step.combo, ctx.layout))
  if (paste && ctx.clipboardText && ComputerCredential.secret(ctx.clipboardText))
    return refuse("secure_field", "Use handoff so the user can enter credentials or payment details.")
  const edits =
    key &&
    (["enter", "tab", "backspace", "delete"].includes(key.key) ||
      ((key.key === "space" || [...key.key].length === 1) &&
        key.modifiers.every((m) => m === "shift" || m === "altgraph")) ||
      (["x", "z", "y"].includes(key.key) && (key.modifiers.includes("control") || key.modifiers.includes("meta"))))
  if (menuPath && step.kind === "key" && (paste || (edits && key?.key !== "enter" && key?.key !== "space")))
    return refuse("blocked", "Menu items cannot receive text editing keys.")
  const ideRun =
    inspect.category === "developer" &&
    activating &&
    !menuEdits &&
    (menu ||
      (inspect.element &&
        !inspect.element.editable &&
        !/textfield|textarea|edit|input|combo/i.test(inspect.element.role))) &&
    (/^(?:run|build|debug|start debugging)\b/i.test(label) ||
      (menuPath &&
        !inspect.element?.editable &&
        menuKey &&
        ((menuKey.modifiers.includes("meta") && ["r", "b", "u"].includes(menuKey.key)) ||
          (menuKey.key === "f5" && menuKey.modifiers.every((modifier) => modifier === "control")))))
  const knownNontextMenu =
    menuKey &&
    ((menuKey.modifiers.includes("control") &&
      menuKey.modifiers.every((modifier) => modifier === "control" || modifier === "shift") &&
      ["a", "c", "s"].includes(menuKey.key)) ||
      (menuKey.modifiers.length === 0 &&
        ["arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end", "pageup", "pagedown"].includes(menuKey.key)))
  const disruptiveMenu =
    menuPath &&
    !menuEdits &&
    ((menuKey &&
      ((menuKey.key === "q" && menuKey.modifiers.includes("meta")) ||
        (menuKey.key === "f4" && menuKey.modifiers.includes("alt")))) ||
      /^(?:quit|exit|log out|log off|sign out|shut down|restart)\b/i.test(label))
  const title = inspect.scope === "app-menu" ? undefined : inspect.window.title
  if (
    inspect.category === "developer" &&
    (step.kind === "type" ||
      paste ||
      (activating && menuEdits) ||
      (activating && inspect.menu && !knownNontextMenu && !ideRun && !disruptiveMenu) ||
      (edits && !ideRun) ||
      (activating && /^(?:cut|delete|undo|redo|replace|insert|format|refactor)\b/i.test(label)))
  )
    return refuse("blocked", "Developer apps are click-only for text changes. Use Vector's edit tools to change code.")
  const entered = step.kind === "type" ? step.text : paste ? ctx.clipboardText : undefined
  if (entered && launcher(inspect, ctx) && shellText(entered))
    return refuse(
      "blocked",
      "Use an approved app directly; command text cannot be typed into an address or launcher field.",
    )
  if (step.kind === "key" && !ComputerKeys.allowedCombo(step.combo, ctx.focusedMenuShortcuts, ctx.layout))
    return refuse("blocked", "This key combination is not permitted for computer use.")
  const launch =
    step.kind === "open" ||
    ((inspect.category === "files" || launcher(inspect, ctx)) &&
      ((step.kind === "click" && step.count >= 2) ||
        key?.key === "enter" ||
        (activating && /^(?:open|run|launch|install)\b/i.test(label))))
  const program = launch ? (step.kind === "open" ? step.path : ctx.programPath) : undefined
  if (
    (program && !path.posix.isAbsolute(program) && !path.win32.isAbsolute(program)) ||
    (launch &&
      !program &&
      (/\.(?:app|exe|com|bat|cmd|ps1|vbs|js|wsf|scr|msi|msp|sh|bash|zsh|command|py|rb|pl|scpt|applescript|workflow|jar|pkg|dmg|lnk)$/i.test(
        label,
      ) ||
        /^(?:run|launch|install)\b/i.test(label)))
  )
    return refuse("blocked", "The full program path must be resolved before asking to run it.")
  const flagged = caution(ctx, inspect)
  if (flagged) return flagged
  if (step.kind === "move" || step.kind === "scroll") return undefined
  if (paste && !inspect.clipboard.agentOwned)
    return {
      kind: "ask",
      why: "paste",
      description:
        ctx.clipboardText === undefined
          ? "This pastes what you copied."
          : `This pastes what you copied: “${Computer.clean(ctx.clipboardText, Computer.LIMITS.previewChars)}”.`,
    }
  if (program)
    return { kind: "ask", why: "run_program", description: `This runs a program: ${Computer.clean(program, 4096)}.` }
  if (step.kind === "type" && ctx.unvouched?.length)
    return {
      kind: "ask",
      why: "new_destination",
      description: `It's typing an address you didn't give it: ${ctx.unvouched.map((entity) => Computer.clean(entity.value, 2048)).join(", ")}.`,
    }
  if (inspect.category === "messaging" && step.kind === "type" && /[\r\n]/.test(step.text)) return ask("send")
  if (
    key?.key === "enter" &&
    (inspect.category === "messaging" ||
      (inspect.category === "mail" &&
        /compose|new message|draft|reply|forward|message body/i.test(`${title ?? ""} ${label}`)))
  )
    return ask("send")
  if (
    inspect.category === "files" &&
    (key?.key === "delete" ||
      (key?.key === "backspace" && key.modifiers.includes("meta")) ||
      ((step.kind === "drag" || step.kind === "up") && /\b(?:trash|recycle bin)\b/i.test(label)))
  )
    return ask("delete")
  if (
    (key &&
      ((key.key === "q" && key.modifiers.includes("meta")) || (key.key === "f4" && key.modifiers.includes("alt")))) ||
    (activating && disruptiveMenu)
  )
    return ask("disruptive")
  if (ideRun)
    return {
      kind: "ask",
      why: "ide_run",
      description: ctx.repository
        ? `This runs code in ${Computer.clean(ctx.repository, 4096)}.`
        : "This runs code in this project.",
    }
  if (
    (ctx.settings ||
      /settings|preferences|configuration|options/i.test(title ?? "") ||
      menuPath?.some((item) => /settings|preferences|configuration|options/i.test(item))) &&
    !/^(?:cancel|close|back|help|search)\b/i.test(label) &&
    (step.kind === "type" || paste || edits || activating)
  )
    return ask("settings")
  if (activating) {
    if (/^(?:quit|exit|log out|log off|sign out|shut down|restart)\b/i.test(label)) return ask("disruptive")
    if (/^(?:delete|erase|uninstall|remove permanently|move to (?:trash|recycle bin))\b/i.test(label))
      return ask("delete")
    if (/^(?:pay|buy|purchase|order|transfer|donate|withdraw)\b/i.test(label)) return ask("buy")
    if (/^(?:send|post|publish)\b/i.test(label)) return ask("send")
    if (/^submit\b/i.test(label)) return ask("submit")
    if (
      /^(?:sign(?:\s|$)|accept(?:\s|$)|agree(?:\s|$)|create account|close account|change (?:password|email|account)|revoke consent)/i.test(
        label,
      )
    )
      return ask("account")
    if (
      inspect.category === "finance" &&
      !/^(?:cancel|close|back|home|help|search|view|history|statements?)\b/i.test(label)
    )
      return ask("buy")
    if (inspect.menu && !knownNontextMenu) return ask("flagged")
  }
  return undefined
}

function caution(ctx: Context, inspect: Computer.InspectResult): Result | undefined {
  if (ctx.providerCheck)
    return {
      kind: "ask",
      why: "provider_check",
      description: `${Computer.clean(ctx.providerCheck.provider, 64)} flagged this step: ${Computer.clean(ctx.providerCheck.message, 1000)}${ctx.providerCheck.domain ? " Watch this step closely." : ""}`,
    }
  const screen = [
    ctx.screenText,
    inspect.scope === "app-menu" ? inspect.menuPath.join(" > ") : inspect.window.title,
    inspect.menu?.path.join(" > "),
    inspect.element?.label,
  ]
    .filter(Boolean)
    .join("\n")
  if (WebFence.flagged(WebFence.clean(screen)).length) return ask("flagged")
  return undefined
}

/** The caller additionally supplies canonical paths for configured files and path aliases. No filesystem is read here. */
export function protectedDocument(file: string, ctx: Pick<Context, "protectedPaths" | "protectedDirectories"> = {}) {
  const normalized = normalize(file)
  if (/(?:^|\/)(?:\.vector|\.claude)(?:\/|$)/.test(normalized)) return true
  if (/(?:^|\/)(?:agents|claude|context|rules|brain|memory)\.md$/.test(normalized)) return true
  if (/(?:^|\/)vector\.jsonc?$/.test(normalized)) return true
  if (
    /(?:^|\/)(?:\.config\/vector|\.local\/(?:share|state)\/vector|application support\/vector|appdata\/(?:local|roaming)\/vector)(?:\/|$)/.test(
      normalized,
    )
  )
    return true
  return (
    (ctx.protectedPaths ?? []).some((item) => normalize(item) === normalized) ||
    (ctx.protectedDirectories ?? []).some(
      (item) => normalized === normalize(item) || normalized.startsWith(`${normalize(item).replace(/\/$/, "")}/`),
    )
  )
}

function normalize(file: string) {
  return path.posix.normalize(file.replaceAll("\\", "/")).toLowerCase()
}

function launcher(inspect: Computer.InspectResult, ctx: Context) {
  return (
    ctx.launcher ||
    (inspect.element &&
      (inspect.element.editable || /textfield|textarea|edit|input|combo|search/i.test(inspect.element.role)) &&
      /\b(?:address|location|url|run|launcher|command)\b/i.test(inspect.element.label ?? ""))
  )
}

function shellText(text: string) {
  // Launcher fields must refuse a protected command whether it is named directly or by a quoted executable path.
  const first = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(text)
  const token = first?.[1] ?? first?.[2] ?? first?.[3] ?? ""
  const executable = /^[a-z][a-z\d+.-]*:\/\//i.test(token)
    ? ""
    : (token
        .replaceAll("\\", "/")
        .split("/")
        .at(-1)
        ?.replace(/\.(?:exe|com|cmd|bat)$/i, "") ?? "")
  return (
    /^(?:sudo|doas|bash|zsh|sh|fish|cmd|powershell|pwsh|osascript|python\d*(?:\.\d+)*|node|ruby|perl|curl|wget|echo|printf|rm|chmod|open|start|exec)$/i.test(
      executable,
    ) ||
    (/^(?:git|npm|npx|pnpm|yarn|bun|deno|cargo|go|make|cmake|gradle|mvn|dotnet|ls|cat|cd|mkdir|rmdir|mv|cp|del|dir|env|export|source|eval|kill)$/i.test(
      executable,
    ) &&
      /^\s+\S/.test(text.slice(first?.[0].length ?? 0))) ||
    /^\s*(?:javascript|vbscript|shell|ms-settings):/i.test(text) ||
    (/(?:&&|\|\||;\s*\S|\$\(|`|\|\s*\S)/.test(text) && !/^https?:\/\/\S+$/i.test(text.trim()))
  )
}

function ask(why: keyof typeof REASONS): Result {
  return { kind: "ask", why, description: REASONS[why] }
}

function refuse(code: Computer.ComputerErrorCode, description: string): Result {
  return { kind: "refuse", code, description }
}

export * as ComputerSensitive from "./sensitive"
