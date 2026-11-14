import type { FilePart, ToolPart } from "@vectordevai/sdk/v2"
import type { UiI18nKey, UiI18nParams } from "@vectordevai/ui/context/i18n"
import { ComputerCredential } from "@vectordevai/core/computer/credential"
import { Computer, ComputerApps, Hands } from "@vectordevai/core/computer/hands"
import { ComputerKeys } from "@vectordevai/core/computer/keys"

/**
 * Vector-built labels for the timeline's run card (INV-S11, INV-T5). Every label is built from fixed copy, closed
 * vocabularies and bounded metadata fields that the engine writes; none reads the model's intent, typed input,
 * reasons or queries. Each field is validated on its own, so one malformed field cannot blank a whole label.
 */

export type Translate = (key: UiI18nKey, params?: UiI18nParams) => string

export type ComputerStep = {
  label: string
  /**
   * `failed` when the step was refused, blocked or did not finish; `unconfirmed` when the call was stopped, paused or
   * handed off, so its action may not have run; `stopped` when the user stopped it.
   */
  state: "running" | "done" | "failed" | "unconfirmed" | "stopped"
}

const ACTIONS = new Set<string>(Computer.ToolAction.literals)
const PAUSES = new Set<string>(Computer.PauseReason.literals)
const HANDOFFS = new Set<string>(Computer.HandoffReason.literals)
const BLOCKS = new Set<string>(ComputerApps.BlockReason.literals)
const DIRECTIONS = new Set(["up", "down", "left", "right"])

// Controls, line separators and bidi formatting become spaces; zero-width and invisible formatting characters are
// dropped, as the app's quoted labels and the desktop's live labels do.
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g
// Notes keep their line breaks.
const NOTE_UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

const MAC_MODIFIERS = { control: "⌃", alt: "⌥", altgraph: "⌥", shift: "⇧", meta: "⌘" } as const
const MODIFIERS = { control: "Ctrl", alt: "Alt", altgraph: "AltGr", shift: "Shift", meta: "Win" } as const
const MODIFIER_ORDER = ["control", "alt", "altgraph", "shift", "meta"] as const
const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Esc",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  pagedown: "Page Down",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
}

/**
 * The label of one computer call: the block, setup or handoff the engine recorded, otherwise its main action, so a
 * call that was blocked or handed to the user is never labeled as done. Never reads `metadata.intent` or any free
 * text in `input`.
 */
export function computerLabel(metadata: unknown, t: Translate, input?: unknown) {
  const say = named(t)
  const meta = record(metadata)
  const blocked = literal(record(meta?.blocked)?.reason, BLOCKS)
  if (blocked) return blockedLabel(blocked, meta, say)
  if (meta?.setup === true) return say("ui.tool.computer.setup")
  const handoff = literal(record(meta?.handoff)?.reason, HANDOFFS)
  if (handoff) return handoffLabel(handoff, appName(meta), say)
  const args = record(input)
  const batch = batchSteps(args)
  // A batch's top-level action is not its first step, and the engine rewrites target, text and keys for each group
  // of steps, so a longer batch shows its first step's target-less label and how many steps follow.
  const step = batch ? record(batch[0]) : args
  const action = batch
    ? literal(step?.action, ACTIONS)
    : (literal(meta?.action, ACTIONS) ?? literal(args?.action, ACTIONS))
  const label = actionLabel(action, batch && batch.length > 1 ? { app: meta?.app } : meta, step, say)
  if (!batch || batch.length < 2) return label
  const more = batch.length - 1
  return `${label} ${say(more === 1 ? "ui.tool.computer.more.one" : "ui.tool.computer.more.other", { count: more })}`
}

/**
 * Every labeled step of one computer call, in order: its action, or each action of a batch, then any block, handoff,
 * take-over or stop.
 */
