import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerScale } from "./scale"

export class ActionError extends Schema.TaggedErrorClass<ActionError>()("ComputerActionError", {
  code: Schema.Literals(["failed", "stale_frame", "out_of_bounds"]),
  message: Schema.String,
}) {}

/** Translate one generic action. App access, live target inspection and permission checks belong to the caller. */
export function step(
  input: Computer.ToolInput,
  frame?: Computer.Frame,
  coords: "pixels" | "grid1000" = "pixels",
  pixelScroll?: { readonly dx: number; readonly dy: number },
): Computer.Step | undefined {
  if (pixelScroll && input.action !== "scroll")
    throw new ActionError({ code: "failed", message: "Pixel scroll data requires a scroll action." })
  const point = (x: number | undefined, y: number | undefined) => {
    if (x === undefined || y === undefined)
      throw new ActionError({ code: "failed", message: "This action requires both x and y coordinates." })
    if (!frame)
      throw new ActionError({ code: "stale_frame", message: "Take a fresh screenshot before using coordinates." })
    if (
      coords === "grid1000" &&
      (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x > 999 || y > 999)
    )
      throw new ActionError({ code: "out_of_bounds", message: "Grid coordinates must be integers from 0 to 999." })
    const value = coords === "grid1000" ? ComputerScale.fromGrid({ x, y }, frame) : { x, y }
    if (!ComputerScale.inBounds(value.x, value.y, frame))
      throw new ActionError({ code: "out_of_bounds", message: "The coordinates are outside the latest screenshot." })
    return value
  }

  switch (input.action) {
    case "click":
    case "double_click":
    case "triple_click":
    case "right_click":
    case "middle_click": {
      if (input.ref !== undefined && (input.x !== undefined || input.y !== undefined))
        throw new ActionError({
          code: "failed",
          message: "Use either an accessibility ref or coordinates for a click.",
        })
      return checked({
        kind: "click",
        button: input.action === "right_click" ? "right" : input.action === "middle_click" ? "middle" : "left",
        count: input.action === "double_click" ? 2 : input.action === "triple_click" ? 3 : 1,
        at: input.ref === undefined ? point(input.x, input.y) : { ref: input.ref },
        modifiers: keys(input.modifiers, true),
      })
    }
    case "mouse_move":
      return checked({ kind: "move", at: point(input.x, input.y) })
    case "drag":
      if (
        !input.path ||
        input.path.length < Computer.LIMITS.dragPointsMin ||
        input.path.length > Computer.LIMITS.dragPointsMax
      )
        throw new ActionError({ code: "failed", message: "A drag requires a path of 2 to 50 points." })
      return checked({
        kind: "drag",
        path: input.path.map((item) => point(item.x, item.y)),
        modifiers: keys(input.modifiers, true),
      })
    case "mouse_down":
    case "mouse_up":
      if (input.x !== undefined || input.y !== undefined || input.ref !== undefined || input.modifiers !== undefined)
        throw new ActionError({
          code: "failed",
          message: "Mouse down and up use the current pointer. Move it first when needed.",
        })
      return { kind: input.action === "mouse_down" ? "down" : "up", button: "left" }
    case "scroll": {
      if (pixelScroll) {
        if (input.direction !== undefined || input.amount !== undefined || input.ref !== undefined)
          throw new ActionError({ code: "failed", message: "Pixel scroll data cannot mix with wheel amounts or refs." })
        return checked({
          kind: "scroll",
          at: point(input.x, input.y),
          unit: "pixel",
          dx: pixelScroll.dx,
          dy: pixelScroll.dy,
        })
      }
      if (!input.direction) throw new ActionError({ code: "failed", message: "A scroll requires a direction." })
      if (input.ref !== undefined)
        throw new ActionError({
          code: "failed",
          message: "Scrolling uses coordinates or the current pointer, not an accessibility ref.",
        })
      const amount = input.amount ?? 1
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > Computer.LIMITS.scrollAmountMax)
        throw new ActionError({ code: "failed", message: "Scroll amount must be an integer from 1 to 20." })
      return checked({
        kind: "scroll",
        ...(input.x !== undefined || input.y !== undefined ? { at: point(input.x, input.y) } : {}),
        dx: input.direction === "left" ? -amount : input.direction === "right" ? amount : 0,
        dy: input.direction === "up" ? -amount : input.direction === "down" ? amount : 0,
      })
    }
    case "type":
      if (!input.text) throw new ActionError({ code: "failed", message: "Typing requires non-empty text." })
      return checked({ kind: "type", text: input.text, ...(input.ref === undefined ? {} : { ref: input.ref }) })
    case "key":
    case "hold_key":
      return checked({
        kind: "key",
        combo: keys(input.keys),
        repeat: input.repeat ?? 1,
        ...(input.action === "hold_key"
          ? { holdMs: milliseconds(input.seconds ?? 1, Computer.LIMITS.holdSecondsMax) }
          : {}),
      })
    case "wait":
      return { kind: "wait", ms: milliseconds(input.seconds ?? 1, Computer.LIMITS.waitSecondsMax) }
    default:
      return undefined
  }
}

function checked(value: Computer.Step) {
  if (!Schema.is(Computer.Step)(value))
    throw new ActionError({ code: "failed", message: "The action has invalid fields or exceeds the input limits." })
  return value
}

function milliseconds(seconds: number, max: number) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > max)
    throw new ActionError({ code: "failed", message: `The action duration must be between 0 and ${max} seconds.` })
  return Math.round(seconds * 1000)
}

function keys(value: string | undefined, modifiers = false): string[] {
  if (value === undefined && modifiers) return []
  if (!value?.trim())
    throw new ActionError({ code: "failed", message: "The action requires a key or key combination." })
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new ActionError({ code: "failed", message: "Key combinations cannot contain control characters." })
  const result = value === "+" ? ["+"] : value.split("+").map((key) => key.trim())
  if (result.some((key) => !key) || result.length > 8)
    throw new ActionError({ code: "failed", message: "Use a non-empty key combination of at most 8 keys." })
  if (
    modifiers &&
    result.some(
      (key) => !/^(?:shift|ctrl|control|cmd|command|meta|alt|option|super|win|windows|altgr|altgraph)$/i.test(key),
    )
  )
    throw new ActionError({ code: "failed", message: "Pointer modifiers must be modifier keys." })
  return result
}

export * as ComputerActions from "./actions"
