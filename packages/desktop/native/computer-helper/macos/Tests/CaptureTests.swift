import CoreGraphics
import Darwin
import Foundation
import ImageIO

private struct CaptureTestFailure: Error {
    let message: String
}

private func captureCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw CaptureTestFailure(message: message) }
}

private func captureRefusal(_ code: String, _ body: () throws -> Void) throws {
    do {
        try body()
    } catch let error as ServerFailure {
        try captureCheck(error.code == code, "Expected \(code), received \(error.code)")
        return
    }
    throw CaptureTestFailure(message: "Expected capture refusal \(code)")
}

private func captureOwner(_ bundle: String, pid: pid_t, apple: Bool = false, system: Bool = false,
                          team: String? = "ABCDEFGHIJ", verified: Bool = true,
                          path: String? = nil, childShell: Bool? = false,
                          start: UInt64 = 10) -> NativeOwner {
    let executable = path ?? "/virtual/\(pid).app/Contents/MacOS/Fixture"
    let identity = MacAppIdentity(bundleId: bundle, teamId: team, apple: apple, system: system,
                                  verified: verified, name: "Synthetic capture owner", path: executable, pid: Int(pid))
    return NativeOwner(identity: identity,
                       process: HelperProcessIdentity(pid: pid, parentPID: 1, startSeconds: start,
                                                      startMicroseconds: 20, executable: executable),
                       childShell: childShell)
}

private func captureSession(_ approved: [NativeOwner], paused: Bool = false) -> ServerSession {
    ServerSession(id: "synthetic-capture", revision: 1, mode: "foreground", paused: paused,
                  approved: approved.map { $0.identity.wire }, vectorPids: [900], vectorWindowIds: ["9000"],
                  overlayWindowIds: ["9001"], escStops: true, stopChord: "Command+Shift+Escape")
}

private func captureDisplay(_ id: String = "1", bounds: CGRect = CGRect(x: 0, y: 0, width: 40, height: 30),
                            scale: Double = 1) -> CaptureDisplayInfo {
    CaptureDisplayInfo(id: id, bounds: bounds,
                       pixelSize: CGSize(width: bounds.width * scale, height: bounds.height * scale),
                       scale: scale, primary: id == "1")
}

private func captureWindow(_ id: String, owner: NativeOwner?, bounds: CGRect,
                           onScreen: Bool = true, minimized: Bool? = false,
                           regular: Bool? = true, alpha: Double = 1) -> CaptureWindowInfo {
    CaptureWindowInfo(windowID: id, pid: owner?.process.pid ?? 777, bounds: bounds, onScreen: onScreen,
                      minimized: minimized, alpha: alpha, owner: owner, regularOwner: regular)
}

/// An in-memory bitmap only: no display enumeration, screen capture, permission preflight or native window lookup.
private func captureBitmap(width: Int, height: Int) throws -> CGImage {
    guard width > 0, height > 0 else { throw CaptureTestFailure(message: "Invalid synthetic bitmap dimensions") }
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    for offset in stride(from: 0, to: bytes.count, by: 4) {
        bytes[offset] = 20
        bytes[offset + 1] = 210
        bytes[offset + 2] = 40
        bytes[offset + 3] = 255
    }
    guard let provider = CGDataProvider(data: Data(bytes) as CFData),
          let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                              bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                              provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
        throw CaptureTestFailure(message: "Could not make the in-memory capture fixture")
    }
    return image
}

private func capturePixel(_ data: Data, x: Int, y: Int) throws -> [UInt8] {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let pixel = image.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)) else {
        throw CaptureTestFailure(message: "Expected a decodable frame containing the requested pixel")
    }
    var bytes = [UInt8](repeating: 0, count: 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                                      bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(pixel, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return true
    }
    guard drawn else { throw CaptureTestFailure(message: "Could not inspect an in-memory capture pixel") }
    return bytes
}

private final class CaptureTestState {
    var granted = true
    var denyAtCommit = false
    var commitGrantRefusals = 0
    var epoch = 1
    var insideFence = false
    var preflights = 0
    var displayReads = 0
    var contentReads = 0
    var windowStateReads = 0
    var windowStateResult: Bool? = nil
    var screenshotRequests: [CaptureImageRequest] = []
    var holdContent = false
    var holdScreenshot = false
    var pendingContent: ((Result<CaptureInventory, ServerFailure>) -> Void)?
    var pendingScreenshot: ((Result<CGImage, ServerFailure>) -> Void)?
    var encodeWork: [() -> Void] = []
    var holdEncode = false
    var inventory: CaptureInventory
    var results: [Result<ServerReply, ServerFailure>] = []

    init(inventory: CaptureInventory) { self.inventory = inventory }
}

private final class CaptureFixture {
    let approved: NativeOwner
    var session: ServerSession
    let state: CaptureTestState
    let registry: CaptureRegistry
    let service: CaptureService

    init(windows: [CaptureWindowInfo]? = nil, display: CaptureDisplayInfo = captureDisplay(), paused: Bool = false,
         hostOwnership: ((CaptureWindowInfo, ServerSession, OperationContext) throws -> HostedWindowProof?)? = nil) {
        let owner = captureOwner("example.capture.allowed", pid: 101)
        let registry = CaptureRegistry()
        let state = CaptureTestState(inventory: CaptureInventory(displays: [display], windows: windows ?? [
            captureWindow("1010", owner: owner, bounds: display.bounds)
        ]))
        self.approved = owner
        self.session = captureSession([owner], paused: paused)
        self.state = state
        self.registry = registry
        self.service = CaptureService(
            registry: registry,
            backend: CaptureBackend(
                preflight: {
                    state.preflights += 1
                    if state.denyAtCommit && state.insideFence { state.commitGrantRefusals += 1; return false }
                    return state.granted
                },
                displays: { state.displayReads += 1; return state.inventory.displays },
                content: { completion in
                    state.contentReads += 1
                    if state.holdContent { state.pendingContent = completion }
                    else { completion(.success(state.inventory)) }
                },
                screenshot: { request, completion in
                    state.screenshotRequests.append(request)
                    if state.holdScreenshot { state.pendingScreenshot = completion }
                    else {
                        do { completion(.success(try captureBitmap(width: request.width, height: request.height))) }
                        catch { completion(.failure(ServerFailure(code: "failed", message: "Synthetic bitmap failed."))) }
                    }
                },
                windowState: { _, _, _ in state.windowStateReads += 1; return state.windowStateResult },
                hostOwnership: hostOwnership
            ),
            execute: { $0() },
            encode: { work in
                if state.holdEncode { state.encodeWork.append(work) }
                else { work() }
            }
        )
    }