export function computerSteps(state: ToolPart["state"], translate: Translate): ComputerStep[] {
  const t = named(translate)
  if (state.status === "pending" || state.status === "running")
    return [
      {
        label: computerLabel(state.status === "running" ? state.metadata : undefined, t, state.input),
        state: "running",
      },
    ]
  // An interrupted or rejected call has no Vector record of what happened; its raw error is never shown.
  if (state.status === "error") return [{ label: computerLabel(state.metadata, t, state.input), state: "failed" }]

  const meta = record(state.metadata)
  const label = computerLabel(meta, t, state.input)
  const blocked = !!literal(record(meta?.blocked)?.reason, BLOCKS) || meta?.setup === true
  const handoff = !!literal(record(meta?.handoff)?.reason, HANDOFFS)
  // A block always failed the call. A handoff did happen, so it fails only when the call failed after it.
  const outcome: ComputerStep = { label, state: blocked || failed(meta) ? "failed" : "done" }
  const batch = batchSteps(record(state.input))
  // A batch lists each step target-less, as its summary label does (see computerLabel), then its block or handoff,
  // which may have come after earlier steps ran.
  const steps: ComputerStep[] =
    batch && batch.length > 1
      ? [
          ...batch.map((entry) => {
            const step = record(entry)
            const action = literal(step?.action, ACTIONS)
            return { label: actionLabel(action, { app: meta?.app }, step, t), state: actionState(meta) }
          }),
          ...(blocked || handoff ? [outcome] : []),
        ]
      : [blocked || handoff ? outcome : { label, state: actionState(meta) }]
  if (blocked) return steps

  const paused = pause(meta?.paused)
  if (paused)
    steps.push({
      label: t(
        paused.by === "input" || paused.by === "button" ? "ui.tool.computer.tookOver" : "ui.tool.computer.paused",
        {
          duration: duration(paused.ms, t),
        },
      ),
      state: "done",
    })
  if ((paused || handoff) && meta?.code === undefined)
    steps.push({ label: t("ui.tool.computer.resumed"), state: "done" })
  if (meta?.code === "stopped") steps.push({ label: t("ui.tool.computer.stopped"), state: "stopped" })
  return steps
}

/** The marker a step's label alone cannot carry: that it failed, or that nothing confirms its action ran. */
export function computerStepStatus(state: ComputerStep["state"], t: Translate) {
  if (state === "failed") return t("ui.toolErrorCard.failed")
  if (state === "unconfirmed") return t("ui.tool.computer.unconfirmed")
}

/**
 * What the run card's header counts: the apps in the order they were used, the actions known to have run, and the
 * time from the first call's start to the latest end (no live ticking).
 *
 * A refused, failed or interrupted call counts nothing. A paused or handed-off call also counts nothing: the engine
 * does not resume the rest of a batch after a pause (E6b.6) and its metadata does not say how many steps ran, so the
 * header never claims a step that may not have happened.
 */
export function computerRun(parts: readonly ToolPart[]) {
  const apps = [
    ...new Set(
      parts.flatMap((part) => appName(record(part.state.status === "pending" ? undefined : part.state.metadata)) ?? []),
    ),
  ]
  const actions = parts.reduce((total, part) => {
    if (part.state.status !== "completed") return total
    const meta = record(part.state.metadata)
    if (!counted(meta) || literal(meta?.action, ACTIONS) === "handoff") return total
    return total + (batchSteps(record(part.state.input))?.length ?? 1)
  }, 0)
  const times = parts.flatMap((part) => (part.state.status === "pending" ? [] : [part.state.time]))
  const start = Math.min(...times.map((time) => time.start))
  const end = Math.max(...times.flatMap((time) => ("end" in time && typeof time.end === "number" ? [time.end] : [])))
  return { apps, actions, ms: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined }
}

/** The run card's header: the name, the apps, the action count and the run's length, joined by " · ". */
export function computerRunTitle(parts: readonly ToolPart[], translate: Translate) {
  const t = named(translate)
  const run = computerRun(parts)
  return [
    Hands.NAME,
    run.apps.join(", "),
    t(run.actions === 1 ? "ui.tool.computer.actions.one" : "ui.tool.computer.actions.other", { count: run.actions }),
    run.ms === undefined ? "" : duration(run.ms, t),
  ]
    .filter(Boolean)
    .join(" · ")
}

/** A completed call's screenshot: its latest image attachment, or `removed` when pruning deleted it (E13). */
export function computerShot(part: ToolPart): { removed: boolean; image?: FilePart } | undefined {
  if (part.state.status !== "completed") return
  if (record(part.state.metadata)?.screenshotRemoved === true) return { removed: true }
  const image = part.state.attachments?.findLast((file) => file.mime.startsWith("image/") && !!file.url)
  return image ? { removed: false, image } : undefined
}

/**
 * Where the ring goes on a screenshot shown `width` pixels wide: the frame-pixel point scaled by width / frame width
 * (INV-R10). A point outside the frame, or a frame without a positive size, has no ring.
 */
export function ringPoint(point: unknown, frame: unknown, width: number) {
  const at = record(point)
  const size = record(frame)
  const x = at?.x
  const y = at?.y
  const frameWidth = size?.width
  const frameHeight = size?.height
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof frameWidth !== "number" ||
    typeof frameHeight !== "number"
  )
    return
  if (!(frameWidth > 0) || !(frameHeight > 0) || !Number.isFinite(frameWidth) || !Number.isFinite(frameHeight)) return
  if (!(width > 0) || !Number.isFinite(width)) return
  if (!(x >= 0 && x < frameWidth && y >= 0 && y < frameHeight)) return
  const scale = width / frameWidth
  return { x: x * scale, y: y * scale }
}

