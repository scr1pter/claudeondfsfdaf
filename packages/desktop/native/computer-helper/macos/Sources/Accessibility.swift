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
    var nameComplete = true
    var secure: Bool { NativeIdentityReader.isSecure(role: role, subrole: subrole) }
}

struct AccessibilityChildren {
    let elements: [AccessibilityElement]
    var truncated = false
}

struct AccessibilityWake {
    let apply: () -> Bool
    let restore: () -> Void
    var restoreVerified: (() -> Bool)? = nil
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
    var menuRoot: ((AccessibilityElement) throws -> AccessibilityElement?)? = nil
    var parent: ((AccessibilityElement) throws -> AccessibilityElement?)? = nil
    var menuDescribe: ((AccessibilityElement) throws -> AccessibilityMenuAttributes)? = nil
    var menuPerform: ((AccessibilityElement, String) throws -> Bool)? = nil
    var text: AccessibilityTextBackend? = nil

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
        backend.menuRoot = AccessibilityNative.menuRoot
        backend.parent = AccessibilityNative.menuParent
        backend.menuDescribe = AccessibilityNative.menuDescribe
        backend.menuPerform = AccessibilityNative.menuPerform
        backend.text = AccessibilityNative.textBackend
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
    private struct WakeEntry {
        let token: UUID
        let owner: NativeOwner
        let runEpoch: UUID
        let restore: () -> Bool
        var retiring = false
    }
    private var wakeRun: UUID?
    private var wakes: [UUID: WakeEntry] = [:]
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
    func invalidateObservations(hard: Bool = false) { if hard { registry.clear() } else { registry.suspendObservations() } }

    /// Called by the authority hook. It only changes private metadata; restoration is a separate drain.
    func noteSession(_ session: ServerSession?) {
        registry.noteSession(session)
        lock.lock(); wakeRun = session?.runEpoch; lock.unlock()
    }

    func retireWakes(session: ServerSession?) {
        let policy = session.flatMap { try? SessionPolicy(session: $0) }
        lock.lock()
        guard wakeRun == session?.runEpoch else { lock.unlock(); return }
        var tokens: [UUID] = []
        for (token, var entry) in wakes {
            if closed || entry.runEpoch != session?.runEpoch || policy?.disclosure(entry.owner) != .content {
                entry.retiring = true; wakes[token] = entry; tokens.append(token)
            }
        }
        lock.unlock()
        guard !tokens.isEmpty else { return }
        execute { [self] in drainWakes(tokens) }
    }

