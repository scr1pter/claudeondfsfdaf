import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Dispatch
import Foundation
import Security

// C2 supplies OverlayDriverIdentity.swift for this target only. It pins the exact smoke bundles,
// pinned Electron executable/default app and native source digest; no runtime environment grants trust.
private let overlayDriverBundleID = "ai.vector.computer.test-overlay-driver"
private let overlayDriverExecutable = "VectorComputerOverlayDriver"
private let overlayDriverFrameLimit = 8192
private let overlayDriverTag: Int64 = 0x5654434F534D4143

private func fail(_ reason: OverlayDriverReason) throws -> Never { throw OverlayDriverError(reason: reason) }
private func check(_ condition: Bool, _ reason: OverlayDriverReason) throws { if !condition { try fail(reason) } }
private func canonical(_ path: String) throws -> String {
    guard path.utf8.count <= 32_768, path.hasPrefix("/"), !path.contains("\0"), let result = realpath(path, nil) else { try fail(.artifactInvalid) }
    defer { free(result) }; return String(cString: result)
}

private final class FileSeal {
    let path: String
    private var descriptor: Int32
    private let observed: stat
    init(_ path: String, expected: String? = nil) throws {
        if let expected { try check(OverlayDriverPolicy.hex(expected), .artifactInvalid) }
        self.path = try canonical(path)
        try check(self.path == path, .artifactInvalid)
        let fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { try fail(.artifactInvalid) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              info.st_mode & mode_t(S_ISUID | S_ISGID) == 0, info.st_size > 0, info.st_size <= 512 * 1024 * 1024 else {
            Darwin.close(fd); try fail(.artifactInvalid)
        }
        descriptor = fd; observed = info
        do {
            var hash = SHA256(), offset: off_t = 0
            var bytes = [UInt8](repeating: 0, count: 64 * 1024)
            while offset < info.st_size {
                let length = min(bytes.count, Int(info.st_size - offset))
                let received = pread(fd, &bytes, length, offset)
                if received < 0 && errno == EINTR { continue }
                try check(received > 0 && received <= length, .artifactInvalid)
                hash.update(data: Data(bytes.prefix(received))); offset += off_t(received)
            }
            let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
            try check((expected == nil || digest == expected) && current(), .artifactInvalid)
        } catch { Darwin.close(fd); descriptor = -1; throw error }
    }
    func current() -> Bool {
        var fd = stat(), name = stat()
        guard fstat(descriptor, &fd) == 0, lstat(path, &name) == 0 else { return false }
        return [fd, name].allSatisfy { value in
            value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && value.st_dev == observed.st_dev && value.st_ino == observed.st_ino &&
                value.st_size == observed.st_size && value.st_mtimespec.tv_sec == observed.st_mtimespec.tv_sec &&
                value.st_mtimespec.tv_nsec == observed.st_mtimespec.tv_nsec && value.st_ctimespec.tv_sec == observed.st_ctimespec.tv_sec &&
                value.st_ctimespec.tv_nsec == observed.st_ctimespec.tv_nsec
        }
    }
    deinit { if descriptor >= 0 { Darwin.close(descriptor) } }
}

private func signature(_ bundle: URL, identifier: String, own: Bool) throws {
    var code: SecStaticCode?, raw: CFDictionary?
    try check(SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, .artifactInvalid)
    guard let code else { try fail(.artifactInvalid) }
    try check(SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate).union(.noNetworkAccess), nil) == errSecSuccess &&
        SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &raw) == errSecSuccess, .artifactInvalid)
    guard let raw else { try fail(.artifactInvalid) }
    let fields = raw as NSDictionary
    guard let plist = fields[kSecCodeInfoPList] as? NSDictionary else { try fail(.artifactInvalid) }
    try check(fields[kSecCodeInfoIdentifier] as? String == identifier && plist["CFBundleIdentifier"] as? String == identifier, .artifactInvalid)
    if own {
        let flags = SecCodeSignatureFlags(rawValue: (fields[kSecCodeInfoFlags] as? NSNumber)?.uint32Value ?? 0)
        let entitlements = fields[kSecCodeInfoEntitlementsDict] as? NSDictionary
        try check(flags.contains(.runtime) && (entitlements == nil || entitlements?.count == 0) &&
            plist["CFBundleExecutable"] as? String == overlayDriverExecutable &&
            plist["VectorComputerSourceDigest"] as? String == OverlayDriverIdentity.sourceDigest, .artifactInvalid)
    } else {
        try check(plist["CFBundleExecutable"] as? String == "Electron" &&
            plist["CFBundleShortVersionString"] as? String == OverlayDriverIdentity.electronVersion, .artifactInvalid)
    }
}

