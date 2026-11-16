import AppKit
import ApplicationServices
import CoreGraphics
import CoreText
import Dispatch
import Foundation
import ImageIO
import ScreenCaptureKit

struct CaptureDisplayInfo {
    let id: String
    let bounds: CGRect
    let pixelSize: CGSize
    let scale: Double
    let primary: Bool
    var captureScale: Double? = nil
}

struct CaptureWindowInfo {
    let windowID: String
    let pid: pid_t
    let bounds: CGRect
    let onScreen: Bool
    let minimized: Bool?
    var alpha: Double = 1
    var layer: Int = 0
    var owner: NativeOwner? = nil
    var regularOwner: Bool? = nil
    var spaceWitness: String? = nil
    var nonApplicationHost: HelperProcessIdentity? = nil
    var captureScale: Double? = nil
    var sourceAvailable = true
    var hosted: HostedWindowProof? = nil

    var target: NativeTarget? {
        if let hosted { return NativeTarget(owner: hosted.physicalOwner, windowID: windowID, hosted: hosted) }
        return owner.map { NativeTarget(owner: $0, windowID: windowID) }
    }
}

struct CaptureInventory {
    let displays: [CaptureDisplayInfo]
    /// Native front-to-back order. Overlay windows remain in this inventory, but never in source or masks.
    var windows: [CaptureWindowInfo]
    var nativeContent: SCShareableContent? = nil
}

struct CaptureImageRequest {
    let inventory: CaptureInventory
    let displayID: String
    let windowID: String?
    let includedWindowIDs: [String]
    let bounds: CGRect
    let width: Int
    let height: Int
    let captureScale: Double
    let imageScale: Double

    func sourceRect(origin: CGPoint) -> CGRect { bounds.offsetBy(dx: -origin.x, dy: -origin.y) }
}

struct CaptureMask {
    let bounds: CGRect
    let vector: Bool
}

struct CapturePrivacyPlan {
    let includedWindowIDs: [String]
    let masks: [CaptureMask]
    let hiddenCount: Int
}

enum CapturePrivacy {
    static func plan(windows: [CaptureWindowInfo], bounds: CGRect, policy: SessionPolicy,
                     session: ServerSession) throws -> CapturePrivacyPlan {
        guard valid(bounds), windows.count <= 4096, Set(windows.map { $0.windowID }).count == windows.count else {
            throw failure("capture_unavailable", "The native window inventory is incomplete.")
        }
        var included: [String] = []
        var masks: [CaptureMask] = []
        var covered: [CGRect] = []
        var hidden = Set<String>()
        let blocklist = try NativeBlocklist.generated()
        let overlays = Set(session.overlayWindowIds)
        for window in windows where window.onScreen {
            guard valid(window.bounds), window.pid > 0, window.alpha.isFinite, (0...1).contains(window.alpha) else {
                throw failure("capture_unavailable", "Native window geometry could not be verified.")
            }
            let region = window.bounds.intersection(bounds)
            if region.isNull || region.isEmpty || window.alpha == 0 || overlays.contains(window.windowID) { continue }
            let vector = session.vectorPids.contains(Int(window.pid)) || session.vectorWindowIds.contains(window.windowID) ||
                window.owner.map { blocklist.category($0.identity, childShell: $0.childShell == true) == "vector" } == true
            var notification = false
            var allowed = false
            if let owner = window.owner {
                guard owner.process.pid == window.pid, owner.identity.pid == Int(window.pid) else {
                    throw failure("changed", "A native window owner changed.")
                }
                notification = owner.identity.bundleId.lowercased() == "com.apple.notificationcenterui"
                allowed = !vector && !notification && window.target.map(policy.mayIncludeInDisplay) == true
            } else {
                guard let host = window.nonApplicationHost, host.pid == window.pid else {
                    throw failure("unavailable", "A visible native window owner could not be verified.")
                }
            }
            if allowed {
                guard window.sourceAvailable else { throw failure("stale_frame", "A shareable window changed.") }
                included.append(window.windowID)
            }
            else {
                let visible = try subtract(region, covered)
                if !visible.isEmpty {
                    if let owner = window.owner {
                        guard let regular = window.regularOwner else {
                            throw failure("unavailable", "A masked application's native role could not be verified.")
                        }
                        let notificationHost = notification && owner.identity.verified && owner.identity.apple
                        if regular && !notificationHost { hidden.insert(owner.identity.key) }
                    }
                    masks.append(contentsOf: visible.map { CaptureMask(bounds: $0, vector: vector) })
                }
            }
            // Translucent windows do not establish opaque occlusion of a window behind them.
            if window.alpha == 1 { covered.append(region) }
            guard masks.count <= 8192, covered.count <= 4096 else {
                throw failure("capture_unavailable", "The native mask inventory exceeds its bounds.")
            }
        }
        return CapturePrivacyPlan(includedWindowIDs: included, masks: masks, hiddenCount: hidden.count)
    }

