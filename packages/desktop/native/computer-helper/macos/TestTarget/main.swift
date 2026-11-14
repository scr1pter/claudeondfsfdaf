import AppKit
import CoreGraphics
import CryptoKit
import Darwin
import Dispatch
import Foundation

private let targetBundleID = "ai.vector.computer.test-target"
private let targetExecutable = "VectorComputerTestTarget"
private let targetFrameLimit = 16 * 1024
private let targetForeignTag: Int64 = 0x5654435446474553
private enum TargetFailure: Error { case invalid }
// Private startup diagnostics: only these fixed stages cross the parent boundary, never exception text.
private enum TargetExit: Int32 {
    case options = 20, bundle = 21, control = 22, application = 23, state = 24, output = 25, encoding = 26, notReady = 27
}

private func targetHex(_ value: String, count: Int) -> Bool {
    value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

private struct TargetOptions {
    let nonce: String
    let artifact: String
    let parent: pid_t
    let isolated: Bool

    static func parse(_ args: [String]) throws -> TargetOptions {
        var fields: [String: String] = [:]
        var isolated = false, index = 0
        while index < args.count {
            let key = args[index]
            if key == "--isolated" {
                guard !isolated else { throw TargetFailure.invalid }
                isolated = true; index += 1; continue
            }
            guard ["--nonce", "--artifact", "--parent-pid"].contains(key), fields[key] == nil,
                  index + 1 < args.count else { throw TargetFailure.invalid }
            fields[key] = args[index + 1]; index += 2
        }
        guard fields.count == 3, let nonce = fields["--nonce"], targetHex(nonce, count: 32),
              let artifact = fields["--artifact"], targetHex(artifact, count: 64),
              let raw = fields["--parent-pid"], raw.utf8.allSatisfy({ (48...57).contains($0) }),
              let parent = Int32(raw), parent > 1, String(parent) == raw else { throw TargetFailure.invalid }
        return TargetOptions(nonce: nonce, artifact: artifact, parent: parent, isolated: isolated)
    }
}

private indirect enum TargetValue: Decodable {
    case bool(Bool), integer(Int64), string(String), object([String: TargetValue]), array([TargetValue]), null
    init(from decoder: Decoder) throws {
        guard decoder.codingPath.count <= 8 else { throw TargetFailure.invalid }
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(Int64.self) { self = .integer(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode([TargetValue].self) { self = .array(item) }
        else { self = .object(try value.decode([String: TargetValue].self)) }
    }
    var stringValue: String? { if case .string(let value) = self { return value }; return nil }
    var integerValue: Int? { if case .integer(let value) = self { return Int(exactly: value) }; return nil }
    var boolValue: Bool? { if case .bool(let value) = self { return value }; return nil }
}

private enum TargetOperation {
    case state, reset, focus(String), move(Int, Int), foreground(Bool), foreignEsc, quit, prepareText(String)
}

private struct TargetCommand {
    let id: Int
    let operation: TargetOperation

    static func parse(_ bytes: Data, nonce: String) throws -> TargetCommand {
        guard !bytes.isEmpty, bytes.count <= targetFrameLimit,
              case .object(let fields) = try JSONDecoder().decode(TargetValue.self, from: bytes),
              let id = fields["id"]?.integerValue, (1...9_007_199_254_740_991).contains(id),
              let supplied = fields["nonce"]?.stringValue, supplied.utf8.elementsEqual(nonce.utf8),
              let op = fields["op"]?.stringValue else { throw TargetFailure.invalid }
        let base: Set<String> = ["id", "nonce", "op"]
        let keys = Set(fields.keys)
        let operation: TargetOperation
        switch op {
        case "state", "reset", "foreignEsc", "quit":
            guard keys == base else { throw TargetFailure.invalid }
            operation = op == "state" ? .state : op == "reset" ? .reset : op == "foreignEsc" ? .foreignEsc : .quit
        case "focus":
            guard keys == base.union(["field"]), let field = fields["field"]?.stringValue,
                  ["text", "secure", "button", "none"].contains(field) else { throw TargetFailure.invalid }
            operation = .focus(field)
        case "move":
            guard keys == base.union(["dx", "dy"]), let dx = fields["dx"]?.integerValue, let dy = fields["dy"]?.integerValue,
                  (-2000...2000).contains(dx), (-2000...2000).contains(dy), dx != 0 || dy != 0 else { throw TargetFailure.invalid }
            operation = .move(dx, dy)
        case "foreground":
            guard keys == base.union(["active"]), let active = fields["active"]?.boolValue else { throw TargetFailure.invalid }
            operation = .foreground(active)
        case "prepareText":
            guard keys == base.union(["preset"]), let preset = fields["preset"]?.stringValue,
                  ["append", "replace", "unicode"].contains(preset) else { throw TargetFailure.invalid }
            operation = .prepareText(preset)
        default: throw TargetFailure.invalid
        }
        return TargetCommand(id: id, operation: operation)
    }
}

private struct TargetRect: Encodable, Equatable {
    let x: Double, y: Double, w: Double, h: Double
    init(_ value: CGRect) { x = Double(value.minX); y = Double(value.minY); w = Double(value.width); h = Double(value.height) }
    var valid: Bool { x.isFinite && y.isFinite && w.isFinite && h.isFinite && w > 0 && h > 0 }
    func contains(_ value: TargetRect) -> Bool {
        valid && value.valid && value.x >= x && value.y >= y && value.x + value.w <= x + w && value.y + value.h <= y + h
    }
}
private struct TargetSelection: Encodable { let location: Int, length: Int }
private struct TargetText: Encodable {
    let length: Int
    let sha256: String
    let selection: TargetSelection?
    var valid: Bool {
        (0...4000).contains(length) && targetHex(sha256, count: 64) &&
            (selection.map { $0.location >= 0 && $0.length >= 0 && $0.location <= length && $0.length <= length - $0.location } ?? true)
    }
}
private struct TargetView: Encodable { let identifier: String; let bounds: TargetRect? }
private func targetGeometryReady(_ main: TargetRect?, _ backdrop: TargetRect?, _ views: [String: TargetView]) -> Bool {
    guard let main, let backdrop, main != backdrop, backdrop.contains(main),
          Set(views.keys) == ["patch", "button", "text", "secure"] else { return false }
    return views.values.allSatisfy { view in
        guard let bounds = view.bounds else { return false }; return main.contains(bounds)
    }
}
private struct TargetEvents: Encodable {
    var keyDowns = 0, keyUps = 0, buttonDowns = 0, buttonUps = 0, heldKeys = 0, heldButtons = 0, escapes = 0
    var valid: Bool { [keyDowns, keyUps, buttonDowns, buttonUps, escapes].allSatisfy { (0...1_000_000).contains($0) } &&
        (0...128).contains(heldKeys) && (0...8).contains(heldButtons) }
}
private struct TargetForeignEsc: Encodable { let status: String; let pid: Int; let tag: String }
private struct TargetState: Encodable {
    let pid: Int, parentPID: Int
    let bundleID: String, bundlePath: String, executablePath: String, sourceDigest: String
    let ready: Bool, windowNumber: Int, backdropWindowNumber: Int
    let windowBounds: TargetRect?, backdropBounds: TargetRect?
    let views: [String: TargetView]
    let patchRGB: [Int], backdropRGB: [Int]
    let counter: Int, text: TargetText, secure: TargetText
    let visible: Bool, minimized: Bool, foreground: Bool, postEvent: Bool
    let events: TargetEvents, foreignEsc: TargetForeignEsc

    var valid: Bool {
        pid > 1 && parentPID > 1 && bundleID == targetBundleID && targetHex(sourceDigest, count: 64) &&
            bundlePath.hasSuffix("/VectorComputerTestTarget.app") && executablePath == bundlePath + "/Contents/MacOS/" + targetExecutable &&
            windowNumber > 0 && backdropWindowNumber > 0 && windowNumber != backdropWindowNumber &&
            Set(views.keys) == ["patch", "button", "text", "secure"] &&
            views.allSatisfy { $0.value.identifier == "fixture." + $0.key && ($0.value.bounds?.valid ?? !ready) } &&
            (!ready || targetGeometryReady(windowBounds, backdropBounds, views)) &&
            patchRGB == [32, 128, 192] && backdropRGB == [224, 96, 32] &&
            (0...1_000_000).contains(counter) && text.valid && secure.valid && events.valid &&
            ["idle", "posted", "not_granted", "not_foreground", "not_isolated", "failed"].contains(foreignEsc.status) &&
            foreignEsc.pid == pid && foreignEsc.tag == String(targetForeignTag, radix: 16)
    }
}
private struct TargetReply: Encodable { let id: Int, nonce: String, ok: Bool; let code: String?; let state: TargetState? }

/// Only private pipe frames are emitted. No field can encode typed text, event characters or screenshot bytes.
private final class TargetChannel {
    let options: TargetOptions
    private let lock = NSLock()
    private var pending = 0, pendingBytes = 0
    private var pendingIDs: [Int: Int] = [:]
    private let writer = DispatchSemaphore(value: 1)
    private var parentWatch: DispatchSourceProcess?
    private var timer: DispatchSourceTimer?
    private let started = DispatchTime.now().uptimeNanoseconds

    init(_ options: TargetOptions) throws {
        self.options = options
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(), getppid() == options.parent else { throw TargetFailure.invalid }
        for descriptor in [STDIN_FILENO, STDOUT_FILENO] {
            var info = stat()
            guard fstat(descriptor, &info) == 0, isatty(descriptor) == 0,
                  info.st_mode & S_IFMT == S_IFIFO || info.st_mode & S_IFMT == S_IFSOCK else { throw TargetFailure.invalid }
        }
        let flags = fcntl(STDOUT_FILENO, F_GETFL)
        guard flags >= 0, fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else { throw TargetFailure.invalid }
        signal(SIGPIPE, SIG_IGN)
    }

    func start(_ receive: @escaping (TargetCommand) -> Void) {
        let queue = DispatchQueue(label: "ai.vector.computer.test-target.control")
        let parent = DispatchSource.makeProcessSource(identifier: options.parent, eventMask: .exit, queue: queue)
        parent.setEventHandler { _exit(0) }; parent.resume(); parentWatch = parent
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        timer.setEventHandler { [self] in
            if getppid() != options.parent || DispatchTime.now().uptimeNanoseconds - started > 180_000_000_000 { _exit(0) }
        }
        timer.resume(); self.timer = timer
        guard getppid() == options.parent else { _exit(0) }
        DispatchQueue(label: "ai.vector.computer.test-target.reader").async { [self] in
            var buffered = Data(), bytes = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = bytes.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
                if count < 0 { if errno == EINTR { continue }; _exit(1) }
                if count == 0 { _exit(buffered.isEmpty ? 0 : 1) }
                buffered.append(contentsOf: bytes.prefix(count))
                while let newline = buffered.firstIndex(of: 10) {
                    let frame = Data(buffered[..<newline]); buffered.removeSubrange(...newline)
                    guard let command = try? TargetCommand.parse(frame, nonce: options.nonce) else { _exit(1) }
                    let cost = frame.count + 1
                    lock.lock()
                    guard pending < 8, pendingIDs[command.id] == nil, cost <= 2 * targetFrameLimit - pendingBytes else { lock.unlock(); _exit(1) }
                    pending += 1; pendingBytes += cost; pendingIDs[command.id] = cost; lock.unlock()
                    DispatchQueue.main.async { [self] in
                        guard getppid() == options.parent else { _exit(0) }
                        receive(command)
                    }
                }
                guard buffered.count <= targetFrameLimit else { _exit(1) }
            }
        }
    }

    func reply(id: Int, state: TargetState?, code: String? = nil) {
        guard getppid() == options.parent else { _exit(0) }
        guard state?.valid ?? true else { _exit(TargetExit.state.rawValue) }
        let deadline = DispatchTime.now().uptimeNanoseconds + 50_000_000
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard var bytes = try? encoder.encode(TargetReply(id: id, nonce: options.nonce, ok: code == nil, code: code, state: state)),
              bytes.count < targetFrameLimit else { _exit(TargetExit.encoding.rawValue) }
        bytes.append(10)
        guard writer.wait(timeout: DispatchTime(uptimeNanoseconds: deadline)) == .success else { _exit(TargetExit.output.rawValue) }
        defer { writer.signal() }
        bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let now = DispatchTime.now().uptimeNanoseconds
                guard now < deadline else { _exit(TargetExit.output.rawValue) }
                let written = Darwin.write(STDOUT_FILENO, raw.baseAddress?.advanced(by: offset), raw.count - offset)
                if written > 0 {
                    offset += written
                    guard DispatchTime.now().uptimeNanoseconds < deadline else { _exit(TargetExit.output.rawValue) }
                    continue
                }
                if written < 0 && errno == EINTR { continue }
                guard written < 0, errno == EAGAIN || errno == EWOULDBLOCK else { _exit(TargetExit.output.rawValue) }
                var item = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
                let remaining = Int32(max(1, (deadline - now + 999_999) / 1_000_000))
                guard poll(&item, 1, remaining) > 0, item.revents & Int16(POLLOUT) != 0,
                      item.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0 else { _exit(TargetExit.output.rawValue) }
            }
        }
        if id > 0 {
            lock.lock()
            guard let cost = pendingIDs.removeValue(forKey: id) else { lock.unlock(); _exit(TargetExit.control.rawValue) }
            pending -= 1; pendingBytes -= cost; lock.unlock()
        }
    }
}