/**
 * The ring on a completed call's screenshot preview, in frame pixels, with the frame's size for the overlay. Only a
 * single call the header counts marks its screenshot. A batch rewrites the point for each group of steps, so the point
 * need not belong to the step its last screenshot shows. A paused or handed-off call's screenshot is the frame captured
 * after the user, not the one its point belongs to, and its click, like a stopped or refused one, may never have run.
 * A call without a point (a zoom, a key press) has no ring.
 */
export function computerRing(part: ToolPart) {
  if (part.state.status !== "completed") return
  const actions = record(part.state.input)?.actions
  if (Array.isArray(actions) && actions.length > 1) return
  const meta = record(part.state.metadata)
  if (!counted(meta)) return
  const frame = record(meta?.frame)
  const width = frame?.width
  const height = frame?.height
  if (typeof width !== "number" || typeof height !== "number") return
  const point = ringPoint(meta?.point, frame, width)
  return point && { ...point, width, height }
}

/** Model text shown attributed under a step ("The agent: …"): plain text without controls or bidi, lines kept. */
export function agentNote(text: unknown) {
  if (typeof text !== "string") return ""
  return text.replace(/\r\n?/g, "\n").replace(NOTE_UNSAFE, "").trim()
}

function actionLabel(
  action: string | undefined,
  meta: Record<string, unknown> | undefined,
  step: Record<string, unknown> | undefined,
  t: Translate,
) {
  const named = appName(meta)
  const app = named ?? t("ui.tool.computer.theApp")
  const target = visible(record(meta?.target)?.name, Computer.LIMITS.labelChars)
  const clicked = (withTarget: UiI18nKey, without: UiI18nKey) =>
    target ? t(withTarget, { target, app }) : t(without, { app })
  switch (action) {
    case "screenshot":
      return t("ui.tool.computer.looked", { app: named ?? t("ui.tool.computer.theScreen") })
    case "zoom":
      return t("ui.tool.computer.zoomed", { app: named ?? t("ui.tool.computer.theScreen") })
    case "cursor_position":
      return t("ui.tool.computer.cursorPosition")
    case "click":
      return clicked("ui.tool.computer.clicked", "ui.tool.computer.clickedIn")
    case "double_click":
      return clicked("ui.tool.computer.doubleClicked", "ui.tool.computer.doubleClickedIn")
    case "triple_click":
      return clicked("ui.tool.computer.tripleClicked", "ui.tool.computer.tripleClickedIn")
    case "right_click":
      return clicked("ui.tool.computer.rightClicked", "ui.tool.computer.rightClickedIn")
    case "middle_click":
      return clicked("ui.tool.computer.middleClicked", "ui.tool.computer.middleClickedIn")
    case "mouse_move":
      return t("ui.tool.computer.moved", { app })
    case "drag":
      return t("ui.tool.computer.dragged", { app })
    case "mouse_down":
      return t("ui.tool.computer.mouseDown", { app })
    case "mouse_up":
      return t("ui.tool.computer.mouseUp", { app })
    case "scroll": {
      const direction = literal(step?.direction, DIRECTIONS)
      return direction
        ? t("ui.tool.computer.scrolled", { direction: t(`ui.tool.computer.direction.${direction}`) })
        : t("ui.tool.computer.scrolledIn", { app })
    }
    case "type": {
      // A call the header does not count, such as a declined confirmation, a stop or a pause, may have typed none of
      // its text, so the text is not shown as typed.
      const text = counted(meta) ? preview(record(meta?.text)?.preview) : undefined
      return text ? t("ui.tool.computer.typed", { text, app }) : t("ui.tool.computer.typedText", { app })
    }
    case "key": {
      const keys = keyLabel(meta)
      return keys ? t("ui.tool.computer.pressed", { keys }) : t("ui.tool.computer.pressedKeys", { app })
    }
    case "hold_key": {
      const keys = keyLabel(meta)
      return keys ? t("ui.tool.computer.held", { keys }) : t("ui.tool.computer.heldKeys", { app })
    }
    case "wait": {
      const seconds = step?.seconds ?? 1
      return typeof seconds === "number" &&
        Number.isFinite(seconds) &&
        seconds >= 0 &&
        seconds <= Computer.LIMITS.waitSecondsMax
        ? t("ui.tool.computer.waited", { seconds: Math.round(seconds * 10) / 10 })
        : t("ui.tool.computer.waited", { seconds: 1 })
    }
    case "list_apps":
      return t("ui.tool.computer.listed")
    case "open_app":
      return t("ui.tool.computer.opened", { app })
    case "focus_window":
      return t("ui.tool.computer.switched", { app })
    case "read_ui":
      return t("ui.tool.computer.read", { app })
    // A recorded handoff reason is labeled before the action; without one the sentence is generic.
    case "handoff":
      return handoffLabel("other", named, t)
    default:
      return t("ui.tool.computer.name")
  }
}