    static func valid(_ rect: CGRect) -> Bool {
        [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy { $0.isFinite && abs($0) <= 1_000_000 } &&
            rect.width > 0 && rect.height > 0
    }

    private static func subtract(_ region: CGRect, _ covers: [CGRect]) throws -> [CGRect] {
        var pieces = [region]
        for cover in covers {
            pieces = pieces.flatMap { piece -> [CGRect] in
                let cut = piece.intersection(cover)
                if cut.isNull || cut.isEmpty { return [piece] }
                return [
                    CGRect(x: piece.minX, y: piece.minY, width: piece.width, height: cut.minY - piece.minY),
                    CGRect(x: piece.minX, y: cut.maxY, width: piece.width, height: piece.maxY - cut.maxY),
                    CGRect(x: piece.minX, y: cut.minY, width: cut.minX - piece.minX, height: cut.height),
                    CGRect(x: cut.maxX, y: cut.minY, width: piece.maxX - cut.maxX, height: cut.height),
                ].filter { !$0.isEmpty }
            }
            if pieces.count > 8192 { throw failure("capture_unavailable", "The native mask inventory exceeds its bounds.") }
            if pieces.isEmpty { break }
        }
        return pieces
    }

    static func failure(_ code: String, _ message: String) -> ServerFailure { ServerFailure(code: code, message: message) }
}

struct CaptureBackend {
    let preflight: () -> Bool
    let displays: () throws -> [CaptureDisplayInfo]
    let content: (@escaping (Result<CaptureInventory, ServerFailure>) -> Void) -> Void
    let screenshot: (CaptureImageRequest, @escaping (Result<CGImage, ServerFailure>) -> Void) -> Void
    var windowState: ((CaptureWindowInfo, CaptureInventory, OperationContext) -> Bool?)? = nil
    var hostOwnership: ((CaptureWindowInfo, ServerSession, OperationContext) throws -> HostedWindowProof?)? = nil

    static var system: CaptureBackend {
        var backend = CaptureBackend(preflight: { CGPreflightScreenCaptureAccess() }, displays: CaptureService.nativeDisplays,
            content: CaptureService.nativeContent, screenshot: CaptureService.nativeScreenshot)
        backend.windowState = CaptureService.nativeMinimized
        let hosts = HostOwnershipResolver()
        backend.hostOwnership = { window, session, operation in
            try hosts.resolve(window: window, session: session, isCurrent: operation.isCurrent)
        }
        return backend
    }
}

private struct CaptureArguments {
    let display: String?
    let window: String?
    let budget: CaptureBudget
    let format: String
    let quality: Int
    let zoom: (id: String, x0: Int, y0: Int, x1: Int, y1: Int)?

    init(_ args: [String: JSONValue]) throws {
        let keys: Set<String> = ["target", "budget", "format", "quality", "zoom"]
        guard Set(args.keys).isSubset(of: keys), let target = args["target"]?.objectValue, target.count == 1,
              let budget = args["budget"].flatMap(CaptureBudget.init(wire:)),
              let format = args["format"]?.stringValue, ["jpeg", "png"].contains(format) else { throw Self.invalid }
        let display = target["display"]?.stringValue
        let window = target["windowId"]?.stringValue
        guard (display != nil) != (window != nil), let id = display ?? window, Self.validID(id) else { throw Self.invalid }
        let quality = args["quality"]?.intValue ?? 80
        guard (1...100).contains(quality), args["quality"] == nil || args["quality"]?.intValue != nil else { throw Self.invalid }
        if let zoom = args["zoom"] {
            guard let fields = zoom.objectValue, Set(fields.keys) == ["captureId", "region"],
                  let id = fields["captureId"]?.stringValue, Self.validID(id), let region = fields["region"]?.objectValue,
                  Set(region.keys) == ["x0", "y0", "x1", "y1"], let x0 = region["x0"]?.intValue,
                  let y0 = region["y0"]?.intValue, let x1 = region["x1"]?.intValue, let y1 = region["y1"]?.intValue else { throw Self.invalid }
            self.zoom = (id, x0, y0, x1, y1)
        } else { self.zoom = nil }
        self.display = display; self.window = window; self.budget = budget; self.format = format; self.quality = quality
    }

    private static var invalid: ServerFailure { CapturePrivacy.failure("failed", "The capture arguments are invalid.") }
    private static func validID(_ value: String) -> Bool { !value.isEmpty && value.utf16.count <= 256 && !value.contains("\0") }
}

final class CaptureService {
    private let registry: CaptureRegistry
    private let backend: CaptureBackend
    private let execute: (@escaping () -> Void) -> Void
    private let encode: (@escaping () -> Void) -> Void
    private let lock = NSLock()
    private var closed = false
    private var fingerprints: [String: InventoryFingerprint] = [:]
    private var fingerprintOrder: [String] = []