private final class ColorPatch: NSView {
    let color: NSColor
    init(frame: NSRect, rgb: [Int]) {
        color = NSColor(srgbRed: CGFloat(rgb[0]) / 255, green: CGFloat(rgb[1]) / 255, blue: CGFloat(rgb[2]) / 255, alpha: 1)
        super.init(frame: frame)
    }
    required init?(coder: NSCoder) { return nil }
    override func draw(_ dirtyRect: NSRect) { color.setFill(); bounds.fill() }
}
private final class TargetContent: NSView { override var isFlipped: Bool { true } }
private final class TargetWindow: NSWindow {
    var observe: ((NSEvent) -> Void)?
    override func sendEvent(_ event: NSEvent) { observe?(event); super.sendEvent(event) }
}

private final class TargetApplication: NSObject, NSApplicationDelegate {
    let channel: TargetChannel
    let window = TargetWindow(contentRect: NSRect(x: 120, y: 140, width: 560, height: 360),
        styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let backdrop = NSWindow(contentRect: NSRect(x: 120, y: 140, width: 560, height: 382),
        styleMask: .borderless, backing: .buffered, defer: false)
    let patch = ColorPatch(frame: NSRect(x: 20, y: 20, width: 160, height: 100), rgb: [32, 128, 192])
    let button = NSButton(title: "Increment", target: nil, action: nil)
    let counterLabel = NSTextField(labelWithString: "Counter: 0")
    let plain = NSTextField(), secure = NSSecureTextField()
    var counter = 0, events = TargetEvents()
    var heldKeys = Set<UInt16>(), heldButtons = Set<Int>()
    var foreignStatus = "idle"
    private var pendingReplies = Set<Int>()

    init(channel: TargetChannel) { self.channel = channel; super.init() }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Vector Computer Test Target"; window.isReleasedWhenClosed = false
        let menus = NSMenu(title: "Fixture"), rootItem = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
        let appItem = NSMenuItem(title: "", action: nil, keyEquivalent: ""), appMenu = NSMenu(title: "App")
        let description = NSMenuItem(title: "Isolated fixture", action: nil, keyEquivalent: "")
        description.isEnabled = false; appMenu.autoenablesItems = false; appMenu.addItem(description); appItem.submenu = appMenu
        menus.addItem(appItem)
        let fixtureMenu = NSMenu(title: "Fixture"), incrementItem = NSMenuItem(title: "Increment", action: #selector(increment), keyEquivalent: "")
        incrementItem.target = self; fixtureMenu.addItem(incrementItem); rootItem.submenu = fixtureMenu
        menus.addItem(rootItem); NSApp.mainMenu = menus
        window.contentView = TargetContent(frame: NSRect(x: 0, y: 0, width: 560, height: 360))
        window.observe = { [weak self] event in self?.observe(event) }
        backdrop.isReleasedWhenClosed = false; backdrop.ignoresMouseEvents = true
        backdrop.contentView = ColorPatch(frame: NSRect(x: 0, y: 0, width: 560, height: 382), rgb: [224, 96, 32])
        window.hasShadow = false; backdrop.hasShadow = false
        button.frame = NSRect(x: 250, y: 30, width: 240, height: 36); button.target = self; button.action = #selector(increment)
        counterLabel.frame = NSRect(x: 250, y: 80, width: 240, height: 28)
        plain.frame = NSRect(x: 20, y: 160, width: 500, height: 28)
        secure.frame = NSRect(x: 20, y: 230, width: 500, height: 28)
        plain.setAccessibilityLabel("Fixture text"); secure.setAccessibilityLabel("Fixture secure")
        for (name, view) in [("patch", patch as NSView), ("button", button), ("text", plain), ("secure", secure)] {
            view.setAccessibilityIdentifier("fixture." + name); window.contentView?.addSubview(view)
        }
        window.contentView?.addSubview(counterLabel)
        backdrop.orderFront(nil); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(button)
        anchorBackdrop()
        backdrop.order(.below, relativeTo: window.windowNumber)
        queueReply(id: 0, milliseconds: 6000)
    }
    private func anchorBackdrop() {
        let desired = window.frame.insetBy(dx: -24, dy: -24)
        if backdrop.frame != desired { backdrop.setFrame(desired, display: backdrop.isVisible) }
    }
    private func queueReply(id: Int, milliseconds: UInt64 = 2000, quit: Bool = false) {
        guard pendingReplies.count < 8, pendingReplies.insert(id).inserted else { _exit(TargetExit.control.rawValue) }
        publishReady(id: id, until: DispatchTime.now().uptimeNanoseconds + milliseconds * 1_000_000, quit: quit)
    }
    private func publishReady(id: Int, until deadline: UInt64, quit: Bool) {
        guard getppid() == channel.options.parent else { _exit(0) }
        anchorBackdrop()
        let state = snapshot()
        guard state.valid else { _exit(TargetExit.state.rawValue) }
        if state.ready { channel.reply(id: id, state: state); pendingReplies.remove(id); if quit { _exit(0) }; return }
        guard DispatchTime.now().uptimeNanoseconds < deadline else { _exit(TargetExit.notReady.rawValue) }
        // Ordering a window is not proof that Quartz has published its geometry yet. Keep one
        // pending main-loop retry and retain the parent's original eight-second handshake bound.
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(20)) { [weak self] in
            guard let self else { _exit(1) }; self.publishReady(id: id, until: deadline, quit: quit)
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    @objc private func increment() { counter = min(1_000_000, counter + 1); counterLabel.stringValue = "Counter: \(counter)" }

    func receive(_ command: TargetCommand) {
        switch command.operation {
        case .state: break
        case .reset:
            window.makeFirstResponder(nil); plain.stringValue = ""; secure.stringValue = ""
            counter = 0; counterLabel.stringValue = "Counter: 0"; foreignStatus = "idle"
        case .focus(let field):
            if field == "none" { window.makeFirstResponder(nil) }
            else {
                show()
                let responder: NSResponder = field == "text" ? plain : field == "secure" ? secure : button
                window.makeFirstResponder(responder)
            }
        case .foreground(let active): if active { show() } else { NSApp.hide(nil) }
        case .move(let dx, let dy):
            let origin = window.frame.origin
            guard abs(origin.x + CGFloat(dx)) <= 100_000, abs(origin.y - CGFloat(dy)) <= 100_000 else {
                channel.reply(id: command.id, state: nil, code: "out_of_bounds"); return
            }
            window.setFrameOrigin(NSPoint(x: origin.x + CGFloat(dx), y: origin.y - CGFloat(dy)))
            backdrop.setFrame(window.frame.insetBy(dx: -24, dy: -24), display: false)
        case .prepareText(let preset):
            let value: String, selection: NSRange
            switch preset {
            case "append": value = "prefix"; selection = NSRange(location: 6, length: 0)
            case "replace": value = "alpha beta"; selection = NSRange(location: 6, length: 4)
            default: value = "A😀B"; selection = NSRange(location: 1, length: 2)
            }
            show(); window.makeFirstResponder(nil); plain.stringValue = value; window.makeFirstResponder(plain)
            (plain.currentEditor() as? NSTextView)?.setSelectedRange(selection)
        case .foreignEsc: postForeignEsc()
        case .quit: queueReply(id: command.id, quit: true); return
        }
        queueReply(id: command.id)
    }

    private func show() {
        NSApp.unhide(nil); backdrop.orderFront(nil); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    private func observe(_ event: NSEvent) {
        switch event.type {
        case .keyDown:
            events.keyDowns = min(1_000_000, events.keyDowns + 1); if heldKeys.count < 128 { heldKeys.insert(event.keyCode) }
            if event.keyCode == 53 { events.escapes = min(1_000_000, events.escapes + 1) }
        case .keyUp: events.keyUps = min(1_000_000, events.keyUps + 1); heldKeys.remove(event.keyCode)
        case .flagsChanged:
            if [54, 55, 56, 58, 59, 60, 61, 62].contains(event.keyCode) {
                if heldKeys.contains(event.keyCode) { heldKeys.remove(event.keyCode) } else if heldKeys.count < 128 { heldKeys.insert(event.keyCode) }
            }
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            events.buttonDowns = min(1_000_000, events.buttonDowns + 1); if (0..<8).contains(event.buttonNumber) { heldButtons.insert(event.buttonNumber) }
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            events.buttonUps = min(1_000_000, events.buttonUps + 1); heldButtons.remove(event.buttonNumber)
        default: break
        }
    }
    private func postForeignEsc() {
        guard channel.options.isolated else { foreignStatus = "not_isolated"; return }
        guard CGPreflightPostEventAccess() else { foreignStatus = "not_granted"; return }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(), window.isKeyWindow else { foreignStatus = "not_foreground"; return }
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: false),
              down.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid()),
              up.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid()) else { foreignStatus = "failed"; return }
        source.userData = targetForeignTag
        for event in [down, up] { event.flags = []; event.setIntegerValueField(.eventSourceUserData, value: targetForeignTag) }
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap); foreignStatus = "posted"
    }

    private func snapshot() -> TargetState {
        let frames = windowFrames()
        let mainBounds = frames[window.windowNumber], backBounds = frames[backdrop.windowNumber]
        var views: [String: TargetView] = [:]
        for (name, view) in [("patch", patch as NSView), ("button", button), ("text", plain), ("secure", secure)] {
            var bounds: TargetRect?
            if let mainBounds {
                let screen = window.convertToScreen(view.convert(view.bounds, to: nil)), frame = window.frame
                bounds = TargetRect(CGRect(x: mainBounds.minX + screen.minX - frame.minX,
                    y: mainBounds.minY + frame.maxY - screen.maxY, width: screen.width, height: screen.height))
            }
            views[name] = TargetView(identifier: "fixture." + name, bounds: bounds)
        }
        events.heldKeys = heldKeys.count; events.heldButtons = heldButtons.count
        let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath().standardizedFileURL.path
        let mainRect = mainBounds.map(TargetRect.init), backRect = backBounds.map(TargetRect.init)
        let ready = targetGeometryReady(mainRect, backRect, views)
        return TargetState(pid: Int(getpid()), parentPID: Int(getppid()), bundleID: Bundle.main.bundleIdentifier ?? "",
            bundlePath: bundle, executablePath: Bundle.main.executableURL?.resolvingSymlinksInPath().standardizedFileURL.path ?? "",
            sourceDigest: Bundle.main.object(forInfoDictionaryKey: "VectorComputerSourceDigest") as? String ?? "",
            ready: ready, windowNumber: window.windowNumber, backdropWindowNumber: backdrop.windowNumber,
            windowBounds: mainRect, backdropBounds: backRect, views: views,
            patchRGB: [32, 128, 192], backdropRGB: [224, 96, 32], counter: counter, text: textState(plain), secure: textState(secure),
            visible: window.isVisible, minimized: window.isMiniaturized, foreground: NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
            postEvent: CGPreflightPostEventAccess(), events: events,
            foreignEsc: TargetForeignEsc(status: foreignStatus, pid: Int(getpid()), tag: String(targetForeignTag, radix: 16)))
    }
    private func textState(_ field: NSTextField) -> TargetText {
        let editor = field.currentEditor() as? NSTextView
        let text = editor?.string ?? field.stringValue
        let selected = editor?.selectedRange()
        return TargetText(length: text.utf16.count, sha256: SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined(),
            selection: selected.map { TargetSelection(location: $0.location, length: $0.length) })
    }
    private func windowFrames() -> [Int: CGRect] {
        guard let raw = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return [:] }
        var frames: [Int: CGRect] = [:]
        for value in raw where (value[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == getpid() {
            guard let id = (value[kCGWindowNumber as String] as? NSNumber)?.intValue,
                  id == window.windowNumber || id == backdrop.windowNumber,
                  let dictionary = value[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary), TargetRect(bounds).valid else { continue }
            frames[id] = bounds
        }
        return frames
    }
}

