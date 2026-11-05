import CoreGraphics
import Foundation

private struct GeometryTestFailure: Error { let message: String }

private func geometryCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw GeometryTestFailure(message: message) }
}

private func geometryThrows(_ code: String, _ body: () throws -> Void) throws {
    do { try body() }
    catch let failure as ServerFailure {
        try geometryCheck(failure.code == code, "Expected \(code), received \(failure.code).")
        return
    }
    throw GeometryTestFailure(message: "Expected geometry failure \(code).")
}

private func geometryProcess(pid: Int32 = 410, start: UInt64 = 12, path: String = "/Applications/Test.app/Contents/MacOS/Test") -> HelperProcessIdentity {
    HelperProcessIdentity(pid: pid, parentPID: 400, startSeconds: start, startMicroseconds: 20, executable: path)
}

private func geometryRecord(
    id: String = "frame", session: String = "session", epoch: UUID, revision: Int? = 7,
    generation: UInt64 = 0, bounds: CGRect = CGRect(x: -100, y: -50, width: 100, height: 80),
    width: Int = 100, height: Int = 80, imageScale: Double = 1, captureScale: Double = 2,
    nativePixelSize: CGSize? = nil, windowID: String? = nil, windowFrame: CGRect? = nil,
    process: HelperProcessIdentity? = nil, windows: [CaptureWindowWitness] = [],
    space: String? = nil, zoom: String? = nil
) -> CaptureGeometry {
    CaptureGeometry(captureID: id, displayID: "display-left", bounds: bounds,
                    nativePixelSize: nativePixelSize ?? CGSize(width: bounds.width * captureScale, height: bounds.height * captureScale),
                    captureScale: captureScale, width: width, height: height, imageScale: imageScale,
                    sessionID: session, observationEpoch: epoch, phaseRevision: revision,
                    configurationGeneration: generation, windowID: windowID, windowFrame: windowFrame,
                    ownerProcess: process, windows: windows, spaceWitness: space, zoomSourceID: zoom)
}

