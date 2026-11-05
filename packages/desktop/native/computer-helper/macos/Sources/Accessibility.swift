import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Dispatch
import Foundation

/// Opaque native handles also permit fully injected tests without constructing an AX object.
final class AccessibilityElement {
    let identity = UUID()
    let native: AXUIElement?
    init(native: AXUIElement? = nil) { self.native = native }

    static func equivalent(_ first: AccessibilityElement, _ second: AccessibilityElement) -> Bool {
        if let a = first.native, let b = second.native { return CFEqual(a, b) }
        return first.identity == second.identity
    }
    static func hash(_ element: AccessibilityElement) -> UInt {
        if let native = element.native { return CFHash(native) }
        return UInt(bitPattern: element.identity.hashValue)
    }
}

struct AccessibilityAttributes {
    let role: String
    var subrole: String? = nil
    var name: String = ""
    let bounds: CGRect
    var enabled = true
    var focused = false
    var editable = false
    var secure: Bool { NativeIdentityReader.isSecure(role: role, subrole: subrole) }
}

struct AccessibilityChildren {
    let elements: [AccessibilityElement]
    var truncated = false
}

struct AccessibilityWake {
    let apply: () -> Bool
    let restore: () -> Void
}

struct AccessibilityBackend {
    let preflight: () -> Bool
    let windows: () throws -> [CaptureWindowInfo]
    let owner: (pid_t) throws -> NativeOwner
    let application: (pid_t) throws -> AccessibilityElement
    let pid: (AccessibilityElement) throws -> pid_t
    /// Descriptions never contain AXValue. Only an authorized caller may ask for this content.
    let describe: (AccessibilityElement) throws -> AccessibilityAttributes
    let value: (AccessibilityElement) throws -> String?
    let children: (AccessibilityElement, Int) throws -> AccessibilityChildren
    let hitTest: (AccessibilityElement, CGPoint) throws -> AccessibilityElement
    let focused: (AccessibilityElement) throws -> AccessibilityElement
    let frontmostPID: () -> pid_t?
    let perform: (AccessibilityElement, String) throws -> Bool
    let setValue: (AccessibilityElement, String) throws -> Bool
    /// A missing path is unknown, not positive evidence of a non-file surface.
    let document: (AccessibilityElement) throws -> String?
    var equal: (AccessibilityElement, AccessibilityElement) -> Bool = AccessibilityElement.equivalent
    var hash: (AccessibilityElement) -> UInt = AccessibilityElement.hash
    var prepareWake: ((AccessibilityElement, NativeOwner) throws -> AccessibilityWake?)? = nil
    var containingWindow: ((AccessibilityElement) throws -> AccessibilityElement?)? = nil
    var keyboardLayout: (() -> [String: JSONValue]?)? = nil
    var menuShortcuts: ((InputObservation, ServerSession) throws -> [InputMenuShortcut]?)? = nil
    var hostResolver: HostOwnershipResolver? = nil

    static var system: AccessibilityBackend {
        var backend = AccessibilityBackend(preflight: { AXIsProcessTrusted() }, windows: AccessibilityNative.windows,
            owner: { pid in
                if let owner = try? NativeIdentityReader.observe(pid: pid) { return owner }
                return try NativeIdentityReader.observeHost(pid: pid)
            }, application: AccessibilityNative.application, pid: AccessibilityNative.pid,
            describe: AccessibilityNative.describe, value: AccessibilityNative.value, children: AccessibilityNative.children,
            hitTest: AccessibilityNative.hitTest, focused: AccessibilityNative.focused,
            frontmostPID: { NSWorkspace.shared.frontmostApplication?.processIdentifier },
            perform: AccessibilityNative.perform, setValue: AccessibilityNative.setValue, document: AccessibilityNative.document)
        backend.prepareWake = AccessibilityNative.prepareWake
        backend.containingWindow = AccessibilityNative.containingWindow
        backend.keyboardLayout = InputNative.layoutWire
        backend.menuShortcuts = InputNative.menusWire
        backend.hostResolver = HostOwnershipResolver()
        return backend
    }
}

/// One bounded AX worker; the AppKit run loop and immediate protocol controls remain independent.
final class AccessibilityService {
    private let captures: CaptureRegistry
    private let backend: AccessibilityBackend
    private let registry: AccessibilityRegistry<AccessibilityElement>
    private let execute: (@escaping () -> Void) -> Void
    private let now: () -> UInt64
    private let lock = NSLock()
    private var closed = false
    private var restoration: (() -> Void)?
    private static let actions: Set<String> = ["AXPress", "AXIncrement", "AXDecrement", "AXScrollToVisible", "AXShowMenu", "AXRaise", "AXConfirm", "AXCancel"]