    func context(session override: ServerSession? = nil) -> OperationContext {
        let state = state
        let epoch = state.epoch
        return OperationContext(session: override ?? session, isCurrent: { state.epoch == epoch }, withCurrent: { body in
            guard state.epoch == epoch else { return false }
            state.insideFence = true
            defer { state.insideFence = false }
            body()
            return true
        })
    }

    func args(target: [String: JSONValue] = ["display": .string("1")], format: String = "png") -> [String: JSONValue] {
        ["target": .object(target),
         "budget": .object(["maxWidth": .integer(40), "maxHeight": .integer(30), "maxPixels": .integer(1200)]),
         "format": .string(format)]
    }

    func capture(_ args: [String: JSONValue]? = nil, context: OperationContext? = nil) {
        let state = state
        service.capture(args ?? self.args(), context: context ?? self.context()) { state.results.append($0) }
    }

    func success(_ index: Int = 0) throws -> ServerReply {
        guard index >= 0, index < state.results.count, case .success(let reply) = state.results[index] else {
            throw CaptureTestFailure(message: "Expected a current capture success")
        }
        return reply
    }

    func failure(_ index: Int = 0) -> String? {
        guard index >= 0, index < state.results.count, case .failure(let error) = state.results[index] else { return nil }
        return error.code
    }
}

