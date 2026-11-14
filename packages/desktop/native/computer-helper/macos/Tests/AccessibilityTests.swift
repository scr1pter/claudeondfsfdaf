import CoreGraphics
import Darwin
import Foundation

private struct AccessibilityTestFailure: Error {
    let message: String
}

private func accessibilityCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw AccessibilityTestFailure(message: message) }
}

private func accessibilityOwner(_ bundle: String = "example.accessibility.fixture", pid: pid_t = 101,
                                start: UInt64 = 10, team: String? = "ABCDEFGHIJ") -> NativeOwner {
    let executable = "/virtual/\(pid).app/Contents/MacOS/Fixture"
    return NativeOwner(
        identity: MacAppIdentity(bundleId: bundle, teamId: team, apple: false, system: false, verified: true,
                                 name: "Synthetic AX owner", path: executable, pid: Int(pid)),
        process: HelperProcessIdentity(pid: pid, parentPID: 1, startSeconds: start, startMicroseconds: 20,
                                       executable: executable),
        childShell: false
    )
}

private final class AccessibilityTestNode {
    let element = AccessibilityElement()
    var role: String
    var subrole: String?
    var name: String
    var bounds: CGRect
    var menuBounds: CGRect?
    var enabled = true
    var focused = false
    var editable = false
    var nameComplete = true
    var menuShortcut: [String]?
    var shortcutComplete = true
    var value: String?
    var children: [AccessibilityTestNode] = []

    init(_ role: String, name: String, bounds: CGRect, subrole: String? = nil, value: String? = nil) {
        self.role = role; self.name = name; self.bounds = bounds; self.menuBounds = bounds; self.subrole = subrole; self.value = value
    }

    var attributes: AccessibilityAttributes {
        AccessibilityAttributes(role: role, subrole: subrole, name: name, bounds: bounds,
                                enabled: enabled, focused: focused, editable: editable, nameComplete: nameComplete)
    }
}

private final class AccessibilityTestState {
    var owner = accessibilityOwner()
    var granted = true
    var denyAtMutation = false
    var epoch = 1
    var insideFence = false
    var refuseFence = false
    var clock: UInt64 = 1_000_000_000
    var holdWork = false
    var work: [() -> Void] = []
    var preflights = 0
    var windowReads = 0
    var ownerReads = 0
    var applications: [pid_t] = []
    var descriptions: [UUID: Int] = [:]
    var values: [UUID: Int] = [:]
    var documents: [UUID: Int] = [:]
    var childLimits: [Int] = []
    var childRequests: [(UUID, Int)] = []
    var hitApplications: [UUID] = []
    var hitPoints: [CGPoint] = []
    var focusedApplications: [UUID] = []
    var containingWindowReads = 0
    var containingWindowInsideFence: AccessibilityTestNode?
    var containingElement: AccessibilityElement?
    var containingElementInsideFence: AccessibilityElement?
    var actions: [(String, UUID, Bool)] = []
    var writes: [(String, UUID, Bool)] = []
    var actionTakes = true
    var writeTakes = true
    var writeReturns = true
    var document: String? = nil
    var foreground: pid_t? = 101
    var onDescribe: ((AccessibilityElement) -> Void)?
    var onValue: ((AccessibilityElement) -> Void)?
    var onWrite: ((AccessibilityElement) -> Void)?
    var onOwner: (() -> Void)?
    var wakeEnabled = false
    var wakeAlreadyEnabled = false
    var wakeVerified = false
    var wakeRestoreSucceeds = true
    var wakePrepares = 0
    var wakeApplies = 0
    var wakeRestores = 0
    var wakeRestoreAttempts = 0
    var wakeApplyInsideFence = false
    var wakeRestoreInsideFence = false
    var pidOverrides: [UUID: pid_t] = [:]
    var ownerOverrides: [pid_t: NativeOwner] = [:]
    var applicationOverrides: [pid_t: AccessibilityElement] = [:]
    var menuRoot: AccessibilityTestNode?
    var menuRootInsideFence: AccessibilityTestNode?
    var menuParents: [UUID: AccessibilityElement] = [:]
    var menuParentsInsideFence: [UUID: AccessibilityElement] = [:]
    var menuDescriptions: [UUID: Int] = [:]
    var menuRootReads = 0
    var menuParentReads = 0
    var menuElementIDs: [String: String] = [:]
    var onMenuDescribe: ((AccessibilityElement) -> Void)?
    var textSelection = AccessibilitySelection(location: 6, length: 0)
    var textStateAvailable = true
    var textValueSettable = true
    var textSelectionSettable = true
    var textSelectionTakes = true
    var textSelectionReturns = true
    var textValueThrows = false
    var textSelectionThrows = false
    var textStates = 0
    var textSelectionWrites: [(AccessibilitySelection, UUID, Bool)] = []
    var textFocusedInsideFence: AccessibilityTestNode?
    var onTextState: ((AccessibilityElement) -> Void)?
    var onTextDocument: ((AccessibilityElement) -> Void)?
    var windows: [CaptureWindowInfo] = []
    var nodes: [UUID: AccessibilityTestNode] = [:]
    var results: [Result<ServerReply, ServerFailure>] = []
    let app: AccessibilityTestNode
    let window: AccessibilityTestNode
    let text: AccessibilityTestNode
    let button: AccessibilityTestNode
    let password: AccessibilityTestNode
    var hit: AccessibilityTestNode
    var focused: AccessibilityTestNode

    init() {
        let bounds = CGRect(x: 0, y: 0, width: 300, height: 200)
        app = AccessibilityTestNode("AXApplication", name: "Synthetic app", bounds: bounds)
        window = AccessibilityTestNode("AXWindow", name: "Synthetic window", bounds: bounds)
        text = AccessibilityTestNode("AXTextField", name: "Title", bounds: CGRect(x: 20, y: 20, width: 100, height: 30), value: "Before")
        button = AccessibilityTestNode("AXButton", name: "Increment", bounds: CGRect(x: 20, y: 70, width: 100, height: 30))
        password = AccessibilityTestNode("AXTextField", name: "Password", bounds: CGRect(x: 20, y: 120, width: 100, height: 30),
                                         subrole: "AXSecureTextField", value: "NEVER_READ_THIS_SYNTHETIC_SECRET")
        text.editable = true; text.focused = true; password.editable = true
        app.children = [window]; window.children = [text, button, password]
        hit = text; focused = text
        for node in [app, window, text, button, password] { nodes[node.element.identity] = node }
        windows = [CaptureWindowInfo(windowID: "1010", pid: 101, bounds: bounds, onScreen: true, minimized: false,
                                     owner: owner, regularOwner: true)]
    }

    func node(_ element: AccessibilityElement) throws -> AccessibilityTestNode {
        guard let node = nodes[element.identity] else {
            throw ServerFailure(code: "stale_ref", message: "The synthetic AX object no longer exists.")
        }
        return node
    }

    func drain() {
        while !work.isEmpty { work.removeFirst()() }
    }

    func replaceOwner(_ owner: NativeOwner) {
        self.owner = owner
        windows = [CaptureWindowInfo(windowID: "1010", pid: owner.process.pid,
                                     bounds: window.bounds, onScreen: true, minimized: false, owner: owner, regularOwner: true)]
        foreground = owner.process.pid
    }
}

private final class AccessibilityFixture {
    let state: AccessibilityTestState
    var session: ServerSession
    let captures: CaptureRegistry
    let service: AccessibilityService

    init(approved: Bool = true, paused: Bool = false, mode: String = "foreground", containingWindow: Bool = false,
         hostResolver: HostOwnershipResolver? = nil, menus: Bool = false, textBackend: Bool = false) {
        let state = AccessibilityTestState()
        let captures = CaptureRegistry()
        self.state = state; self.captures = captures
        self.session = ServerSession(id: "synthetic-accessibility", revision: 1, mode: mode, paused: paused,
            approved: approved ? [state.owner.identity.wire] : [], vectorPids: [900], vectorWindowIds: ["9000"],
            overlayWindowIds: ["9001"], escStops: true, stopChord: "Command+Shift+Escape")
        self.service = AccessibilityService(
            captures: captures,
            backend: AccessibilityBackend(
                preflight: { state.preflights += 1; return state.granted && !(state.insideFence && state.denyAtMutation) },
                windows: { state.windowReads += 1; return state.windows },
                owner: { pid in
                    state.ownerReads += 1; state.onOwner?()
                    if pid == state.owner.process.pid { return state.owner }
                    guard let owner = state.ownerOverrides[pid] else { throw ServerFailure(code: "app_not_found", message: "No synthetic owner.") }
                    return owner
                },
                application: { pid in state.applications.append(pid); return state.applicationOverrides[pid] ?? state.app.element },
                pid: { element in state.pidOverrides[element.identity] ?? state.owner.process.pid },
                describe: { element in
                    state.descriptions[element.identity, default: 0] += 1
                    state.onDescribe?(element)
                    return try state.node(element).attributes
                },
                value: { element in
                    state.values[element.identity, default: 0] += 1
                    state.onValue?(element)
                    return try state.node(element).value
                },
                children: { element, limit in
                    state.childLimits.append(limit)
                    state.childRequests.append((element.identity, limit))
                    let children = try state.node(element).children
                    return AccessibilityChildren(elements: Array(children.prefix(max(0, limit))).map(\.element),
                                                  truncated: children.count > max(0, limit))
                },
                hitTest: { application, point in
                    state.hitApplications.append(application.identity); state.hitPoints.append(point)
                    return state.hit.element
                },
                focused: { application in state.focusedApplications.append(application.identity); return state.focused.element },
                frontmostPID: { state.foreground },
                perform: { element, action in
                    state.actions.append((action, element.identity, state.insideFence)); return state.actionTakes
                },
                setValue: { element, value in
                    state.writes.append((value, element.identity, state.insideFence))
                    if state.writeTakes { let node = try state.node(element); node.value = value }
                    state.onWrite?(element)
                    return state.writeReturns
                },
                document: { element in state.documents[element.identity, default: 0] += 1; return state.document },
                equal: { $0.identity == $1.identity },
                hash: { UInt(bitPattern: $0.identity.hashValue) },
                prepareWake: { _, _ in
                    state.wakePrepares += 1
                    guard state.wakeEnabled && !state.wakeAlreadyEnabled else { return nil }
                    return AccessibilityWake(apply: {
                        state.wakeApplies += 1; state.wakeApplyInsideFence = state.insideFence; return true
                    }, restore: {
                        state.wakeRestores += 1; state.wakeRestoreInsideFence = state.wakeRestoreInsideFence || state.insideFence
                    }, restoreVerified: state.wakeVerified ? { () -> Bool in
                        state.wakeRestoreAttempts += 1; state.wakeRestoreInsideFence = state.wakeRestoreInsideFence || state.insideFence
                        if state.wakeRestoreSucceeds { state.wakeRestores += 1 }
                        return state.wakeRestoreSucceeds
                    } : nil)
                },
                containingWindow: containingWindow ? { (_: AccessibilityElement) throws -> AccessibilityElement? in
                    state.containingWindowReads += 1
                    if state.insideFence {
                        return state.containingElementInsideFence ?? state.containingWindowInsideFence?.element ?? state.containingElement ?? state.window.element
                    }
                    return state.containingElement ?? state.window.element
                } : nil,
                hostResolver: hostResolver,
                menuRoot: menus ? { (_: AccessibilityElement) throws -> AccessibilityElement? in
                    state.menuRootReads += 1
                    return (state.insideFence ? state.menuRootInsideFence ?? state.menuRoot : state.menuRoot)?.element
                } : nil,
                parent: menus ? { (element: AccessibilityElement) throws -> AccessibilityElement? in
                    state.menuParentReads += 1
                    return state.insideFence ? state.menuParentsInsideFence[element.identity] ?? state.menuParents[element.identity] : state.menuParents[element.identity]
                } : nil,
                menuDescribe: menus ? { (element: AccessibilityElement) throws -> AccessibilityMenuAttributes in
                    state.menuDescriptions[element.identity, default: 0] += 1
                    state.onMenuDescribe?(element)
                    let node = try state.node(element)
                    return AccessibilityMenuAttributes(role: node.role, subrole: node.subrole, name: node.name,
                        bounds: node.menuBounds, enabled: node.enabled, focused: node.focused, editable: node.editable,
                        menuShortcut: node.menuShortcut, shortcutComplete: node.shortcutComplete)
                } : nil,
                text: textBackend ? AccessibilityTextBackend(
                    attributes: { element in
                        state.descriptions[element.identity, default: 0] += 1; state.onDescribe?(element)
                        return try state.node(element).attributes
                    },
                    state: { element in
                        state.textStates += 1; state.onTextState?(element)
                        guard state.textStateAvailable, let value = try state.node(element).value else { return nil }
                        return AccessibilityTextState(value: value, selection: state.textSelection,
                            valueSettable: state.textValueSettable, selectionSettable: state.textSelectionSettable)
                    },
                    focused: { _ in state.insideFence ? state.textFocusedInsideFence?.element ?? state.focused.element : state.focused.element },
                    window: { _ in
                        state.insideFence
                            ? state.containingElementInsideFence ?? state.containingWindowInsideFence?.element ?? state.containingElement ?? state.window.element
                            : state.containingElement ?? state.window.element
                    },
                    bounds: { try state.node($0).bounds },
                    document: { element in state.onTextDocument?(element); return state.document },
                    setValue: { element, value in
                        state.writes.append((value, element.identity, state.insideFence))
                        if state.writeTakes { let node = try state.node(element); node.value = value }
                        state.onWrite?(element)
                        if state.textValueThrows { throw ServerFailure(code: "failed", message: "Synthetic uncertain AX write.") }
                        return state.writeReturns
                    },
                    setSelection: { element, selection in
                        state.textSelectionWrites.append((selection, element.identity, state.insideFence))
                        if state.textSelectionTakes { state.textSelection = selection }
                        if state.textSelectionThrows { throw ServerFailure(code: "failed", message: "Synthetic uncertain AX selection.") }
                        return state.textSelectionReturns
                    }
                ) : nil
            ),
            execute: { work in if state.holdWork { state.work.append(work) } else { work() } },
            now: { state.clock }
        )
        self.service.noteSession(self.session)
    }

