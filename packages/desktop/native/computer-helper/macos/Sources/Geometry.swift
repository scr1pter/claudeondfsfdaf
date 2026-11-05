import CoreGraphics
import Foundation

struct CapturePixelSize {
    let width: Int
    let height: Int
    /// A single isotropic factor, before integer raster dimensions are rounded down.
    let scale: Double
}

struct CaptureBudget {
    let maxWidth: Int
    let maxHeight: Int
    let maxPixels: Int

    init(maxWidth: Int, maxHeight: Int, maxPixels: Int) throws {
        guard (1...16384).contains(maxWidth), (1...16384).contains(maxHeight),
              (1...(16384 * 16384)).contains(maxPixels) else {
            throw ServerFailure(code: "failed", message: "The capture budget is invalid.")
        }
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
        self.maxPixels = maxPixels
    }

    init?(wire: JSONValue) {
        guard let value = wire.objectValue,
              Set(value.keys) == Set(["maxWidth", "maxHeight", "maxPixels"]),
              let width = value["maxWidth"]?.intValue,
              let height = value["maxHeight"]?.intValue,
              let pixels = value["maxPixels"]?.intValue,
              let budget = try? CaptureBudget(maxWidth: width, maxHeight: height, maxPixels: pixels) else { return nil }
        self = budget
    }

    func fit(sourceWidth: Int, sourceHeight: Int) throws -> CapturePixelSize {
        try fit(sourceWidth: Double(sourceWidth), sourceHeight: Double(sourceHeight))
    }

    func fit(sourceWidth: Double, sourceHeight: Double) throws -> CapturePixelSize {
        guard sourceWidth.isFinite, sourceHeight.isFinite, sourceWidth > 0, sourceHeight > 0 else {
            throw ServerFailure(code: "capture_unavailable", message: "The capture source has no pixels.")
        }
        let width = sourceWidth
        let height = sourceHeight
        var scale = min(1, Double(maxWidth) / width, Double(maxHeight) / height,
                        sqrt(Double(maxPixels) / (width * height)))
        guard scale.isFinite, scale > 0 else {
            throw ServerFailure(code: "capture_unavailable", message: "The capture source cannot fit the budget.")
        }
        var resultWidth = Int((width * scale).rounded(.down))
        var resultHeight = Int((height * scale).rounded(.down))
        // Floating-point rounding at an exact cap must never exceed the declared budget.
        if resultWidth > maxWidth || resultHeight > maxHeight || resultWidth * resultHeight > maxPixels {
            scale = scale.nextDown
            resultWidth = Int((width * scale).rounded(.down))
            resultHeight = Int((height * scale).rounded(.down))
        }
        // Stretching a subpixel axis to one pixel would invent a different coordinate scale.
        guard resultWidth > 0, resultHeight > 0, resultWidth <= maxWidth, resultHeight <= maxHeight,
              resultWidth * resultHeight <= maxPixels else {
            throw ServerFailure(code: "capture_unavailable", message: "The capture aspect ratio cannot fit the budget.")
        }
        return CapturePixelSize(width: resultWidth, height: resultHeight, scale: scale)
    }
}

struct CaptureWindowWitness: Equatable {
    let windowID: String
    let process: HelperProcessIdentity
    let bounds: CGRect
    let onScreen: Bool
    let minimized: Bool
    let alpha: Double
    let spaceWitness: String?
    let hosted: HostedWindowProof?

    init(windowID: String, process: HelperProcessIdentity, bounds: CGRect,
         onScreen: Bool = true, minimized: Bool = false, alpha: Double = 1, spaceWitness: String? = nil,
         hosted: HostedWindowProof? = nil) {
        self.windowID = windowID
        self.process = process
        self.bounds = bounds
        self.onScreen = onScreen
        self.minimized = minimized
        self.alpha = alpha
        self.spaceWitness = spaceWitness
        self.hosted = hosted
    }
}

/// Native geometry and private ownership witnesses only; no image bytes or reusable app approvals.
/// Bounds are already global Quartz top-left points, including negative display origins.
struct CaptureGeometry {
    let captureID: String
    let displayID: String
    let bounds: CGRect
    let nativePixelSize: CGSize
    let captureScale: Double
    let width: Int
    let height: Int
    /// Returned image pixels per global point, not the inverse transform.
    let imageScale: Double
    let sessionID: String
    let observationEpoch: UUID
    let phaseRevision: Int?
    let configurationGeneration: UInt64
    let windowID: String?
    let windowFrame: CGRect?
    let ownerProcess: HelperProcessIdentity?
    let windows: [CaptureWindowWitness]
    let spaceWitness: String?
    let zoomSourceID: String?

