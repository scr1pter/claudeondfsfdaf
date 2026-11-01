export * as Computer from "./computer"

import { Schema } from "effect"
import { AppCategory, BlockReason } from "./computer-apps"
import { NonNegativeInt, PositiveInt, optional } from "./schema"

/**
 * Shared shapes for Vector Hands (build contract sections 2.2 and 2.4 to 2.10). Effect Schemas cover every value
 * that crosses a process boundary (bridge bodies and responses, helper frames, ask metadata, the mention marker,
 * part metadata, the state the desktop publishes); desktop-only views are plain types.
 *
 * Principles every shape here keeps: no field, option or command hides the glow or banner; no field lets a company,
 * a mention, a client or the engine answer an ask for the user; the never-list is a floor; every screen-derived
 * string is untrusted data.
 */

// ---------------------------------------------------------------------------------------------------------------
// Numbers and fixed strings (sections 2.7, 2.8, 2.10, 2.12)

/** The bridge and helper protocol version this build speaks. */
export const PROTOCOL = 1

/** Metadata key of the @Hands / @App mention marker (section 2.5). Never changes. */
export const MENTION_KEY = "vector.computer.mention"

/** The exact text for batch steps after a failure (section 2.7). */
export const BATCH_FAILURE = "Not executed: an earlier computer action in this turn failed."

export const LIMITS = Object.freeze({
  /** Allow is inert this long after an ask appears. */
  askArmMs: 700,
  /** The agent's words in an ask. */
  agentTextChars: 200,
  /** Verified accessibility labels in asks and banners. */
  labelChars: 40,
  /** Typed-text previews and paste previews. */
  previewChars: 60,
  intentChars: 120,
  handoffReasonChars: 300,
  typeTextChars: 4000,
  batchSteps: 10,
  dragPointsMin: 2,
  dragPointsMax: 50,
  repeatMax: 20,
  scrollAmountMax: 20,
  waitSecondsMax: 30,
  holdSecondsMax: 10,
  readUiNodesMax: 400,
  heartbeatMs: 2000,
  helperHaltMs: 5000,
  engineSilenceMs: 10_000,
  takeoverPx: 8,
  pauseLatencyMs: 100,
  inputStepMs: 10_000,
  captureMs: 10_000,
  uiTreeMs: 15_000,
  actSlackMs: 15_000,
  longPollMs: 60_000,
  checkInActions: 300,
  checkInMinutes: 45,
  awayMinutes: 30,
  pausedEndMinutes: 30,
  keepAwakeReleaseMinutes: 2,
  startNotifyThrottleMinutes: 5,
  doneFlashMs: 2000,
  overlayFadeMs: 400,
  screenshotsKept: 3,
  screenshotsKeptSmallContext: 2,
  helperRestartsPerMinute: 3,
  bridgeBodyBytes: 64 * 1024,
  bridgeResponseBytes: 8 * 1024 * 1024,
  helperFrameBytes: 16 * 1024 * 1024,
  iconBytes: 8 * 1024,
  jpegQuality: 80,
})

// ---------------------------------------------------------------------------------------------------------------
// Primitives

// C0 and C1 controls, line and paragraph separators, and bidi formatting characters. Text shown in asks, banners and
// the timeline must not carry them, so a label can neither break a line nor reorder what the user reads.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const UNSAFE_ALL = new RegExp(UNSAFE.source, "g")

/** Strip control and bidi characters, collapse whitespace and cut to at most `max` characters. */
export function clean(text: string, max: number): string {
  const flat = text.replace(UNSAFE_ALL, " ").replace(/\s+/g, " ").trim()
  const chars = Array.from(flat)
  if (chars.length <= max) return flat
  return (
    chars
      .slice(0, Math.max(0, max - 1))
      .join("")
      .trimEnd() + "…"
  )
}

/** Bounded text with no control or bidi characters; what a person reads. */
const Safe = (max: number) =>
  Schema.String.check(
    Schema.isMaxLength(max),
    Schema.makeFilter((value: string) => !UNSAFE.test(value), { expected: "text without control or bidi characters" }),
  )
/** Bounded opaque text. */
const Bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Name = Bounded(256)
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const SessionRef = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const Directory = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
/** A permission request id from the engine's event stream. */
const RequestID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const Millis = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Lease = PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Scale = Schema.Finite.check(Schema.isGreaterThan(0))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/))
/** A `ui_N` reference from `read_ui`. */
const UiRef = Schema.String.check(Schema.isPattern(/^ui_\d{1,6}$/))
const KeyName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
)

/** A PNG icon as a data URL, at most `LIMITS.iconBytes` decoded. */
export const Icon = Schema.String.check(
  Schema.isPattern(/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/),
  Schema.isMaxLength("data:image/png;base64,".length + Math.ceil(LIMITS.iconBytes / 3) * 4),
).annotate({ identifier: "Computer.Icon" })

/** A JPEG or PNG frame as a data URL, within the bridge's response limit. */
export const ImageData = Schema.String.check(
  Schema.isPattern(/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]*={0,2}$/),
  Schema.isMaxLength(LIMITS.bridgeResponseBytes),
).annotate({ identifier: "Computer.ImageData" })

/** A point in frame pixels, origin top-left. */
export interface Point extends Schema.Schema.Type<typeof Point> {}
export const Point = Schema.Struct({ x: Schema.Int, y: Schema.Int }).annotate({ identifier: "Computer.Point" })

/** A rectangle: global DIP on the bridge, helper units (macOS points, Windows physical pixels) on the helper wire. */
export interface Rect extends Schema.Schema.Type<typeof Rect> {}
export const Rect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  w: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  h: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Computer.Rect" })

/** A region of a frame in frame pixels (`zoom`). Coordinates stay in full-frame space after a zoom. */
export interface Region extends Schema.Schema.Type<typeof Region> {}
export const Region = Schema.Struct({ x0: Schema.Int, y0: Schema.Int, x1: Schema.Int, y1: Schema.Int }).annotate({
  identifier: "Computer.Region",
})

export const Mode = Schema.Literals(["foreground", "background"]).annotate({ identifier: "Computer.Mode" })
export type Mode = typeof Mode.Type

// ---------------------------------------------------------------------------------------------------------------
// 2.2 App identity and keys

const TeamId = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/))

export interface MacIdentity extends Schema.Schema.Type<typeof MacIdentity> {}
export const MacIdentity = Schema.Struct({
  platform: Schema.Literal("macos"),
  bundleId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  /** From the code signature; compared at access time, never part of the key. */
  teamId: optional(TeamId),
  /** True only for Apple-anchored signatures. */
  apple: Schema.Boolean,
  /** An OS platform binary (`/System`, `/usr/libexec`, `/System/Library/CoreServices`). */
  system: Schema.Boolean,
  /** False for ad-hoc, unsigned or unverifiable apps: asked for one task, never saved with Always allow. */
  verified: Schema.Boolean,
  name: Name,
  path: optional(Path),
  pid: optional(PositiveInt),
}).annotate({ identifier: "Computer.MacIdentity" })

export interface WindowsAumidIdentity extends Schema.Schema.Type<typeof WindowsAumidIdentity> {}
export const WindowsAumidIdentity = Schema.Struct({
  platform: Schema.Literal("windows"),
  kind: Schema.Literal("aumid"),
  /** Trusted only when Windows confirms the package for the process. */
  aumid: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  publisher: optional(Name),
  system: Schema.Boolean,
  verified: Schema.Boolean,
  name: Name,
  exe: optional(Path),
  pid: optional(PositiveInt),
}).annotate({ identifier: "Computer.WindowsAumidIdentity" })

export interface WindowsExeIdentity extends Schema.Schema.Type<typeof WindowsExeIdentity> {}
export const WindowsExeIdentity = Schema.Struct({
  platform: Schema.Literal("windows"),
  kind: Schema.Literal("exe"),
  /** The verified Authenticode signer; empty when there is none. */
  publisher: Bounded(256),
  product: Bounded(256),
  /** The original file name from the signed image, never the on-disk basename. */
  binary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(260)),
  system: Schema.Boolean,
  verified: Schema.Boolean,
  name: Name,
  exe: Path,
  pid: optional(PositiveInt),
}).annotate({ identifier: "Computer.WindowsExeIdentity" })

/** Reserved for a remote computer; unused this build. */
export interface RemoteIdentity extends Schema.Schema.Type<typeof RemoteIdentity> {}
export const RemoteIdentity = Schema.Struct({
  platform: Schema.Literal("remote"),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Name,
  verified: Schema.Literal(false),
}).annotate({ identifier: "Computer.RemoteIdentity" })

export const AppIdentity = Schema.Union([
  MacIdentity,
  WindowsAumidIdentity,
  WindowsExeIdentity,
  RemoteIdentity,
]).annotate({
  identifier: "Computer.AppIdentity",
})
export type AppIdentity = typeof AppIdentity.Type

const KEY_PREFIX = "app:"
const MAX_KEY = 1024

// Windows exe keys join three parts with `|`, so `%` and `|` inside a part are escaped to keep keys unambiguous.
const escapePart = (part: string) => part.toLowerCase().replaceAll("%", "%25").replaceAll("|", "%7c")
const unescapePart = (part: string) => part.replaceAll("%7c", "|").replaceAll("%25", "%")

/** The publisher part of a Windows exe key: the verified signer, or `unsigned`. */
function signer(app: WindowsExeIdentity) {
  return app.verified && app.publisher.trim() ? app.publisher : "unsigned"
}

/**
 * The stable, lowercased key of an app:
 * `app:macos:<bundleId>`, `app:windows:aumid:<aumid>`, `app:windows:exe:<publisher>|<product>|<binary>` (publisher
 * `unsigned` without a verified signer) or `app:remote:<id>`. The key never includes the Team ID or signer: those
 * are compared at access time.
 */