    func context() -> OperationContext {
        let state = state
        let epoch = state.epoch
        return OperationContext(session: session, isCurrent: { state.epoch == epoch }, withCurrent: { body in
            guard state.epoch == epoch, !state.refuseFence else { return false }
            state.insideFence = true
            defer { state.insideFence = false }
            body()
            return true
        })
    }

    func call(_ operation: String, _ args: [String: JSONValue] = [:], context: OperationContext? = nil) {
        let completion: Dispatcher.Completion = { self.state.results.append($0) }
        let current = context ?? self.context()
        switch operation {
        case "ui.tree": service.tree(args, context: current, completion: completion)
        case "ui.hittest": service.hitTest(args, context: current, completion: completion)
        case "ui.focused": service.focused(args, context: current, completion: completion)
        case "ui.resolve": service.resolve(args, context: current, completion: completion)
        case "ui.perform": service.perform(args, context: current, completion: completion)
        case "ui.setValue": service.setValue(args, context: current, completion: completion)
        case "input.type": service.insertText(args, context: current, completion: completion)
        default: state.results.append(.failure(ServerFailure(code: "failed", message: "Invalid synthetic test operation.")))
        }
    }

    func treeArgs(maxNodes: Int = 100, maxDepth: Int = 8) -> [String: JSONValue] {
        ["pid": .integer(Int64(state.owner.process.pid)), "maxNodes": .integer(Int64(maxNodes)), "maxDepth": .integer(Int64(maxDepth))]
    }

    func performArgs(_ ref: String, action: String = "AXPress") -> [String: JSONValue] {
        var args: [String: JSONValue] = ["ref": .string(ref), "action": .string(action), "pid": .integer(Int64(state.owner.process.pid)),
            "sessionId": .string(session.id), "phaseRevision": .integer(Int64(session.revision ?? 0))]
        if let id = state.menuElementIDs[ref] { args["elementId"] = .string(id) }
        return args
    }

    func setArgs(_ ref: String, value: String = "After") -> [String: JSONValue] {
        var args: [String: JSONValue] = ["ref": .string(ref), "value": .string(value), "pid": .integer(Int64(state.owner.process.pid)),
            "sessionId": .string(session.id), "phaseRevision": .integer(Int64(session.revision ?? 0))]
        if let id = state.menuElementIDs[ref] { args["elementId"] = .string(id) }
        return args
    }

    func insertArgs(_ ref: String, text: String = "!") -> [String: JSONValue] {
        var args = setArgs(ref, value: text)
        args.removeValue(forKey: "value"); args["text"] = .string(text)
        return args
    }

    func advancePhase(paused: Bool) {
        service.invalidateObservations()
        session.revision = (session.revision ?? 0) + 1; session.observationEpoch = UUID(); session.paused = paused
        state.epoch += 1
        service.noteSession(session)
    }

    func replaceRun() {
        let previous = session
        session = ServerSession(id: previous.id, revision: previous.revision, mode: previous.mode, paused: previous.paused,
            approved: previous.approved, vectorPids: previous.vectorPids, vectorWindowIds: previous.vectorWindowIds,
            overlayWindowIds: previous.overlayWindowIds, escStops: previous.escStops, stopChord: previous.stopChord)
        session.observationEpoch = previous.observationEpoch
        state.epoch += 1
        service.noteSession(session)
    }

    func success(_ index: Int? = nil) throws -> [String: JSONValue] {
        let index = index ?? (state.results.count - 1)
        guard index >= 0, index < state.results.count, case .success(let reply) = state.results[index] else {
            throw AccessibilityTestFailure(message: "Expected a successful synthetic accessibility result")
        }
        return reply.fields
    }

    func failure(_ index: Int? = nil) -> String? {
        let index = index ?? (state.results.count - 1)
        guard index >= 0, index < state.results.count, case .failure(let error) = state.results[index] else { return nil }
        return error.code
    }

    func ref(named name: String) throws -> String {
        call("ui.tree", treeArgs())
        let nodes = try success()["nodes"]?.arrayValue ?? []
        guard let ref = nodes.first(where: { $0["name"]?.stringValue == name })?["ref"]?.stringValue else {
            throw AccessibilityTestFailure(message: "Synthetic tree omitted the expected node reference")
        }
        return ref
    }

    func retainCapture(windowCapture: Bool = false) throws -> String {
        let id = "cap_synthetic_ax"
        let window = state.windows[0]
        try captures.store(CaptureGeometry(captureID: id, displayID: "1", bounds: window.bounds,
            nativePixelSize: window.bounds.size, captureScale: 1, width: 300, height: 200, imageScale: 1,
            sessionID: session.id, observationEpoch: session.observationEpoch, phaseRevision: session.revision,
            configurationGeneration: captures.generation,
            windowID: windowCapture ? window.windowID : nil, windowFrame: windowCapture ? window.bounds : nil,
            ownerProcess: windowCapture ? state.owner.process : nil,
            windows: [CaptureWindowWitness(windowID: window.windowID, process: state.owner.process,
                                           bounds: window.bounds, onScreen: window.onScreen)]))
        return id
    }
}

/// An independent real menu ancestry, including a geometry-free root and unnamed AXMenu container.
private final class AccessibilityMenuFixture {
    let fake: AccessibilityFixture
    let root = AccessibilityTestNode("AXMenuBar", name: "", bounds: .zero)
    let file = AccessibilityTestNode("AXMenuBarItem", name: "File", bounds: .zero)
    let container = AccessibilityTestNode("AXMenu", name: "", bounds: .zero)
    let item = AccessibilityTestNode("AXMenuItem", name: "Export", bounds: .zero)

    init(approved: Bool = true, mode: String = "background", windowless: Bool = true, textBackend: Bool = false) {
        fake = AccessibilityFixture(approved: approved, mode: mode, menus: true, textBackend: textBackend)
        root.children = [file]; file.children = [container]; container.children = [item]
        for node in [root, file, container, item] {
            node.menuBounds = nil
            fake.state.nodes[node.element.identity] = node
        }
        fake.state.menuParents[file.element.identity] = root.element
        fake.state.menuParents[container.element.identity] = file.element
        fake.state.menuParents[item.element.identity] = container.element
        fake.state.menuRoot = root
        fake.state.foreground = 707
        if windowless { fake.state.windows = [] }
    }

    func read() throws -> [JSONValue] {
        fake.call("ui.tree", fake.treeArgs())
        let nodes = try fake.success()["nodes"]?.arrayValue ?? []
        for node in nodes {
            if node["scope"] == .string("app-menu"), let ref = node["ref"]?.stringValue, let id = node["elementId"]?.stringValue {
                fake.state.menuElementIDs[ref] = id
            }
        }
        return nodes
    }

    func ref(named name: String) throws -> String {
        guard let ref = try read().first(where: { $0["scope"] == .string("app-menu") && $0["name"] == .string(name) })?["ref"]?.stringValue else {
            throw AccessibilityTestFailure(message: "Synthetic app menu omitted its observed reference")
        }
        return ref
    }
}

private final class AccessibilityHostParents {
    var links: [UUID: AccessibilityElement] = [:]
}

/// A real resolver-backed hosted panel, with actual endpoint/CG/client distinctions but no native handles.
private final class AccessibilityHostedFixture {
    let host: HostOwnershipTestFixture
    let fake: AccessibilityFixture
    let parents: AccessibilityHostParents

    init(surfaceIsPhysical: Bool = false, resolverEnabled: Bool = true, containingWindow: Bool = true) {
        let host = HostOwnershipTestFixture(surfaceIsPhysical: surfaceIsPhysical)
        let parents = AccessibilityHostParents()
        var backend = host.backend()
        backend.parent = { parents.links[$0.identity] }
        let resolver = HostOwnershipResolver(backend: backend, now: { host.time })
        let fake = AccessibilityFixture(containingWindow: containingWindow, hostResolver: resolverEnabled ? resolver : nil)
        self.host = host; self.fake = fake; self.parents = parents
        let state = fake.state
        state.owner = host.physical
        state.ownerOverrides[host.logical.process.pid] = host.logical
        state.foreground = host.logical.process.pid
        state.window.bounds = host.surface.bounds
        state.app.bounds = host.surface.bounds
        state.text.bounds = CGRect(x: host.surface.bounds.minX + 20, y: host.surface.bounds.minY + 20, width: 100, height: 30)
        state.button.bounds = CGRect(x: host.surface.bounds.minX + 20, y: host.surface.bounds.minY + 70, width: 100, height: 30)
        state.password.bounds = CGRect(x: host.surface.bounds.minX + 20, y: host.surface.bounds.minY + 120, width: 100, height: 30)
        state.nodes[host.physicalRoot.identity] = state.window
        state.nodes[host.logicalWindow.identity] = state.window
        state.containingElement = host.physicalRoot
        state.pidOverrides[state.app.element.identity] = host.logical.process.pid
        state.pidOverrides[host.logicalWindow.identity] = host.logical.process.pid
        state.applicationOverrides[host.logical.process.pid] = state.app.element
        let physicalApp = AccessibilityTestNode("AXApplication", name: "Synthetic physical host", bounds: host.surface.bounds)
        physicalApp.children = [state.window]
        state.nodes[physicalApp.element.identity] = physicalApp
        state.applicationOverrides[host.physical.process.pid] = physicalApp.element
        for node in [state.window, state.text, state.button, state.password, physicalApp] {
            host.elementPIDs[node.element.identity] = host.physical.process.pid
            host.elementBounds[node.element.identity] = node.bounds
            parents.links[node.element.identity] = host.physicalRoot
        }
        host.elementPIDs[state.app.element.identity] = host.logical.process.pid
        host.elementBounds[state.app.element.identity] = host.surface.bounds
        var window = host.surface
        window.owner = surfaceIsPhysical ? host.physical : host.logical
        host.window = window; host.windows = [window]; state.windows = [window]
        fake.session = host.session()
        fake.service.noteSession(fake.session)
    }

    func mutateArgs(_ ref: String, value: String = "Hosted edit") -> [String: JSONValue] {
        ["ref": .string(ref), "value": .string(value), "pid": .integer(Int64(host.logical.process.pid)),
         "sessionId": .string(fake.session.id), "phaseRevision": .integer(Int64(fake.session.revision ?? 0))]
    }
}