    init(captureID: String, displayID: String, bounds: CGRect, nativePixelSize: CGSize,
         captureScale: Double, width: Int, height: Int, imageScale: Double,
         sessionID: String, observationEpoch: UUID, phaseRevision: Int?, configurationGeneration: UInt64,
         windowID: String? = nil, windowFrame: CGRect? = nil, ownerProcess: HelperProcessIdentity? = nil,
         windows: [CaptureWindowWitness] = [], spaceWitness: String? = nil, zoomSourceID: String? = nil) {
        self.captureID = captureID
        self.displayID = displayID
        self.bounds = bounds
        self.nativePixelSize = nativePixelSize
        self.captureScale = captureScale
        self.width = width
        self.height = height
        self.imageScale = imageScale
        self.sessionID = sessionID
        self.observationEpoch = observationEpoch
        self.phaseRevision = phaseRevision
        self.configurationGeneration = configurationGeneration
        self.windowID = windowID
        self.windowFrame = windowFrame
        self.ownerProcess = ownerProcess
        self.windows = windows
        self.spaceWitness = spaceWitness
        self.zoomSourceID = zoomSourceID
    }

    func point(x: Int, y: Int) throws -> CGPoint {
        try requireActionFrame()
        guard x >= 0, y >= 0, x < width, y < height else {
            throw ServerFailure(code: "out_of_bounds", message: "The image pixel is outside the capture.")
        }
        let result = CGPoint(x: Double(bounds.minX) + (Double(x) + 0.5) / imageScale,
                             y: Double(bounds.minY) + (Double(y) + 0.5) / imageScale)
        guard contains(result) else {
            throw ServerFailure(code: "out_of_bounds", message: "The image pixel is outside the native capture.")
        }
        return result
    }

    func pixel(point: CGPoint) throws -> (x: Int, y: Int) {
        try requireActionFrame()
        guard contains(point) else {
            throw ServerFailure(code: "out_of_bounds", message: "The native point is outside the capture.")
        }
        let x = floor(Double(point.x - bounds.minX) * imageScale)
        let y = floor(Double(point.y - bounds.minY) * imageScale)
        guard x >= 0, y >= 0, x < Double(width), y < Double(height) else {
            throw ServerFailure(code: "out_of_bounds", message: "The native point is outside the image raster.")
        }
        return (Int(x), Int(y))
    }

    /// Zoom edges stay in the original full-frame pixel space; the crop is reread at native scale.
    func zoomRegion(x0: Int, y0: Int, x1: Int, y1: Int) throws -> CGRect {
        try requireActionFrame()
        guard x0 >= 0, y0 >= 0, x0 < x1, y0 < y1, x1 <= width, y1 <= height else {
            throw ServerFailure(code: "out_of_bounds", message: "The zoom region is outside the source frame.")
        }
        return CGRect(x: Double(bounds.minX) + Double(x0) / imageScale,
                      y: Double(bounds.minY) + Double(y0) / imageScale,
                      width: Double(x1 - x0) / imageScale, height: Double(y1 - y0) / imageScale)
    }

    private func requireActionFrame() throws {
        guard zoomSourceID == nil else {
            throw ServerFailure(code: "stale_frame", message: "A zoom image is not an input frame.")
        }
        guard valid else {
            throw ServerFailure(code: "stale_frame", message: "The capture geometry is invalid.")
        }
    }

    private func contains(_ point: CGPoint) -> Bool {
        point.x.isFinite && point.y.isFinite && point.x >= bounds.minX && point.y >= bounds.minY &&
            point.x < bounds.maxX && point.y < bounds.maxY
    }

