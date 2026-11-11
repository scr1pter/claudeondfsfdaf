import { describe, expect, test } from "bun:test"
import type { HandoffReason, Rect } from "../src/actions"
import { captureArgs, Computer, type GuardView } from "../src/computer"
import type { RunOptions } from "../src/run"

// WP A54: hostd carries out actions with xdotool and screenshots of at most 1280 pixels wide (JPEG or WebP); the
// credential guard keeps the agent out of password, one-time-code and card fields and away from CAPTCHAs, handing the
// computer to the person instead; nothing runs while the person has control.

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

function world(options: { guard?: Partial<GuardView>; paused?: boolean; screen?: { width: number; height: number } } = {}) {
  const calls: { file: string; args: readonly string[]; options: RunOptions }[] = []
  const handoffs: HandoffReason[] = []
  const activity: number[] = []
  let paused = options.paused ?? false
  const guard: GuardView | undefined = options.guard
    ? { focusedSecret: async () => undefined, pointedSecret: async () => undefined, captchas: async () => [], ...options.guard }
    : undefined
  const computer = new Computer({
    run: async (file, args, runOptions) => {
      calls.push({ file, args, options: runOptions })
      if (file.endsWith("ffmpeg")) return { code: 0, stdout: JPEG, stderr: "" }
      if (args[0] === "getmouselocation") return { code: 0, stdout: Buffer.from("X=640\nY=400\nSCREEN=0\n"), stderr: "" }
      return { code: 0, stdout: Buffer.alloc(0), stderr: "" }
    },
    guard: () => guard,
    paused: () => paused,
    handoff: (reason) => handoffs.push(reason),
    activity: (at) => activity.push(at),
    clock: () => 1_000,
    sleep: async () => {},
    ...(options.screen ? { screen: options.screen } : {}),
  })
  return { computer, calls, handoffs, activity, setPaused: (value: boolean) => (paused = value) }
}