export function appKey(app: AppIdentity): string {
  switch (app.platform) {
    case "macos":
      return `${KEY_PREFIX}macos:${app.bundleId}`.toLowerCase()
    case "windows":
      if (app.kind === "aumid") return `${KEY_PREFIX}windows:aumid:${app.aumid}`.toLowerCase()
      return `${KEY_PREFIX}windows:exe:${[signer(app), app.product, app.binary].map(escapePart).join("|")}`
    case "remote":
      return `${KEY_PREFIX}remote:${app.id}`.toLowerCase()
  }
}

export interface ParsedAppKey {
  readonly platform: AppIdentity["platform"]
  /** macOS `[bundleId]`; Windows `["aumid", aumid]` or `["exe", publisher, product, binary]`; remote `[id]`. */
  readonly parts: readonly string[]
}

/** Parse a key made by `appKey`. Anything else, including a key that is not lowercase, returns undefined. */
export function parseAppKey(key: string): ParsedAppKey | undefined {
  if (key.length > MAX_KEY || key !== key.toLowerCase() || UNSAFE.test(key) || !key.startsWith(KEY_PREFIX)) return
  const rest = key.slice(KEY_PREFIX.length)
  if (rest.startsWith("macos:")) {
    const bundleId = rest.slice("macos:".length)
    return bundleId ? { platform: "macos", parts: [bundleId] } : undefined
  }
  if (rest.startsWith("windows:aumid:")) {
    const aumid = rest.slice("windows:aumid:".length)
    return aumid ? { platform: "windows", parts: ["aumid", aumid] } : undefined
  }
  if (rest.startsWith("windows:exe:")) {
    const parts = rest.slice("windows:exe:".length).split("|")
    if (parts.length !== 3) return
    const [publisher, product, binary] = parts.map(unescapePart)
    if (!publisher || !binary) return
    return { platform: "windows", parts: ["exe", publisher, product, binary] }
  }
  if (rest.startsWith("remote:")) {
    const id = rest.slice("remote:".length)
    return id ? { platform: "remote", parts: [id] } : undefined
  }
  return
}

/** A string that `parseAppKey` accepts. */
export const AppKey = Schema.String.check(
  Schema.makeFilter((value: string) => parseAppKey(value) !== undefined, { expected: "an app key" }),
).annotate({ identifier: "Computer.AppKey" })

/** A resolved artifact is not an app, and its launch approval never grants screen or input access. */
export const ProgramKey = Schema.String.check(Schema.isPattern(/^program:(?:macos|windows):[0-9a-f]{64}$/)).annotate({
  identifier: "Computer.ProgramKey",
})
export type ProgramKey = typeof ProgramKey.Type
export interface ProgramLaunch extends Schema.Schema.Type<typeof ProgramLaunch> {}
export const ProgramLaunch = Schema.Struct({
  key: ProgramKey,
  platform: Schema.Literals(["macos", "windows"]),
  path: Path,
  name: Safe(256).check(Schema.isMinLength(1)),
  /** Native hash of the canonical artifact contents and its verified launch-handler binding. */
  binding: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
}).annotate({ identifier: "Computer.ProgramLaunch" })
/** Ephemeral helper authority stays on the desktop; it is never sent to the engine or saved in an ask. */
export interface NativeProgramLaunch extends Schema.Schema.Type<typeof NativeProgramLaunch> {}
export const NativeProgramLaunch = Schema.Struct({
  ...ProgramLaunch.fields,
  token: Id,
  /** Native-observed handler identity for desktop policy checks; never sent to the engine or stored in an ask. */
  handler: optional(AppIdentity),
}).annotate({
  identifier: "Computer.NativeProgramLaunch",
})
export const LaunchResolution = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("app"), identity: AppIdentity }),
  Schema.Struct({ kind: Schema.Literal("program"), program: NativeProgramLaunch }),
  Schema.Struct({ kind: Schema.Literal("protected"), reason: BlockReason }),
]).annotate({ identifier: "Computer.LaunchResolution" })
export type LaunchResolution = typeof LaunchResolution.Type

// ---------------------------------------------------------------------------------------------------------------
// Error codes and availability (section 2.8)

export const ComputerErrorCode = Schema.Literals([
  "unavailable",
  "permissions",
  "busy",
  "stopped",
  "paused",
  "locked",
  "blocked",
  "protected",
  "denied",
  "not_granted",
  "stale_frame",
  "stale_ref",
  "changed",
  "occluded",
  "secure_field",
  "elevated",
  "secure_desktop",
  "not_foreground",
  "capture_unavailable",
  "no_ui_tree",
  "out_of_bounds",
  "needs_foreground",
  "timeout",
  "app_not_found",
  "unsupported_action",
  "frame_too_large",
  "helper_incompatible",
  "unsupported_os",
  "blocked_by_os",
  "responsible_missing",
  "failed",
]).annotate({ identifier: "Computer.ErrorCode" })
export type ComputerErrorCode = typeof ComputerErrorCode.Type

export const UnavailableReason = Schema.Literals([
  "unsupported_os",
  "helper_missing",
  "helper_incompatible",
  "permissions",
  "policy_disabled",
  "elevated",
  "blocked_by_os",
  "responsible_missing",
]).annotate({ identifier: "Computer.UnavailableReason" })
export type UnavailableReason = typeof UnavailableReason.Type

export const Backend = Schema.Literals(["local-macos", "local-windows", "fake", "remote"]).annotate({
  identifier: "Computer.Backend",
})
export type Backend = typeof Backend.Type

/** OS permission status as the helper reports it. */
export const PermissionState = Schema.Literals(["granted", "denied", "notDetermined", "restricted", "n/a"]).annotate({
  identifier: "Computer.PermissionState",
})
export type PermissionState = typeof PermissionState.Type

// ---------------------------------------------------------------------------------------------------------------
// 2.4 Permissions and ask metadata

export const AskLevel = Schema.Literals(["observe", "interact"]).annotate({ identifier: "Computer.AskLevel" })
export type AskLevel = typeof AskLevel.Type

export const AlwaysWhyNot = Schema.Literals(["policy", "category", "unverified", "changed"]).annotate({
  identifier: "Computer.AlwaysWhyNot",
})
export type AlwaysWhyNot = typeof AlwaysWhyNot.Type

/** Metadata of a `computer_app` ask. No field answers or skips the ask. */
export interface AppAskMetadata extends Schema.Schema.Type<typeof AppAskMetadata> {}
export const AppAskMetadata = Schema.Struct({
  action: Schema.Literal("use_app"),
  level: AskLevel,
  target: Schema.Struct({
    appName: Safe(256),
    appKey: AppKey,
    platform: Schema.Literals(["macos", "windows"]),
    publisher: optional(Safe(256)),
    teamId: optional(TeamId),
    verified: Schema.Boolean,
    category: AppCategory,
    /** Observed process/path; unsigned task consent cannot bind two missing identity fields. */
    pid: optional(PositiveInt),
    path: optional(Path),
    icon: optional(Icon),
    ownBuild: optional(Schema.Struct({ repo: Safe(256) })),
  }),
  canAlways: Schema.Boolean,
  alwaysWhyNot: optional(AlwaysWhyNot),
  companyAllowed: optional(Schema.Boolean),
  mentioned: optional(Schema.Boolean),
  /** The Vector Local first-use note. */
  localWarning: optional(Schema.Boolean),
  /** The agent's words; shown only as "The agent says". */
  reason: optional(Safe(LIMITS.agentTextChars)),
}).annotate({ identifier: "Computer.AppAskMetadata" })

export const SensitiveWhy = Schema.Literals([
  "send",
  "delete",
  "buy",
  "submit",
  "account",
  "settings",
  "run_program",
  "paste",
  "new_destination",
  "ide_run",
  "disruptive",
  "provider_check",
  "flagged",
]).annotate({ identifier: "Computer.SensitiveWhy" })
export type SensitiveWhy = typeof SensitiveWhy.Type

/** Metadata of a `computer_sensitive` ask: answered by a person every time, never Always. */
export interface SensitiveAskMetadata extends Schema.Schema.Type<typeof SensitiveAskMetadata> {}
export const SensitiveAskMetadata = Schema.Struct({
  action: Schema.Literals(["click", "type", "key", "drag", "open"]),
  why: SensitiveWhy,
  target: Schema.Struct({
    appName: Safe(256),
    appKey: Schema.Union([AppKey, ProgramKey]),
    /** Observed target identity for the desktop's live, once-only proof check. */
    windowId: optional(Id),
    pid: optional(PositiveInt),
    ref: optional(UiRef),
    elementId: optional(Id),
  }),
  /** A verified accessibility label, shown quoted. */
  targetName: optional(Safe(LIMITS.labelChars)),
  /** The exact text to be typed, or the first characters of a paste. */
  text: optional(Bounded(LIMITS.typeTextChars)),
  /** Binds a Paste approval to the complete observed clipboard without retaining its text in main's proof store. */
  clipboardHash: optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  /** `run_program`: the full path. */
  path: optional(Path),
  program: optional(ProgramLaunch),
  /** `new_destination`: shown in full. */
  destination: optional(Bounded(2048)),
  providerCheck: optional(
    Schema.Struct({
      provider: Safe(64),
      code: Safe(128),
      message: Safe(1000),
      domain: optional(Schema.Boolean),
    }),
  ),
  frame: optional(Id),
  stepIndex: optional(NonNegativeInt),
  /** SHA-256 of the canonical proposed step. Desktop matches it before consuming the once-only approval. */
  stepDigest: optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
})
  .check(
    Schema.makeFilter(
      (value) =>
        !value.target.appKey.startsWith("program:")
          ? value.program === undefined
          : value.action === "open" &&
            value.why === "run_program" &&
            value.program !== undefined &&
            value.program.key === value.target.appKey &&
            value.path === value.program.path,
      { expected: "a program identity only for its explicit run-program approval" },
    ),
  )
  .annotate({ identifier: "Computer.SensitiveAskMetadata" })