private struct Artifacts {
    let executable: String, root: String, electron: String
    let seals: [FileSeal]
    init() throws {
        let bundle = try canonical(Bundle.main.bundleURL.path)
        let suffix = "/resources/computer/VectorComputerOverlayDriver.app"
        try check(bundle.hasSuffix(suffix) && OverlayDriverPolicy.hex(OverlayDriverIdentity.sourceDigest), .artifactInvalid)
        root = String(bundle.dropLast(suffix.count))
        let resolvedRoot = try canonical(root)
        try check(!root.isEmpty && resolvedRoot == root, .artifactInvalid)
        executable = bundle + "/Contents/MacOS/" + overlayDriverExecutable
        guard let current = HelperLifecycle.processIdentity(getpid()) else { try fail(.parentInvalid) }
        try check(current.executable == executable, .artifactInvalid)
        try signature(URL(fileURLWithPath: bundle), identifier: overlayDriverBundleID, own: true)
        let electronBundle = root + "/electron/Electron.app"
        electron = electronBundle + "/Contents/MacOS/Electron"
        try signature(URL(fileURLWithPath: electronBundle), identifier: "com.github.Electron", own: false)
        // The CI parent has already admitted this driver's exact executable hash from the
        // source-bound manifest. Hold its image and sealed plist across the same-image spawn.
        var files = [try FileSeal(executable), try FileSeal(bundle + "/Contents/Info.plist"),
            try FileSeal(electron, expected: OverlayDriverIdentity.electronSha256),
            try FileSeal(electronBundle + "/Contents/Info.plist"),
            try FileSeal(root + "/smoke/computer-overlay-smoke-electron.mjs", expected: OverlayDriverIdentity.mainSha256),
            try FileSeal(root + "/smoke/computer-overlay-smoke-preload.cjs", expected: OverlayDriverIdentity.preloadSha256),
            try FileSeal(electronBundle + "/Contents/Resources/default_app.asar", expected: OverlayDriverIdentity.defaultAppSha256)]
        if !OverlayDriverIdentity.fakeHelperSha256.isEmpty {
            files.append(try FileSeal(root + "/smoke/computer-fake-helper.mjs", expected: OverlayDriverIdentity.fakeHelperSha256))
        } else {
            var value = stat()
            try check(lstat(root + "/smoke/computer-fake-helper.mjs", &value) != 0 && errno == ENOENT, .artifactInvalid)
        }
        // Check signatures with the held file identities already established, then close the
        // signature/path race using the identity/ctime/mtime witnesses before any prerequisite skip.
        try signature(URL(fileURLWithPath: bundle), identifier: overlayDriverBundleID, own: true)
        try signature(URL(fileURLWithPath: electronBundle), identifier: "com.github.Electron", own: false)
        try check(files.allSatisfy { $0.current() }, .artifactInvalid)
        seals = files
    }
    func current() -> Bool { seals.allSatisfy { $0.current() } }
}

private struct Peer {
    let original: HelperProcessIdentity
    let supervisor: HelperProcessIdentity?
    let own: HelperProcessIdentity
    var start: String { "\(original.startSeconds):\(original.startMicroseconds)" }
    static func observe(_ options: OverlayDriverOptions) throws -> Peer {
        guard let own = HelperLifecycle.processIdentity(getpid()), let original = HelperLifecycle.processIdentity(options.parent),
              original.pid != own.pid, original.startSeconds < own.startSeconds ||
                (original.startSeconds == own.startSeconds && original.startMicroseconds <= own.startMicroseconds) else { try fail(.parentInvalid) }
        let supervisor: HelperProcessIdentity?
        if let expected = options.supervisor {
            guard getppid() == expected, let observed = HelperLifecycle.processIdentity(expected), observed.parentPID == original.pid,
                  observed.executable == own.executable, observed.startSeconds < own.startSeconds ||
                    (observed.startSeconds == own.startSeconds && observed.startMicroseconds <= own.startMicroseconds) else { try fail(.parentInvalid) }
            try check(original.startSeconds < observed.startSeconds ||
                (original.startSeconds == observed.startSeconds && original.startMicroseconds <= observed.startMicroseconds), .parentInvalid)
            supervisor = observed
        } else {
            try check(getppid() == original.pid && own.parentPID == original.pid, .parentInvalid); supervisor = nil
        }
        var details = proc_bsdinfo(); let count = Int32(MemoryLayout<proc_bsdinfo>.size)
        try check(getuid() > 0 && getuid() == geteuid() && proc_pidinfo(original.pid, PROC_PIDTBSDINFO, 0, &details, count) == count &&
            details.pbi_uid == geteuid() && details.pbi_ruid == getuid() && details.pbi_start_tvsec == original.startSeconds &&
            details.pbi_start_tvusec == original.startMicroseconds, .parentInvalid)
        return Peer(original: original, supervisor: supervisor, own: own)
    }
    func current() -> Bool {
        HelperLifecycle.processIdentity(original.pid) == original && HelperLifecycle.processIdentity(own.pid) == own &&
            (supervisor.map { HelperLifecycle.processIdentity($0.pid) == $0 } ?? true)
    }
}