    fileprivate var valid: Bool {
        guard Self.validString(captureID), Self.validString(displayID), Self.validString(sessionID),
              Self.validRect(bounds), nativePixelSize.width.isFinite, nativePixelSize.height.isFinite,
              nativePixelSize.width > 0, nativePixelSize.height > 0,
              captureScale.isFinite, captureScale > 0, imageScale.isFinite, imageScale > 0,
              imageScale <= captureScale * (1 + 1e-12),
              (1...16384).contains(width), (1...16384).contains(height),
              phaseRevision.map({ $0 >= 0 }) ?? true,
              windows.count <= 4096 else { return false }
        let scaledWidth = Double(bounds.width) * imageScale
        let scaledHeight = Double(bounds.height) * imageScale
        guard scaledWidth.isFinite, scaledHeight.isFinite,
              Double(width) <= scaledWidth + 1e-7, Double(height) <= scaledHeight + 1e-7,
              scaledWidth - Double(width) < 1.0000001, scaledHeight - Double(height) < 1.0000001,
              windowID.map(Self.validString) ?? true, windowFrame.map(Self.validRect) ?? true,
              spaceWitness.map(Self.validString) ?? true, zoomSourceID.map(Self.validString) ?? true,
              ownerProcess.map(Self.validProcess) ?? true,
              windows.allSatisfy({ Self.validString($0.windowID) && Self.validProcess($0.process) &&
                  Self.validRect($0.bounds) && $0.alpha.isFinite && (0...1).contains($0.alpha) &&
                  ($0.spaceWitness.map(Self.validString) ?? true) && storedHostMapping($0) }) else { return false }
        // A small bounded window catalog is enough for stale checks, even on unusually busy desktops.
        let metadataBytes = windows.reduce(0) { total, window in
            let hostBytes = window.hosted.map { proof in
                [proof.physicalOwner, proof.logicalOwner].reduce(0) { bytes, owner in
                    bytes + owner.process.executable.utf8.count + owner.identity.bundleId.utf8.count +
                        owner.identity.name.utf8.count + (owner.identity.teamId?.utf8.count ?? 0) + 128
                }
            } ?? 0
            return total + window.windowID.utf8.count + window.process.executable.utf8.count +
                (window.spaceWitness?.utf8.count ?? 0) + hostBytes + 96
        }
        return metadataBytes <= 1024 * 1024
    }

    /// Stored capture bindings are compared without consulting the OS or treating an old proof as a new grant.
    private func storedHostMapping(_ window: CaptureWindowWitness) -> Bool {
        guard let proof = window.hosted else { return true }
        guard proof.surface.windowID == window.windowID, proof.surface.process == window.process,
              proof.surface.bounds == window.bounds, proof.surface.onScreen == window.onScreen,
              proof.surface.alpha == window.alpha, proof.surface.spaceWitness == window.spaceWitness,
              proof.sessionID.utf8.elementsEqual(sessionID.utf8), proof.observationEpoch == observationEpoch,
              proof.phaseRevision == phaseRevision else { return false }
        return [proof.physicalOwner, proof.logicalOwner].allSatisfy { owner in
            Self.validProcess(owner.process) && owner.identity.pid == Int(owner.process.pid) &&
                owner.identity.path == owner.process.executable && MacAppIdentity(wire: owner.identity.wire) != nil
        }
    }

    private static func validRect(_ rect: CGRect) -> Bool {
        rect.origin.x.isFinite && rect.origin.y.isFinite && rect.width.isFinite && rect.height.isFinite &&
            rect.width > 0 && rect.height > 0 && rect.maxX.isFinite && rect.maxY.isFinite
    }

    private static func validString(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256 && !value.contains("\0")
    }

    private static func validProcess(_ value: HelperProcessIdentity) -> Bool {
        value.pid > 0 && value.parentPID >= 0 && !value.executable.isEmpty && value.executable.utf8.count <= 4096 &&
            !value.executable.contains("\0") && value.executable.hasPrefix("/")
    }
}

final class CaptureRegistry {
    private let lock = NSLock()
    private let limit: Int
    private var records: [String: CaptureGeometry] = [:]
    private var order: [String] = []
    private var configurationGeneration: UInt64 = 0

    init(limit: Int = 32) { self.limit = min(32, max(1, limit)) }

    var generation: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return configurationGeneration
    }

    func store(_ record: CaptureGeometry) throws {
        lock.lock()
        defer { lock.unlock() }
        guard record.configurationGeneration == configurationGeneration, record.valid,
              records[record.captureID] == nil else {
            throw ServerFailure(code: "stale_frame", message: "The capture geometry can no longer be retained.")
        }
        records[record.captureID] = record
        order.append(record.captureID)
        while order.count > limit { records.removeValue(forKey: order.removeFirst()) }
    }

    func get(_ captureID: String, sessionID: String, observationEpoch: UUID,
             phaseRevision: Int? = nil, allowZoom: Bool = false) throws -> CaptureGeometry {
        lock.lock()
        defer { lock.unlock() }
        guard let record = records[captureID], record.sessionID == sessionID,
              record.observationEpoch == observationEpoch,
              record.configurationGeneration == configurationGeneration,
              phaseRevision.map({ record.phaseRevision == $0 }) ?? true,
              allowZoom || record.zoomSourceID == nil else {
            throw ServerFailure(code: "stale_frame", message: "The capture belongs to an expired observation.")
        }
        return record
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        configurationGeneration &+= 1
        records.removeAll(keepingCapacity: true)
        order.removeAll(keepingCapacity: true)
    }

    func invalidateDisplays() { clear() }
}