    init(captures: CaptureRegistry = CaptureRegistry(), backend: AccessibilityBackend = .system,
         execute: ((@escaping () -> Void) -> Void)? = nil, now: (() -> UInt64)? = nil) {
        self.captures = captures; self.backend = backend
        registry = AccessibilityRegistry(hash: backend.hash, equal: backend.equal)
        let queue = DispatchQueue(label: "ai.vector.computer.accessibility")
        self.execute = execute ?? { queue.async(execute: DispatchWorkItem(block: $0)) }
        self.now = now ?? { DispatchTime.now().uptimeNanoseconds }
    }

    func features() -> [String: Bool] { ["ui.tree": true, "ui.actions": true, "ui.secureFieldDetect": true] }

    /// M5 compares the actual scoped AX object with an existing M4 observation; input never mints a new ref.
    func verifyInputTarget(element: AccessibilityElement?, target: NativeTarget, window: CaptureWindowInfo,
                           expected: NativeExpectedTarget, session: ServerSession) throws -> NativeTarget {
        try requireOpen()
        let policy = try SessionPolicy(session: session)
        try policy.requireTarget(target, operation: .observe)
        var actual = target
        if expected.ref != nil || expected.elementID != nil {
            guard let element else { throw Self.stale }
            try requirePID(element, target.owner.process.pid)
            if let hosted = target.hosted {
                guard let resolver = backend.hostResolver,
                      resolver.contains(element: element, proof: hosted) else { throw Self.stale }
            }
            let witness = self.witness(window, target.owner, hosted: target.hosted)
            let record: AccessibilityReference<AccessibilityElement>
            if let ref = expected.ref { record = try registry.resolve(ref, session: session, witness: witness) }
            else if let id = expected.elementID { record = try registry.resolveElement(id, session: session, witness: witness) }
            else { throw Self.stale }
            guard backend.equal(element, record.element) else { throw Self.stale }
            actual.ref = record.ref; actual.elementID = record.elementID
        }
        try policy.requireTarget(actual, operation: .observe, expected: expected)
        return actual
    }

    /// Called under the dispatcher's authority lock: no AX call, process lookup or restoration runs here.
    func invalidateObservations() { registry.clear() }

    func close() {
        lock.lock(); closed = true; let restore = restoration; restoration = nil; lock.unlock()
        registry.close()
        restore?()
    }

