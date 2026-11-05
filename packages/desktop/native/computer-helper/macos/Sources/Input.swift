import CoreGraphics
import Darwin
import Dispatch
import Foundation

enum InputEventKind: String {
    case move, drag, buttonDown, buttonUp, keyDown, keyUp, unicodeDown, unicodeUp, scroll
}

/// Only native facts and bounded event data. The wire never chooses a source, tag or destination process witness.
struct InputPostedEvent: Equatable {
    let kind: InputEventKind
    var point: CGPoint = .zero
    var button: Int = 0
    var clickCount: Int = 1
    var keyCode: UInt16 = 0
    var flags: UInt64 = 0
    var dx: Int32 = 0
    var dy: Int32 = 0
    var pixelScroll = false
    var unicode: [UInt16] = []
    var destination: HelperProcessIdentity? = nil
    /// Hosted AX endpoints can differ from the actual foreground application; both are private witnesses.
    var foreground: HelperProcessIdentity? = nil
    var tag: Int64 = 0
}

struct InputKeyBinding: Equatable {
    let code: UInt16
    let flags: UInt64
    var isModifier = false
}

struct InputChord {
    let keys: [InputKeyBinding]
    let flags: UInt64
    let layout: String?
    var semanticKeys: [String]? = nil
}

struct InputMenuShortcut {
    let combo: [String]
    let label: String
}

struct InputObservation {
    let target: NativeTarget
    let window: CaptureWindowInfo
    var element: AccessibilityElement? = nil
    var menuShortcuts: [InputMenuShortcut]? = nil
}

struct InputBackend {
    let tag: Int64
    let preflight: () -> Bool
    let windows: () throws -> [CaptureWindowInfo]
    let owner: (pid_t) throws -> NativeOwner
    /// Native implementations authorize the metadata owner before any app-scoped AX observation.
    let pointer: (CGPoint, ServerSession) throws -> InputObservation
    let focused: (pid_t, ServerSession) throws -> InputObservation
    /// Validates actual AX equality against already-owned M4 references; never echoes request strings as proof.
    let bind: (InputObservation, NativeExpectedTarget, ServerSession) throws -> NativeTarget
    let resolve: ([String]) throws -> InputChord
    let layout: () -> String?
    /// false means no event was posted; a thrown uncertain failure retains its journaled release.
    let post: (InputPostedEvent) throws -> Bool
    let release: (InputPostedEvent) -> InputReleaseOutcome
    let reconcile: () -> Void
    var menus: ((InputObservation, ServerSession) throws -> [InputMenuShortcut]?)? = nil
}

enum InputReleaseOutcome { case released, discarded, retry }

private struct InputPoint { let x: Int; let y: Int }

private struct InputRequest {
    let op: String
    var captureID: String? = nil
    var points: [InputPoint] = []
    var expected: [NativeExpectedTarget] = []
    var pid: pid_t? = nil
    var button = 0
    var count = 1
    var modifiers: [String] = []
    var combo: [String] = []
    var repeats = 1
    var text = ""
    var milliseconds = 0
    var dx: Int32 = 0
    var dy: Int32 = 0
    var pixel = false

