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

    static var system: AccessibilityBackend {
        var backend = AccessibilityBackend(preflight: { AXIsProcessTrusted() }, windows: AccessibilityNative.windows,
            owner: NativeIdentityReader.observe, application: AccessibilityNative.application, pid: AccessibilityNative.pid,
            describe: AccessibilityNative.describe, value: AccessibilityNative.value, children: AccessibilityNative.children,
            hitTest: AccessibilityNative.hitTest, focused: AccessibilityNative.focused,
            frontmostPID: { NSWorkspace.shared.frontmostApplication?.processIdentifier },
            perform: AccessibilityNative.perform, setValue: AccessibilityNative.setValue, document: AccessibilityNative.document)
        backend.prepareWake = AccessibilityNative.prepareWake
        backend.containingWindow = AccessibilityNative.containingWindow
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
            let selected = windows.filter { window in
                if let pid = Self.pidArgument(args["pid"]) { return window.pid == pid }
                return window.windowID == args["windowId"]?.stringValue
            }
            guard !selected.isEmpty, selected.count <= 128 else { throw Self.failure("app_not_found", "The native app window is unavailable.") }
            let snapshot = try self.publish(context) { try self.registry.beginSnapshot(session: session) }
            var result: [JSONValue] = []
            var truncated = nodes > 400 || depth > 30
            var visited: [AccessibilityElement] = []
            for window in selected {
                if result.count >= limit || self.now() >= deadline { truncated = true; break }
                try self.requireCurrent(context)
                let owner = try self.observe(window, policy: policy, operation: .observe)
                let app = try self.backend.application(window.pid)
                try self.requirePID(app, window.pid)
                try self.wake(app, owner, context: context)
                defer { self.restoreWake() }
                let root: AccessibilityElement
                do { root = try self.windowElement(app, window, context: context, deadline: deadline) }
                catch let failure as ServerFailure where failure.code == "timeout" { truncated = true; break }
                let witness = self.witness(window, owner)
                var queue: [(AccessibilityElement, Int)] = [(root, 1)]
                var index = 0
                while index < queue.count {
                    if result.count >= limit || self.now() >= deadline { truncated = true; break }
                    try self.requireCurrent(context)
                    let (element, level) = queue[index]; index += 1
                    if visited.contains(where: { self.backend.equal($0, element) }) { truncated = true; continue }
                    visited.append(element)
                    try self.requirePID(element, window.pid)
                    do {
                        let attributes = try self.attributes(element)
                        let reference = try self.publish(context) { try self.registry.register(element: element, witness: witness, snapshot: snapshot) }
                        var fields: [String: JSONValue] = ["ref": .string(reference.ref), "role": .string(AccessibilityContent.sanitize(attributes.role, limit: 64)),
                            "name": .string(AccessibilityContent.sanitize(attributes.name)), "bounds": Self.rect(attributes.bounds),
                            "enabled": .bool(attributes.enabled), "focused": .bool(attributes.focused), "secure": .bool(attributes.secure)]
                        if let subrole = attributes.subrole { fields["subrole"] = .string(AccessibilityContent.sanitize(subrole, limit: 64)) }
                        if attributes.secure { fields["value"] = .string("REDACTED") }
                        else if let raw = try self.backend.value(element) { fields["value"] = .string(AccessibilityContent.sanitize(raw)) }
                        try self.requirePID(element, window.pid)
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
                try self.recheck(window, owner: owner, context: context)
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
            let owner = try self.backend.owner(window.pid)
            if policy.disclosure(NativeTarget(owner: owner, windowID: window.windowID)) == .structural {
                try self.recheck(window, owner: owner, context: context)
                return ServerReply(fields: self.structural(window, owner: owner))
            }
            let app = try self.backend.application(window.pid)
            try self.requirePID(app, window.pid)
            let element = try self.backend.hitTest(app, point)
            return try self.hit(element, window: window, owner: owner, session: session, policy: policy, context: context)
        }
    }

    func focused(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        run(context, completion) { session, policy in
            guard args.isEmpty else { throw Self.invalid }
            guard let pid = self.backend.frontmostPID(), pid > 0 else { throw Self.failure("not_foreground", "No native app is focused.") }
            let windows = try self.catalog().filter { $0.pid == pid && $0.onScreen && !session.overlayWindowIds.contains($0.windowID) }
            guard let window = windows.first else { throw Self.failure("not_foreground", "No native window is focused.") }
            let owner = try self.backend.owner(pid)
            if policy.disclosure(NativeTarget(owner: owner, windowID: window.windowID)) == .structural {
                // Frontmost-app metadata alone cannot disambiguate several protected windows without AX reads.
                guard windows.count == 1 else { throw Self.unavailable }
                try self.recheck(window, owner: owner, context: context)
                return ServerReply(fields: self.structural(window, owner: owner))
            }
            let app = try self.backend.application(pid)
            try self.requirePID(app, pid)
            let element = try self.backend.focused(app)
            try self.requirePID(element, pid)
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
            let window = try self.liveWindow(record.witness)
            let owner = try self.observe(window, policy: policy, operation: .observe)
            guard owner.process == record.witness.process else { throw Self.stale }
            return try self.hit(record.element, window: window, owner: owner, session: session, policy: policy, context: context, reference: record)
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
            let initialWindow = try self.liveWindow(record.witness)
            _ = try self.observe(initialWindow, policy: policy, operation: .observe)
            try self.requireWindow(record.element, initialWindow, context: context)
            var outcome: Result<(CaptureWindowInfo, NativeOwner, Bool), ServerFailure>?
            guard context.withCurrent({
                do {
                    try self.requireOpen()
                    guard self.backend.preflight() else { throw Self.failure("permissions", "Accessibility is not granted.") }
                    let (window, owner) = try self.liveTarget(record.witness)
                    let expected = NativeExpectedTarget(pid: Self.pidArgument(args["pid"]).map(Int.init), process: record.witness.process,
                        windowID: record.witness.windowID, ref: ref, elementID: args["elementId"]?.stringValue)
                    // Establish disclosure authority before requesting any AX attributes, including labels.
                    try policy.requireTarget(NativeTarget(owner: owner, windowID: window.windowID), operation: .observe)
                    try self.requirePID(record.element, window.pid)
                    let attributes = try self.attributes(record.element)
                    try self.requireWindow(record.element, window, context: context)
                    let finalOwner = try self.backend.owner(window.pid)
                    guard finalOwner.process == owner.process, finalOwner.identity == owner.identity else { throw Self.changed }
                    try self.requirePID(record.element, window.pid)
                    let target = NativeTarget(owner: finalOwner, windowID: window.windowID, ref: record.ref,
                                              elementID: record.elementID, secure: attributes.secure)
                    try policy.requireTarget(target, operation: setting ? .setValue : .pointer, expected: expected)
                    _ = try self.registry.resolve(ref, session: session, witness: self.witness(window, owner))
                    if !setting && text == "AXRaise" && session.mode == "background" {
                        throw Self.failure("needs_foreground", "Raising a window needs the foreground.")
                    }
                    let took = setting
                        ? (attributes.editable ? try self.backend.setValue(record.element, text) : false)
                        : try self.backend.perform(record.element, text)
                    outcome = .success((window, owner, took))
                } catch { outcome = .failure(Self.failure(error)) }
            }), let outcome else { throw Self.changed }
            let (window, owner, written) = try outcome.get()
            // Re-reading cannot post an action and must never keep cancellation behind the dispatcher lock.
            try self.requireAccess(context)
            var took = written
            if setting && written {
                try self.requirePID(record.element, window.pid)
                guard try !self.attributes(record.element).secure else {
                    throw Self.failure("secure_field", "The native field cannot expose text.")
                }
                try self.requireAccess(context)
                took = try self.backend.value(record.element) == text
            }
            try self.requirePID(record.element, window.pid)
            try self.recheck(window, owner: owner, context: context)
            return ServerReply(fields: ["took": .bool(took)])
        }
    }

    private func hit(_ element: AccessibilityElement, window: CaptureWindowInfo, owner: NativeOwner,
                     session: ServerSession, policy: SessionPolicy, context: OperationContext,
                     reference: AccessibilityReference<AccessibilityElement>? = nil) throws -> ServerReply {
        try policy.requireTarget(NativeTarget(owner: owner, windowID: window.windowID), operation: .observe)
        try requirePID(element, window.pid)
        try requireWindow(element, window, context: context)
        let attributes = try self.attributes(element)
        let witness = self.witness(window, owner)
        let record = try publish(context) {
            if let reference { return try self.registry.resolve(reference.ref, session: session, witness: witness) }
            let snapshot = try self.registry.currentSnapshot(session: session)
            return try self.registry.register(element: element, witness: witness, snapshot: snapshot)
        }
        var fields = structural(window, owner: owner)
        fields["ref"] = .string(record.ref); fields["elementId"] = .string(record.elementID)
        fields["role"] = .string(AccessibilityContent.sanitize(attributes.role, limit: 64))
        fields["name"] = .string(AccessibilityContent.sanitize(attributes.name))
        fields["secure"] = .bool(attributes.secure); fields["enabled"] = .bool(attributes.enabled); fields["editable"] = .bool(attributes.editable)
        if let document = try backend.document(element), MacAppIdentity.canonicalPathShape(document) {
            fields["document"] = .string(document); fields["documentStatus"] = .string("known")
        } else { fields["documentStatus"] = .string("unknown") }
        try requirePID(element, window.pid)
        try recheck(window, owner: owner, context: context)
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

    private func observe(_ window: CaptureWindowInfo, policy: SessionPolicy, operation: NativeOperation) throws -> NativeOwner {
        let owner = try backend.owner(window.pid)
        try policy.requireTarget(NativeTarget(owner: owner, windowID: window.windowID), operation: operation)
        return owner
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

    private func witness(_ window: CaptureWindowInfo, _ owner: NativeOwner) -> AccessibilityWitness {
        AccessibilityWitness(process: owner.process, windowID: window.windowID, windowFrame: window.bounds,
                             onScreen: window.onScreen, spaceWitness: window.spaceWitness)
    }

    private func liveWindow(_ witness: AccessibilityWitness) throws -> CaptureWindowInfo { try liveTarget(witness).0 }

    private func liveTarget(_ witness: AccessibilityWitness) throws -> (CaptureWindowInfo, NativeOwner) {
        let windows = try catalog().filter { $0.windowID == witness.windowID }
        guard windows.count == 1, let window = windows.first, window.pid == witness.process.pid,
              window.bounds == witness.windowFrame, window.spaceWitness == witness.spaceWitness,
              window.onScreen == witness.onScreen else { throw Self.stale }
        let owner = try backend.owner(window.pid)
        guard owner.process == witness.process else { throw Self.stale }
        return (window, owner)
    }

    private func recheck(_ window: CaptureWindowInfo, owner: NativeOwner, context: OperationContext) throws {
        try requireCurrent(context)
        let fresh = try backend.owner(window.pid)
        guard fresh.process == owner.process, fresh.identity == owner.identity,
              let current = try catalog().first(where: { $0.windowID == window.windowID }), current.pid == window.pid,
              current.bounds == window.bounds, current.onScreen == window.onScreen else { throw Self.changed }
        try requireCurrent(context)
    }

    private func requirePID(_ element: AccessibilityElement, _ pid: pid_t) throws {
        guard try backend.pid(element) == pid else { throw Self.stale }
    }

    private func requireWindow(_ element: AccessibilityElement, _ window: CaptureWindowInfo, context: OperationContext) throws {
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

    private func structural(_ window: CaptureWindowInfo, owner: NativeOwner) -> [String: JSONValue] {
        ["role": .string("AXWindow"), "secure": .bool(false), "owner": owner.identity.wire,
         "windowId": .string(window.windowID), "signals": .object(owner.childShell.map { ["childShell": .bool($0)] } ?? [:])]
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