    init(registry: CaptureRegistry = CaptureRegistry(), backend: CaptureBackend = .system,
         execute: ((@escaping () -> Void) -> Void)? = nil, encode: ((@escaping () -> Void) -> Void)? = nil) {
        self.registry = registry; self.backend = backend
        self.execute = execute ?? { DispatchQueue.main.async(execute: DispatchWorkItem(block: $0)) }
        let queue = DispatchQueue(label: "ai.vector.computer.capture-encode")
        self.encode = encode ?? { queue.async(execute: DispatchWorkItem(block: $0)) }
    }

    func features() -> [String: Bool] {
        if #available(macOS 14.0, *) {
            return ["capture.display": true, "capture.window": true, "capture.exclude": true, "capture.zoom": true]
        }
        return [:]
    }

    func invalidateDisplays() {
        lock.lock(); defer { lock.unlock() }
        fingerprints.removeAll(); fingerprintOrder.removeAll(); registry.invalidateDisplays()
    }
    func close() {
        lock.lock(); defer { lock.unlock() }
        closed = true; fingerprints.removeAll(); fingerprintOrder.removeAll(); registry.clear()
    }

    func listDisplays(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        guard args.isEmpty else { completion(.failure(CapturePrivacy.failure("failed", "Display listing takes no arguments."))); return }
        execute { [self] in
            guard current(context) else { completion(.failure(Self.changed)); return }
            do {
                let displays = try backend.displays()
                guard Self.validDisplays(displays), current(context) else { throw Self.changed }
                completion(.success(ServerReply(fields: ["displays": .array(displays.map(Self.displayWire))])))
            } catch { completion(.failure(Self.failure(error))) }
        }
    }

    func capture(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        do {
            let parsed = try CaptureArguments(args)
            guard let session = context.session else { throw CapturePrivacy.failure("unavailable", "No computer session is active.") }
            let policy = try SessionPolicy(session: session)
            let generation = registry.generation
            execute { [self] in
                guard current(context) else { completion(.failure(Self.changed)); return }
                guard backend.preflight() else { completion(.failure(Self.denied)); return }
                backend.content { result in
                    self.execute {
                        do {
                            guard self.current(context) else { throw Self.changed }
                            guard self.registry.generation == generation else { throw Self.stale }
                            let inventory = try result.get()
                            let work = try self.prepare(parsed, inventory, session, policy, generation, context)
                            if work.paused { completion(.success(ServerReply(fields: ["paused": .bool(true)]))); return }
                            guard self.current(context), self.backend.preflight() else { throw self.current(context) ? Self.denied : Self.changed }
                            self.backend.screenshot(work.request) { imageResult in
                                self.execute {
                                    guard self.current(context) else { completion(.failure(Self.changed)); return }
                                    guard self.backend.preflight() else { completion(.failure(Self.denied)); return }
                                    self.backend.content { afterResult in
                                        self.execute {
                                            do {
                                                guard self.current(context) else { throw Self.changed }
                                                guard self.registry.generation == generation else { throw Self.stale }
                                                let after = try afterResult.get()
                                                let check = try self.prepare(parsed, after, session, policy, generation, context)
                                                guard !check.paused, Self.same(work, check) else { throw Self.stale }
                                                let image = try imageResult.get()
                                                self.encode {
                                                    do {
                                                        guard self.current(context), self.registry.generation == generation else { throw Self.changed }
                                                        guard self.backend.preflight() else { throw Self.denied }
                                                        let reply = try self.finish(image, work, parsed, context, generation)
                                                        guard self.current(context), self.registry.generation == generation else { throw Self.changed }
                                                        guard self.backend.preflight() else { throw Self.denied }
                                                        completion(.success(reply))
                                                    } catch { completion(.failure(Self.failure(error))) }
                                                }
                                            } catch { completion(.failure(Self.failure(error))) }
                                        }
                                    }
                                }
                            }
                        } catch { completion(.failure(Self.failure(error))) }
                    }
                }
            }
        } catch { completion(.failure(Self.failure(error))) }
    }

    private struct Work {
        let request: CaptureImageRequest
        let geometry: CaptureGeometry
        let masks: [CaptureMask]
        let hiddenCount: Int
        let witnesses: [CaptureWindowWitness]
        let paused: Bool
        let fingerprint: InventoryFingerprint
    }