private final class Lifetime {
    private let lock = NSLock()
    private var closed = false
    private var inputOwned = true
    private var source: CGEventSource?
    private var held = false
    private var point = CGPoint.zero
    private var timer: DispatchSourceTimer?
    private var eof: DispatchSourceTimer?
    private var watchers: HelperWorkerWatchers?
    init(peer: Peer) throws {
        let deadline = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "ai.vector.overlay-test.deadline"))
        deadline.schedule(deadline: .now() + .seconds(15)); deadline.setEventHandler { [weak self] in self?.terminate() }; deadline.resume(); timer = deadline
        watchers = try HelperLifecycle.installWorkerWatchers(parent: HelperParent(original: peer.original, supervisor: peer.supervisor)) { [weak self] in self?.terminate() }
        let input = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "ai.vector.overlay-test.eof"))
        input.schedule(deadline: .now(), repeating: .milliseconds(25))
        input.setEventHandler { [weak self] in
            guard let self, self.ownsInput else { return }
            var item = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            if poll(&item, 1, 0) > 0 && item.revents & Int16(POLLHUP | POLLERR | POLLNVAL) != 0 && self.ownsInput { self.terminate() }
        }
        input.resume(); eof = input
    }
    var live: Bool { lock.lock(); defer { lock.unlock() }; return !closed }
    private var ownsInput: Bool { lock.lock(); defer { lock.unlock() }; return !closed && inputOwned }
    func handOffInput() { lock.lock(); inputOwned = false; eof?.cancel(); eof = nil; lock.unlock() }
    private func requireClearPhysicalState() throws {
        let modifiers: CGEventFlags = [.maskCommand, .maskControl, .maskShift, .maskAlternate, .maskSecondaryFn]
        try check(CGEventSource.flagsState(.hidSystemState).intersection(modifiers).isEmpty &&
            !CGEventSource.buttonState(.hidSystemState, button: .left) && !CGEventSource.buttonState(.hidSystemState, button: .right) &&
            !CGEventSource.buttonState(.hidSystemState, button: .center), .sourceUnavailable)
    }
    func postClick(_ point: CGPoint, authorize: () throws -> Void) throws {
        try requireClearPhysicalState()
        guard let source = CGEventSource(stateID: .privateState) else { try fail(.sourceUnavailable) }
        source.userData = overlayDriverTag; source.localEventsSuppressionInterval = 0
        guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
              let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { try fail(.sourceUnavailable) }
        for event in [move, down, up] { event.flags = []; event.setIntegerValueField(.eventSourceUserData, value: overlayDriverTag); event.setIntegerValueField(.mouseEventClickState, value: 1) }
        // Provider work never owns the lifecycle lock. Revocation can win while AX is blocked.
        try authorize()
        try requireClearPhysicalState()
        lock.lock()
        guard !closed && !held else { lock.unlock(); try fail(.deadlineExceeded) }
        self.source = source; self.point = point; move.post(tap: .cghidEventTap); lock.unlock()
        // Repeat the native proof after the only hover effect, preserving its original finite age.
        try authorize()
        try requireClearPhysicalState()
        lock.lock(); defer { lock.unlock() }
        try check(!closed && !held, .deadlineExceeded)
        held = true; down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap); held = false; self.source = nil
    }
    func close() {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true; inputOwned = false
        if held, let source, let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
            up.flags = []; up.setIntegerValueField(.eventSourceUserData, value: overlayDriverTag); up.setIntegerValueField(.mouseEventClickState, value: 1); up.post(tap: .cghidEventTap)
        }
        held = false; source = nil
        let active = watchers; watchers = nil
        timer?.cancel(); timer = nil; eof?.cancel(); eof = nil; lock.unlock()
        active?.finish()
    }
    private func terminate() {
        if lock.try() {
            let expired = !closed; lock.unlock()
            if !expired { return }
        }
        // The hard fuse is independent of a possibly stalled WindowServer call holding the source lock.
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(250)) { _exit(1) }
        close(); _exit(1)
    }
    deinit { close() }
}

