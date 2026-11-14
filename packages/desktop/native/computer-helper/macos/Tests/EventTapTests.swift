import CoreGraphics
import Darwin
import Foundation

private struct EventTapTestFailure: Error { let message: String }
private func eventTapCheck(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw EventTapTestFailure(message: message) }
}

private final class EventTapFixture {
    var current: ServerSession? = ServerSession(id: "tap-session", revision: 2, mode: "foreground", paused: false,
        approved: [], vectorPids: [900], vectorWindowIds: [], overlayWindowIds: [], escStops: true,
        stopChord: "Command+Shift+Escape")
    var installed = true
    var enabled = true
    var accept = true
    var cursor: CGPoint? = .zero
    var queued = false
    var tasks: [() -> Void] = []
    var events: [Event] = []
    var statuses: [EventTapStatus] = []
    var order: [String] = []
    var recovery = 0
    var keyboardReads = 0
    var keyboardAvailable = true
    var layoutName = "synthetic-layout"
    var punctuationOffset: UInt16 = 0
    var received: ((EventTapSample) -> Bool)?
    var changed: ((EventTapStatus) -> Void)?
    var beforeStop: (() -> Void)?
    var beforeInput: (() -> Void)?
    var afterSnapshot: (() -> Void)?

    static func code(_ name: String) -> UInt16? {
        ["Escape": 53, "KeyA": 0, "KeyQ": 12, "Digit4": 21, "f12": 111, "ForwardDelete": 117,
         "ArrowUp": 126, "Space": 49][name]
    }
    static func punctuation(_ value: String, _ flags: UInt64) -> (code: UInt16, flags: UInt64)? {
        if value == "+" { return (24, flags | CGEventFlags.maskShift.rawValue) }
        if value == "-" { return (27, flags) }
        return nil
    }
    lazy var backend = EventTapBackend(start: { sample, status in
        self.received = sample; self.changed = status
        status(EventTapStatus(generation: 1, installed: self.installed, enabled: self.enabled))
    }, execute: { body in
        if self.queued { self.tasks.append(body) } else { body() }
    }, recover: {
        self.recovery += 1
        self.changed?(EventTapStatus(generation: 1, installed: self.installed, enabled: self.enabled))
    }, probe: { challenge in
        self.changed?(EventTapStatus(generation: 1, installed: self.installed, enabled: self.enabled, challenge: challenge))
    }, close: {}, cursor: { self.cursor }, chord: { raw in
        self.keyboardReads += 1
        guard self.keyboardAvailable else { return nil }
        return EventTapChord.parse(raw, layout: self.layoutName, code: Self.code, resolve: { value, flags in
            guard let binding = Self.punctuation(value, flags) else { return nil }
            return (binding.code + self.punctuationOffset, binding.flags)
        })
    })
    lazy var monitor = EventTapMonitor(session: {
        let snapshot = self.current; self.afterSnapshot?(); return snapshot
    }, input: { event, captured, pause in
        self.beforeInput?()
        guard self.accept, self.current?.observationEpoch == captured.observationEpoch,
              self.current?.revision == captured.revision else { return false }
        if pause { self.order += ["latch", "release"]; self.current?.paused = true; self.current?.escStops = false }
        self.order.append("input"); self.events.append(event); return true
    }, stop: { by, captured in
        self.beforeStop?()
        guard self.accept, self.current?.observationEpoch == captured.observationEpoch,
              self.current?.revision == captured.revision else { return false }
        self.order += ["halt", "release", "stop"]
        self.current?.paused = true; self.current?.escStops = false
        self.events.append(Event(name: "stop", fields: ["by": .string(by)])); return true
    }, status: { self.statuses.append($0) }, backend: backend, ownPID: 900, tag: 77)