export const HandoffReason = Schema.Literals([
  "credential",
  "sign_in",
  "captcha",
  "payment_details",
  "admin_prompt",
  "security_prompt",
  "capture_confirm",
  "elevated",
  "site_permission",
  "download",
  "extension",
  "protocol_handler",
  "macros",
  "other",
]).annotate({ identifier: "Computer.HandoffReason" })
export type HandoffReason = typeof HandoffReason.Type

/** A handoff is a Question, not a permission. */
export interface HandoffQuestionMetadata extends Schema.Schema.Type<typeof HandoffQuestionMetadata> {}
export const HandoffQuestionMetadata = Schema.Struct({
  computer: Schema.Struct({ kind: Schema.Literal("handoff"), app: optional(Safe(256)), reason: HandoffReason }),
}).annotate({ identifier: "Computer.HandoffQuestionMetadata" })

export interface CheckInQuestionMetadata extends Schema.Schema.Type<typeof CheckInQuestionMetadata> {}
export const CheckInQuestionMetadata = Schema.Struct({
  computer: Schema.Struct({ kind: Schema.Literal("check_in"), actions: NonNegativeInt, minutes: NonNegativeInt }),
}).annotate({ identifier: "Computer.CheckInQuestionMetadata" })

// ---------------------------------------------------------------------------------------------------------------
// 2.5 Mention marker

/** A hint for the model and the ask copy. Never a grant: it carries no grant field. */
export const MentionMarker = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("feature") }),
  Schema.Struct({ kind: Schema.Literal("app"), key: AppKey, name: Safe(256) }),
]).annotate({ identifier: "Computer.MentionMarker" })
export type MentionMarker = typeof MentionMarker.Type

/** The empty synthetic text part an @Hands or @App pill adds after the typed text. */
export interface MentionPart extends Schema.Schema.Type<typeof MentionPart> {}
export const MentionPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.Literal(""),
  synthetic: Schema.Literal(true),
  metadata: Schema.Struct({ [MENTION_KEY]: MentionMarker }),
}).annotate({ identifier: "Computer.MentionPart" })

// ---------------------------------------------------------------------------------------------------------------
// 2.6 Access verdict

const VerdictNever = { verdict: Schema.Literal("never"), reason: BlockReason }
const VerdictBlocked = { verdict: Schema.Literal("blocked"), reason: Schema.Literals(["user", "default"]) }
const VerdictCompanyDeny = { verdict: Schema.Literal("company-deny") }
const VerdictDenied = { verdict: Schema.Literal("denied") }
const VerdictGranted = { verdict: Schema.Literal("granted"), level: AskLevel, via: Schema.Literals(["task", "always"]) }
const VerdictAsk = {
  verdict: Schema.Literal("ask"),
  canAlways: Schema.Boolean,
  alwaysWhyNot: optional(AlwaysWhyNot),
  companyAllowed: Schema.Boolean,
  changed: Schema.Boolean,
  ownBuild: optional(Schema.Struct({ repo: Safe(256) })),
}

export const AccessVerdict = Schema.Union([
  Schema.Struct(VerdictNever),
  Schema.Struct(VerdictBlocked),
  Schema.Struct(VerdictCompanyDeny),
  Schema.Struct(VerdictDenied),
  Schema.Struct(VerdictGranted),
  Schema.Struct(VerdictAsk),
]).annotate({ identifier: "Computer.AccessVerdict" })
export type AccessVerdict = typeof AccessVerdict.Type

export const VerdictKind = Schema.Literals(["never", "blocked", "company-deny", "denied", "granted", "ask"]).annotate({
  identifier: "Computer.VerdictKind",
})
export type VerdictKind = typeof VerdictKind.Type

// ---------------------------------------------------------------------------------------------------------------
// 2.7 Engine tool schema and part metadata

export const ToolAction = Schema.Literals([
  "screenshot",
  "zoom",
  "cursor_position",
  "click",
  "double_click",
  "triple_click",
  "right_click",
  "middle_click",
  "mouse_move",
  "drag",
  "mouse_down",
  "mouse_up",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
  "list_apps",
  "open_app",
  "focus_window",
  "read_ui",
  "handoff",
]).annotate({ identifier: "Computer.ToolAction" })
export type ToolAction = typeof ToolAction.Type

/** Every action except `handoff`, which cannot run inside a batch. */
export const BatchAction = Schema.Literals(
  ToolAction.literals.filter((action) => action !== "handoff") as Exclude<ToolAction, "handoff">[],
).annotate({ identifier: "Computer.BatchAction" })
export type BatchAction = typeof BatchAction.Type

const toolStepFields = {
  app: optional(Bounded(256)),
  window: optional(Bounded(256)),
  display: optional(Bounded(256)),
  x: optional(Schema.Int),
  y: optional(Schema.Int),
  ref: optional(UiRef),
  path: optional(Schema.Array(Point).check(Schema.isLengthBetween(LIMITS.dragPointsMin, LIMITS.dragPointsMax))),
  modifiers: optional(Bounded(64)),
  text: optional(Bounded(LIMITS.typeTextChars)),
  keys: optional(Bounded(64)),
  repeat: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.repeatMax }))),
  direction: optional(Schema.Literals(["up", "down", "left", "right"])),
  amount: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.scrollAmountMax }))),
  seconds: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: LIMITS.waitSecondsMax }))),
  region: optional(Region),
  query: optional(Bounded(256)),
  screenshot: optional(Schema.Boolean),
  intent: optional(Bounded(LIMITS.intentChars)),
}

// `hold_key` holds for at most 10 seconds; other actions take up to 30.
const holdLimit = Schema.makeFilter(
  (input: { readonly action: string; readonly seconds?: number }) =>
    input.action !== "hold_key" || input.seconds === undefined || input.seconds <= LIMITS.holdSecondsMax,
  { expected: `hold_key seconds of at most ${LIMITS.holdSecondsMax}` },
)

/** One step of a batch: the tool's fields minus `actions` and `handoff`. */
export interface ToolStep extends Schema.Schema.Type<typeof ToolStep> {}
export const ToolStep = Schema.Struct({ action: BatchAction, ...toolStepFields })
  .check(holdLimit)
  .annotate({ identifier: "Computer.ToolStep" })

/** The model-facing input of the generic `computer` function tool. Flat, so OpenAI strict mode works. */
export interface ToolInput extends Schema.Schema.Type<typeof ToolInput> {}
export const ToolInput = Schema.Struct({
  action: ToolAction,
  ...toolStepFields,
  reason: optional(Bounded(LIMITS.handoffReasonChars)),
  actions: optional(Schema.Array(ToolStep).check(Schema.isMaxLength(LIMITS.batchSteps))),
})
  .check(holdLimit)
  .annotate({ identifier: "Computer.ToolInput" })

export const PauseReason = Schema.Literals([
  "input",
  "button",
  "locked",
  "suspend",
  "away",
  "helper",
  "detection",
  "secure_input",
  "secure_desktop",
  "overlay",
  "pointer",
]).annotate({ identifier: "Computer.PauseReason" })
export type PauseReason = typeof PauseReason.Type

/** What the timeline renders for a computer tool part. `intent` is model text: timeline only, attributed. */
export interface ComputerPartMetadata extends Schema.Schema.Type<typeof ComputerPartMetadata> {}
export const ComputerPartMetadata = Schema.Struct({
  action: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  app: optional(Schema.Struct({ key: AppKey, name: Safe(256) })),
  target: optional(Schema.Struct({ role: optional(Safe(64)), name: optional(Safe(LIMITS.labelChars)) })),
  text: optional(Schema.Struct({ length: NonNegativeInt, preview: optional(Safe(LIMITS.previewChars)) })),
  keys: optional(Safe(64)),
  point: optional(Point),
  frame: optional(Schema.Struct({ id: Id, width: PositiveInt, height: PositiveInt, hash: Hash })),
  display: optional(NonNegativeInt),
  screenshot: optional(Schema.Boolean),
  screenshotRemoved: optional(Schema.Boolean),
  paused: optional(Schema.Struct({ by: PauseReason, ms: Millis })),
  blocked: optional(Schema.Struct({ reason: BlockReason })),
  handoff: optional(Schema.Struct({ reason: HandoffReason })),
  setup: optional(Schema.Boolean),
  code: optional(ComputerErrorCode),
  intent: optional(Bounded(LIMITS.intentChars)),
}).annotate({ identifier: "Computer.PartMetadata" })

// ---------------------------------------------------------------------------------------------------------------
// 2.9 Desktop state (published on IPC and returned by the bridge's `heartbeat` and `act`)

export const ComputerPhase = Schema.Literals([
  "off",
  "setup",
  "ready",
  "working",
  "asking",
  "handoff",
  "paused",
  "waiting",
  "done",
  "stopped",
]).annotate({ identifier: "Computer.Phase" })
export type ComputerPhase = typeof ComputerPhase.Type

export const AskKind = Schema.Literals(["app", "sensitive", "handoff", "pointer", "check_in"]).annotate({
  identifier: "Computer.AskKind",
})
export type AskKind = typeof AskKind.Type

