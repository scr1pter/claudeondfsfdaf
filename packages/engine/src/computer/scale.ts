import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import type { Computer } from "@vectordevai/schema/computer"
import type { Provider } from "@/provider/provider"
import { ComputerModels } from "./models"

export type Plan = Computer.CaptureBudget & {
  readonly coords: "pixels" | "grid1000"
  readonly keep: number
  readonly batch: number
}

/** Capture bounds fit attachment dimensions before encoding; callers also enforce the encoded-byte limit. */
export function plan(model: Provider.Model, config: ConfigV1.Info = {}): Plan {
  const small = model.limit.context < 100_000
  const family = ComputerModels.family(model)
  const maxWidth = Math.min(
    small ? 1024 : family ? 1440 : 1280,
    config.computer?.screenshots?.max_width ?? Infinity,
    config.attachment?.image?.max_width ?? 2000,
  )
  const maxHeight = Math.min(
    small ? 640 : family ? 900 : 800,
    config.computer?.screenshots?.max_height ?? Infinity,
    config.attachment?.image?.max_height ?? 2000,
  )
  return {
    maxWidth,
    maxHeight,
    // This conservative ceiling also fits Claude's older vision path when the native runtime is unavailable.
    maxPixels: Math.min(maxWidth * maxHeight, family === "anthropic" ? 1_150_000 : Infinity),
    coords: ComputerModels.coords(model),
    keep: Math.min(config.computer?.screenshots?.keep ?? 3, small ? 2 : 10),
    batch: !small && (family !== undefined || model.cost.cache.read > 0 || model.cost.cache.write > 0) ? 25 : 1,
  }
}

/** Source dimensions are physical capture pixels, never DIP or multiplied again by a display's scale. */
export function fit(width: number, height: number, budget: Computer.CaptureBudget) {
  if (
    ![width, height, budget.maxWidth, budget.maxHeight, budget.maxPixels].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new RangeError("Capture dimensions and budget must be positive integers.")
  const ratio = Math.min(
    1,
    budget.maxWidth / width,
    budget.maxHeight / height,
    Math.sqrt(budget.maxPixels / (width * height)),
  )
  // Avoid losing an edge pixel to floating point error when the limiting bound is an exact integer.
  const w = Math.max(1, Math.min(width, budget.maxWidth, Math.floor(width * ratio + 1e-9), budget.maxPixels))
  return {
    w,
    h: Math.max(
      1,
      Math.min(height, budget.maxHeight, Math.floor(height * ratio + 1e-9), Math.floor(budget.maxPixels / w)),
    ),
  }
}

type Frame = Pick<Computer.Frame, "image">
type Point = { readonly x: number; readonly y: number }

export function fromGrid(value: number, extent: number): number
export function fromGrid(point: Point, frame: Frame): Point
export function fromGrid(value: number | Point, extent: number | Frame): number | Point {
  if (typeof value !== "number" && typeof extent !== "number")
    return { x: fromGrid(value.x, extent.image.w), y: fromGrid(value.y, extent.image.h) }
  if (
    typeof value !== "number" ||
    typeof extent !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 999 ||
    !Number.isSafeInteger(extent) ||
    extent < 1
  )
    throw new RangeError("Grid coordinates must be integers from 0 to 999 in a valid frame.")
  return Math.round((value * (extent - 1)) / 999)
}

export function inBounds(x: number, y: number, frame: Frame) {
  return (
    Number.isSafeInteger(x) &&
    Number.isSafeInteger(y) &&
    Number.isSafeInteger(frame.image.w) &&
    Number.isSafeInteger(frame.image.h) &&
    frame.image.w > 0 &&
    frame.image.h > 0 &&
    x >= 0 &&
    y >= 0 &&
    x < frame.image.w &&
    y < frame.image.h
  )
}

export * as ComputerScale from "./scale"