/// All fixtures are numbers and private metadata; this suite never observes or captures the desktop.
func runGeometryTests() throws -> Int {
    var count = 0
    do {
        let budget = try CaptureBudget(maxWidth: 16384, maxHeight: 16384, maxPixels: 16384 * 16384)
        let fit = try budget.fit(sourceWidth: 1920, sourceHeight: 1080)
        try geometryCheck(fit.width == 1920 && fit.height == 1080 && fit.scale == 1, "A large budget must never upscale.")
        let tiny = try budget.fit(sourceWidth: 1, sourceHeight: 1)
        try geometryCheck(tiny.width == 1 && tiny.height == 1 && tiny.scale == 1, "One native pixel must stay one pixel.")
        count += 1
    }
    do {
        let fit = try CaptureBudget(maxWidth: 1920, maxHeight: 1080, maxPixels: 1920 * 1080)
            .fit(sourceWidth: 3840, sourceHeight: 2160)
        try geometryCheck(fit.width == 1920 && fit.height == 1080 && fit.scale == 0.5, "Retina downscale must use one factor.")
        count += 1
    }
    do {
        let fit = try CaptureBudget(maxWidth: 4000, maxHeight: 2000, maxPixels: 2_000_000)
            .fit(sourceWidth: 4000, sourceHeight: 2000)
        try geometryCheck(fit.width == 2000 && fit.height == 1000 && fit.scale == 0.5, "The pixel count must constrain both axes.")
        let portrait = try CaptureBudget(maxWidth: 2000, maxHeight: 300, maxPixels: 2_000_000)
            .fit(sourceWidth: 1000, sourceHeight: 2000)
        try geometryCheck(portrait.width == 150 && portrait.height == 300, "Height limits must preserve portrait aspect.")
        count += 1
    }
    do {
        let fit = try CaptureBudget(maxWidth: 333, maxHeight: 333, maxPixels: 333 * 333)
            .fit(sourceWidth: 1001, sourceHeight: 777)
        try geometryCheck(fit.width == 333 && fit.height == 258, "Nonintegral raster dimensions must round down.")
        try geometryCheck(abs(fit.scale - 333.0 / 1001.0) < 1e-14, "Scale must not be replaced by the rounded height ratio.")
        let frame = geometryRecord(epoch: UUID(), bounds: CGRect(x: -2000, y: -900, width: 1001, height: 777),
                                   width: fit.width, height: fit.height, imageScale: fit.scale, captureScale: 1)
        let last = try frame.point(x: 332, y: 257)
        let pixel = try frame.pixel(point: last)
        try geometryCheck(pixel.x == 332 && pixel.y == 257 && last.x < -999 && last.y < -123,
                          "Rounding must keep the final pixel center inside its original native rectangle.")
        count += 1
    }
    do {
        let budget = try CaptureBudget(maxWidth: 4, maxHeight: 4, maxPixels: 16)
        let fit = try budget.fit(sourceWidth: 5.5, sourceHeight: 3.25)
        try geometryCheck(fit.width == 4 && fit.height == 2 && abs(fit.scale - 4.0 / 5.5) < 1e-14,
                          "Fractional native crops must use their original dimensions, without ceil/floor source distortion.")
        let frame = geometryRecord(epoch: UUID(), bounds: CGRect(x: -50, y: -20, width: 2.75, height: 1.625),
                                   width: fit.width, height: fit.height, imageScale: fit.scale * 2)
        let last = try frame.point(x: 3, y: 1)
        let pixel = try frame.pixel(point: last)
        try geometryCheck(pixel.x == 3 && pixel.y == 1, "Fractional crops must keep the same coordinate scale after fitting.")
        for dimensions in [(Double.nan, 3.25), (5.5, Double.infinity), (0.0, 3.25), (-0.5, 3.25)] {
            try geometryThrows("capture_unavailable") { _ = try budget.fit(sourceWidth: dimensions.0, sourceHeight: dimensions.1) }
        }
        count += 1
    }
    do {
        let original = CGRect(x: -1440, y: -900, width: 1001, height: 777)
        let fit = try CaptureBudget(maxWidth: 333, maxHeight: 333, maxPixels: 333 * 333)
            .fit(sourceWidth: 1001, sourceHeight: 777)
        // Native capture trims the right/bottom remainder before SCK preserves the source aspect ratio.
        let rasterBounds = CGRect(origin: original.origin,
                                  size: CGSize(width: Double(fit.width) / fit.scale, height: Double(fit.height) / fit.scale))
        let epoch = UUID()
        let registry = CaptureRegistry()
        let process = geometryProcess()
        let witness = CaptureWindowWitness(windowID: "odd-window", process: process, bounds: original)
        try registry.store(geometryRecord(epoch: epoch, bounds: rasterBounds, width: fit.width, height: fit.height,
                                          imageScale: fit.scale, captureScale: 1, windowID: witness.windowID,
                                          windowFrame: original, process: process, windows: [witness]))
        let frame = try registry.get("frame", sessionID: "session", observationEpoch: epoch)
        try geometryCheck(abs(Double(frame.bounds.width) * frame.imageScale - Double(frame.width)) < 1e-10 &&
                          abs(Double(frame.bounds.height) * frame.imageScale - Double(frame.height)) < 1e-10,
                          "The returned raster source must have exactly the output aspect ratio and uniform scale.")
        try geometryCheck(frame.bounds.origin == original.origin && frame.bounds.height < original.height &&
                          frame.windowFrame == original && frame.windows[0].bounds == original,
                          "Trimming a raster must preserve the original process/window witness for later stale checks.")
        let fullZoom = try frame.zoomRegion(x0: 0, y0: 0, x1: frame.width, y1: frame.height)
        try geometryCheck(fullZoom == rasterBounds, "A full zoom must use the exact retained raster source, without hidden padding.")
        let last = try frame.point(x: frame.width - 1, y: frame.height - 1)
        let inverse = try frame.pixel(point: last)
        try geometryCheck(inverse.x == frame.width - 1 && inverse.y == frame.height - 1,
                          "The final trimmed raster pixel must retain its native center mapping.")
        try geometryThrows("out_of_bounds") {
            _ = try frame.pixel(point: CGPoint(x: original.minX + 1, y: original.maxY - 0.01))
        }
        count += 1
    }
    do {
        for budget in [(0, 10, 100), (10, 0, 100), (10, 10, 0), (-1, 10, 100),
                       (16385, 10, 100), (10, 16385, 100), (10, 10, 16384 * 16384 + 1)] {
            try geometryThrows("failed") { _ = try CaptureBudget(maxWidth: budget.0, maxHeight: budget.1, maxPixels: budget.2) }
        }
        let valid = JSONValue.object(["maxWidth": .integer(20), "maxHeight": .integer(10), "maxPixels": .integer(200)])
        try geometryCheck(CaptureBudget(wire: valid) != nil, "A strict wire budget should decode.")
        for invalid in [JSONValue.bool(true), .array([]), .object([:]),
                        .object(["maxWidth": .bool(true), "maxHeight": .integer(10), "maxPixels": .integer(200)]),
                        .object(["maxWidth": .number(2.5), "maxHeight": .integer(10), "maxPixels": .integer(200)]),
                        .object(["maxWidth": .integer(20), "maxHeight": .integer(10), "maxPixels": .integer(200), "extra": .null])] {
            try geometryCheck(CaptureBudget(wire: invalid) == nil, "Malformed budget must not coerce or accept extra fields.")
        }
        count += 1
    }
    do {
        let budget = try CaptureBudget(maxWidth: 100, maxHeight: 100, maxPixels: 10_000)
        for source in [(0, 1), (1, 0), (-1, 1), (1, -1), (1, 100_000)] {
            try geometryThrows("capture_unavailable") { _ = try budget.fit(sourceWidth: source.0, sourceHeight: source.1) }
        }
        let huge = try budget.fit(sourceWidth: Int.max, sourceHeight: Int.max)
        try geometryCheck(huge.width > 0 && huge.width <= 100 && huge.height > 0 && huge.height <= 100,
                          "Budget math must not overflow on oversized source dimensions.")
        count += 1
    }
    do {
        // Exercise the three independent caps and odd aspect ratios without duplicating the fitting formula.
        for source in [(17, 13), (1920, 1080), (3840, 2160), (1080, 3840), (999, 1001)] {
            for limits in [(300, 200, 40_000), (1024, 900, 500_000), (16384, 16384, 268_435_456)] {
                let fit = try CaptureBudget(maxWidth: limits.0, maxHeight: limits.1, maxPixels: limits.2)
                    .fit(sourceWidth: source.0, sourceHeight: source.1)
                try geometryCheck(fit.width <= limits.0 && fit.height <= limits.1 && fit.width * fit.height <= limits.2,
                                  "Every fitted frame must satisfy every cap.")
                try geometryCheck(fit.scale <= 1 && fit.width <= source.0 && fit.height <= source.1, "Fits must never upscale.")
                try geometryCheck(Double(source.0) * fit.scale - Double(fit.width) < 1.0000001 &&
                                  Double(source.1) * fit.scale - Double(fit.height) < 1.0000001,
                                  "Both raster axes must represent the same scale within one pixel of rounding.")
            }
        }
        count += 1
    }
    do {
        for scale in [0.25, 0.5, 1.0, 2.0] {
            let frame = geometryRecord(epoch: UUID(), bounds: CGRect(x: -1440, y: -900, width: 640, height: 360),
                                       width: Int(640 * scale), height: Int(360 * scale), imageScale: scale)
            for (x, y) in [(0, 0), (1, 1), (frame.width / 2, frame.height / 2), (frame.width - 1, frame.height - 1)] {
                let point = try frame.point(x: x, y: y)
                let pixel = try frame.pixel(point: point)
                try geometryCheck(pixel.x == x && pixel.y == y, "Pixel centers must round-trip on negative-origin displays.")
                try geometryCheck(abs(Double(point.x) - (-1440 + (Double(x) + 0.5) / scale)) < 1e-10,
                                  "Image scale must mean pixels per point.")
            }
        }
        count += 1
    }
    do {
        let frame = geometryRecord(epoch: UUID(), width: 200, height: 160, imageScale: 2)
        let first = try frame.point(x: 0, y: 0)
        try geometryCheck(first == CGPoint(x: -99.75, y: -49.75), "Retina pixel centers use half a pixel, without a Y flip.")
        let origin = try frame.pixel(point: CGPoint(x: -100, y: -50))
        try geometryCheck(origin.x == 0 && origin.y == 0, "Top-left native edges are inclusive.")
        let lowerRight = try frame.pixel(point: CGPoint(x: -0.001, y: 29.999))
        try geometryCheck(lowerRight.x == 199 && lowerRight.y == 159, "Bottom-right interior points must floor to the final pixel.")
        count += 1
    }
    do {
        let frame = geometryRecord(epoch: UUID())
        for pixel in [(-1, 0), (0, -1), (100, 0), (0, 80), (Int.max, Int.max)] {
            try geometryThrows("out_of_bounds") { _ = try frame.point(x: pixel.0, y: pixel.1) }
        }
        for point in [CGPoint(x: -100.001, y: -50), CGPoint(x: -100, y: -50.001),
                      CGPoint(x: 0, y: 0), CGPoint(x: -10, y: 30),
                      CGPoint(x: Double.nan, y: 0), CGPoint(x: 0, y: Double.infinity)] {
            try geometryThrows("out_of_bounds") { _ = try frame.pixel(point: point) }
        }
        count += 1
    }
    do {
        // The cropped-off subpixel strip after raster rounding is not an addressable image pixel.
        let frame = geometryRecord(epoch: UUID(), bounds: CGRect(x: 0, y: 0, width: 10.5, height: 8.5), width: 10, height: 8)
        try geometryThrows("out_of_bounds") { _ = try frame.pixel(point: CGPoint(x: 10.25, y: 1)) }
        try geometryThrows("out_of_bounds") { _ = try frame.pixel(point: CGPoint(x: 1, y: 8.25)) }
        let last = try frame.point(x: 9, y: 7)
        try geometryCheck(last == CGPoint(x: 9.5, y: 7.5), "Addressable rounded pixels must retain the declared uniform scale.")
        count += 1
    }
    do {
        let frame = geometryRecord(epoch: UUID(), bounds: CGRect(x: -1000, y: -500, width: 400, height: 200),
                                   width: 200, height: 100, imageScale: 0.5)
        let region = try frame.zoomRegion(x0: 50, y0: 25, x1: 150, y1: 75)
        try geometryCheck(region == CGRect(x: -900, y: -450, width: 200, height: 100),
                          "Zoom edges must refer to the original full-frame pixel space.")
        let full = try frame.zoomRegion(x0: 0, y0: 0, x1: 200, y1: 100)
        try geometryCheck(full == frame.bounds, "A full-size zoom must preserve global top-left origin.")
        for region in [(-1, 0, 1, 1), (0, -1, 1, 1), (1, 0, 1, 1), (0, 1, 1, 1),
                       (0, 0, 201, 1), (0, 0, 1, 101), (Int.min, 0, Int.max, 1)] {
            try geometryThrows("out_of_bounds") { _ = try frame.zoomRegion(x0: region.0, y0: region.1, x1: region.2, y1: region.3) }
        }
        count += 1
    }
    do {
        let epoch = UUID()
        let registry = CaptureRegistry()
        try registry.store(geometryRecord(id: "base", epoch: epoch))
        let zoom = geometryRecord(id: "zoom", epoch: epoch, zoom: "base")
        try registry.store(zoom)
        try geometryThrows("stale_frame") { _ = try registry.get("zoom", sessionID: "session", observationEpoch: epoch) }
        let metadata = try registry.get("zoom", sessionID: "session", observationEpoch: epoch, allowZoom: true)
        try geometryCheck(metadata.zoomSourceID == "base", "Zoom metadata may be inspected explicitly.")
        try geometryThrows("stale_frame") { _ = try zoom.point(x: 0, y: 0) }
        try geometryThrows("stale_frame") { _ = try zoom.pixel(point: CGPoint(x: -99, y: -49)) }
        try geometryThrows("stale_frame") { _ = try zoom.zoomRegion(x0: 0, y0: 0, x1: 1, y1: 1) }
        let base = try registry.get("base", sessionID: "session", observationEpoch: epoch)
        try geometryCheck(base.captureID == "base" && base.zoomSourceID == nil, "Zoom must never replace the original input frame.")
        count += 1
    }
    do {
        let epoch = UUID()
        let registry = CaptureRegistry(limit: 2)
        try registry.store(geometryRecord(id: "one", epoch: epoch))
        try registry.store(geometryRecord(id: "two", epoch: epoch))
        _ = try registry.get("one", sessionID: "session", observationEpoch: epoch)
        try registry.store(geometryRecord(id: "three", epoch: epoch))
        try geometryThrows("stale_frame") { _ = try registry.get("one", sessionID: "session", observationEpoch: epoch) }
        _ = try registry.get("two", sessionID: "session", observationEpoch: epoch)
        _ = try registry.get("three", sessionID: "session", observationEpoch: epoch)
        count += 1
    }
    do {
        let epoch = UUID()
        let registry = CaptureRegistry(limit: 1000)
        for index in 0..<33 { try registry.store(geometryRecord(id: "frame-\(index)", epoch: epoch)) }
        try geometryThrows("stale_frame") { _ = try registry.get("frame-0", sessionID: "session", observationEpoch: epoch) }
        _ = try registry.get("frame-1", sessionID: "session", observationEpoch: epoch)
        let minimum = CaptureRegistry(limit: 0)
        try minimum.store(geometryRecord(id: "one", epoch: epoch))
        try minimum.store(geometryRecord(id: "two", epoch: epoch))
        try geometryThrows("stale_frame") { _ = try minimum.get("one", sessionID: "session", observationEpoch: epoch) }
        count += 1
    }
    do {
        let epoch = UUID()
        let registry = CaptureRegistry()
        try registry.store(geometryRecord(epoch: epoch))
        try geometryThrows("stale_frame") { try registry.store(geometryRecord(epoch: UUID(), bounds: CGRect(x: 0, y: 0, width: 100, height: 80))) }
        let original = try registry.get("frame", sessionID: "session", observationEpoch: epoch)
        try geometryCheck(original.bounds.origin == CGPoint(x: -100, y: -50), "A repeated capture id must not replace its original witness.")
        try geometryThrows("stale_frame") { _ = try registry.get("frame", sessionID: "other", observationEpoch: epoch) }
        try geometryThrows("stale_frame") { _ = try registry.get("frame", sessionID: "session", observationEpoch: UUID()) }
        try geometryThrows("stale_frame") { _ = try registry.get("frame", sessionID: "session", observationEpoch: epoch, phaseRevision: 8) }
        _ = try registry.get("frame", sessionID: "session", observationEpoch: epoch, phaseRevision: 7)
        count += 1
    }
    do {
        let oldEpoch = UUID()
        let registry = CaptureRegistry()
        try registry.store(geometryRecord(epoch: oldEpoch, revision: 7))
        // Both an end/begin and a same-revision approval/overlay update rotate this internal epoch.
        for _ in 0..<2 {
            try geometryThrows("stale_frame") { _ = try registry.get("frame", sessionID: "session", observationEpoch: UUID(), phaseRevision: 7) }
        }
        let legacy = geometryRecord(id: "legacy", epoch: oldEpoch, revision: nil)
        try registry.store(legacy)
        _ = try registry.get("legacy", sessionID: "session", observationEpoch: oldEpoch)
        try geometryThrows("stale_frame") { _ = try registry.get("legacy", sessionID: "session", observationEpoch: oldEpoch, phaseRevision: 7) }
        count += 1
    }
    do {
        let epoch = UUID()
        let registry = CaptureRegistry()
        let asynchronous = geometryRecord(epoch: epoch, generation: registry.generation)
        try registry.store(asynchronous)
        registry.invalidateDisplays()
        try geometryCheck(registry.generation == 1, "Display changes must advance the capture configuration generation.")
        try geometryThrows("stale_frame") { _ = try registry.get("frame", sessionID: "session", observationEpoch: epoch) }
        try geometryThrows("stale_frame") { try registry.store(asynchronous) }
        try registry.store(geometryRecord(id: "fresh", epoch: epoch, generation: registry.generation))
        registry.clear()
        try geometryCheck(registry.generation == 2, "Session clearing must also invalidate in-flight capture metadata.")
        try geometryThrows("stale_frame") { _ = try registry.get("fresh", sessionID: "session", observationEpoch: epoch) }
        count += 1
    }
    do {
        let epoch = UUID()
        let registry = CaptureRegistry()
        let invalid = [
            geometryRecord(id: "", epoch: epoch),
            geometryRecord(id: "bad-origin", epoch: epoch, bounds: CGRect(x: Double.nan, y: 0, width: 100, height: 80)),
            geometryRecord(id: "bad-size", epoch: epoch, bounds: CGRect(x: 0, y: 0, width: 0, height: 80)),
            geometryRecord(id: "bad-scale", epoch: epoch, imageScale: Double.infinity),
            geometryRecord(id: "upscale", epoch: epoch, width: 300, height: 240, imageScale: 3),
            geometryRecord(id: "mismatched-raster", epoch: epoch, width: 80),
            geometryRecord(id: "bad-native", epoch: epoch, nativePixelSize: CGSize(width: 0, height: 80)),
            geometryRecord(id: "bad-revision", epoch: epoch, revision: -1),
            geometryRecord(id: "bad-owner", epoch: epoch, process: geometryProcess(pid: 0)),
        ]
        for record in invalid {
            try geometryThrows("stale_frame") { try registry.store(record) }
            try geometryThrows("stale_frame") { _ = try record.point(x: 0, y: 0) }
        }
        count += 1
    }
    do {
        let epoch = UUID()
        let process = geometryProcess()
        let original = CaptureWindowWitness(windowID: "window-1", process: process,
                                            bounds: CGRect(x: -100, y: -50, width: 100, height: 80), spaceWitness: "space-a")
        let registry = CaptureRegistry()
        try registry.store(geometryRecord(epoch: epoch, windowID: original.windowID, windowFrame: original.bounds,
                                          process: process, windows: [original], space: "space-a"))
        let retained = try registry.get("frame", sessionID: "session", observationEpoch: epoch)
        try geometryCheck(retained.windows == [original] && retained.ownerProcess == process && retained.windowFrame == original.bounds,
                          "A frame must retain the private process, window and space witnesses for native input stale checks.")
        for changed in [
            CaptureWindowWitness(windowID: "window-2", process: process, bounds: original.bounds, spaceWitness: "space-a"),
            CaptureWindowWitness(windowID: original.windowID, process: geometryProcess(start: 13), bounds: original.bounds, spaceWitness: "space-a"),
            CaptureWindowWitness(windowID: original.windowID, process: geometryProcess(path: "/different/Test"), bounds: original.bounds, spaceWitness: "space-a"),
            CaptureWindowWitness(windowID: original.windowID, process: process, bounds: original.bounds.offsetBy(dx: 1, dy: 0), spaceWitness: "space-a"),
            CaptureWindowWitness(windowID: original.windowID, process: process, bounds: CGRect(x: -100, y: -50, width: 101, height: 80), spaceWitness: "space-a"),
            CaptureWindowWitness(windowID: original.windowID, process: process, bounds: original.bounds, onScreen: false, spaceWitness: "space-a"),
            CaptureWindowWitness(windowID: original.windowID, process: process, bounds: original.bounds, minimized: true, spaceWitness: "space-a"),
            CaptureWindowWitness(windowID: original.windowID, process: process, bounds: original.bounds, alpha: 0, spaceWitness: "space-a"),
            CaptureWindowWitness(windowID: original.windowID, process: process, bounds: original.bounds, spaceWitness: "space-b"),
        ] {
            try geometryCheck(retained.windows[0] != changed, "Every process/geometry/visibility/space change must remain detectable.")
        }
        count += 1
    }
    do {
        let epoch = UUID()
        let registry = CaptureRegistry()
        let offscreen = CaptureWindowWitness(windowID: "offscreen", process: geometryProcess(),
                                             bounds: CGRect(x: -10000, y: -10000, width: 100, height: 80), onScreen: false)
        try registry.store(geometryRecord(epoch: epoch, bounds: offscreen.bounds, windowID: offscreen.windowID,
                                          windowFrame: offscreen.bounds, process: offscreen.process, windows: [offscreen]))
        let stored = try registry.get("frame", sessionID: "session", observationEpoch: epoch)
        try geometryCheck(stored.windows[0].onScreen == false && stored.windows[0].minimized == false,
                          "A fully offscreen independent window must not be classified as minimized.")
        _ = try stored.point(x: 0, y: 0)
        count += 1
    }
    do {
        let epoch = UUID()
        let witness = CaptureWindowWitness(windowID: "window", process: geometryProcess(),
                                          bounds: CGRect(x: 0, y: 0, width: 100, height: 80))
        let registry = CaptureRegistry()
        try registry.store(geometryRecord(id: "catalog", epoch: epoch, windows: Array(repeating: witness, count: 4096)))
        try geometryThrows("stale_frame") {
            try registry.store(geometryRecord(id: "too-many", epoch: epoch, windows: Array(repeating: witness, count: 4097)))
        }
        let large = CaptureWindowWitness(windowID: "large", process: geometryProcess(path: "/" + String(repeating: "a", count: 4_000)),
                                        bounds: witness.bounds)
        try geometryThrows("stale_frame") {
            try registry.store(geometryRecord(id: "too-large", epoch: epoch, windows: Array(repeating: large, count: 270)))
        }
        count += 1
    }
    return count
}