private final class Channel {
    private let descriptor: Int32
    private let writer: FrameWriter
    init() throws {
        try check(HelperLifecycle.protocolDescriptorIsValid(STDIN_FILENO) && HelperLifecycle.protocolDescriptorIsValid(STDOUT_FILENO), .requestInvalid)
        let copied = fcntl(STDOUT_FILENO, F_DUPFD_CLOEXEC, 3)
        guard copied >= 3 else { try fail(.requestInvalid) }
        guard fcntl(copied, F_SETFL, fcntl(copied, F_GETFL) | O_NONBLOCK) == 0 &&
              fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK) == 0 else { Darwin.close(copied); try fail(.requestInvalid) }
        descriptor = copied; writer = FrameWriter(descriptor: copied, writeTimeoutMs: 50)
    }
    func send(_ value: JSONValue) throws {
        let bytes = try JSONEncoder().encode(value)
        try check(bytes.count <= overlayDriverFrameLimit, .requestInvalid)
        try writer.write(Response(value: value))
    }
    func read(lifetime: Lifetime) throws -> JSONValue {
        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        var bytes = Data(), expected: Int? = nil
        while lifetime.live && DispatchTime.now().uptimeNanoseconds < deadline {
            var poller = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            let status = poll(&poller, 1, 20)
            if status < 0 && errno == EINTR { continue }
            try check(status >= 0 && poller.revents & Int16(POLLHUP | POLLERR | POLLNVAL) == 0, .requestInvalid)
            if status == 0 { continue }
            var chunk = [UInt8](repeating: 0, count: 4096)
            let read = Darwin.read(STDIN_FILENO, &chunk, chunk.count)
            if read < 0 && (errno == EAGAIN || errno == EINTR) { continue }
            try check(read > 0 && bytes.count <= overlayDriverFrameLimit + 4 - read, .requestInvalid)
            bytes.append(contentsOf: chunk.prefix(read))
            if expected == nil && bytes.count >= 4 { expected = bytes.prefix(4).reduce(0) { ($0 << 8) | Int($1) }; try check((1...overlayDriverFrameLimit).contains(expected ?? 0), .requestInvalid) }
            if let expected, bytes.count >= expected + 4 {
                try check(bytes.count == expected + 4, .requestInvalid)
                return try JSONDecoder().decode(JSONValue.self, from: bytes.dropFirst(4))
            }
        }
        try fail(.deadlineExceeded)
    }
    deinit { Darwin.close(descriptor) }
}

private struct WindowFact: Equatable {
    let id: CGWindowID, pid: pid_t, bounds: OverlayDriverRect, title: String, layer: Int, alpha: Double
    static func observe() throws -> [WindowFact] {
        guard let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]], rows.count <= 4096 else { try fail(.windowChanged) }
        return try rows.compactMap { row in
            guard let id = row[kCGWindowNumber as String] as? NSNumber, let pid = row[kCGWindowOwnerPID as String] as? NSNumber,
                  let raw = row[kCGWindowBounds as String] as? [String: Any], let rectangle = CGRect(dictionaryRepresentation: raw as CFDictionary),
                  let layer = row[kCGWindowLayer as String] as? NSNumber, let alpha = row[kCGWindowAlpha as String] as? NSNumber else { try fail(.windowChanged) }
            let bounds = OverlayDriverRect(rectangle)
            if bounds.w == 0 || bounds.h == 0 || alpha.doubleValue == 0 { return nil }
            try check(id.uint64Value > 0 && id.uint64Value <= UInt64(UInt32.max) && pid.int64Value > 1 && pid.int64Value <= Int64(Int32.max) &&
                bounds.valid && alpha.doubleValue.isFinite && alpha.doubleValue > 0 && alpha.doubleValue <= 1, .windowChanged)
            return WindowFact(id: id.uint32Value, pid: pid.int32Value, bounds: bounds, title: row[kCGWindowName as String] as? String ?? "", layer: layer.intValue, alpha: alpha.doubleValue)
        }
    }
}

