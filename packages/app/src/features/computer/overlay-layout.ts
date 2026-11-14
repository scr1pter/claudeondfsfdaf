export * as ComputerOverlayLayout from "./overlay-layout"

// Where the glow strips, the banner and the agent cursor go (section 1.5 D). Every value is in logical points (DIP),
// as Electron's `screen` reports displays, never physical pixels or frame pixels (INV-R10), so a display's
// scaleFactor never changes a size or a threshold. Rects are Electron-shaped so desktop main can pass
// `screen.getAllDisplays()` straight in. This file has no imports, so desktop main can load it.

export type Rect = { x: number; y: number; width: number; height: number }
export type Point = { x: number; y: number }
export type Display = { id: number; bounds: Rect; workArea: Rect; scaleFactor: number }
export type Edge = "top" | "right" | "bottom" | "left"

/** Glow strip thickness. */
export const STRIP = 24
export const BANNER = Object.freeze({ height: 40, gap: 8, min: 420, max: 640, share: 0.92 })
/** Stepping aside: enter within 24 px of the banner, return after 3 steps clear of 48 px, or after 5 s. */
export const ASIDE = Object.freeze({ enterPx: 24, leavePx: 48, clearSteps: 3, ms: 5000 })

/** Whether the banner is at the bottom, how many steps in a row landed clear of it, and when it last moved down. */
export type Aside = { aside: boolean; clear: number; at: number }
export const HOME: Aside = Object.freeze({ aside: false, clear: 0, at: 0 })

/**
 * The four glow strips of a display, top, right, bottom, left. Top and bottom span the full width; left and right
 * sit between them, so the strips cover the display's border without overlapping.
 */
export function stripBounds(display: Display): { edge: Edge; bounds: Rect }[] {
  const area = whole(display.bounds)
  const thick = Math.min(STRIP, Math.floor(Math.min(area.width, area.height) / 3))
  const side = area.height - 2 * thick
  return [
    { edge: "top", bounds: { x: area.x, y: area.y, width: area.width, height: thick } },
    { edge: "right", bounds: { x: area.x + area.width - thick, y: area.y + thick, width: thick, height: side } },
    { edge: "bottom", bounds: { x: area.x, y: area.y + area.height - thick, width: area.width, height: thick } },
    { edge: "left", bounds: { x: area.x, y: area.y + thick, width: thick, height: side } },
  ]
}

/**
 * The banner, centred in the work area 8 px below the menu bar, notch or a top taskbar, or 8 px above the bottom of
 * the work area when it steps aside. The width is clamped to 420..640 px and then to 92% of the work area.
 */
export function bannerBounds(display: Display, width: number, place: "top" | "bottom" = "top"): Rect {
  const area = whole(display.workArea)
  const wanted = Number.isFinite(width) ? Math.round(width) : BANNER.max
  const size = Math.min(Math.max(wanted, BANNER.min), BANNER.max, Math.floor(area.width * BANNER.share))
  return {
    x: area.x + Math.round((area.width - size) / 2),
    y: place === "top" ? area.y + BANNER.gap : area.y + area.height - BANNER.gap - BANNER.height,
    width: size,
    height: BANNER.height,
  }
}

/**
 * The next step-aside state. `home` is the banner's top rect; distances are always measured against it, so the
 * banner's bottom position never changes the decision. `point` is a pointer step, or undefined for a timer tick
 * (schedule one at `state.at + ASIDE.ms`). A step near home moves the banner down and restarts the 5 s, even while
 * it is already down, so steps that keep landing under the banner never bring it back on the timer.
 */
export function stepAside(state: Aside, home: Rect, point: Point | undefined, now: number): Aside {
  if (point && near(home, point, ASIDE.enterPx)) return { aside: true, clear: 0, at: now }
  if (!state.aside) return state
  if (now - state.at >= ASIDE.ms) return HOME
  if (!point) return state
  if (near(home, point, ASIDE.leavePx)) return { ...state, clear: 0 }
  if (state.clear + 1 >= ASIDE.clearSteps) return HOME
  return { ...state, clear: state.clear + 1 }
}

/** The display holding most of the target window. Ties, no overlap and no target keep the primary display. */
export function bannerDisplay(displays: readonly Display[], target: Rect | undefined, primary: Display): Display {
  if (!target) return primary
  return displays.reduce(
    (best, display) => (overlap(display.bounds, target) > overlap(best.bounds, target) ? display : best),
    primary,
  )
}

/** Whether the agent cursor may be drawn at `point`: inside the target window and under no other window. */
export function cursorVisible(target: Rect, occluders: readonly Rect[], point: Point): boolean {
  return inside(target, point) && !occluders.some((rect) => inside(rect, point))
}

function whole(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  }
}

// Inclusive of the padded edge: a step exactly 24 px from the banner moves it.
function near(rect: Rect, point: Point, pad: number) {
  return (
    point.x >= rect.x - pad &&
    point.x <= rect.x + rect.width + pad &&
    point.y >= rect.y - pad &&
    point.y <= rect.y + rect.height + pad
  )
}

// Half-open, as windows tile: a point on a window's right or bottom edge belongs to its neighbour.
function inside(rect: Rect, point: Point) {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
}

function overlap(a: Rect, b: Rect) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}
