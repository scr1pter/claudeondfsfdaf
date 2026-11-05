import CoreGraphics
import Darwin
import Foundation

private struct InputTestFailure: Error { let message: String }

private func inputCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw InputTestFailure(message: message) }
}

private func inputOwner(_ bundle: String = "example.input.fixture", pid: pid_t = 101,
                        start: UInt64 = 10) -> NativeOwner {
    let executable = "/virtual/\(pid).app/Contents/MacOS/Fixture"
    return NativeOwner(identity: MacAppIdentity(bundleId: bundle, teamId: "ABCDEFGHIJ", apple: false,
        system: false, verified: true, name: "Synthetic input owner", path: executable, pid: Int(pid)),
        process: HelperProcessIdentity(pid: pid, parentPID: 1, startSeconds: start, startMicroseconds: 20,
                                       executable: executable), childShell: false)
}

private final class InputTestTimer {
    let due: UInt64
    let work: () -> Void
    var canceled = false
    init(due: UInt64, work: @escaping () -> Void) { self.due = due; self.work = work }
}

private final class InputTestState {
    let tag: Int64 = 0x564543544f52
    var owner = inputOwner()
    var keyboardPID: pid_t?
    var granted = true
    var denyInsideFence = false
    var epoch = 1
    var insideFence = false
    var refuseFence = false
    var clock: UInt64 = 1_000_000_000
    var holdWork = false
    var work: [() -> Void] = []
    var timers: [InputTestTimer] = []
    var delays: [Int] = []
    var preflights = 0
    var windowReads = 0
    var ownerPIDs: [pid_t] = []
    var extraOwners: [pid_t: NativeOwner] = [:]
    var windowsOverride: [CaptureWindowInfo]?
    var pointerPoints: [CGPoint] = []
    var focusedPIDs: [pid_t] = []
    var bindings: [NativeExpectedTarget] = []
    var resolved: [[String]] = []
    var layoutName: String? = "synthetic-azerty"
    var semanticOverride: [String]?
    var posts: [InputPostedEvent] = []
    var stream: [InputPostedEvent] = []
    var postFences: [Bool] = []
    var releases: [InputPostedEvent] = []
    var reconciliations = 0
    var postResult = true
    var throwPostAt: Int?
    var releaseResult = InputReleaseOutcome.released
    var secure: Bool? = false
    var windowID = "1010"
    var windowBounds = CGRect(x: -100, y: -50, width: 150, height: 100)
    var onScreen = true
    var minimized: Bool? = false
    var space: String? = "synthetic-space"
    var ref = "native_synthetic_ref"
    var elementID = "native_synthetic_element"
    var menuShortcuts: [InputMenuShortcut]? = [InputMenuShortcut(combo: ["Command", "s"], label: "Save")]
    var menuReads = 0
    var onPointer: ((CGPoint) -> Void)?
    var onFocused: ((pid_t) -> Void)?
    var onBind: (() -> Void)?
    var onPost: ((InputPostedEvent) -> Void)?
    var onFence: (() -> Void)?
    var pointerOverride: InputObservation?
    var focusedOverride: InputObservation?
    var results: [Result<ServerReply, ServerFailure>] = []
    var element = AccessibilityElement()
    var referenceElement: AccessibilityElement?

    var observation: InputObservation {
        let window = CaptureWindowInfo(windowID: windowID, pid: owner.process.pid, bounds: windowBounds,
            onScreen: onScreen, minimized: minimized, owner: owner, regularOwner: true, spaceWitness: space)
        return InputObservation(target: NativeTarget(owner: owner, windowID: windowID, secure: secure), window: window,
                                element: element, menuShortcuts: menuShortcuts)
    }

    func chord(_ names: [String]) throws -> InputChord {
        resolved.append(names)
        var keys: [InputKeyBinding] = []
        var flags: UInt64 = 0
        for name in names {
            let key = name.lowercased()
            let modifier: (UInt16, UInt64)?
            switch key {
            case "command", "cmd", "meta", "⌘": modifier = (55, CGEventFlags.maskCommand.rawValue)
            case "shift", "shiftleft", "⇧": modifier = (56, CGEventFlags.maskShift.rawValue)
            case "control", "ctrl", "controlleft", "⌃": modifier = (59, CGEventFlags.maskControl.rawValue)
            case "option", "alt", "⌥": modifier = (58, CGEventFlags.maskAlternate.rawValue)
            default: modifier = nil
            }
            if let (code, flag) = modifier {
                keys.append(InputKeyBinding(code: code, flags: flag, isModifier: true)); flags |= flag
            } else {
                // Deliberately synthetic/non-US: the service must honor its resolver instead of assuming ASCII/US codes.
                let mapping: [String: UInt16] = ["a": 12, "keya": 12, "s": 1, "keys": 1, "v": 9, "keyv": 9, "keyx": 7,
                    "4": 21, "enter": 36, "return": 36, "escape": 53, "esc": 53, "arrowleft": 123,
                    "tab": 48, "insert": 114, "ins": 114]
                guard let code = mapping[key] else { throw ServerFailure(code: "unsupported_action", message: "No synthetic key binding.") }
                keys.append(InputKeyBinding(code: code, flags: 0))
            }
        }
        return InputChord(keys: keys, flags: flags, layout: layoutName, semanticKeys: semanticOverride ?? names)
    }

    func drain() { while !work.isEmpty { work.removeFirst()() } }

    func runTimers() throws {
        for _ in 0..<2000 {
            guard let next = timers.filter({ !$0.canceled }).min(by: { $0.due < $1.due }) else { drain(); return }
            clock = max(clock, next.due); next.canceled = true; next.work(); drain()
        }
        throw InputTestFailure(message: "Synthetic input timers did not quiesce")
    }
}

private final class InputFixture {
    let state: InputTestState
    let captures: CaptureRegistry
    var session: ServerSession
    let service: InputService

    init(approved: Bool = true, paused: Bool = false, mode: String = "foreground",
         backgroundType: (([String: JSONValue], OperationContext, @escaping Dispatcher.Completion) -> Void)? = nil) {
        let state = InputTestState()
        state.referenceElement = state.element
        let captures = CaptureRegistry()
        self.state = state; self.captures = captures
        self.session = ServerSession(id: "synthetic-input", revision: 1, mode: mode, paused: paused,
            approved: approved ? [state.owner.identity.wire] : [], vectorPids: [900], vectorWindowIds: ["9000"],
            overlayWindowIds: ["9001"], escStops: true, stopChord: "Command+Shift+Escape")
        self.service = InputService(captures: captures, backend: InputBackend(
            tag: state.tag,
            preflight: {
                state.preflights += 1
                let observed = !state.focusedPIDs.isEmpty || !state.pointerPoints.isEmpty
                return state.granted && !(state.insideFence && state.denyInsideFence && observed)
            },
            windows: { state.windowReads += 1; return state.windowsOverride ?? [state.observation.window] },
            owner: { pid in
                state.ownerPIDs.append(pid)
                if pid == state.owner.process.pid { return state.owner }
                if let owner = state.extraOwners[pid] { return owner }
                throw ServerFailure(code: "changed", message: "The synthetic captured process changed.")
            },
            pointer: { point, _ in
                state.pointerPoints.append(point); state.onPointer?(point)
                return state.pointerOverride ?? state.observation
            },
            focused: { pid, _ in
                state.focusedPIDs.append(pid); state.onFocused?(pid)
                return state.focusedOverride ?? state.observation
            },
            bind: { observation, expected, _ in
                state.bindings.append(expected); state.onBind?()
                if expected.ref != nil || expected.elementID != nil {
                    guard observation.element?.identity == state.referenceElement?.identity else {
                        throw ServerFailure(code: "changed", message: "The synthetic private AX reference points to another object.")
                    }
                }
                if let ref = expected.ref, ref != state.ref {
                    throw ServerFailure(code: "changed", message: "The synthetic native ref changed.")
                }
                if let element = expected.elementID, element != state.elementID {
                    throw ServerFailure(code: "changed", message: "The synthetic native element changed.")
                }
                var target = observation.target
                target.ref = state.ref; target.elementID = state.elementID
                return target
            },
            resolve: { try state.chord($0) },
            layout: { state.layoutName },
            post: { event in
                state.posts.append(event); state.stream.append(event); state.postFences.append(state.insideFence); state.onPost?(event)
                if state.throwPostAt == state.posts.count { throw ServerFailure(code: "failed", message: "Uncertain synthetic posting failure.") }
                return state.postResult
            },
            release: { event in state.releases.append(event); state.stream.append(event); return state.releaseResult },
            reconcile: { state.reconciliations += 1 },
            menus: { _, _ in state.menuReads += 1; return state.menuShortcuts },
            backgroundType: backgroundType
        ), execute: { work in if state.holdWork { state.work.append(work) } else { work() } },
        schedule: { milliseconds, work in
            state.delays.append(milliseconds)
            let timer = InputTestTimer(due: state.clock + UInt64(max(0, milliseconds)) * 1_000_000, work: work)
            state.timers.append(timer)
            return { timer.canceled = true }
        }, now: { state.clock })
    }

