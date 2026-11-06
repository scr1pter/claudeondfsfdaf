import { createHash, randomBytes } from "node:crypto"
import {
  ActionError,
  BATCH_FAILURE,
  checkRegion,
  imageSize,
  plan,
  pressPoints,
  toStep,
  typesText,
  type ErrorCode,
  type Frame,
  type HandoffReason,
  type Point,
  type Rect,
  type ToolAction,
  type ToolInput,
  type ToolStep,
} from "./actions"
import { inside } from "./guard"
import { BINARIES, DISPLAY, SCREEN, SCREENSHOT_MAX_WIDTH, XAUTHORITY } from "./limits"
import { runChecked, type Runner } from "./run"

/*
 * hostd's action executor (contract WP A54): carries out the agent's computer actions on the virtual display with
 * xdotool and takes screenshots (JPEG, or WebP when asked, at most 1280 wide). Before an action it asks the credential
 * guard: nothing is typed into a password, one-time-code or card field, and nothing is pressed inside a CAPTCHA. Both
 * hand the computer to the person instead. While the person has control (a take-over) every action is refused.
 */

export type ImageFormat = "jpeg" | "webp"

export type StepResult =
  | { ok: true; action: ToolAction; frame?: Frame; image?: string; point?: Point; handoff?: HandoffReason }
  | { ok: false; action: ToolAction; code: ErrorCode; message: string; handoff?: HandoffReason }

export type ActionResult = StepResult | { ok: boolean; action: ToolAction; steps: StepResult[] }

/** What the guard answers (BrowserGuard, or nothing while no browser runs). */
export type GuardView = {
  focusedSecret(): Promise<HandoffReason | undefined>
  captchas(): Promise<Rect[]>
}

export type ComputerDeps = {
  run: Runner
  guard: () => GuardView | undefined
  /** Whether the person holds control (a take-over). */
  paused: () => boolean
  /** Called on every action, for the session's last-activity time. */
  activity?: (at: number) => void
  /** Called when the agent hands the computer to the person, or the guard does. */
  handoff?: (reason: HandoffReason) => void
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
  screen?: { width: number; height: number }
}

const X_ENV = { DISPLAY, XAUTHORITY }
const STEP_MS = 15_000

export class Computer {
  private frame: Frame | undefined
  private readonly clock: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly screen: { width: number; height: number }

  constructor(private readonly deps: ComputerDeps) {
    this.clock = deps.clock ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.screen = deps.screen ?? SCREEN
  }

  /** The latest screenshot's frame (coordinates refer to it). */
  latest() {
    return this.frame
  }

  /** Runs one request: a single action, or a batch of up to 10 that stops at its first failure. */
  async execute(input: ToolInput, format: ImageFormat = "jpeg"): Promise<ActionResult> {
    this.deps.activity?.(this.clock())
    if (!input.actions?.length) return this.step(input, format)
    const steps: StepResult[] = []
    let failed = false
    for (const step of [...input.actions, stripBatch(input)]) {
      if (failed) {
        steps.push({ ok: false, action: step.action, code: "failed", message: BATCH_FAILURE })
        continue
      }
      const result = await this.step(step, format)
      steps.push(result)
      if (!result.ok) failed = true
    }
    return { ok: !failed, action: input.action, steps }
  }