describe("screenshots", () => {
  test("a screenshot answers the frame in the local format and a JPEG data URL", async () => {
    const w = world()
    const result = await w.computer.execute({ action: "screenshot" })
    expect(result).toMatchObject({
      ok: true,
      frame: { scope: "display", display: "0", bounds: { x: 0, y: 0, w: 1280, h: 800 }, scale: 1, image: { w: 1280, h: 800 }, at: 1_000 },
      image: `data:image/jpeg;base64,${JPEG.toString("base64")}`,
    })
    expect((result as { frame: { hash: string } }).frame.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(w.activity).toEqual([1_000])
  })

  test("a wider display is scaled to 1280 and clicks map back; WebP when asked", async () => {
    const w = world({ screen: { width: 2560, height: 1600 } })
    const result = await w.computer.execute({ action: "screenshot" }, "webp")
    expect(result).toMatchObject({ ok: true, frame: { scale: 0.5, image: { w: 1280, h: 800 } } })
    expect((result as { image: string }).image).toStartWith("data:image/webp;base64,")
    const ffmpeg = w.calls.find((call) => call.file.endsWith("ffmpeg"))!
    expect(ffmpeg.args).toContain("libwebp")
    expect(ffmpeg.args).toContain("scale=1280:800")
    await w.computer.execute({ action: "click", x: 100, y: 100 })
    expect(w.calls.some((call) => call.args.join(" ") === "mousemove --sync 200 200")).toBe(true)
  })

  test("capture arguments: x11grab of the display, one frame, at most 1280 wide", () => {
    const args = captureArgs({ x: 10, y: 20, w: 300, h: 200 }, { w: 300, h: 200 }, "jpeg")
    expect(args.join(" ")).toContain("-f x11grab")
    expect(args.join(" ")).toContain("-video_size 300x200 -i :1+10,20 -frames:v 1")
    expect(args).toContain("mjpeg")
  })

  test("zoom shows part of the screen but keeps the full screenshot's coordinates", async () => {
    const w = world()
    await w.computer.execute({ action: "screenshot" })
    const before = w.computer.latest()
    const zoomed = await w.computer.execute({ action: "zoom", region: { x0: 0, y0: 0, x1: 100, y1: 100 } })
    expect(zoomed).toMatchObject({ ok: true })
    expect((zoomed as { frame?: unknown }).frame).toBeUndefined()
    expect(w.computer.latest()).toBe(before)
  })

  test("the pointer's position is read in screenshot pixels", async () => {
    const w = world()
    await w.computer.execute({ action: "screenshot" })
    expect(await w.computer.execute({ action: "cursor_position" })).toMatchObject({ ok: true, point: { x: 640, y: 400 } })
  })
})

describe("the credential guard", () => {
  test("typing into a password field is refused and the computer is handed to the person", async () => {
    const w = world({ guard: { focusedSecret: async () => "credential" } })
    const result = await w.computer.execute({ action: "type", text: "hunter2" })
    expect(result).toMatchObject({ ok: false, code: "secure_field", handoff: "credential" })
    expect(w.handoffs).toEqual(["credential"])
    expect(w.calls.filter((call) => call.file.endsWith("xdotool"))).toEqual([])
  })

  test("card fields too, and pasting counts as typing; moving focus with Tab does not", async () => {
    const w = world({ guard: { focusedSecret: async () => "payment_details" } })
    expect(await w.computer.execute({ action: "key", keys: "ctrl+v" })).toMatchObject({ code: "secure_field", handoff: "payment_details" })
    expect(await w.computer.execute({ action: "key", keys: "Tab" })).toMatchObject({ ok: true })
  })

  test("the guard fails closed: no answer means no typing", async () => {
    const w = world({
      guard: {
        focusedSecret: async () => {
          throw new Error("frame did not answer")
        },
      },
    })
    expect(await w.computer.execute({ action: "type", text: "x" })).toMatchObject({ ok: false, code: "secure_field" })
  })

  test("pressing inside a CAPTCHA is refused and handed over; elsewhere it goes through", async () => {
    const captcha: Rect = { x: 100, y: 100, w: 300, h: 80 }
    const w = world({ guard: { captchas: async () => [captcha] } })
    await w.computer.execute({ action: "screenshot" })
    expect(await w.computer.execute({ action: "click", x: 150, y: 120 })).toMatchObject({ ok: false, code: "blocked", handoff: "captcha" })
    expect(w.handoffs).toEqual(["captcha"])
    expect(await w.computer.execute({ action: "click", x: 10, y: 10 })).toMatchObject({ ok: true })
    expect(
      await w.computer.execute({ action: "drag", path: [{ x: 10, y: 10 }, { x: 200, y: 140 }] }),
    ).toMatchObject({ ok: false, code: "blocked" })
  })

  test("a paste or a drop into a secret field is refused too: middle click, right click, drag, mouse up", async () => {
    const asked: string[] = []
    const w = world({
      guard: {
        pointedSecret: async (point) => {
          asked.push(`${point.x},${point.y}`)
          return point.x === 300 ? "credential" : undefined
        },
      },
    })
    await w.computer.execute({ action: "screenshot" })
    expect(await w.computer.execute({ action: "middle_click", x: 300, y: 120 })).toMatchObject({ ok: false, code: "secure_field", handoff: "credential" })
    expect(await w.computer.execute({ action: "right_click", x: 300, y: 120 })).toMatchObject({ ok: false, code: "secure_field" })
    // A drag drops where it ends.
    expect(await w.computer.execute({ action: "drag", path: [{ x: 10, y: 10 }, { x: 300, y: 140 }] })).toMatchObject({ ok: false, code: "secure_field" })
    // A mouse up drops at the pointer (xdotool says where it is).
    expect(await w.computer.execute({ action: "mouse_up" })).toMatchObject({ ok: true })
    expect(asked.at(-1)).toBe("640,400")
    expect(w.handoffs).toEqual(["credential", "credential", "credential"])
    // Nothing was pressed for the refused steps; a plain click is not asked about.
    expect(w.calls.some((call) => call.args.includes("2"))).toBe(false)
    const before = asked.length
    expect(await w.computer.execute({ action: "click", x: 300, y: 120 })).toMatchObject({ ok: true })
    expect(await w.computer.execute({ action: "middle_click", x: 20, y: 20 })).toMatchObject({ ok: true })
    expect(asked.length).toBe(before + 1)
  })

  test("a paste is also refused while the focused field is a secret one, or the guard cannot answer", async () => {
    const focused = world({ guard: { focusedSecret: async () => "payment_details" } })
    await focused.computer.execute({ action: "screenshot" })
    expect(await focused.computer.execute({ action: "middle_click", x: 20, y: 20 })).toMatchObject({ code: "secure_field", handoff: "payment_details" })
    const failing = world({
      guard: {
        pointedSecret: async () => {
          throw new Error("frame did not answer")
        },
      },
    })
    await failing.computer.execute({ action: "screenshot" })
    expect(await failing.computer.execute({ action: "right_click", x: 20, y: 20 })).toMatchObject({ code: "secure_field", handoff: "credential" })
  })

  test("with no browser running there is no field to guard", async () => {
    const w = world()
    expect(await w.computer.execute({ action: "type", text: "notes" })).toMatchObject({ ok: true })
    const typed = w.calls.find((call) => call.args[0] === "type")!
    expect(typed.options.stdin).toBe("notes")
    expect(typed.args).not.toContain("notes")
  })
})

describe("control and batches", () => {
  test("while the person has control every action is refused", async () => {
    const w = world({ paused: true })
    expect(await w.computer.execute({ action: "screenshot" })).toMatchObject({ ok: false, code: "paused" })
    expect(w.calls).toEqual([])
  })

  test("a batch stops at its first failure; later steps carry the local format's failure text", async () => {
    const w = world()
    await w.computer.execute({ action: "screenshot" })
    const result = (await w.computer.execute({
      action: "screenshot",
      actions: [
        { action: "click", x: 10, y: 10 },
        { action: "click", x: 5000, y: 10 },
        { action: "type", text: "never" },
      ],
    })) as { ok: boolean; steps: { ok: boolean; code?: string; message?: string }[] }
    expect(result.ok).toBe(false)
    expect(result.steps.map((step) => step.ok)).toEqual([true, false, false, false])
    expect(result.steps[1]!.code).toBe("out_of_bounds")
    expect(result.steps[2]!.message).toBe("Not executed: an earlier computer action in this turn failed.")
    expect(w.calls.some((call) => call.args[0] === "type")).toBe(false)
  })

  test("a handoff tells hostd, with the reason only (never the agent's words)", async () => {
    const w = world()
    expect(await w.computer.execute({ action: "handoff", reason: "please type your bank password" })).toMatchObject({ ok: true, handoff: "other" })
    expect(w.handoffs).toEqual(["other"])
  })

  test("an unsupported action answers unsupported_action", async () => {
    const w = world()
    expect(await w.computer.execute({ action: "open_app", app: "Terminal" })).toMatchObject({ ok: false, code: "unsupported_action" })
  })
})