private struct ButtonFact {
    let element: AXUIElement, window: AXUIElement, bounds: OverlayDriverRect
    static func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef {
        var value: CFTypeRef?
        try check(AXUIElementSetMessagingTimeout(element, 0.02) == .success && AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, .buttonUnavailable)
        guard let value else { try fail(.buttonUnavailable) }; return value
    }
    static func string(_ element: AXUIElement, _ name: String) throws -> String {
        let value = try attribute(element, name)
        try check(CFGetTypeID(value) == CFStringGetTypeID(), .buttonUnavailable)
        guard let result = value as? String, result.utf16.count <= 128 else { try fail(.buttonUnavailable) }; return result
    }
    static func attributes(_ element: AXUIElement, _ names: [String]) throws -> [CFTypeRef] {
        var raw: CFArray?
        try check(AXUIElementSetMessagingTimeout(element, 0.02) == .success &&
            AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &raw) == .success, .buttonUnavailable)
        guard let values = raw as? [AnyObject], values.count == names.count else { try fail(.buttonUnavailable) }
        return values.map { $0 as CFTypeRef }
    }
    static func rectangle(_ position: CFTypeRef, _ size: CFTypeRef) throws -> OverlayDriverRect {
        try check(CFGetTypeID(position) == AXValueGetTypeID() && CFGetTypeID(size) == AXValueGetTypeID(), .buttonUnavailable)
        let p = position as! AXValue, s = size as! AXValue
        try check(AXValueGetType(p) == .cgPoint && AXValueGetType(s) == .cgSize, .buttonUnavailable)
        var point = CGPoint.zero, extent = CGSize.zero
        try check(AXValueGetValue(p, .cgPoint, &point) && AXValueGetValue(s, .cgSize, &extent), .buttonUnavailable)
        let result = OverlayDriverRect(CGRect(origin: point, size: extent)); try check(result.valid, .buttonUnavailable); return result
    }
    static func observe(_ request: OverlayDriverRequest) throws -> ButtonFact {
        let app = AXUIElementCreateApplication(request.parent); try check(AXUIElementSetMessagingTimeout(app, 0.02) == .success, .buttonUnavailable)
        var hit: AXUIElement?
        try check(AXUIElementCopyElementAtPosition(app, Float(request.stop.center.x), Float(request.stop.center.y), &hit) == .success, .buttonUnavailable)
        guard var element = hit else { try fail(.buttonUnavailable) }
        for _ in 0..<8 {
            var owner: pid_t = 0; try check(AXUIElementGetPid(element, &owner) == .success && owner == request.parent, .buttonUnavailable)
            let role = try string(element, kAXRoleAttribute)
            if role == kAXButtonRole { break }
            let raw = try attribute(element, kAXParentAttribute); try check(CFGetTypeID(raw) == AXUIElementGetTypeID(), .buttonUnavailable); element = raw as! AXUIElement
        }
        let values = try attributes(element, [kAXRoleAttribute, kAXTitleAttribute, kAXEnabledAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXWindowAttribute])
        try check(CFGetTypeID(values[0]) == CFStringGetTypeID() && CFGetTypeID(values[1]) == CFStringGetTypeID() &&
            values[0] as? String == kAXButtonRole && values[1] as? String == "Stop", .buttonUnavailable)
        let enabled = values[2]; try check(CFGetTypeID(enabled) == CFBooleanGetTypeID() && CFBooleanGetValue(enabled as! CFBoolean), .buttonUnavailable)
        let bounds = try rectangle(values[3], values[4])
        try check(request.bounds.contains(bounds) && request.stop.matchesHint(bounds), .buttonUnavailable)
        let raw = values[5]; try check(CFGetTypeID(raw) == AXUIElementGetTypeID(), .buttonUnavailable)
        let window = raw as! AXUIElement
        let frame = try attributes(window, [kAXRoleAttribute, kAXTitleAttribute, kAXPositionAttribute, kAXSizeAttribute])
        let windowBounds = try rectangle(frame[2], frame[3])
        try check(CFGetTypeID(frame[0]) == CFStringGetTypeID() && CFGetTypeID(frame[1]) == CFStringGetTypeID() &&
            frame[0] as? String == kAXWindowRole && frame[1] as? String == request.title && windowBounds == request.bounds, .buttonUnavailable)
        return ButtonFact(element: element, window: window, bounds: bounds)
    }
    func same(_ other: ButtonFact) -> Bool { CFEqual(element, other.element) && CFEqual(window, other.window) && bounds == other.bounds }
}