/** Every string here is built by Vector; model text never enters state. */
export interface ComputerState extends Schema.Schema.Type<typeof ComputerState> {}
export const ComputerState = Schema.Struct({
  phase: ComputerPhase,
  backend: Schema.Literals(["local-macos", "local-windows", "remote"]),
  mode: Mode,
  holder: optional(
    Schema.Struct({
      sessionID: SessionRef,
      directory: Directory,
      title: Safe(256),
      startedAt: Millis,
      actions: NonNegativeInt,
    }),
  ),
  apps: Schema.Array(Schema.Struct({ key: AppKey, name: Safe(256), icon: optional(Icon) })),
  /** Built by Vector from ComputerPartMetadata; never model text. */
  step: optional(Safe(256)),
  pause: optional(PauseReason),
  secureInputHolder: optional(Safe(256)),
  ask: optional(
    Schema.Struct({
      requestID: RequestID,
      directory: Directory,
      kind: AskKind,
      title: Safe(256),
      detail: optional(Safe(1000)),
      canAlways: Schema.Boolean,
      icon: optional(Icon),
      shownAt: Millis,
    }),
  ),
  queue: Schema.Array(Schema.Struct({ sessionID: SessionRef, title: Safe(256) })),
  /** True only in the foreground working phase (drives the banner key hint). */
  escStops: Schema.Boolean,
  stopChord: Safe(64),
  lease: NonNegativeInt,
  reduceMotion: Schema.Boolean,
}).annotate({ identifier: "Computer.State" })

// ---------------------------------------------------------------------------------------------------------------
// 2.8 Bridge wire protocol v1 (engine to desktop)

export interface CaptureBudget extends Schema.Schema.Type<typeof CaptureBudget> {}
export const CaptureBudget = Schema.Struct({
  maxWidth: PositiveInt.check(Schema.isLessThanOrEqualTo(16_384)),
  maxHeight: PositiveInt.check(Schema.isLessThanOrEqualTo(16_384)),
  maxPixels: PositiveInt.check(Schema.isLessThanOrEqualTo(16_384 * 16_384)),
}).annotate({ identifier: "Computer.CaptureBudget" })

export interface Frame extends Schema.Schema.Type<typeof Frame> {}
export const Frame = Schema.Struct({
  id: Id,
  scope: Schema.Literals(["display", "window"]),
  display: Id,
  windowId: optional(Id),
  /** Global DIP. */
  bounds: Rect,
  scale: Scale,
  image: Schema.Struct({ w: PositiveInt, h: PositiveInt }),
  at: Millis,
  /** Perceptual hash, 16 hex digits. */
  hash: Hash,
}).annotate({ identifier: "Computer.Frame" })

/** Screen-derived strings here are untrusted data. */
export interface InspectResult extends Schema.Schema.Type<typeof InspectResult> {}
export const InspectResult = Schema.Struct({
  app: AppIdentity,
  category: AppCategory,
  pid: PositiveInt,
  window: Schema.Struct({ id: Id, title: optional(Bounded(1024)) }),
  element: optional(
    Schema.Struct({
      role: Bounded(64),
      ref: optional(UiRef),
      elementId: optional(Id),
      label: optional(Bounded(1024)),
      secure: Schema.Boolean,
      enabled: Schema.Boolean,
      editable: Schema.Boolean,
    }),
  ),
  document: optional(Path),
  /** `none` is a positive native observation of a non-file editor, not a missing document lookup. */
  documentStatus: optional(Schema.Literals(["none", "known", "unknown"])),
  clipboard: Schema.Struct({
    agentOwned: Schema.Boolean,
    /** Complete text only, never a truncated preview. Desktop still checks the live clipboard before input. */
    text: optional(Bounded(LIMITS.typeTextChars)),
  }),
  /** Observed on the desktop, never supplied by model input. Missing facts do not imply approval. */
  layout: optional(
    Schema.Struct({
      platform: Schema.Literals(["macos", "windows"]),
      keys: optional(
        Schema.Record(
          Bounded(64),
          Schema.Union([
            Bounded(32),
            Schema.Struct({
              key: Bounded(32),
              shift: optional(Bounded(32)),
              altGraph: optional(Bounded(32)),
              shiftAltGraph: optional(Bounded(32)),
            }),
          ]),
        ).check(
          Schema.makeFilter((keys) => Object.keys(keys).length <= 256, { expected: "at most 256 physical keys" }),
        ),
      ),
    }),
  ),
  focusedMenuShortcuts: optional(
    Schema.Array(
      Schema.Struct({ combo: Schema.Array(KeyName).check(Schema.isLengthBetween(1, 8)), label: Bounded(256) }),
    ).check(Schema.isMaxLength(128)),
  ),
  /** Canonical executable or script path resolved at the actual target. */
  programPath: optional(Path),
  elevated: optional(Schema.Boolean),
}).annotate({ identifier: "Computer.InspectResult" })

/** A node from `read_ui`. Screen-derived and untrusted; `value` is never set for secure fields. */
export interface UiNode extends Schema.Schema.Type<typeof UiNode> {}
export const UiNode = Schema.Struct({
  ref: UiRef,
  role: Bounded(64),
  name: optional(Bounded(1024)),
  value: optional(Bounded(4096)),
  /** Frame pixels when a frame exists. */
  bounds: optional(Rect),
  enabled: Schema.Boolean,
  secure: Schema.Boolean,
}).annotate({ identifier: "Computer.UiNode" })

const Button = Schema.Literals(["left", "right", "middle"])
const Modifiers = Schema.Array(KeyName).check(Schema.isMaxLength(8))

export const Step = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("click"),
    button: Button,
    count: Schema.Literals([1, 2, 3]),
    at: Schema.Union([Point, Schema.Struct({ ref: UiRef })]),
    modifiers: Modifiers,
  }),
  Schema.Struct({ kind: Schema.Literal("move"), at: Point }),
  Schema.Struct({ kind: Schema.Literals(["down", "up"]), button: Button }),
  Schema.Struct({
    kind: Schema.Literal("drag"),
    path: Schema.Array(Point).check(Schema.isLengthBetween(LIMITS.dragPointsMin, LIMITS.dragPointsMax)),
    modifiers: Modifiers,
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    at: optional(Point),
    /** Native provider deltas use pixels; omitted means the generic tool's wheel amount. */
    unit: optional(Schema.Literal("pixel")),
    dx: Schema.Int.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
    dy: Schema.Int.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.typeTextChars)),
    ref: optional(UiRef),
  }),
  Schema.Struct({
    kind: Schema.Literal("key"),
    combo: Schema.Array(KeyName).check(Schema.isLengthBetween(1, 8)),
    repeat: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.repeatMax })),
    holdMs: optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: LIMITS.holdSecondsMax * 1000 }))),
  }),
  Schema.Struct({
    kind: Schema.Literal("wait"),
    ms: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: LIMITS.waitSecondsMax * 1000 })),
  }),
]).annotate({ identifier: "Computer.Step" })
export type Step = typeof Step.Type

/** Ids from `list_apps`, or an app name. */
export const AppQuery = Schema.Union([
  Schema.Struct({ key: AppKey }),
  Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)) }),
]).annotate({ identifier: "Computer.AppQuery" })
export type AppQuery = typeof AppQuery.Type

/** `openApp` also takes an executable or script path, which raises the sensitive `run_program` ask. */
const OpenTarget = Schema.Union([...AppQuery.members, Schema.Struct({ path: Path })])

const envelope = {
  v: Schema.Literal(PROTOCOL),
  rootSessionID: SessionRef,
  sessionID: SessionRef,
  directory: Directory,
}

const command = <const C extends string, const F extends Schema.Struct.Fields>(name: C, fields: F) =>
  Schema.Struct({ ...envelope, command: Schema.Literal(name), ...fields })

const Ok = Schema.Struct({ ok: Schema.Literal(true) })

const withAccess = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({ identity: AppIdentity, category: AppCategory, ...fields })

export const StatusResponse = Schema.Struct({
  platform: Schema.Literals(["macos", "windows", "remote"]),
  backendVersion: Bounded(64),
  permissions: Schema.Struct({ screen: PermissionState, accessibility: PermissionState }),
  displays: Schema.Array(
    Schema.Struct({ id: Id, name: Bounded(256), bounds: Rect, scale: Scale, primary: Schema.Boolean }),
  ),
  mode: Mode,
}).annotate({ identifier: "Computer.StatusResponse" })

export const AcquireResponse = Schema.Union([
  Schema.Struct({ lease: Lease }),
  Schema.Struct({ code: Schema.Literal("busy"), holder: Schema.Struct({ title: Safe(256) }) }),
  Schema.Struct({
    code: Schema.Literal("permissions"),
    missing: Schema.Array(Schema.Literals(["screen", "accessibility"])).check(Schema.isMinLength(1)),
  }),
]).annotate({ identifier: "Computer.AcquireResponse" })

export const AccessResponse = Schema.Union([
  withAccess(VerdictNever),
  withAccess(VerdictBlocked),
  withAccess(VerdictCompanyDeny),
  withAccess(VerdictDenied),
  withAccess(VerdictGranted),
  withAccess(VerdictAsk),
]).annotate({ identifier: "Computer.AccessResponse" })

export const ListAppsResponse = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      identity: AppIdentity,
      name: Name,
      running: Schema.Boolean,
      frontmost: Schema.Boolean,
      category: AppCategory,
      verdict: VerdictKind,
      windows: optional(
        Schema.Array(
          Schema.Struct({
            id: Id,
            /** Only for apps granted for this task. */
            title: optional(Bounded(1024)),
            bounds: Rect,
            display: Id,
          }),
        ),
      ),
    }),
  ),
}).annotate({ identifier: "Computer.ListAppsResponse" })

export const ScreenshotResponse = Schema.Struct({
  frame: Frame,
  image: ImageData,
  /** Approved apps visible in the frame. */
  visible: Schema.Array(AppIdentity),
  /** Distinct regular app owners with visible masked pixels, excluding overlays and system furniture. */
  hiddenCount: NonNegativeInt,
  pointer: optional(Point),
}).annotate({ identifier: "Computer.ScreenshotResponse" })