/// This explicitly selected mode checks only the private control grammar. It never constructs NSApplication.
private func targetControlSelfTest() -> Bool {
    let nonce = String(repeating: "a", count: 32), digest = String(repeating: "b", count: 64)
    guard (try? TargetOptions.parse(["--nonce", nonce, "--artifact", digest, "--parent-pid", "123", "--isolated"])) != nil else { return false }
    for args in [[], ["--nonce", nonce], ["--nonce", nonce, "--artifact", digest, "--parent-pid", "0"],
                 ["--nonce", nonce, "--artifact", digest, "--parent-pid", "0123"],
                 ["--nonce", nonce, "--artifact", digest, "--parent-pid", "123", "--isolated", "--isolated"]] {
        if (try? TargetOptions.parse(args)) != nil { return false }
    }
    for op in ["state", "reset", "foreignEsc", "quit"] {
        let bytes = Data("{\"id\":1,\"nonce\":\"\(nonce)\",\"op\":\"\(op)\"}".utf8)
        if (try? TargetCommand.parse(bytes, nonce: nonce)) == nil { return false }
    }
    for payload in ["\"op\":\"focus\",\"field\":\"secure\"", "\"op\":\"focus\",\"field\":\"none\"",
                    "\"op\":\"move\",\"dx\":-2000,\"dy\":2000", "\"op\":\"foreground\",\"active\":false",
                    "\"op\":\"prepareText\",\"preset\":\"unicode\""] {
        if (try? TargetCommand.parse(Data("{\"id\":2,\"nonce\":\"\(nonce)\",\(payload)}".utf8), nonce: nonce)) == nil { return false }
    }
    for raw in ["{\"id\":true,\"nonce\":\"\(nonce)\",\"op\":\"state\"}",
                "{\"id\":0,\"nonce\":\"\(nonce)\",\"op\":\"state\"}",
                "{\"id\":1,\"nonce\":\"wrong\",\"op\":\"state\"}",
                "{\"id\":1,\"nonce\":\"\(nonce)\",\"op\":\"state\",\"text\":\"private\"}",
                "{\"id\":1,\"nonce\":\"\(nonce)\",\"op\":\"focus\",\"field\":\"other\"}",
                "{\"id\":1,\"nonce\":\"\(nonce)\",\"op\":\"move\",\"dx\":2001,\"dy\":0}",
                "{\"id\":1,\"nonce\":\"\(nonce)\",\"op\":\"prepareText\",\"preset\":\"arbitrary\"}"] {
        if (try? TargetCommand.parse(Data(raw.utf8), nonce: nonce)) != nil { return false }
    }
    if (try? TargetCommand.parse(Data(repeating: 32, count: targetFrameLimit + 1), nonce: nonce)) != nil { return false }
    if (try? TargetCommand.parse(Data("{\"id\":1,\"nonce\":\"\(nonce)\",\"op\":\"setText\",\"text\":\"arbitrary\"}".utf8), nonce: nonce)) != nil { return false }
    let secret = "private fixture secret"
    let summary = TargetText(length: secret.utf16.count, sha256: SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined(), selection: nil)
    let bounds = TargetRect(CGRect(x: -100, y: 20, width: 100, height: 50))
    let state = TargetState(pid: 123, parentPID: 122, bundleID: targetBundleID,
        bundlePath: "/virtual/VectorComputerTestTarget.app", executablePath: "/virtual/VectorComputerTestTarget.app/Contents/MacOS/" + targetExecutable,
        sourceDigest: digest, ready: true, windowNumber: 10, backdropWindowNumber: 11, windowBounds: bounds,
        backdropBounds: TargetRect(CGRect(x: -124, y: -4, width: 148, height: 98)),
        views: Dictionary(uniqueKeysWithValues: ["patch", "button", "text", "secure"].map { ($0, TargetView(identifier: "fixture." + $0, bounds: bounds)) }),
        patchRGB: [32, 128, 192], backdropRGB: [224, 96, 32], counter: 0, text: summary, secure: summary,
        visible: true, minimized: false, foreground: true, postEvent: false, events: TargetEvents(),
        foreignEsc: TargetForeignEsc(status: "idle", pid: 123, tag: String(targetForeignTag, radix: 16)))
    var outsideViews = state.views
    outsideViews["patch"] = TargetView(identifier: "fixture.patch", bounds: TargetRect(CGRect(x: -101, y: 20, width: 100, height: 50)))
    guard state.valid, targetGeometryReady(state.windowBounds, state.backdropBounds, state.views),
          !targetGeometryReady(state.windowBounds, state.windowBounds, state.views),
          !targetGeometryReady(state.windowBounds, TargetRect(CGRect(x: -99, y: 21, width: 1, height: 1)), state.views),
          !targetGeometryReady(state.windowBounds, state.backdropBounds, outsideViews),
          !targetGeometryReady(state.windowBounds, state.backdropBounds, [:]),
          let encoded = try? JSONEncoder().encode(state), encoded.count < targetFrameLimit,
          let serialized = String(data: encoded, encoding: .utf8), !serialized.contains(secret),
          !TargetEvents(heldKeys: 129).valid else { return false }
    return TargetText(length: 0, sha256: String(repeating: "0", count: 64), selection: nil).valid &&
        !TargetText(length: 4001, sha256: String(repeating: "0", count: 64), selection: nil).valid &&
        !TargetText(length: 1, sha256: String(repeating: "0", count: 64), selection: TargetSelection(location: 1, length: 1)).valid &&
        !TargetRect(CGRect(x: Double.nan, y: 0, width: 1, height: 1)).valid
}

