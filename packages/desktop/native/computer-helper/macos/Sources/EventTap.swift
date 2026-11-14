import ApplicationServices
import CoreGraphics
import Darwin
import Dispatch
import Foundation

struct EventTapStatus: Equatable {
    let generation: UInt64
    let installed: Bool
    let enabled: Bool
    var challenge: UInt64? = nil
    var bindingReady = true
    var bindingEpoch: UUID? = nil
}

enum EventTapKind: Equatable { case keyDown, keyUp, flagsChanged, pointer, click, scroll }

/// Private callback facts. Key codes and source markers never become protocol fields.
struct EventTapSample {
    let kind: EventTapKind
    var sourcePID: pid_t = 0
    var tag: Int64 = 0
    var targetPID: pid_t? = nil
    var keyCode: UInt16? = nil
    var flags: UInt64 = 0
    var point: CGPoint? = nil
    var repeated = false
}

struct EventTapChord: Equatable {
    let code: UInt16
    let flags: UInt64
    let layout: String
    var layoutDependent = false

    static let modifierMask = CGEventFlags.maskCommand.rawValue | CGEventFlags.maskControl.rawValue |
        CGEventFlags.maskAlternate.rawValue | CGEventFlags.maskShift.rawValue

    /// Observing a portable stop chord does not register it, reserve it, or consume its ordinary key.
    static func parse(_ raw: String, layout: String, code: (String) -> UInt16?,
                      resolve: ((String, UInt64) -> (code: UInt16, flags: UInt64)?)? = nil) -> EventTapChord? {
        guard !raw.isEmpty, raw.utf8.count <= 64, raw.utf8.allSatisfy({ (32...126).contains($0) }),
              !layout.isEmpty else { return nil }
        let parts = raw.split(separator: "+", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces).lowercased()
        }
        guard (3...5).contains(parts.count), parts.allSatisfy({ !$0.isEmpty }) else { return nil }
        var flags: UInt64 = 0
        var key: String?
        var modifiers = 0
        for part in parts {
            let flag: UInt64?
            switch part {
            case "command", "cmd", "meta", "super", "commandorcontrol", "cmdorctrl", "commandorctrl", "cmdorcontrol": flag = CGEventFlags.maskCommand.rawValue
            case "control", "ctrl", "ctl": flag = CGEventFlags.maskControl.rawValue
            case "alt", "option", "opt": flag = CGEventFlags.maskAlternate.rawValue
            case "shift": flag = CGEventFlags.maskShift.rawValue
            default: flag = nil
            }
            if let flag {
                guard flags & flag == 0 else { return nil }
                flags |= flag; modifiers += 1
            } else {
                guard key == nil else { return nil }
                if part.utf8.count == 1, let byte = part.utf8.first, (97...122).contains(byte) { key = "Key" + part.uppercased() }
                else if part.utf8.count == 1, let byte = part.utf8.first, (48...57).contains(byte) { key = "Digit" + part }
                else if part == "plus" || part == "minus" || part == "-" { key = part == "plus" ? "+" : "-" }
                else {
                    let names = ["esc": "Escape", "escape": "Escape", "space": "Space", "spacebar": "Space",
                        "enter": "Enter", "return": "Enter", "tab": "Tab", "backspace": "Backspace",
                        "delete": "ForwardDelete", "del": "ForwardDelete", "insert": "Insert", "ins": "Insert",
                        "up": "ArrowUp", "arrowup": "ArrowUp", "down": "ArrowDown", "arrowdown": "ArrowDown",
                        "left": "ArrowLeft", "arrowleft": "ArrowLeft", "right": "ArrowRight", "arrowright": "ArrowRight",
                        "home": "Home", "end": "End", "pageup": "PageUp", "pagedown": "PageDown"]
                    key = names[part] ?? (part.range(of: "^f([1-9]|1[0-9]|2[0-4])$", options: .regularExpression) != nil ? part : nil)
                }
            }
        }
        guard modifiers >= 2, let key else { return nil }
        let reserved = CGEventFlags.maskCommand.rawValue | CGEventFlags.maskAlternate.rawValue
        if key == "Escape", flags & reserved == reserved { return nil }
        if key == "+" || key == "-" {
            guard let binding = resolve?(key, flags), binding.flags & ~modifierMask == 0,
                  binding.flags & flags == flags else { return nil }
            return EventTapChord(code: binding.code, flags: binding.flags, layout: layout, layoutDependent: true)
        }
        guard let keyCode = code(key) else { return nil }
        return EventTapChord(code: keyCode, flags: flags, layout: layout)
    }
}