    func context() -> OperationContext {
        let state = state
        let epoch = state.epoch
        return OperationContext(session: session, isCurrent: { state.epoch == epoch }, withCurrent: { body in
            guard state.epoch == epoch, !state.refuseFence else { return false }
            let previous = state.insideFence
            state.insideFence = true
            defer { state.insideFence = previous }
            state.onFence?()
            body()
            return true
        })
    }

    func retainCapture(windowCapture: Bool = false, zoom: Bool = false) throws -> String {
        let id = "cap_synthetic_input"
        try captures.store(CaptureGeometry(captureID: id, displayID: "1", bounds: state.windowBounds,
            nativePixelSize: CGSize(width: 300, height: 200), captureScale: 2, width: 300, height: 200, imageScale: 2,
            sessionID: session.id, observationEpoch: session.observationEpoch, phaseRevision: session.revision,
            configurationGeneration: captures.generation, windowID: windowCapture ? state.windowID : nil,
            windowFrame: windowCapture ? state.windowBounds : nil, ownerProcess: windowCapture ? state.owner.process : nil,
            windows: [CaptureWindowWitness(windowID: state.windowID, process: state.owner.process,
                bounds: state.windowBounds, onScreen: state.onScreen, minimized: state.minimized ?? false, spaceWitness: state.space)],
            spaceWitness: windowCapture ? state.space : nil, zoomSourceID: zoom ? "cap_original" : nil))
        return id
    }

    func phase() -> [String: JSONValue] { ["sessionId": .string(session.id), "phaseRevision": .integer(Int64(session.revision ?? 0))] }

    func pointerArgs(_ capture: String, x: Int = 20, y: Int = 20) -> [String: JSONValue] {
        var args = phase()
        args["captureId"] = .string(capture); args["x"] = .integer(Int64(x)); args["y"] = .integer(Int64(y))
        return args
    }

    func clickArgs(_ capture: String, count: Int = 1) -> [String: JSONValue] {
        var args = pointerArgs(capture)
        args["button"] = .string("left"); args["count"] = .integer(Int64(count)); args["modifiers"] = .array([])
        return args
    }

    func keyArgs(_ combo: [String] = ["Command", "s"], repeat count: Int = 1) -> [String: JSONValue] {
        var args = phase(); args["pid"] = .integer(Int64(state.keyboardPID ?? state.owner.process.pid))
        args["combo"] = .array(combo.map(JSONValue.string)); args["repeat"] = .integer(Int64(count))
        return args
    }

    func typeArgs(_ text: String = "Synthetic text") -> [String: JSONValue] {
        var args = phase(); args["pid"] = .integer(Int64(state.keyboardPID ?? state.owner.process.pid)); args["text"] = .string(text)
        return args
    }

    func holdArgs(_ combo: [String] = ["Command", "s"], milliseconds: Int = 500) -> [String: JSONValue] {
        var args = keyArgs(combo); args.removeValue(forKey: "repeat"); args["ms"] = .integer(Int64(milliseconds)); return args
    }

    func dragArgs(_ capture: String) -> [String: JSONValue] {
        var args = phase(); args["captureId"] = .string(capture)
        args["path"] = .array([["x": JSONValue.integer(20), "y": .integer(20)],
                                ["x": .integer(40), "y": .integer(20)],
                                ["x": .integer(60), "y": .integer(30)]].map(JSONValue.object))
        args["button"] = .string("left"); args["modifiers"] = .array([]); return args
    }

    func call(_ operation: String, _ args: [String: JSONValue], context: OperationContext? = nil) {
        service.handle(op: operation, args: args, context: context ?? self.context()) { self.state.results.append($0) }
    }

    func success() throws -> [String: JSONValue] {
        guard let result = state.results.last, case .success(let reply) = result else {
            throw InputTestFailure(message: "Expected a successful synthetic input result")
        }
        return reply.fields
    }

    func failure() -> String? {
        guard let result = state.results.last, case .failure(let error) = result else { return nil }
        return error.code
    }

    /// Reuses the actual injected host resolver's private proof; no request string fabricates a mapping.
    @discardableResult
    func hosted(_ host: HostOwnershipTestFixture, secure: Bool? = false) throws -> HostedWindowProof {
        let session = host.session()
        let proof = try host.proof(session: session)
        configureHost(host, session: session, proof: proof, secure: secure)
        return proof
    }

    func configureHost(_ host: HostOwnershipTestFixture, session: ServerSession,
                       proof: HostedWindowProof?, secure: Bool? = false) {
        self.session = session
        state.owner = host.physical; state.extraOwners[host.logical.process.pid] = host.logical
        state.keyboardPID = host.logical.process.pid
        state.windowsOverride = host.windows
        state.windowID = host.surface.windowID; state.windowBounds = host.surface.bounds
        state.onScreen = host.surface.onScreen; state.minimized = host.surface.minimized; state.space = host.surface.spaceWitness
        state.element = host.physicalRoot; state.referenceElement = host.physicalRoot
        let observation = InputObservation(target: NativeTarget(owner: host.physical, windowID: host.surface.windowID,
            secure: secure, hosted: proof), window: host.surface, element: host.physicalRoot, menuShortcuts: state.menuShortcuts)
        state.pointerOverride = observation; state.focusedOverride = observation
    }

    func retainHostedCapture(_ proof: HostedWindowProof, windowCapture: Bool = false) throws -> String {
        let id = "cap_synthetic_host_input"
        let surface = proof.surface
        try captures.store(CaptureGeometry(captureID: id, displayID: "1", bounds: surface.bounds,
            nativePixelSize: CGSize(width: 600, height: 400), captureScale: 2, width: 600, height: 400, imageScale: 2,
            sessionID: session.id, observationEpoch: session.observationEpoch, phaseRevision: session.revision,
            configurationGeneration: captures.generation, windowID: windowCapture ? surface.windowID : nil,
            windowFrame: windowCapture ? surface.bounds : nil, ownerProcess: windowCapture ? surface.process : nil,
            windows: [CaptureWindowWitness(windowID: surface.windowID, process: surface.process, bounds: surface.bounds,
                onScreen: surface.onScreen, minimized: false, alpha: surface.alpha, spaceWitness: surface.spaceWitness, hosted: proof)],
            spaceWitness: windowCapture ? surface.spaceWitness : nil))
        return id
    }
}

