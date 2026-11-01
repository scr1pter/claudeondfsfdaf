import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerCredential } from "@vectordevai/core/computer/credential"
import { ComputerError } from "./computer-bridge"
import type { GrantScope } from "./computer-grants"

type Target = Computer.CaptureRequest["target"]
type Capture = {
  scope: GrantScope
  phase: Computer.NativePhase
  frame: Computer.Frame
  header: Computer.CaptureHeader
  target: Target
  geometry: Computer.Rect
}
type Reference = { scope: GrantScope; sessionId: string; native: string; generation?: number; elementId?: string }

/** Private coordinate/ref authority. Native IDs never double as engine-facing frame or accessibility IDs. */
export function createComputerFrames(input: {
  backend: Pick<Computer.ComputerBackend, "apps" | "displays" | "resolveRef">
  platform: "macos" | "windows"
  phase(scope: GrantScope): Computer.NativePhase | undefined
  /** Windows must supply a per-display physical→DIP transform, including negative virtual-screen origins. */
  toDip?: (rect: Computer.Rect, displayId: string) => Computer.Rect
}) {
  const frames = new Map<string, Capture>()
  const refs = new Map<string, Reference>()
  const generations = new Map<string, number>()
  let sequence = 0
  let epoch = 0
  const key = (scope: GrantScope) =>
    JSON.stringify([scope.rootSessionID, scope.sessionID, scope.directory, scope.lease])
  const same = (a: GrantScope, b: GrantScope) => key(a) === key(b)
  const phase = (scope: GrantScope, expected?: Computer.NativePhase) => {
    const current = input.phase(scope)
    if (
      !current ||
      (expected && (expected.sessionId !== current.sessionId || expected.phaseRevision !== current.phaseRevision))
    )
      throw new ComputerError("stopped", "This computer coordinate space has ended.")
    return current
  }
  const toDip = (rect: Computer.Rect, displayId: string) => {
    if (input.platform === "windows" && !input.toDip)
      throw new ComputerError("unavailable", "The Windows display transform is unavailable.")
    const result = input.toDip ? input.toDip({ ...rect }, displayId) : { ...rect }
    if (![result.x, result.y, result.w, result.h].every(Number.isFinite) || result.w < 0 || result.h < 0)
      throw new ComputerError("unavailable", "The display transform is invalid.")
    return result
  }
  const record = (scope: GrantScope, id: string) => {
    const entry = frames.get(id)
    const current = phase(scope)
    if (!entry || !same(entry.scope, scope) || entry.phase.sessionId !== current.sessionId)
      throw new ComputerError("stale_frame", "Use a current full screenshot for these coordinates.")
    return entry
  }
  const mint = (scope: GrantScope, native: string, generation?: number, elementId?: string) => {
    const current = phase(scope)
    const existing = [...refs].find(
      ([, entry]) => same(entry.scope, scope) && entry.sessionId === current.sessionId && entry.native === native,
    )
    if (existing) {
      if (elementId && existing[1].elementId && elementId !== existing[1].elementId)
        throw new ComputerError("stale_ref", "The UI element changed.")
      if (elementId) existing[1].elementId = elementId
      return existing[0]
    }
    if (sequence >= 999999)
      throw new ComputerError("stale_ref", "Start a fresh desktop connection to read more UI references.")
    const id = `ui_${++sequence}`
    refs.set(id, { scope: { ...scope }, sessionId: current.sessionId, native, generation, elementId })
    while (refs.size > 4000) refs.delete(refs.keys().next().value!)
    return id
  }

  return {
    toDip,
    async add(
      scope: GrantScope,
      capture: {
        header: Computer.CaptureHeader
        bytes: Uint8Array
        target: Target
        approved: readonly Computer.AppIdentity[]
        phase: Computer.NativePhase
        budget?: Computer.CaptureBudget
      },
    ): Promise<typeof Computer.ScreenshotResponse.Type> {
      const version = epoch
      phase(scope, capture.phase)
      const header = capture.header
      const target = capture.target
      if (capture.bytes.byteLength !== header.imageBytes || header.imageScale <= 0)
        throw new ComputerError("capture_unavailable", "The screenshot is incomplete.")
      const mime = imageMime(capture.bytes)
      const image = `data:${mime};base64,${Buffer.from(capture.bytes).toString("base64")}`
      if (!Schema.is(Computer.ImageData)(image))
        throw new ComputerError("capture_unavailable", "The screenshot exceeds the image limit.")
      const [apps, displays] = await Promise.all([input.backend.apps(), input.backend.displays()])
      phase(scope, capture.phase)
      if (epoch !== version) throw new ComputerError("stopped", "This screenshot arrived after the task changed.")
      const nativeBounds = {
        x: header.origin.x,
        y: header.origin.y,
        w: header.width / header.imageScale,
        h: header.height / header.imageScale,
      }
      const bounds = toDip(nativeBounds, header.displayId)
      const geometry =
        "windowId" in target
          ? apps.flatMap((app) => app.windows).find((window) => window.windowId === target.windowId)?.bounds
          : displays.find((display) => display.id === target.display)?.bounds
      if (
        !geometry ||
        bounds.w <= 0 ||
        bounds.h <= 0 ||
        Math.abs(header.height - (bounds.h * header.width) / bounds.w) > 2
      )
        throw new ComputerError("capture_unavailable", "The screenshot geometry is unavailable.")
      const frame: Computer.Frame = {
        id: `frame_${randomUUID()}`,
        scope: "windowId" in capture.target ? "window" : "display",
        display: header.displayId,
        ...("windowId" in capture.target ? { windowId: capture.target.windowId } : {}),
        bounds,
        scale: header.width / bounds.w,
        image: { w: header.width, h: header.height },
        at: header.capturedAtMs,
        hash: header.hash,
      }
      if (!Schema.is(Computer.Frame)(frame))
        throw new ComputerError("capture_unavailable", "The screenshot geometry is invalid.")
      const approved = new Map(capture.approved.map((identity) => [Computer.appKey(identity), identity]))
      const visible = apps
        .filter(
          (app) =>
            sameObservedIdentity(app.identity, approved.get(Computer.appKey(app.identity))) &&
            app.windows.some((window) => {
              if (window.minimized || !window.onScreen || ("windowId" in target && window.windowId !== target.windowId))
                return false
              const part = intersect(nativeBounds, window.bounds)
              if (!part) return false
              const pixels = {
                x: (part.x - nativeBounds.x) * header.imageScale,
                y: (part.y - nativeBounds.y) * header.imageScale,
                w: part.w * header.imageScale,
                h: part.h * header.imageScale,
              }
              return uncovered(pixels, header.masked)
            }),
        )
        .map((app) => app.identity)
      const response = {
        frame: structuredClone(frame),
        image,
        visible: structuredClone(visible),
        hiddenCount: header.hiddenCount,
      }
      if (Buffer.byteLength(JSON.stringify(response)) > Computer.LIMITS.bridgeResponseBytes)
        throw new ComputerError("capture_unavailable", "The screenshot response exceeds the image limit.")
      frames.set(frame.id, {
        scope: { ...scope },
        phase: { ...capture.phase },
        frame,
        header: structuredClone(header),
        target: { ...target },
        geometry: { ...geometry },
      })
      while (frames.size > Computer.LIMITS.screenshotsKept) frames.delete(frames.keys().next().value!)
      return response
    },
    frame(scope: GrantScope, id: string) {
      return structuredClone(record(scope, id).frame)
    },
    captureId(scope: GrantScope, id: string) {
      return record(scope, id).header.captureId
    },
    latest(scope: GrantScope) {
      const current = phase(scope)
      const entry = [...frames.values()].findLast(
        (entry) => same(entry.scope, scope) && entry.phase.sessionId === current.sessionId,
      )
      return entry && structuredClone(entry.frame)
    },
    point(scope: GrantScope, frame: Computer.Frame | string, point: Computer.Point) {
      const entry = record(scope, typeof frame === "string" ? frame : frame.id)
      if (
        !Number.isInteger(point.x) ||
        !Number.isInteger(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x >= entry.header.width ||
        point.y >= entry.header.height
      )
        throw new ComputerError("stale_frame", "The point is outside the screenshot.")
      const converted = toDip(
        {
          x: entry.header.origin.x + (point.x + 0.5) / entry.header.imageScale,
          y: entry.header.origin.y + (point.y + 0.5) / entry.header.imageScale,
          w: 0,
          h: 0,
        },
        entry.header.displayId,
      )
      return { x: converted.x, y: converted.y }
    },
    pixel(scope: GrantScope, frame: Computer.Frame | string, point: { x: number; y: number }) {
      const entry = record(scope, typeof frame === "string" ? frame : frame.id)
      const pixel = {
        x: Math.floor((point.x - entry.header.origin.x) * entry.header.imageScale),
        y: Math.floor((point.y - entry.header.origin.y) * entry.header.imageScale),
      }
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        pixel.x < 0 ||
        pixel.y < 0 ||
        pixel.x >= entry.header.width ||
        pixel.y >= entry.header.height
      )
        throw new ComputerError("stale_frame", "The pointer is outside the screenshot.")
      return pixel
    },
    async current(scope: GrantScope, frame: Computer.Frame, hit: Computer.HitResult) {
      const version = epoch
      const entry = record(scope, frame.id)
      const target = entry.target
      const geometry =
        "windowId" in target
          ? (await input.backend.apps())
              .flatMap((app) => app.windows)
              .find((window) => window.windowId === target.windowId)?.bounds
          : (await input.backend.displays()).find((display) => display.id === target.display)?.bounds
      phase(scope)
      const latest = [...frames.values()].findLast((candidate) => same(candidate.scope, scope))
      return (
        epoch === version &&
        latest === entry &&
        !!geometry &&
        equalRect(entry.geometry, geometry) &&
        (!("windowId" in entry.target) || hit.windowId === entry.target.windowId)
      )
    },
    tree(scope: GrantScope, tree: Computer.TreeResult, frame?: Computer.Frame, expected?: Computer.NativePhase) {
      phase(scope, expected)
      const previous = generations.get(key(scope))
      if (previous !== undefined && previous !== tree.generation)
        for (const [id, entry] of refs) if (same(entry.scope, scope)) refs.delete(id)
      generations.set(key(scope), tree.generation)
      const capture = frame && record(scope, frame.id)
      return tree.nodes.map((node): Computer.UiNode => {
        const secure = ComputerCredential.field({
          role: node.subrole ?? node.role,
          label: node.name,
          secure: node.secure,
          editable: /text|edit|input|combo/i.test(`${node.role} ${node.subrole ?? ""}`),
          enabled: node.enabled,
        })
        return {
          ref: mint(scope, node.ref, tree.generation),
          role: node.role,
          name: node.name,
          enabled: node.enabled,
          secure,
          ...(!secure && node.value !== undefined ? { value: node.value } : {}),
          ...(capture
            ? {
                bounds: {
                  x: (node.bounds.x - capture.header.origin.x) * capture.header.imageScale,
                  y: (node.bounds.y - capture.header.origin.y) * capture.header.imageScale,
                  w: node.bounds.w * capture.header.imageScale,
                  h: node.bounds.h * capture.header.imageScale,
                },
              }
            : {}),
        }
      })
    },
    async resolve(scope: GrantScope, id: string) {
      const version = epoch
      const current = phase(scope)
      const entry = refs.get(id)
      if (!entry || !same(entry.scope, scope) || entry.sessionId !== current.sessionId)
        throw new ComputerError("stale_ref", "Read the current UI before using this reference.")
      const hit = await input.backend.resolveRef(entry.native)
      phase(scope)
      if (
        version !== epoch ||
        refs.get(id) !== entry ||
        hit.ref !== entry.native ||
        (entry.elementId && hit.elementId !== entry.elementId)
      )
        throw new ComputerError("stale_ref", "The UI element changed.")
      if (hit.elementId) entry.elementId = hit.elementId
      return hit
    },
    uiRef(scope: GrantScope, hit: Computer.HitResult) {
      return hit.ref ? mint(scope, hit.ref, undefined, hit.elementId) : undefined
    },
    clear(scope?: GrantScope) {
      epoch++
      for (const [id, entry] of frames) if (!scope || same(entry.scope, scope)) frames.delete(id)
      for (const [id, entry] of refs) if (!scope || same(entry.scope, scope)) refs.delete(id)
      if (scope) generations.delete(key(scope))
      else generations.clear()
    },
  }
}