private func nativeScope(_ request: OverlayDriverRequest, peer: Peer, artifacts: Artifacts) throws -> [WindowFact] {
    try check(peer.current() && artifacts.current() && NSWorkspace.shared.frontmostApplication?.processIdentifier == request.parent &&
        WatchdogBackend.system.sample().availability == .available, .windowChanged)
    let windows = try WindowFact.observe(), point = request.stop.center
    let candidates = windows.filter { $0.bounds.cg.contains(point) }
    guard let first = candidates.first, first.id == request.banner, first.pid == request.parent, first.title == request.title,
          first.bounds == request.bounds, first.layer == CGWindowLevelForKey(.screenSaverWindow), first.alpha == 1,
          let underlay = candidates.dropFirst().first, underlay.pid == request.parent, underlay.layer == CGWindowLevelForKey(.normalWindow),
          underlay.title == "Vector computer smoke underlay " + request.nonce, underlay.bounds.contains(request.stop) else { try fail(.windowChanged) }
    return windows
}

private func awaitNative<T>(_ start: (@escaping (Result<T, ServerFailure>) -> Void) -> Void) throws -> T {
    let finished = DispatchSemaphore(value: 0), lock = NSLock()
    var result: Result<T, ServerFailure>?
    start { value in lock.lock(); if result == nil { result = value }; lock.unlock(); finished.signal() }
    try check(finished.wait(timeout: .now() + .seconds(4)) == .success, .deadlineExceeded)
    lock.lock(); let received = result; lock.unlock()
    guard let received, case .success(let value) = received else { try fail(.captureFailed) }; return value
}

private func edgeCount(_ image: CGImage, display: CaptureDisplayInfo) throws -> Int {
    try check(image.width > 0 && image.height > 0 && image.width * image.height <= 2_000_000, .captureFailed)
    let stride = image.width * 4
    var bytes = [UInt8](repeating: 0, count: stride * image.height)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: stride,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height)); return true
    }
    try check(drawn, .captureFailed)
    let thickness = max(1, Int((4 * Double(image.width) / Double(display.bounds.width)).rounded(.up)))
    var count = 0
    for y in 0..<image.height {
        for x in 0..<image.width where x < thickness || y < thickness || x >= image.width - thickness || y >= image.height - thickness {
            let index = y * stride + x * 4
            if OverlayDriverPolicy.violet(bytes[index], bytes[index + 1], bytes[index + 2]) { count += 1 }
        }
    }
    return count
}

private func captureProof(_ request: OverlayDriverRequest, peer: Peer, artifacts: Artifacts, lifetime: Lifetime) throws -> OverlayDriverOutcome {
    if request.glows.isEmpty { return .skip(.targetUnavailable) }
    try check(lifetime.live, .deadlineExceeded)
    let inventory: CaptureInventory = try awaitNative(CaptureService.nativeContent)
    let owned = inventory.windows.filter { $0.pid == peer.original.pid && $0.onScreen && $0.alpha > 0 }
    let glows = owned.filter { request.glows.contains(CGWindowID($0.windowID) ?? 0) }
    try check(glows.count == request.glows.count && glows.allSatisfy { $0.sourceAvailable && $0.layer == CGWindowLevelForKey(.screenSaverWindow) }, .windowChanged)
    var expected = inventory.displays.flatMap { OverlayDriverPolicy.strips(OverlayDriverRect($0.bounds)) }
    for glow in glows {
        guard let index = expected.firstIndex(of: OverlayDriverRect(glow.bounds)) else { try fail(.windowChanged) }; expected.remove(at: index)
    }
    try check(expected.isEmpty && !inventory.displays.isEmpty && owned.allSatisfy { $0.sourceAvailable }, .windowChanged)
    guard let display = inventory.displays.max(by: { $0.bounds.intersection(request.bounds.cg).area < $1.bounds.intersection(request.bounds.cg).area }),
          OverlayDriverRect(display.bounds).contains(request.stop), let scale = display.captureScale,
          scale.isFinite && scale > 0 else { try fail(.captureFailed) }
    let fit = min(1.0, min(1280.0 / Double(display.bounds.width), 800.0 / Double(display.bounds.height)))
    let width = max(1, Int((Double(display.bounds.width) * fit).rounded())), height = max(1, Int((Double(display.bounds.height) * fit).rounded()))
    func image(_ ids: [String]) throws -> CGImage {
        try check(lifetime.live && peer.current() && artifacts.current() && CGPreflightScreenCaptureAccess(), .windowChanged)
        let selection = CaptureImageRequest(inventory: inventory, displayID: display.id, windowID: nil, includedWindowIDs: ids,
            bounds: display.bounds, width: width, height: height, captureScale: scale, imageScale: fit)
        return try awaitNative { CaptureService.nativeScreenshot(selection, $0) }
    }
    let all = owned.map { $0.windowID }, removed = Set(request.glows.map(String.init))
    let included = try image(all), excluded = try image(all.filter { !removed.contains($0) })
    let afterWindows = try nativeScope(request, peer: peer, artifacts: artifacts)
    for glow in glows {
        guard let id = CGWindowID(glow.windowID), let current = afterWindows.first(where: { $0.id == id }),
              current.pid == peer.original.pid, current.bounds == OverlayDriverRect(glow.bounds),
              current.layer == glow.layer, current.alpha == glow.alpha else { try fail(.windowChanged) }
    }
    let before = try edgeCount(included, display: display), after = try edgeCount(excluded, display: display)
    try check(lifetime.live && before >= 8 && after == 0, .assertionFailed)
    return OverlayDriverOutcome(ok: true)
}

