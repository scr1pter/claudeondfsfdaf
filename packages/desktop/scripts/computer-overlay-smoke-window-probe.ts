import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron"
import {
  COMPUTER_SMOKE_GEOMETRY_MARK,
  parseComputerSmokeGeometry,
  type ComputerSmokeGeometry,
  type ComputerSmokeLastPhase,
} from "./computer-overlay-smoke-report"

export const COMPUTER_SMOKE_WINDOW_PROBE_MARK = "computer-smoke-window-probe "
export const COMPUTER_SMOKE_WINDOW_PROBE_VARIANTS = [
  "baseline",
  "resizable",
  "lock-after-bounds",
  "explicit-constraints",
] as const
export type ComputerSmokeWindowProbe = {
  protocol: 1
  variant: (typeof COMPUTER_SMOKE_WINDOW_PROBE_VARIANTS)[number]
  requested: ComputerSmokeGeometry["expected"]
  actual: ComputerSmokeGeometry["actual"]
  minimum: [number, number]
  maximum: [number, number]
  content: [number, number]
  resizable: boolean
}

/** Closed hidden-window observations; no native handles, content or exception text. */
export function parseComputerSmokeWindowProbe(line: string): ComputerSmokeWindowProbe {
  if (!line.startsWith(COMPUTER_SMOKE_WINDOW_PROBE_MARK) || line.length > 512)
    throw new Error("The computer smoke window probe receipt is invalid.")
  const value: unknown = JSON.parse(line.slice(COMPUTER_SMOKE_WINDOW_PROBE_MARK.length))
  const fields = ["protocol", "variant", "requested", "actual", "minimum", "maximum", "content", "resizable"]
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    !("variant" in value) ||
    typeof value.variant !== "string" ||
    !COMPUTER_SMOKE_WINDOW_PROBE_VARIANTS.includes(value.variant as ComputerSmokeWindowProbe["variant"]) ||
    !("resizable" in value) ||
    typeof value.resizable !== "boolean"
  )
    throw new Error("The computer smoke window probe receipt is invalid.")
  const record = value as Record<string, unknown>
  const geometry = parseComputerSmokeGeometry(
    COMPUTER_SMOKE_GEOMETRY_MARK +
      JSON.stringify({
        protocol: record.protocol,
        window: 0,
        kind: "top",
        expected: record.requested,
        actual: record.actual,
        minimum: record.minimum,
        maximum: record.maximum,
        content: record.content,
      }),
  )
  return {
    protocol: 1,
    variant: value.variant as ComputerSmokeWindowProbe["variant"],
    requested: geometry.expected,
    actual: geometry.actual,
    minimum: geometry.minimum,
    maximum: geometry.maximum,
    content: geometry.content,
    resizable: value.resizable,
  }
}

export function acceptComputerSmokeWindowProbe(
  line: string,
  input: {
    platform: string
    phase: ComputerSmokeLastPhase
    terminal: boolean
    seen: Set<ComputerSmokeWindowProbe["variant"]>
  },
) {
  if (input.platform !== "win32" || input.phase !== "properties" || input.terminal || input.seen.size >= 4)
    throw new Error("The computer smoke window probe is out of phase or exceeds its bound.")
  const probe = parseComputerSmokeWindowProbe(line)
  if (input.seen.has(probe.variant)) throw new Error("The computer smoke window probe is duplicated.")
  input.seen.add(probe.variant)
  return probe
}

type ProbeWindow = Pick<
  BrowserWindow,
  | "getBounds"
  | "getMinimumSize"
  | "getMaximumSize"
  | "getContentBounds"
  | "isResizable"
  | "setBounds"
  | "setResizable"
  | "destroy"
  | "isDestroyed"
>

/** Four fixed, hidden constructors only. Every created window is destroyed before a receipt returns. */
export function computerSmokeWindowProbes(input: {
  options: BrowserWindowConstructorOptions
  bounds: ComputerSmokeGeometry["expected"]
  create(options: BrowserWindowConstructorOptions): ProbeWindow
}): ComputerSmokeWindowProbe[] {
  return COMPUTER_SMOKE_WINDOW_PROBE_VARIANTS.flatMap((variant) => {
    let window: ProbeWindow | undefined
    try {
      window = input.create({
        ...input.options,
        ...input.bounds,
        show: false,
        focusable: false,
        resizable: variant === "resizable" || variant === "lock-after-bounds",
        ...(variant === "explicit-constraints"
          ? {
              minWidth: input.bounds.width,
              maxWidth: input.bounds.width,
              minHeight: input.bounds.height,
              maxHeight: input.bounds.height,
            }
          : {}),
      })
      if (variant === "lock-after-bounds") {
        window.setBounds(input.bounds)
        window.setResizable(false)
      }
      const content = window.getContentBounds()
      return [
        parseComputerSmokeWindowProbe(
          COMPUTER_SMOKE_WINDOW_PROBE_MARK +
            JSON.stringify({
              protocol: 1,
              variant,
              requested: input.bounds,
              actual: window.getBounds(),
              minimum: window.getMinimumSize(),
              maximum: window.getMaximumSize(),
              content: [content.width, content.height],
              resizable: window.isResizable(),
            }),
        ),
      ]
    } catch {
      // An unavailable observation cannot replace the original failed bounds assertion.
      return []
    } finally {
      if (window && !window.isDestroyed()) window.destroy()
    }
  })
}