    init(op: String, args: [String: JSONValue], session: ServerSession) throws {
        self.op = op
        let phase: Set<String> = ["sessionId", "phaseRevision"]
        let target: Set<String> = ["pid", "windowId", "ref", "elementId"]
        let allowed: Set<String>
        switch op {
        case "input.click": allowed = phase.union(target).union(["captureId", "x", "y", "button", "count", "modifiers"])
        case "input.move": allowed = phase.union(target).union(["captureId", "x", "y"])
        case "input.scroll": allowed = phase.union(target).union(["captureId", "x", "y", "dx", "dy", "unit"])
        case "input.drag": allowed = phase.union(["captureId", "path", "targets", "button", "modifiers"])
        case "input.key": allowed = phase.union(target).union(["combo", "repeat"])
        case "input.type": allowed = phase.union(target).union(["text"])
        case "input.hold": allowed = phase.union(target).union(["combo", "ms"])
        default: throw ServerFailure(code: "unsupported_action", message: "This input operation is unavailable.")
        }
        guard Set(args.keys).isSubset(of: allowed) else { throw Self.invalid }
        if let revision = session.revision {
            guard args["sessionId"]?.stringValue == session.id, args["phaseRevision"]?.intValue == revision else { throw Self.changed }
        } else {
            guard args["sessionId"] == nil || args["sessionId"]?.stringValue == session.id,
                  args["phaseRevision"] == nil || args["phaseRevision"]?.intValue.map({ $0 >= 0 }) == true else { throw Self.changed }
        }
        if ["input.click", "input.move", "input.scroll", "input.drag"].contains(op) {
            guard let id = Self.id(args["captureId"]) else { throw Self.invalid }; captureID = id
            if op == "input.drag" {
                guard let path = args["path"]?.arrayValue, (2...50).contains(path.count) else { throw Self.invalid }
                points = try path.map { value in
                    guard let fields = value.objectValue, Set(fields.keys) == ["x", "y"],
                          let x = fields["x"]?.intValue, let y = fields["y"]?.intValue else { throw Self.invalid }
                    return InputPoint(x: x, y: y)
                }
                if let targets = args["targets"] {
                    guard let list = targets.arrayValue, list.count == path.count else { throw Self.invalid }
                    expected = try list.map { value in
                        guard let fields = value.objectValue, Set(fields.keys).isSubset(of: target) else { throw Self.invalid }
                        return try Self.target(fields)
                    }
                } else { expected = path.map { _ in NativeExpectedTarget() } }
            } else {
                guard let x = args["x"]?.intValue, let y = args["y"]?.intValue else { throw Self.invalid }
                points = [InputPoint(x: x, y: y)]; expected = [try Self.target(args)]
            }
            if op == "input.click" || op == "input.drag" {
                guard let button = args["button"]?.stringValue, ["left", "right", "middle"].contains(button) else { throw Self.invalid }
                self.button = button == "right" ? 1 : button == "middle" ? 2 : 0
                modifiers = try Self.names(args["modifiers"], empty: true)
            }
            if op == "input.click" {
                guard let count = args["count"]?.intValue, (1...3).contains(count) else { throw Self.invalid }; self.count = count
            }
            if op == "input.scroll" {
                guard let dx = args["dx"]?.intValue, let dy = args["dy"]?.intValue,
                      abs(Double(dx)) <= Double(Int32.max), abs(Double(dy)) <= Double(Int32.max),
                      args["unit"] == nil || args["unit"]?.stringValue == "pixel" else { throw Self.invalid }
                self.dx = Int32(dx); self.dy = Int32(dy); pixel = args["unit"] != nil
            }
        } else {
            guard let pid = Self.process(args["pid"]) else { throw Self.invalid }; self.pid = pid
            expected = [try Self.target(args)]
            if op == "input.type" {
                guard let text = args["text"]?.stringValue, (1...4000).contains(text.utf16.count) else { throw Self.invalid }
                self.text = text
            } else {
                combo = try Self.names(args["combo"])
                if op == "input.key" {
                    guard let count = args["repeat"]?.intValue, (1...20).contains(count) else { throw Self.invalid }; repeats = count
                } else {
                    guard let ms = args["ms"]?.intValue, (0...10000).contains(ms) else { throw Self.invalid }; milliseconds = ms
                }
            }
        }
    }