export const ActResponse = Schema.Struct({
  done: NonNegativeInt,
  frame: optional(Frame),
  image: optional(ImageData),
  state: ComputerState,
  pending: optional(
    Schema.Struct({
      index: NonNegativeInt,
      kind: Schema.Literals(["app", "sensitive"]),
      why: optional(SensitiveWhy),
      inspect: InspectResult,
    }),
  ),
  /** Status `waiting_for_user`: a background step needs the real pointer. Returned at once. */
  waiting: optional(Schema.Struct({ waitId: Id, reason: Schema.Literal("pointer") })),
}).annotate({ identifier: "Computer.ActResponse" })

/**
 * Every bridge command with its request body and its 200 response. Requests share the envelope
 * `{v: 1, command, rootSessionID, sessionID, directory}`.
 */
export const BridgeCommands = {
  status: { request: command("status", {}), response: StatusResponse },
  acquire: {
    request: command("acquire", { title: Safe(256), wait: optional(Schema.Boolean) }),
    response: AcquireResponse,
  },
  release: { request: command("release", { lease: Lease }), response: Ok },
  access: {
    /** `liftDeny` turns a recorded deny back into `ask`, never into a grant. */
    request: command("access", { lease: Lease, app: OpenTarget, liftDeny: optional(Schema.Boolean) }),
    response: AccessResponse,
  },
  grant: {
    request: command("grant", { lease: Lease, identity: AppIdentity, level: AskLevel, requestID: RequestID }),
    response: Ok,
  },
  remember: {
    request: command("remember", { identity: AppIdentity, requestID: RequestID }),
    response: Schema.Struct({ saved: Schema.Boolean }),
  },
  prepareOpen: {
    request: command("prepareOpen", { lease: Lease, app: OpenTarget }),
    response: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("app"), identity: AppIdentity }),
      Schema.Struct({ kind: Schema.Literal("program"), program: ProgramLaunch }),
    ]),
  },
  listApps: {
    request: command("listApps", { lease: Lease, query: optional(Bounded(256)), installed: optional(Schema.Boolean) }),
    response: ListAppsResponse,
  },
  openApp: {
    request: command("openApp", {
      lease: Lease,
      app: Schema.Union([...OpenTarget.members, Schema.Struct({ program: ProgramLaunch })]),
      background: optional(Schema.Boolean),
      /** A path launch requires the desktop's observed, once-approved run_program request. */
      requestID: optional(RequestID),
    }),
    response: Schema.Union([
      Schema.Struct({ identity: AppIdentity, launched: Schema.Boolean }),
      Schema.Struct({ program: ProgramLaunch, launched: Schema.Literal(true) }),
      Schema.Struct({
        pending: Schema.Struct({
          kind: Schema.Literal("sensitive"),
          why: Schema.Literal("run_program"),
          program: ProgramLaunch,
        }),
      }),
    ]),
  },
  focusWindow: {
    request: command("focusWindow", { lease: Lease, app: AppQuery, window: optional(Id) }),
    response: Ok,
  },
  screenshot: {
    request: command("screenshot", {
      lease: Lease,
      scope: Schema.Union([
        Schema.Struct({ app: AppQuery, window: optional(Id) }),
        Schema.Struct({ display: optional(Id) }),
      ]),
      budget: CaptureBudget,
      format: optional(Schema.Literals(["jpeg", "png"])),
    }),
    response: ScreenshotResponse,
  },
  zoom: {
    request: command("zoom", { lease: Lease, frame: Id, region: Region, budget: CaptureBudget }),
    response: Schema.Struct({ image: ImageData }),
  },
  inspect: {
    request: command("inspect", {
      lease: Lease,
      frame: optional(Id),
      x: optional(Schema.Int),
      y: optional(Schema.Int),
      ref: optional(UiRef),
      focus: optional(Schema.Boolean),
    }),
    response: InspectResult,
  },
  readUi: {
    request: command("readUi", {
      lease: Lease,
      app: AppQuery,
      window: optional(Id),
      query: optional(Bounded(256)),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.readUiNodesMax })),
    }),
    response: Schema.Struct({ nodes: Schema.Array(UiNode).check(Schema.isMaxLength(LIMITS.readUiNodesMax)) }),
  },
  act: {
    request: command("act", {
      lease: Lease,
      frame: optional(Id),
      steps: Schema.Array(Step).check(Schema.isLengthBetween(1, LIMITS.batchSteps)),
      // Restricts targets to identities checked by the engine for this call; it never grants app access.
      // D16 returns pending app for targets outside this list, including when it is absent or empty.
      allowedApps: optional(Schema.Array(AppKey).check(Schema.isMaxLength(LIMITS.batchSteps))),
      approvals: optional(
        // One live step can require both an app approval and a separate sensitive-action approval.
        // Each reason has its own proof; provider_check can carry three independent provider flags.
        Schema.Array(Schema.Struct({ index: NonNegativeInt, requestID: RequestID })).check(
          Schema.isMaxLength((SensitiveWhy.literals.length + 3) * LIMITS.batchSteps),
        ),
      ),
      settleMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5000 })),
    }),
    response: ActResponse,
  },
  handoff: {
    request: command("handoff", { lease: Lease, phase: Schema.Literals(["start", "end"]), reason: HandoffReason }),
    response: Ok,
  },
  awaitControl: {
    // Pointer waits use their returned ID; a missing ID waits for this lease's paused control state.
    request: command("awaitControl", { lease: Lease, waitId: optional(Id) }),
    response: Schema.Struct({ result: Schema.Literals(["resumed", "stopped", "declined", "pending"]) }),
  },
  heartbeat: { request: command("heartbeat", { lease: Lease }), response: Schema.Struct({ state: ComputerState }) },
  cancel: {
    // Without a lease, cancel only this root's queued acquire. Never stop or release an active holder.
    request: command("cancel", { lease: optional(Lease), requestId: optional(Id) }),
    response: Ok,
  },
} as const

export type BridgeCommandName = keyof typeof BridgeCommands
export const BridgeCommandName = Schema.Literals(Object.keys(BridgeCommands) as BridgeCommandName[]).annotate({
  identifier: "Computer.BridgeCommandName",
})

/** Any `POST /computer` body. */
export const BridgeRequest = Schema.Union([
  BridgeCommands.status.request,
  BridgeCommands.acquire.request,
  BridgeCommands.release.request,
  BridgeCommands.access.request,
  BridgeCommands.grant.request,
  BridgeCommands.remember.request,
  BridgeCommands.prepareOpen.request,
  BridgeCommands.listApps.request,
  BridgeCommands.openApp.request,
  BridgeCommands.focusWindow.request,
  BridgeCommands.screenshot.request,
  BridgeCommands.zoom.request,
  BridgeCommands.inspect.request,
  BridgeCommands.readUi.request,
  BridgeCommands.act.request,
  BridgeCommands.handoff.request,
  BridgeCommands.awaitControl.request,
  BridgeCommands.heartbeat.request,
  BridgeCommands.cancel.request,
]).annotate({ identifier: "Computer.BridgeRequest" })
export type BridgeRequest = typeof BridgeRequest.Type

/** The 409 body: `{ok: false, code, error}`. */
export interface BridgeFailure extends Schema.Schema.Type<typeof BridgeFailure> {}
export const BridgeFailure = Schema.Struct({
  ok: Schema.Literal(false),
  code: ComputerErrorCode,
  error: Bounded(2000),
}).annotate({ identifier: "Computer.BridgeFailure" })

/** `GET /computer/capabilities`. */
export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  protocol: Schema.Literal(PROTOCOL),
  available: Schema.Boolean,
  reason: optional(UnavailableReason),
  backend: Backend,
  actions: Schema.Array(ToolAction),
  features: Schema.Struct({
    background: Schema.Boolean,
    uiTree: Schema.Boolean,
    zoom: Schema.Boolean,
    clipboard: Schema.Boolean,
    /** Locked use is deferred: always false. */
    locked: Schema.Literal(false),
  }),
}).annotate({ identifier: "Computer.Capabilities" })

/** Bridge HTTP surface (section 2.8). */
export const BRIDGE = Object.freeze({
  capabilitiesPath: "/computer/capabilities",
  commandPath: "/computer",
  protocolHeader: "Vector-Computer-Protocol",
  urlEnv: "VECTOR_COMPUTER_BRIDGE_URL",
  tokenEnv: "VECTOR_COMPUTER_BRIDGE_TOKEN",
  host: "127.0.0.1",
})

// ---------------------------------------------------------------------------------------------------------------
// 2.10 Helper protocol v1 (desktop main to native helper)

export const HelperFeature = Schema.Literals([
  "capture.display",
  "capture.window",
  "capture.exclude",
  "capture.zoom",
  "cursor.position",
  "input.pointer",
  "input.keyboard",
  "input.unicode",
  "ui.tree",
  "ui.actions",
  "ui.secureFieldDetect",
  "apps.list",
  "apps.open",
  "apps.resolve",
  "program.launch",
  "clipboard",
  "stop.esc",
  "stop.chord",
  "userInput.detect",
  "background",
  "locked",
]).annotate({ identifier: "Computer.HelperFeature" })
export type HelperFeature = typeof HelperFeature.Type

const HelperRequestId = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Version = Schema.Struct({ min: PositiveInt, max: PositiveInt })
const Service = Schema.Literals(["screen", "accessibility"])
const WindowId = Id
export type NativePhase = { readonly sessionId: string; readonly phaseRevision: number }
const ExpectedPhase = { sessionId: optional(Id), phaseRevision: optional(NonNegativeInt) }

export interface PermissionsStatus extends Schema.Schema.Type<typeof PermissionsStatus> {}
export const PermissionsStatus = Schema.Struct({
  screen: PermissionState,
  accessibility: PermissionState,
  postEvent: optional(PermissionState),
  /** Windows: the privacy switch blocks capture for desktop apps. */
  captureBlocked: optional(Schema.Boolean),
}).annotate({ identifier: "Computer.PermissionsStatus" })