    func tree(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        run(context, completion) { session, policy in
            let allowed: Set<String> = ["pid", "windowId", "maxNodes", "maxDepth"]
            guard Set(args.keys).isSubset(of: allowed), (args["pid"] != nil) != (args["windowId"] != nil),
                  let nodes = args["maxNodes"]?.intValue, nodes > 0,
                  let depth = args["maxDepth"]?.intValue, depth > 0,
                  args["pid"] == nil || Self.pidArgument(args["pid"]) != nil,
                  args["windowId"] == nil || Self.id(args["windowId"]) != nil else { throw Self.invalid }
            let limit = min(nodes, 400), maxDepth = min(depth, 30)
            let deadline = self.now() &+ 13_000_000_000
            let windows = try self.catalog()
            let requestedPID = Self.pidArgument(args["pid"])
            var selected: [(CaptureWindowInfo, NativeTarget)] = []
            var selectionTruncated = false
            for window in windows {
                if self.now() >= deadline { selectionTruncated = true; break }
                try self.requireCurrent(context)
                if let id = args["windowId"]?.stringValue, window.windowID != id { continue }
                if let pid = requestedPID, window.pid != pid {
                    guard let resolver = self.backend.hostResolver,
                          let hosted = try resolver.resolve(window: window, session: session, logicalPID: pid, isCurrent: context.isCurrent) else { continue }
                    selected.append((window, NativeTarget(owner: hosted.physicalOwner, windowID: window.windowID, hosted: hosted)))
                } else {
                    selected.append((window, try self.target(window, session: session, context: context, logicalPID: requestedPID)))
                }
                if selected.count > 128 { throw Self.unavailable }
            }
            guard !selected.isEmpty, selected.count <= 128 else { throw Self.failure("app_not_found", "The native app window is unavailable.") }
            let snapshot = try self.publish(context) { try self.registry.beginSnapshot(session: session) }
            var result: [JSONValue] = []
            var truncated = nodes > 400 || depth > 30 || selectionTruncated
            var visited: [AccessibilityElement] = []
            for (window, observed) in selected {
                if result.count >= limit || self.now() >= deadline { truncated = true; break }
                try self.requireCurrent(context)
                var current = observed
                try policy.requireTarget(current, operation: .observe)
                let root: AccessibilityElement
                defer { self.restoreWake() }
                if let hosted = current.hosted {
                    root = hosted.physicalRoot
                    // The retained remote subtree is complete evidence; client-side chrome outside it is omitted.
                    truncated = true
                } else {
                    let app = try self.backend.application(current.owner.process.pid)
                    try self.requirePID(app, current.owner.process.pid)
                    try self.wake(app, current.owner, context: context)
                    do { root = try self.windowElement(app, window, context: context, deadline: deadline) }
                    catch let failure as ServerFailure where failure.code == "timeout" { truncated = true; break }
                }
                var queue: [(AccessibilityElement, Int)] = [(root, 1)]
                var index = 0
                while index < queue.count {
                    if result.count >= limit || self.now() >= deadline { truncated = true; break }
                    try self.requireCurrent(context)
                    let (element, level) = queue[index]; index += 1
                    if visited.contains(where: { self.backend.equal($0, element) }) { truncated = true; continue }
                    visited.append(element)
                    current = try self.refreshed(current, window: window, session: session, context: context)
                    try self.requirePID(element, current.owner.process.pid)
                    do {
                        if current.hosted != nil { try self.requireWindow(element, window, context: context, hosted: current.hosted) }
                        try policy.requireTarget(current, operation: .observe)
                        let attributes = try self.attributes(element)
                        let witness = self.witness(window, current.owner, hosted: current.hosted)
                        let reference = try self.publish(context) { try self.registry.register(element: element, witness: witness, snapshot: snapshot) }
                        var fields: [String: JSONValue] = ["ref": .string(reference.ref), "role": .string(AccessibilityContent.sanitize(attributes.role, limit: 64)),
                            "name": .string(AccessibilityContent.sanitize(attributes.name)), "bounds": Self.rect(attributes.bounds),
                            "enabled": .bool(attributes.enabled), "focused": .bool(attributes.focused), "secure": .bool(attributes.secure)]
                        if let subrole = attributes.subrole { fields["subrole"] = .string(AccessibilityContent.sanitize(subrole, limit: 64)) }
                        if attributes.secure { fields["value"] = .string("REDACTED") }
                        else if let raw = try self.backend.value(element) { fields["value"] = .string(AccessibilityContent.sanitize(raw)) }
                        try self.requirePID(element, current.owner.process.pid)
                        if current.hosted != nil { try self.requireWindow(element, window, context: context, hosted: current.hosted) }
                        try self.requireCurrent(context)
                        result.append(.object(fields))
                        let remaining = max(0, limit - result.count - (queue.count - index))
                        let children = try self.backend.children(element, level < maxDepth ? remaining : 0)
                        guard children.elements.count <= remaining || level >= maxDepth else { throw Self.unavailable }
                        if children.truncated || (level >= maxDepth && !children.elements.isEmpty) { truncated = true }
                        if level < maxDepth { queue.append(contentsOf: children.elements.map { ($0, level + 1) }) }
                    } catch let failure as ServerFailure {
                        if failure.code == "changed" || failure.code == "stale_ref" { throw failure }
                        truncated = true
                    }
                }
                try self.recheck(window, owner: current.owner, context: context, hosted: current.hosted)
            }
            try self.requireCurrent(context)
            return ServerReply(fields: ["generation": .integer(Int64(snapshot.generation)), "truncated": .bool(truncated), "nodes": .array(result)])
        }
    }

    func hitTest(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        run(context, completion) { session, policy in
            guard Set(args.keys) == ["captureId", "x", "y"], let id = Self.id(args["captureId"]),
                  let x = args["x"]?.intValue, let y = args["y"]?.intValue else { throw Self.invalid }
            let frame = try self.captures.get(id, sessionID: session.id, observationEpoch: session.observationEpoch, phaseRevision: session.revision)
            let point = try frame.point(x: x, y: y)
            let windows = try self.catalog()
            let window: CaptureWindowInfo
            if let id = frame.windowID {
                guard let current = windows.first(where: { $0.windowID == id }), current.bounds == frame.windowFrame,
                      current.pid == frame.ownerProcess?.pid, try self.backend.owner(current.pid).process == frame.ownerProcess else {
                    throw Self.failure("stale_frame", "The captured native window changed.")
                }
                // A desktop-independent window image keeps its own target even while occluded or offscreen.
                window = current
            } else {
                guard let old = frame.windows.first(where: { $0.onScreen && $0.bounds.contains(point) }),
                      let current = windows.first(where: { $0.windowID == old.windowID }), current.bounds == old.bounds,
                      current.pid == old.process.pid, try self.backend.owner(current.pid).process == old.process else {
                    throw Self.failure("stale_frame", "The captured native geometry changed.")
                }
                guard let current = windows.first(where: { $0.onScreen && $0.bounds.contains(point) && !session.overlayWindowIds.contains($0.windowID) }) else {
                    throw Self.failure("out_of_bounds", "No native window is at the captured point.")
                }
                window = current
            }
            let observed = try self.target(window, session: session, context: context)
            if let previous = frame.windows.first(where: { $0.windowID == window.windowID })?.hosted,
               observed.hosted?.sameMapping(previous) != true { throw Self.failure("stale_frame", "The captured panel ownership changed.") }
            if policy.disclosure(observed) == .structural {
                try self.recheck(window, owner: observed.owner, context: context, hosted: observed.hosted)
                return ServerReply(fields: self.structural(window, owner: observed.owner, hosted: observed.hosted))
            }
            let app = try self.backend.application(observed.owner.process.pid)
            try self.requirePID(app, observed.owner.process.pid)
            let element = try self.backend.hitTest(app, point)
            return try self.hit(element, window: window, owner: observed.owner, session: session, policy: policy,
                                context: context, hosted: observed.hosted)
        }
    }