// Copy keeps the feature's name injectable (D2), so every template receives it.
function named(t: Translate): Translate {
  return (key, params) => t(key, { name: Hands.NAME, ...params })
}

function blockedLabel(reason: string, meta: Record<string, unknown> | undefined, t: Translate) {
  const app = appName(meta) ?? t("ui.tool.computer.theApp")
  // BlockReason `passwords` has the copy key `password` (D2).
  const sentence = t(`ui.tool.computer.blocked.${reason === "passwords" ? "password" : reason}`, { app })
  return t("ui.tool.computer.blocked", { app, reason: sentence })
}

function handoffLabel(reason: string, app: string | undefined, t: Translate) {
  const sentence = t(`ui.tool.computer.handoff.${reason}`)
  return app
    ? t("ui.tool.computer.yourTurn", { app, reason: sentence })
    : t("ui.tool.computer.yourTurnWithoutApp", { reason: sentence })
}

function duration(ms: number, t: Translate) {
  const total = Math.round(ms / 1000)
  if (total < 60) return t("ui.message.duration.seconds", { count: total })
  return t("ui.message.duration.minutesSeconds", { minutes: Math.floor(total / 60), seconds: total % 60 })
}

/**
 * A completed call's action, judged as the header counts it (`computerRun`): any code but `stopped` failed it. A
 * stopped, paused or handed-off call may have ended before or after its input reached the app, at a check-in, a
 * confirmation or a pointer wait, and the engine records no executed count (D8.9), so its action is unconfirmed,
 * never done.
 */
function actionState(meta: Record<string, unknown> | undefined): ComputerStep["state"] {
  if (failed(meta)) return "failed"
  return counted(meta) ? "done" : "unconfirmed"
}

function failed(meta: Record<string, unknown> | undefined) {
  return meta?.code !== undefined && meta.code !== "stopped"
}

/** Whether the header counts the call's actions as run: no code, pause or handoff (see `computerRun`). */
function counted(meta: Record<string, unknown> | undefined) {
  return meta?.code === undefined && meta?.paused === undefined && meta?.handoff === undefined
}

function pause(value: unknown) {
  const paused = record(value)
  const by = literal(paused?.by, PAUSES)
  const ms = paused?.ms
  if (!by || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return
  return { by, ms }
}

function appName(meta: Record<string, unknown> | undefined) {
  return visible(record(meta?.app)?.name, Computer.LIMITS.labelChars)
}

/** The engine already redacts and cuts typed text (E6); the label checks both again before showing any of it. */
function preview(value: unknown) {
  if (typeof value !== "string" || ComputerCredential.secret(value)) return
  return visible(value, Computer.LIMITS.previewChars)
}

/** Keys from the engine's `metadata.keys`, through the same resolver the engine uses, shown as glyphs on macOS. */
function keyLabel(meta: Record<string, unknown> | undefined) {
  if (typeof meta?.keys !== "string") return
  const resolved = ComputerKeys.resolve(meta.keys.split("+").filter(Boolean))
  if (!resolved) return
  const appKey = record(meta.app)?.key
  const mac = typeof appKey === "string" && Computer.parseAppKey(appKey)?.platform === "macos"
  const key = keyName(resolved.key)
  if (!key) return
  const modifiers = MODIFIER_ORDER.filter((modifier) => resolved.modifiers.includes(modifier))
  if (mac) return [...new Set(modifiers.map((modifier) => MAC_MODIFIERS[modifier]))].join("") + key
  return [...modifiers.map((modifier) => MODIFIERS[modifier]), key].join("+")
}

function keyName(key: string) {
  if (Object.hasOwn(NAMED_KEYS, key)) return NAMED_KEYS[key]
  if (/^f(?:[1-9]|1\d|2[0-4])$/.test(key)) return key.toUpperCase()
  if ([...key].length === 1 && /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(key)) return key.toUpperCase()
}

/** Bounded text for a label: no controls, bidi or invisible characters, single spaces, straight inner quotes. */
function visible(value: unknown, max: number) {
  if (typeof value !== "string") return
  const flat = value.replace(BREAKS, " ").replace(INVISIBLE, "").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat || undefined
  // Cut by UTF-16 units, as the schema bounds them, without splitting a surrogate pair.
  return (
    flat
      .slice(0, max - 1)
      .replace(/[\ud800-\udbff]$/, "")
      .trimEnd() + "…"
  )
}

function batchSteps(args: Record<string, unknown> | undefined) {
  const actions = args?.actions
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > Computer.LIMITS.batchSteps) return
  return actions
}

function literal(value: unknown, set: ReadonlySet<string>) {
  return typeof value === "string" && set.has(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}