    private static func target(_ fields: [String: JSONValue]) throws -> NativeExpectedTarget {
        guard fields["pid"] == nil || process(fields["pid"]) != nil else { throw invalid }
        for key in ["windowId", "ref", "elementId"] where fields[key] != nil {
            guard id(fields[key]) != nil else { throw invalid }
        }
        return NativeExpectedTarget(pid: process(fields["pid"]).map(Int.init), windowID: fields["windowId"]?.stringValue,
            ref: fields["ref"]?.stringValue, elementID: fields["elementId"]?.stringValue)
    }
    private static func names(_ value: JSONValue?, empty: Bool = false) throws -> [String] {
        guard let list = value?.arrayValue, list.count <= 8, empty || !list.isEmpty else { throw invalid }
        return try list.map { item in
            guard let name = item.stringValue, !name.isEmpty, name.utf16.count <= 32,
                  !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw invalid }
            return name
        }
    }
    private static func id(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue, !text.isEmpty, text.utf16.count <= 256, !text.contains("\0") else { return nil }; return text
    }
    private static func process(_ value: JSONValue?) -> pid_t? {
        guard let value = value?.intValue, value > 0, value <= Int(Int32.max) else { return nil }; return pid_t(value)
    }
    private static var invalid: ServerFailure { ServerFailure(code: "failed", message: "The input arguments are invalid.") }
    private static var changed: ServerFailure { ServerFailure(code: "changed", message: "The input phase changed.") }
}

final class InputService {
    typealias Schedule = (Int, @escaping () -> Void) -> (() -> Void)
    private let captures: CaptureRegistry
    private let backend: InputBackend
    private let journal: HeldInputJournal
    private let execute: (@escaping () -> Void) -> Void
    private let schedule: Schedule
    private let now: () -> UInt64
    private let lock = NSLock()
    private var closed = false
    private var reconciled = false
    private var active: Flight?

    private final class Flight {
        let request: InputRequest
        let session: ServerSession
        let policy: SessionPolicy
        let context: OperationContext
        let completion: Dispatcher.Completion
        let lease: HeldInputLease
        let started: UInt64
        let deadline: UInt64
        var preparedAt: UInt64 = 0
        var prepared: InputObservation?
        var preparedPoint: CGPoint?
        var preparedFrame: CaptureGeometry?
        var baseline: InputObservation?
        var cancelTimer: (() -> Void)?

        init(request: InputRequest, session: ServerSession, policy: SessionPolicy, context: OperationContext,
             completion: @escaping Dispatcher.Completion, lease: HeldInputLease, started: UInt64) {
            self.request = request; self.session = session; self.policy = policy; self.context = context
            self.completion = completion; self.lease = lease; self.started = started
            deadline = started &+ UInt64(request.op == "input.hold" ? request.milliseconds + 10000 : 10000) * 1_000_000
        }
    }

    init(captures: CaptureRegistry = CaptureRegistry(), accessibility: AccessibilityService? = nil,
         backend: InputBackend? = nil, execute: ((@escaping () -> Void) -> Void)? = nil,
         schedule: Schedule? = nil, now: (() -> UInt64)? = nil) {
        let adapter = backend ?? InputNative.backend(accessibility: accessibility)
        self.captures = captures; self.backend = adapter
        self.now = now ?? { DispatchTime.now().uptimeNanoseconds }
        journal = HeldInputJournal(release: adapter.release, now: now)
        let queue = DispatchQueue(label: "ai.vector.computer.input")
        let timers = DispatchQueue(label: "ai.vector.computer.input-timers")
        self.execute = execute ?? { queue.async(execute: DispatchWorkItem(block: $0)) }
        self.schedule = schedule ?? { milliseconds, work in
            let item = DispatchWorkItem(block: work)
            timers.asyncAfter(deadline: .now() + .milliseconds(milliseconds), execute: item)
            return { item.cancel() }
        }
    }

    func features() -> [String: Bool] { ["input.pointer": true, "input.keyboard": true, "input.unicode": true] }

    /// Verified serving calls this explicitly; construction, version and probe paths remain inert.
    func reconcileOnStart() {
        lock.lock(); let allowed = !closed && !reconciled; reconciled = true; lock.unlock()
        if allowed { backend.reconcile() }
    }

    @discardableResult
    func releaseAll() -> Int {
        lock.lock(); let flight = active; active = nil; lock.unlock()
        let released = journal.releaseAll(deadlineMs: 300)
        flight?.cancelTimer?()
        return released
    }