struct EventTapBackend {
    let start: (@escaping (EventTapSample) -> Bool, @escaping (EventTapStatus) -> Void) -> Void
    let execute: (@escaping () -> Void) -> Void
    let recover: () -> Void
    let probe: (UInt64) -> Void
    let close: () -> Void
    let cursor: () -> CGPoint?
    let chord: (String) -> EventTapChord?

    static var system: EventTapBackend {
        let native = NativeEventTap()
        return EventTapBackend(start: native.start, execute: native.execute, recover: native.recover,
            probe: native.probe, close: native.close, cursor: { CGEvent(source: nil)?.location }, chord: { raw in
                guard let before = InputNative.keyboardFingerprint(),
                      let chord = EventTapChord.parse(raw, layout: before, code: InputNative.physicalKeyCode,
                        resolve: { InputNative.resolveKey($0, flags: $1) }),
                      InputNative.keyboardFingerprint() == before else { return nil }
                return chord
            })
    }
}

/// The tap calls Dispatcher only after releasing this monitor's lock. Session hooks may use the opposite
/// Dispatcher -> monitor order, and exact-snapshot callbacks reject events prepared before a phase changed.
final class EventTapMonitor {
    private let lock = NSLock()
    private let backend: EventTapBackend
    private let session: () -> ServerSession?
    private let input: (Event, ServerSession, Bool) -> Bool
    private let stop: (String, ServerSession) -> Bool
    private let statusChanged: (EventTapStatus) -> Void
    private let ownPID: pid_t
    private let tag: Int64
    private var started = false
    private var closed = false
    private var latest = EventTapStatus(generation: 0, installed: false, enabled: false, bindingReady: false)
    private var bindingReady = false
    private var epoch: UUID?
    private var configuration = UUID()
    private var chord: EventTapChord?
    private var baseline: CGPoint?
    /// An up is consumed only after this source's actual down was consumed. A fresh nonrepeat down ends
    /// any previous press from that source; disabling a tap also loses continuity and retires these records.
    private var consumedEscape: [pid_t: UInt64] = [:]
    private var escapeSequence: UInt64 = 0

    init(session: @escaping () -> ServerSession?, input: @escaping (Event, ServerSession, Bool) -> Bool,
         stop: @escaping (String, ServerSession) -> Bool, status: @escaping (EventTapStatus) -> Void,
         backend: EventTapBackend? = nil, ownPID: pid_t = getpid(), tag: Int64 = InputNative.eventTag) {
        self.session = session; self.input = input; self.stop = stop; statusChanged = status
        self.backend = backend ?? .system; self.ownPID = ownPID; self.tag = tag
    }

    func start() {
        lock.lock()
        guard !closed, !started else { lock.unlock(); return }
        started = true; lock.unlock()
        backend.start({ [weak self] in self?.handle($0) ?? false }, { [weak self] in self?.observe($0) })
        refreshSession()
    }

    /// Safe in the authority notification path: native cursor/layout work is queued on the tap loop.
    func refreshSession() {
        let current = session()
        lock.lock()
        guard !closed else { lock.unlock(); return }
        let ticket = UUID(); configuration = ticket
        let changed = epoch != current?.observationEpoch
        epoch = current?.observationEpoch
        chord = nil; bindingReady = false
        latest = EventTapStatus(generation: latest.generation, installed: latest.installed, enabled: latest.enabled,
            bindingReady: false, bindingEpoch: epoch)
        if changed { baseline = nil; consumedEscape.removeAll(); escapeSequence &+= 1 }
        lock.unlock()
        backend.execute { [weak self] in
            guard let self else { return }
            let point = self.backend.cursor()
            let binding = current.flatMap { self.backend.chord($0.stopChord) }
            guard self.session()?.observationEpoch == current?.observationEpoch else { return }
            self.lock.lock()
            guard !self.closed, self.configuration == ticket else { self.lock.unlock(); return }
            self.chord = binding; self.bindingReady = current == nil || binding != nil
            self.latest = EventTapStatus(generation: self.latest.generation, installed: self.latest.installed, enabled: self.latest.enabled,
                bindingReady: self.bindingReady, bindingEpoch: self.epoch)
            if changed, let point, Self.finite(point) { self.baseline = point }
            let value = self.latest
            self.lock.unlock(); self.statusChanged(value)
        }
    }