  private async step(input: ToolStep & { reason?: string }, format: ImageFormat): Promise<StepResult> {
    try {
      if (this.deps.paused()) throw new ActionError("paused", "The person has control of the computer. Wait for them to hand it back.")
      switch (input.action) {
        case "screenshot":
          return { ok: true, action: input.action, ...(await this.capture(format)) }
        case "zoom": {
          const region = checkRegion(input.region, this.frame)
          const frame = this.frame!
          const rect = {
            x: Math.round(region.x0 / frame.scale),
            y: Math.round(region.y0 / frame.scale),
            w: Math.max(8, Math.round((region.x1 - region.x0) / frame.scale)),
            h: Math.max(8, Math.round((region.y1 - region.y0) / frame.scale)),
          }
          // A zoom shows a part of the screen larger; coordinates stay those of the latest full screenshot.
          const image = await this.grab(rect, format)
          return { ok: true, action: input.action, image: dataUrl(image.bytes, format) }
        }
        case "cursor_position": {
          const result = await runChecked(this.deps.run, BINARIES.xdotool, ["getmouselocation", "--shell"], {
            env: X_ENV,
            timeoutMs: STEP_MS,
          })
          const text = result.stdout.toString("utf8")
          const x = Number(/^X=(\d+)$/m.exec(text)?.[1])
          const y = Number(/^Y=(\d+)$/m.exec(text)?.[1])
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ActionError("failed", "The pointer position could not be read.")
          const scale = this.frame?.scale ?? 1
          return { ok: true, action: input.action, point: { x: Math.round(x * scale), y: Math.round(y * scale) } }
        }
        case "handoff":
          // The agent's own words never travel further: the person is told only that the agent asked for them.
          this.deps.handoff?.("other")
          return { ok: true, action: input.action, handoff: "other" }
      }
      const step = toStep(input, this.frame)
      if (!step) throw new ActionError("unsupported_action", "This action is not available on a cloud computer.")
      const guard = this.deps.guard()
      if (guard) {
        const points = pressPoints(step)
        if (points.length) {
          const rects = await guard.captchas().catch(() => [] as Rect[])
          if (points.some((point) => inside(point, rects))) {
            this.deps.handoff?.("captcha")
            throw new ActionError("blocked", "That is a CAPTCHA. The person solves CAPTCHAs: hand the computer to them.", "captcha")
          }
        }
        if (typesText(step)) {
          const secret = await guard.focusedSecret().catch(() => "credential" as const)
          if (secret) {
            this.deps.handoff?.(secret)
            throw new ActionError(
              "secure_field",
              "The focused field takes a password, a one-time code or card details. The person types these: hand the computer to them.",
              secret,
            )
          }
        }
      }
      for (const command of plan(step)) {
        if ("sleepMs" in command) await this.sleep(command.sleepMs)
        else
          await runChecked(this.deps.run, BINARIES.xdotool, command.argv, {
            env: X_ENV,
            ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
            timeoutMs: STEP_MS,
          })
      }
      if (input.screenshot) return { ok: true, action: input.action, ...(await this.capture(format)) }
      return { ok: true, action: input.action }
    } catch (error) {
      if (error instanceof ActionError)
        return { ok: false, action: input.action, code: error.code, message: error.message, ...(error.handoff ? { handoff: error.handoff } : {}) }
      return { ok: false, action: input.action, code: "failed", message: "The action could not be carried out." }
    }
  }

  private async capture(format: ImageFormat) {
    const bounds = { x: 0, y: 0, w: this.screen.width, h: this.screen.height }
    const image = await this.grab(bounds, format)
    const frame: Frame = {
      id: randomBytes(8).toString("hex"),
      scope: "display",
      display: "0",
      bounds,
      scale: image.size.w / bounds.w,
      image: image.size,
      at: this.clock(),
      hash: createHash("sha256").update(image.bytes).digest("hex").slice(0, 16),
    }
    this.frame = frame
    return { frame, image: dataUrl(image.bytes, format) }
  }

  private async grab(rect: Rect, format: ImageFormat) {
    const size = imageSize(rect.w, rect.h, SCREENSHOT_MAX_WIDTH)
    const result = await this.deps.run(BINARIES.ffmpeg, captureArgs(rect, size, format), {
      env: X_ENV,
      timeoutMs: STEP_MS,
      maxOutput: 16 * 1024 * 1024,
    })
    if (result.code !== 0 || !result.stdout.length)
      throw new ActionError("capture_unavailable", "The screen could not be captured. Try again.")
    return { bytes: result.stdout, size }
  }
}

function stripBatch(input: ToolInput): ToolStep {
  const { actions: _actions, reason: _reason, ...step } = input
  return step
}

function dataUrl(bytes: Buffer, format: ImageFormat) {
  return `data:image/${format};base64,${bytes.toString("base64")}`
}

/** ffmpeg's arguments for one capture of `rect` of the display, scaled to `size`, as one JPEG or WebP image. */
export function captureArgs(rect: Rect, size: { w: number; h: number }, format: ImageFormat) {
  return [
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-draw_mouse",
    "1",
    "-video_size",
    `${rect.w}x${rect.h}`,
    "-i",
    `${DISPLAY}+${rect.x},${rect.y}`,
    "-frames:v",
    "1",
    "-vf",
    `scale=${size.w}:${size.h}`,
    ...(format === "webp" ? ["-c:v", "libwebp", "-quality", "80"] : ["-c:v", "mjpeg", "-q:v", "4"]),
    "-f",
    "image2pipe",
    "-",
  ]
}