    func close() {
        lock.lock(); closed = true; let flight = active; active = nil; lock.unlock()
        _ = journal.close(); flight?.cancelTimer?()
    }

    func handle(op: String, args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        execute { [self] in
            var lease: HeldInputLease?
            do {
                guard let session = context.session else { throw Self.failure("unavailable", "No computer session is active.") }
                let request = try InputRequest(op: op, args: args, session: session)
                let policy = try SessionPolicy(session: session)
                var startFailure: Error?
                guard context.withCurrent({
                    do {
                        try self.requireOpen()
                        guard self.backend.preflight() else { throw Self.permissions }
                        guard !session.paused else { throw Self.failure("paused", "The computer session is paused.") }
                        lease = try self.journal.begin()
                    } catch { startFailure = error }
                }), let owned = lease else { throw startFailure ?? Self.changed }
                let flight = Flight(request: request, session: session, policy: policy, context: context,
                    completion: completion, lease: owned, started: now())
                lock.lock()
                guard !closed, active == nil else { lock.unlock(); throw Self.changed }
                active = flight; lock.unlock()
                do { try run(flight) }
                catch { finish(flight, .failure(Self.failure(error))) }
            } catch {
                if let lease { _ = journal.release(lease: lease) }
                completion(.failure(Self.failure(error)))
            }
        }
    }

    private func run(_ flight: Flight) throws {
        let request = flight.request
        if request.op == "input.type" {
            for units in Self.unicodeChunks(request.text) {
                let observation = try keyboard(flight, chord: nil)
                var down = InputPostedEvent(kind: .unicodeDown)
                down.unicode = units; down.destination = observation.target.owner.process
                down.foreground = observation.target.grantOwner.process; down.tag = backend.tag
                let up = Self.up(down, kind: .unicodeUp)
                try scoped(flight) {
                    try self.journal.press(lease: flight.lease, id: "unicode", up: up) { try self.post(down, flight) }
                }
                guard journal.lift(lease: flight.lease, id: "unicode") else { throw Self.postFailed }
            }
            finish(flight, .success(ServerReply())); return
        }
        if request.op == "input.key" || request.op == "input.hold" {
            let chord = try backend.resolve(request.combo)
            try validate(chord)
            for _ in 0..<request.repeats {
                try chordDown(chord, flight: flight)
                if request.op == "input.hold" && request.milliseconds > 0 {
                    return
                }
                try liftChord(chord, flight)
            }
            finish(flight, .success(ServerReply())); return
        }
        let modifiers = request.modifiers.isEmpty ? nil : try backend.resolve(request.modifiers)
        if let modifiers {
            try validate(modifiers)
            let allowed = CGEventFlags.maskCommand.rawValue | CGEventFlags.maskControl.rawValue |
                CGEventFlags.maskShift.rawValue | CGEventFlags.maskAlternate.rawValue
            guard modifiers.keys.allSatisfy(\.isModifier), modifiers.flags & ~allowed == 0 else {
                throw Self.failure("failed", "Pointer modifiers must be modifier keys.")
            }
        }
        if request.op == "input.drag" {
            for (index, _) in request.points.enumerated() {
                let (point, observation) = try pointer(flight, index)
                var event = InputPostedEvent(kind: index == 0 ? .buttonDown : .drag)
                event.point = point; event.button = request.button; event.flags = modifiers?.flags ?? 0
                event.destination = observation.target.owner.process; event.tag = backend.tag
                let up = Self.up(event, kind: .buttonUp)
                try scoped(flight) {
                    if index == 0 { try self.journal.press(lease: flight.lease, id: "button", up: up) { try self.post(event, flight) } }
                    else { try self.journal.update(lease: flight.lease, id: "button", up: up) { try self.post(event, flight) } }
                }
            }
            _ = try pointer(flight, request.points.count - 1)
            try scoped(flight) { try self.journal.post(lease: flight.lease) { true } }
            guard journal.lift(lease: flight.lease, id: "button") else { throw Self.postFailed }
        } else {
            for click in 1...request.count {
                let (point, observation) = try pointer(flight, 0)
                var event = InputPostedEvent(kind: request.op == "input.click" ? .buttonDown : request.op == "input.move" ? .move : .scroll)
                event.point = point; event.button = request.button; event.clickCount = click
                event.flags = modifiers?.flags ?? 0; event.destination = observation.target.owner.process; event.tag = backend.tag
                event.dx = request.dx; event.dy = request.dy; event.pixelScroll = request.pixel
                try scoped(flight) {
                    if request.op == "input.click" {
                        let up = Self.up(event, kind: .buttonUp)
                        try self.journal.press(lease: flight.lease, id: "button", up: up) { try self.post(event, flight) }
                    } else { try self.journal.post(lease: flight.lease) { try self.post(event, flight) } }
                }
                if request.op == "input.click" {
                    _ = try pointer(flight, 0)
                    try scoped(flight) { try self.journal.post(lease: flight.lease) { true } }
                    guard journal.lift(lease: flight.lease, id: "button") else { throw Self.postFailed }
                }
            }
        }
        finish(flight, .success(ServerReply()))
    }

