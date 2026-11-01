const overlays = new WeakSet<object>()

/** Window identity survives URL changes; an overlay can never become an ordinary renderer. */
export function registerComputerOverlay(window: object) {
  overlays.add(window)
}

export function isComputerOverlay(window: unknown): boolean {
  return typeof window === "object" && window !== null && overlays.has(window)
}

/** Electron still sees overlays as windows; synthesize the event when only those or hidden hosts remain. */
export function shouldEmitWindowAllClosed(mainCount: number, others: readonly { isVisible(): boolean }[]) {
  return (
    mainCount === 0 && others.length > 0 && others.every((window) => isComputerOverlay(window) || !window.isVisible())
  )
}