    private struct WindowFingerprint: Equatable {
        let id: String
        let pid: pid_t
        let bounds: CGRect
        let onScreen: Bool
        let minimized: Bool?
        let alpha: Double
        let layer: Int
        let identity: MacAppIdentity?
        let process: HelperProcessIdentity?
        let childShell: Bool?
        let regular: Bool?
        let host: HelperProcessIdentity?
        let space: String?
        let scale: Double?
        let sourceAvailable: Bool
        let hosted: HostedWindowProof?
    }
    private struct DisplayFingerprint: Equatable {
        let id: String
        let bounds: CGRect
        let pixels: CGSize
        let scale: Double
        let primary: Bool
        let captureScale: Double?
    }
    private struct InventoryFingerprint: Equatable {
        let displays: [DisplayFingerprint]
        let windows: [WindowFingerprint]
        init(_ inventory: CaptureInventory, overlays: [String]) throws {
            guard inventory.windows.count <= 4096 else { throw CaptureService.stale }
            var metadataBytes: Int = 0
            for window in inventory.windows {
                metadataBytes += window.owner?.process.executable.utf8.count ?? 0
                metadataBytes += window.owner?.identity.bundleId.utf8.count ?? 0
                metadataBytes += window.nonApplicationHost?.executable.utf8.count ?? 0
                metadataBytes += 256
                guard metadataBytes <= 1024 * 1024 else { throw CaptureService.stale }
            }
            displays = inventory.displays.map { DisplayFingerprint(id: $0.id, bounds: $0.bounds, pixels: $0.pixelSize, scale: $0.scale, primary: $0.primary, captureScale: $0.captureScale) }
            windows = inventory.windows.filter { !overlays.contains($0.windowID) }.map { WindowFingerprint(id: $0.windowID, pid: $0.pid, bounds: $0.bounds,
                onScreen: $0.onScreen, minimized: $0.minimized, alpha: $0.alpha, layer: $0.layer,
                identity: $0.owner?.identity, process: $0.owner?.process, childShell: $0.owner?.childShell,
                regular: $0.regularOwner, host: $0.nonApplicationHost, space: $0.spaceWitness, scale: $0.captureScale,
                sourceAvailable: $0.sourceAvailable, hosted: $0.hosted) }
        }
    }