private func runWorker(_ options: OverlayDriverOptions, peer: Peer, artifacts: Artifacts, lifetime: Lifetime, channel: Channel) throws -> OverlayDriverResult {
    try check(peer.original.executable == artifacts.electron && peer.current() && artifacts.current(), .parentInvalid)
    if ProcessInfo.processInfo.environment["VECTOR_COMPUTER_TEST_ISOLATED"] != "1" { return OverlayDriverResult(stop: .skip(.isolationRequired), capture: .skip(.isolationRequired)) }
    if !HelperLifecycle.isSelfResponsible() { return OverlayDriverResult(stop: .skip(.responsibilityMissing), capture: .skip(.responsibilityMissing)) }
    if WatchdogBackend.system.sample().availability != .available { return OverlayDriverResult(stop: .skip(.desktopUnavailable), capture: .skip(.desktopUnavailable)) }
    if !CGPreflightScreenCaptureAccess() { return OverlayDriverResult(stop: .skip(.screenDenied), capture: .skip(.screenDenied)) }
    if !AXIsProcessTrusted() { return OverlayDriverResult(stop: .skip(.accessibilityDenied), capture: .skip(.accessibilityDenied)) }
    if !CGPreflightPostEventAccess() { return OverlayDriverResult(stop: .skip(.postEventDenied), capture: .skip(.postEventDenied)) }
    try channel.send(.object(["id": .integer(0), "ok": .bool(true), "protocol": .integer(1), "ready": .bool(true), "nonce": .string(options.nonce),
        "parentPID": .integer(Int64(options.parent)), "parentCreationTime": .string(peer.start), "sourceDigest": .string(OverlayDriverIdentity.sourceDigest)]))
    guard let request = OverlayDriverRequest.decode(try channel.read(lifetime: lifetime), options: options, start: peer.start, source: OverlayDriverIdentity.sourceDigest) else { try fail(.requestInvalid) }
    _ = try nativeScope(request, peer: peer, artifacts: artifacts)
    let captured: OverlayDriverOutcome
    do { captured = try captureProof(request, peer: peer, artifacts: artifacts, lifetime: lifetime) }
    catch let failure as OverlayDriverError {
        let rejected = OverlayDriverOutcome(ok: false, reason: failure.reason)
        return OverlayDriverResult(stop: rejected, capture: rejected)
    } catch {
        let rejected = OverlayDriverOutcome(ok: false, reason: .captureFailed)
        return OverlayDriverResult(stop: rejected, capture: rejected)
    }
    let prepared = DispatchTime.now().uptimeNanoseconds
    let button = try ButtonFact.observe(request)
    try check(DispatchTime.now().uptimeNanoseconds - prepared < 50_000_000, .buttonUnavailable)
    try lifetime.postClick(button.bounds.center) {
        try check(lifetime.live && AXIsProcessTrusted() && CGPreflightPostEventAccess(), .postEventDenied)
        _ = try nativeScope(request, peer: peer, artifacts: artifacts)
        let current = try ButtonFact.observe(request)
        try check(button.same(current) && DispatchTime.now().uptimeNanoseconds - prepared < 50_000_000, .buttonUnavailable)
    }
    return OverlayDriverResult(stop: OverlayDriverOutcome(ok: true), capture: captured)
}