    private func scoped<T>(_ flight: Flight, _ body: () throws -> T) throws -> T {
        var result: Result<T, Error>?
        guard flight.context.withCurrent({
            result = Result {
                try self.requireActive(flight)
                guard self.backend.preflight() else { throw Self.permissions }
                try self.recheckPrepared(flight)
                return try body()
            }
        }), let result else { throw Self.changed }
        return try result.get()
    }

    private func pointer(_ flight: Flight, _ index: Int) throws -> (CGPoint, InputObservation) {
        try requireActive(flight)
        guard backend.preflight() else { throw Self.permissions }
        let request = flight.request
        guard let captureID = request.captureID else { throw Self.changed }
        let frame = try captures.get(captureID, sessionID: flight.session.id, observationEpoch: flight.session.observationEpoch,
            phaseRevision: flight.session.revision)
        let point = try frame.point(x: request.points[index].x, y: request.points[index].y)
        let windows = try catalog()
        let previous: CaptureWindowWitness
        if let id = frame.windowID {
            guard let process = frame.ownerProcess, let bounds = frame.windowFrame,
                  let witness = frame.windows.first(where: { $0.windowID == id }), witness.process == process, witness.bounds == bounds else { throw Self.stale }
            previous = witness
        } else {
            guard let witness = frame.windows.first(where: { $0.onScreen && $0.alpha > 0 && $0.bounds.contains(point) && !flight.session.overlayWindowIds.contains($0.windowID) }) else {
                throw Self.failure("out_of_bounds", "No captured native window is at that point.")
            }
            previous = witness
        }
        guard let current = windows.first(where: { $0.windowID == previous.windowID }), current.pid == previous.process.pid,
              current.bounds == previous.bounds, current.onScreen == previous.onScreen, current.alpha == previous.alpha,
              current.spaceWitness == previous.spaceWitness, try backend.owner(current.pid).process == previous.process else { throw Self.stale }
        guard current.onScreen, current.minimized != true else { throw Self.failure("needs_foreground", "The native window needs the foreground.") }
        let observation = try backend.pointer(point, flight.session)
        try coherent(observation)
        try flight.policy.requireTarget(observation.target, operation: .pointer)
        guard observation.window.windowID == previous.windowID else {
            throw Self.failure(frame.windowID == nil ? "changed" : "occluded", "Another native window covers the captured target.")
        }
        let surface = observation.target.hosted?.surface.process ?? observation.target.owner.process
        guard surface == previous.process else { throw Self.stale }
        if let hosted = previous.hosted {
            guard let current = observation.target.hosted, hosted.sameMapping(current) else { throw Self.stale }
        }
        guard observation.window.bounds == previous.bounds, observation.window.onScreen == previous.onScreen,
              observation.window.alpha == previous.alpha, observation.window.spaceWitness == previous.spaceWitness else { throw Self.stale }
        var expected = request.expected[index]; expected.process = observation.target.owner.process
        let target = try backend.bind(observation, expected, flight.session)
        try flight.policy.requireTarget(target, operation: .pointer, expected: expected)
        guard flight.session.mode == "foreground" else { throw Self.failure("needs_foreground", "This input needs the real pointer.") }
        try requireActive(flight)
        flight.preparedAt = now()
        flight.prepared = observation; flight.preparedPoint = point; flight.preparedFrame = frame
        return (point, observation)
    }