export function imageMime(bytes: Uint8Array) {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
    return "image/png"
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
  throw new ComputerError("capture_unavailable", "The helper returned an unsupported image.")
}

function intersect(a: Computer.Rect, b: Computer.Rect) {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y)
  const w = Math.min(a.x + a.w, b.x + b.w) - x,
    h = Math.min(a.y + a.h, b.y + b.h) - y
  return w > 0 && h > 0 ? { x, y, w, h } : undefined
}
function equalRect(a: Computer.Rect, b: Computer.Rect) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}
/** Determine whether any of an approved window's captured area survives the native masks. */
function uncovered(rect: Computer.Rect, masks: readonly Computer.Rect[]) {
  const clipped = masks.flatMap((mask) => {
    const part = intersect(rect, mask)
    return part ? [part] : []
  })
  const xs = [...new Set([rect.x, rect.x + rect.w, ...clipped.flatMap((mask) => [mask.x, mask.x + mask.w])])].sort(
    (a, b) => a - b,
  )
  return xs.slice(1).some((end, index) => {
    const start = xs[index]!
    const intervals = clipped.filter((mask) => mask.x < end && mask.x + mask.w > start).sort((a, b) => a.y - b.y)
    let covered = rect.y
    for (const mask of intervals) {
      if (mask.y > covered) return true
      covered = Math.max(covered, mask.y + mask.h)
    }
    return covered < rect.y + rect.h
  })
}

/** Pixels may only be labelled with the same observed process and signer that was approved for capture. */
function sameObservedIdentity(app: Computer.AppIdentity, expected?: Computer.AppIdentity) {
  if (
    !expected ||
    app.platform === "remote" ||
    expected.platform === "remote" ||
    app.platform !== expected.platform ||
    app.verified !== expected.verified ||
    !app.pid ||
    app.pid !== expected.pid ||
    Computer.appKey(app) !== Computer.appKey(expected)
  )
    return false
  if (app.platform === "macos" && expected.platform === "macos")
    return (
      app.apple === expected.apple &&
      app.teamId?.toLowerCase() === expected.teamId?.toLowerCase() &&
      app.path === expected.path
    )
  if (app.platform === "windows" && expected.platform === "windows")
    return (
      app.kind === expected.kind &&
      app.publisher?.toLowerCase() === expected.publisher?.toLowerCase() &&
      app.exe?.toLowerCase() === expected.exe?.toLowerCase()
    )
  return false
}