    func status() -> EventTapStatus { lock.lock(); defer { lock.unlock() }; return latest }
    func recover() { lock.lock(); let active = !closed && started; lock.unlock(); if active { backend.recover() } }
    func probe(challenge: UInt64) {
        lock.lock(); let active = !closed && started; lock.unlock()
        guard active else { return }
        backend.execute { [weak self] in
            guard let self else { return }
            let current = self.session()
            self.lock.lock()
            guard !self.closed else { self.lock.unlock(); return }
            let ticket = self.configuration; let matches = self.epoch == current?.observationEpoch
            self.lock.unlock()
            if matches {
                let binding = current.flatMap { self.backend.chord($0.stopChord) }
                self.updateBinding(binding, current: current, ticket: ticket)
            } else { self.refreshSession() }
            self.backend.probe(challenge)
        }
    }

    private func updateBinding(_ binding: EventTapChord?, current: ServerSession?, ticket: UUID) {
        lock.lock()
        guard !closed, configuration == ticket, epoch == current?.observationEpoch else { lock.unlock(); return }
        let ready = current == nil || binding != nil
        let changed = bindingReady != ready
        chord = binding; bindingReady = ready
        latest = EventTapStatus(generation: latest.generation, installed: latest.installed, enabled: latest.enabled,
            challenge: changed ? nil : latest.challenge, bindingReady: ready, bindingEpoch: epoch)
        let value = latest; lock.unlock()
        if changed { statusChanged(value) }
    }

    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true; configuration = UUID(); chord = nil; baseline = nil; bindingReady = false; consumedEscape.removeAll(); escapeSequence &+= 1
        latest = EventTapStatus(generation: latest.generation &+ 1, installed: false, enabled: false, bindingReady: false)
        let value = latest; lock.unlock()
        backend.close(); statusChanged(value)
    }

    private func observe(_ value: EventTapStatus) {
        lock.lock()
        guard !closed, value.generation >= latest.generation else { lock.unlock(); return }
        if value.generation != latest.generation || !value.installed || !value.enabled {
            consumedEscape.removeAll(); escapeSequence &+= 1; baseline = nil
        }
        let observed = EventTapStatus(generation: value.generation, installed: value.installed, enabled: value.enabled,
            challenge: value.challenge, bindingReady: bindingReady, bindingEpoch: epoch)
        latest = observed; lock.unlock()
        statusChanged(observed)
    }

    /// Returns true only for the exact physical Escape press the tap owns; all other events pass through.
    func handle(_ sample: EventTapSample) -> Bool {
        lock.lock()
        guard !closed, started else { lock.unlock(); return false }
        let own = sample.sourcePID == ownPID && sample.tag == tag
        if own {
            if sample.kind == .pointer || sample.kind == .click, let point = sample.point, Self.finite(point) { baseline = point }
            lock.unlock(); return false
        }
        guard latest.installed, latest.enabled else { lock.unlock(); return false }
        var press: UInt64?
        if sample.keyCode == 53 {
            if sample.kind == .keyUp {
                escapeSequence &+= 1
                if consumedEscape.removeValue(forKey: sample.sourcePID) != nil { lock.unlock(); return true }
            }
            if sample.kind == .keyDown {
                if sample.repeated, consumedEscape[sample.sourcePID] != nil { lock.unlock(); return true }
                if !sample.repeated { consumedEscape.removeValue(forKey: sample.sourcePID) }
                escapeSequence &+= 1; press = escapeSequence
            }
        }
        lock.unlock()
        guard let current = session() else { return false }
        lock.lock()
        guard !closed else { lock.unlock(); return false }
        let matches = epoch == current.observationEpoch
        let cached = matches ? chord : nil
        let ticket = configuration
        var dx: Double?, dy: Double?
        if matches, sample.kind == .pointer {
            if let point = sample.point, Self.finite(point) {
                if let previous = baseline { dx = Double(point.x - previous.x); dy = Double(point.y - previous.y) }
                baseline = point
            } else { baseline = nil }
        } else if matches, sample.kind == .click, let point = sample.point, Self.finite(point) { baseline = point }
        lock.unlock()

        let working = current.mode == "foreground" && current.escStops && !current.paused
        if sample.kind == .keyDown {
            // Refresh the actual TIS witness only for a potential stop key; ordinary callback work has no
            // layout lookup, AX call, app lookup, content read or key logging.
            let candidate = cached == nil || cached?.layoutDependent == true || cached?.code == sample.keyCode
            let observed = candidate ? backend.chord(current.stopChord) : cached
            if candidate { updateBinding(observed, current: current, ticket: ticket) }
            let isChord = observed.map { $0.code == sample.keyCode && sample.flags & EventTapChord.modifierMask == $0.flags } == true
            let plainEscape = sample.keyCode == 53 && sample.flags & EventTapChord.modifierMask == 0
            let by = isChord ? "chord" : plainEscape && working ? "esc" : nil
            if let by {
                let accepted = stop(by, current)
                guard accepted else { return false }
                if sample.keyCode == 53 && working {
                    lock.lock()
                    if !closed, latest.installed, latest.enabled, let press, escapeSequence == press, consumedEscape.count < 16 {
                        consumedEscape[sample.sourcePID] = press
                    }
                    let consume = press != nil && consumedEscape[sample.sourcePID] == press
                    lock.unlock(); return consume
                }
                return false
            }
        }
        let kind: String
        switch sample.kind {
        case .keyDown, .keyUp, .flagsChanged: kind = "key"
        case .pointer: kind = "pointer"
        case .click: kind = "click"
        case .scroll: kind = "scroll"
        }
        var fields: [String: JSONValue] = ["kind": .string(kind)]
        if let pid = sample.targetPID, pid > 0 { fields["pid"] = .integer(Int64(pid)) }
        if let dx, let dy, dx.isFinite, dy.isFinite { fields["dx"] = .number(dx); fields["dy"] = .number(dy) }
        let qualifies = working && (sample.kind != .pointer || dx == nil || dy == nil || hypot(dx!, dy!) >= 8)
        _ = input(Event(name: "user_input", fields: fields), current, qualifies)
        return false
    }

    private static func finite(_ point: CGPoint) -> Bool { point.x.isFinite && point.y.isFinite && abs(point.x) <= 1_000_000 && abs(point.y) <= 1_000_000 }
}