    func focused(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        run(context, completion) { session, policy in
            guard args.isEmpty else { throw Self.invalid }
            guard let pid = self.backend.frontmostPID(), pid > 0 else { throw Self.failure("not_foreground", "No native app is focused.") }
            let visible = try self.catalog().filter { $0.onScreen && !session.overlayWindowIds.contains($0.windowID) }
            let windows = visible.filter { $0.pid == pid }
            let owner = try self.backend.owner(pid)
            guard owner.process.pid == pid, owner.identity.pid == Int(pid) else { throw Self.changed }
            if policy.disclosure(owner) == .structural {
                // Frontmost-app metadata alone cannot disambiguate several protected windows without AX reads.
                guard windows.count == 1, let window = windows.first else { throw Self.unavailable }
                try self.recheck(window, owner: owner, context: context)
                return ServerReply(fields: self.structural(window, owner: owner))
            }
            let app = try self.backend.application(pid)
            try self.requirePID(app, pid)
            let element = try self.backend.focused(app)
            let actualPID = try self.backend.pid(element)
            if actualPID != pid {
                guard let resolver = self.backend.hostResolver else { throw Self.stale }
                let candidates = visible.filter { $0.pid == pid || $0.pid == actualPID }
                guard candidates.count <= 128 else { throw Self.unavailable }
                var hosted: [(CaptureWindowInfo, HostedWindowProof)] = []
                for window in candidates {
                    try self.requireCurrent(context)
                    guard let proof = try resolver.resolve(window: window, session: session, logicalPID: pid, isCurrent: context.isCurrent),
                          proof.physicalOwner.process.pid == actualPID, proof.logicalOwner.process == owner.process,
                          proof.logicalOwner.identity == owner.identity,
                          resolver.contains(element: element, proof: proof, isCurrent: context.isCurrent) else { continue }
                    hosted.append((window, proof))
                }
                guard hosted.count == 1, let (window, proof) = hosted.first else { throw Self.stale }
                return try self.hit(element, window: window, owner: proof.physicalOwner, session: session,
                                    policy: policy, context: context, hosted: proof)
            }
            let matches: [CaptureWindowInfo]
            if let containing = self.backend.containingWindow {
                guard let root = try containing(element) else { throw Self.unavailable }
                try self.requirePID(root, pid)
                let attributes = try self.attributes(root)
                guard attributes.role == "AXWindow" else { throw Self.unavailable }
                matches = windows.filter { $0.bounds == attributes.bounds }
            } else {
                let attributes = try self.attributes(element)
                matches = windows.filter { $0.bounds.contains(attributes.bounds) || $0.bounds == attributes.bounds }
            }
            guard matches.count == 1, let actual = matches.first else { throw Self.unavailable }
            return try self.hit(element, window: actual, owner: owner, session: session, policy: policy, context: context)
        }
    }

    func resolve(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        run(context, completion) { session, policy in
            guard Set(args.keys) == ["ref"], let ref = Self.id(args["ref"]) else { throw Self.invalid }
            let record = try self.registry.resolve(ref, session: session)
            let (window, target) = try self.preparedTarget(record.witness, session: session, context: context)
            try policy.requireTarget(target, operation: .observe)
            return try self.hit(record.element, window: window, owner: target.owner, session: session, policy: policy,
                                context: context, reference: record, hosted: target.hosted)
        }
    }

    func perform(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        mutate(args, context: context, completion: completion, setting: false)
    }
    func setValue(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        mutate(args, context: context, completion: completion, setting: true)
    }