    private func keyboard(_ flight: Flight, chord: InputChord?) throws -> InputObservation {
        try requireActive(flight)
        guard backend.preflight() else { throw Self.permissions }
        guard let pid = flight.request.pid else { throw Self.changed }
        var observation = try backend.focused(pid, flight.session)
        try coherent(observation)
        guard observation.target.grantOwner.process.pid == pid else { throw Self.changed }
        try flight.policy.requireTarget(observation.target, operation: .observe)
        let menus = chord == nil ? nil : try backend.menus?(observation, flight.session) ?? observation.menuShortcuts
        if chord != nil && backend.menus != nil {
            try requireActive(flight)
            let fresh = try backend.focused(pid, flight.session)
            try coherent(fresh)
            guard sameFocus(observation, fresh) else { throw Self.changed }
            observation = fresh
        }
        if let baseline = flight.baseline {
            guard sameFocus(baseline, observation) else { throw Self.changed }
        }
        var expected = flight.request.expected[0]
        expected.process = flight.baseline?.target.owner.process ?? observation.target.owner.process
        let target = try backend.bind(observation, expected, flight.session)
        let text = chord.map { InputKeySafety.typesText(raw: flight.request.combo, chord: $0, menus: menus) } ?? true
        try flight.policy.requireTarget(target, operation: text ? .type : .key(flight.request.combo), expected: expected)
        guard flight.session.mode == "foreground", observation.window.onScreen, observation.window.minimized != true else {
            throw Self.failure("needs_foreground", "This keyboard target needs the foreground.")
        }
        if let chord {
            guard backend.layout() == chord.layout else { throw Self.changed }
            guard InputKeySafety.allowed(raw: flight.request.combo, chord: chord, menus: menus) else {
                throw Self.failure("blocked", "This keyboard shortcut is unavailable.")
            }
        }
        if flight.baseline == nil { flight.baseline = observation }
        try requireActive(flight)
        flight.preparedAt = now()
        flight.prepared = observation; flight.preparedPoint = nil; flight.preparedFrame = nil
        return observation
    }

    private func chordDown(_ chord: InputChord, flight: Flight) throws {
        var seen = Set<UInt16>()
        var flags: UInt64 = 0
        for key in Self.ordered(chord) {
            guard seen.insert(key.code).inserted else { throw Self.failure("failed", "A chord repeats a physical key.") }
            // Each down is fenced again, even within one chord, because a prior event can change app state.
            let current = try keyboard(flight, chord: chord)
            let before = flags
            if key.isModifier { flags |= key.flags }
            var event = InputPostedEvent(kind: .keyDown)
            event.keyCode = key.code; event.flags = key.isModifier ? flags : chord.flags
            event.destination = current.target.owner.process; event.foreground = current.target.grantOwner.process
            event.tag = backend.tag
            var up = Self.up(event, kind: .keyUp)
            up.flags = key.isModifier ? before : flags
            try scoped(flight) {
                try self.journal.press(lease: flight.lease, id: "key:\(key.code)", up: up) { try self.post(event, flight, layout: chord.layout) }
            }
        }
    }

    private func liftChord(_ chord: InputChord, _ flight: Flight) throws {
        for key in Self.ordered(chord).reversed() {
            guard journal.lift(lease: flight.lease, id: "key:\(key.code)") else { throw Self.postFailed }
        }
    }