/// All ownership/window lists, permission facts, schedulers and images are injected. The system capture backend
/// is never constructed; bitmap creation, image encoding/decoding and privacy math touch only synthetic memory.
func runCaptureTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let fake = CaptureFixture()
        fake.state.granted = false
        fake.service.listDisplays([:], context: fake.context()) { fake.state.results.append($0) }
        let reply = try fake.success()
        try captureCheck(reply.fields["displays"]?.arrayValue?.count == 1 && reply.image == nil,
                         "Display metadata is available without a Screen Recording grant")
        try captureCheck(fake.state.displayReads == 1 && fake.state.preflights == 0 &&
                         fake.state.contentReads == 0 && fake.state.screenshotRequests.isEmpty,
                         "Display listing uses only its grant-free metadata adapter")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.granted = false
        fake.capture()
        try captureCheck(fake.failure() == "permissions", "Missing Screen Recording is an ordinary permission refusal")
        try captureCheck(fake.state.preflights == 1 && fake.state.contentReads == 0 && fake.state.screenshotRequests.isEmpty,
                         "Denied capture never asks ScreenCaptureKit for shareable content or pixels")
    }

    try test {
        let fake = CaptureFixture()
        let context = fake.context()
        fake.state.epoch += 1
        fake.capture(context: context)
        try captureCheck(fake.failure() == "changed" && fake.state.contentReads == 0 && fake.state.screenshotRequests.isEmpty,
                         "An already-revoked operation never acquires a native capture inventory")
        let refusedCommit = CaptureFixture()
        let readOnlyCurrent = OperationContext(session: refusedCommit.session, isCurrent: { true }, withCurrent: { _ in false })
        refusedCommit.capture(context: readOnlyCurrent)
        try captureCheck(refusedCommit.failure() == "changed",
                         "A current read check cannot replace the atomic authority fence required to retain a finished frame")
    }

    try test {
        let fake = CaptureFixture()
        var malformed: [[String: JSONValue]] = [[:]]
        for target in [[String: JSONValue](), ["display": .string("1"), "windowId": .string("1010")],
                       ["display": .string("")], ["display": .string(String(repeating: "x", count: 257))],
                       ["windowId": .integer(1010)], ["pid": .integer(101)]] {
            malformed.append(fake.args(target: target))
        }
        for budget in [["maxWidth": JSONValue.integer(0), "maxHeight": .integer(30), "maxPixels": .integer(1200)],
                       ["maxWidth": .integer(16385), "maxHeight": .integer(30), "maxPixels": .integer(1200)],
                       ["maxWidth": .integer(40), "maxHeight": .integer(-1), "maxPixels": .integer(1200)],
                       ["maxWidth": .integer(40), "maxHeight": .integer(30), "maxPixels": .integer(268435457)],
                       ["maxWidth": .number(40.5), "maxHeight": .integer(30), "maxPixels": .integer(1200)],
                       ["maxWidth": .integer(40), "maxHeight": .integer(30)]] {
            var args = fake.args(); args["budget"] = .object(budget); malformed.append(args)
        }
        for quality in [JSONValue.integer(0), .integer(101), .number(80.5), .string("80")] {
            var args = fake.args(); args["quality"] = quality; malformed.append(args)
        }
        var badFormat = fake.args(); badFormat["format"] = .string("heic"); malformed.append(badFormat)
        var extra = fake.args(); extra["path"] = .string("/virtual/frame.png"); malformed.append(extra)
        for args in malformed {
            let before = fake.state.results.count
            fake.capture(args)
            try captureCheck(fake.failure(before) == "failed", "Malformed capture arguments are refused before acquisition")
        }
        try captureCheck(fake.state.contentReads == 0 && fake.state.screenshotRequests.isEmpty,
                         "Invalid budgets, target unions, formats and quality cannot trigger capture")
    }

    try test {
        let fake = CaptureFixture()
        fake.capture()
        let reply = try fake.success()
        guard let bytes = reply.image else { throw CaptureTestFailure(message: "Capture omitted its binary frame") }
        try captureCheck(Array(bytes.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10], "PNG requests produce actual PNG bytes")
        try captureCheck(reply.fields["width"] == .integer(40) && reply.fields["height"] == .integer(30) &&
                         reply.fields["imageScale"]?.doubleValue == 1 && reply.fields["displayId"] == .string("1"),
                         "The header describes the final encoded bitmap in pixels per native point")
        try captureCheck(reply.fields["imageBytes"]?.intValue == bytes.count && reply.fields["hiddenCount"] == .integer(0) &&
                         reply.fields["masked"] == .array([]), "Image length and required privacy facts match the final frame")
        let hash = reply.fields["hash"]?.stringValue ?? ""
        try captureCheck(hash.count == 16 && hash.allSatisfy { "0123456789abcdef".contains($0) },
                         "The final frame has the required lower-case 64-bit perceptual hash")
        try captureCheck(try capturePixel(bytes, x: 2, y: 2) == [20, 210, 40, 255],
                         "An approved synthetic window survives the real encode path unchanged")
        try captureCheck(fake.state.screenshotRequests.count == 1 &&
                         fake.state.screenshotRequests[0].width == 40 && fake.state.screenshotRequests[0].height == 30,
                         "Only the budget-sized frame is requested from the screenshot backend")
        try captureCheck(fake.state.windowStateReads == 0,
                         "Display capture never asks Accessibility to enumerate native window minimized state")
    }

    try test {
        let fake = CaptureFixture()
        fake.capture(fake.args(format: "jpeg"))
        guard let bytes = try fake.success().image else { throw CaptureTestFailure(message: "Missing JPEG frame") }
        try captureCheck(Array(bytes.prefix(2)) == [255, 216], "JPEG requests produce actual JPEG bytes")
        try captureCheck(try capturePixel(bytes, x: 20, y: 15)[3] == 255, "The encoded JPEG frame is opaque")
    }

    try test {
        let display = captureDisplay(bounds: CGRect(x: -1001, y: -777, width: 1001, height: 777))
        let fake = CaptureFixture(display: display)
        var args = fake.args()
        args["budget"] = .object(["maxWidth": .integer(333), "maxHeight": .integer(333), "maxPixels": .integer(110889)])
        fake.capture(args)
        let reply = try fake.success()
        guard let request = fake.state.screenshotRequests.first,
              let captureID = reply.fields["captureId"]?.stringValue else {
            throw CaptureTestFailure(message: "Nondivisible downscale omitted its geometry")
        }
        let scale = 333.0 / 1001.0
        let source = request.sourceRect(origin: display.bounds.origin)
        try captureCheck(reply.fields["width"] == .integer(333) && reply.fields["height"] == .integer(258) &&
                         abs((reply.fields["imageScale"]?.doubleValue ?? 0) - scale) < 0.000000001,
                         "A nondivisible native size retains the one uniform scale announced in the header")
        try captureCheck(source.origin == .zero && abs(Double(source.width) - 333.0 / scale) < 0.000000001 &&
                         abs(Double(source.height) - 258.0 / scale) < 0.000000001,
                         "The native screenshot source trims only right/bottom subpixel tails instead of adding aspect-ratio padding")
        try captureCheck(abs(Double(request.width) / Double(source.width) - request.imageScale) < 0.000000001 &&
                         abs(Double(request.height) / Double(source.height) - request.imageScale) < 0.000000001,
                         "The actual ScreenCaptureKit source rectangle and output raster share the header's exact scale on both axes")
        let retained = try fake.registry.get(captureID, sessionID: fake.session.id,
                                             observationEpoch: fake.session.observationEpoch, phaseRevision: fake.session.revision)
        try captureCheck(retained.bounds == request.bounds && retained.bounds.origin == display.bounds.origin,
                         "Negative global origins remain exact when the retained geometry records the trimmed native source")
    }

    try test {
        let fake = CaptureFixture(paused: true)
        let window = captureWindow("1010", owner: fake.approved, bounds: CGRect(x: -5, y: -4, width: 20, height: 10),
                                   onScreen: false, minimized: false)
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [window])
        fake.capture(fake.args(target: ["windowId": .string("1010")]))
        let reply = try fake.success()
        try captureCheck(reply.fields["paused"] == nil && reply.image != nil && fake.state.screenshotRequests.count == 1,
                         "An approved offscreen or occluded window still captures, including during a paused input session")
        try captureCheck(fake.state.screenshotRequests[0].windowID == "1010",
                         "Window capture selects the independent target window rather than the display")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [
            captureWindow("1010", owner: fake.approved, bounds: CGRect(x: 0, y: 0, width: 20, height: 10), minimized: true)
        ])
        fake.capture(fake.args(target: ["windowId": .string("1010")]))
        let reply = try fake.success()
        try captureCheck(reply.fields == ["paused": .bool(true)] && reply.image == nil && fake.state.screenshotRequests.isEmpty,
                         "A positively minimized window returns paused without acquiring pixels")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [
            captureWindow("1010", owner: fake.approved, bounds: CGRect(x: 0, y: 0, width: 20, height: 10), minimized: nil)
        ])
        fake.capture(fake.args(target: ["windowId": .string("1010")]))
        try captureCheck(fake.failure() == "unavailable" && fake.state.screenshotRequests.isEmpty,
                         "Unknown minimized state is not silently invented as false")
        fake.state.windowStateResult = false
        fake.capture(fake.args(target: ["windowId": .string("1010")]))
        try captureCheck(try fake.success(1).image != nil && fake.state.windowStateReads == 3,
                         "An approved window may resolve unknown minimized state through its injected adapter before and after capture")
    }

    try test {
        let fake = CaptureFixture()
        fake.capture(fake.args(target: ["windowId": .string("4040")]))
        fake.capture(fake.args(target: ["display": .string("404")]))
        try captureCheck(fake.failure(0) == "capture_unavailable" && fake.failure(1) == "capture_unavailable" &&
                         fake.state.screenshotRequests.isEmpty, "Unknown native targets do not produce a guessed frame")
    }

    try test {
        let fake = CaptureFixture()
        let unapproved = captureOwner("example.capture.unapproved", pid: 102)
        let terminal = captureOwner("com.apple.Terminal", pid: 103, apple: true, system: true, team: nil)
        let vector = captureOwner(Identity.channels[0].appId, pid: 900)
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [
            captureWindow("1020", owner: unapproved, bounds: CGRect(x: 0, y: 0, width: 10, height: 10), minimized: true),
            captureWindow("1030", owner: terminal, bounds: CGRect(x: 0, y: 0, width: 10, height: 10)),
            captureWindow("9000", owner: vector, bounds: CGRect(x: 0, y: 0, width: 10, height: 10)),
            captureWindow("9001", owner: fake.approved, bounds: CGRect(x: 0, y: 0, width: 10, height: 10))
        ])
        for id in ["1020", "1030", "9000", "9001"] { fake.capture(fake.args(target: ["windowId": .string(id)])) }
        try captureCheck(fake.failure(0) == "not_granted" && fake.failure(1) == "protected" &&
                         fake.failure(2) == "protected" && fake.failure(3) == "protected",
                         "Window captures enforce approvals and protected/exact-overlay floors before minimized disclosure")
        try captureCheck(fake.state.screenshotRequests.isEmpty, "A refused owner never reaches the pixel acquisition backend")
        try captureCheck(fake.state.windowStateReads == 0,
                         "Protected and unapproved targets are refused before any Accessibility window-state adapter")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.holdContent = true
        fake.capture()
        fake.state.epoch += 1
        fake.state.pendingContent?(.success(fake.state.inventory))
        try captureCheck(fake.failure() == "changed" && fake.state.screenshotRequests.isEmpty,
                         "Session revocation during shareable-content enumeration stops pixel acquisition")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.holdScreenshot = true
        fake.capture()
        fake.state.epoch += 1
        fake.state.pendingScreenshot?(.success(try captureBitmap(width: 40, height: 30)))
        try captureCheck(fake.failure() == "changed" && fake.state.results.count == 1,
                         "An image finishing after revocation is never returned as a success")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.holdEncode = true
        fake.capture()
        try captureCheck(fake.state.encodeWork.count == 1, "Encoding is held independently from native image acquisition")
        fake.state.epoch += 1
        while !fake.state.encodeWork.isEmpty { fake.state.encodeWork.removeFirst()() }
        try captureCheck(fake.failure() == "changed", "Revocation while encoding discards the resulting frame")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.holdEncode = true
        fake.capture()
        try captureCheck(fake.state.encodeWork.count == 1, "The synthetic frame reached its queued encoder")
        fake.state.granted = false
        while !fake.state.encodeWork.isEmpty { fake.state.encodeWork.removeFirst()() }
        try captureCheck(fake.failure() == "permissions" && fake.state.results.count == 1,
                         "Losing Screen Recording while encoding refuses the image even when session authority remains current")
        let refusedCommit = CaptureFixture()
        refusedCommit.state.denyAtCommit = true
        refusedCommit.capture()
        try captureCheck(refusedCommit.failure() == "permissions" && refusedCommit.state.commitGrantRefusals == 1,
                         "Screen Recording is rechecked inside the final commit fence after all acquisition and encoding preflights passed")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.holdScreenshot = true
        fake.capture()
        fake.registry.invalidateDisplays()
        fake.state.pendingScreenshot?(.success(try captureBitmap(width: 40, height: 30)))
        try captureCheck(fake.failure() == "stale_frame", "Display reconfiguration invalidates an in-flight frame")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.holdScreenshot = true
        fake.capture()
        fake.service.close()
        fake.service.close()
        fake.state.pendingScreenshot?(.success(try captureBitmap(width: 40, height: 30)))
        try captureCheck(fake.failure() == "changed", "Closing the service prevents a late callback from returning pixels")
    }

    try test {
        let bounds = CGRect(x: 0, y: 0, width: 40, height: 30)
        let allowed = captureOwner("example.capture.allowed", pid: 101)
        let hidden = captureOwner("example.capture.hidden", pid: 102)
        let occluded = captureOwner("example.capture.occluded", pid: 103)
        let vector = captureOwner(Identity.channels[0].appId, pid: 900)
        let notifications = captureOwner("com.apple.notificationcenterui", pid: 201, apple: true,
                                         system: true, team: nil, path: "/System/Library/FixtureNotificationHost")
        let dock = captureOwner("com.apple.dock", pid: 301, apple: true, system: true,
                                team: nil, path: "/System/Library/FixtureDock")
        let session = captureSession([allowed])
        let windows = [
            captureWindow("9001", owner: vector, bounds: bounds, regular: false),
            captureWindow("1010", owner: allowed, bounds: CGRect(x: 10, y: 0, width: 10, height: 20)),
            captureWindow("3010", owner: dock, bounds: CGRect(x: 35, y: 0, width: 5, height: 5), regular: false),
            captureWindow("2010", owner: notifications, bounds: CGRect(x: 0, y: 22, width: 5, height: 5), regular: false),
            captureWindow("9000", owner: vector, bounds: CGRect(x: 20, y: 22, width: 5, height: 5)),
            captureWindow("1021", owner: hidden, bounds: CGRect(x: 30, y: 22, width: 5, height: 5)),
            captureWindow("1020", owner: hidden, bounds: CGRect(x: 0, y: 0, width: 30, height: 20)),
            captureWindow("1030", owner: occluded, bounds: CGRect(x: 10, y: 0, width: 10, height: 20)),
            captureWindow("1031", owner: occluded, bounds: CGRect(x: 50, y: 0, width: 10, height: 20)),
            captureWindow("1011", owner: allowed, bounds: bounds)
        ]
        let plan = try CapturePrivacy.plan(windows: windows, bounds: bounds,
                                           policy: SessionPolicy(session: session, helperPID: 999), session: session)
        try captureCheck(Set(plan.includedWindowIDs) == Set(["1010", "3010", "1011"]),
                         "Only approved windows and positively verified benign furniture enter the pixel source")
        try captureCheck(plan.hiddenCount == 2,
                         "Visible masks count each regular owner once, including Vector but excluding notifications and occluded owners")
        let totalArea = plan.masks.reduce(CGFloat(0)) { $0 + $1.bounds.width * $1.bounds.height }
        try captureCheck(plan.masks.count == 5 && totalArea == 475,
                         "Front-to-back subtraction masks visible pieces without painting over approved windows above them")
        try captureCheck(plan.masks.filter(\.vector).count == 1 &&
                         plan.masks.allSatisfy { bounds.contains($0.bounds) },
                         "Vector has a labelled-mask fact and all mask rectangles are clipped to the capture")
        try captureCheck(!plan.masks.contains { $0.bounds.contains(CGPoint(x: 15, y: 5)) },
                         "A hidden window below an approved window never covers the approved pixels with a mask")
    }

    try test {
        let fake = CaptureFixture()
        let hidden = captureOwner("example.capture.hidden", pid: 102)
        let vector = captureOwner(Identity.channels[0].appId, pid: 900)
        let notifications = captureOwner("com.apple.notificationcenterui", pid: 201, apple: true,
                                         system: true, team: nil, path: "/System/Library/FixtureNotificationHost")
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [
            captureWindow("9001", owner: vector, bounds: CGRect(x: 0, y: 0, width: 40, height: 30), regular: false),
            captureWindow("1010", owner: fake.approved, bounds: CGRect(x: 10, y: 0, width: 10, height: 20)),
            captureWindow("1020", owner: hidden, bounds: CGRect(x: 0, y: 0, width: 30, height: 20)),
            captureWindow("2010", owner: notifications, bounds: CGRect(x: 0, y: 22, width: 5, height: 5), regular: false),
            captureWindow("9000", owner: vector, bounds: CGRect(x: 20, y: 22, width: 10, height: 8)),
            captureWindow("1011", owner: fake.approved, bounds: CGRect(x: 0, y: 0, width: 40, height: 30))
        ])
        fake.capture()
        let reply = try fake.success()
        guard let image = reply.image else { throw CaptureTestFailure(message: "Missing synthetic privacy frame") }
        try captureCheck(try capturePixel(image, x: 5, y: 5) == [0, 0, 0, 255] &&
                         capturePixel(image, x: 25, y: 5) == [0, 0, 0, 255] &&
                         capturePixel(image, x: 2, y: 24) == [0, 0, 0, 255],
                         "Hidden app and notification regions are actual opaque black pixels in the encoded frame")
        try captureCheck(try capturePixel(image, x: 15, y: 5) == [20, 210, 40, 255] &&
                         capturePixel(image, x: 38, y: 28) == [20, 210, 40, 255],
                         "Approved foreground pixels and pixels underneath an excluded overlay remain visible")
        let vectorPixel = try capturePixel(image, x: 20, y: 29)
        try captureCheck(vectorPixel[3] == 255 && vectorPixel != [20, 210, 40, 255],
                         "The Vector main window is opaque after source exclusion, so content behind it is never exposed")
        try captureCheck(reply.fields["hiddenCount"] == .integer(2) &&
                         Set(fake.state.screenshotRequests[0].includedWindowIDs) == Set(["1010", "1011"]),
                         "Encoded privacy facts match the filtered source; exact overlay IDs never enter it")
    }

    try test {
        let allowed = captureOwner("example.capture.allowed", pid: 101)
        let session = captureSession([allowed])
        let bounds = CGRect(x: 0, y: 0, width: 40, height: 30)
        let policy = try SessionPolicy(session: session, helperPID: 999)
        let windows = [
            captureWindow("9001", owner: allowed, bounds: CGRect(x: 0, y: 0, width: 10, height: 10)),
            captureWindow("90010", owner: allowed, bounds: CGRect(x: 10, y: 0, width: 10, height: 10)),
            captureWindow("1010", owner: allowed, bounds: bounds)
        ]
        let plan = try CapturePrivacy.plan(windows: windows, bounds: bounds, policy: policy, session: session)
        try captureCheck(Set(plan.includedWindowIDs) == Set(["90010", "1010"]) && plan.masks.isEmpty && plan.hiddenCount == 0,
                         "Overlay exclusion matches only the exact window ID, even within an otherwise approved app")
        let unknownOverlay = try CapturePrivacy.plan(windows: [
            captureWindow("9001", owner: nil, bounds: bounds, regular: nil), windows[2]
        ], bounds: bounds, policy: policy, session: session)
        try captureCheck(unknownOverlay.includedWindowIDs == ["1010"] && unknownOverlay.masks.isEmpty,
                         "A trusted exact overlay ID is removed before irrelevant owner evidence is requested")
    }

    try test {
        let allowed = captureOwner("example.capture.allowed", pid: 101)
        let session = captureSession([allowed])
        let bounds = CGRect(x: 0, y: 0, width: 40, height: 30)
        let policy = try SessionPolicy(session: session, helperPID: 999)
        try captureRefusal("unavailable") {
            _ = try CapturePrivacy.plan(windows: [captureWindow("7770", owner: nil, bounds: bounds)],
                                         bounds: bounds, policy: policy, session: session)
        }
        let hidden = captureOwner("example.capture.hidden", pid: 102)
        try captureRefusal("unavailable") {
            _ = try CapturePrivacy.plan(windows: [captureWindow("1020", owner: hidden, bounds: bounds, regular: nil)],
                                         bounds: bounds, policy: policy, session: session)
        }
        let fake = CaptureFixture(windows: [captureWindow("7770", owner: nil, bounds: bounds)])
        fake.capture()
        try captureCheck(fake.failure() == "unavailable" && fake.state.screenshotRequests.isEmpty,
                         "Unavailable native signer/owner evidence refuses before any source pixels are requested")
        var host = captureWindow("7770", owner: nil, bounds: bounds, regular: nil)
        host.nonApplicationHost = HelperProcessIdentity(pid: 777, parentPID: 1, startSeconds: 40, startMicroseconds: 50,
                                                        executable: "/System/Library/SyntheticWindowHost")
        let verifiedHost = try CapturePrivacy.plan(windows: [host], bounds: bounds, policy: policy, session: session)
        try captureCheck(verifiedHost.includedWindowIDs.isEmpty && verifiedHost.masks.count == 1 && verifiedHost.hiddenCount == 0,
                         "An independently verified non-application system host remains opaque without inventing an app count")
    }

    try test {
        let allowed = captureOwner("example.capture.allowed", pid: 101)
        let session = captureSession([allowed])
        let bounds = CGRect(x: 0, y: 0, width: 40, height: 30)
        let spoofedDock = captureOwner("com.apple.dock", pid: 302)
        let accessory = captureOwner("example.capture.accessory", pid: 303)
        let spoofedNotification = captureOwner("com.apple.notificationcenterui", pid: 304)
        let plan = try CapturePrivacy.plan(windows: [
            captureWindow("3020", owner: spoofedDock, bounds: CGRect(x: 0, y: 0, width: 10, height: 10)),
            captureWindow("3030", owner: accessory, bounds: CGRect(x: 10, y: 0, width: 10, height: 10), regular: false),
            captureWindow("3040", owner: spoofedNotification, bounds: CGRect(x: 20, y: 0, width: 10, height: 10)),
            captureWindow("1010", owner: allowed, bounds: bounds)
        ], bounds: bounds, policy: SessionPolicy(session: session, helperPID: 999), session: session)
        try captureCheck(Set(plan.includedWindowIDs) == Set(["1010"]) && plan.masks.count == 3 && plan.hiddenCount == 2,
                         "Bundle-name claims cannot establish furniture/notification exemptions or a nonregular owner fact")
    }

    try test {
        let fake = CaptureFixture()
        let grant = captureOwner("example.capture.unsigned", pid: 102, team: nil, verified: false)
        let changedPID = captureOwner("example.capture.unsigned", pid: 103, team: nil, verified: false,
                                      path: grant.process.executable)
        fake.session = captureSession([grant])
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [
            captureWindow("1030", owner: changedPID, bounds: CGRect(x: 0, y: 0, width: 40, height: 30))
        ])
        fake.capture(fake.args(target: ["windowId": .string("1030")]))
        try captureCheck(fake.failure() == "not_granted" && fake.state.screenshotRequests.isEmpty,
                         "An unsigned app approval never transfers to a different process with the same bundle and path")
    }

    try test {
        let fake = CaptureFixture()
        let mismatched = CaptureWindowInfo(windowID: "1010", pid: 102,
            bounds: CGRect(x: 0, y: 0, width: 40, height: 30), onScreen: true, minimized: false,
            owner: fake.approved, regularOwner: true)
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [mismatched])
        fake.capture(fake.args(target: ["windowId": .string("1010")]))
        try captureCheck(fake.failure() == "changed" && fake.state.screenshotRequests.isEmpty,
                         "A window PID must match the private process and observed identity before independent-window capture")
    }

    try test {
        let fake = CaptureFixture()
        fake.state.holdScreenshot = true
        fake.capture()
        var changed = fake.state.inventory.windows[0]
        changed.alpha = 0.5
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [changed])
        fake.state.pendingScreenshot?(.success(try captureBitmap(width: 40, height: 30)))
        try captureCheck(fake.failure() == "stale_frame",
                         "Changed native opacity invalidates the image even when source IDs, owner PID and frame remain unchanged")
    }

    try test {
        let fake = CaptureFixture()
        let vector = captureOwner(Identity.channels[0].appId, pid: 900)
        let approvedWindow = captureWindow("1010", owner: fake.approved, bounds: CGRect(x: 0, y: 0, width: 40, height: 30))
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [
            captureWindow("9001", owner: vector, bounds: CGRect(x: 0, y: 0, width: 10, height: 10), regular: false),
            approvedWindow
        ])
        fake.state.holdScreenshot = true
        fake.capture()
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [
            captureWindow("9001", owner: vector, bounds: CGRect(x: 20, y: 10, width: 10, height: 10), regular: false),
            approvedWindow
        ])
        fake.state.pendingScreenshot?(.success(try captureBitmap(width: 40, height: 30)))
        guard let baseID = try fake.success().fields["captureId"]?.stringValue else {
            throw CaptureTestFailure(message: "Excluded overlay movement incorrectly invalidated the image")
        }
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [
            captureWindow("9001", owner: vector, bounds: CGRect(x: 30, y: 20, width: 10, height: 10), regular: false),
            approvedWindow
        ])
        fake.state.holdScreenshot = false
        var zoom = fake.args()
        zoom["zoom"] = .object(["captureId": .string(baseID),
                                "region": .object(["x0": .integer(0), "y0": .integer(0),
                                                    "x1": .integer(20), "y1": .integer(15)])])
        fake.capture(zoom)
        try captureCheck(try fake.success(1).image != nil && fake.state.screenshotRequests.count == 2,
                         "Only moving an exact excluded overlay preserves both in-flight image and subsequent zoom geometry")
    }

    try test {
        let allowed = captureOwner("example.capture.allowed", pid: 101)
        let first = captureOwner("example.capture.hidden", pid: 102)
        let second = captureOwner("example.capture.hidden", pid: 103)
        let session = captureSession([allowed])
        let bounds = CGRect(x: 0, y: 0, width: 40, height: 30)
        let plan = try CapturePrivacy.plan(windows: [
            captureWindow("1020", owner: first, bounds: CGRect(x: 0, y: 0, width: 10, height: 10)),
            captureWindow("1030", owner: second, bounds: CGRect(x: 20, y: 0, width: 10, height: 10)),
            captureWindow("1010", owner: allowed, bounds: bounds)
        ], bounds: bounds, policy: SessionPolicy(session: session, helperPID: 999), session: session)
        try captureCheck(plan.hiddenCount == 1 && plan.masks.count == 2,
                         "One regular app identity contributes one hidden app even when it has multiple native processes")
        let vector = captureOwner(Identity.channels[0].appId, pid: 901)
        let newlyObservedVector = try CapturePrivacy.plan(windows: [
            captureWindow("9010", owner: vector, bounds: CGRect(x: 0, y: 0, width: 10, height: 10)),
            captureWindow("1010", owner: allowed, bounds: bounds)
        ], bounds: bounds, policy: SessionPolicy(session: session, helperPID: 999), session: session)
        try captureCheck(newlyObservedVector.masks.count == 1 && newlyObservedVector.masks[0].vector &&
                         newlyObservedVector.hiddenCount == 1 && !newlyObservedVector.includedWindowIDs.contains("9010"),
                         "Generated Vector app identities remain labelled opaque blocks even before session PID/window lists refresh")
    }

    try test {
        let allowed = captureOwner("example.capture.allowed", pid: 101)
        let hidden = captureOwner("example.capture.hidden", pid: 102)
        let session = captureSession([allowed])
        let bounds = CGRect(x: 0, y: 0, width: 40, height: 30)
        let plan = try CapturePrivacy.plan(windows: [
            captureWindow("7770", owner: nil, bounds: bounds, regular: nil, alpha: 0),
            captureWindow("1010", owner: allowed, bounds: CGRect(x: 10, y: 0, width: 10, height: 20), alpha: 0.5),
            captureWindow("1020", owner: hidden, bounds: CGRect(x: 0, y: 0, width: 30, height: 20)),
            captureWindow("1011", owner: allowed, bounds: bounds)
        ], bounds: bounds, policy: SessionPolicy(session: session, helperPID: 999), session: session)
        try captureCheck(plan.hiddenCount == 1 && plan.masks.count == 1 &&
                         plan.masks[0].bounds == CGRect(x: 0, y: 0, width: 30, height: 20),
                         "Invisible windows contribute nothing, and translucent foreground windows cannot prove a hidden app occluded")
    }

    try test {
        let fake = CaptureFixture()
        fake.capture()
        guard let baseID = try fake.success().fields["captureId"]?.stringValue else {
            throw CaptureTestFailure(message: "Full capture omitted its registry ID")
        }
        var zoom = fake.args()
        zoom["zoom"] = .object(["captureId": .string(baseID),
                                "region": .object(["x0": .integer(10), "y0": .integer(5),
                                                    "x1": .integer(30), "y1": .integer(15)])])
        fake.capture(zoom)
        let reply = try fake.success(1)
        guard let zoomID = reply.fields["captureId"]?.stringValue, let bytes = reply.image else {
            throw CaptureTestFailure(message: "Zoom omitted its registry ID or PNG frame")
        }
        try captureCheck(reply.fields["width"] == .integer(20) && reply.fields["height"] == .integer(10) &&
                         reply.fields["origin"] == .object(["x": .number(10), "y": .number(5)]),
                         "Zoom rereads the native subregion described by the full frame's pixel edges")
        try captureCheck(Array(bytes.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10] &&
                         fake.state.screenshotRequests[1].bounds == CGRect(x: 10, y: 5, width: 20, height: 10),
                         "Zoom produces actual PNG pixels from the requested native crop")
        let base = try fake.registry.get(baseID, sessionID: fake.session.id,
                                         observationEpoch: fake.session.observationEpoch, phaseRevision: fake.session.revision)
        try captureCheck(base.bounds == CGRect(x: 0, y: 0, width: 40, height: 30) && base.zoomSourceID == nil,
                         "Producing a zoom retains the original full-frame coordinate authority")
        try captureRefusal("stale_frame") {
            _ = try fake.registry.get(zoomID, sessionID: fake.session.id,
                                       observationEpoch: fake.session.observationEpoch, phaseRevision: fake.session.revision)
        }
        zoom["zoom"] = .object(["captureId": .string(zoomID),
                                "region": .object(["x0": .integer(0), "y0": .integer(0),
                                                    "x1": .integer(10), "y1": .integer(5)])])
        fake.capture(zoom)
        try captureCheck(fake.failure(2) == "stale_frame" && fake.state.screenshotRequests.count == 2,
                         "A zoom cannot become a new input/zoom coordinate space")
    }

    try test {
        let fake = CaptureFixture()
        fake.capture()
        guard let baseID = try fake.success().fields["captureId"]?.stringValue else {
            throw CaptureTestFailure(message: "Missing full-frame registry ID")
        }
        fake.session.observationEpoch = UUID()
        var args = fake.args()
        args["zoom"] = .object(["captureId": .string(baseID),
                                "region": .object(["x0": .integer(0), "y0": .integer(0),
                                                    "x1": .integer(20), "y1": .integer(15)])])
        fake.capture(args)
        try captureCheck(fake.failure(1) == "stale_frame" && fake.state.screenshotRequests.count == 1,
                         "An accepted authority update invalidates old pixels even when raw session ID and revision repeat")
    }

    try test {
        let fake = CaptureFixture()
        fake.capture()
        guard let baseID = try fake.success().fields["captureId"]?.stringValue else {
            throw CaptureTestFailure(message: "Missing source frame for native fingerprint check")
        }
        var changed = fake.state.inventory.windows[0]
        changed.spaceWitness = "synthetic-space-after"
        fake.state.inventory = CaptureInventory(displays: [captureDisplay()], windows: [changed])
        var args = fake.args()
        args["zoom"] = .object(["captureId": .string(baseID),
                                "region": .object(["x0": .integer(0), "y0": .integer(0),
                                                    "x1": .integer(20), "y1": .integer(15)])])
        fake.capture(args)
        try captureCheck(fake.failure(1) == "stale_frame" && fake.state.screenshotRequests.count == 1,
                         "A zoom retains native Space/ownership facts rather than trusting unchanged public frame bounds")
    }

    try test {
        let fake = CaptureFixture()
        fake.capture()
        guard let baseID = try fake.success().fields["captureId"]?.stringValue else {
            throw CaptureTestFailure(message: "Missing source frame for zoom bounds checks")
        }
        let regions: [[String: JSONValue]] = [
            ["x0": .integer(-1), "y0": .integer(0), "x1": .integer(10), "y1": .integer(10)],
            ["x0": .integer(0), "y0": .integer(0), "x1": .integer(41), "y1": .integer(10)],
            ["x0": .integer(0), "y0": .integer(0), "x1": .integer(10), "y1": .integer(31)],
            ["x0": .integer(10), "y0": .integer(0), "x1": .integer(10), "y1": .integer(10)],
            ["x0": .number(0.5), "y0": .integer(0), "x1": .integer(10), "y1": .integer(10)]
        ]
        for region in regions {
            var args = fake.args()
            args["zoom"] = .object(["captureId": .string(baseID), "region": .object(region)])
            let index = fake.state.results.count
            fake.capture(args)
            try captureCheck(fake.failure(index) != nil, "Invalid zoom edges never produce a capture reply")
        }
        try captureCheck(fake.state.screenshotRequests.count == 1,
                         "Out-of-bounds, empty and fractional zoom crops never reach the screenshot backend")
    }

    try test {
        let host = HostOwnershipTestFixture()
        var surface = host.surface
        surface.owner = host.logical; surface.regularOwner = true
        host.window = surface; host.windows = [surface]
        let resolver = host.makeResolver()
        let fake = CaptureFixture(windows: [surface], display: captureDisplay(bounds: surface.bounds),
            hostOwnership: { window, session, operation in
                try resolver.resolve(window: window, session: session, isCurrent: operation.isCurrent)
            })
        fake.session = host.session()
        fake.capture(fake.args(target: ["windowId": .string(surface.windowID)]))
        let reply = try fake.success()
        guard let id = reply.fields["captureId"]?.stringValue else { throw CaptureTestFailure(message: "Missing hosted capture id") }
        let frame = try fake.registry.get(id, sessionID: fake.session.id, observationEpoch: fake.session.observationEpoch)
        try captureCheck(frame.ownerProcess == host.logical.process && frame.windows.first?.process == host.logical.process &&
                         frame.windows.first?.hosted?.physicalOwner.process == host.physical.process &&
                         frame.windows.first?.hosted?.logicalOwner.process == host.logical.process,
                         "An explicit client-owned CG window retains a separate physical AX host proof without rewriting its actual capture owner")
        try captureCheck(fake.state.screenshotRequests.first?.includedWindowIDs == [surface.windowID],
                         "Hosted captures continue to name the real WindowServer surface, never an invented logical window id")
    }

    try test {
        let host = HostOwnershipTestFixture(surfaceIsPhysical: true)
        var surface = host.surface
        surface.owner = host.physical; surface.regularOwner = false
        host.window = surface; host.windows = [surface]
        let resolver = host.makeResolver()
        let fake = CaptureFixture(windows: [surface], display: captureDisplay(bounds: surface.bounds),
            hostOwnership: { window, session, operation in
                try resolver.resolve(window: window, session: session, isCurrent: operation.isCurrent)
            })
        fake.session = host.session()
        fake.capture()
        let reply = try fake.success()
        try captureCheck(reply.fields["masked"] == .array([]) && reply.fields["hiddenCount"] == .integer(0),
                         "A proven panel for the approved client is visible even when its real CG owner is the normally protected system host")
        let request = fake.state.screenshotRequests.first
        try captureCheck(request?.includedWindowIDs == [surface.windowID] &&
                         request?.inventory.windows.first?.owner?.process == host.physical.process,
                         "Including an approved hosted surface never replaces the native capture process with its logical grant owner")
    }

    try test {
        let host = HostOwnershipTestFixture(surfaceIsPhysical: true)
        var surface = host.surface
        surface.owner = host.physical; surface.regularOwner = false
        host.window = surface; host.windows = [surface]
        let resolver = host.makeResolver()
        let fake = CaptureFixture(windows: [surface], display: captureDisplay(bounds: surface.bounds),
            hostOwnership: { window, session, operation in
                try resolver.resolve(window: window, session: session, isCurrent: operation.isCurrent)
            })
        fake.session = host.session()
        let replacement = captureOwner("example.host.second", pid: 303)
        fake.session.approved.append(replacement.identity.wire)
        fake.state.holdScreenshot = true
        fake.capture()
        guard let request = fake.state.screenshotRequests.first, let complete = fake.state.pendingScreenshot else {
            throw CaptureTestFailure(message: "Missing pending hosted screenshot")
        }
        host.logical = replacement; host.install(replacement); host.responsible = replacement.process.pid
        host.elementPIDs[host.logicalWindow.identity] = replacement.process.pid
        host.links = [HostAXBridge(logicalPID: replacement.process.pid, logicalWindow: host.logicalWindow,
                                  linkedRoot: host.physicalRoot, physicalRoot: host.physicalRoot)]
        complete(.success(try captureBitmap(width: request.width, height: request.height)))
        try captureCheck(fake.failure() == "stale_frame", "A panel client remap while capturing invalidates the image even when physical PID, CG id and bounds stay unchanged")
    }

    try test {
        let host = HostOwnershipTestFixture(surfaceIsPhysical: true)
        let security = captureOwner("com.apple.SecurityAgent", pid: 202, apple: true, system: true, team: nil,
            path: "/System/Library/CoreServices/SecurityAgent.app/Contents/MacOS/SecurityAgent")
        host.physical = security; host.install(security)
        var surface = host.surface
        surface.owner = security; surface.regularOwner = false
        host.window = surface; host.windows = [surface]
        let resolver = host.makeResolver()
        let fake = CaptureFixture(windows: [surface], display: captureDisplay(bounds: surface.bounds),
            hostOwnership: { window, session, operation in
                try resolver.resolve(window: window, session: session, isCurrent: operation.isCurrent)
            })
        fake.session = host.session()
        fake.capture(fake.args(target: ["windowId": .string(surface.windowID)]))
        try captureCheck(fake.failure() == "protected" && fake.state.screenshotRequests.isEmpty,
                         "A responsible approved client and matching AX roots never exempt a real security host from capture refusal")
    }
    return count
}
