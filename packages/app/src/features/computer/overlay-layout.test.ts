import { describe, expect, test } from "bun:test"
import { ComputerOverlayLayout } from "./overlay-layout"

type Rect = ComputerOverlayLayout.Rect

const display = (
  id: number,
  bounds: Rect,
  workArea: Rect = bounds,
  scaleFactor = 1,
): ComputerOverlayLayout.Display => ({
  id,
  bounds,
  workArea,
  scaleFactor,
})

const area = (rect: Rect) => rect.width * rect.height
const intersects = (a: Rect, b: Rect) =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height
const covered = (rects: Rect[], x: number, y: number) =>
  rects.some((rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)

// A MacBook at 2x with the menu bar, a 1.5x external monitor to its left, and a portrait monitor above it.
const laptop = display(1, { x: 0, y: 0, width: 1512, height: 982 }, { x: 0, y: 25, width: 1512, height: 957 }, 2)
const external = display(
  2,
  { x: -2560, y: 0, width: 2560, height: 1440 },
  { x: -2560, y: 0, width: 2560, height: 1400 },
  1.5,
)
const portrait = display(
  3,
  { x: 200, y: -1920, width: 1080, height: 1920 },
  { x: 200, y: -1920, width: 1080, height: 1880 },
  1,
)

describe("glow strips", () => {
  test("four strips per display at mixed DPI", () => {
    for (const screen of [laptop, external, portrait]) {
      const strips = ComputerOverlayLayout.stripBounds(screen)
      expect(strips.map((strip) => strip.edge)).toEqual(["top", "right", "bottom", "left"])
      const rects = strips.map((strip) => strip.bounds)
      for (const strip of strips) {
        expect(contains(screen.bounds, strip.bounds)).toBe(true)
        const thickness = strip.edge === "top" || strip.edge === "bottom" ? strip.bounds.height : strip.bounds.width
        expect(thickness).toBe(ComputerOverlayLayout.STRIP)
        for (const value of Object.values(strip.bounds)) expect(Number.isInteger(value)).toBe(true)
      }
      for (const [index, rect] of rects.entries())
        for (const other of rects.slice(index + 1)) expect(intersects(rect, other)).toBe(false)
      // The strips cover exactly the 24 px frame of the display.
      const frame = rects.reduce((sum, rect) => sum + area(rect), 0)
      const { width, height } = screen.bounds
      expect(frame).toBe(width * height - (width - 48) * (height - 48))
      const { x, y } = screen.bounds
      for (const [px, py] of [
        [x, y],
        [x + width - 1, y],
        [x + width - 1, y + height - 1],
        [x, y + height - 1],
        [x + 23, y + height / 2],
        [x + width - 24, y + height / 2],
        [x + width / 2, y + 23],
        [x + width / 2, y + height - 24],
      ])
        expect(covered(rects, px, py)).toBe(true)
      expect(covered(rects, x + 24, y + 24)).toBe(false)
      expect(covered(rects, x + width - 25, y + height - 25)).toBe(false)
    }
    expect(ComputerOverlayLayout.stripBounds(external)[3]!.bounds).toEqual({ x: -2560, y: 24, width: 24, height: 1392 })
    expect(ComputerOverlayLayout.stripBounds(portrait)[0]!.bounds).toEqual({
      x: 200,
      y: -1920,
      width: 1080,
      height: 24,
    })
  })

  test("strip sizes ignore the scale factor and stay inside a tiny display", () => {
    for (const scale of [1, 1.25, 1.5, 2, 3])
      expect(ComputerOverlayLayout.stripBounds({ ...laptop, scaleFactor: scale })).toEqual(
        ComputerOverlayLayout.stripBounds(laptop),
      )
    const tiny = display(9, { x: 10, y: 10, width: 30, height: 60 })
    const strips = ComputerOverlayLayout.stripBounds(tiny)
    for (const strip of strips) {
      expect(contains(tiny.bounds, strip.bounds)).toBe(true)
      expect(strip.bounds.width).toBeGreaterThan(0)
      expect(strip.bounds.height).toBeGreaterThan(0)
    }
    expect(strips[0]!.bounds.height).toBe(10)
  })
})

describe("banner", () => {
  test("the banner sits 8 px below the menu bar, a notch or a top taskbar, centred and 40 px tall", () => {
    const notch = display(4, { x: 0, y: 0, width: 1728, height: 1117 }, { x: 0, y: 38, width: 1728, height: 1079 }, 2)
    const taskbar = display(
      5,
      { x: 1920, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 48, width: 1920, height: 1032 },
    )
    for (const [screen, top] of [
      [laptop, 33],
      [notch, 46],
      [taskbar, 56],
      [external, 8],
    ] as const) {
      const rect = ComputerOverlayLayout.bannerBounds(screen, 640)
      expect(rect.y).toBe(top)
      expect(rect.y).toBe(screen.workArea.y + 8)
      expect(rect.height).toBe(40)
      expect(rect.width).toBe(640)
      expect(rect.x - screen.workArea.x).toBe(screen.workArea.x + screen.workArea.width - (rect.x + rect.width))
    }
  })

  test("it is clamped to 420..640 px and to 92% of a narrow work area", () => {
    expect(ComputerOverlayLayout.bannerBounds(laptop, 300).width).toBe(420)
    expect(ComputerOverlayLayout.bannerBounds(laptop, 900).width).toBe(640)
    expect(ComputerOverlayLayout.bannerBounds(laptop, 512.6).width).toBe(513)
    expect(ComputerOverlayLayout.bannerBounds(laptop, Number.NaN).width).toBe(640)
    const narrow = display(6, { x: 100, y: 0, width: 400, height: 800 }, { x: 100, y: 25, width: 400, height: 775 })
    const rect = ComputerOverlayLayout.bannerBounds(narrow, 640)
    expect(rect).toEqual({ x: 116, y: 33, width: 368, height: 40 })
    expect(contains(narrow.workArea, rect)).toBe(true)
    // Between 420 / 0.92 and 640 / 0.92 the 92% cap decides.
    const medium = display(7, { x: 0, y: 0, width: 600, height: 800 })
    expect(ComputerOverlayLayout.bannerBounds(medium, 640).width).toBe(552)
  })

  test("stepping aside puts it 8 px above the bottom of the work area", () => {
    const dock = display(8, { x: 0, y: 0, width: 1512, height: 982 }, { x: 0, y: 25, width: 1512, height: 887 }, 2)
    expect(ComputerOverlayLayout.bannerBounds(dock, 640, "bottom")).toEqual({ x: 436, y: 864, width: 640, height: 40 })
    expect(ComputerOverlayLayout.bannerBounds(dock, 640, "top")).toEqual({ x: 436, y: 33, width: 640, height: 40 })
  })

  test("bannerDisplay picks the display with most of the target", () => {
    const displays = [laptop, external, portrait]
    // Straddles the laptop and the external display; most of it is on the external one.
    expect(ComputerOverlayLayout.bannerDisplay(displays, { x: -900, y: 100, width: 1200, height: 600 }, laptop)).toBe(
      external,
    )
    expect(ComputerOverlayLayout.bannerDisplay(displays, { x: -300, y: 100, width: 1200, height: 600 }, external)).toBe(
      laptop,
    )
    expect(ComputerOverlayLayout.bannerDisplay(displays, { x: 300, y: -500, width: 400, height: 800 }, laptop)).toBe(
      portrait,
    )
    // An even split keeps the primary display, whichever is listed first.
    expect(ComputerOverlayLayout.bannerDisplay(displays, { x: -500, y: 100, width: 1000, height: 400 }, laptop)).toBe(
      laptop,
    )
    expect(ComputerOverlayLayout.bannerDisplay(displays, { x: -500, y: 100, width: 1000, height: 400 }, external)).toBe(
      external,
    )
    // Off every display, zero-sized, or unknown: the primary display.
    expect(ComputerOverlayLayout.bannerDisplay(displays, { x: 9000, y: 9000, width: 300, height: 300 }, laptop)).toBe(
      laptop,
    )
    expect(ComputerOverlayLayout.bannerDisplay(displays, { x: -300, y: 100, width: 0, height: 600 }, external)).toBe(
      external,
    )
    expect(ComputerOverlayLayout.bannerDisplay(displays, undefined, portrait)).toBe(portrait)
  })
})

describe("stepping aside", () => {
  const home = ComputerOverlayLayout.bannerBounds(laptop, 640)
  const below = (gap: number) => ({ x: home.x + 100, y: home.y + home.height + gap })
  const far = { x: 20, y: 700 }

  test("the step-aside hysteresis sequence", () => {
    const step = ComputerOverlayLayout.stepAside
    // 24 px from the banner moves it; 25 px does not.
    expect(step(ComputerOverlayLayout.HOME, home, below(25), 1000)).toBe(ComputerOverlayLayout.HOME)
    expect(step(ComputerOverlayLayout.HOME, home, { x: home.x - 25, y: home.y }, 1000)).toBe(ComputerOverlayLayout.HOME)
    const down = step(ComputerOverlayLayout.HOME, home, below(24), 1000)
    expect(down).toEqual({ aside: true, clear: 0, at: 1000 })
    expect(step(ComputerOverlayLayout.HOME, home, { x: home.x + home.width + 24, y: home.y - 24 }, 1000).aside).toBe(
      true,
    )

    // Two clear steps, then one within 48 px resets the count; three clear steps in a row bring it back.
    const one = step(down, home, far, 1100)
    expect(one).toEqual({ aside: true, clear: 1, at: 1000 })
    const two = step(one, home, far, 1200)
    expect(two).toEqual({ aside: true, clear: 2, at: 1000 })
    const reset = step(two, home, below(48), 1300)
    expect(reset).toEqual({ aside: true, clear: 0, at: 1000 })
    const counted = step(step(reset, home, below(49), 1400), home, far, 1500)
    expect(counted).toEqual({ aside: true, clear: 2, at: 1000 })
    expect(step(counted, home, far, 1600)).toEqual(ComputerOverlayLayout.HOME)
  })

  test("a timer tick returns it after 5 s, measured from the last step under the banner", () => {
    const step = ComputerOverlayLayout.stepAside
    const down = step(ComputerOverlayLayout.HOME, home, below(10), 0)
    expect(step(down, home, undefined, 4999)).toBe(down)
    expect(step(down, home, undefined, 5000)).toEqual(ComputerOverlayLayout.HOME)
    // A step past 5 s returns it even when the step itself is within 48 px.
    expect(step(down, home, below(40), 5000)).toEqual(ComputerOverlayLayout.HOME)

    // Steps that keep landing under the banner restart the 5 s, so it does not flap back on the timer.
    const again = step(down, home, below(0), 4900)
    expect(again).toEqual({ aside: true, clear: 0, at: 4900 })
    expect(step(again, home, undefined, 5100)).toBe(again)
    expect(step(again, home, undefined, 9899).aside).toBe(true)
    expect(step(again, home, undefined, 9900)).toEqual(ComputerOverlayLayout.HOME)

    // A tick while home changes nothing.
    expect(step(ComputerOverlayLayout.HOME, home, undefined, 50_000)).toBe(ComputerOverlayLayout.HOME)
  })

  test("distances are measured against the top position, not the banner's bottom position", () => {
    const step = ComputerOverlayLayout.stepAside
    const down = step(ComputerOverlayLayout.HOME, home, below(0), 0)
    const bottom = ComputerOverlayLayout.bannerBounds(laptop, 640, "bottom")
    const onBottom = { x: bottom.x + 10, y: bottom.y + 10 }
    expect(step(down, home, onBottom, 100)).toEqual({ aside: true, clear: 1, at: 0 })
  })
})

describe("cursor", () => {
  test("cursor and step-aside use DIP", () => {
    // A window on a 2x display, in logical points: physical pixels would double every number.
    const target = { x: 100, y: 100, width: 800, height: 600 }
    const occluder = { x: 500, y: 300, width: 300, height: 200 }
    expect(ComputerOverlayLayout.cursorVisible(target, [occluder], { x: 200, y: 200 })).toBe(true)
    expect(ComputerOverlayLayout.cursorVisible(target, [occluder], { x: 600, y: 400 })).toBe(false)
    expect(ComputerOverlayLayout.cursorVisible(target, [occluder], { x: 950, y: 400 })).toBe(false)
    // Half-open: the right and bottom edges belong to the next window.
    expect(ComputerOverlayLayout.cursorVisible(target, [], { x: 100, y: 100 })).toBe(true)
    expect(ComputerOverlayLayout.cursorVisible(target, [], { x: 900, y: 400 })).toBe(false)
    expect(ComputerOverlayLayout.cursorVisible(target, [], { x: 400, y: 700 })).toBe(false)
    expect(ComputerOverlayLayout.cursorVisible(target, [occluder], { x: 800, y: 400 })).toBe(true)
    expect(ComputerOverlayLayout.cursorVisible({ x: 100, y: 100, width: 0, height: 600 }, [], { x: 100, y: 200 })).toBe(
      false,
    )

    // The step-aside thresholds are logical points on every display: the same step moves the banner at any scale.
    for (const scale of [1, 1.5, 2]) {
      const screen = { ...laptop, scaleFactor: scale }
      const home = ComputerOverlayLayout.bannerBounds(screen, 640)
      expect(home).toEqual(ComputerOverlayLayout.bannerBounds(laptop, 640))
      const edge = { x: home.x + 10, y: home.y + home.height + 24 }
      expect(ComputerOverlayLayout.stepAside(ComputerOverlayLayout.HOME, home, edge, 0).aside).toBe(true)
      expect(
        ComputerOverlayLayout.stepAside(ComputerOverlayLayout.HOME, home, { ...edge, y: edge.y + 1 }, 0).aside,
      ).toBe(false)
    }
  })
})