export interface HelperHello extends Schema.Schema.Type<typeof HelperHello> {}
export const HelperHello = Schema.Struct({
  protocol: Version,
  helper: Schema.Struct({
    version: Bounded(64),
    platform: Schema.Literals(["macos", "windows"]),
    arch: Bounded(32),
    os: Bounded(128),
  }),
  /** Unknown feature keys are ignored; a missing feature removes the matching tool actions. */
  features: Schema.Record(Schema.String, Schema.Boolean),
  permissions: PermissionsStatus,
  limits: Schema.Struct({ maxFrameBytes: PositiveInt }),
  /** The helper is its own responsible process for OS grants. */
  responsible: Schema.Boolean,
}).annotate({ identifier: "Computer.HelperHello" })

export interface SessionBegin extends Schema.Schema.Type<typeof SessionBegin> {}
export const SessionBegin = Schema.Struct({
  sessionId: Id,
  mode: Mode,
  /** Main's phase gate; paused sessions may observe but cannot post input or change focus. */
  paused: optional(Schema.Boolean),
  /** Orders phase changes independently of transport timing; older async updates cannot unpause a newer phase. */
  phaseRevision: optional(NonNegativeInt),
  /** Apps granted for this task. The helper refuses every op outside this set and never self-approves. */
  approved: Schema.Array(AppIdentity),
  vectorPids: Schema.Array(PositiveInt),
  vectorWindowIds: Schema.Array(WindowId),
  /** Excluded from capture so frames show what lies under them. */
  overlayWindowIds: Schema.Array(WindowId),
  escStops: Schema.Boolean,
  stopChord: Bounded(64),
  heartbeatMs: Schema.Literal(LIMITS.heartbeatMs),
}).annotate({ identifier: "Computer.SessionBegin" })

export interface DisplayInfo extends Schema.Schema.Type<typeof DisplayInfo> {}
export const DisplayInfo = Schema.Struct({
  id: Id,
  /** macOS points, Windows physical pixels. */
  bounds: Rect,
  pixelSize: Schema.Struct({ w: PositiveInt, h: PositiveInt }),
  scale: Scale,
  dpiScale: optional(Scale),
  primary: Schema.Boolean,
}).annotate({ identifier: "Computer.DisplayInfo" })

export interface NativeCursor extends Schema.Schema.Type<typeof NativeCursor> {}
export const NativeCursor = Schema.Struct({
  /** Global helper units: macOS points or Windows physical pixels, never frame pixels or Electron DIP. */
  x: Schema.Finite,
  y: Schema.Finite,
  displayId: Id,
}).annotate({ identifier: "Computer.NativeCursor" })

export interface HelperApp extends Schema.Schema.Type<typeof HelperApp> {}
export const HelperApp = Schema.Struct({
  identity: AppIdentity,
  active: Schema.Boolean,
  windows: Schema.Array(
    Schema.Struct({
      windowId: WindowId,
      /** Blank for protected windows. */
      title: Bounded(1024),
      bounds: Rect,
      minimized: Schema.Boolean,
      onScreen: Schema.Boolean,
      elevated: optional(Schema.Boolean),
    }),
  ),
}).annotate({ identifier: "Computer.HelperApp" })

export interface CaptureRequest extends Schema.Schema.Type<typeof CaptureRequest> {}
export const CaptureRequest = Schema.Struct({
  op: Schema.Literal("capture"),
  target: Schema.Union([Schema.Struct({ display: Id }), Schema.Struct({ windowId: WindowId })]),
  budget: CaptureBudget,
  format: Schema.Literals(["jpeg", "png"]),
  quality: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  zoom: optional(Schema.Struct({ captureId: Id, region: Region })),
}).annotate({ identifier: "Computer.CaptureRequest" })

/** The JSON header frame; the image follows as one binary frame of `imageBytes` bytes. */
export interface CaptureHeader extends Schema.Schema.Type<typeof CaptureHeader> {}
export const CaptureHeader = Schema.Struct({
  captureId: Id,
  width: PositiveInt,
  height: PositiveInt,
  /** Global origin of the capture in helper units. */
  origin: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
  /** Image pixels per native helper unit (macOS points / Windows physical pixels). */
  imageScale: Scale,
  dpiScale: optional(Scale),
  displayId: Id,
  capturedAtMs: Millis,
  /** Painted blocks, in image pixels. */
  masked: Schema.Array(Rect),
  /** Distinct regular app owners with visible masked pixels, including Vector's main app but excluding overlays,
   * desktop furniture and system notification hosts. Required native fact, never a mask-rectangle estimate. */
  hiddenCount: NonNegativeInt,
  hash: Hash,
  imageBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(LIMITS.helperFrameBytes)),
}).annotate({ identifier: "Computer.CaptureHeader" })

export const TreeRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("ui.tree"), pid: PositiveInt, maxNodes: PositiveInt, maxDepth: PositiveInt }),
  Schema.Struct({ op: Schema.Literal("ui.tree"), windowId: WindowId, maxNodes: PositiveInt, maxDepth: PositiveInt }),
]).annotate({ identifier: "Computer.TreeRequest" })
export type TreeRequest = typeof TreeRequest.Type

export interface TreeResult extends Schema.Schema.Type<typeof TreeResult> {}
export const TreeResult = Schema.Struct({
  generation: NonNegativeInt,
  truncated: Schema.Boolean,
  nodes: Schema.Array(
    Schema.Struct({
      ref: Id,
      role: Bounded(64),
      subrole: optional(Bounded(64)),
      name: Bounded(1024),
      value: optional(Bounded(4096)),
      bounds: Rect,
      enabled: Schema.Boolean,
      focused: Schema.Boolean,
      secure: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "Computer.TreeResult" })

export interface HitResult extends Schema.Schema.Type<typeof HitResult> {}
export const HitResult = Schema.Struct({
  ref: optional(Id),
  /** Stable native element identity within this helper session, even when a fresh ref has a newer generation. */
  elementId: optional(Id),
  role: Bounded(64),
  name: optional(Bounded(1024)),
  secure: Schema.Boolean,
  enabled: optional(Schema.Boolean),
  editable: optional(Schema.Boolean),
  owner: AppIdentity,
  windowId: WindowId,
  signals: optional(Schema.Struct({ childShell: optional(Schema.Boolean), windowClass: optional(Bounded(256)) })),
  windowTitle: optional(Bounded(1024)),
  elevated: optional(Schema.Boolean),
  /** Helper-observed context, never model assertions. Missing observations do not waive live gates. */
  document: optional(Path),
  documentStatus: InspectResult.fields.documentStatus,
  programPath: optional(Path),
  layout: InspectResult.fields.layout,
  focusedMenuShortcuts: InspectResult.fields.focusedMenuShortcuts,
}).annotate({ identifier: "Computer.HitResult" })

/**
 * Input ops. Each is atomic in the helper: the ownership check and the posting happen in one call, and held keys and
 * buttons are released in the same call. Pointer ops carry frame pixels of the named capture; keyboard ops carry the
 * pid the focused app must belong to. Expected windowId/ref/elementId bind the helper's actual live target, and a
 * drag can bind every point separately. The helper checks these immediately before posting or releasing a drag.
 */
const ExpectedInputTarget = {
  windowId: optional(WindowId),
  ref: optional(Id),
  elementId: optional(Id),
}
const ExpectedPointerTarget = { ...ExpectedInputTarget, pid: optional(PositiveInt) }

/** An independently observed owner/element for an action addressed by a native reference. */
export type NativeElementTarget = { readonly pid?: number; readonly elementId?: string }

export const InputOp = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("input.click"),
    ...ExpectedPhase,
    ...ExpectedPointerTarget,
    captureId: Id,
    x: Schema.Int,
    y: Schema.Int,
    button: Button,
    count: Schema.Literals([1, 2, 3]),
    modifiers: Modifiers,
  }),
  Schema.Struct({
    op: Schema.Literal("input.move"),
    ...ExpectedPhase,
    ...ExpectedPointerTarget,
    captureId: Id,
    x: Schema.Int,
    y: Schema.Int,
  }),
  Schema.Struct({
    op: Schema.Literal("input.drag"),
    ...ExpectedPhase,
    captureId: Id,
    path: Schema.Array(Point).check(Schema.isLengthBetween(LIMITS.dragPointsMin, LIMITS.dragPointsMax)),
    targets: optional(
      Schema.Array(Schema.Struct(ExpectedPointerTarget)).check(Schema.isMaxLength(LIMITS.dragPointsMax)),
    ),
    button: Button,
    modifiers: Modifiers,
  }).check(
    Schema.makeFilter((request) => request.targets === undefined || request.targets.length === request.path.length, {
      expected: "one expected target for each drag point",
    }),
  ),
  Schema.Struct({
    op: Schema.Literal("input.scroll"),
    ...ExpectedPhase,
    ...ExpectedPointerTarget,
    captureId: Id,
    unit: optional(Schema.Literal("pixel")),
    x: Schema.Int,
    y: Schema.Int,
    dx: Schema.Int,
    dy: Schema.Int,
  }),
  Schema.Struct({
    op: Schema.Literal("input.key"),
    ...ExpectedPhase,
    pid: PositiveInt,
    ...ExpectedInputTarget,
    combo: Schema.Array(KeyName).check(Schema.isLengthBetween(1, 8)),
    repeat: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.repeatMax })),
  }),
  Schema.Struct({
    op: Schema.Literal("input.type"),
    ...ExpectedPhase,
    pid: PositiveInt,
    ...ExpectedInputTarget,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.typeTextChars)),
  }),
  Schema.Struct({
    op: Schema.Literal("input.hold"),
    ...ExpectedPhase,
    pid: PositiveInt,
    ...ExpectedInputTarget,
    combo: Schema.Array(KeyName).check(Schema.isLengthBetween(1, 8)),
    ms: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: LIMITS.holdSecondsMax * 1000 })),
  }),
]).annotate({ identifier: "Computer.InputOp" })
export type InputOp = typeof InputOp.Type