/// Active (not listen-only) HID tap. Creating this object does nothing; only a verified worker calls start.
private final class NativeEventTap {
    private let lock = NSLock()
    private var thread: Thread?
    private var loop: CFRunLoop?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var keepAlive: CFRunLoopTimer?
    private var callback: ((EventTapSample) -> Bool)?
    private var changed: ((EventTapStatus) -> Void)?
    private var pending: [() -> Void] = []
    private var generation: UInt64 = 0
    private var closed = false

    func start(_ callback: @escaping (EventTapSample) -> Bool, _ changed: @escaping (EventTapStatus) -> Void) {
        lock.lock()
        guard !closed, thread == nil else { lock.unlock(); return }
        self.callback = callback; self.changed = changed
        let thread = Thread { [self] in run() }
        thread.name = "Vector Hands physical input"; thread.qualityOfService = .userInteractive
        self.thread = thread; lock.unlock(); thread.start()
    }
    func execute(_ body: @escaping () -> Void) {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        guard let loop else {
            if pending.count < 16 { pending.append(body) }
            lock.unlock(); return
        }
        lock.unlock()
        CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue, body)
        CFRunLoopWakeUp(loop)
    }
    func recover() { execute { [weak self] in self?.enable() } }
    func probe(_ challenge: UInt64) { execute { [weak self] in self?.publish(challenge) } }
    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true; generation &+= 1; callback = nil; changed = nil; pending.removeAll()
        let loop = self.loop; lock.unlock()
        if let loop { CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(loop) }; CFRunLoopWakeUp(loop) }
    }
    private func run() {
        let loop = CFRunLoopGetCurrent()
        lock.lock()
        guard !closed else { thread = nil; callback = nil; changed = nil; lock.unlock(); return }
        self.loop = loop; generation &+= 1
        let work = pending; pending.removeAll(); lock.unlock()
        // Keep the dedicated loop available even if initial AX preflight or tap installation fails.
        // A later verified grant/recovery can retry without inventing successful installation.
        let timer = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 0.25,
            0.25, 0, 0) { _ in }
        if let timer { CFRunLoopAddTimer(loop, timer, .commonModes) }
        lock.lock(); keepAlive = timer; lock.unlock()
        defer {
            lock.lock(); let tap = self.tap; let source = self.source; let changed = self.changed
            generation &+= 1; let retired = generation
            self.tap = nil; self.source = nil; self.loop = nil; thread = nil; callback = nil; self.changed = nil; keepAlive = nil
            lock.unlock()
            if let timer { CFRunLoopTimerInvalidate(timer) }
            if let source { CFRunLoopRemoveSource(loop, source, .commonModes) }
            if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
            changed?(EventTapStatus(generation: retired, installed: false, enabled: false))
        }
        install()
        work.forEach { $0() }
        lock.lock(); let active = !closed; lock.unlock()
        if active { CFRunLoopRun() }
    }
    private func install() {
        lock.lock(); let active = !closed; let existing = tap; lock.unlock()
        guard active else { return }
        if let existing, CFMachPortIsValid(existing) { enable(); return }
        // An active default tap uses Accessibility. No listen-only preflight or request API is called.
        guard AXIsProcessTrusted() else { publish(); return }
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .mouseMoved, .leftMouseDragged,
            .rightMouseDragged, .otherMouseDragged, .leftMouseDown, .leftMouseUp, .rightMouseDown,
            .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
            eventsOfInterest: mask, callback: Self.receive, userInfo: Unmanaged.passUnretained(self).toOpaque()) else { publish(); return }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap); publish(); return
        }
        lock.lock()
        guard !closed else { lock.unlock(); CFMachPortInvalidate(tap); return }
        let oldTap = self.tap; let oldSource = self.source
        self.tap = tap; self.source = source; generation &+= 1
        let loop = self.loop; lock.unlock()
        if let loop, let oldSource { CFRunLoopRemoveSource(loop, oldSource, .commonModes) }
        if let oldTap { CFMachPortInvalidate(oldTap) }
        guard let loop else { CFMachPortInvalidate(tap); publish(); return }
        CFRunLoopAddSource(loop, source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        publish()
    }
    private func enable() {
        lock.lock(); let tap = self.tap; let active = !closed; lock.unlock()
        guard active else { return }
        guard let tap, CFMachPortIsValid(tap) else { install(); return }
        if AXIsProcessTrusted() { CGEvent.tapEnable(tap: tap, enable: true) }
        publish()
    }
    private func publish(_ challenge: UInt64? = nil, disabled: Bool = false) {
        lock.lock(); let tap = self.tap; let callback = changed; let generation = self.generation; let active = !closed; lock.unlock()
        let installed = active && tap != nil && tap.map { CFMachPortIsValid($0) } == true
        callback?(EventTapStatus(generation: generation, installed: installed,
            enabled: installed && !disabled && AXIsProcessTrusted() && tap.map { CGEvent.tapIsEnabled(tap: $0) } == true, challenge: challenge))
    }
    private static let receive: CGEventTapCallBack = { _, type, event, context in
        guard let context else { return Unmanaged.passUnretained(event) }
        let native = Unmanaged<NativeEventTap>.fromOpaque(context).takeUnretainedValue()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            native.publish(disabled: true); native.enable(); return Unmanaged.passUnretained(event)
        }
        let kind: EventTapKind
        switch type {
        case .keyDown: kind = .keyDown
        case .keyUp: kind = .keyUp
        case .flagsChanged: kind = .flagsChanged
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: kind = .pointer
        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp: kind = .click
        case .scrollWheel: kind = .scroll
        default: return Unmanaged.passUnretained(event)
        }
        let source = event.getIntegerValueField(.eventSourceUnixProcessID)
        let target = event.getIntegerValueField(.eventTargetUnixProcessID)
        let sourcePID = source >= 0 && source <= Int64(Int32.max) ? pid_t(source) : 0
        let targetPID = target > 0 && target <= Int64(Int32.max) ? pid_t(target) : nil
        var sample = EventTapSample(kind: kind, sourcePID: sourcePID,
            tag: event.getIntegerValueField(.eventSourceUserData), targetPID: targetPID,
            flags: event.flags.rawValue, point: kind == .pointer || kind == .click ? event.location : nil)
        if kind == .keyDown || kind == .keyUp || kind == .flagsChanged {
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            if code >= 0 && code <= Int64(UInt16.max) { sample.keyCode = UInt16(code) }
            sample.repeated = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        }
        native.lock.lock(); let callback = native.closed ? nil : native.callback; native.lock.unlock()
        return callback?(sample) == true ? nil : Unmanaged.passUnretained(event)
    }
}