    private func mutate(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion, setting: Bool) {
        run(context, completion) { session, policy in
            let payload = setting ? "value" : "action"
            let allowed: Set<String> = ["ref", payload, "pid", "elementId", "sessionId", "phaseRevision"]
            guard Set(args.keys).isSubset(of: allowed), let ref = Self.id(args["ref"]),
                  let text = args[payload]?.stringValue, text.utf16.count <= (setting ? 4000 : 64),
                  args["pid"] == nil || Self.pidArgument(args["pid"]) != nil,
                  args["elementId"] == nil || Self.id(args["elementId"]) != nil else { throw Self.invalid }
            if !setting && !Self.actions.contains(text) { throw Self.failure("unsupported_action", "This native element action is unavailable.") }
            guard Self.validPhase(args, session: session) else { throw Self.changed }
            let record = try self.registry.resolve(ref, session: session)
            let (initialWindow, prepared) = try self.preparedTarget(record.witness, session: session, context: context)
            try policy.requireTarget(prepared, operation: .observe)
            try self.requireWindow(record.element, initialWindow, context: context, hosted: prepared.hosted)
            var outcome: Result<(CaptureWindowInfo, NativeTarget, Bool), ServerFailure>?
            guard context.withCurrent({
                do {
                    try self.requireOpen()
                    guard self.backend.preflight() else { throw Self.failure("permissions", "Accessibility is not granted.") }
                    let (window, owner) = try self.liveTarget(record.witness)
                    guard owner.process == prepared.owner.process, owner.identity == prepared.owner.identity else { throw Self.changed }
                    let expected = NativeExpectedTarget(pid: Self.pidArgument(args["pid"]).map(Int.init), process: record.witness.process,
                        windowID: record.witness.windowID, ref: ref, elementID: args["elementId"]?.stringValue)
                    // Establish disclosure authority before requesting any AX attributes, including labels.
                    try policy.requireTarget(NativeTarget(owner: owner, windowID: window.windowID, hosted: prepared.hosted), operation: .observe)
                    try self.requirePID(record.element, owner.process.pid)
                    let attributes = try self.attributes(record.element)
                    if let hosted = prepared.hosted {
                        // One current AXWindow lookup catches same-host reparenting. Group-only bridges
                        // remain observable but cannot authorize mutation; no AX parent walk runs here.
                        try self.requireHostedMutationWindow(record.element, hosted: hosted)
                    } else { try self.requireWindow(record.element, window, context: context) }
                    let finalOwner = try self.backend.owner(owner.process.pid)
                    guard finalOwner.process == owner.process, finalOwner.identity == owner.identity else { throw Self.changed }
                    try self.requirePID(record.element, finalOwner.process.pid)
                    let target = NativeTarget(owner: finalOwner, windowID: window.windowID, ref: record.ref,
                                              elementID: record.elementID, secure: attributes.secure, hosted: prepared.hosted)
                    try policy.requireTarget(target, operation: setting ? .setValue : .pointer, expected: expected)
                    _ = try self.registry.resolve(ref, session: session, witness: self.witness(window, owner, hosted: prepared.hosted))
                    if !setting && text == "AXRaise" && session.mode == "background" {
                        throw Self.failure("needs_foreground", "Raising a window needs the foreground.")
                    }
                    let took = setting
                        ? (attributes.editable ? try self.backend.setValue(record.element, text) : false)
                        : try self.backend.perform(record.element, text)
                    outcome = .success((window, target, took))
                } catch { outcome = .failure(Self.failure(error)) }
            }), let outcome else { throw Self.changed }
            let (window, committed, written) = try outcome.get()
            // Re-reading cannot post an action and must never keep cancellation behind the dispatcher lock.
            try self.requireAccess(context)
            let current = try self.refreshed(committed, window: window, session: session, context: context)
            try policy.requireTarget(current, operation: .observe)
            if current.hosted != nil { try self.requireWindow(record.element, window, context: context, hosted: current.hosted) }
            var took = written
            if setting && written {
                try self.requirePID(record.element, current.owner.process.pid)
                guard try !self.attributes(record.element).secure else {
                    throw Self.failure("secure_field", "The native field cannot expose text.")
                }
                try self.requireAccess(context)
                took = try self.backend.value(record.element) == text
            }
            try self.requirePID(record.element, current.owner.process.pid)
            if current.hosted != nil { try self.requireWindow(record.element, window, context: context, hosted: current.hosted) }
            try self.recheck(window, owner: current.owner, context: context, hosted: current.hosted)
            return ServerReply(fields: ["took": .bool(took)])
        }
    }