    private func prepare(_ args: CaptureArguments, _ sourceInventory: CaptureInventory, _ session: ServerSession,
                         _ policy: SessionPolicy, _ generation: UInt64, _ operation: OperationContext) throws -> Work {
        var inventory = sourceInventory
        guard Self.validDisplays(inventory.displays), inventory.windows.count <= 4096 else { throw Self.stale }
        if let resolve = backend.hostOwnership {
            let started = DispatchTime.now().uptimeNanoseconds
            inventory.windows = try inventory.windows.map { original in
                guard operation.isCurrent(), DispatchTime.now().uptimeNanoseconds - started < 750_000_000 else { throw Self.stale }
                if !original.onScreen && original.windowID != args.window { return original }
                if original.windowID != args.window && original.target.map(policy.mayIncludeInDisplay) == true { return original }
                guard let proof = try resolve(original, session, operation) else { return original }
                var window = original
                window.hosted = proof
                window.owner = proof.surface.process == proof.physicalOwner.process ? proof.physicalOwner : proof.logicalOwner
                return window
            }
        }
        let window = args.window.flatMap { id in inventory.windows.first { $0.windowID == id } }
        if args.window != nil && window == nil { throw CapturePrivacy.failure("capture_unavailable", "The native window is unavailable.") }
        let display: CaptureDisplayInfo?
        if let id = args.display { display = inventory.displays.first { $0.id == id } }
        else if let window {
            display = inventory.displays.sorted { left, right in
                let a = left.bounds.intersection(window.bounds).area, b = right.bounds.intersection(window.bounds).area
                if a != b { return a > b }
                let da = Self.distance(window.bounds, left.bounds), db = Self.distance(window.bounds, right.bounds)
                return da == db ? left.id < right.id : da < db
            }.first
        }
        else { display = nil }
        guard let display else { throw CapturePrivacy.failure("capture_unavailable", "The native display is unavailable.") }
        var bounds = window?.bounds ?? display.bounds
        let captureScale = window?.captureScale ?? display.captureScale ?? display.scale
        guard captureScale.isFinite, captureScale > 0, captureScale <= 16 else { throw Self.stale }
        var paused = false
        var masks: [CaptureMask] = []
        var included: [String] = []
        var hiddenCount = 0
        if let window {
            guard let owner = window.owner else { throw CapturePrivacy.failure("unavailable", "The native window owner could not be verified.") }
            guard owner.process.pid == window.pid, owner.identity.pid == Int(window.pid) else {
                throw CapturePrivacy.failure("changed", "The native window owner changed.")
            }
            guard CapturePrivacy.valid(window.bounds) else { throw Self.stale }
            guard window.sourceAvailable else { throw Self.stale }
            guard let target = window.target else { throw Self.stale }
            try policy.requireTarget(target, operation: .capture)
            guard let minimized = window.minimized ?? backend.windowState?(window, inventory, operation) else {
                throw CapturePrivacy.failure("unavailable", "The native window state could not be verified.")
            }
            paused = minimized
            included = [window.windowID]
        }
        let fingerprint = try InventoryFingerprint(inventory, overlays: session.overlayWindowIds)
        if let zoom = args.zoom {
            let source = try registry.get(zoom.id, sessionID: session.id, observationEpoch: session.observationEpoch, phaseRevision: session.revision)
            lock.lock(); let previous = fingerprints[zoom.id]; lock.unlock()
            guard source.displayID == display.id, source.windowID == args.window,
                  source.bounds.origin == bounds.origin, source.windowFrame == window?.bounds,
                  source.ownerProcess == window?.owner?.process, previous == fingerprint else { throw Self.stale }
            bounds = try source.zoomRegion(x0: zoom.x0, y0: zoom.y0, x1: zoom.x1, y1: zoom.y1)
        }
        let native = CGSize(width: bounds.width * captureScale, height: bounds.height * captureScale)
        let bounded = try CaptureBudget(maxWidth: args.budget.maxWidth, maxHeight: args.budget.maxHeight,
                                       maxPixels: min(args.budget.maxPixels, maxFrameBytes / 4))
        let size = try bounded.fit(sourceWidth: Double(native.width), sourceHeight: Double(native.height))
        let imageScale = size.scale * captureScale
        // Floor raster dimensions by trimming only the right/bottom subpixel slivers. The screenshot source
        // has exactly the output aspect ratio, so preservesAspectRatio cannot add padding or change the scale.
        bounds = CGRect(origin: bounds.origin, size: CGSize(width: Double(size.width) / imageScale, height: Double(size.height) / imageScale))
        if window == nil {
            let plan = try CapturePrivacy.plan(windows: inventory.windows, bounds: bounds, policy: policy, session: session)
            masks = plan.masks; included = plan.includedWindowIDs; hiddenCount = plan.hiddenCount
        }
        let witnesses = inventory.windows.compactMap { item -> CaptureWindowWitness? in
            guard !session.overlayWindowIds.contains(item.windowID), let process = item.owner?.process ?? item.nonApplicationHost else { return nil }
            if !item.onScreen && item.minimized == nil && item.windowID != window?.windowID { return nil }
            return CaptureWindowWitness(windowID: item.windowID, process: process, bounds: item.bounds,
                onScreen: item.onScreen, minimized: item.minimized ?? paused, alpha: item.alpha, spaceWitness: item.spaceWitness,
                hosted: item.hosted)
        }
        let geometry = CaptureGeometry(captureID: "cap_" + UUID().uuidString.lowercased(), displayID: display.id,
            bounds: bounds, nativePixelSize: CGSize(width: bounds.width * captureScale, height: bounds.height * captureScale),
            captureScale: captureScale, width: size.width, height: size.height,
            imageScale: imageScale, sessionID: session.id, observationEpoch: session.observationEpoch,
            phaseRevision: session.revision, configurationGeneration: generation, windowID: args.window,
            windowFrame: window?.bounds, ownerProcess: window?.owner?.process, windows: witnesses,
            spaceWitness: window?.spaceWitness, zoomSourceID: args.zoom?.id)
        let request = CaptureImageRequest(inventory: inventory, displayID: display.id, windowID: args.window,
            includedWindowIDs: included, bounds: bounds, width: size.width, height: size.height, captureScale: captureScale, imageScale: imageScale)
        return Work(request: request, geometry: geometry, masks: masks, hiddenCount: hiddenCount, witnesses: witnesses, paused: paused, fingerprint: fingerprint)
    }