/// Native event posting, process/window/AX reads, keyboard layouts, clocks and timers are entirely injected.
/// Descriptors are plain values: no CGEvent, event source, OS input, native screen or permission API is constructed.
func runInputTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let fake = InputFixture()
        for feature in ["input.pointer", "input.keyboard", "input.unicode"] {
            try inputCheck(fake.service.features()[feature] == true, "Implemented native input feature groups are advertised")
        }
        try inputCheck(fake.state.posts.isEmpty && fake.state.pointerPoints.isEmpty && fake.state.focusedPIDs.isEmpty,
                       "Creating the injected service and reporting features never posts input or inspects a target")
        try inputCheck(fake.state.reconciliations == 0, "Probe-style service construction never reconciles a native source")
        fake.service.reconcileOnStart(); fake.service.reconcileOnStart()
        try inputCheck(fake.state.reconciliations == 1 && fake.state.posts.isEmpty,
                       "Verified serving invokes its injected startup reconciliation exactly once")
    }

    try test {
        let fake = InputFixture()
        let capture = try fake.retainCapture()
        fake.call("input.move", fake.pointerArgs(capture))
        try fake.state.runTimers()
        _ = try fake.success()
        let moves = fake.state.posts.filter { $0.kind == .move }
        try inputCheck(moves.count == 1 && moves[0].point == CGPoint(x: -89.75, y: -39.75),
                       "Screenshot pixel centers map exactly across Retina scale and a negative global origin")
        try inputCheck(fake.state.postFences.allSatisfy { $0 } && fake.state.posts.allSatisfy { $0.tag == fake.state.tag },
                       "Every normal event is posted inside the current authority fence with the helper's private tag")
        try inputCheck(!fake.state.pointerPoints.isEmpty && fake.state.pointerPoints.last == moves[0].point,
                       "The native point is re-observed immediately for the mapped target")
    }

    try test {
        for count in 1...3 {
            let fake = InputFixture()
            let capture = try fake.retainCapture()
            fake.call("input.click", fake.clickArgs(capture, count: count))
            try fake.state.runTimers()
            _ = try fake.success()
            let down = fake.state.stream.filter { $0.kind == .buttonDown }
            let up = fake.state.stream.filter { $0.kind == .buttonUp }
            try inputCheck(down.count == count && up.count == count && down.allSatisfy { $0.button == 0 },
                           "Single, double and triple clicks emit complete down/up pairs for the requested button")
            try inputCheck(down.map(\.clickCount) == Array(1...count), "Native click-state counts identify each click in a sequence")
            try inputCheck(fake.service.releaseAll() == 0, "A completed click leaves no synthetic button held")
        }
    }

    try test {
        let fake = InputFixture()
        let capture = try fake.retainCapture()
        var args = fake.clickArgs(capture)
        args["button"] = .string("right"); args["modifiers"] = .array([.string("Shift")])
        fake.call("input.click", args)
        try fake.state.runTimers()
        _ = try fake.success()
        let buttons = fake.state.stream.filter { $0.kind == .buttonDown || $0.kind == .buttonUp }
        try inputCheck(buttons.count == 2 && buttons.allSatisfy { $0.button == 1 && $0.flags & CGEventFlags.maskShift.rawValue != 0 },
                       "Pointer down and up retain the same explicit requested modifiers without synthesizing modifier-key ownership")
    }

    try test {
        let fake = InputFixture()
        let capture = try fake.retainCapture()
        var args = fake.pointerArgs(capture)
        args["dx"] = .integer(-13); args["dy"] = .integer(27); args["unit"] = .string("pixel")
        fake.call("input.scroll", args)
        try fake.state.runTimers()
        _ = try fake.success()
        let scroll = fake.state.posts.filter { $0.kind == .scroll }
        try inputCheck(scroll.count == 1 && scroll[0].dx == -13 && scroll[0].dy == 27 && scroll[0].pixelScroll,
                       "Pixel scroll preserves signed horizontal/vertical amounts without changing units")
    }

    try test {
        let fake = InputFixture()
        let capture = try fake.retainCapture()
        fake.state.granted = false
        fake.call("input.click", fake.clickArgs(capture))
        try inputCheck(fake.failure() == "permissions" && fake.state.windowReads == 0 && fake.state.ownerPIDs.isEmpty &&
                       fake.state.pointerPoints.isEmpty && fake.state.posts.isEmpty,
                       "Missing event permission is refused before geometry, owner lookup or posting")
        let invalid = InputFixture()
        invalid.call("input.move", invalid.pointerArgs("missing_capture"))
        try inputCheck(invalid.failure() == "stale_frame" && invalid.state.pointerPoints.isEmpty && invalid.state.posts.isEmpty,
                       "Unknown frame authority is refused before point ownership can be inspected")
    }

    try test {
        for zoom in [false, true] {
            let fake = InputFixture()
            let capture = try fake.retainCapture(zoom: zoom)
            if !zoom { fake.captures.invalidateDisplays() }
            fake.call("input.move", fake.pointerArgs(capture))
            try inputCheck(fake.failure() == "stale_frame" && fake.state.pointerPoints.isEmpty && fake.state.posts.isEmpty,
                           "Display reconfiguration and zoom-only frames cannot authorize coordinate input")
        }
        let outside = InputFixture()
        let capture = try outside.retainCapture()
        outside.call("input.move", outside.pointerArgs(capture, x: 300))
        try inputCheck(outside.failure() == "out_of_bounds" && outside.state.posts.isEmpty,
                       "A pixel equal to image width is outside the input coordinate space")
    }

    try test {
        for change in 0..<3 {
            let fake = InputFixture()
            let capture = try fake.retainCapture(windowCapture: true)
            if change == 0 { fake.state.windowBounds.origin.x += 1 }
            if change == 1 { fake.state.space = "different-native-space" }
            if change == 2 { fake.state.owner = inputOwner(start: 11) }
            fake.call("input.click", fake.clickArgs(capture))
            try inputCheck(fake.failure() == "stale_frame" && fake.state.posts.isEmpty,
                           "Moved, re-spaced or replacement-process windows invalidate their captured coordinate authority")
        }
        let duringObservation = InputFixture()
        let capture = try duringObservation.retainCapture(windowCapture: true)
        duringObservation.state.windowsOverride = [duringObservation.state.observation.window]
        duringObservation.state.onPointer = { _ in duringObservation.state.windowBounds.origin.x += 1 }
        duringObservation.call("input.click", duringObservation.clickArgs(capture))
        try inputCheck(duringObservation.failure() == "stale_frame" && duringObservation.state.posts.isEmpty,
                       "A frame change between catalog and actual pointer observation cannot reuse the old screenshot coordinates")
        for ownerChange in [false, true] {
            let atCommit = InputFixture()
            let capture = try atCommit.retainCapture(windowCapture: true)
            atCommit.state.onFence = {
                if !atCommit.state.pointerPoints.isEmpty {
                    if ownerChange { atCommit.state.owner = inputOwner(start: 11) }
                    else { atCommit.state.windowBounds.origin.x += 1 }
                }
            }
            atCommit.call("input.click", atCommit.clickArgs(capture))
            try inputCheck(["stale_frame", "changed"].contains(atCommit.failure() ?? "") && atCommit.state.posts.isEmpty,
                           "Changing the private process or window at commit entry is refused even within the 50ms freshness bound")
        }
    }

    try test {
        for windowCapture in [false, true] {
            let fake = InputFixture()
            let capture = try fake.retainCapture(windowCapture: windowCapture)
            let other = inputOwner("example.input.other", pid: 202)
            let window = CaptureWindowInfo(windowID: "2020", pid: 202, bounds: fake.state.windowBounds,
                onScreen: true, minimized: false, owner: other, regularOwner: true)
            fake.state.extraOwners[202] = other
            fake.state.windowsOverride = [window, fake.state.observation.window]
            fake.state.pointerOverride = InputObservation(target: NativeTarget(owner: other, windowID: "2020", secure: false), window: window)
            fake.session.approved.append(other.identity.wire)
            fake.call("input.click", fake.clickArgs(capture))
            try inputCheck(fake.failure() == (windowCapture ? "occluded" : "changed") && fake.state.posts.isEmpty,
                           "A newly frontmost approved owner cannot steal a captured click; independent windows report occlusion")
        }
    }

    try test {
        for protected in [false, true] {
            let fake = InputFixture(approved: false)
            if protected { fake.state.owner = inputOwner("com.apple.Terminal") }
            let capture = try fake.retainCapture()
            fake.call("input.click", fake.clickArgs(capture))
            try inputCheck(fake.failure() == (protected ? "protected" : "not_granted") && fake.state.posts.isEmpty,
                           "Native never-list and task allowlist refusals happen before any pointer event")
        }
    }

    try test {
        for field in ["pid", "windowId", "ref", "elementId"] {
            let fake = InputFixture()
            let capture = try fake.retainCapture()
            var args = fake.clickArgs(capture)
            args[field] = field == "pid" ? .integer(202) : .string("different-native-witness")
            fake.call("input.click", args)
            try inputCheck(["changed", "stale_ref"].contains(fake.failure() ?? "") && fake.state.posts.isEmpty,
                           "Every supplied native pointer target witness is validated before posting")
        }
        let matching = InputFixture()
        let capture = try matching.retainCapture()
        var args = matching.clickArgs(capture)
        args["pid"] = .integer(101); args["windowId"] = .string("1010")
        args["ref"] = .string(matching.state.ref); args["elementId"] = .string(matching.state.elementID)
        matching.call("input.click", args); try matching.state.runTimers()
        _ = try matching.success()
        try inputCheck(matching.state.bindings.contains { $0.ref == matching.state.ref && $0.elementID == matching.state.elementID },
                       "Valid expected refs require the private native binding adapter rather than echoing request strings")
    }

    try test {
        let fake = InputFixture()
        fake.call("input.key", fake.keyArgs(["Command", "Shift", "a"], repeat: 2))
        try fake.state.runTimers()
        _ = try fake.success()
        let keyDown = fake.state.stream.filter { $0.kind == .keyDown }
        try inputCheck(keyDown.contains { $0.keyCode == 12 } && keyDown.filter { $0.keyCode == 12 }.count == 2,
                       "Repeated chords use keycodes supplied by the active layout resolver")
        try inputCheck(keyDown.filter { $0.keyCode == 12 }.allSatisfy {
            $0.flags & CGEventFlags.maskCommand.rawValue != 0 && $0.flags & CGEventFlags.maskShift.rawValue != 0
        }, "The final key carries every explicit modifier flag")
        try inputCheck(fake.state.stream.filter { $0.kind == .keyUp }.count == keyDown.count &&
                       fake.state.postFences.allSatisfy { $0 } && fake.service.releaseAll() == 0,
                       "A completed repeated chord releases every synthetic key")
        let keyUps = fake.state.stream.filter { $0.kind == .keyUp }
        let flags = CGEventFlags.maskCommand.rawValue | CGEventFlags.maskShift.rawValue
        try inputCheck(keyUps.map(\.keyCode) == [12, 56, 55, 12, 56, 55] &&
                       keyUps.map(\.flags) == [flags, CGEventFlags.maskCommand.rawValue, 0, flags, CGEventFlags.maskCommand.rawValue, 0],
                       "Normal multi-modifier releases preserve only the remaining owned modifiers on every up event")
        let screenshot = InputFixture()
        screenshot.call("input.key", screenshot.keyArgs(["Command", "Shift", "4"]))
        try inputCheck(screenshot.failure() == "blocked" && screenshot.state.posts.isEmpty,
                       "The native shortcut floor blocks OS screenshot commands before posting")
    }

    try test {
        let fake = InputFixture()
        let text = String(repeating: "a", count: 19) + "😀" + String(repeating: "b", count: 25) + "界"
        fake.call("input.type", fake.typeArgs(text))
        try fake.state.runTimers()
        _ = try fake.success()
        let chunks = fake.state.posts.filter { $0.kind == .unicodeDown }.map(\.unicode)
        try inputCheck(chunks.count > 1 && chunks.allSatisfy { !$0.isEmpty && $0.count <= 20 &&
            Array(String(decoding: $0, as: UTF16.self).utf16) == $0
        }, "Each native Unicode chunk is at most 20 UTF16 units and preserves complete scalars")
        try inputCheck(String(decoding: chunks.flatMap { $0 }, as: UTF16.self) == text,
                       "Unicode chunks reconstruct the exact original text")
        try inputCheck(fake.state.stream.filter { $0.kind == .unicodeUp }.count == chunks.count &&
                       fake.state.posts.allSatisfy { $0.flags == 0 && $0.tag == fake.state.tag },
                       "Unicode input uses explicit empty modifier flags, a private tag and complete release pairs")
    }

    try test {
        for combo in [["a"], ["Option", "s"], ["Command", "v"], ["Control", "v"], ["Shift", "Insert"]] {
            let fake = InputFixture()
            fake.state.secure = true
            fake.call("input.key", fake.keyArgs(combo))
            try inputCheck(fake.failure() == "secure_field" && fake.state.posts.isEmpty,
                           "Typing keys, Option text and paste chords cannot bypass a secure native field")
        }
        let navigation = InputFixture()
        navigation.state.secure = true
        navigation.call("input.key", navigation.keyArgs(["ArrowLeft"]))
        try navigation.state.runTimers()
        _ = try navigation.success()
        try inputCheck(!navigation.state.posts.isEmpty, "Secure-field navigation remains available without sending text")
        let heldPaste = InputFixture()
        heldPaste.state.secure = true
        heldPaste.call("input.hold", heldPaste.holdArgs(["Command", "v"]))
        try inputCheck(heldPaste.failure() == "secure_field" && heldPaste.state.posts.isEmpty,
                       "A held paste shortcut is text input and cannot bypass a secure field")
        let unknown = InputFixture()
        unknown.state.secure = nil
        unknown.call("input.type", unknown.typeArgs())
        try inputCheck(unknown.failure() == "secure_field" && unknown.state.posts.isEmpty,
                       "An unavailable focused-field security observation cannot authorize text")
        let translatedPaste = InputFixture()
        translatedPaste.state.secure = true; translatedPaste.state.semanticOverride = ["Command", "v"]
        translatedPaste.call("input.key", translatedPaste.keyArgs(["Command", "KeyX"]))
        try inputCheck(translatedPaste.failure() == "secure_field" && translatedPaste.state.posts.isEmpty,
                       "Secure-field policy uses the resolver's actual semantic keys when a physical alias maps to Paste")
    }

    try test {
        let fake = InputFixture()
        fake.state.owner = inputOwner("com.microsoft.VSCode")
        fake.session.approved = [fake.state.owner.identity.wire]
        fake.call("input.type", fake.typeArgs())
        try inputCheck(fake.failure() == "blocked" && fake.state.posts.isEmpty,
                       "Developer apps remain click-only for arbitrary Unicode typing")
        fake.call("input.key", fake.keyArgs(["Command", "v"]))
        try inputCheck(fake.failure() == "blocked" && fake.state.posts.isEmpty,
                       "A paste shortcut is still text input under the native IDE policy")
        fake.call("input.key", fake.keyArgs(["Command", "s"]))
        try fake.state.runTimers()
        _ = try fake.success()
        try inputCheck(!fake.state.posts.isEmpty, "Approved nontext IDE shortcuts remain usable")
        let unobservedSave = InputFixture()
        unobservedSave.state.menuShortcuts = []
        unobservedSave.call("input.key", unobservedSave.keyArgs())
        try inputCheck(unobservedSave.failure() == "blocked" && unobservedSave.state.posts.isEmpty,
                       "A nondefault Save shortcut requires a matching observed safe app menu")
        let customPaste = InputFixture()
        customPaste.state.secure = true
        customPaste.state.menuShortcuts = [InputMenuShortcut(combo: ["Command", "s"], label: "Paste")]
        customPaste.call("input.key", customPaste.keyArgs(["Command", "s"]))
        try inputCheck(customPaste.failure() == "secure_field" && customPaste.state.posts.isEmpty,
                       "An observed custom Paste menu shortcut is text input even when its keys look like a save chord")
    }

    try test {
        let fake = InputFixture()
        var args = fake.typeArgs(); args["pid"] = .integer(202)
        fake.call("input.type", args)
        try inputCheck(fake.failure() == "changed" && fake.state.posts.isEmpty,
                       "Keyboard input requires the actual focused native owner to match the expected PID")
    }

    try test {
        let fake = InputFixture()
        fake.state.onPost = { event in if event.kind == .unicodeDown { fake.state.secure = true } }
        fake.call("input.type", fake.typeArgs(String(repeating: "a", count: 45)))
        try fake.state.runTimers()
        try inputCheck(fake.failure() == "secure_field" && fake.state.posts.filter { $0.kind == .unicodeDown }.count == 1,
                       "A secure-field transition stops the remaining native text chunks")
        try inputCheck(fake.state.stream.contains { $0.kind == .unicodeUp } && fake.service.releaseAll() == 0,
                       "A refused later chunk still releases the earlier synthetic key state")
    }

    try test {
        let fake = InputFixture()
        fake.state.onPost = { event in if event.kind == .unicodeDown { fake.state.owner = inputOwner(start: 11) } }
        fake.call("input.type", fake.typeArgs(String(repeating: "a", count: 45)))
        try fake.state.runTimers()
        try inputCheck(fake.failure() == "changed" && fake.state.posts.filter { $0.kind == .unicodeDown }.count == 1,
                       "The remainder of one typing operation never transfers to a replacement process sharing PID and signer")
    }

    try test {
        let fake = InputFixture()
        var args = fake.typeArgs(String(repeating: "a", count: 45)); args["elementId"] = .string(fake.state.elementID)
        fake.state.onPost = { event in if event.kind == .unicodeDown { fake.state.elementID = "replacement-element" } }
        fake.call("input.type", args)
        try fake.state.runTimers()
        try inputCheck(["changed", "stale_ref"].contains(fake.failure() ?? "") &&
                       fake.state.posts.filter { $0.kind == .unicodeDown }.count == 1,
                       "Actual element replacement invalidates expected bindings between Unicode chunks")
        let actual = InputFixture()
        actual.state.onPost = { event in if event.kind == .unicodeDown { actual.state.element = AccessibilityElement() } }
        actual.call("input.type", actual.typeArgs(String(repeating: "a", count: 45)))
        try actual.state.runTimers()
        try inputCheck(actual.failure() == "changed" && actual.state.posts.filter { $0.kind == .unicodeDown }.count == 1,
                       "A typing flight remains bound to its actual native AX object even when public labels and optional request refs are unchanged")
    }

    try test {
        let fake = InputFixture()
        fake.state.refuseFence = true
        fake.call("input.key", fake.keyArgs())
        try inputCheck(fake.failure() == "changed" && fake.state.posts.isEmpty,
                       "A current read check cannot substitute for the atomic authority fence around posting")
        let denied = InputFixture()
        denied.state.denyInsideFence = true
        denied.call("input.type", denied.typeArgs())
        try inputCheck(denied.failure() == "permissions" && denied.state.posts.isEmpty,
                       "The final posting fence rechecks the live OS event grant")
        let revokedAtPost = InputFixture()
        revokedAtPost.state.onFocused = { _ in revokedAtPost.state.refuseFence = true }
        revokedAtPost.call("input.type", revokedAtPost.typeArgs())
        try inputCheck(revokedAtPost.failure() == "changed" && revokedAtPost.state.posts.isEmpty,
                       "A successful observation cannot waive a refused final posting fence")
    }

    try test {
        let fake = InputFixture()
        let capture = try fake.retainCapture()
        fake.call("input.drag", fake.dragArgs(capture))
        try fake.state.runTimers()
        _ = try fake.success()
        let down = fake.state.stream.filter { $0.kind == .buttonDown }
        let up = fake.state.stream.filter { $0.kind == .buttonUp }
        let drag = fake.state.posts.filter { $0.kind == .drag }
        try inputCheck(down.count == 1 && up.count == 1 && drag.count >= 2 &&
                       up[0].point == CGPoint(x: -69.75, y: -34.75),
                       "A drag keeps one synthetic button down and releases at its last checked native point")
        try inputCheck(fake.state.postFences.allSatisfy { $0 } && fake.service.releaseAll() == 0,
                       "Every drag primitive is current-fenced and the completed path leaves no held button")
    }

    try test {
        let fake = InputFixture()
        let capture = try fake.retainCapture()
        var args = fake.dragArgs(capture)
        args["targets"] = .array([
            .object(["pid": .integer(101), "windowId": .string("1010")]),
            .object(["pid": .integer(101), "elementId": .string(fake.state.elementID)]),
            .object(["pid": .integer(202), "windowId": .string("1010")])
        ])
        fake.call("input.drag", args)
        try fake.state.runTimers()
        try inputCheck(["changed", "stale_ref"].contains(fake.failure() ?? "") &&
                       !fake.state.posts.contains { $0.kind == .drag && $0.point == CGPoint(x: -69.75, y: -34.75) },
                       "Each drag point has its own native target binding, including the final drop")
        try inputCheck(fake.state.stream.filter { $0.kind == .buttonDown }.count ==
                       fake.state.stream.filter { $0.kind == .buttonUp }.count && fake.service.releaseAll() == 0,
                       "A refused path point releases any earlier synthetic button without visiting the rejected point")
    }

    try test {
        let fake = InputFixture()
        let capture = try fake.retainCapture()
        fake.state.onPost = { event in if event.kind == .drag { fake.state.epoch += 1 } }
        fake.call("input.drag", fake.dragArgs(capture))
        try fake.state.runTimers()
        let before = fake.state.posts.count
        let callbacks = fake.state.timers.map(\.work)
        callbacks.forEach { $0() }
        fake.state.drain()
        try inputCheck(fake.state.posts.filter { $0.kind == .drag }.count == 1 && fake.state.posts.count == before,
                       "Revocation between drag primitives prevents remaining points and canceled late timers from posting")
        try inputCheck(fake.state.stream.contains { $0.kind == .buttonUp } && fake.service.releaseAll() == 0,
                       "Canceling a drag always releases its owned synthetic button")
    }

    try test {
        let fake = InputFixture()
        fake.call("input.hold", fake.holdArgs(milliseconds: 500))
        try fake.state.runTimers()
        _ = try fake.success()
        try inputCheck(fake.state.delays.contains { $0 >= 500 } &&
                       fake.state.stream.filter { $0.kind == .keyDown }.count == fake.state.stream.filter { $0.kind == .keyUp }.count,
                       "A hold waits through the injected scheduler and releases every key before success")
        try inputCheck(fake.service.releaseAll() == 0, "A completed hold cannot leave a synthetic key behind")
        let zero = InputFixture()
        zero.call("input.hold", zero.holdArgs(milliseconds: 0)); try zero.state.runTimers()
        _ = try zero.success()
        try inputCheck(zero.state.stream.filter { $0.kind == .keyDown }.count == zero.state.stream.filter { $0.kind == .keyUp }.count,
                       "The wire's zero-duration hold still produces a complete bounded down/up sequence")
        let retry = InputFixture()
        retry.state.releaseResult = .retry
        retry.call("input.hold", retry.holdArgs(milliseconds: 500)); try retry.state.runTimers()
        try inputCheck(retry.failure() == "failed", "An asynchronous hold cannot report success while matching ups still require retry")
        retry.state.releaseResult = .released
        try inputCheck(retry.service.releaseAll() > 0 && retry.service.releaseAll() == 0,
                       "Failed hold cleanup retains its owned keys for a later bounded release attempt")
        let blockedRead = InputFixture()
        var releasedDuringRead = false
        blockedRead.state.onPost = { event in if event.kind == .keyDown { blockedRead.state.holdWork = true } }
        blockedRead.state.onFocused = { _ in
            if let timer = blockedRead.state.timers.first(where: { !$0.canceled }) {
                blockedRead.state.clock = max(blockedRead.state.clock, timer.due)
                timer.canceled = true; timer.work()
                releasedDuringRead = !blockedRead.state.releases.isEmpty
            }
        }
        blockedRead.call("input.hold", blockedRead.holdArgs(["Command", "Shift", "a"], milliseconds: 1))
        blockedRead.state.drain()
        try inputCheck(releasedDuringRead && blockedRead.state.posts.filter { $0.kind == .keyDown }.count == 1 &&
                       blockedRead.service.releaseAll() == 0,
                       "An independent hold timer releases its first owned down while a later AX observation and completion queue are still blocked")
    }

    try test {
        let fake = InputFixture()
        fake.call("input.hold", fake.holdArgs(milliseconds: 5000))
        let down = fake.state.posts.filter { $0.kind == .keyDown }
        try inputCheck(!down.isEmpty, "The synthetic hold reached its owned down state")
        let callbacks = fake.state.timers.map(\.work)
        fake.state.granted = false; fake.state.epoch += 1; fake.state.owner = inputOwner("com.apple.Terminal", pid: 202)
        try inputCheck(fake.service.releaseAll() > 0, "Release-all remains available after grant loss, revocation and target replacement")
        let posts = fake.state.posts.count
        callbacks.forEach { $0() }; fake.state.drain()
        try inputCheck(fake.state.posts.count == posts && fake.service.releaseAll() == 0,
                       "Canceled hold timers cannot repost a down or revive an already released lease")
        for event in down {
            try inputCheck(fake.state.releases.contains { $0.kind == .keyUp && $0.keyCode == event.keyCode && $0.destination == event.destination },
                           "Cleanup releases only the original key and destination receipt, never a replacement target")
        }
        let modifiers = InputFixture()
        modifiers.call("input.hold", modifiers.holdArgs(["Shift", "Command", "a"], milliseconds: 5000))
        modifiers.state.epoch += 1; _ = modifiers.service.releaseAll()
        let ups = modifiers.state.releases.filter { $0.kind == .keyUp }
        let both = CGEventFlags.maskShift.rawValue | CGEventFlags.maskCommand.rawValue
        try inputCheck(ups.map(\.keyCode) == [12, 55, 56] && ups.map(\.flags) == [both, CGEventFlags.maskShift.rawValue, 0],
                       "Canceled multi-modifier holds release in reverse ownership order without borrowing or retaining unrelated flags")
    }

    try test {
        let fake = InputFixture()
        fake.state.throwPostAt = 2
        fake.call("input.key", fake.keyArgs())
        try fake.state.runTimers()
        try inputCheck(fake.failure() != nil && !fake.state.releases.isEmpty && fake.service.releaseAll() == 0,
                       "An uncertain posting error releases both confirmed and possibly posted synthetic downs")
        try inputCheck(fake.state.posts.allSatisfy { $0.tag == fake.state.tag } && fake.state.releases.allSatisfy { $0.tag == fake.state.tag },
                       "Error cleanup retains the same private own-event tag")
    }

    try test {
        let fake = InputFixture()
        fake.state.onPost = { event in if event.kind == .keyDown { fake.state.granted = false } }
        fake.call("input.key", fake.keyArgs())
        try fake.state.runTimers()
        try inputCheck(fake.failure() == "permissions" && fake.state.posts.filter { $0.kind == .keyDown }.count == 1 &&
                       fake.state.releases.contains { $0.kind == .keyUp && $0.keyCode == 55 },
                       "Permission loss during a chord prevents later downs while still releasing the earlier modifier")
    }

    try test {
        let fake = InputFixture()
        fake.state.onPost = { event in if event.kind == .keyDown && event.keyCode == 1 { fake.state.layoutName = "replacement-layout" } }
        fake.call("input.key", fake.keyArgs(repeat: 3))
        try fake.state.runTimers()
        try inputCheck(fake.failure() == "changed" && fake.state.posts.filter { $0.kind == .keyDown && $0.keyCode == 1 }.count == 1,
                       "A layout change cannot send subsequent repetitions through stale keycode bindings")
    }

    try test {
        let fake = InputFixture(paused: true)
        fake.call("input.type", fake.typeArgs())
        try inputCheck(fake.failure() == "paused" && fake.state.posts.isEmpty, "Paused native authority cannot type")
        let background = InputFixture(mode: "background")
        background.call("input.key", background.keyArgs())
        try inputCheck(background.failure() == "needs_foreground" && background.state.posts.isEmpty,
                       "M5 refuses an unimplemented app-directed background path without fabricated input success")
        let capture = try background.retainCapture()
        background.call("input.click", background.clickArgs(capture))
        try inputCheck(background.failure() == "needs_foreground" && background.state.posts.isEmpty,
                       "A background pointer operation cannot take the user's cursor or foreground")
    }

    try test {
        let fake = InputFixture()
        fake.state.holdWork = true
        fake.call("input.type", fake.typeArgs())
        fake.state.epoch += 1; fake.state.drain()
        try inputCheck(fake.failure() == "changed" && fake.state.posts.isEmpty && fake.state.focusedPIDs.isEmpty,
                       "Revoked queued work cannot inspect a target or post input")
        let closed = InputFixture()
        closed.call("input.hold", closed.holdArgs(milliseconds: 5000))
        closed.service.close(); closed.service.close()
        let posts = closed.state.posts.count
        closed.state.timers.map(\.work).forEach { $0() }
        closed.state.drain()
        try inputCheck(closed.state.posts.count == posts && closed.service.releaseAll() == 0 &&
                       closed.state.stream.filter { $0.kind == .keyDown }.count == closed.state.stream.filter { $0.kind == .keyUp }.count,
                       "Idempotent close releases held input and prevents late callbacks from posting again")
    }

    try test {
        let fake = InputFixture()
        fake.state.onPost = { event in if event.kind == .unicodeDown { fake.state.clock += 20_000_000_000 } }
        fake.call("input.type", fake.typeArgs(String(repeating: "a", count: 45)))
        try fake.state.runTimers()
        try inputCheck(fake.failure() == "timeout" && fake.state.posts.filter { $0.kind == .unicodeDown }.count == 1 &&
                       fake.state.stream.contains { $0.kind == .unicodeUp } && fake.service.releaseAll() == 0,
                       "The helper's own operation deadline stops remaining chunks and releases input without relying on a live caller")
    }

    try test {
        let fake = InputFixture()
        let capture = try fake.retainCapture()
        let badClick = fake.clickArgs(capture, count: 4)
        var badButton = fake.clickArgs(capture); badButton["button"] = .string("back")
        var badModifiers = fake.clickArgs(capture); badModifiers["modifiers"] = .array(Array(repeating: .string("Shift"), count: 9))
        var badCoordinate = fake.pointerArgs(capture); badCoordinate["x"] = .number(0.5)
        var badScroll = fake.pointerArgs(capture); badScroll["dx"] = .integer(2147483648); badScroll["dy"] = .integer(0)
        var badDrag = fake.dragArgs(capture); badDrag["targets"] = .array([.object([:])])
        var shortDrag = fake.dragArgs(capture); shortDrag["path"] = .array([.object(["x": .integer(20), "y": .integer(20)])])
        var longDrag = fake.dragArgs(capture)
        longDrag["path"] = .array(Array(repeating: .object(["x": .integer(20), "y": .integer(20)]), count: 51))
        var tooManyKeys = fake.keyArgs(); tooManyKeys["combo"] = .array(Array(repeating: .string("s"), count: 9))
        var extra = fake.clickArgs(capture); extra["ignored"] = .bool(true)
        var noPID = fake.typeArgs(); noPID.removeValue(forKey: "pid")
        let invalid: [(String, [String: JSONValue])] = [
            ("input.click", badClick), ("input.click", badButton), ("input.click", badModifiers),
            ("input.move", badCoordinate), ("input.scroll", badScroll), ("input.drag", badDrag), ("input.drag", shortDrag), ("input.drag", longDrag),
            ("input.key", fake.keyArgs([], repeat: 1)), ("input.key", fake.keyArgs(repeat: 0)),
            ("input.key", fake.keyArgs(repeat: 21)), ("input.key", tooManyKeys),
            ("input.type", fake.typeArgs("")), ("input.type", fake.typeArgs(String(repeating: "a", count: 4001))), ("input.type", noPID),
            ("input.click", extra),
            ("input.hold", fake.holdArgs(milliseconds: -1)), ("input.hold", fake.holdArgs(milliseconds: 10001))
        ]
        for (operation, args) in invalid {
            fake.call(operation, args); try fake.state.runTimers()
            try inputCheck(fake.failure() == "failed", "Malformed native input targets, payloads and limits are refused before posting")
        }
        try inputCheck(fake.state.posts.isEmpty && fake.state.pointerPoints.isEmpty && fake.state.focusedPIDs.isEmpty,
                       "Malformed requests cannot cause target inspection, key downs or pointer movement")
        var wrongPhase = fake.typeArgs(); wrongPhase["phaseRevision"] = .integer(2)
        fake.call("input.type", wrongPhase); try fake.state.runTimers()
        try inputCheck(fake.failure() == "changed" && fake.state.posts.isEmpty,
                       "Input cannot borrow native authority from a different session phase")
        let boundary = InputFixture()
        boundary.call("input.type", boundary.typeArgs(String(repeating: "a", count: 4000)))
        try boundary.state.runTimers(); _ = try boundary.success()
        try inputCheck(boundary.state.posts.filter { $0.kind == .unicodeDown }.reduce(0) { $0 + $1.unicode.count } == 4000,
                       "The complete 4000-unit wire limit remains usable through bounded native chunks")
    }

    try test {
        let shift = CGEventFlags.maskShift.rawValue
        let command = CGEventFlags.maskCommand.rawValue
        let french = InputNative.resolvePrintable("a", flags: 0) { code, flags in
            flags == 0 ? ([UInt16(0): "q", UInt16(12): "a"][code]) : nil
        }
        try inputCheck(french?.code == 12 && french?.flags == 0, "A semantic printable key reverse-maps through a synthetic AZERTY layout")
        let digit = InputNative.resolvePrintable("4", flags: command) { code, flags in
            code == 21 && flags == (command | shift) ? "4" : nil
        }
        try inputCheck(digit?.code == 21 && digit?.flags == (command | shift),
                       "Layout-required Shift is retained alongside an explicit Command shortcut flag")
        let cyrillic = InputNative.resolvePrintable("я", flags: 0) { code, flags in code == 6 && flags == 0 ? "я" : nil }
        try inputCheck(cyrillic?.code == 6 && InputNative.resolvePrintable("unmapped", flags: 0, translate: { _, _ in nil }) == nil,
                       "Non-Latin semantic characters map from actual table output while unavailable keys fail closed")
        let uppercase = InputNative.resolvePrintable("Ж", flags: 0) { code, flags in
            guard code == 6 else { return nil }; return flags == shift ? "Ж" : flags == 0 ? "ж" : nil
        }
        try inputCheck(uppercase?.code == 6 && uppercase?.flags == shift,
                       "Non-Latin case is exact: an uppercase character retains the layout-required Shift")
        var translatedPhysical = false
        let physical = InputNative.resolveKey("KeyQ", flags: command, translate: { _, _ in translatedPhysical = true; return nil })
        let physicalDigit = InputNative.resolveKey("Digit4", flags: shift, translate: { _, _ in translatedPhysical = true; return nil })
        try inputCheck(physical?.code == 12 && physical?.flags == command && physicalDigit?.code == 21 &&
                       physicalDigit?.flags == shift && !translatedPhysical,
                       "Explicit physical Key/Digit aliases retain their native location instead of reverse-translating a semantic character")
        let paste = try InputNative.resolveCombo(["Command", "KeyX"], layout: "synthetic-layout",
            resolve: { name, flags in InputNative.resolveKey(name, flags: flags, translate: { _, _ in nil }) },
            translate: { code, flags in code == 7 && flags == command ? "v" : nil })
        try inputCheck(paste.semanticKeys.map { NativeOperation.key($0).typesText } == true,
                       "A physical shortcut that translates to Paste retains text-changing semantic keys for native policy")
    }

    try test {
        for surfaceIsPhysical in [false, true] {
            let host = HostOwnershipTestFixture(surfaceIsPhysical: surfaceIsPhysical)
            let fake = InputFixture()
            _ = try fake.hosted(host)
            fake.call("input.type", fake.typeArgs("Hosted panel text")); try fake.state.runTimers(); _ = try fake.success()
            let downs = fake.state.posts.filter { $0.kind == .unicodeDown }
            try inputCheck(fake.session.approved == [host.logical.identity.wire] && !downs.isEmpty &&
                           fake.state.focusedPIDs.allSatisfy { $0 == host.logical.process.pid },
                           "Hosted text uses only the logical client's grant and requested foreground PID for either real CG-surface owner")
            try inputCheck(downs.allSatisfy { $0.destination == host.physical.process && $0.foreground == host.logical.process } &&
                           fake.state.releases.allSatisfy { $0.destination == host.physical.process && $0.foreground == host.logical.process },
                           "Hosted Unicode downs and matching ups retain the physical AX destination separately from the logical foreground witness")
            try inputCheck(fake.state.bindings.allSatisfy { $0.pid == Int(host.logical.process.pid) && $0.process == host.physical.process },
                           "Hosted keyboard bindings never replace the physical AX process receipt with the logical grant identity")
        }
    }

    try test {
        for surfaceIsPhysical in [false, true] {
            for windowCapture in [false, true] {
                let host = HostOwnershipTestFixture(surfaceIsPhysical: surfaceIsPhysical)
                let fake = InputFixture()
                let proof = try fake.hosted(host)
                let capture = try fake.retainHostedCapture(proof, windowCapture: windowCapture)
                var args = fake.clickArgs(capture)
                args["pid"] = .integer(Int64(host.logical.process.pid)); args["windowId"] = .string(host.surface.windowID)
                fake.call("input.click", args); try fake.state.runTimers(); _ = try fake.success()
                try inputCheck(fake.state.posts.filter { $0.kind == .buttonDown }.count == 1 &&
                               fake.state.posts.allSatisfy { $0.destination == host.physical.process } &&
                               fake.state.bindings.allSatisfy { $0.pid == Int(host.logical.process.pid) && $0.process == host.physical.process },
                               "Hosted pointer input binds capture pixels to the actual visible surface while retaining its separate physical AX endpoint")
                try inputCheck(fake.service.releaseAll() == 0,
                               "A complete hosted click leaves no synthetic button held for either display or window captures")
            }
        }
    }

    try test {
        let cases = ["physical-process", "logical-process", "surface-geometry", "responsibility", "responsibility-during-metadata", "expired-proof"]
        for name in cases {
            let host = HostOwnershipTestFixture()
            let fake = InputFixture()
            _ = try fake.hosted(host)
            fake.state.onFence = {
                guard !fake.state.focusedPIDs.isEmpty else { return }
                fake.state.onFence = nil
                switch name {
                case "physical-process": host.processes[host.physical.process.pid] = inputOwner(pid: host.physical.process.pid, start: 99).process
                case "logical-process": host.processes[host.logical.process.pid] = inputOwner(pid: host.logical.process.pid, start: 99).process
                case "surface-geometry":
                    let surface = host.surface
                    host.windows = [CaptureWindowInfo(windowID: surface.windowID, pid: surface.pid,
                        bounds: surface.bounds.offsetBy(dx: 1, dy: 0), onScreen: true, minimized: false,
                        spaceWitness: surface.spaceWitness)]
                case "responsibility": host.responsible = nil
                case "responsibility-during-metadata":
                    host.onWindows = { host.responsible = 303; host.onWindows = nil }
                default: host.time += 50_000_001
                }
            }
            fake.call("input.type", fake.typeArgs("Never post stale panel text")); try fake.state.runTimers()
            try inputCheck(fake.failure() == "changed" && fake.state.posts.isEmpty && fake.state.releases.isEmpty,
                           "Final hosted metadata guard refuses \(name) changed after AX observation and before any native down")
        }
    }

    try test {
        let host = HostOwnershipTestFixture(surfaceIsPhysical: true)
        let fake = InputFixture()
        let proof = try fake.hosted(host)
        let capture = try fake.retainHostedCapture(proof, windowCapture: true)
        fake.state.onFence = {
            guard !fake.state.pointerPoints.isEmpty else { return }
            fake.state.onFence = nil; host.responsible = 303
        }
        fake.call("input.click", fake.clickArgs(capture)); try fake.state.runTimers()
        try inputCheck(fake.failure() == "changed" && fake.state.posts.isEmpty,
                       "A host responsibility switch after pointer hit-test cannot reuse the captured panel's grant at posting time")
    }

    try test {
        let host = HostOwnershipTestFixture()
        let fake = InputFixture()
        _ = try fake.hosted(host)
        let id = fake.session.id, revision = fake.session.revision
        fake.session.observationEpoch = UUID()
        fake.call("input.type", fake.typeArgs("Retired authority text")); try fake.state.runTimers()
        try inputCheck(fake.session.id == id && fake.session.revision == revision && fake.failure() == "changed" && fake.state.posts.isEmpty,
                       "Reusing a wire session ID and revision never revives a hosted proof from another private observation epoch")
    }

    try test {
        let host = HostOwnershipTestFixture()
        let fake = InputFixture()
        _ = try fake.hosted(host)
        let replacementWindow = AccessibilityElement()
        host.elementPIDs[replacementWindow.identity] = host.logical.process.pid
        host.elementBounds[replacementWindow.identity] = host.surface.bounds
        host.links = [HostAXBridge(logicalPID: host.logical.process.pid, logicalWindow: replacementWindow,
            linkedRoot: host.physicalRoot, physicalRoot: host.physicalRoot)]
        let replacement = try host.proof(session: fake.session)
        fake.state.onFocused = { _ in
            if fake.state.focusedPIDs.count == 2 {
                fake.state.focusedOverride = InputObservation(target: NativeTarget(owner: host.physical,
                    windowID: host.surface.windowID, secure: false, hosted: replacement), window: host.surface,
                    element: host.physicalRoot, menuShortcuts: fake.state.menuShortcuts)
            }
        }
        fake.call("input.key", fake.keyArgs(["Command", "a"])); try fake.state.runTimers()
        try inputCheck(fake.failure() == "changed" && fake.state.posts.isEmpty,
                       "The post-menu same-focus check includes the actual logical AX mapping even when physical process, element and CG rectangle stay equal")
    }

    try test {
        let host = HostOwnershipTestFixture()
        let fake = InputFixture()
        let captured = try fake.hosted(host)
        let capture = try fake.retainHostedCapture(captured, windowCapture: true)
        let replacementWindow = AccessibilityElement()
        host.elementPIDs[replacementWindow.identity] = host.logical.process.pid
        host.elementBounds[replacementWindow.identity] = host.surface.bounds
        host.links = [HostAXBridge(logicalPID: host.logical.process.pid, logicalWindow: replacementWindow,
            linkedRoot: host.physicalRoot, physicalRoot: host.physicalRoot)]
        let replacement = try host.proof(session: fake.session)
        fake.state.pointerOverride = InputObservation(target: NativeTarget(owner: host.physical,
            windowID: host.surface.windowID, secure: false, hosted: replacement), window: host.surface, element: host.physicalRoot)
        fake.call("input.click", fake.clickArgs(capture)); try fake.state.runTimers()
        try inputCheck(fake.failure() == "stale_frame" && fake.state.posts.isEmpty,
                       "A captured host mapping cannot be swapped for another logical AX window while retaining the same surface and physical endpoint")
    }

    try test {
        let host = HostOwnershipTestFixture()
        let fake = InputFixture()
        _ = try fake.hosted(host)
        fake.session.approved = [host.physical.identity.wire]
        fake.call("input.type", fake.typeArgs("No logical client grant")); try fake.state.runTimers()
        try inputCheck(fake.failure() == "not_granted" && fake.state.posts.isEmpty,
                       "Approving the Apple host process cannot substitute for approval of the panel's logical client")
    }

    try test {
        let host = HostOwnershipTestFixture()
        host.logical = inputOwner("com.microsoft.VSCode", pid: host.logical.process.pid)
        host.install(host.logical)
        let fake = InputFixture()
        let proof = try fake.hosted(host)
        fake.call("input.type", fake.typeArgs("IDE panel text")); try fake.state.runTimers()
        try inputCheck(fake.failure() == "blocked" && fake.state.posts.isEmpty,
                       "A hosted panel retains its logical developer client's click-only typing floor")
        let capture = try fake.retainHostedCapture(proof)
        fake.call("input.click", fake.clickArgs(capture)); try fake.state.runTimers(); _ = try fake.success()
        try inputCheck(fake.state.posts.filter { $0.kind == .buttonDown }.count == 1,
                       "Click-only policy still permits a proven hosted button click")
    }

    try test {
        let security: [Bool?] = [true, nil]
        for secure in security {
            let host = HostOwnershipTestFixture()
            let fake = InputFixture()
            _ = try fake.hosted(host, secure: secure)
            fake.call("input.type", fake.typeArgs("Private panel text")); try fake.state.runTimers()
            try inputCheck(fake.failure() == "secure_field" && fake.state.posts.isEmpty,
                           "Hosted secure or unobserved-security fields cannot receive Unicode text")
            fake.call("input.key", fake.keyArgs(["Enter"])); try fake.state.runTimers(); _ = try fake.success()
            try inputCheck(fake.state.posts.allSatisfy { $0.destination == host.physical.process && $0.foreground == host.logical.process },
                           "A non-typing hosted navigation key preserves the logical grant and physical destination without waiving text protection")
        }
    }

    try test {
        for surfaceIsPhysical in [false, true] {
            let host = HostOwnershipTestFixture(surfaceIsPhysical: surfaceIsPhysical)
            let fake = InputFixture()
            fake.configureHost(host, session: host.session(), proof: nil)
            var forged = fake.typeArgs("Forged panel text")
            forged["hosted"] = .object(["logicalPID": .integer(Int64(host.logical.process.pid)),
                                        "physicalPID": .integer(Int64(host.physical.process.pid))])
            fake.call("input.type", forged); try fake.state.runTimers()
            try inputCheck(fake.failure() == "failed" && fake.state.focusedPIDs.isEmpty && fake.state.posts.isEmpty,
                           "Wire-supplied host/client identifiers are refused before observation and never become a private mapping proof")
            fake.call("input.type", fake.typeArgs("Unproven panel text")); try fake.state.runTimers()
            try inputCheck(fake.failure() != nil && fake.state.posts.isEmpty,
                           "A responsible PID, matching rectangle and client request cannot invent a hosted keyboard grant without a private AX bridge proof")
            let request = fake.state.results.count
            var args = fake.keyArgs(["Enter"]); args["pid"] = .integer(Int64(host.physical.process.pid))
            fake.call("input.key", args); try fake.state.runTimers()
            try inputCheck(fake.state.results.count == request + 1 && fake.failure() != nil && fake.state.posts.isEmpty,
                           "Falling back to the physical system host as a requested app still fails its native security/ownership floor")
        }
    }

    try test {
        let host = HostOwnershipTestFixture()
        host.logical = inputOwner("com.apple.Terminal", pid: host.logical.process.pid)
        host.install(host.logical)
        let session = host.session()
        let proof = try host.makeResolver().resolve(window: host.surface, session: session)
        try inputCheck(proof == nil, "An explicitly granted terminal cannot obtain a host proof through a benign Apple panel service")
        let fake = InputFixture()
        fake.configureHost(host, session: session, proof: proof)
        fake.call("input.type", fake.typeArgs("Never type through a protected client")); try fake.state.runTimers()
        try inputCheck(fake.failure() != nil && fake.state.posts.isEmpty,
                       "A missing protected-client proof does not fall back to a surface-only input authorization")
    }

    try test {
        var insertions: [String] = []
        let fake = InputFixture(mode: "background", backgroundType: { args, context, completion in
            var wrote = false
            let current = context.withCurrent { insertions.append(args["text"]!.stringValue!); wrote = true }
            completion(current && wrote ? .success(ServerReply()) : .failure(ServerFailure(code: "changed", message: "Revoked")))
        })
        fake.state.granted = false // AX insertion does not require CGPostEvent permission.
        fake.call("input.type", fake.typeArgs("A🙂e\u{301}")); _ = try fake.success()
        try inputCheck(insertions == ["A🙂e\u{301}"] && fake.state.preflights == 0 && fake.state.posts.isEmpty &&
                       fake.state.releases.isEmpty && fake.state.focusedPIDs.isEmpty,
                       "Background insertion delegates the complete text without CG preflight, global focus or a held-input lease")
    }

    try test {
        var calls = 0
        let fake = InputFixture(mode: "background", backgroundType: { _, _, completion in
            calls += 1
            completion(.failure(ServerFailure(code: "changed", message: "Uncertain partial write")))
        })
        fake.call("input.type", fake.typeArgs("Never duplicate"))
        try inputCheck(fake.failure() == "changed" && calls == 1 && fake.state.posts.isEmpty,
                       "An uncertain AX insertion is returned without blind Unicode fallback")
        var invalid = fake.typeArgs("Invalid"); invalid["text"] = .string("")
        fake.call("input.type", invalid)
        try inputCheck(fake.failure() == "failed" && calls == 1, "Malformed background text never reaches the AX delegate")
    }

    try test {
        var calls = 0
        let fake = InputFixture(paused: true, mode: "background", backgroundType: { _, _, _ in calls += 1 })
        fake.call("input.type", fake.typeArgs("Paused"))
        try inputCheck(fake.failure() == "paused" && calls == 0 && fake.state.preflights == 0,
                       "Paused background insertion is refused before touching either backend")
        let unsupported = InputFixture(mode: "background")
        unsupported.call("input.type", unsupported.typeArgs("Unsupported"))
        try inputCheck(unsupported.failure() == "needs_foreground" && unsupported.state.preflights == 0 && unsupported.state.posts.isEmpty,
                       "An unavailable AX insertion capability asks for foreground without posting")
    }

    try test {
        var pending: OperationContext?
        let fake = InputFixture(mode: "background", backgroundType: { _, context, _ in pending = context })
        fake.call("input.type", fake.typeArgs("Delayed"))
        guard let context = pending else { throw InputTestFailure(message: "Missing insertion context") }
        fake.state.epoch += 1
        var writes = 0
        try inputCheck(!context.isCurrent() && !context.withCurrent({ writes += 1 }),
                       "A delayed AX insertion loses authority when the native epoch changes")
        fake.state.epoch -= 1
        fake.service.close()
        try inputCheck(!context.isCurrent() && !context.withCurrent({ writes += 1 }) && writes == 0,
                       "Closing the input service revokes a retained AX insertion context")
    }

    return count
}