    func start() { monitor.start() }
    func withChord(_ chord: String) {
        guard let previous = current else { return }
        current = ServerSession(id: previous.id, revision: previous.revision, mode: previous.mode, paused: previous.paused,
            approved: previous.approved, vectorPids: previous.vectorPids, vectorWindowIds: previous.vectorWindowIds,
            overlayWindowIds: previous.overlayWindowIds, escStops: previous.escStops, stopChord: chord)
    }
    @discardableResult func send(_ sample: EventTapSample) -> Bool { received?(sample) ?? false }
    func escape(_ kind: EventTapKind = .keyDown, source: pid_t = 0, flags: UInt64 = 0, repeated: Bool = false) -> EventTapSample {
        EventTapSample(kind: kind, sourcePID: source, keyCode: 53, flags: flags, repeated: repeated)
    }
    func fresh(mode: String = "foreground", esc: Bool = true) {
        current?.observationEpoch = UUID(); current?.revision = 3; current?.mode = mode
        current?.paused = false; current?.escStops = esc
        monitor.refreshSession()
    }
}

func runEventTapTests() throws -> Int {
    var groups = 0
    func test(_ body: () throws -> Void) throws { try body(); groups += 1 }

    try test {
        let f = EventTapFixture()
        try eventTapCheck(f.statuses.isEmpty && f.received == nil, "Construction must remain inert.")
        f.start(); f.start()
        try eventTapCheck(f.monitor.status().enabled && f.monitor.status().bindingReady && f.statuses.count == 2, "Start publishes installation and completed exact-session binding once.")
    }
    try test {
        let f = EventTapFixture(); f.start()
        _ = f.send(EventTapSample(kind: .keyDown, sourcePID: 900, tag: 77, keyCode: 53))
        _ = f.send(EventTapSample(kind: .pointer, sourcePID: 900, tag: 77, point: CGPoint(x: 1000, y: 400)))
        try eventTapCheck(f.events.isEmpty && f.order.isEmpty, "Own PID/tag must have no public or authority effects.")
        _ = f.send(EventTapSample(kind: .pointer, point: CGPoint(x: 1001, y: 400)))
        try eventTapCheck(f.order == ["input"] && f.events[0].value.objectValue?["dx"] == .number(1), "Own warps update only the private logical baseline.")
    }
    try test {
        let f = EventTapFixture(); f.start()
        _ = f.send(EventTapSample(kind: .keyDown, sourcePID: 901, tag: 77, keyCode: 0))
        try eventTapCheck(f.order == ["latch", "release", "input"], "A foreign source cannot hide physical input with the fixed marker.")
    }
    try test {
        let f = EventTapFixture(); f.start()
        _ = f.send(EventTapSample(kind: .keyDown, sourcePID: 900, tag: 78, targetPID: 101, keyCode: 0))
        let fields = f.events[0].value.objectValue!
        try eventTapCheck(Set(fields.keys) == ["event", "kind", "pid"] && fields["pid"] == .integer(101), "Only the actual target PID and kind may cross the wire.")
    }
    try test {
        let f = EventTapFixture(); f.start()
        _ = f.send(EventTapSample(kind: .pointer, point: CGPoint(x: 6, y: 0)))
        _ = f.send(EventTapSample(kind: .pointer, point: CGPoint(x: 12, y: 0)))
        try eventTapCheck(f.order == ["input", "input"], "Small observed motions do not accumulate into takeover.")
        _ = f.send(EventTapSample(kind: .pointer, point: CGPoint(x: 20, y: 0)))
        try eventTapCheck(f.order.suffix(3).elementsEqual(["latch", "release", "input"]), "An observed eight-point motion latches before publication.")
    }
    try test {
        let f = EventTapFixture(); f.cursor = nil; f.start()
        _ = f.send(EventTapSample(kind: .pointer, point: CGPoint(x: 1, y: 1)))
        try eventTapCheck(f.order == ["latch", "release", "input"] && f.events[0].value.objectValue?["dx"] == nil, "Unknown logical displacement must conservatively pause.")
    }
    try test {
        for kind in [EventTapKind.click, .scroll, .flagsChanged, .keyUp] {
            let f = EventTapFixture(); f.start(); _ = f.send(EventTapSample(kind: kind))
            try eventTapCheck(f.order == ["latch", "release", "input"], "Every non-motion physical input category pauses a working foreground run.")
        }
    }
    try test {
        let f = EventTapFixture(); f.start()
        try eventTapCheck(f.send(f.escape()), "Accepted genuine Escape down must be consumed.")
        try eventTapCheck(f.order == ["halt", "release", "stop"], "Escape must halt and release before Stop publication.")
        try eventTapCheck(f.send(f.escape(repeated: true)) && f.events.count == 1, "A consumed physical press owns its repeats without duplicate Stop.")
        try eventTapCheck(f.send(f.escape(.keyUp)) && !f.send(f.escape(.keyUp)), "Only the matching consumed press owns one up.")
    }
    try test {
        let f = EventTapFixture(); f.start(); _ = f.send(f.escape())
        try eventTapCheck(!f.send(f.escape(.keyUp, source: 44)), "A foreign source up cannot be consumed for another press.")
        try eventTapCheck(f.send(f.escape(.keyUp)), "Foreign up must not retire the actual consumed press.")
    }
    try test {
        let f = EventTapFixture(); f.start(); _ = f.send(f.escape())
        f.fresh(mode: "background", esc: false)
        try eventTapCheck(!f.send(f.escape()) && !f.send(f.escape(.keyUp)), "A successor's fresh unrelated Escape down/up must pass through.")
    }
    try test {
        let f = EventTapFixture(); f.start(); f.accept = false
        try eventTapCheck(!f.send(f.escape()) && !f.send(f.escape(.keyUp)), "Rejected exact-session Stop must never consume a new press.")
        try eventTapCheck(f.events.isEmpty, "Rejected events cannot reach a successor.")
    }
    try test {
        let f = EventTapFixture(); f.start()
        f.beforeStop = { f.current?.observationEpoch = UUID() }
        try eventTapCheck(!f.send(f.escape()) && f.events.isEmpty, "Phase retirement between observation and Stop prevents consumption/publication.")
    }
    try test {
        let f = EventTapFixture(); f.start()
        f.beforeInput = { f.current?.observationEpoch = UUID() }
        _ = f.send(EventTapSample(kind: .keyDown, keyCode: 0))
        try eventTapCheck(f.events.isEmpty && f.order.isEmpty, "Exact-session input callback rejects a retired observation.")
    }
    try test {
        for mode in ["foreground", "background"] {
            let f = EventTapFixture(); f.current?.mode = mode; f.current?.paused = true; f.current?.escStops = false; f.start()
            let flags = CGEventFlags.maskCommand.rawValue | CGEventFlags.maskShift.rawValue
            try eventTapCheck(!f.send(f.escape(flags: flags)), "Stop chord observation does not reserve a background or paused key.")
            try eventTapCheck(f.events.last?.value.objectValue?["by"] == .string("chord"), "Configured chord stops in every session phase.")
        }
    }
    try test {
        let f = EventTapFixture(); f.current?.mode = "background"; f.current?.escStops = true; f.start()
        try eventTapCheck(!f.send(f.escape()), "Background Escape must pass even if a stale Esc setting is true.")
        _ = f.send(EventTapSample(kind: .keyDown, targetPID: 101, keyCode: 0))
        try eventTapCheck(!f.order.contains("latch") && f.events.count == 2, "Background physical presence remains observable without foreground takeover.")
    }
    try test {
        let f = EventTapFixture(); f.current?.escStops = false; f.start()
        _ = f.send(EventTapSample(kind: .click))
        try eventTapCheck(f.order == ["input"], "Nonworking foreground phases do not acquire physical takeover.")
    }
    try test {
        let f = EventTapFixture(); f.installed = false; f.enabled = false; f.start()
        try eventTapCheck(!f.monitor.status().enabled && !f.send(f.escape()) && f.events.isEmpty, "Denied installation cannot claim availability or consume input.")
        f.installed = true; f.enabled = true; f.monitor.recover()
        try eventTapCheck(f.recovery == 1 && f.monitor.status().enabled, "Recovery reports actual injected state.")
    }
    try test {
        let f = EventTapFixture(); f.start(); _ = f.send(f.escape())
        f.changed?(EventTapStatus(generation: 1, installed: true, enabled: false))
        f.monitor.recover()
        try eventTapCheck(!f.send(f.escape(.keyUp)), "Tap discontinuity retires unknown physical-press continuity.")
        f.monitor.probe(challenge: 81)
        try eventTapCheck(f.statuses.last?.challenge == 81 && f.statuses.last?.enabled == true, "Loop challenge replies retain actual generation and availability.")
    }
    try test {
        let f = EventTapFixture(); f.start()
        f.changed?(EventTapStatus(generation: 2, installed: true, enabled: true))
        f.changed?(EventTapStatus(generation: 1, installed: false, enabled: false, challenge: 7))
        try eventTapCheck(f.monitor.status().generation == 2 && f.monitor.status().enabled, "Old installation status cannot replace successor state.")
        f.monitor.close(); let count = f.statuses.count
        f.monitor.recover(); f.monitor.probe(challenge: 9); _ = f.send(f.escape())
        try eventTapCheck(f.statuses.count == count && !f.monitor.status().enabled && f.events.isEmpty, "Close revokes callbacks and prevents recovery from reopening authority.")
    }
    try test {
        let f = EventTapFixture(); f.queued = true; f.start()
        f.fresh(mode: "background", esc: false)
        let tasks = f.tasks; f.tasks.removeAll(); tasks.forEach { $0() }
        _ = f.send(EventTapSample(kind: .pointer, point: CGPoint(x: 1, y: 0)))
        try eventTapCheck(f.order == ["input"], "Queued configuration cannot restore a retired working phase.")
    }
    try test {
        let command = CGEventFlags.maskCommand.rawValue, shift = CGEventFlags.maskShift.rawValue
        let physical = EventTapChord.parse("Shift+Command+Q", layout: "azerty-measured", code: EventTapFixture.code)
        try eventTapCheck(physical?.code == 12 && physical?.flags == (command | shift), "Recorded letters preserve physical key positions across non-US layouts.")
        try eventTapCheck(EventTapChord.parse("Control+Alt+Shift+Escape", layout: "portable", code: EventTapFixture.code) != nil, "Portable chord observation is separate from OS shortcut registration policy.")
        for invalid in ["Command+Escape", "Command+Command+Escape", "Command+Shift+", "Command+Shift+A+Q", "Other", "Command+Shift+Ж"] {
            try eventTapCheck(EventTapChord.parse(invalid, layout: "synthetic", code: EventTapFixture.code) == nil, "Malformed chord must not invent a key mapping.")
        }
    }
    try test {
        let f = EventTapFixture(); f.start()
        f.afterSnapshot = {
            f.afterSnapshot = nil
            f.fresh()
        }
        _ = f.send(EventTapSample(kind: .pointer, point: CGPoint(x: 100, y: 0)))
        try eventTapCheck(f.events.isEmpty, "A phase hook between snapshot and reducer must reject the old event without mutating successor state.")
        _ = f.send(EventTapSample(kind: .pointer, point: CGPoint(x: 1, y: 0)))
        try eventTapCheck(f.order == ["input"], "A retired event must not poison the successor logical baseline.")
    }
    try test {
        let f = EventTapFixture(); f.start(); _ = f.send(f.escape())
        f.fresh(mode: "background", esc: false)
        try eventTapCheck(!f.send(f.escape(.keyUp)), "A successor authority must not inherit an isolated Escape up from retired authority.")
    }
    try test {
        let f = EventTapFixture(); f.start()
        let heldOSModifiers = CGEventFlags.maskCommand.rawValue | CGEventFlags.maskAlternate.rawValue
        try eventTapCheck(!f.send(f.escape(flags: heldOSModifiers)), "A reserved modified Escape must remain available to macOS when modifiers were already held.")
        try eventTapCheck(f.order == ["latch", "release", "input"] && f.events[0].value.objectValue?["kind"] == .string("key"), "Modified Escape is ordinary physical takeover when it is not the configured chord.")
    }
    try test {
        let command = CGEventFlags.maskCommand.rawValue, shift = CGEventFlags.maskShift.rawValue
        for spelling in ["Command+Shift+Minus", "Command+Shift+-"] {
            let binding = EventTapChord.parse(spelling, layout: "synthetic", code: EventTapFixture.code, resolve: EventTapFixture.punctuation)
            try eventTapCheck(binding?.code == 27 && binding?.flags == (command | shift), "Minus aliases preserve explicit modifiers and measured punctuation mapping.")
        }
        let plus = EventTapChord.parse("Command+Control+Plus", layout: "synthetic", code: EventTapFixture.code, resolve: EventTapFixture.punctuation)
        try eventTapCheck(plus?.code == 24 && plus?.flags == (command | CGEventFlags.maskControl.rawValue | shift), "Plus retains actual layout-required Shift.")
        let f = EventTapFixture(); f.withChord("Command+Shift+Plus"); f.start()
        _ = f.send(EventTapSample(kind: .keyDown, keyCode: 24, flags: command | shift))
        try eventTapCheck(f.events.last?.value.objectValue?["by"] == .string("chord"), "A valid punctuation chord must reach native Stop observation.")
    }
    try test {
        let f = EventTapFixture(); f.queued = true; f.start()
        try eventTapCheck(f.monitor.status().enabled && !f.monitor.status().bindingReady, "A healthy installed tap cannot stand in for completed chord binding.")
        let tasks = f.tasks; f.tasks.removeAll(); tasks.forEach { $0() }
        try eventTapCheck(f.monitor.status().bindingReady && f.monitor.status().bindingEpoch == f.current?.observationEpoch, "Completed binding must name the actual captured epoch.")
        f.withChord("Other"); f.monitor.refreshSession()
        let next = f.tasks; f.tasks.removeAll(); next.forEach { $0() }
        try eventTapCheck(f.monitor.status().enabled && !f.monitor.status().bindingReady, "Unsupported configured chord cannot report detection readiness.")
        f.withChord("Command+Shift+Escape"); f.queued = false; f.monitor.refreshSession()
        f.monitor.probe(challenge: 91)
        try eventTapCheck(f.monitor.status().bindingReady && f.monitor.status().challenge == 91, "A fresh accepted configuration and loop probe can recover without input or prompts.")
    }
    try test {
        try eventTapCheck(EventTapChord.parse("Command+Alt+Escape", layout: "synthetic", code: EventTapFixture.code) == nil, "Even private configuration cannot reserve Force Quit as a helper stop chord.")
    }
    try test {
        let f = EventTapFixture(); f.start(); f.keyboardAvailable = false
        f.monitor.probe(challenge: 101)
        try eventTapCheck(f.monitor.status().enabled && !f.monitor.status().bindingReady, "Loop liveness must not preserve an unavailable current keyboard binding.")
        f.keyboardAvailable = true; f.monitor.probe(challenge: 102)
        try eventTapCheck(f.monitor.status().bindingReady && f.monitor.status().bindingEpoch == f.current?.observationEpoch, "A valid measured binding can recover on a later real loop probe.")
        f.withChord("Command+Shift+Q"); f.monitor.refreshSession(); f.keyboardAvailable = false
        _ = f.send(EventTapSample(kind: .keyDown, keyCode: 12, flags: CGEventFlags.maskCommand.rawValue | CGEventFlags.maskShift.rawValue))
        try eventTapCheck(!f.monitor.status().bindingReady, "A fresh stop-key binding failure must immediately invalidate advertised binding health.")
    }
    try test {
        let f = EventTapFixture(); f.withChord("Command+Shift+Plus"); f.start()
        f.layoutName = "changed-measured-layout"; f.punctuationOffset = 6
        _ = f.send(EventTapSample(kind: .keyDown, keyCode: 30, flags: CGEventFlags.maskCommand.rawValue | CGEventFlags.maskShift.rawValue))
        try eventTapCheck(f.events.last?.value.objectValue?["by"] == .string("chord"), "A layout-dependent punctuation chord must resolve its new actual code before matching.")
    }
    return groups
}