    private func hit(_ element: AccessibilityElement, window: CaptureWindowInfo, owner: NativeOwner,
                     session: ServerSession, policy: SessionPolicy, context: OperationContext,
                     reference: AccessibilityReference<AccessibilityElement>? = nil,
                     hosted: HostedWindowProof? = nil) throws -> ServerReply {
        let fresh = try refreshed(NativeTarget(owner: owner, windowID: window.windowID, hosted: hosted),
                                  window: window, session: session, context: context)
        let mapping = fresh.hosted
        try policy.requireTarget(fresh, operation: .observe)
        try requirePID(element, owner.process.pid)
        try requireWindow(element, window, context: context, hosted: mapping)
        let attributes = try self.attributes(element)
        let witness = self.witness(window, owner, hosted: mapping)
        let record = try publish(context) {
            if let reference { return try self.registry.resolve(reference.ref, session: session, witness: witness) }
            let snapshot = try self.registry.currentSnapshot(session: session)
            return try self.registry.register(element: element, witness: witness, snapshot: snapshot)
        }
        var fields = structural(window, owner: owner, hosted: mapping)
        fields["ref"] = .string(record.ref); fields["elementId"] = .string(record.elementID)
        fields["role"] = .string(AccessibilityContent.sanitize(attributes.role, limit: 64))
        fields["name"] = .string(AccessibilityContent.sanitize(attributes.name))
        fields["secure"] = .bool(attributes.secure); fields["enabled"] = .bool(attributes.enabled); fields["editable"] = .bool(attributes.editable)
        if let layout = backend.keyboardLayout?() { fields["layout"] = .object(layout) }
        if let observer = backend.menuShortcuts,
           let shortcuts = try? observer(InputObservation(target: NativeTarget(owner: owner, windowID: window.windowID,
                secure: attributes.secure, hosted: mapping),
                window: window, element: element), session), shortcuts.count <= 128,
           shortcuts.allSatisfy({ (1...8).contains($0.combo.count) && $0.combo.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 32 && MacAppIdentity.safeName($0) }) }) {
            fields["focusedMenuShortcuts"] = .array(shortcuts.map {
                .object(["combo": .array($0.combo.map(JSONValue.string)), "label": .string(AccessibilityContent.sanitize($0.label, limit: 256))])
            })
        }
        if let document = try backend.document(element), MacAppIdentity.canonicalPathShape(document) {
            fields["document"] = .string(document); fields["documentStatus"] = .string("known")
        } else { fields["documentStatus"] = .string("unknown") }
        try requirePID(element, owner.process.pid)
        if mapping != nil { try requireWindow(element, window, context: context, hosted: mapping) }
        try recheck(window, owner: owner, context: context, hosted: mapping)
        return ServerReply(fields: fields)
    }

    private func run(_ context: OperationContext, _ completion: @escaping Dispatcher.Completion,
                     _ body: @escaping (ServerSession, SessionPolicy) throws -> ServerReply) {
        execute { [self] in
            do {
                try requireCurrent(context)
                guard let session = context.session else { throw Self.failure("unavailable", "No computer session is active.") }
                guard backend.preflight() else { throw Self.failure("permissions", "Accessibility is not granted.") }
                let result = try body(session, SessionPolicy(session: session))
                try requireAccess(context)
                completion(.success(result))
            } catch { completion(.failure(Self.failure(error))) }
        }
    }

    private func catalog() throws -> [CaptureWindowInfo] {
        let windows = try backend.windows()
        guard windows.count <= 4096, Set(windows.map(\.windowID)).count == windows.count,
              windows.allSatisfy({ Self.id(.string($0.windowID)) != nil && $0.pid > 0 && CapturePrivacy.valid($0.bounds) }) else { throw Self.unavailable }
        return windows
    }

    /// A hosted target preserves the real AX endpoint and carries its separately proven client/surface binding.
    /// Resolution and element membership may perform bounded AX work and therefore stay outside commit fences.
    private func target(_ window: CaptureWindowInfo, session: ServerSession, context: OperationContext,
                        logicalPID: pid_t? = nil) throws -> NativeTarget {
        if let resolver = backend.hostResolver,
           let proof = try resolver.resolve(window: window, session: session, logicalPID: logicalPID, isCurrent: context.isCurrent) {
            return NativeTarget(owner: proof.physicalOwner, windowID: window.windowID, hosted: proof)
        }
        let owner = try backend.owner(window.pid)
        guard owner.process.pid == window.pid, owner.identity.pid == Int(window.pid) else { throw Self.changed }
        return NativeTarget(owner: owner, windowID: window.windowID)
    }

    private func preparedTarget(_ witness: AccessibilityWitness, session: ServerSession,
                                context: OperationContext) throws -> (CaptureWindowInfo, NativeTarget) {
        let (window, owner) = try liveTarget(witness)
        guard let old = witness.hosted else {
            return (window, NativeTarget(owner: owner, windowID: window.windowID))
        }
        guard let resolver = backend.hostResolver,
              let fresh = try resolver.resolve(window: window, session: session,
                  logicalPID: old.logicalOwner.process.pid, isCurrent: context.isCurrent),
              fresh.sameMapping(old), fresh.physicalOwner.process == witness.process else { throw Self.stale }
        return (window, NativeTarget(owner: fresh.physicalOwner, windowID: window.windowID, hosted: fresh))
    }

    private func refreshed(_ target: NativeTarget, window: CaptureWindowInfo, session: ServerSession,
                           context: OperationContext) throws -> NativeTarget {
        guard let old = target.hosted else { return target }
        if old.validAuthority(session: session, physicalOwner: target.owner, windowID: window.windowID) { return target }
        guard let resolver = backend.hostResolver,
              let fresh = try resolver.resolve(window: window, session: session,
                  logicalPID: old.logicalOwner.process.pid, isCurrent: context.isCurrent), fresh.sameMapping(old) else { throw Self.stale }
        return NativeTarget(owner: fresh.physicalOwner, windowID: window.windowID, ref: target.ref,
                            elementID: target.elementID, secure: target.secure, hosted: fresh)
    }

    private func attributes(_ element: AccessibilityElement) throws -> AccessibilityAttributes {
        let attributes = try backend.describe(element)
        guard !attributes.role.isEmpty, CapturePrivacy.valid(attributes.bounds),
              attributes.role.utf16.count <= 4096, attributes.subrole.map({ $0.utf16.count <= 4096 }) ?? true else { throw Self.unavailable }
        return attributes
    }

    private func windowElement(_ app: AccessibilityElement, _ window: CaptureWindowInfo, context: OperationContext, deadline: UInt64) throws -> AccessibilityElement {
        guard try catalog().filter({ $0.pid == window.pid && $0.bounds == window.bounds }).count == 1 else { throw Self.unavailable }
        let children = try backend.children(app, 128)
        guard !children.truncated, children.elements.count <= 128 else { throw Self.unavailable }
        var matches: [AccessibilityElement] = []
        for candidate in children.elements {
            try requireCurrent(context)
            guard now() < deadline else { throw Self.failure("timeout", "The native window lookup timed out.") }
            try requirePID(candidate, window.pid)
            if let attrs = try? attributes(candidate), attrs.role == "AXWindow", attrs.bounds == window.bounds { matches.append(candidate) }
        }
        guard matches.count == 1, let result = matches.first else { throw Self.unavailable }
        return result
    }

    private func witness(_ window: CaptureWindowInfo, _ owner: NativeOwner, hosted: HostedWindowProof? = nil) -> AccessibilityWitness {
        AccessibilityWitness(process: owner.process, windowID: window.windowID, windowFrame: window.bounds,
                             onScreen: window.onScreen, spaceWitness: window.spaceWitness, hosted: hosted)
    }

    private func liveTarget(_ witness: AccessibilityWitness) throws -> (CaptureWindowInfo, NativeOwner) {
        let windows = try catalog().filter { $0.windowID == witness.windowID }
        let surfaceProcess = witness.hosted?.surface.process ?? witness.process
        guard windows.count == 1, let window = windows.first, window.pid == surfaceProcess.pid,
              window.bounds == witness.windowFrame, window.spaceWitness == witness.spaceWitness,
              window.onScreen == witness.onScreen else { throw Self.stale }
        let owner = try backend.owner(witness.process.pid)
        guard owner.process == witness.process else { throw Self.stale }
        return (window, owner)
    }

    private func recheck(_ window: CaptureWindowInfo, owner: NativeOwner, context: OperationContext,
                         hosted: HostedWindowProof? = nil) throws {
        try requireCurrent(context)
        if let hosted {
            guard let session = context.session, let resolver = backend.hostResolver,
                  let fresh = try resolver.resolve(window: window, session: session,
                      logicalPID: hosted.logicalOwner.process.pid, isCurrent: context.isCurrent),
                  fresh.sameMapping(hosted), fresh.validAuthority(session: session, physicalOwner: owner, windowID: window.windowID) else {
                throw Self.changed
            }
            try requireCurrent(context)
            return
        }
        let fresh = try backend.owner(window.pid)
        guard fresh.process == owner.process, fresh.identity == owner.identity,
              let current = try catalog().first(where: { $0.windowID == window.windowID }), current.pid == window.pid,
              current.bounds == window.bounds, current.onScreen == window.onScreen else { throw Self.changed }
        try requireCurrent(context)
    }

    private func requirePID(_ element: AccessibilityElement, _ pid: pid_t) throws {
        guard try backend.pid(element) == pid else { throw Self.stale }
    }

    private func requireHostedMutationWindow(_ element: AccessibilityElement, hosted: HostedWindowProof) throws {
        guard let containing = backend.containingWindow, let actual = try containing(element),
              backend.equal(actual, hosted.physicalRoot) else { throw Self.stale }
        try requirePID(actual, hosted.physicalOwner.process.pid)
    }

    private func requireWindow(_ element: AccessibilityElement, _ window: CaptureWindowInfo, context: OperationContext,
                               hosted: HostedWindowProof? = nil) throws {
        if let hosted {
            try requireCurrent(context)
            try requirePID(element, hosted.physicalOwner.process.pid)
            guard let resolver = backend.hostResolver,
                  resolver.contains(element: element, proof: hosted, isCurrent: context.isCurrent) else { throw Self.stale }
            try requireCurrent(context)
            return
        }
        guard let containing = backend.containingWindow else { return }
        try requireCurrent(context)
        try requirePID(element, window.pid)
        guard let root = try containing(element) else { throw Self.stale }
        try requirePID(root, window.pid)
        let attributes = try self.attributes(root)
        guard attributes.role == "AXWindow", attributes.bounds == window.bounds,
              try catalog().filter({ $0.pid == window.pid && $0.bounds == window.bounds }).count == 1 else { throw Self.stale }
        try requireCurrent(context)
    }

    private func structural(_ window: CaptureWindowInfo, owner: NativeOwner, hosted: HostedWindowProof? = nil) -> [String: JSONValue] {
        let granted = hosted?.logicalOwner ?? owner
        return ["role": .string("AXWindow"), "secure": .bool(false), "owner": granted.identity.wire,
         "windowId": .string(window.windowID), "signals": .object(granted.childShell.map { ["childShell": .bool($0)] } ?? [:])]
    }

    private func wake(_ app: AccessibilityElement, _ owner: NativeOwner, context: OperationContext) throws {
        try requireAccess(context)
        guard let prepare = backend.prepareWake, let wake = try prepare(app, owner) else { return }
        var applied = false
        guard context.withCurrent({
            self.lock.lock(); defer { self.lock.unlock() }
            guard !self.closed, self.restoration == nil else { return }
            self.restoration = wake.restore
            applied = wake.apply()
        }) else { throw Self.changed }
        if !applied { restoreWake() }
    }

    private func restoreWake() {
        lock.lock(); let restore = restoration; restoration = nil; lock.unlock()
        restore?()
    }
    private func requireOpen() throws { lock.lock(); defer { lock.unlock() }; if closed { throw Self.changed } }
    private func requireCurrent(_ context: OperationContext) throws { guard context.isCurrent() else { throw Self.changed }; try requireOpen() }
    private func requireAccess(_ context: OperationContext) throws {
        try requireCurrent(context)
        guard backend.preflight() else { throw Self.failure("permissions", "Accessibility is not granted.") }
    }

    private func publish<T>(_ context: OperationContext, _ body: () throws -> T) throws -> T {
        var result: Result<T, Error>?
        guard context.withCurrent({ result = Result(catching: body) }), let result else { throw Self.changed }
        return try result.get()
    }

    private static func validPhase(_ fields: [String: JSONValue], session: ServerSession) -> Bool {
        if let revision = session.revision {
            return fields["sessionId"]?.stringValue == session.id && fields["phaseRevision"]?.intValue == revision
        }
        return (fields["sessionId"] == nil || fields["sessionId"]?.stringValue == session.id) &&
            (fields["phaseRevision"] == nil || fields["phaseRevision"]?.intValue.map({ $0 >= 0 }) == true)
    }

    private static func id(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue, !text.isEmpty, text.utf16.count <= 256, !text.contains("\0") else { return nil }; return text
    }
    private static func pidArgument(_ value: JSONValue?) -> pid_t? {
        guard let number = value?.intValue, number > 0, number <= Int(Int32.max) else { return nil }; return pid_t(number)
    }
    private static func rect(_ value: CGRect) -> JSONValue { .object(["x": .number(value.minX), "y": .number(value.minY), "w": .number(value.width), "h": .number(value.height)]) }
    private static var invalid: ServerFailure { failure("failed", "The accessibility arguments are invalid.") }
    private static var unavailable: ServerFailure { failure("unavailable", "The native accessibility target could not be verified.") }
    private static var changed: ServerFailure { failure("changed", "The accessibility operation is no longer current.") }
    private static var stale: ServerFailure { failure("stale_ref", "The native accessibility element changed.") }
    private static func failure(_ code: String, _ message: String) -> ServerFailure { ServerFailure(code: code, message: message) }
    private static func failure(_ error: Error) -> ServerFailure { error as? ServerFailure ?? unavailable }
}