const op = <const O extends string, const F extends Schema.Struct.Fields>(name: O, fields: F) =>
  Schema.Struct({ op: Schema.Literal(name), ...fields })

const LaunchTarget = Schema.Union([
  op("app.launch", { identity: AppIdentity, ...ExpectedPhase }),
  op("app.launch", { path: Path, ...ExpectedPhase }),
])

/**
 * Every helper op: `args` is the request without its `id`, `result` is the success response without `id` and
 * `ok`. Array results are wrapped (`{displays}`, `{apps}`) so a response stays `{id, ok: true, ...result}`.
 */
export const HelperOps = {
  hello: { args: op("hello", { protocol: Version }), result: HelperHello },
  "permissions.status": { args: op("permissions.status", {}), result: PermissionsStatus },
  /** Called once, only after the user clicks in onboarding; later the deep link is used. */
  "permissions.request": { args: op("permissions.request", { service: Service }), result: PermissionsStatus },
  /** Resets only the helper's own entry. */
  "permissions.reset": { args: op("permissions.reset", { service: Service }), result: PermissionsStatus },
  "session.begin": { args: op("session.begin", SessionBegin.fields), result: Schema.Struct({}) },
  "session.update": {
    args: op("session.update", {
      /** Expected active session identity, never a request to replace it. */
      sessionId: optional(Id),
      phaseRevision: optional(NonNegativeInt),
      approved: optional(SessionBegin.fields.approved),
      mode: optional(Mode),
      escStops: optional(Schema.Boolean),
      paused: optional(Schema.Boolean),
      overlayWindowIds: optional(SessionBegin.fields.overlayWindowIds),
    }),
    result: Schema.Struct({}),
  },
  "session.end": { args: op("session.end", {}), result: Schema.Struct({}) },
  heartbeat: { args: op("heartbeat", {}), result: Schema.Struct({}) },
  "displays.list": { args: op("displays.list", {}), result: Schema.Struct({ displays: Schema.Array(DisplayInfo) }) },
  "cursor.position": { args: op("cursor.position", {}), result: NativeCursor },
  "apps.list": {
    args: op("apps.list", { installed: optional(Schema.Boolean) }),
    result: Schema.Struct({ apps: Schema.Array(HelperApp) }),
  },
  "apps.resolve": { args: op("apps.resolve", { path: Path }), result: LaunchResolution },
  "program.launch": {
    args: op("program.launch", { token: Id, binding: ProgramLaunch.fields.binding, ...ExpectedPhase }),
    result: Schema.Struct({ launched: Schema.Literal(true) }),
  },
  "app.activate": {
    args: op("app.activate", { identity: AppIdentity, ...ExpectedPhase }),
    result: Schema.Struct({ foreground: optional(Schema.Boolean) }),
  },
  "app.launch": { args: LaunchTarget, result: Schema.Struct({ foreground: optional(Schema.Boolean) }) },
  "window.focus": {
    args: op("window.focus", { windowId: WindowId, ...ExpectedPhase }),
    result: Schema.Struct({ foreground: optional(Schema.Boolean) }),
  },
  capture: {
    args: CaptureRequest,
    result: Schema.Union([CaptureHeader, Schema.Struct({ paused: Schema.Literal(true) })]),
  },
  "ui.tree": { args: TreeRequest, result: TreeResult },
  "ui.hittest": { args: op("ui.hittest", { captureId: Id, x: Schema.Int, y: Schema.Int }), result: HitResult },
  "ui.focused": { args: op("ui.focused", {}), result: HitResult },
  /** Re-resolves a generation-bound native element without changing focus or requiring a screenshot. */
  "ui.resolve": { args: op("ui.resolve", { ref: Id }), result: HitResult },
  "ui.perform": {
    args: op("ui.perform", {
      ref: Id,
      action: Bounded(64),
      pid: optional(PositiveInt),
      elementId: optional(Id),
      ...ExpectedPhase,
    }),
    result: Schema.Struct({ took: optional(Schema.Boolean) }),
  },
  "ui.setValue": {
    args: op("ui.setValue", {
      ref: Id,
      value: Bounded(LIMITS.typeTextChars),
      pid: optional(PositiveInt),
      elementId: optional(Id),
      ...ExpectedPhase,
    }),
    result: Schema.Struct({ took: optional(Schema.Boolean) }),
  },
  "input.click": { args: InputOp.members[0], result: Schema.Struct({}) },
  "input.move": { args: InputOp.members[1], result: Schema.Struct({}) },
  "input.drag": { args: InputOp.members[2], result: Schema.Struct({}) },
  "input.scroll": { args: InputOp.members[3], result: Schema.Struct({}) },
  "input.key": { args: InputOp.members[4], result: Schema.Struct({}) },
  "input.type": { args: InputOp.members[5], result: Schema.Struct({}) },
  "input.hold": { args: InputOp.members[6], result: Schema.Struct({}) },
  "input.releaseAll": { args: op("input.releaseAll", {}), result: Schema.Struct({ released: NonNegativeInt }) },
  "clipboard.read": { args: op("clipboard.read", {}), result: Schema.Struct({ text: Bounded(1_000_000) }) },
  "clipboard.write": {
    args: op("clipboard.write", { text: Bounded(1_000_000), ...ExpectedPhase }),
    result: Schema.Struct({}),
  },
  /** A clean no-op when idle. `target` is the id of the request to cancel (the envelope already uses `id`). */
  cancel: { args: op("cancel", { target: optional(HelperRequestId) }), result: Schema.Struct({}) },
  /** Releases input, ends the session and exits. */
  shutdown: { args: op("shutdown", {}), result: Schema.Struct({}) },
} as const

export type HelperOpName = keyof typeof HelperOps
export const HelperOpName = Schema.Literals(Object.keys(HelperOps) as HelperOpName[]).annotate({
  identifier: "Computer.HelperOpName",
})

/** A request frame `{id, op, ...args}` for one op. */
export function helperRequest<O extends HelperOpName>(name: O) {
  const args = HelperOps[name].args as Schema.Top
  const withId = (member: Schema.Top) => {
    const matches = Schema.is(member)
    return Schema.Struct({ id: HelperRequestId, ...(member as Schema.Struct<Schema.Struct.Fields>).fields }).check(
      Schema.makeFilter(
        (value) => {
          const { id, ...body } = value
          return matches(body)
        },
        { expected: `valid ${name} request` },
      ),
    )
  }
  if (args.ast._tag === "Union") {
    const members = (args as unknown as { readonly members: readonly Schema.Top[] }).members
    return Schema.Union(members.map(withId))
  }
  return withId(args)
}

/** A success frame `{id, ok: true, ...result}` for one op. */
export function helperResponse<O extends HelperOpName>(name: O) {
  const result = HelperOps[name].result as Schema.Top
  const withOk = (member: Schema.Top) => {
    const matches = Schema.is(member)
    return Schema.Struct({
      id: HelperRequestId,
      ok: Schema.Literal(true),
      ...(member as Schema.Struct<Schema.Struct.Fields>).fields,
    }).check(
      Schema.makeFilter(
        (value) => {
          const { id, ok, ...body } = value
          return matches(body)
        },
        { expected: `valid ${name} response` },
      ),
    )
  }
  if (result.ast._tag === "Union") {
    const members = (result as unknown as { readonly members: readonly Schema.Top[] }).members
    return Schema.Union(members.map(withOk))
  }
  return withOk(result)
}

/** A failure frame. */
export interface HelperFailure extends Schema.Schema.Type<typeof HelperFailure> {}
export const HelperFailure = Schema.Struct({
  id: HelperRequestId,
  ok: Schema.Literal(false),
  code: ComputerErrorCode,
  error: Bounded(2000),
}).annotate({ identifier: "Computer.HelperFailure" })

/**
 * Events carry no id. `exit` is raised by desktop main's supervisor when the helper process ends; the helper never
 * sends it.
 */
export const HelperEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("user_input"),
    kind: Schema.Literals(["pointer", "key", "click", "scroll"]),
    /** Actual native event owner, never an approved-app or model assertion. Omitted when no owner is known. */
    pid: optional(PositiveInt),
    /** Logical displacement in DIP, normalized by the helper for the event's display (never raw HID counts). */
    dx: optional(Schema.Finite),
    dy: optional(Schema.Finite),
  }),
  Schema.Struct({ event: Schema.Literal("stop"), by: Schema.Literals(["esc", "chord"]) }),
  Schema.Struct({
    event: Schema.Literal("input_detection"),
    alive: Schema.Boolean,
    reason: optional(
      Schema.Literals(["tap_disabled", "secure_input", "probe_missing", "elevated_foreground", "secure_desktop"]),
    ),
    holder: optional(Bounded(256)),
  }),
  Schema.Struct({ event: Schema.Literal("locked"), locked: Schema.Boolean }),
  Schema.Struct({ event: Schema.Literal("display_change") }),
  Schema.Struct({ event: Schema.Literal("exit"), code: optional(Schema.Int), signal: optional(Bounded(32)) }),
]).annotate({ identifier: "Computer.HelperEvent" })
export type HelperEvent = typeof HelperEvent.Type

/** Helper process arguments and exit codes (section 2.10). */
export const HELPER_CLI = Object.freeze({
  version: ["--version", "--json"],
  probe: ["--probe", "--json"],
  serve: ["--stdio", "--parent-pid"],
  selfTest: "--self-test",
  exit: Object.freeze({ pass: 0, fail: 1, usage: 2, skipped: 77 }),
})