    private func finish(_ image: CGImage, _ work: Work, _ args: CaptureArguments, _ operation: OperationContext,
                        _ generation: UInt64) throws -> ServerReply {
        let geometry = work.geometry
        guard image.width == geometry.width, image.height == geometry.height,
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Self.stale }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        var masked: [JSONValue] = []
        for mask in work.masks {
            let intersection = mask.bounds.intersection(geometry.bounds)
            if intersection.isNull || intersection.isEmpty { continue }
            let x = max(0, floor((intersection.minX - geometry.bounds.minX) * geometry.imageScale))
            let y = max(0, floor((intersection.minY - geometry.bounds.minY) * geometry.imageScale))
            let right = min(CGFloat(image.width), ceil((intersection.maxX - geometry.bounds.minX) * geometry.imageScale))
            let bottom = min(CGFloat(image.height), ceil((intersection.maxY - geometry.bounds.minY) * geometry.imageScale))
            guard right > x, bottom > y else { continue }
            let rect = CGRect(x: x, y: y, width: right - x, height: bottom - y)
            context.setFillColor(CGColor(gray: 0, alpha: 1))
            context.fill(CGRect(x: x, y: CGFloat(image.height) - bottom, width: rect.width, height: rect.height))
            // A label is rasterized locally after the opaque fill, never from a captured Vector title or content.
            if mask.vector && rect.width >= 44 && rect.height >= 16 {
                context.saveGState()
                context.textMatrix = .identity
                let attributes: [String: Any] = [kCTFontAttributeName as String: CTFontCreateWithName("Helvetica" as CFString, 11, nil),
                    kCTForegroundColorAttributeName as String: CGColor(gray: 1, alpha: 1)]
                let label = CFAttributedStringCreate(nil, "Vector" as CFString, attributes as CFDictionary)!
                let line = CTLineCreateWithAttributedString(label)
                context.textPosition = CGPoint(x: x + 4, y: CGFloat(image.height) - bottom + 4)
                CTLineDraw(line, context)
                context.restoreGState()
            }
            masked.append(Self.rectWire(rect))
        }
        guard let final = context.makeImage() else { throw Self.stale }
        let data = NSMutableData()
        let format = args.zoom == nil ? args.format : "png"
        guard let destination = CGImageDestinationCreateWithData(data, (format == "jpeg" ? "public.jpeg" : "public.png") as CFString, 1, nil) else { throw Self.stale }
        CGImageDestinationAddImage(destination, final, [kCGImageDestinationLossyCompressionQuality: Double(args.quality) / 100] as CFDictionary)
        guard CGImageDestinationFinalize(destination), data.length > 0, data.length <= maxFrameBytes else {
            throw CapturePrivacy.failure("frame_too_large", "The encoded capture exceeds the frame limit.")
        }
        let hash = try Self.hash(final)
        var stored = false
        var storeError: Error?
        guard operation.withCurrent({
            self.lock.lock(); defer { self.lock.unlock() }
            guard !self.closed, self.registry.generation == generation else { return }
            guard self.backend.preflight() else { storeError = Self.denied; return }
            do {
                try self.registry.store(geometry)
                self.fingerprints[geometry.captureID] = work.fingerprint
                self.fingerprintOrder.append(geometry.captureID)
                if self.fingerprintOrder.count > 32 { self.fingerprints.removeValue(forKey: self.fingerprintOrder.removeFirst()) }
                stored = true
            } catch { storeError = error }
        }), stored else { throw storeError ?? Self.changed }
        return ServerReply(fields: [
            "captureId": .string(geometry.captureID), "width": .integer(Int64(final.width)), "height": .integer(Int64(final.height)),
            "origin": .object(["x": .number(geometry.bounds.minX), "y": .number(geometry.bounds.minY)]),
            "imageScale": .number(geometry.imageScale), "displayId": .string(geometry.displayID),
            "capturedAtMs": .integer(Int64(Date().timeIntervalSince1970 * 1000)), "masked": .array(masked),
            "hiddenCount": .integer(Int64(work.hiddenCount)), "hash": .string(hash), "imageBytes": .integer(Int64(data.length)),
        ], image: data as Data)
    }

    private func current(_ context: OperationContext) -> Bool {
        guard context.isCurrent() else { return false }
        lock.lock(); defer { lock.unlock() }; return !closed
    }
    private static let changed = CapturePrivacy.failure("changed", "The capture operation is no longer current.")
    private static let denied = CapturePrivacy.failure("permissions", "Screen Recording is not granted.")
    private static let stale = CapturePrivacy.failure("stale_frame", "The native capture geometry changed.")
    private static func failure(_ error: Error) -> ServerFailure { (error as? ServerFailure) ?? CapturePrivacy.failure("capture_unavailable", "The native capture is unavailable.") }
    private static func same(_ left: Work, _ right: Work) -> Bool {
        left.request.bounds == right.request.bounds && left.request.displayID == right.request.displayID &&
            left.request.includedWindowIDs == right.request.includedWindowIDs && left.fingerprint == right.fingerprint &&
            left.masks.map { $0.bounds } == right.masks.map { $0.bounds } && left.hiddenCount == right.hiddenCount
    }
    private static func validDisplays(_ displays: [CaptureDisplayInfo]) -> Bool {
        !displays.isEmpty && displays.count <= 64 && Set(displays.map { $0.id }).count == displays.count && displays.allSatisfy {
            !$0.id.isEmpty && $0.id.utf16.count <= 256 && !$0.id.contains("\0") &&
            CapturePrivacy.valid($0.bounds) && $0.scale.isFinite && $0.scale > 0 && $0.scale <= 16 &&
            $0.pixelSize.width.isFinite && $0.pixelSize.height.isFinite && $0.pixelSize.width > 0 && $0.pixelSize.height > 0 &&
            $0.pixelSize.width <= 1_000_000 && $0.pixelSize.height <= 1_000_000 &&
            $0.pixelSize.width.rounded() == $0.pixelSize.width && $0.pixelSize.height.rounded() == $0.pixelSize.height
        }
    }
    private static func distance(_ window: CGRect, _ display: CGRect) -> Double {
        let x = max(display.minX - window.maxX, window.minX - display.maxX, 0)
        let y = max(display.minY - window.maxY, window.minY - display.maxY, 0)
        return x * x + y * y
    }
    private static func rectWire(_ rect: CGRect) -> JSONValue {
        .object(["x": .number(rect.minX), "y": .number(rect.minY), "w": .number(rect.width), "h": .number(rect.height)])
    }
    private static func displayWire(_ display: CaptureDisplayInfo) -> JSONValue {
        .object(["id": .string(display.id), "bounds": rectWire(display.bounds),
            "pixelSize": .object(["w": .integer(Int64(display.pixelSize.width)), "h": .integer(Int64(display.pixelSize.height))]),
            "scale": .number(display.scale), "primary": .bool(display.primary)])
    }
    private static func hash(_ image: CGImage) throws -> String {
        var bytes = [UInt8](repeating: 0, count: 64)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: 8, height: 8, bitsPerComponent: 8,
                bytesPerRow: 8, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: 8, height: 8))
            return true
        }
        guard drawn else { throw stale }
        let mean = Double(bytes.reduce(0) { $0 + Int($1) }) / 64
        let value = bytes.reduce(UInt64(0)) { ($0 << 1) | (Double($1) > mean ? 1 : 0) }
        return String(format: "%016llx", value)
    }

    static func nativeDisplays() throws -> [CaptureDisplayInfo] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0, count <= 64 else { throw stale }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { throw stale }
        return try ids.prefix(Int(count)).map { id in
            let bounds = CGDisplayBounds(id)
            let width = CGDisplayPixelsWide(id), height = CGDisplayPixelsHigh(id)
            guard CapturePrivacy.valid(bounds), width > 0, height > 0 else { throw stale }
            let scale = Double(width) / bounds.width
            guard abs(Double(height) / bounds.height - scale) < 0.01 else { throw stale }
            return CaptureDisplayInfo(id: String(id), bounds: bounds, pixelSize: CGSize(width: width, height: height), scale: scale, primary: id == CGMainDisplayID())
        }
    }

    static func nativeContent(_ completion: @escaping (Result<CaptureInventory, ServerFailure>) -> Void) {
        guard CGPreflightScreenCaptureAccess() else { completion(.failure(denied)); return }
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, _ in
            DispatchQueue.main.async {
                do {
                    guard CGPreflightScreenCaptureAccess(), let content else { throw denied }
                    let displays = try nativeDisplays().map { original -> CaptureDisplayInfo in
                        guard let native = content.displays.first(where: { String($0.displayID) == original.id }) else { throw stale }
                        var display = original
                        display.captureScale = Double(SCContentFilter(display: native, including: []).pointPixelScale)
                        return display
                    }
                    guard let rows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]], rows.count <= 4096 else { throw stale }
                    var owners: [pid_t: NativeOwner] = [:]
                    var hosts: [pid_t: HelperProcessIdentity] = [:]
                    var windows: [CaptureWindowInfo] = []
                    let deadline = DispatchTime.now().uptimeNanoseconds + 750_000_000
                    for row in rows {
                        guard DispatchTime.now().uptimeNanoseconds < deadline else { throw stale }
                        guard let number = row[kCGWindowNumber as String] as? NSNumber,
                              let process = row[kCGWindowOwnerPID as String] as? NSNumber,
                              let raw = row[kCGWindowBounds as String] as? [String: Any],
                              let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary) else { throw stale }
                        if bounds.width == 0 || bounds.height == 0 { continue }
                        guard CapturePrivacy.valid(bounds) else { throw stale }
                        let pid = pid_t(process.int32Value), id = String(number.uint32Value)
                        guard pid > 0 else { throw stale }
                        let onScreen = (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true
                        if owners[pid] == nil && hosts[pid] == nil {
                            owners[pid] = try? NativeIdentityReader.observe(pid: pid)
                            if owners[pid] == nil { hosts[pid] = NativeIdentityReader.nonApplicationSystemHost(pid: pid) }
                        }
                        let shareable = content.windows.filter { String($0.windowID) == id }
                        var item = CaptureWindowInfo(windowID: id, pid: pid, bounds: bounds, onScreen: onScreen,
                            minimized: onScreen ? false : nil)
                        item.sourceAvailable = shareable.count == 1 && shareable[0].owningApplication?.processID == pid && shareable[0].frame == bounds
                        item.alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
                        item.layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
                        item.owner = owners[pid]; item.nonApplicationHost = hosts[pid]
                        if item.sourceAvailable, let window = shareable.first { item.captureScale = Double(SCContentFilter(desktopIndependentWindow: window).pointPixelScale) }
                        item.regularOwner = NSRunningApplication(processIdentifier: pid).map { $0.activationPolicy == .regular }
                        windows.append(item)
                    }
                    var result = CaptureInventory(displays: displays, windows: windows)
                    result.nativeContent = content
                    completion(.success(result))
                } catch { completion(.failure(failure(error))) }
            }
        }
    }

    static func nativeMinimized(_ target: CaptureWindowInfo, _ inventory: CaptureInventory, _ operation: OperationContext) -> Bool? {
        guard let content = inventory.nativeContent, let witness = target.owner?.process, witness.pid == target.pid,
              HelperLifecycle.processIdentity(target.pid) == witness, operation.isCurrent() else { return nil }
        let pid = target.pid, bounds = target.bounds
        guard content.windows.filter({ $0.owningApplication?.processID == pid && $0.frame == bounds }).count == 1 else { return nil }
        let deadline = DispatchTime.now().uptimeNanoseconds + 100_000_000
        let app = AXUIElementCreateApplication(pid)
        guard AXUIElementSetMessagingTimeout(app, 0.05) == .success else { return nil }
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &count) == .success,
              count > 0, count <= 128, operation.isCurrent(), DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
        var value: CFArray?
        guard AXUIElementCopyAttributeValues(app, kAXWindowsAttribute as CFString, 0, count, &value) == .success,
              let windows = value as? [AXUIElement], windows.count <= 128,
              operation.isCurrent(), DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
        var matches: [Bool] = []
        for window in windows {
            if DispatchTime.now().uptimeNanoseconds > deadline || !operation.isCurrent() { return nil }
            var owner: pid_t = 0
            guard CFGetTypeID(window) == AXUIElementGetTypeID(), AXUIElementGetPid(window, &owner) == .success, owner == pid,
                  AXUIElementSetMessagingTimeout(window, 0.05) == .success else { return nil }
            var position: CFTypeRef?, size: CFTypeRef?, minimized: CFTypeRef?
            guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success else { continue }
            guard operation.isCurrent(), DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
            guard AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
                  let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { continue }
            var point = CGPoint.zero, dimensions = CGSize.zero
            guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
                  CGRect(origin: point, size: dimensions) == bounds else { continue }
            guard operation.isCurrent(), DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
            guard AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized) == .success,
                  let minimized, CFGetTypeID(minimized) == CFBooleanGetTypeID() else { return nil }
            matches.append(CFBooleanGetValue((minimized as! CFBoolean)))
        }
        return matches.count == 1 && operation.isCurrent() && HelperLifecycle.processIdentity(pid) == witness ? matches[0] : nil
    }

    static func nativeScreenshot(_ request: CaptureImageRequest, _ completion: @escaping (Result<CGImage, ServerFailure>) -> Void) {
        guard CGPreflightScreenCaptureAccess() else { completion(.failure(denied)); return }
        guard let content = request.inventory.nativeContent,
              let display = content.displays.first(where: { String($0.displayID) == request.displayID }) else { completion(.failure(stale)); return }
        let filter: SCContentFilter
        let origin: CGPoint
        if let id = request.windowID {
            guard let window = content.windows.first(where: { String($0.windowID) == id }),
                  let witness = request.inventory.windows.first(where: { $0.windowID == id }), witness.sourceAvailable,
                  window.owningApplication?.processID == witness.pid, window.frame == witness.bounds else { completion(.failure(stale)); return }
            filter = SCContentFilter(desktopIndependentWindow: window)
            origin = window.frame.origin
        } else {
            let windows = content.windows.filter { request.includedWindowIDs.contains(String($0.windowID)) }
            guard windows.count == request.includedWindowIDs.count,
                  Set(windows.map { String($0.windowID) }) == Set(request.includedWindowIDs),
                  windows.allSatisfy({ window in
                    guard let witness = request.inventory.windows.first(where: { $0.windowID == String(window.windowID) }) else { return false }
                    return witness.sourceAvailable && witness.pid == window.owningApplication?.processID && witness.bounds == window.frame
                  }) else { completion(.failure(stale)); return }
            filter = SCContentFilter(display: display, including: windows)
            origin = CGDisplayBounds(display.displayID).origin
        }
        if #available(macOS 14.2, *) { filter.includeMenuBar = false }
        guard abs(Double(filter.pointPixelScale) - request.captureScale) < 0.000001 else { completion(.failure(stale)); return }
        let configuration = SCStreamConfiguration()
        configuration.width = request.width; configuration.height = request.height
        configuration.scalesToFit = true; configuration.preservesAspectRatio = true
        configuration.ignoreShadowsSingleWindow = true
        if #available(macOS 14.2, *) { configuration.includeChildWindows = false }
        configuration.showsCursor = false; configuration.capturesAudio = false
        let background = CGColor(gray: 0, alpha: 1)
        configuration.backgroundColor = background
        configuration.sourceRect = request.sourceRect(origin: origin)
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, _ in
            defer { withExtendedLifetime(background) {} }
            guard let image else { completion(.failure(CapturePrivacy.failure("capture_unavailable", "ScreenCaptureKit did not return an image."))); return }
            completion(.success(image))
        }
    }
}

private extension CGRect {
    var area: CGFloat { isNull || isEmpty ? 0 : width * height }
}