if CommandLine.arguments.dropFirst().elementsEqual(["--self-test=control"]) {
    let passed = targetControlSelfTest()
    let bytes = Data((passed ? "{\"checks\":[{\"name\":\"test-target-control-schema\",\"ok\":true}]}\n" :
        "{\"checks\":[{\"name\":\"test-target-control-schema\",\"ok\":false}]}\n").utf8)
    _ = bytes.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress, $0.count) }
    _exit(passed ? 0 : 1)
}

private var targetStartupExit = TargetExit.options
do {
    let options = try TargetOptions.parse(Array(CommandLine.arguments.dropFirst()))
    targetStartupExit = .bundle
    let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath().standardizedFileURL
    guard Bundle.main.bundleIdentifier == targetBundleID, bundle.lastPathComponent == "VectorComputerTestTarget.app",
          Bundle.main.executableURL?.resolvingSymlinksInPath().standardizedFileURL.path == bundle.appendingPathComponent("Contents/MacOS/" + targetExecutable).path,
          Bundle.main.object(forInfoDictionaryKey: "VectorComputerSourceDigest") as? String == options.artifact else { throw TargetFailure.invalid }
    targetStartupExit = .control
    let channel = try TargetChannel(options)
    var target: TargetApplication?
    // The independent EOF/parent watchers are armed before AppKit can block while opening its first window.
    channel.start { command in guard let target else { _exit(1) }; target.receive(command) }
    targetStartupExit = .application
    let application = NSApplication.shared
    let delegate = TargetApplication(channel: channel)
    target = delegate
    application.delegate = delegate
    if application.activationPolicy() != .regular { _ = application.setActivationPolicy(.regular) }
    guard application.activationPolicy() == .regular else { throw TargetFailure.invalid }
    application.run()
    _exit(0)
} catch { _exit(targetStartupExit.rawValue) }