/// Every AX object, native owner/window fact, clock and executor is synthetic. The system backend is never used,
/// and these checks never create AXUIElements, inspect a desktop, request grants, move a pointer or post input.
func runAccessibilityTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let fake = AccessibilityFixture()
        let features = fake.service.features()
        for feature in ["ui.tree", "ui.actions", "ui.secureFieldDetect"] {
            try accessibilityCheck(features[feature] == true, "The implemented AX protocol feature groups are advertised")
        }
        try accessibilityCheck(fake.state.preflights == 0 && fake.state.applications.isEmpty,
                               "Feature reporting does not query Accessibility or an app")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.call("ui.tree", fake.treeArgs())
        let reply = try fake.success()
        let nodes = reply["nodes"]?.arrayValue ?? []
        try accessibilityCheck(reply["generation"]?.intValue != nil && reply["truncated"] == .bool(false) &&
                               nodes.contains { $0["role"] == .string("AXButton") && $0["name"] == .string("Increment") },
                               "A complete synthetic snapshot contains actionable native roles and sanitized names")
        try accessibilityCheck(nodes.allSatisfy { $0["ref"]?.stringValue?.isEmpty == false && $0["bounds"]?.objectValue != nil },
                               "Every disclosed tree node has a native generation-scoped ref and geometry")
        let secure = nodes.first { $0["name"] == .string("Password") }
        try accessibilityCheck(secure?["secure"] == .bool(true) && secure?["value"] == .string("REDACTED"),
                               "A secure AX subrole is marked secure and represented without its value")
        try accessibilityCheck(fake.state.values[fake.state.password.element.identity, default: 0] == 0,
                               "Secure values are never requested from the backend, even when the backend could return them")
        try accessibilityCheck(fake.state.actions.isEmpty && fake.state.writes.isEmpty,
                               "A read-only snapshot never invokes an AX action or value mutation")
        fake.call("ui.tree", ["windowId": .string("1010"), "maxNodes": .integer(100), "maxDepth": .integer(8)])
        try accessibilityCheck(try fake.success()["nodes"]?.arrayValue?.count == nodes.count,
                               "The exact native-window target form selects the same approved bounded tree")
    }

    try test {
        let fake = AccessibilityFixture()
        let forbidden: [UInt32] = [0, 8, 10, 31, 127, 128, 159, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
                                   0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
                                   0x2060, 0x2061, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]
        let controls = String(String.UnicodeScalarView(forbidden.compactMap(UnicodeScalar.init)))
        fake.state.text.name = controls + String(repeating: "n", count: 700)
        fake.state.text.value = controls + String(repeating: "v", count: 700)
        fake.call("ui.tree", fake.treeArgs())
        let node = try fake.success()["nodes"]?.arrayValue?.first { $0["role"] == .string("AXTextField") && $0["secure"] == .bool(false) }
        let name = node?["name"]?.stringValue ?? ""
        let value = node?["value"]?.stringValue ?? ""
        try accessibilityCheck(!name.isEmpty && !value.isEmpty && name.utf16.count <= 500 && value.utf16.count <= 500,
                               "AX content is capped before it leaves the helper")
        try accessibilityCheck(!name.unicodeScalars.contains { forbidden.contains($0.value) } &&
                               !value.unicodeScalars.contains { forbidden.contains($0.value) },
                               "AX names and values strip controls, bidi formatting and zero-width ranges")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.call("ui.tree", fake.treeArgs(maxNodes: 2))
        let reply = try fake.success()
        try accessibilityCheck(reply["nodes"]?.arrayValue?.count == 2 && reply["truncated"] == .bool(true),
                               "A snapshot respects its node budget and reports incomplete traversal")
        try accessibilityCheck(fake.state.childLimits.allSatisfy { $0 >= 0 && $0 <= 128 } &&
                               fake.state.childRequests.filter { $0.0 != fake.state.app.element.identity }.allSatisfy { $0.1 <= 2 },
                               "Window lookup has its own finite cap and traversal child copies respect the remaining node budget")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.call("ui.tree", fake.treeArgs(maxDepth: 1))
        let reply = try fake.success()
        try accessibilityCheck(reply["nodes"]?.arrayValue?.count == 1 && reply["truncated"] == .bool(true),
                               "A depth-limited tree returns its root and truthfully reports omitted descendants")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.state.onDescribe = { _ in fake.state.clock += 20_000_000_000 }
        fake.call("ui.tree", fake.treeArgs())
        let reply = try fake.success()
        try accessibilityCheck(reply["truncated"] == .bool(true) && (reply["nodes"]?.arrayValue?.count ?? 100) < 5,
                               "An AX deadline returns bounded partial data rather than walking indefinitely")
    }

    try test {
        for approved in [false, true] {
            let fake = AccessibilityFixture(approved: approved)
            if approved {
                fake.state.replaceOwner(accessibilityOwner("com.apple.Terminal"))
                fake.session.approved = [fake.state.owner.identity.wire]
            }
            fake.call("ui.tree", fake.treeArgs())
            try accessibilityCheck(fake.failure() == (approved ? "protected" : "not_granted"),
                                   "A tree requires both an approved app identity and the native never-list floor")
            try accessibilityCheck(fake.state.applications.isEmpty && fake.state.descriptions.isEmpty &&
                                   fake.state.values.isEmpty && fake.state.documents.isEmpty,
                                   "Denied trees do not read AX elements or content and cannot mint refs")
        }
    }

    try test {
        let fake = AccessibilityFixture()
        let captureID = try fake.retainCapture()
        let vector = accessibilityOwner(Identity.channels[0].appId, pid: 900)
        fake.state.windows.insert(CaptureWindowInfo(windowID: "9001", pid: 900, bounds: fake.state.window.bounds,
            onScreen: true, minimized: false, owner: vector, regularOwner: false), at: 0)
        fake.call("ui.hittest", ["captureId": .string(captureID), "x": .integer(25), "y": .integer(25)])
        let hit = try fake.success()
        try accessibilityCheck(hit["role"] == .string("AXTextField") && hit["name"] == .string("Title") &&
                               hit["windowId"] == .string("1010") && hit["secure"] == .bool(false) &&
                               hit["ref"]?.stringValue != nil && hit["elementId"]?.stringValue != nil,
                               "An approved app-scoped hit reports actual native element and owner facts")
        try accessibilityCheck(fake.state.hitApplications == [fake.state.app.element.identity] &&
                               fake.state.hitPoints == [CGPoint(x: 25.5, y: 25.5)],
                               "Hit testing uses the target app root at the mapped pixel center and excludes exact overlay IDs")
        try accessibilityCheck(fake.state.actions.isEmpty && fake.state.writes.isEmpty,
                               "Hit testing never activates a window or changes the pointer")
        let independent = AccessibilityFixture()
        independent.state.windows = [CaptureWindowInfo(windowID: "1010", pid: 101, bounds: independent.state.window.bounds,
            onScreen: false, minimized: false, owner: independent.state.owner, regularOwner: true)]
        let independentID = try independent.retainCapture(windowCapture: true)
        independent.state.windows.insert(CaptureWindowInfo(windowID: "2020", pid: 202, bounds: independent.state.window.bounds,
            onScreen: true, minimized: false, owner: accessibilityOwner("example.occluder", pid: 202), regularOwner: true), at: 0)
        independent.call("ui.hittest", ["captureId": .string(independentID), "x": .integer(25), "y": .integer(25)])
        try accessibilityCheck(try independent.success()["windowId"] == .string("1010") &&
                               independent.state.applications == [101] &&
                               independent.state.hitApplications == [independent.state.app.element.identity],
                               "An independent offscreen/occluded window capture hit-tests its exact captured app instead of a current display occluder")
    }

    try test {
        let fake = AccessibilityFixture()
        let captureID = try fake.retainCapture()
        fake.call("ui.hittest", ["captureId": .string(captureID), "x": .integer(300), "y": .integer(0)])
        try accessibilityCheck(fake.failure() == "out_of_bounds" && fake.state.hitApplications.isEmpty,
                               "An image-edge coordinate outside the frame never reaches AX hit testing")
        fake.captures.invalidateDisplays()
        fake.call("ui.hittest", ["captureId": .string(captureID), "x": .integer(25), "y": .integer(25)])
        try accessibilityCheck(fake.failure() == "stale_frame" && fake.state.hitApplications.isEmpty,
                               "Reconfigured capture geometry is refused before app-scoped AX lookup")
    }

    try test {
        for protected in [false, true] {
            let fake = AccessibilityFixture(approved: false)
            if protected { fake.state.replaceOwner(accessibilityOwner("com.apple.Terminal")) }
            fake.state.hit = fake.state.password
            fake.state.focused = fake.state.password
            let captureID = try fake.retainCapture()
            fake.call("ui.hittest", ["captureId": .string(captureID), "x": .integer(25), "y": .integer(125)])
            fake.call("ui.focused")
            for index in 0..<2 {
                let structural = try fake.success(index)
                try accessibilityCheck(structural["owner"] == fake.state.owner.identity.wire &&
                                       structural["windowId"] == .string("1010") &&
                                       structural["role"] == .string("AXWindow") && structural["secure"] == .bool(false),
                                       "Outside authority, observations describe the actual native window without inventing an AX element")
                for field in ["ref", "elementId", "name", "value", "document", "programPath", "layout", "focusedMenuShortcuts", "windowTitle"] {
                    try accessibilityCheck(structural[field] == nil, "Structural observations omit every content-bearing field and UI reference")
                }
            }
            try accessibilityCheck(fake.state.applications.isEmpty && fake.state.hitApplications.isEmpty &&
                                   fake.state.focusedApplications.isEmpty && fake.state.descriptions.isEmpty &&
                                   fake.state.values.isEmpty && fake.state.documents.isEmpty,
                                   "Protected/unapproved observations perform no AX lookup, including security or content reads")
        }
    }

    try test {
        let fake = AccessibilityFixture(paused: true)
        fake.call("ui.focused")
        let first = try fake.success()
        guard let ref = first["ref"]?.stringValue, let elementID = first["elementId"]?.stringValue else {
            throw AccessibilityTestFailure(message: "Approved focus omitted its native identities")
        }
        fake.state.text.value = "Changed without replacing the native element"
        fake.call("ui.resolve", ["ref": .string(ref)])
        let resolved = try fake.success()
        try accessibilityCheck(resolved["ref"] == .string(ref) && resolved["elementId"] == .string(elementID) &&
                               resolved["windowId"] == .string("1010") && resolved["role"] == .string("AXTextField"),
                               "Resolving an approved native element remains read-only and valid while input is paused")
        try accessibilityCheck(fake.state.actions.isEmpty && fake.state.writes.isEmpty,
                               "Resolve cannot take focus or modify an element")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.call("ui.focused")
        let old = try fake.success()
        guard let oldRef = old["ref"]?.stringValue else { throw AccessibilityTestFailure(message: "Missing old focused ref") }
        _ = try fake.ref(named: "Title")
        fake.call("ui.resolve", ["ref": .string(oldRef)])
        try accessibilityCheck(fake.failure() == "stale_ref", "A fresh snapshot retires refs from the previous generation")
        fake.call("ui.focused")
        let fresh = try fake.success()
        try accessibilityCheck(fresh["elementId"] == old["elementId"] && fresh["ref"] != old["ref"],
                               "Stable native element identity survives a new snapshot while its reference refreshes")
    }

    try test {
        let fake = AccessibilityFixture()
        let ref = try fake.ref(named: "Title")
        fake.replaceRun()
        fake.call("ui.resolve", ["ref": .string(ref)])
        try accessibilityCheck(fake.failure() == "stale_ref", "A fresh native run cannot reuse refs even when the wire ID, revision and observation epoch are repeated")
    }

    try test {
        let fake = AccessibilityFixture()
        let ref = try fake.ref(named: "Increment")
        fake.call("ui.perform", fake.performArgs(ref))
        try accessibilityCheck(try fake.success()["took"] == .bool(true) && fake.state.actions.count == 1 &&
                               fake.state.actions[0].0 == "AXPress" && fake.state.actions[0].1 == fake.state.button.element.identity &&
                               fake.state.actions[0].2, "An AX action executes on the bound native element inside the current authority fence")
        try accessibilityCheck(fake.state.writes.isEmpty, "Performing an AX action does not synthesize typed text")
    }

    try test {
        let fake = AccessibilityFixture()
        let ref = try fake.ref(named: "Title")
        fake.call("ui.setValue", fake.setArgs(ref))
        try accessibilityCheck(try fake.success()["took"] == .bool(true) && fake.state.text.value == "After" &&
                               fake.state.writes.count == 1 && fake.state.writes[0].2,
                               "A direct AX value set is fenced and reports whether the value actually took")
        fake.state.writeTakes = false
        fake.call("ui.setValue", fake.setArgs(ref, value: "Ignored by target"))
        try accessibilityCheck(try fake.success()["took"] == .bool(false) && fake.state.text.value == "After",
                               "A successful setter return does not hide a failed native value readback")
        let exactLimit = String(repeating: "v", count: 4000)
        try accessibilityCheck(AccessibilityNative.completeString(exactLimit as CFString, limit: 4000) == exactLimit &&
                               AccessibilityNative.completeString((exactLimit + "extra") as CFString, limit: 4000) == nil,
                               "Native write verification requires the complete value; a matching 4000-unit prefix cannot prove a successful write")
    }

    try test {
        let fake = AccessibilityFixture()
        let ref = try fake.ref(named: "Password")
        fake.call("ui.setValue", fake.setArgs(ref, value: "Synthetic credential"))
        try accessibilityCheck(fake.failure() == "secure_field" && fake.state.writes.isEmpty &&
                               fake.state.values[fake.state.password.element.identity, default: 0] == 0,
                               "Secure fields refuse direct value mutation without reading their existing value")
        let developer = AccessibilityFixture()
        developer.state.replaceOwner(accessibilityOwner("com.microsoft.VSCode"))
        developer.session.approved = [developer.state.owner.identity.wire]
        let developerRef = try developer.ref(named: "Title")
        developer.call("ui.setValue", developer.setArgs(developerRef))
        try accessibilityCheck(developer.failure() == "blocked" && developer.state.writes.isEmpty,
                               "The shared developer click-only floor applies to direct AX value writes")
        let changed = AccessibilityFixture()
        let changedRef = try changed.ref(named: "Title")
        let valueReads = changed.state.values[changed.state.text.element.identity, default: 0]
        changed.state.onWrite = { element in
            if element.identity == changed.state.text.element.identity { changed.state.text.subrole = "AXSecureTextField" }
        }
        changed.call("ui.setValue", changed.setArgs(changedRef))
        try accessibilityCheck(changed.failure() == "secure_field" && changed.state.writes.count == 1 &&
                               changed.state.values[changed.state.text.element.identity, default: 0] == valueReads,
                               "If a nonsecure target becomes secure after writing, its value is never fetched for readback")
    }

    try test {
        let fake = AccessibilityFixture(mode: "background")
        let windowRef = try fake.ref(named: "Synthetic window")
        fake.call("ui.perform", fake.performArgs(windowRef, action: "AXRaise"))
        try accessibilityCheck(fake.failure() == "needs_foreground" && fake.state.actions.isEmpty,
                               "Background AXRaise never activates the app or bypasses the foreground ask")
        let buttonRef = try fake.ref(named: "Increment")
        fake.call("ui.perform", fake.performArgs(buttonRef))
        try accessibilityCheck(try fake.success()["took"] == .bool(true) && fake.state.actions.count == 1 &&
                               fake.state.actions[0].0 == "AXPress", "Background-safe element actions remain available without focus acquisition")
    }

    try test {
        let fake = AccessibilityFixture(mode: "background")
        fake.state.foreground = 707
        let ref = try fake.ref(named: "Increment")
        for action in ["AXIncrement", "AXDecrement", "AXScrollToVisible", "AXPress"] {
            fake.call("ui.perform", fake.performArgs(ref, action: action))
            try accessibilityCheck(try fake.success()["took"] == .bool(true),
                                   "A supported background AX action reports its actual element result")
        }
        try accessibilityCheck(fake.state.actions.map { $0.0 } == ["AXIncrement", "AXDecrement", "AXScrollToVisible", "AXPress"] &&
                               fake.state.actions.allSatisfy { $0.1 == fake.state.button.element.identity && $0.2 } &&
                               fake.state.foreground == 707 && fake.state.hitPoints.isEmpty && fake.state.focusedApplications.isEmpty,
                               "Background actions use only the observed element inside its posting fence without pointer or focus lookup")
    }

    try test {
        let fake = AccessibilityFixture(mode: "background")
        fake.state.foreground = 707
        let ref = try fake.ref(named: "Title")
        fake.state.writeTakes = false
        fake.call("ui.setValue", fake.setArgs(ref, value: "Untaken background edit"))
        try accessibilityCheck(try fake.success()["took"] == .bool(false) && fake.state.text.value == "Before" &&
                               fake.state.writes.count == 1 && fake.state.writes[0].2 && fake.state.actions.isEmpty &&
                               fake.state.foreground == 707 && fake.state.hitPoints.isEmpty,
                               "An untaken background AX write remains an observed failure to take, without taking focus or synthesizing pointer input")
    }

    try test {
        let fake = AccessibilityFixture(paused: true)
        let ref = try fake.ref(named: "Title")
        fake.call("ui.perform", fake.performArgs(ref))
        try accessibilityCheck(fake.failure() == "paused" && fake.state.actions.isEmpty,
                               "A paused session may read refs but cannot perform AX actions")
        fake.call("ui.setValue", fake.setArgs(ref))
        try accessibilityCheck(fake.failure() == "paused" && fake.state.writes.isEmpty,
                               "A paused session cannot set an AX value")
    }

    try test {
        let fake = AccessibilityFixture()
        let ref = try fake.ref(named: "Increment")
        var wrongPID = fake.performArgs(ref); wrongPID["pid"] = .integer(102)
        fake.call("ui.perform", wrongPID)
        try accessibilityCheck(fake.failure() == "changed" && fake.state.actions.isEmpty,
                               "Expected native PIDs cannot be replaced by a model-selected owner")
        var wrongElement = fake.performArgs(ref); wrongElement["elementId"] = .string("synthetic-replacement")
        fake.call("ui.perform", wrongElement)
        try accessibilityCheck(fake.failure() == "stale_ref" && fake.state.actions.isEmpty,
                               "The freshly observed native element ID binds an AX action")
    }

    try test {
        let fake = AccessibilityFixture()
        let ref = try fake.ref(named: "Title")
        fake.state.replaceOwner(accessibilityOwner(start: 11))
        fake.call("ui.setValue", fake.setArgs(ref))
        try accessibilityCheck(["stale_ref", "changed"].contains(fake.failure() ?? "") && fake.state.writes.isEmpty,
                               "A replaced process cannot inherit a previous signed app's native element reference")
    }

    try test {
        let fake = AccessibilityFixture()
        let ref = try fake.ref(named: "Increment")
        fake.state.refuseFence = true
        fake.call("ui.perform", fake.performArgs(ref))
        try accessibilityCheck(fake.failure() == "changed" && fake.state.actions.isEmpty,
                               "A current read check never replaces the atomic withCurrent mutation fence")
        let denied = AccessibilityFixture()
        let deniedRef = try denied.ref(named: "Title")
        denied.state.denyAtMutation = true
        denied.call("ui.setValue", denied.setArgs(deniedRef))
        try accessibilityCheck(denied.failure() == "permissions" && denied.state.writes.isEmpty,
                               "Accessibility grant loss at the final mutation fence prevents a value write")
    }

    try test {
        let fake = AccessibilityFixture()
        let ref = try fake.ref(named: "Title")
        fake.state.onDescribe = { element in
            if fake.state.insideFence && element.identity == fake.state.text.element.identity {
                fake.state.text.subrole = "AXSecureTextField"
            }
        }
        fake.call("ui.setValue", fake.setArgs(ref))
        try accessibilityCheck(fake.failure() == "secure_field" && fake.state.writes.isEmpty,
                               "The focused native security subrole is re-observed inside the mutation fence")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.state.holdWork = true
        fake.call("ui.tree", fake.treeArgs())
        fake.state.epoch += 1
        fake.state.drain()
        try accessibilityCheck(fake.failure() == "changed" && fake.state.applications.isEmpty,
                               "Revoking a queued operation prevents all subsequent AX traversal")
        let duringRead = AccessibilityFixture()
        duringRead.state.onDescribe = { _ in duringRead.state.epoch += 1 }
        duringRead.call("ui.tree", duringRead.treeArgs())
        try accessibilityCheck(duringRead.failure() == "changed",
                               "A late AX read cannot publish content or refs after session cancellation")
    }

    try test {
        let fake = AccessibilityFixture()
        let ref = try fake.ref(named: "Increment")
        fake.state.holdWork = true
        fake.call("ui.perform", fake.performArgs(ref))
        fake.service.close()
        fake.service.close()
        fake.state.drain()
        try accessibilityCheck(fake.failure() == "changed" && fake.state.actions.isEmpty,
                               "Closing the service idempotently prevents pending AX actions and stale callbacks")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.call("ui.focused")
        try accessibilityCheck(try fake.success()["documentStatus"] == .string("unknown") &&
                               fake.success()["document"] == nil,
                               "Missing native document evidence remains unknown rather than an invented non-file surface")
        fake.state.document = "/virtual/Documents/Fixture.txt"
        fake.call("ui.focused")
        try accessibilityCheck(try fake.success()["documentStatus"] == .string("known") &&
                               fake.success()["document"] == .string("/virtual/Documents/Fixture.txt"),
                               "Positive native document observations are reported only for approved content")
        let prefix = "file:///virtual/Documents/" + String(repeating: "x", count: 4100)
        try accessibilityCheck(AccessibilityNative.documentURL(prefix as CFString) == nil,
                               "A truncated 4096-unit file URL prefix never becomes positive native document proof")
        for (index, text) in ["file:///virtual/a\0b", "file:///virtual/a%00b", "file:///virtual/a?query=secret",
                     "file:///virtual/a#fragment", "file://remote.example/virtual/a", "https://example.test/a"].enumerated() {
            try accessibilityCheck(AccessibilityNative.documentURL(text as CFString) == nil,
                                   "Native document URL decoding refuses invalid fixture \(index + 1)")
        }
        if let encodedNUL = CFURLCreateWithString(nil, "file:///virtual/a%00b" as CFString, nil) {
            try accessibilityCheck(AccessibilityNative.documentURL(encodedNUL) == nil,
                                   "Native CFURL input cannot bypass the encoded-NUL refusal")
        }
        try accessibilityCheck(AccessibilityNative.documentURL("file:///virtual/a%2500b" as CFString) != nil,
                               "A literal percent filename stays distinct from an encoded NUL")
        try accessibilityCheck(AccessibilityNative.documentURL("file:///virtual/Documents/Fixture.txt" as CFString)?.path ==
                               "/virtual/Documents/Fixture.txt", "A complete local file URL retains its exact path without filesystem access")
        let boundary = String(repeating: "a", count: 499) + "😀" + "tail"
        try accessibilityCheck(AccessibilityNative.decodeString(boundary as CFString, limit: 500) == String(repeating: "a", count: 499) &&
                               AccessibilityNative.completeString(NSNumber(value: 7), limit: 500) == nil,
                               "Pure native CF string decoding never splits a surrogate pair or accepts a nonstring value")
    }

    try test {
        let fake = AccessibilityFixture()
        let captureID = try fake.retainCapture()
        let invalid: [(String, [String: JSONValue])] = [
            ("ui.tree", ["pid": .integer(101), "windowId": .string("1010"), "maxNodes": .integer(10), "maxDepth": .integer(3)]),
            ("ui.tree", fake.treeArgs(maxNodes: 0)), ("ui.tree", fake.treeArgs(maxDepth: 0)),
            ("ui.hittest", ["captureId": .string(captureID), "x": .number(0.5), "y": .integer(0)]),
            ("ui.hittest", ["captureId": .string(captureID), "x": .integer(0)]),
            ("ui.focused", ["pid": .integer(101)]), ("ui.resolve", ["ref": .string("")]),
            ("ui.resolve", ["ref": .string(String(repeating: "x", count: 257))])
        ]
        for (operation, args) in invalid {
            fake.call(operation, args)
            try accessibilityCheck(fake.failure() == "failed", "Malformed AX operation arguments are refused before native lookup")
        }
        try accessibilityCheck(fake.state.applications.isEmpty && fake.state.descriptions.isEmpty,
                               "Bad targets, budgets, coordinates and refs cannot cause AX content reads")
        let ref = try fake.ref(named: "Title")
        var oversized = fake.setArgs(ref); oversized["value"] = .string(String(repeating: "x", count: 4001))
        fake.call("ui.setValue", oversized)
        try accessibilityCheck(fake.failure() == "failed" && fake.state.writes.isEmpty, "Direct AX text input obeys the 4000 UTF16-unit limit")
        fake.call("ui.perform", fake.performArgs(ref, action: "AXDestroy"))
        try accessibilityCheck(fake.failure() == "unsupported_action" && fake.state.actions.isEmpty,
                               "Only the explicit native AX action allowlist can reach the backend")
        var stalePhase = fake.performArgs(ref); stalePhase["phaseRevision"] = .integer(2)
        fake.call("ui.perform", stalePhase)
        try accessibilityCheck(fake.failure() == "changed" && fake.state.actions.isEmpty,
                               "A mutation cannot borrow authority from another phase revision")
    }

    try test {
        for operation in ["ui.tree", "ui.hittest", "ui.focused", "ui.resolve", "ui.perform", "ui.setValue"] {
            let fake = AccessibilityFixture()
            let ref = try fake.ref(named: "Title")
            let captureID = try fake.retainCapture()
            let descriptions = fake.state.descriptions.values.reduce(0, +)
            let applications = fake.state.applications.count
            let windowReads = fake.state.windowReads
            fake.state.granted = false
            let args: [String: JSONValue]
            switch operation {
            case "ui.tree": args = fake.treeArgs()
            case "ui.hittest": args = ["captureId": .string(captureID), "x": .integer(25), "y": .integer(25)]
            case "ui.resolve": args = ["ref": .string(ref)]
            case "ui.perform": args = fake.performArgs(ref)
            case "ui.setValue": args = fake.setArgs(ref)
            default: args = [:]
            }
            fake.call(operation, args)
            try accessibilityCheck(fake.failure() == "permissions" && fake.state.applications.count == applications &&
                                   fake.state.descriptions.values.reduce(0, +) == descriptions && fake.state.windowReads == windowReads &&
                                   fake.state.actions.isEmpty && fake.state.writes.isEmpty,
                                   "All six AX operations check the live grant before native lookup or mutation")
        }
    }

    try test {
        let fake = AccessibilityFixture()
        fake.state.pidOverrides[fake.state.text.element.identity] = 102
        fake.call("ui.focused")
        try accessibilityCheck(fake.failure() == "stale_ref" &&
                               fake.state.descriptions[fake.state.text.element.identity, default: 0] == 0 &&
                               fake.state.values[fake.state.text.element.identity, default: 0] == 0 &&
                               fake.state.documents[fake.state.text.element.identity, default: 0] == 0,
                               "A foreign-process focused AX element is refused before its name, value or document is read")
        let captureID = try fake.retainCapture()
        fake.call("ui.hittest", ["captureId": .string(captureID), "x": .integer(25), "y": .integer(25)])
        try accessibilityCheck(fake.failure() == "stale_ref" &&
                               fake.state.descriptions[fake.state.text.element.identity, default: 0] == 0,
                               "App-scoped hit testing also verifies the returned AX object's actual PID before reading a label")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.call("ui.focused")
        let first = try fake.success()
        let replacement = AccessibilityTestNode("AXTextField", name: "Title", bounds: fake.state.text.bounds, value: "Before")
        replacement.editable = true; replacement.focused = true
        fake.state.nodes[replacement.element.identity] = replacement
        fake.state.focused = replacement
        fake.call("ui.focused")
        let second = try fake.success()
        try accessibilityCheck(first["name"] == second["name"] && first["elementId"] != second["elementId"],
                               "Identical labels and bounds cannot substitute for the actual stable native AX object identity")
    }

    try test {
        let fake = AccessibilityFixture(approved: false)
        fake.state.windows.append(CaptureWindowInfo(windowID: "1011", pid: 101,
            bounds: CGRect(x: 400, y: 0, width: 300, height: 200), onScreen: true, minimized: false,
            owner: fake.state.owner, regularOwner: true))
        fake.call("ui.focused")
        try accessibilityCheck(fake.failure() == "unavailable" && fake.state.applications.isEmpty && fake.state.descriptions.isEmpty,
                               "Frontmost-app metadata cannot invent a focused protected/unapproved window when several are possible")
    }

    try test {
        let fake = AccessibilityFixture(containingWindow: true)
        fake.state.windows.append(CaptureWindowInfo(windowID: "1011", pid: 101,
            bounds: CGRect(x: 10, y: 10, width: 200, height: 100), onScreen: true, minimized: false,
            owner: fake.state.owner, regularOwner: true))
        fake.call("ui.focused")
        let focused = try fake.success()
        try accessibilityCheck(focused["windowId"] == .string("1010") && fake.state.containingWindowReads > 0,
                               "The actual AX containing window selects its CG witness when another window also contains the element's bounds")
        guard let ref = focused["ref"]?.stringValue else { throw AccessibilityTestFailure(message: "Missing bound containing-window ref") }
        fake.state.pidOverrides[fake.state.window.element.identity] = 102
        let descriptions = fake.state.descriptions[fake.state.window.element.identity, default: 0]
        fake.call("ui.resolve", ["ref": .string(ref)])
        try accessibilityCheck(fake.failure() == "stale_ref" &&
                               fake.state.descriptions[fake.state.window.element.identity, default: 0] == descriptions,
                               "A foreign-process AX containing window is refused before its attributes can be read")
        let reparented = AccessibilityFixture(containingWindow: true)
        let reparentedRef = try reparented.ref(named: "Title")
        let secondWindow = AccessibilityTestNode("AXWindow", name: "Second synthetic window",
                                                 bounds: CGRect(x: 400, y: 0, width: 300, height: 200))
        reparented.state.nodes[secondWindow.element.identity] = secondWindow
        reparented.state.containingWindowInsideFence = secondWindow
        reparented.call("ui.setValue", reparented.setArgs(reparentedRef))
        try accessibilityCheck(reparented.failure() == "stale_ref" && reparented.state.writes.isEmpty,
                               "A same-PID AX element reparented after outside checks cannot cross the final native-window mutation fence")
        let hidden = AccessibilityFixture()
        let hiddenRef = try hidden.ref(named: "Title")
        hidden.state.windows = [CaptureWindowInfo(windowID: "1010", pid: 101, bounds: hidden.state.window.bounds,
            onScreen: false, minimized: false, owner: hidden.state.owner, regularOwner: true)]
        hidden.call("ui.resolve", ["ref": .string(hiddenRef)])
        try accessibilityCheck(hidden.failure() == "stale_ref", "A changed on-screen witness invalidates an existing native element ref")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.state.wakeEnabled = true
        fake.call("ui.tree", fake.treeArgs())
        _ = try fake.success()
        fake.call("ui.tree", fake.treeArgs())
        _ = try fake.success()
        fake.service.invalidateObservations()
        fake.session.observationEpoch = UUID()
        fake.service.noteSession(fake.session)
        fake.service.retireWakes(session: fake.session)
        fake.call("ui.tree", fake.treeArgs())
        _ = try fake.success()
        try accessibilityCheck(fake.state.wakeApplies == 1 && fake.state.wakeApplyInsideFence && fake.state.wakeRestores == 0,
                               "A fenced AX wake is retained once for the same process/run across snapshots and ordinary authority updates")
        fake.service.noteSession(nil)
        try accessibilityCheck(fake.state.wakeRestores == 0, "The phase notification itself performs no AX restoration under authority")
        fake.service.retireWakes(session: nil)
        fake.service.close(); fake.service.close()
        try accessibilityCheck(fake.state.wakeRestores == 1 && !fake.state.wakeRestoreInsideFence,
                               "Ending the run restores its owned AX wake once outside the mutation fence")
        let canceled = AccessibilityFixture()
        canceled.state.wakeEnabled = true
        canceled.state.onValue = { element in
            if element.identity == canceled.state.text.element.identity { canceled.service.close() }
        }
        canceled.call("ui.tree", canceled.treeArgs())
        try accessibilityCheck(canceled.failure() == "changed" && canceled.state.wakeApplies == 1 && canceled.state.wakeRestores == 1,
                               "Closing during an AX read restores its run's owned wake exactly once before the retired traversal can publish")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.state.wakeEnabled = true
        fake.call("ui.tree", fake.treeArgs())
        _ = try fake.success()
        fake.state.holdWork = true
        fake.session = ServerSession(id: fake.session.id, revision: fake.session.revision, mode: fake.session.mode, paused: false,
            approved: fake.session.approved, vectorPids: fake.session.vectorPids, vectorWindowIds: fake.session.vectorWindowIds,
            overlayWindowIds: fake.session.overlayWindowIds, escStops: true, stopChord: fake.session.stopChord)
        fake.state.epoch += 1
        fake.service.noteSession(fake.session)
        fake.service.retireWakes(session: fake.session)
        try accessibilityCheck(fake.state.wakeRestores == 0 && fake.state.work.count == 1 && !fake.service.wakeCleanupComplete(),
                               "A replacement captures the old run's restoration work without running AX under its metadata hook")
        let retired = fake.state.work.removeFirst()
        retired()
        fake.state.holdWork = false
        fake.call("ui.tree", fake.treeArgs())
        _ = try fake.success()
        try accessibilityCheck(fake.state.wakeApplies == 2 && fake.state.wakeRestores == 1,
                               "A fresh run may own a new wake only after the old run's captured restoration completes")
        retired()
        try accessibilityCheck(fake.state.wakeRestores == 1,
                               "A delayed duplicate restoration token cannot undo a successor run's owned wake")
        fake.service.close()
        try accessibilityCheck(fake.state.wakeRestores == 2 && !fake.state.wakeRestoreInsideFence,
                               "Worker close restores the successor's independent wake exactly once")
    }

    try test {
        let fake = AccessibilityFixture()
        fake.state.wakeEnabled = true; fake.state.wakeVerified = true; fake.state.wakeRestoreSucceeds = false
        fake.call("ui.tree", fake.treeArgs())
        _ = try fake.success()
        fake.service.noteSession(nil); fake.service.retireWakes(session: nil)
        try accessibilityCheck(fake.state.wakeRestoreAttempts > 0 && fake.state.wakeRestores == 0 && !fake.service.wakeCleanupComplete(),
                               "An unconfirmed AX restoration keeps its owned retry state rather than silently dropping the side effect")
        fake.state.wakeRestoreSucceeds = true
        fake.service.close(); fake.service.close()
        try accessibilityCheck(fake.state.wakeRestoreAttempts > 1 && fake.state.wakeRestores == 1 && !fake.state.wakeRestoreInsideFence && fake.service.wakeCleanupComplete(),
                               "Close retries an unconfirmed restoration once it can succeed, without restoring a token twice")
        let original = AccessibilityFixture()
        original.state.wakeEnabled = true; original.state.wakeAlreadyEnabled = true
        original.call("ui.tree", original.treeArgs())
        _ = try original.success()
        original.service.noteSession(nil); original.service.retireWakes(session: nil); original.service.close()
        try accessibilityCheck(original.state.wakeApplies == 0 && original.state.wakeRestores == 0,
                               "An already-enabled native AX attribute is never adopted as the helper's side effect or cleared on shutdown")
    }

    try test {
        let hosted = AccessibilityHostedFixture()
        let fake = hosted.fake
        fake.call("ui.tree", ["pid": .integer(Int64(hosted.host.logical.process.pid)), "maxNodes": .integer(100), "maxDepth": .integer(8)])
        let tree = try fake.success()
        let nodes = tree["nodes"]?.arrayValue ?? []
        try accessibilityCheck(tree["truncated"] == .bool(true) && nodes.contains { $0["name"] == .string("Title") } &&
                               !nodes.contains { $0["name"] == .string("Synthetic app") },
                               "A logical-client tree returns only its proven physical host subtree and marks omitted client chrome truncated")
        try accessibilityCheck(fake.state.values[fake.state.password.element.identity] == nil &&
                               nodes.contains { $0["secure"] == .bool(true) && $0["value"] == .string("REDACTED") },
                               "Hosted tree traversal reads no secure values from the actual physical field")
    }
    try test {
        let hosted = AccessibilityHostedFixture()
        let fake = hosted.fake
        fake.call("ui.focused")
        let hit = try fake.success()
        guard let ref = hit["ref"]?.stringValue, let elementID = hit["elementId"]?.stringValue else {
            throw AccessibilityTestFailure(message: "Hosted focus omitted its native reference")
        }
        try accessibilityCheck(hit["owner"] == hosted.host.logical.identity.wire &&
                               hit["windowId"] == .string(hosted.host.surface.windowID) &&
                               fake.state.owner.process.pid == 202 && fake.state.foreground == 101,
                               "Focused wire ownership is the approved logical client while AX calls retain the distinct real host PID and CG window")
        hosted.host.time += 60_000_000
        fake.call("ui.resolve", ["ref": .string(ref)])
        let refreshed = try fake.success()
        try accessibilityCheck(refreshed["ref"] == .string(ref) && refreshed["elementId"] == .string(elementID),
                               "Re-proving an unchanged hosted mapping preserves the exact old ref and native identity without focus changes")
    }
    try test {
        let hosted = AccessibilityHostedFixture()
        let fake = hosted.fake
        fake.call("ui.focused")
        guard let ref = try fake.success()["ref"]?.stringValue else { throw AccessibilityTestFailure(message: "Missing hosted edit ref") }
        fake.call("ui.setValue", hosted.mutateArgs(ref))
        try accessibilityCheck(try fake.success()["took"] == .bool(true) && fake.state.writes.count == 1 &&
                               fake.state.writes[0].1 == fake.state.text.element.identity && fake.state.writes[0].2,
                               "A logical PID witness authorizes only the proven actual physical field, with the mutation inside the current fence")
        var wrong = hosted.mutateArgs(ref); wrong["pid"] = .integer(202)
        fake.call("ui.setValue", wrong)
        try accessibilityCheck(fake.failure() == "changed" && fake.state.writes.count == 1,
                               "The physical host PID is never accepted as an app approval substitute on the wire")
    }
    try test {
        let secure = AccessibilityHostedFixture()
        secure.fake.state.focused = secure.fake.state.password
        secure.fake.call("ui.focused")
        guard let secureRef = try secure.fake.success()["ref"]?.stringValue else { throw AccessibilityTestFailure(message: "Missing secure hosted ref") }
        secure.fake.call("ui.setValue", secure.mutateArgs(secureRef))
        try accessibilityCheck(secure.fake.failure() == "secure_field" && secure.fake.state.writes.isEmpty &&
                               secure.fake.state.values[secure.fake.state.password.element.identity] == nil,
                               "A hosted secure field refuses text before any physical write or value read")
        let developer = AccessibilityHostedFixture()
        let owner = accessibilityOwner("com.microsoft.VSCode")
        developer.host.logical = owner; developer.host.install(owner)
        developer.fake.state.ownerOverrides[101] = owner
        developer.fake.session = developer.host.session()
        developer.fake.service.noteSession(developer.fake.session)
        developer.fake.call("ui.focused")
        guard let developerRef = try developer.fake.success()["ref"]?.stringValue else { throw AccessibilityTestFailure(message: "Missing developer hosted ref") }
        developer.fake.call("ui.setValue", developer.mutateArgs(developerRef))
        try accessibilityCheck(developer.fake.failure() == "blocked" && developer.fake.state.writes.isEmpty,
                               "Logical developer click-only policy survives delegation through an eligible system host")
    }
    try test {
        let hosted = AccessibilityHostedFixture(surfaceIsPhysical: true)
        let fake = hosted.fake
        let other = accessibilityOwner("example.host.other", pid: 303)
        fake.session.approved.append(other.identity.wire)
        fake.call("ui.focused")
        let old = try fake.success()
        guard let oldRef = old["ref"]?.stringValue, let oldID = old["elementId"]?.stringValue else {
            throw AccessibilityTestFailure(message: "Missing initial hosted reference")
        }
        hosted.host.logical = other; hosted.host.install(other); hosted.host.responsible = 303
        hosted.host.elementPIDs[hosted.host.logicalWindow.identity] = 303
        hosted.host.links = [HostAXBridge(logicalPID: 303, logicalWindow: hosted.host.logicalWindow,
                                        linkedRoot: hosted.host.physicalRoot, physicalRoot: hosted.host.physicalRoot)]
        fake.state.ownerOverrides[303] = other; fake.state.foreground = 303
        let otherApp = AccessibilityElement()
        fake.state.applicationOverrides[303] = otherApp; fake.state.pidOverrides[otherApp.identity] = 303
        fake.call("ui.resolve", ["ref": .string(oldRef)])
        try accessibilityCheck(fake.failure() == "stale_ref", "A client remap invalidates old hosted refs despite unchanged physical PID, AX handle and CG geometry")
        fake.call("ui.focused")
        let current = try fake.success()
        try accessibilityCheck(current["owner"] == other.identity.wire && current["ref"]?.stringValue != oldRef &&
                               current["elementId"]?.stringValue != oldID,
                               "A fresh observation of the new approved client mints distinct native identity instead of resurrecting the old mapping")
    }
    try test {
        let hosted = AccessibilityHostedFixture()
        let fake = hosted.fake
        fake.call("ui.focused")
        guard let ref = try fake.success()["ref"]?.stringValue else { throw AccessibilityTestFailure(message: "Missing epoch-bound hosted ref") }
        let reads = fake.state.descriptions.values.reduce(0, +)
        fake.replaceRun()
        fake.call("ui.resolve", ["ref": .string(ref)])
        try accessibilityCheck(fake.failure() == "stale_ref" && fake.state.descriptions.values.reduce(0, +) == reads,
                               "A reused session/revision in a fresh run cannot re-resolve old host content or native handles")
    }
    try test {
        let hosted = AccessibilityHostedFixture()
        hosted.parents.links.removeValue(forKey: hosted.fake.state.text.element.identity)
        hosted.fake.call("ui.focused")
        try accessibilityCheck(hosted.fake.failure() == "stale_ref" && hosted.fake.state.descriptions.isEmpty &&
                               hosted.fake.state.values.isEmpty && hosted.fake.state.actions.isEmpty,
                               "The same physical host PID alone never permits reading a foreign handle outside the proven client subtree")
    }
    try test {
        let hosted = AccessibilityHostedFixture(surfaceIsPhysical: true, resolverEnabled: false)
        hosted.fake.call("ui.tree", ["windowId": .string(hosted.host.surface.windowID), "maxNodes": .integer(20), "maxDepth": .integer(4)])
        try accessibilityCheck(hosted.fake.failure() == "protected" && hosted.fake.state.descriptions.isEmpty && hosted.fake.state.values.isEmpty,
                               "Without native host proof, a protected physical host remains structural and its tree content is never requested")
        hosted.fake.call("ui.focused")
        try accessibilityCheck(hosted.fake.failure() == "stale_ref" && hosted.fake.state.descriptions.isEmpty,
                               "A foreign focused handle cannot be adopted without a resolver-backed mapping")
    }
    try test {
        let hosted = AccessibilityHostedFixture(surfaceIsPhysical: true)
        let path = "/System/Library/CoreServices/SecurityAgent.app/Contents/MacOS/SecurityAgent"
        let process = HelperProcessIdentity(pid: 202, parentPID: 1, startSeconds: 10, startMicroseconds: 20, executable: path)
        let security = NativeOwner(identity: MacAppIdentity(bundleId: "com.apple.SecurityAgent", apple: true, system: true,
            verified: true, name: "Synthetic security host", path: path, pid: 202), process: process, childShell: false)
        hosted.host.physical = security; hosted.host.install(security)
        hosted.fake.state.owner = security
        var window = hosted.host.surface; window.owner = security
        hosted.host.window = window; hosted.host.windows = [window]; hosted.fake.state.windows = [window]
        hosted.fake.call("ui.tree", ["windowId": .string(window.windowID), "maxNodes": .integer(20), "maxDepth": .integer(4)])
        try accessibilityCheck(hosted.fake.failure() == "protected" && hosted.fake.state.descriptions.isEmpty && hosted.fake.state.values.isEmpty,
                               "An actual security host is never remapped into ordinary approved-client AX content")
    }
    try test {
        let hosted = AccessibilityHostedFixture()
        let fake = hosted.fake
        fake.call("ui.focused")
        guard let ref = try fake.success()["ref"]?.stringValue else { throw AccessibilityTestFailure(message: "Missing reparent test ref") }
        fake.state.containingElementInsideFence = AccessibilityElement()
        for operation in ["ui.perform", "ui.setValue"] {
            var args = hosted.mutateArgs(ref)
            if operation == "ui.perform" { args.removeValue(forKey: "value"); args["action"] = .string("AXPress") }
            fake.call(operation, args)
            try accessibilityCheck(fake.failure() == "stale_ref" && fake.state.actions.isEmpty && fake.state.writes.isEmpty,
                                   "Same-PID reparenting at commit entry refuses both perform and setValue before any native action")
        }
    }
    try test {
        let hosted = AccessibilityHostedFixture(containingWindow: false)
        let fake = hosted.fake
        fake.state.window.role = "AXGroup"
        fake.call("ui.tree", ["pid": .integer(101), "maxNodes": .integer(20), "maxDepth": .integer(4)])
        let nodes = try fake.success()["nodes"]?.arrayValue ?? []
        guard let ref = nodes.first(where: { $0["name"] == .string("Title") })?["ref"]?.stringValue else {
            throw AccessibilityTestFailure(message: "A proven group subtree should remain observable")
        }
        fake.call("ui.setValue", hosted.mutateArgs(ref))
        try accessibilityCheck(fake.failure() == "stale_ref" && fake.state.writes.isEmpty,
                               "Group-only host proof without an actual current AXWindow remains readable but cannot authorize mutation")
    }
    try test {
        let menu = AccessibilityMenuFixture()
        let nodes = try menu.read()
        let root = nodes.first { $0["role"] == .string("AXMenuBar") }
        let item = nodes.first { $0["name"] == .string("Export") }
        try accessibilityCheck(root?["scope"] == .string("app-menu") && root?["menuPath"] == .array([]) &&
                               root?["pid"] == .integer(101) && root?["ref"]?.stringValue != nil && root?["elementId"]?.stringValue != nil &&
                               item?["scope"] == .string("app-menu") && item?["pid"] == .integer(101) &&
                               item?["menuPath"] == .array([.string("File"), .string("Export")]) &&
                               nodes.allSatisfy { $0["windowId"] == nil && $0["bounds"] == nil && $0["owner"] == nil },
                               "A windowless approved app exposes its actual independent menu root/path and omits unknown geometry")
        try accessibilityCheck(menu.fake.state.windows.isEmpty && menu.fake.state.menuRootReads > 0 &&
                               menu.fake.state.foreground == 707 && menu.fake.state.hitPoints.isEmpty,
                               "Windowless menu discovery never manufactures a CG window, takes focus or uses a coordinate hit")
    }

    try test {
        let menu = AccessibilityMenuFixture()
        guard let ref = try menu.read().first(where: { $0["role"] == .string("AXMenuBar") })?["ref"]?.stringValue else {
            throw AccessibilityTestFailure(message: "Missing readonly menu-root reference")
        }
        menu.fake.call("ui.resolve", ["ref": .string(ref)])
        let root = try menu.fake.success()
        try accessibilityCheck(root["ref"] == .string(ref) && root["scope"] == .string("app-menu") && root["menuPath"] == .array([]) &&
                               root["pid"] == .integer(101) && root["owner"]?["pid"] == .integer(101) &&
                               root["windowId"] == nil && root["bounds"] == nil,
                               "Resolving a menu root preserves the exact ref and actual app identity without inventing a containing window")
        for action in ["AXPress", "AXShowMenu", "AXRaise", "AXIncrement"] {
            menu.fake.call("ui.perform", menu.fake.performArgs(ref, action: action))
            try accessibilityCheck(menu.fake.failure() != nil && menu.fake.state.actions.isEmpty,
                                   "The empty menu path is an observation root and cannot authorize an element action")
        }
        menu.fake.call("ui.setValue", menu.fake.setArgs(ref))
        try accessibilityCheck(menu.fake.failure() != nil && menu.fake.state.writes.isEmpty,
                               "The empty menu path cannot authorize a value mutation")
    }

    try test {
        let menu = AccessibilityMenuFixture()
        menu.item.menuBounds = CGRect(x: 12, y: 24, width: 90, height: 18)
        let ref = try menu.ref(named: "Export")
        menu.fake.call("ui.resolve", ["ref": .string(ref)])
        let resolved = try menu.fake.success()
        try accessibilityCheck(resolved["ref"] == .string(ref) && resolved["scope"] == .string("app-menu") &&
                               resolved["menuPath"] == .array([.string("File"), .string("Export")]) &&
                               resolved["bounds"]?["x"]?.doubleValue == 12 && resolved["bounds"]?["y"]?.doubleValue == 24 &&
                               resolved["windowId"] == nil && resolved["elementId"]?.stringValue != nil,
                               "A menu observation may expose actual native bounds without treating them as a captured window")
        menu.fake.call("ui.perform", menu.fake.performArgs(ref))
        try accessibilityCheck(try menu.fake.success()["took"] == .bool(true) && menu.fake.state.actions.count == 1 &&
                               menu.fake.state.actions[0].0 == "AXPress" && menu.fake.state.actions[0].1 == menu.item.element.identity &&
                               menu.fake.state.actions[0].2 && menu.fake.state.foreground == 707 && menu.fake.state.hitPoints.isEmpty,
                               "A background menu press acts on the exact observed element without app activation or pointer posting")
    }

    try test {
        let menu = AccessibilityMenuFixture()
        let ref = try menu.ref(named: "Export")
        var wrongPID = menu.fake.performArgs(ref); wrongPID["pid"] = .integer(102)
        menu.fake.call("ui.perform", wrongPID)
        try accessibilityCheck(menu.fake.failure() != nil && menu.fake.state.actions.isEmpty,
                               "A supplied menu PID must match the ref's actual native owner")
        var wrongElement = menu.fake.performArgs(ref); wrongElement["elementId"] = .string("synthetic-forged-menu-item")
        menu.fake.call("ui.perform", wrongElement)
        try accessibilityCheck(menu.fake.failure() != nil && menu.fake.state.actions.isEmpty,
                               "A supplied menu element ID cannot replace the ref's actual native element")
        var privateOnly = menu.fake.performArgs(ref); privateOnly.removeValue(forKey: "pid"); privateOnly.removeValue(forKey: "elementId")
        menu.fake.call("ui.perform", privateOnly)
        try accessibilityCheck(try menu.fake.success()["took"] == .bool(true) && menu.fake.state.actions.count == 1 &&
                               menu.fake.state.actions[0].1 == menu.item.element.identity,
                               "An optional wire expectation never replaces the private process/root/element binding retained by an observed menu ref")
    }

    try test {
        let menu = AccessibilityMenuFixture()
        menu.fake.state.foreground = 101; menu.fake.state.focused = menu.item
        menu.fake.call("ui.focused")
        let focused = try menu.fake.success()
        try accessibilityCheck(focused["scope"] == .string("app-menu") && focused["pid"] == .integer(101) &&
                               focused["owner"]?["pid"] == .integer(101) && focused["ref"]?.stringValue != nil &&
                               focused["elementId"]?.stringValue != nil && focused["windowId"] == nil &&
                               focused["menuPath"] == .array([.string("File"), .string("Export")]) &&
                               menu.fake.state.focusedApplications == [menu.fake.state.app.element.identity],
                               "A focused windowless menu reports the real app-scoped AX element without requiring a physical window")
        let foreign = AccessibilityMenuFixture()
        foreign.fake.state.foreground = 101; foreign.fake.state.focused = foreign.item
        foreign.fake.state.pidOverrides[foreign.item.element.identity] = 202
        foreign.fake.call("ui.focused")
        try accessibilityCheck(foreign.fake.failure() == "stale_ref" && foreign.fake.state.menuDescriptions.isEmpty && foreign.fake.state.values.isEmpty,
                               "A foreign focused AX handle cannot borrow a logical app's menu approval without a hosted proof")
    }

    try test {
        let menu = AccessibilityMenuFixture()
        menu.fake.state.foreground = 101; menu.fake.state.hit = menu.item
        menu.root.menuBounds = CGRect(x: 0, y: 0, width: 300, height: 20)
        menu.item.menuBounds = CGRect(x: 10, y: 0, width: 100, height: 20)
        let session = menu.fake.session
        try menu.fake.captures.store(CaptureGeometry(captureID: "cap_synthetic_menu", displayID: "1",
            bounds: CGRect(x: 0, y: 0, width: 300, height: 200), nativePixelSize: CGSize(width: 300, height: 200),
            captureScale: 1, width: 300, height: 200, imageScale: 1, sessionID: session.id,
            observationEpoch: session.observationEpoch, phaseRevision: session.revision,
            configurationGeneration: menu.fake.captures.generation))
        menu.fake.call("ui.hittest", ["captureId": .string("cap_synthetic_menu"), "x": .integer(20), "y": .integer(10)])
        let hit = try menu.fake.success()
        try accessibilityCheck(hit["scope"] == .string("app-menu") && hit["pid"] == .integer(101) &&
                               hit["owner"]?["pid"] == .integer(101) && hit["ref"]?.stringValue != nil && hit["windowId"] == nil &&
                               hit["menuPath"] == .array([.string("File"), .string("Export")]) &&
                               menu.fake.state.windows.isEmpty && menu.fake.state.hitApplications == [menu.fake.state.app.element.identity] &&
                               menu.fake.state.hitPoints == [CGPoint(x: 20.5, y: 10.5)],
                               "A valid display pixel can hit the actual menu bar of a windowless app without inventing a CG window witness")
    }

    try test {
        for atFence in [false, true] {
            let menu = AccessibilityMenuFixture()
            let ref = try menu.ref(named: "Export")
            let replacement = AccessibilityTestNode("AXMenuBar", name: "", bounds: .zero)
            replacement.menuBounds = nil; replacement.children = [menu.file]
            menu.fake.state.nodes[replacement.element.identity] = replacement
            if atFence { menu.fake.state.menuRootInsideFence = replacement }
            else {
                menu.fake.state.menuRoot = replacement
                menu.fake.state.menuParents[menu.file.element.identity] = replacement.element
            }
            menu.fake.call("ui.perform", menu.fake.performArgs(ref))
            try accessibilityCheck(menu.fake.failure() == "stale_ref" && menu.fake.state.actions.isEmpty,
                                   "An identical-looking replacement native menu root cannot inherit an observed descendant's action authority")
        }
    }

    try test {
        for atFence in [false, true] {
            let menu = AccessibilityMenuFixture()
            let ref = try menu.ref(named: "Export")
            let services = AccessibilityTestNode("AXMenuBarItem", name: "Services", bounds: .zero)
            services.menuBounds = nil; services.children = [menu.container]
            menu.fake.state.nodes[services.element.identity] = services
            menu.fake.state.menuParents[services.element.identity] = menu.root.element
            if atFence { menu.fake.state.menuParentsInsideFence[menu.container.element.identity] = services.element }
            else {
                menu.root.children = [services]
                menu.fake.state.menuParents[menu.container.element.identity] = services.element
            }
            menu.fake.call("ui.perform", menu.fake.performArgs(ref))
            try accessibilityCheck(menu.fake.failure() != nil && menu.fake.state.actions.isEmpty && menu.fake.state.writes.isEmpty,
                                   "A retained same-PID item reparented under another observed menu cannot act through its previous path")
        }
    }

    try test {
        for transition in ["approval", "epoch", "process", "foreign-element"] {
            let menu = AccessibilityMenuFixture()
            let ref = try menu.ref(named: "Export")
            switch transition {
            case "approval": menu.fake.session.approved = []
            case "epoch": menu.fake.session.observationEpoch = UUID()
            case "process": menu.fake.state.owner = accessibilityOwner(start: 11)
            default: menu.fake.state.pidOverrides[menu.item.element.identity] = 102
            }
            menu.fake.call("ui.perform", menu.fake.performArgs(ref))
            try accessibilityCheck(menu.fake.failure() != nil && menu.fake.state.actions.isEmpty,
                                   "Menu refs retain current exact approval, observation epoch, private process and native-element PID requirements")
        }
    }

    try test {
        let menu = AccessibilityMenuFixture()
        menu.item.subrole = "AXSecureTextField"
        menu.item.editable = true
        menu.item.value = "NEVER_READ_THIS_MENU_SECRET"
        let nodes = try menu.read()
        guard let node = nodes.first(where: { $0["name"] == .string("Export") }), let ref = node["ref"]?.stringValue else {
            throw AccessibilityTestFailure(message: "Missing secure menu observation")
        }
        try accessibilityCheck(node["secure"] == .bool(true) && node["value"] == .string("REDACTED") &&
                               menu.fake.state.values[menu.item.element.identity] == nil,
                               "A secure native menu descendant is disclosed without reading its AXValue")
        menu.fake.call("ui.setValue", menu.fake.setArgs(ref))
        try accessibilityCheck(menu.fake.failure() == "secure_field" && menu.fake.state.writes.isEmpty &&
                               menu.fake.state.values[menu.item.element.identity] == nil,
                               "Secure-field refusal remains below menu routing and precedes every value mutation/readback")
    }

    try test {
        for ancestor in ["Services", "Scripts", "Macros", "αScripts", "Scriptsα"] {
            let menu = AccessibilityMenuFixture()
            menu.file.name = ancestor
            let ref = try menu.ref(named: "Export")
            menu.fake.call("ui.perform", menu.fake.performArgs(ref))
            try accessibilityCheck(menu.fake.failure() != nil && menu.fake.state.actions.isEmpty && menu.fake.state.writes.isEmpty,
                                   "An observed Services/script/macro ancestor cannot be bypassed by a harmless-looking descendant label")
        }
    }

    try test {
        let unapproved = AccessibilityMenuFixture(approved: false)
        unapproved.fake.call("ui.tree", unapproved.fake.treeArgs())
        try accessibilityCheck(unapproved.fake.failure() == "not_granted" && unapproved.fake.state.menuDescriptions.isEmpty &&
                               unapproved.fake.state.values.isEmpty && unapproved.fake.state.actions.isEmpty,
                               "Windowless app-menu content requires exact app approval before any menu attributes or values are fetched")
        let protected = AccessibilityMenuFixture()
        protected.fake.state.owner = accessibilityOwner("com.apple.Terminal")
        protected.fake.session.approved = [protected.fake.state.owner.identity.wire]
        protected.fake.call("ui.tree", protected.fake.treeArgs())
        try accessibilityCheck(protected.fake.failure() == "protected" && protected.fake.state.menuDescriptions.isEmpty &&
                               protected.fake.state.values.isEmpty,
                               "A protected app cannot gain menu content or actions through a windowless scope")
    }

    try test {
        for changedLabel in ["Cafe\u{301}", "Ca\u{202e}fé", String(repeating: "x", count: 257)] {
            let menu = AccessibilityMenuFixture()
            menu.item.name = "Café"
            let ref = try menu.ref(named: "Café")
            menu.item.name = changedLabel
            menu.fake.call("ui.perform", menu.fake.performArgs(ref))
            try accessibilityCheck(menu.fake.failure() == "stale_ref" && menu.fake.state.actions.isEmpty,
                                   "Changed, control-stripped or truncated native labels cannot alias an observed exact menu path")
        }
        let canceled = AccessibilityMenuFixture()
        canceled.fake.state.onMenuDescribe = { element in
            if element.identity == canceled.item.element.identity { canceled.fake.state.epoch += 1 }
        }
        canceled.fake.call("ui.tree", canceled.fake.treeArgs())
        try accessibilityCheck(canceled.fake.failure() == "changed" && canceled.fake.state.actions.isEmpty,
                               "A late app-menu traversal cannot publish references after its authority is canceled")
    }

    try test {
        let menu = AccessibilityMenuFixture(windowless: false)
        menu.fake.call("ui.tree", menu.fake.treeArgs(maxNodes: 2))
        let bounded = try menu.fake.success()
        try accessibilityCheck((bounded["nodes"]?.arrayValue?.count ?? 0) <= 2 && bounded["truncated"] == .bool(true),
                               "Window and independent menu roots share the requested node budget rather than each consuming a fresh allowance")
        for selector in [menu.fake.treeArgs(), ["windowId": .string("1010"), "maxNodes": .integer(100), "maxDepth": .integer(8)]] {
            menu.fake.call("ui.tree", selector)
            let all = try menu.fake.success()["nodes"]?.arrayValue ?? []
            try accessibilityCheck(all.contains { $0["role"] == .string("AXWindow") && $0["scope"] != .string("app-menu") } &&
                                   all.contains { $0["role"] == .string("AXMenuBar") && $0["scope"] == .string("app-menu") && $0["menuPath"] == .array([]) },
                                   "A PID/window tree keeps actual windows and its app-level menu as independently scoped roots")
        }
    }

    try test {
        let menu = AccessibilityMenuFixture()
        menu.fake.session.paused = true
        let ref = try menu.ref(named: "Export")
        menu.fake.call("ui.resolve", ["ref": .string(ref)])
        let inspected = try menu.fake.success()
        menu.fake.advancePhase(paused: false)
        menu.fake.call("ui.perform", menu.fake.performArgs(ref))
        try accessibilityCheck(menu.fake.failure() == "stale_ref" && menu.fake.state.actions.isEmpty,
                               "A working phase cannot use an inactive asking-phase menu ref as raw mutation authority")
        menu.fake.call("ui.resolve", ["ref": .string(ref)])
        let refreshed = try menu.fake.success()
        try accessibilityCheck(refreshed["ref"] == inspected["ref"] && refreshed["elementId"] == inspected["elementId"] &&
                               refreshed["menuPath"] == inspected["menuPath"],
                               "An explicit current native resolve preserves the exact once-consent menu ref and element lineage")
        menu.fake.call("ui.perform", menu.fake.performArgs(ref))
        try accessibilityCheck(try menu.fake.success()["took"] == .bool(true) && menu.fake.state.actions.count == 1,
                               "The same consent-bound menu ref can act only after complete current revalidation")
    }
    try test {
        for changed in ["name", "secure", "root", "approval", "new-run"] {
            let menu = AccessibilityMenuFixture()
            let ref = try menu.ref(named: "Export")
            menu.fake.call("ui.resolve", ["ref": .string(ref)]); _ = try menu.fake.success()
            menu.fake.advancePhase(paused: false)
            switch changed {
            case "name": menu.item.name = "Different command"
            case "secure": menu.item.subrole = "AXSecureTextField"
            case "root":
                let replacement = AccessibilityTestNode("AXMenuBar", name: "", bounds: .zero)
                replacement.menuBounds = nil; replacement.children = [menu.file]
                menu.fake.state.nodes[replacement.element.identity] = replacement
                menu.fake.state.menuRoot = replacement; menu.fake.state.menuParents[menu.file.element.identity] = replacement.element
            case "approval": menu.fake.session.approved = []
            default: menu.fake.replaceRun()
            }
            menu.fake.call("ui.resolve", ["ref": .string(ref)])
            try accessibilityCheck(menu.fake.failure() != nil && menu.fake.state.actions.isEmpty && menu.fake.state.writes.isEmpty,
                                   "Explicit receipt refresh cannot survive changed menu facts, root, approval or a same-wire fresh run")
            menu.fake.call("ui.perform", menu.fake.performArgs(ref))
            try accessibilityCheck(menu.fake.failure() == "stale_ref" && menu.fake.state.actions.isEmpty,
                                   "A failed refresh leaves the old menu evidence inactive rather than partially promoting it")
        }
    }
    try test {
        let fake = AccessibilityFixture(paused: true, mode: "background", textBackend: true)
        let ref = try fake.ref(named: "Title")
        fake.call("ui.resolve", ["ref": .string(ref)]); let before = try fake.success()
        fake.advancePhase(paused: false)
        fake.call("input.type", fake.insertArgs(ref))
        try accessibilityCheck(fake.failure() == "stale_ref" && fake.state.writes.isEmpty,
                               "Background insertion cannot promote an inactive asking-phase native ref")
        fake.call("ui.resolve", ["ref": .string(ref)]); let after = try fake.success()
        try accessibilityCheck(after["ref"] == before["ref"] && after["elementId"] == before["elementId"],
                               "Current window facts may explicitly refresh the exact previously inspected text ref")
        fake.call("input.type", fake.insertArgs(ref))
        try accessibilityCheck(try fake.success().isEmpty && fake.state.text.value == "Before!" && fake.state.writes.count == 1,
                               "Revalidated background insertion appends at the observed caret instead of replacing existing content")
    }
    try test {
        for changed in ["document", "name", "secure", "incomplete"] {
            let fake = AccessibilityFixture(mode: "background", textBackend: true)
            fake.state.document = "/virtual/original.txt"
            let ref = try fake.ref(named: "Title")
            fake.call("ui.resolve", ["ref": .string(ref)]); _ = try fake.success()
            fake.advancePhase(paused: false)
            switch changed {
            case "document": fake.state.document = "/virtual/replacement.txt"
            case "name": fake.state.text.name = "Different field"
            case "secure": fake.state.text.subrole = "AXSecureTextField"
            default: fake.state.text.nameComplete = false
            }
            fake.call("ui.resolve", ["ref": .string(ref)])
            try accessibilityCheck(fake.failure() == "stale_ref" && fake.state.writes.isEmpty,
                                   "A window receipt cannot refresh changed or incomplete native document/name/security facts")
        }
    }
    try test {
        let cases: [(String, Int, Int, String, String, Int)] = [
            ("Before", 6, 0, "!", "Before!", 7), ("alpha beta", 6, 4, "🌍", "alpha 🌍", 8),
            ("A😀B", 1, 2, "X", "AXB", 2),
        ]
        for item in cases {
            let fake = AccessibilityFixture(mode: "background", textBackend: true)
            fake.state.foreground = 707; fake.state.text.value = item.0
            fake.state.textSelection = AccessibilitySelection(location: item.1, length: item.2)
            let ref = try fake.ref(named: "Title")
            fake.call("input.type", fake.insertArgs(ref, text: item.3))
            try accessibilityCheck(try fake.success().isEmpty && fake.state.text.value?.utf8.elementsEqual(item.4.utf8) == true &&
                                   fake.state.textSelection == AccessibilitySelection(location: item.5, length: 0) &&
                                   fake.state.writes.count == 1 && fake.state.writes[0].0.utf8.elementsEqual(item.4.utf8) &&
                                   fake.state.writes[0].2 && fake.state.textSelectionWrites.count == 1 && fake.state.textSelectionWrites[0].2 &&
                                   fake.state.foreground == 707 && fake.state.actions.isEmpty && fake.state.hitPoints.isEmpty,
                                   "Background AX insertion writes one complete selected-range result and verifies its UTF-16 caret without taking foreground")
        }
    }
    try test {
        for unsupported in ["backend", "state", "value", "selection", "split-surrogate"] {
            let fake = AccessibilityFixture(mode: "background", textBackend: unsupported != "backend")
            switch unsupported {
            case "state": fake.state.textStateAvailable = false
            case "value": fake.state.textValueSettable = false
            case "selection": fake.state.textSelectionSettable = false
            case "split-surrogate": fake.state.text.value = "A😀B"; fake.state.textSelection = AccessibilitySelection(location: 2, length: 0)
            default: break
            }
            let ref = try fake.ref(named: "Title")
            fake.call("input.type", fake.insertArgs(ref))
            try accessibilityCheck(fake.failure() == "needs_foreground" && fake.state.writes.isEmpty && fake.state.textSelectionWrites.isEmpty,
                                   "Unsupported or incomplete native selected-text insertion asks for foreground before changing a field")
        }
        let unchanged = AccessibilityFixture(mode: "background", textBackend: true)
        let ref = try unchanged.ref(named: "Title")
        unchanged.state.writeTakes = false; unchanged.state.writeReturns = false
        unchanged.call("input.type", unchanged.insertArgs(ref))
        try accessibilityCheck(unchanged.failure() == "needs_foreground" && unchanged.state.text.value == "Before" &&
                               unchanged.state.textSelection == AccessibilitySelection(location: 6, length: 0) && unchanged.state.writes.count == 1 &&
                               unchanged.state.textSelectionWrites.isEmpty,
                               "Only a verified unchanged value and selection permit a foreground retry after an untaken AX edit")
    }
    try test {
        let fake = AccessibilityFixture(mode: "background", textBackend: true)
        let ref = try fake.ref(named: "Title")
        var wrongWindow = fake.insertArgs(ref); wrongWindow["windowId"] = .string("synthetic-other-window")
        fake.call("input.type", wrongWindow)
        try accessibilityCheck(fake.failure() != nil && fake.state.writes.isEmpty && fake.state.textSelectionWrites.isEmpty,
                               "A supplied window expectation must match the actual retained native text surface")
        var actualWindow = fake.insertArgs(ref); actualWindow["windowId"] = .string("1010")
        fake.call("input.type", actualWindow)
        try accessibilityCheck(try fake.success().isEmpty && fake.state.text.value == "Before!" && fake.state.writes.count == 1,
                               "The true native window expectation permits the same current selected-text insertion")
        let menu = AccessibilityMenuFixture()
        let menuRef = try menu.ref(named: "Export")
        menu.fake.call("input.type", menu.fake.insertArgs(menuRef))
        try accessibilityCheck(menu.fake.failure() == "blocked" && menu.fake.state.writes.isEmpty && menu.fake.state.textStates == 0,
                               "An app-menu observation cannot be reused as a window text-insertion capability")
    }
    try test {
        for partial in ["value-only", "selection-failed", "value-uncertain", "unchanged-uncertain", "selection-uncertain"] {
            let fake = AccessibilityFixture(mode: "background", textBackend: true)
            let ref = try fake.ref(named: "Title")
            switch partial {
            case "value-only": fake.state.writeReturns = false
            case "selection-failed": fake.state.textSelectionTakes = false; fake.state.textSelectionReturns = false
            case "value-uncertain": fake.state.textValueThrows = true
            case "unchanged-uncertain": fake.state.writeTakes = false; fake.state.writeReturns = false; fake.state.textValueThrows = true
            default: fake.state.textSelectionThrows = true
            }
            fake.call("input.type", fake.insertArgs(ref))
            try accessibilityCheck(fake.failure() == "changed" && fake.state.writes.count == 1 && fake.state.textSelectionWrites.count <= 1 &&
                                   fake.state.actions.isEmpty,
                                   "Partial or uncertain AX edits refuse as changed and never retry the inserted text as a duplicate fallback")
        }
    }
    try test {
        let secure = AccessibilityFixture(mode: "background", textBackend: true)
        let secureRef = try secure.ref(named: "Password")
        secure.call("input.type", secure.insertArgs(secureRef))
        try accessibilityCheck(secure.failure() == "secure_field" && secure.state.textStates == 0 && secure.state.writes.isEmpty,
                               "Secure-field policy precedes any selected text/value read for background insertion")
        let developer = AccessibilityFixture(mode: "background", textBackend: true)
        developer.state.replaceOwner(accessibilityOwner("com.microsoft.VSCode")); developer.session.approved = [developer.state.owner.identity.wire]
        let developerRef = try developer.ref(named: "Title")
        developer.call("input.type", developer.insertArgs(developerRef))
        try accessibilityCheck(developer.failure() == "blocked" && developer.state.textStates == 0 && developer.state.writes.isEmpty,
                               "A developer app's click-only floor cannot be bypassed through selected-text accessibility insertion")
    }
    try test {
        for changed in ["focus", "selection", "document", "permission", "owner"] {
            let fake = AccessibilityFixture(mode: "background", textBackend: true)
            fake.state.document = "/virtual/original.txt"
            let ref = try fake.ref(named: "Title")
            fake.call("ui.resolve", ["ref": .string(ref)]); _ = try fake.success()
            switch changed {
            case "focus": fake.state.textFocusedInsideFence = fake.state.button
            case "selection": fake.state.onTextState = { _ in if fake.state.insideFence { fake.state.textSelection = AccessibilitySelection(location: 0, length: 0) } }
            case "document": fake.state.onTextDocument = { _ in if fake.state.insideFence { fake.state.document = "/virtual/replacement.txt" } }
            case "permission": fake.state.denyAtMutation = true
            default: fake.state.onTextState = { _ in if fake.state.insideFence { fake.state.owner = accessibilityOwner(start: 11) } }
            }
            fake.call("input.type", fake.insertArgs(ref))
            try accessibilityCheck(fake.failure() != nil && fake.state.writes.isEmpty && fake.state.textSelectionWrites.isEmpty,
                                   "Fresh app focus, selection, document, grant and owner facts must still match at the final insertion fence")
        }
        let changed = AccessibilityFixture(mode: "background", textBackend: true)
        let ref = try changed.ref(named: "Title")
        var readsBeforeSecure = 0
        changed.state.onWrite = { _ in readsBeforeSecure = changed.state.textStates; changed.state.text.subrole = "AXSecureTextField" }
        changed.call("input.type", changed.insertArgs(ref))
        try accessibilityCheck(changed.failure() == "changed" && changed.state.writes.count == 1 && readsBeforeSecure > 0 && changed.state.textStates == readsBeforeSecure,
                               "A field that becomes secure after writing prevents readback and never authorizes a second typing attempt")
    }
    try test {
        let menu = AccessibilityMenuFixture()
        menu.item.name = "Ouvrir les outils"; menu.item.menuShortcut = ["Command", "Option", "I"]
        let ref = try menu.ref(named: menu.item.name)
        menu.fake.call("ui.perform", menu.fake.performArgs(ref))
        try accessibilityCheck(menu.fake.failure() == "blocked" && menu.fake.state.actions.isEmpty,
                               "A localized harmless-looking menu label cannot waive the actual forbidden developer-tools shortcut")
        let unknown = AccessibilityMenuFixture()
        unknown.item.shortcutComplete = false
        let unknownRef = try unknown.ref(named: "Export")
        unknown.fake.call("ui.perform", unknown.fake.performArgs(unknownRef))
        try accessibilityCheck(unknown.fake.failure() == "needs_foreground" && unknown.fake.state.actions.isEmpty,
                               "Unknown shortcut observations cannot authorize a background menu press")
    }
    try test {
        for mode in ["background", "foreground"] {
            let menu = AccessibilityMenuFixture(mode: mode, windowless: false, textBackend: true)
            menu.item.name = "Coller"; menu.item.menuShortcut = ["Command", "V"]
            let ref = try menu.ref(named: menu.item.name)
            menu.fake.call("ui.perform", menu.fake.performArgs(ref))
            try accessibilityCheck(menu.fake.failure() == (mode == "background" ? "needs_foreground" : "unsupported_action") &&
                                   menu.fake.state.actions.isEmpty && menu.fake.state.writes.isEmpty && menu.fake.state.textStates == 0,
                                   "A localized paste menu checks actual app-focused policy and routes explicitly without pretending menu activation proves insertion")
        }
        for target in ["secure", "developer"] {
            let menu = AccessibilityMenuFixture(windowless: false, textBackend: true)
            menu.item.name = "Coller"; menu.item.menuShortcut = ["Command", "V"]
            if target == "secure" { menu.fake.state.focused = menu.fake.state.password }
            else {
                menu.fake.state.replaceOwner(accessibilityOwner("com.microsoft.VSCode"))
                menu.fake.session.approved = [menu.fake.state.owner.identity.wire]
            }
            let ref = try menu.ref(named: menu.item.name)
            menu.fake.call("ui.perform", menu.fake.performArgs(ref))
            try accessibilityCheck(menu.fake.failure() == (target == "secure" ? "secure_field" : "blocked") &&
                                   menu.fake.state.actions.isEmpty && menu.fake.state.writes.isEmpty && menu.fake.state.textStates == 0,
                                   "Localized paste menus cannot bypass the real focused field's secure or developer text floor")
        }
    }
    try test {
        let menu = AccessibilityMenuFixture()
        menu.item.menuShortcut = ["Command", "S"]
        let ref = try menu.ref(named: "Export")
        menu.fake.call("ui.resolve", ["ref": .string(ref)]); _ = try menu.fake.success()
        menu.fake.advancePhase(paused: false)
        menu.item.menuShortcut = ["Command", "V"]
        menu.fake.call("ui.resolve", ["ref": .string(ref)])
        try accessibilityCheck(menu.fake.failure() == "stale_ref" && menu.fake.state.actions.isEmpty,
                               "An observed shortcut change invalidates a phase receipt even when the complete menu path and native handle are unchanged")
    }
    return count
}