    func wakeCleanupComplete() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !wakes.values.contains(where: { $0.retiring })
    }

    func close() {
        lock.lock(); closed = true; wakeRun = nil
        let tokens = Array(wakes.keys)
        for token in tokens { wakes[token]?.retiring = true }
        lock.unlock()
        registry.close(); drainWakes(tokens)
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
            var menuOwners: [NativeOwner] = []
            if self.backend.menuRoot != nil {
                if let pid = requestedPID {
                    let owner = try self.backend.owner(pid)
                    try policy.requireTarget(NativeTarget(owner: owner), operation: .observe)
                    menuOwners.append(owner)
                } else {
                    for (_, target) in selected {
                        let owner = target.grantOwner
                        if !menuOwners.contains(where: { $0.process == owner.process }) { menuOwners.append(owner) }
                    }
                }
            }
            guard (!selected.isEmpty || !menuOwners.isEmpty), selected.count <= 128 else { throw Self.failure("app_not_found", "The native app window is unavailable.") }
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
                        let reference = try self.publish(context) { try self.registry.register(element: element, witness: witness, snapshot: snapshot,
                            facts: self.receiptFacts(attributes, owner: current.grantOwner)) }
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
            for owner in menuOwners {
                if result.count >= limit || self.now() >= deadline { truncated = true; break }
                try self.menuTree(owner, session: session, policy: policy, context: context, snapshot: snapshot,
                    limit: limit, maxDepth: maxDepth, deadline: deadline, result: &result, truncated: &truncated)
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
            if frame.windowID == nil, let menu = try self.menuAtPoint(point, session: session, policy: policy, context: context) { return menu }
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
            if self.backend.menuRoot != nil, let _ = try? self.menuProof(element, owner: owner, context: context) {
                return try self.hitMenu(element, owner: owner, session: session, policy: policy, context: context)
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
            let record: AccessibilityReference<AccessibilityElement>
            let refreshing: Bool
            if let active = try? self.registry.resolve(ref, session: session) { record = active; refreshing = false }
            else { record = try self.registry.receipt(ref, session: session); refreshing = true }
            if record.witness.menu != nil {
                let owner = try self.backend.owner(record.witness.process.pid)
                guard owner.process == record.witness.process else { throw Self.stale }
                return try self.hitMenu(record.element, owner: owner, session: session, policy: policy, context: context, reference: record, refreshing: refreshing)
            }
            let (window, target) = try self.preparedTarget(record.witness, session: session, context: context, receipt: refreshing)
            try policy.requireTarget(target, operation: .observe)
            return try self.hit(record.element, window: window, owner: target.owner, session: session, policy: policy,
                                context: context, reference: record, hosted: target.hosted, refreshing: refreshing)
        }
    }

    func perform(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        mutate(args, context: context, completion: completion, setting: false)
    }
    func setValue(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        mutate(args, context: context, completion: completion, setting: true)
    }

    /// Background typing preserves the complete observed UTF-16 selection; it is never a replacement guess.
    func insertText(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        run(context, completion) { session, policy in
            let allowed: Set<String> = ["ref", "pid", "windowId", "elementId", "text", "sessionId", "phaseRevision"]
            guard Set(args.keys).isSubset(of: allowed), let ref = Self.id(args["ref"]),
                  let pid = Self.pidArgument(args["pid"]), let inserted = args["text"]?.stringValue,
                  (1...4000).contains(inserted.utf16.count),
                  args["elementId"] == nil || Self.id(args["elementId"]) != nil else { throw Self.invalid }
            guard Self.validPhase(args, session: session) else { throw Self.changed }
            let record = try self.registry.resolve(ref, session: session)
            guard record.witness.menu == nil else { throw Self.failure("blocked", "App menus cannot receive text edits.") }
            if let window = args["windowId"] {
                guard let requested = Self.id(window), requested == record.witness.windowID else { throw Self.stale }
            }
            guard let text = self.backend.text else { throw Self.needsForeground }
            let expected = NativeExpectedTarget(pid: Int(pid), process: record.witness.process, windowID: record.witness.windowID,
                ref: ref, elementID: args["elementId"]?.stringValue)
            let prepared: TextObservation
            let original: AccessibilityTextState
            do {
                prepared = try self.textObservation(record, text: text, session: session, policy: policy,
                    expected: expected, context: context)
                guard let state = try text.state(record.element), state.valueSettable, state.selectionSettable else { throw Self.needsForeground }
                original = state
            } catch let error as ServerFailure {
                if ["unavailable", "unsupported_action"].contains(error.code) { throw Self.needsForeground }
                throw error
            }
            guard let desired = AccessibilityTextEdit.insert(inserted, into: original) else { throw Self.needsForeground }
            try self.requireAccess(context)
            let currentTarget = try self.refreshed(prepared.target, window: prepared.window, session: session, context: context)
            var attempted = false, wrote = false, selected = false, uncertain = false
            var failure: ServerFailure?
            guard context.withCurrent({
                do {
                    let started = self.now(), (deadline, overflow) = started.addingReportingOverflow(50_000_000)
                    guard !overflow else { throw Self.changed }
                    let live = try self.textObservation(record, text: text, session: session, policy: policy,
                        expected: expected, context: context, prepared: currentTarget, root: prepared.root)
                    guard live.facts == prepared.facts, let state = try text.state(record.element),
                          state.valueSettable, state.selectionSettable, state.sameContent(original) else { throw Self.changed }
                    let final = try self.textObservation(record, text: text, session: session, policy: policy,
                        expected: expected, context: context, prepared: live.target, root: prepared.root)
                    guard final.facts == prepared.facts, self.now() < deadline else { throw Self.changed }
                    try self.requireAccess(context)
                    attempted = true
                    wrote = try text.setValue(record.element, desired.value)
                    if wrote { selected = try text.setSelection(record.element, desired.selection) }
                } catch {
                    uncertain = attempted
                    failure = attempted ? Self.changed : Self.failure(error)
                }
            }) else { throw Self.changed }
            if let failure, !attempted { throw failure }
            // No readback is allowed under stale authority or after a field becomes secure. Every failure after
            // an attempted write is changed, so callers cannot type the same text again as a blind fallback.
            do {
                try self.requireAccess(context)
                _ = try self.textObservation(record, text: text, session: session, policy: policy,
                    expected: expected, context: context, root: prepared.root)
                guard let after = try text.state(record.element) else { throw Self.changed }
                _ = try self.textObservation(record, text: text, session: session, policy: policy,
                    expected: expected, context: context, root: prepared.root)
                try self.requireAccess(context)
                if uncertain { throw Self.changed }
                if wrote && selected && after.sameContent(desired) { return ServerReply() }
                if after.sameContent(original) { throw Self.needsForeground }
                throw Self.changed
            } catch let error as ServerFailure {
                if error.code == "needs_foreground" && !uncertain { throw error }
                throw Self.changed
            } catch { throw Self.changed }
        }
    }

    private struct TextObservation {
        let window: CaptureWindowInfo
        let target: NativeTarget
        let root: AccessibilityElement
        let facts: AccessibilityReceiptFacts
    }
    private func textObservation(_ record: AccessibilityReference<AccessibilityElement>, text: AccessibilityTextBackend,
                                 session: ServerSession, policy: SessionPolicy, expected: NativeExpectedTarget,
                                 context: OperationContext, prepared: NativeTarget? = nil,
                                 root expectedRoot: AccessibilityElement? = nil) throws -> TextObservation {
        try requireAccess(context)
        let selection: (CaptureWindowInfo, NativeTarget)
        if let prepared {
            let (actual, owner) = try liveTarget(record.witness)
            guard owner.process == prepared.owner.process, owner.identity == prepared.owner.identity else { throw Self.changed }
            selection = (actual, NativeTarget(owner: owner, windowID: actual.windowID, hosted: prepared.hosted))
        } else { selection = try preparedTarget(record.witness, session: session, context: context) }
        let (window, target) = selection
        try policy.requireTarget(target, operation: .observe)
        try requirePID(record.element, target.owner.process.pid)
        let attributes = try text.attributes(record.element)
        let bound = NativeTarget(owner: target.owner, windowID: window.windowID, ref: record.ref,
            elementID: record.elementID, secure: attributes.secure, hosted: target.hosted)
        try policy.requireTarget(bound, operation: .type, expected: expected)
        guard attributes.enabled, attributes.editable, attributes.nameComplete else { throw Self.needsForeground }
        let app = try backend.application(target.grantOwner.process.pid)
        try requirePID(app, target.grantOwner.process.pid)
        let focused = try text.focused(app)
        try requirePID(focused, target.owner.process.pid)
        guard backend.equal(focused, record.element), let root = try text.window(record.element) else { throw Self.needsForeground }
        try requirePID(root, target.owner.process.pid)
        guard expectedRoot.map({ backend.equal($0, root) }) ?? true,
              try text.bounds(root) == window.bounds else { throw Self.stale }
        if let hosted = target.hosted {
            guard backend.equal(root, hosted.physicalRoot) else { throw Self.stale }
        } else {
            guard try catalog().filter({ $0.pid == window.pid && $0.bounds == window.bounds }).count == 1 else { throw Self.stale }
        }
        let document = try text.document(record.element)
        let facts = receiptFacts(attributes, owner: target.grantOwner, document: document,
            status: document == nil ? "unknown" : "known")
        guard facts.complete, record.facts == facts else { throw Self.stale }
        _ = try registry.resolve(record.ref, session: session, witness: witness(window, target.owner, hosted: target.hosted))
        try requireAccess(context)
        return TextObservation(window: window, target: bound, root: root, facts: facts)
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
            if record.witness.menu != nil {
                return try self.mutateMenu(record, text: text, setting: setting, args: args, session: session, policy: policy, context: context)
            }
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
                took = try self.backend.value(record.element).map { $0.utf8.elementsEqual(text.utf8) } == true
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
                     hosted: HostedWindowProof? = nil, refreshing: Bool = false) throws -> ServerReply {
        let fresh = try refreshed(NativeTarget(owner: owner, windowID: window.windowID, hosted: hosted),
                                  window: window, session: session, context: context)
        let mapping = fresh.hosted
        try policy.requireTarget(fresh, operation: .observe)
        try requirePID(element, owner.process.pid)
        try requireWindow(element, window, context: context, hosted: mapping)
        let attributes = try self.attributes(element)
        let witness = self.witness(window, owner, hosted: mapping)
        var record = try publish(context) {
            if let reference {
                if refreshing { return reference }
                return try self.registry.resolve(reference.ref, session: session, witness: witness)
            }
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
        let facts = receiptFacts(attributes, owner: mapping?.logicalOwner ?? owner,
            document: fields["document"]?.stringValue, status: fields["documentStatus"]?.stringValue ?? "unknown")
        record = try publish(context) {
            if refreshing { return try registry.refreshReceipt(record, liveElement: element, witness: witness, facts: facts, session: session) }
            return try registry.recordFacts(record.ref, facts: facts, session: session)
        }
        return ServerReply(fields: fields)
    }

    private func receiptFacts(_ attributes: AccessibilityAttributes, owner: NativeOwner,
                              document: String? = nil, status: String = "unknown") -> AccessibilityReceiptFacts {
        AccessibilityReceiptFacts(role: attributes.role, subrole: attributes.subrole, name: attributes.name,
            secure: attributes.secure, enabled: attributes.enabled, editable: attributes.editable,
            document: document, documentStatus: status, owner: owner.identity, nameComplete: attributes.nameComplete)
    }
    private func menuFacts(_ proof: AccessibilityMenuProof, owner: NativeOwner) -> AccessibilityReceiptFacts {
        AccessibilityReceiptFacts(role: proof.attributes.role, subrole: proof.attributes.subrole, name: proof.attributes.name,
            secure: proof.attributes.secure, enabled: proof.attributes.enabled, editable: proof.attributes.editable, owner: owner.identity,
            menuShortcut: proof.attributes.menuShortcut, menuShortcutComplete: proof.attributes.shortcutComplete)
    }
    private func sameNativeHost(_ old: HostedWindowProof, _ current: HostedWindowProof) -> Bool {
        old.physicalOwner.process == current.physicalOwner.process && old.logicalOwner.process == current.logicalOwner.process &&
            old.physicalOwner.identity == current.physicalOwner.identity && old.logicalOwner.identity == current.logicalOwner.identity &&
            old.surface == current.surface && old.kind == current.kind &&
            backend.equal(old.physicalRoot, current.physicalRoot) && backend.equal(old.logicalWindow, current.logicalWindow)
    }

    private func menuProof(_ element: AccessibilityElement, owner: NativeOwner, context: OperationContext,
                           root: AccessibilityElement? = nil, budgetMs: UInt64 = 150) throws -> AccessibilityMenuProof {
        try requireCurrent(context)
        guard let session = context.session else { throw Self.stale }
        try SessionPolicy(session: session).requireTarget(NativeTarget(owner: owner), operation: .observe)
        return try AccessibilityMenuScope.observe(element: element, owner: owner, expectedRoot: root,
            backend: backend, now: now, isCurrent: context.isCurrent, budgetMs: budgetMs)
    }

    private func menuTree(_ owner: NativeOwner, session: ServerSession, policy: SessionPolicy, context: OperationContext,
                          snapshot: AccessibilitySnapshot, limit: Int, maxDepth: Int, deadline: UInt64,
                          result: inout [JSONValue], truncated: inout Bool) throws {
        try policy.requireTarget(NativeTarget(owner: owner), operation: .observe)
        guard let lookup = backend.menuRoot else { return }
        let app = try backend.application(owner.process.pid)
        try requirePID(app, owner.process.pid)
        try wake(app, owner, context: context)
        guard let root = try lookup(app) else { return }
        try requirePID(root, owner.process.pid)
        var queue: [(AccessibilityElement, Int)] = [(root, 1)], visited: [AccessibilityElement] = []
        var index = 0
        while index < queue.count {
            guard result.count < limit, now() < deadline else { truncated = true; break }
            let (element, depth) = queue[index]; index += 1
            if visited.contains(where: { backend.equal($0, element) }) { truncated = true; continue }
            visited.append(element)
            do {
                let observedAt = now()
                guard observedAt < deadline else { truncated = true; break }
                let proof = try menuProof(element, owner: owner, context: context, root: root,
                    budgetMs: min(150, max(1, (deadline - observedAt) / 1_000_000)))
                let witness = AccessibilityWitness(process: owner.process, menu: proof.witness(session: session))
                let record = try publish(context) { try registry.register(element: element, witness: witness, snapshot: snapshot,
                    facts: menuFacts(proof, owner: owner)) }
                var fields = menuFields(proof, owner: owner, record: record)
                fields.removeValue(forKey: "owner"); fields.removeValue(forKey: "documentStatus"); fields.removeValue(forKey: "editable")
                fields["focused"] = .bool(proof.attributes.focused)
                if let subrole = proof.attributes.subrole { fields["subrole"] = .string(subrole) }
                if proof.attributes.secure { fields["value"] = .string("REDACTED") }
                result.append(.object(fields))
                let remaining = max(0, limit - result.count - (queue.count - index))
                let children = try backend.children(element, depth < maxDepth ? remaining : 0)
                guard children.elements.count <= remaining || depth >= maxDepth else { throw Self.unavailable }
                if children.truncated { truncated = true }
                if depth < maxDepth { queue += children.elements.map { ($0, depth + 1) } }
            } catch let error as ServerFailure {
                if error.code == "changed" { throw error }
                truncated = true
            }
        }
    }

    private func menuFields(_ proof: AccessibilityMenuProof, owner: NativeOwner,
                            record: AccessibilityReference<AccessibilityElement>) -> [String: JSONValue] {
        var fields: [String: JSONValue] = ["scope": .string("app-menu"), "pid": .integer(Int64(owner.process.pid)),
            "owner": owner.identity.wire, "ref": .string(record.ref), "elementId": .string(record.elementID),
            "menuPath": .array(proof.menuPath.map { .string(AccessibilityContent.sanitize($0, limit: 256)) }),
            "role": .string(proof.attributes.role), "name": .string(AccessibilityContent.sanitize(proof.attributes.name, limit: 256)),
            "secure": .bool(proof.attributes.secure), "enabled": .bool(proof.attributes.enabled), "editable": .bool(proof.attributes.editable),
            "documentStatus": .string("unknown")]
        if let shortcut = proof.attributes.menuShortcut { fields["menuShortcut"] = .array(shortcut.map(JSONValue.string)) }
        if let bounds = proof.attributes.bounds { fields["bounds"] = Self.rect(bounds) }
        return fields
    }

    private func hitMenu(_ element: AccessibilityElement, owner: NativeOwner, session: ServerSession, policy: SessionPolicy,
                         context: OperationContext, reference: AccessibilityReference<AccessibilityElement>? = nil,
                         refreshing: Bool = false) throws -> ServerReply {
        try policy.requireTarget(NativeTarget(owner: owner), operation: .observe)
        let proof = try menuProof(element, owner: owner, context: context, root: reference?.witness.menu?.root)
        let witness = AccessibilityWitness(process: owner.process, menu: proof.witness(session: session))
        var record = try publish(context) {
            if let reference {
                if refreshing { return reference }
                return try registry.resolve(reference.ref, session: session, witness: witness)
            }
            let snapshot = try registry.currentSnapshot(session: session)
            return try registry.register(element: element, witness: witness, snapshot: snapshot)
        }
        let layout = backend.keyboardLayout?()
        let final = try menuProof(element, owner: owner, context: context, root: proof.root)
        guard final.witness(session: session) == proof.witness(session: session) else { throw Self.stale }
        let facts = menuFacts(final, owner: owner)
        record = try publish(context) {
            if refreshing { return try registry.refreshReceipt(record, liveElement: element, witness: witness, facts: facts, session: session) }
            return try registry.recordFacts(record.ref, facts: facts, session: session)
        }
        var fields = menuFields(final, owner: owner, record: record)
        if let layout { fields["layout"] = .object(layout) }
        try requireCurrent(context)
        return ServerReply(fields: fields)
    }

    private func menuAtPoint(_ point: CGPoint, session: ServerSession, policy: SessionPolicy,
                             context: OperationContext) throws -> ServerReply? {
        guard let lookup = backend.menuRoot, let describe = backend.menuDescribe,
              let pid = backend.frontmostPID(), pid > 0 else { return nil }
        let owner = try backend.owner(pid)
        guard policy.disclosure(NativeTarget(owner: owner)) == .content else { return nil }
        let app = try backend.application(pid)
        try requirePID(app, pid)
        guard let root = try lookup(app) else { return nil }
        try requirePID(root, pid)
        guard let bounds = try describe(root).bounds, bounds.contains(point) else { return nil }
        let element = try backend.hitTest(app, point)
        try requirePID(element, pid)
        guard let proof = try? menuProof(element, owner: owner, context: context, root: root),
              proof.attributes.bounds.map({ $0.contains(point) }) ?? false,
              backend.frontmostPID() == pid else { return nil }
        return try hitMenu(element, owner: owner, session: session, policy: policy, context: context)
    }

    private func mutateMenu(_ record: AccessibilityReference<AccessibilityElement>, text: String, setting: Bool,
                            args: [String: JSONValue], session: ServerSession, policy: SessionPolicy,
                            context: OperationContext) throws -> ServerReply {
        guard let menu = record.witness.menu, menu.runEpoch == session.runEpoch else { throw Self.stale }
        let owner = try backend.owner(record.witness.process.pid)
        guard owner.process == record.witness.process else { throw Self.stale }
        try policy.requireTarget(NativeTarget(owner: owner), operation: .observe)
        let prepared = try menuProof(record.element, owner: owner, context: context, root: menu.root)
        guard prepared.witness(session: session) == menu else { throw Self.stale }
        let expected = NativeExpectedTarget(pid: Self.pidArgument(args["pid"]).map(Int.init), process: record.witness.process,
            ref: record.ref, elementID: args["elementId"]?.stringValue)
        try policy.requireTarget(NativeTarget(owner: owner, ref: record.ref, elementID: record.elementID, secure: prepared.attributes.secure),
            operation: setting ? .setValue : .pointer, expected: expected)
        guard MenuSafety.allowed(prepared.menuPath, shortcut: prepared.attributes.menuShortcut) else { throw Self.failure("blocked", "This native menu route is unavailable.") }
        guard !setting else { throw Self.failure("blocked", "App menus cannot receive text edits.") }
        if text == "AXPress" {
            guard prepared.attributes.shortcutComplete else { throw menuFallback(session) }
            if let shortcut = prepared.attributes.menuShortcut, MenuSafety.requiresTextTarget(shortcut) {
                try requireMenuTypingTarget(owner: owner, shortcut: shortcut, session: session, policy: policy, context: context)
                throw menuFallback(session)
            }
        }
        guard record.facts == menuFacts(prepared, owner: owner) else { throw Self.stale }
        if text == "AXRaise" { throw Self.failure("needs_foreground", "Raising an app needs the foreground.") }
        var result: Result<Bool, ServerFailure>?
        guard context.withCurrent({
            do {
                let commitStart = self.now(), (commitDeadline, overflow) = commitStart.addingReportingOverflow(50_000_000)
                guard !overflow else { throw Self.changed }
                try self.requireAccess(context)
                let fresh = try self.backend.owner(owner.process.pid)
                guard fresh.process == owner.process, fresh.identity == owner.identity else { throw Self.stale }
                try policy.requireTarget(NativeTarget(owner: fresh), operation: .observe)
                let remainingAt = self.now()
                guard remainingAt < commitDeadline else { throw Self.failure("timeout", "The native menu validation timed out.") }
                let proof = try self.menuProof(record.element, owner: fresh, context: context, root: menu.root,
                    budgetMs: min(50, max(1, (commitDeadline - remainingAt) / 1_000_000)))
                guard proof.witness(session: session) == menu else { throw Self.stale }
                try policy.requireTarget(NativeTarget(owner: fresh, ref: record.ref, elementID: record.elementID, secure: proof.attributes.secure),
                    operation: .pointer, expected: expected)
                guard MenuSafety.allowed(proof.menuPath, shortcut: proof.attributes.menuShortcut) else { throw Self.failure("blocked", "This native menu route is unavailable.") }
                guard record.facts == self.menuFacts(proof, owner: fresh) else { throw Self.stale }
                if text == "AXPress" {
                    guard proof.attributes.shortcutComplete else { throw self.menuFallback(session) }
                    if let shortcut = proof.attributes.menuShortcut, MenuSafety.requiresTextTarget(shortcut) {
                        // The prepared path normally rejects this before the commit; a changed shortcut is never acted upon.
                        throw self.menuFallback(session)
                    }
                }
                _ = try self.registry.resolve(record.ref, session: session,
                    witness: AccessibilityWitness(process: fresh.process, menu: proof.witness(session: session)))
                guard self.now() < commitDeadline else { throw Self.failure("timeout", "The native menu validation timed out.") }
                try self.requireAccess(context)
                result = .success(try (self.backend.menuPerform ?? self.backend.perform)(record.element, text))
            } catch { result = .failure(Self.failure(error)) }
        }), let result else { throw Self.changed }
        let took = try result.get()
        try requireAccess(context)
        return ServerReply(fields: ["took": .bool(took)])
    }

    private func menuFallback(_ session: ServerSession) -> ServerFailure {
        session.mode == "background" ? Self.needsForeground :
            Self.failure("unsupported_action", "Use the actual focused field for this menu command.")
    }
    private func requireMenuTypingTarget(owner: NativeOwner, shortcut: [String], session: ServerSession,
                                         policy: SessionPolicy, context: OperationContext) throws {
        guard let text = backend.text else { throw menuFallback(session) }
        try requireAccess(context)
        let app = try backend.application(owner.process.pid)
        try requirePID(app, owner.process.pid)
        let focused = try text.focused(app)
        try requirePID(focused, owner.process.pid)
        let attributes = try text.attributes(focused)
        let field = NativeTarget(owner: owner, secure: attributes.secure)
        try policy.requireTarget(field, operation: .observe)
        guard !attributes.secure else { throw Self.failure("secure_field", "The focused field cannot receive this menu command.") }
        if MenuSafety.editsText(shortcut) { try policy.requireTarget(field, operation: .setValue) }
        guard let root = try text.window(focused) else { throw menuFallback(session) }
        try requirePID(root, owner.process.pid)
        let bounds = try text.bounds(root)
        let windows = try catalog().filter { $0.pid == owner.process.pid && $0.bounds == bounds }
        guard windows.count == 1, let window = windows.first else { throw menuFallback(session) }
        let target = NativeTarget(owner: owner, windowID: window.windowID, secure: attributes.secure)
        try policy.requireTarget(target, operation: .observe)
        guard !attributes.secure else { throw Self.failure("secure_field", "The focused field cannot receive this menu command.") }
        if MenuSafety.editsText(shortcut) { try policy.requireTarget(target, operation: .setValue) }
        try requireAccess(context)
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
                                context: OperationContext, receipt: Bool = false) throws -> (CaptureWindowInfo, NativeTarget) {
        let (window, owner) = try liveTarget(witness)
        guard let old = witness.hosted else {
            return (window, NativeTarget(owner: owner, windowID: window.windowID))
        }
        guard let resolver = backend.hostResolver,
              let fresh = try resolver.resolve(window: window, session: session,
                  logicalPID: old.logicalOwner.process.pid, isCurrent: context.isCurrent),
              (receipt ? self.sameNativeHost(old, fresh) : fresh.sameMapping(old)),
              fresh.physicalOwner.process == witness.process else { throw Self.stale }
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
        guard witness.menu == nil, witness.windowID != nil, witness.windowFrame != nil, witness.onScreen != nil else { throw Self.stale }
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
        guard let session = context.session else { throw Self.changed }
        lock.lock()
        let previous = wakes.values.first { $0.owner.process == owner.process }
        let full = wakes.count >= 32
        lock.unlock()
        if let previous {
            guard previous.runEpoch == session.runEpoch, !previous.retiring else {
                throw Self.failure("unavailable", "Native accessibility cleanup is pending.")
            }
            return
        }
        guard !full else { throw Self.failure("unavailable", "The accessibility wake limit was reached.") }
        guard let prepare = backend.prepareWake, let wake = try prepare(app, owner) else { return }
        let token = UUID()
        let entry = WakeEntry(token: token, owner: owner, runEpoch: session.runEpoch,
            restore: wake.restoreVerified ?? { wake.restore(); return true })
        var applied = false
        var recorded = false
        guard context.withCurrent({
            self.lock.lock(); defer { self.lock.unlock() }
            if self.wakeRun == nil && self.wakes.isEmpty { self.wakeRun = session.runEpoch }
            guard !self.closed, self.wakeRun == session.runEpoch, self.wakes.count < 32,
                  !self.wakes.values.contains(where: { $0.owner.process == owner.process }) else { return }
            recorded = true
            self.wakes[token] = entry // Record the original state before an AX timeout can hide an applied write.
            applied = wake.apply()
            if !applied { self.wakes[token]?.retiring = true }
        }) else { throw Self.changed }
        guard recorded else { throw Self.changed }
        if !applied { drainWakes([token]) }
    }

    private func drainWakes(_ tokens: [UUID]) {
        let started = now(), (deadline, overflow) = started.addingReportingOverflow(200_000_000)
        guard !overflow else { return }
        var pending = tokens, attempts: [UUID: Int] = [:]
        var index = 0
        while index < pending.count, now() < deadline {
            let token = pending[index]; index += 1
            lock.lock(); let entry = wakes[token]; lock.unlock()
            guard let entry, entry.retiring else { continue }
            let restored = entry.restore()
            lock.lock()
            if restored, wakes[token]?.token == entry.token { wakes.removeValue(forKey: token) }
            lock.unlock()
            if !restored {
                attempts[token, default: 0] += 1
                if attempts[token, default: 0] < 3 { pending.append(token) }
            }
        }
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
    private static var needsForeground: ServerFailure { failure("needs_foreground", "This input needs foreground control.") }
    private static var invalid: ServerFailure { failure("failed", "The accessibility arguments are invalid.") }
    private static var unavailable: ServerFailure { failure("unavailable", "The native accessibility target could not be verified.") }
    private static var changed: ServerFailure { failure("changed", "The accessibility operation is no longer current.") }
    private static var stale: ServerFailure { failure("stale_ref", "The native accessibility element changed.") }
    private static func failure(_ code: String, _ message: String) -> ServerFailure { ServerFailure(code: code, message: message) }
    private static func failure(_ error: Error) -> ServerFailure { error as? ServerFailure ?? unavailable }
}