// ---------------------------------------------------------------------------------------------------------------
// Desktop-side backend interface (section 2.10)

/** Implemented by the native helper backend (D14), the fake helper, and a reserved remote backend. */
export interface ComputerBackend {
  readonly kind: Backend
  hello(): Promise<HelperHello>
  capabilities(): { actions: ToolAction[]; features: Record<string, boolean> }
  permissions(): Promise<PermissionsStatus>
  beginSession(s: SessionBegin): Promise<void>
  updateSession(s: Partial<SessionBegin>): Promise<void>
  endSession(): Promise<void>
  heartbeat(): Promise<void>
  displays(): Promise<DisplayInfo[]>
  cursorPosition(): Promise<NativeCursor>
  apps(q?: { installed?: boolean }): Promise<HelperApp[]>
  resolveLaunch(path: string): Promise<LaunchResolution>
  launchProgram(program: NativeProgramLaunch, phase?: NativePhase): Promise<void>
  activate(app: AppIdentity, phase?: NativePhase): Promise<void>
  launch(target: AppIdentity | { path: string }, phase?: NativePhase): Promise<void>
  focusWindow(id: string, phase?: NativePhase): Promise<void>
  /** `bytes` is a Uint8Array so the interface stays browser-safe; a Node Buffer satisfies it. */
  capture(req: CaptureRequest, deadlineMs: number): Promise<{ header: CaptureHeader; bytes: Uint8Array }>
  tree(req: TreeRequest, deadlineMs: number): Promise<TreeResult>
  hitTest(captureId: string, x: number, y: number): Promise<HitResult>
  focused(): Promise<HitResult>
  resolveRef(ref: string): Promise<HitResult>
  perform(ref: string, action: string, phase?: NativePhase, expected?: NativeElementTarget): Promise<{ took?: boolean }>
  setValue(ref: string, value: string, phase?: NativePhase, expected?: NativeElementTarget): Promise<{ took?: boolean }>
  input(op: InputOp, deadlineMs: number): Promise<void>
  releaseAll(): Promise<number>
  cancel(id?: string): Promise<void>
  close(): Promise<void>
  /** user_input, stop, input_detection, locked, display_change, exit */
  onEvent(cb: (e: HelperEvent) => void): () => void
}

// ---------------------------------------------------------------------------------------------------------------
// 2.9 Settings, policy and renderer API (desktop-only views)

export const Retention = Schema.Literals(["task", "1d", "7d", "30d", "session"]).annotate({
  identifier: "Computer.Retention",
})
export type Retention = typeof Retention.Type

export type ComputerPrefs = {
  enabled: boolean
  consentedAt?: number
  mode: "background" | "foreground"
  pointer: "ask" | "take"
  blocked: { key: string; name: string; addedAt: number }[]
  /** Removed DEFAULT_BLOCKED keys (`AppMatcher.key`). Never-list entries cannot be removed. */
  unblocked: string[]
  retention: Retention
  stopChord: string
  keepAwake: boolean
  notify: boolean
  reduceMotion: boolean
  granted?: { helperVersion: string; at: number }
}

/** One entry of the desktop's sealed Always-allowed store. */
export type AlwaysAllowed = { key: string; name: string; teamId?: string; publisher?: string; addedAt: number }

/** Company policy: a ceiling, read only from managed sources. Values are allow and deny only. */
export type ComputerPolicy = {
  managed: boolean
  enabled: boolean
  defaultAccess: "ask" | "deny"
  allowAlways: boolean
  background: boolean
  keepAwake: boolean
  awayMinutesMax?: number
  maxRetentionDays?: number
  apps: ReadonlyMap<string, "allow" | "deny">
  /** Rules ignored, such as a third-party macOS rule without a Team ID. */
  ignored: string[]
}

export type ResolvedComputerSettings = {
  prefs: ComputerPrefs
  policy: ComputerPolicy
  always: AlwaysAllowed[]
  builtins: { key: string; name: string; reason: BlockReason; removable: boolean }[]
  locked: (keyof ComputerPrefs)[]
  /** The sealed Always-allowed list failed verification and was discarded (D15). */
  alwaysReset?: boolean
}

export type PermissionsView = {
  rows: {
    id: "screen" | "accessibility"
    status: "granted" | "denied" | "unknown" | "reset-after-update"
    pane: string
  }[]
  canReset: boolean
  adhoc: boolean
  helperStart: "ok" | "failed"
  vectorHoldsGrant: { screen: boolean; accessibility: boolean }
  windows?: { captureBlocked: boolean; elevated: boolean }
}

/** Commands the renderer and tray send to main. None hides the glow or banner. */
export const Command = Schema.Literals(["stop", "takeover", "resume", "stop-session", "hand-over", "not-now"]).annotate(
  {
    identifier: "Computer.Command",
  },
)
export type Command = typeof Command.Type

export const CommandArg = Schema.Struct({ sessionID: optional(SessionRef) }).annotate({
  identifier: "Computer.CommandArg",
})

/** Actions the banner page sends. The banner never offers Always allow. */
export const OverlayAction = Schema.Literals([
  "stop",
  "takeover",
  "resume",
  "allow",
  "deny",
  "continue",
  "hand-over",
  "not-now",
  "keep-going",
]).annotate({ identifier: "Computer.OverlayAction" })
export type OverlayAction = typeof OverlayAction.Type

/**
 * Overlay actions that answer an ask: main rejects them unless `requestID` is the open ask. Keep going extends a
 * check-in and Hand over gives up the real pointer, so they are bound to their request like Allow.
 */
export const OVERLAY_ANSWERS: readonly OverlayAction[] = Object.freeze([
  "allow",
  "deny",
  "continue",
  "keep-going",
  "hand-over",
  "not-now",
])

/** Renderer IPC channels, each behind `assertTrustedRenderer`. */
export const IPC_CHANNELS = Object.freeze([
  "computer-status",
  "computer-state",
  "computer-state-changed",
  "computer-command",
  "computer-prefs",
  "computer-set-prefs",
  "computer-permissions",
  "computer-recheck",
  "computer-open-pane",
  "computer-reset",
  "computer-apps",
  "computer-remove-always",
  "computer-remove-all-always",
  "computer-block",
  "computer-unblock",
  "computer-delete-screenshots",
] as const)

/** Banner page channels, accepted only from the banner's own webContents. */
export const OVERLAY_CHANNELS = Object.freeze(["computer-overlay-act", "computer-overlay-hover"] as const)

/** `window.api.computer`, exposed as `platform.computer`. */
export interface ComputerPlatform {
  /** False on the Linux desktop. */
  supported: boolean
  status(): Promise<{
    available: boolean
    reason?: UnavailableReason
    backend: string
    helper?: { version: string; protocol: number; signing: "developer-id" | "adhoc" | "unsigned" | "dev" }
  }>
  state(): Promise<ComputerState>
  onState(cb: (s: ComputerState) => void): () => void
  command(c: Command, arg?: { sessionID?: string }): Promise<void>
  prefs(): Promise<ResolvedComputerSettings>
  setPrefs(p: Partial<ComputerPrefs>): Promise<ResolvedComputerSettings>
  permissions(): Promise<PermissionsView>
  recheck(): Promise<PermissionsView>
  openPane(id: "screen" | "accessibility" | "windows-capture"): Promise<void>
  reset(id: "screen" | "accessibility"): Promise<PermissionsView>
  apps(
    query?: string,
  ): Promise<
    { key: string; name: string; icon?: string; running: boolean; rule?: "never" | "blocked" | "company-deny" }[]
  >
  removeAlways(key: string): Promise<void>
  removeAllAlways(): Promise<void>
  /**
   * Adds a user block for an `apps()` row. The renderer holds no verified identity (`apps()` returns only key, name,
   * icon, running and rule), so it sends the row's key and name. Main validates the key with `parseAppKey`, cleans
   * the name with `clean`, and stores `{key, name, addedAt}`. A block only restricts access, so it cannot widen it.
   */
  block(app: { key: string; name: string }): Promise<void>
  unblock(key: string): Promise<void>
  deleteScreenshots(): Promise<{ removed: number }>
}

// Runtime key lists for the plain types, so tests can inspect their shape. The extra parameter makes the call fail
// to compile when a key of the type is missing from the list.
const keysOf =
  <T>() =>
  <const K extends readonly (keyof T)[]>(
    keys: K,
    ..._missing: [Exclude<keyof T, K[number]>] extends [never] ? [] : [missing: Exclude<keyof T, K[number]>]
  ): K =>
    Object.freeze(keys)

export const PREFS_KEYS = keysOf<ComputerPrefs>()([
  "enabled",
  "consentedAt",
  "mode",
  "pointer",
  "blocked",
  "unblocked",
  "retention",
  "stopChord",
  "keepAwake",
  "notify",
  "reduceMotion",
  "granted",
])

export const POLICY_KEYS = keysOf<ComputerPolicy>()([
  "managed",
  "enabled",
  "defaultAccess",
  "allowAlways",
  "background",
  "keepAwake",
  "awayMinutesMax",
  "maxRetentionDays",
  "apps",
  "ignored",
])

export const SETTINGS_KEYS = keysOf<ResolvedComputerSettings>()([
  "prefs",
  "policy",
  "always",
  "builtins",
  "locked",
  "alwaysReset",
])

export const PLATFORM_KEYS = keysOf<ComputerPlatform>()([
  "supported",
  "status",
  "state",
  "onState",
  "command",
  "prefs",
  "setPrefs",
  "permissions",
  "recheck",
  "openPane",
  "reset",
  "apps",
  "removeAlways",
  "removeAllAlways",
  "block",
  "unblock",
  "deleteScreenshots",
])