    private func post(_ event: InputPostedEvent, _ flight: Flight, layout: String? = nil) throws -> Bool {
        try requireActive(flight, context: false)
        guard backend.preflight() else { throw Self.permissions }
        if let layout, backend.layout() != layout { throw Self.changed }
        if let id = flight.request.captureID {
            _ = try captures.get(id, sessionID: flight.session.id, observationEpoch: flight.session.observationEpoch,
                phaseRevision: flight.session.revision)
        }
        let current = now()
        guard current >= flight.preparedAt, current - flight.preparedAt <= 50_000_000 else { throw Self.changed }
        let result = try backend.post(event)
        if result, event.kind == .keyDown, flight.request.op == "input.hold", flight.request.milliseconds > 0 {
            armHold(flight)
        }
        try requireActive(flight, context: false)
        return result
    }

    /// No AX, menu or current-authority query may delay an owned hold's matching ups.
    private func armHold(_ flight: Flight) {
        lock.lock(); let needed = active === flight && flight.cancelTimer == nil; lock.unlock()
        guard needed else { return }
        let cancel = schedule(flight.request.milliseconds) { [weak self, weak flight] in
            guard let self, let flight else { return }
            _ = self.journal.release(lease: flight.lease)
            self.execute {
                do {
                    try self.requireActive(flight)
                    self.finish(flight, .success(ServerReply()))
                } catch { self.finish(flight, .failure(Self.failure(error))) }
            }
        }
        lock.lock()
        if active === flight && flight.cancelTimer == nil { flight.cancelTimer = cancel; lock.unlock() }
        else { lock.unlock(); cancel() }
    }

    /// Only fresh native metadata is checked under the short authority fence; AX work finished immediately before it.
    private func recheckPrepared(_ flight: Flight) throws {
        guard let prepared = flight.prepared else { throw Self.changed }
        let windows = try catalog()
        let actual: CaptureWindowInfo
        if let point = flight.preparedPoint {
            guard let window = windows.first(where: { $0.onScreen && $0.alpha > 0 && $0.bounds.contains(point) &&
                !flight.session.overlayWindowIds.contains($0.windowID) }) else { throw Self.changed }
            actual = window
        } else {
            guard let window = windows.first(where: { $0.windowID == prepared.window.windowID }) else { throw Self.changed }
            actual = window
        }
        let owner = try backend.owner(prepared.target.owner.process.pid)
        try flight.policy.requireTarget(NativeTarget(owner: owner, windowID: actual.windowID, secure: prepared.target.secure,
            hosted: prepared.target.hosted), operation: .pointer)
        if actual.windowID != prepared.window.windowID {
            throw Self.failure(flight.preparedFrame?.windowID == nil ? "changed" : "occluded", "The native input target changed.")
        }
        guard actual.pid == prepared.window.pid, owner.process == prepared.target.owner.process,
              owner.identity == prepared.target.owner.identity, actual.bounds == prepared.window.bounds,
              actual.alpha == prepared.window.alpha, actual.onScreen == prepared.window.onScreen,
              actual.minimized == prepared.window.minimized, actual.spaceWitness == prepared.window.spaceWitness else {
            throw flight.preparedPoint == nil ? Self.changed : Self.stale
        }
        if let proof = prepared.target.hosted {
            guard proof.surface.process == (try backend.owner(actual.pid)).process,
                  proof.surface.bounds == actual.bounds, proof.surface.onScreen == actual.onScreen,
                  proof.surface.alpha == actual.alpha, proof.surface.spaceWitness == actual.spaceWitness else { throw Self.changed }
        }
    }

    private func sameFocus(_ first: InputObservation, _ second: InputObservation) -> Bool {
        guard first.target.owner.process == second.target.owner.process, first.window.windowID == second.window.windowID,
              first.target.grantOwner.process == second.target.grantOwner.process, first.target.hosted == second.target.hosted,
              first.window.bounds == second.window.bounds, first.window.spaceWitness == second.window.spaceWitness else { return false }
        if let first = first.element, let second = second.element { return AccessibilityElement.equivalent(first, second) }
        return first.element == nil && second.element == nil
    }