private func supervise(_ options: OverlayDriverOptions, peer: Peer, artifacts: Artifacts, lifetime: Lifetime) throws -> Int32 {
    try check(!options.worker && getppid() == options.parent && peer.original.executable == artifacts.electron && artifacts.current(), .parentInvalid)
    try check(HelperLifecycle.protocolDescriptorIsValid(STDIN_FILENO) && HelperLifecycle.protocolDescriptorIsValid(STDOUT_FILENO), .requestInvalid)
    var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
    try check(posix_spawn_file_actions_init(&actions) == 0, .sourceUnavailable)
    defer { posix_spawn_file_actions_destroy(&actions) }
    try check(posix_spawnattr_init(&attributes) == 0, .sourceUnavailable)
    defer { posix_spawnattr_destroy(&attributes) }
    var defaults = sigset_t(), mask = sigset_t(); sigfillset(&defaults); sigemptyset(&mask)
    try check(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)) == 0 &&
        posix_spawnattr_setsigdefault(&attributes, &defaults) == 0 && posix_spawnattr_setsigmask(&attributes, &mask) == 0, .sourceUnavailable)
    if !HelperLifecycle.disclaimSpawn(&attributes) {
        let result = OverlayDriverResult(stop: .skip(.responsibilityMissing), capture: .skip(.responsibilityMissing)), channel = try Channel()
        lifetime.close(); try channel.send(result.wire); return result.exitCode
    }
    try check(posix_spawn_file_actions_addinherit_np(&actions, STDIN_FILENO) == 0 && posix_spawn_file_actions_addinherit_np(&actions, STDOUT_FILENO) == 0 &&
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0, .requestInvalid)
    let args = [artifacts.executable, "--overlay-worker", "--parent-pid", String(options.parent), "--supervisor-pid", String(getpid()), "--nonce", options.nonce]
    let environment = ["PATH=/usr/bin:/bin", "VECTOR_COMPUTER_TEST_ISOLATED=" + (ProcessInfo.processInfo.environment["VECTOR_COMPUTER_TEST_ISOLATED"] == "1" ? "1" : "0")]
    let allocated = (args + environment).map { strdup($0) }; defer { allocated.forEach { free($0) } }
    try check(allocated.allSatisfy { $0 != nil }, .sourceUnavailable)
    var argv = Array(allocated.prefix(args.count)) + [nil], envp = Array(allocated.dropFirst(args.count)) + [nil], child: pid_t = 0
    try check(lifetime.live && peer.current() && artifacts.current() && posix_spawn(&child, artifacts.executable, &actions, &attributes, &argv, &envp) == 0 && child > 1, .sourceUnavailable)
    lifetime.handOffInput(); Darwin.close(STDIN_FILENO); Darwin.close(STDOUT_FILENO)
    while lifetime.live {
        var status: Int32 = 0; let exited = waitpid(child, &status, WNOHANG)
        if exited == child { return HelperLifecycle.exitCode(waitStatus: status) }
        if exited < 0 && errno != EINTR { return 1 }
        usleep(10_000)
    }
    // Only this unreaped child is signalled, so its PID cannot have been reused.
    kill(child, SIGTERM); let deadline = DispatchTime.now().uptimeNanoseconds + 750_000_000
    while DispatchTime.now().uptimeNanoseconds < deadline { var status: Int32 = 0; if waitpid(child, &status, WNOHANG) == child { return 1 }; usleep(10_000) }
    kill(child, SIGKILL); var status: Int32 = 0; _ = waitpid(child, &status, 0); return 1
}

private extension CGRect { var area: CGFloat { isNull || isEmpty ? 0 : width * height } }

private func entry(_ options: OverlayDriverOptions) -> Int32 {
    var channel: Channel?, lifetime: Lifetime?
    do {
        let peer = try Peer.observe(options); lifetime = try Lifetime(peer: peer)
        guard let lifetime else { return 1 }
        let artifacts = try Artifacts()
        try check(peer.original.executable == artifacts.electron && artifacts.current() && peer.current(), .parentInvalid)
        if !options.worker { return try supervise(options, peer: peer, artifacts: artifacts, lifetime: lifetime) }
        channel = try Channel()
        guard let channel else { return 1 }
        let result = try runWorker(options, peer: peer, artifacts: artifacts, lifetime: lifetime, channel: channel)
        lifetime.close(); try channel.send(result.wire); return result.exitCode
    } catch let error as OverlayDriverError {
        lifetime?.close(); let result = OverlayDriverResult(stop: OverlayDriverOutcome(ok: false, reason: error.reason))
        if channel == nil { channel = try? Channel() }; try? channel?.send(result.wire); return 1
    } catch {
        lifetime?.close(); let result = OverlayDriverResult(stop: OverlayDriverOutcome(ok: false, reason: .assertionFailed))
        if channel == nil { channel = try? Channel() }; try? channel?.send(result.wire); return 1
    }
}

signal(SIGPIPE, SIG_IGN)
guard let options = OverlayDriverOptions.parse(Array(CommandLine.arguments.dropFirst())) else { exit(2) }
_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
DispatchQueue.global(qos: .userInitiated).async { exit(entry(options)) }
NSApp.run()