    private func finish(_ flight: Flight, _ result: Result<ServerReply, ServerFailure>) {
        _ = journal.release(lease: flight.lease)
        let completed: Result<ServerReply, ServerFailure>
        if journal.pending(lease: flight.lease), case .success = result { completed = .failure(Self.postFailed) }
        else { completed = result }
        lock.lock()
        guard active === flight else { lock.unlock(); return }
        active = nil; let canceled = closed; lock.unlock()
        flight.cancelTimer?()
        guard !canceled, flight.context.isCurrent() else { flight.completion(.failure(Self.changed)); return }
        flight.completion(completed)
    }

    private func requireOpen() throws { lock.lock(); defer { lock.unlock() }; guard !closed else { throw Self.changed } }
    private func requireActive(_ flight: Flight, context: Bool = true) throws {
        lock.lock(); let valid = !closed && active === flight; lock.unlock()
        guard valid, !context || flight.context.isCurrent() else { throw Self.changed }
        let current = now()
        guard current >= flight.started, current < flight.deadline else { throw Self.failure("timeout", "The input operation timed out.") }
    }
    private func coherent(_ observation: InputObservation) throws {
        let surface = observation.target.hosted?.surface.process ?? observation.target.owner.process
        guard observation.window.pid == surface.pid,
              observation.target.owner.identity.pid == Int(observation.target.owner.process.pid),
              observation.target.windowID == observation.window.windowID, CapturePrivacy.valid(observation.window.bounds) else { throw Self.changed }
    }
    private func catalog() throws -> [CaptureWindowInfo] {
        let windows = try backend.windows()
        guard windows.count <= 4096, Set(windows.map(\.windowID)).count == windows.count,
              windows.allSatisfy({ $0.pid > 0 && CapturePrivacy.valid($0.bounds) && $0.alpha.isFinite && (0...1).contains($0.alpha) }) else { throw Self.stale }
        return windows
    }
    private func validate(_ chord: InputChord) throws {
        guard !chord.keys.isEmpty, chord.keys.count <= 8, Set(chord.keys.map(\.code)).count == chord.keys.count,
              chord.layout.map({ !$0.isEmpty && $0.utf8.count <= 1024 }) ?? true else { throw Self.failure("failed", "The native key binding is invalid.") }
    }
    private static func up(_ event: InputPostedEvent, kind: InputEventKind) -> InputPostedEvent {
        var result = event
        switch kind {
        case .buttonUp:
            result = InputPostedEvent(kind: .buttonUp); result.point = event.point; result.button = event.button
            result.clickCount = event.clickCount; result.flags = event.flags
        case .keyUp: result = InputPostedEvent(kind: .keyUp); result.keyCode = event.keyCode
        case .unicodeUp: result = InputPostedEvent(kind: .unicodeUp); result.unicode = event.unicode
        default: break
        }
        result.destination = kind == .buttonUp ? nil : event.destination; result.tag = event.tag
        result.foreground = event.foreground
        return result
    }
    static func unicodeChunks(_ text: String) -> [[UInt16]] {
        var chunks: [[UInt16]] = [], current: [UInt16] = []
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16)
            if current.count + units.count > 20 { chunks.append(current); current = [] }
            current.append(contentsOf: units)
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
    private static func ordered(_ chord: InputChord) -> [InputKeyBinding] {
        chord.keys.filter(\.isModifier) + chord.keys.filter { !$0.isModifier }
    }
    private static var changed: ServerFailure { failure("changed", "The input operation is no longer current.") }
    private static var permissions: ServerFailure { failure("permissions", "Accessibility input is not granted.") }
    private static var stale: ServerFailure { failure("stale_frame", "The captured native geometry changed.") }
    private static var postFailed: ServerFailure { failure("failed", "The owned input release did not complete.") }
    private static func failure(_ code: String, _ message: String) -> ServerFailure { ServerFailure(code: code, message: message) }
    private static func failure(_ error: Error) -> ServerFailure { error as? ServerFailure ?? failure("failed", "The native input operation failed.") }
}
