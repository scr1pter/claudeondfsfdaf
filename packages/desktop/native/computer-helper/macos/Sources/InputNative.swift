import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import CryptoKit
import Darwin
import Dispatch
import Foundation

/// One native adapter per worker. Construction does not inspect or post any input.
final class InputNative {
    /// Fixed, positive 64-bit tag shared with M8's own-event filter; never sent over the protocol.
    static let eventTag: Int64 = 0x564543544F52484E
    private let sourceLock = NSLock()
    private var privateSource: CGEventSource?
    private var resolvedLayout: String?
    private struct PointerWitness {
        let window: CaptureWindowInfo
        let process: HelperProcessIdentity
        let overlays: Set<String>
        let point: CGPoint
    }
    private var pointerWitness: PointerWitness?
    private var ownedUps: [String: InputPostedEvent] = [:]
    private var ownedOrder: [String] = []
    private var sourceReady = true

    static func backend(accessibility: AccessibilityService? = nil) -> InputBackend {
        let native = InputNative()
        var backend = InputBackend(tag: eventTag, preflight: { AXIsProcessTrusted() && CGPreflightPostEventAccess() },
            windows: AccessibilityNative.windows, owner: NativeIdentityReader.observe,
            pointer: native.pointer, focused: native.focused,
            bind: { observation, expected, session in
                if let accessibility {
                    return try accessibility.verifyInputTarget(element: observation.element, target: observation.target,
                        window: observation.window, expected: expected, session: session)
                }
                guard expected.ref == nil, expected.elementID == nil else { throw InputNative.stale }
                return observation.target
            },
            resolve: { combo in
                let snapshot = try KeyboardSnapshot()
                guard snapshot.representable else { throw InputNative.unavailable }
                let result = try resolveCombo(combo, layout: snapshot.fingerprint,
                    resolve: { key, flags in resolveKey(key, flags: flags, translate: snapshot.translate) }, translate: snapshot.translate)
                guard let current = try? KeyboardSnapshot(), current.fingerprint == snapshot.fingerprint else { throw InputNative.changed }
                native.sourceLock.lock(); native.resolvedLayout = snapshot.fingerprint; native.sourceLock.unlock()
                return result
            },
            layout: { try? KeyboardSnapshot().fingerprint }, post: { try native.post($0) }, release: native.release,
            reconcile: native.reconcile)
        backend.menus = native.menus
        return backend
    }

    private func pointer(_ point: CGPoint, _ session: ServerSession) throws -> InputObservation {
        guard finite(point) else { throw InputNative.unavailable }
        let windows = try AccessibilityNative.windows()
        guard let window = windows.first(where: { $0.onScreen && $0.alpha > 0 && $0.bounds.contains(point) && !session.overlayWindowIds.contains($0.windowID) }) else { throw InputNative.unavailable }
        let owner = try NativeIdentityReader.observe(pid: window.pid)
        let policy = try SessionPolicy(session: session)
        try policy.requireTarget(NativeTarget(owner: owner, windowID: window.windowID), operation: .observe)
        var element: AccessibilityElement?
        var secure: Bool?
        // Coordinate input still works on approved surfaces that expose no usable AX tree.
        if let app = try? axApplication(window.pid),
           let hit = try? axHit(app, point, pid: window.pid),
           let root = try? axWindow(hit, pid: window.pid),
           let bounds = try? axBounds(root, pid: window.pid), bounds == window.bounds,
           windows.filter({ $0.pid == window.pid && $0.bounds == window.bounds }).count == 1,
           let actual = hit.native, try AccessibilityNative.pid(hit) == window.pid {
            element = hit
            secure = axSecure(actual, pid: window.pid)
        }
        try recheck(owner, window: window)
        sourceLock.lock()
        pointerWitness = PointerWitness(window: window, process: owner.process, overlays: Set(session.overlayWindowIds), point: point)
        sourceLock.unlock()
        return InputObservation(target: NativeTarget(owner: owner, windowID: window.windowID, secure: secure), window: window, element: element)
    }

    private func focused(_ pid: pid_t, _ session: ServerSession) throws -> InputObservation {
        guard pid > 0, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw InputNative.changed }
        let owner = try NativeIdentityReader.observe(pid: pid)
        let policy = try SessionPolicy(session: session)
        // Policy is checked before asking the app for a focused AX element or its security metadata.
        try policy.requireTarget(NativeTarget(owner: owner), operation: .observe)
        let app = try axApplication(pid)
        let focused = try axElement(app, attribute: kAXFocusedUIElementAttribute, pid: pid)
        guard try AccessibilityNative.pid(focused) == pid,
              let root = try axWindow(focused, pid: pid),
              try AccessibilityNative.pid(root) == pid else { throw InputNative.changed }
        let frame = try axBounds(root, pid: pid)
        let windows = try AccessibilityNative.windows().filter { $0.pid == pid && $0.bounds == frame }
        guard windows.count == 1, let window = windows.first else { throw InputNative.unavailable }
        try policy.requireTarget(NativeTarget(owner: owner, windowID: window.windowID), operation: .observe)
        guard let native = focused.native else { throw InputNative.unavailable }
        let secure = axSecure(native, pid: pid)
        try recheck(owner, window: window)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw InputNative.changed }
        return InputObservation(target: NativeTarget(owner: owner, windowID: window.windowID, secure: secure), window: window, element: focused)
    }

    private func axApplication(_ pid: pid_t) throws -> AccessibilityElement {
        guard let process = HelperLifecycle.processIdentity(pid) else { throw InputNative.changed }
        let native = AXUIElementCreateApplication(pid)
        guard AXUIElementSetMessagingTimeout(native, 0.01) == .success,
              HelperLifecycle.processIdentity(pid) == process else { throw InputNative.changed }
        return AccessibilityElement(native: native)
    }
    private func axHandle(_ element: AccessibilityElement, pid: pid_t) throws -> AXUIElement {
        guard let native = element.native, CFGetTypeID(native) == AXUIElementGetTypeID() else { throw InputNative.unavailable }
        var actual: pid_t = 0
        guard AXUIElementGetPid(native, &actual) == .success, actual == pid,
              AXUIElementSetMessagingTimeout(native, 0.01) == .success else { throw InputNative.changed }
        return native
    }
    private func axElement(_ element: AccessibilityElement, attribute: String, pid: pid_t) throws -> AccessibilityElement {
        let native = try axHandle(element, pid: pid); var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(native, attribute as CFString, &raw) == .success,
              let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { throw InputNative.unavailable }
        let result = AccessibilityElement(native: raw as! AXUIElement)
        _ = try axHandle(result, pid: pid)
        return result
    }
    private func axHit(_ app: AccessibilityElement, _ point: CGPoint, pid: pid_t) throws -> AccessibilityElement {
        let native = try axHandle(app, pid: pid); var raw: AXUIElement?
        guard AXUIElementCopyElementAtPosition(native, Float(point.x), Float(point.y), &raw) == .success,
              let raw else { throw InputNative.unavailable }
        let result = AccessibilityElement(native: raw)
        _ = try axHandle(result, pid: pid)
        return result
    }
    private func axWindow(_ element: AccessibilityElement, pid: pid_t) throws -> AccessibilityElement? {
        let native = try axHandle(element, pid: pid); var raw: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(native, kAXWindowAttribute as CFString, &raw)
        if error == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() {
            let window = AccessibilityElement(native: raw as! AXUIElement)
            _ = try axHandle(window, pid: pid)
            return window
        }
        guard error == .attributeUnsupported || error == .noValue else { throw InputNative.unavailable }
        raw = nil
        guard AXUIElementCopyAttributeValue(native, kAXRoleAttribute as CFString, &raw) == .success,
              let raw, AccessibilityNative.completeString(raw, limit: 64) == "AXWindow" else { return nil }
        return element
    }
    private func axBounds(_ element: AccessibilityElement, pid: pid_t) throws -> CGRect {
        let native = try axHandle(element, pid: pid); var raw: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(native, [kAXPositionAttribute, kAXSizeAttribute] as CFArray, [], &raw) == .success,
              let values = raw as? [AnyObject], values.count == 2,
              CFGetTypeID(values[0]) == AXValueGetTypeID(), CFGetTypeID(values[1]) == AXValueGetTypeID(),
              AXValueGetType(values[0] as! AXValue) == .cgPoint, AXValueGetType(values[1] as! AXValue) == .cgSize else { throw InputNative.unavailable }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(values[0] as! AXValue, .cgPoint, &point), AXValueGetValue(values[1] as! AXValue, .cgSize, &size) else { throw InputNative.unavailable }
        let rect = CGRect(origin: point, size: size)
        guard CapturePrivacy.valid(rect) else { throw InputNative.unavailable }
        return rect
    }
    private func axSecure(_ element: AXUIElement, pid: pid_t) -> Bool? {
        guard let process = HelperLifecycle.processIdentity(pid), AXUIElementSetMessagingTimeout(element, 0.01) == .success else { return nil }
        var actual: pid_t = 0, raw: CFTypeRef?
        guard AXUIElementGetPid(element, &actual) == .success, actual == pid,
              AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &raw) == .success,
              let raw, let role = AccessibilityNative.completeString(raw, limit: 64), !role.isEmpty else { return nil }
        var subrole: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
        let value: String?
        if error == .attributeUnsupported || error == .noValue { value = nil }
        else {
            guard error == .success, let subrole, let text = AccessibilityNative.completeString(subrole, limit: 64) else { return nil }
            value = text
        }
        guard AXUIElementGetPid(element, &actual) == .success, actual == pid,
              HelperLifecycle.processIdentity(pid) == process else { return nil }
        return NativeIdentityReader.isSecure(role: role, subrole: value)
    }

    private func recheck(_ owner: NativeOwner, window: CaptureWindowInfo) throws {
        let current = try NativeIdentityReader.observe(pid: owner.process.pid)
        guard current.process == owner.process, current.identity == owner.identity,
              let actual = try AccessibilityNative.windows().first(where: { $0.windowID == window.windowID }),
              actual.pid == window.pid, actual.bounds == window.bounds, actual.onScreen == window.onScreen,
              actual.alpha == window.alpha else { throw InputNative.changed }
    }

    /// A bounded, complete app-scoped menu observation. Incomplete data remains unknown, never an empty proof.
    private func menus(_ observation: InputObservation, _ session: ServerSession) throws -> [InputMenuShortcut]? {
        let owner = observation.target.owner
        try SessionPolicy(session: session).requireTarget(observation.target, operation: .observe)
        try recheck(owner, window: observation.window)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == owner.process.pid else { return nil }
        let focused = try axElement(axApplication(owner.process.pid), attribute: kAXFocusedUIElementAttribute, pid: owner.process.pid)
        guard let focusedWindow = try axWindow(focused, pid: owner.process.pid),
              try axBounds(focusedWindow, pid: owner.process.pid) == observation.window.bounds else { return nil }
        guard let app = try AccessibilityNative.application(owner.process.pid).native else { return nil }
        let deadline = DispatchTime.now().uptimeNanoseconds + 30_000_000
        guard AXUIElementSetMessagingTimeout(app, 0.005) == .success else { return nil }
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &raw) == .success,
              let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        let root = AccessibilityElement(native: raw as! AXUIElement)
        var queue: [(AccessibilityElement, Int)] = [(root, 0)]
        var index = 0
        var visited: [AccessibilityElement] = []
        var result: [InputMenuShortcut] = []
        while index < queue.count {
            guard DispatchTime.now().uptimeNanoseconds < deadline, visited.count < 256 else { return nil }
            let (item, depth) = queue[index]; index += 1
            if visited.contains(where: { AccessibilityElement.equivalent($0, item) }) { return nil }
            visited.append(item)
            guard try AccessibilityNative.pid(item) == owner.process.pid, let native = item.native,
                  AXUIElementSetMessagingTimeout(native, 0.005) == .success else { return nil }
            let attributes = [kAXTitleAttribute, kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute,
                              kAXMenuItemCmdVirtualKeyAttribute] as CFArray
            var values: CFArray?
            guard AXUIElementCopyMultipleAttributeValues(native, attributes, [], &values) == .success,
                  let values = values as? [AnyObject], values.count == 4 else { return nil }
            let character = AccessibilityNative.completeString(values[1], limit: 32)
            let virtualKey = number(values[3], maximum: 127)
            if character?.isEmpty == false || virtualKey != nil {
                guard let modifiers = number(values[2], maximum: 15) else { return nil }
                var combo: [String] = []
                if modifiers & 8 == 0 { combo.append("cmd") }
                if modifiers & 1 != 0 { combo.append("shift") }
                if modifiers & 2 != 0 { combo.append("alt") }
                if modifiers & 4 != 0 { combo.append("ctrl") }
                let key: String
                if let character, !character.isEmpty, character.count == 1, MacAppIdentity.safeName(character) {
                    key = character.utf8.count == 1 ? character.lowercased() : character
                } else if let virtualKey, let control = Self.semanticControl(UInt16(virtualKey)) { key = control }
                else { return nil }
                combo.append(key)
                let label = AccessibilityNative.completeString(values[0], limit: 256) ?? ""
                result.append(InputMenuShortcut(combo: combo, label: MacAppIdentity.safeName(label) ? label : ""))
                guard result.count <= 128 else { return nil }
            }
            let remaining = max(0, 256 - visited.count - (queue.count - index))
            let children = try menuChildren(item, pid: owner.process.pid, limit: depth < 8 ? remaining : 0)
            guard !children.truncated, depth < 8 || children.elements.isEmpty else { return nil }
            queue.append(contentsOf: children.elements.map { ($0, depth + 1) })
        }
        try recheck(owner, window: observation.window)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == owner.process.pid else { throw InputNative.changed }
        return result
    }

    static func menusWire(_ observation: InputObservation, _ session: ServerSession) throws -> [InputMenuShortcut]? {
        try InputNative().menus(observation, session)
    }
    private func menuChildren(_ element: AccessibilityElement, pid: pid_t, limit: Int) throws -> AccessibilityChildren {
        guard let native = element.native, AXUIElementSetMessagingTimeout(native, 0.005) == .success else { throw InputNative.unavailable }
        var count: CFIndex = 0
        let error = AXUIElementGetAttributeValueCount(native, kAXChildrenAttribute as CFString, &count)
        if error == .attributeUnsupported || error == .noValue { return AccessibilityChildren(elements: []) }
        guard error == .success, count >= 0 else { throw InputNative.unavailable }
        let number = min(count, max(0, limit))
        if number == 0 { return AccessibilityChildren(elements: [], truncated: count > 0) }
        var array: CFArray?
        guard AXUIElementCopyAttributeValues(native, kAXChildrenAttribute as CFString, 0, number, &array) == .success,
              let values = array as? [AnyObject], values.count <= number else { throw InputNative.unavailable }
        let children = try values.map { value -> AccessibilityElement in
            guard CFGetTypeID(value) == AXUIElementGetTypeID() else { throw InputNative.unavailable }
            let child = AccessibilityElement(native: value as! AXUIElement)
            _ = try axHandle(child, pid: pid)
            return child
        }
        return AccessibilityChildren(elements: children, truncated: count > number)
    }

    private func number(_ raw: CFTypeRef, maximum: Int) -> Int? {
        guard CFGetTypeID(raw) == CFNumberGetTypeID(), let number = raw as? NSNumber,
              number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= Double(maximum),
              number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
        return number.intValue
    }

    private func source() -> CGEventSource? {
        sourceLock.lock(); defer { sourceLock.unlock() }
        if let privateSource { return privateSource }
        guard let source = CGEventSource(stateID: .privateState) else { return nil }
        source.userData = Self.eventTag
        source.localEventsSuppressionInterval = 0
        privateSource = source
        return source
    }

    private func post(_ descriptor: InputPostedEvent, cleanup: Bool = false) throws -> Bool {
        sourceLock.lock(); let ready = sourceReady; sourceLock.unlock()
        guard ready || (cleanup && [.keyUp, .unicodeUp, .buttonUp].contains(descriptor.kind)) else { return false }
        guard descriptor.tag == Self.eventTag, descriptor.flags & ~Self.allowedFlags == 0,
              finite(descriptor.point), descriptor.unicode.count <= 20,
              descriptor.button >= 0, descriptor.button <= 2, (1...3).contains(descriptor.clickCount),
              let source = self.source() else { return false }
        let keyboard = [.keyDown, .keyUp, .unicodeDown, .unicodeUp].contains(descriptor.kind)
        var generatedLayout: String?
        if keyboard {
            guard let destination = descriptor.destination, HelperLifecycle.processIdentity(destination.pid) == destination else { return false }
            if descriptor.kind == .keyDown || descriptor.kind == .unicodeDown {
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == destination.pid else { return false }
                let layout = try KeyboardSnapshot()
                source.keyboardType = layout.keyboardType
                generatedLayout = layout.fingerprint
                if descriptor.kind == .keyDown {
                    sourceLock.lock(); let expected = resolvedLayout; sourceLock.unlock()
                    guard let expected, layout.fingerprint == expected else { return false }
                }
            }
        } else if let destination = descriptor.destination, HelperLifecycle.processIdentity(destination.pid) != destination { return false }
        let event: CGEvent?
        let button: CGMouseButton = descriptor.button == 1 ? .right : descriptor.button == 2 ? .center : .left
        switch descriptor.kind {
        case .move:
            event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: descriptor.point, mouseButton: .left)
        case .drag:
            let type: CGEventType = descriptor.button == 1 ? .rightMouseDragged : descriptor.button == 2 ? .otherMouseDragged : .leftMouseDragged
            event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: descriptor.point, mouseButton: button)
        case .buttonDown, .buttonUp:
            let down = descriptor.kind == .buttonDown
            let type: CGEventType = descriptor.button == 1 ? (down ? .rightMouseDown : .rightMouseUp)
                : descriptor.button == 2 ? (down ? .otherMouseDown : .otherMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
            event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: descriptor.point, mouseButton: button)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(descriptor.clickCount))
        case .keyDown, .keyUp, .unicodeDown, .unicodeUp:
            let down = descriptor.kind == .keyDown || descriptor.kind == .unicodeDown
            event = CGEvent(keyboardEventSource: source, virtualKey: descriptor.keyCode, keyDown: down)
            event?.setIntegerValueField(.keyboardEventAutorepeat, value: 0)
            event?.setIntegerValueField(.keyboardEventKeyboardType, value: Int64(source.keyboardType))
            if descriptor.kind == .unicodeDown || descriptor.kind == .unicodeUp {
                guard !descriptor.unicode.isEmpty, Self.validUnicode(descriptor.unicode) else { return false }
                descriptor.unicode.withUnsafeBufferPointer { units in event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units.baseAddress!) }
            }
        case .scroll:
            guard abs(Int64(descriptor.dx)) <= 10000, abs(Int64(descriptor.dy)) <= 10000 else { return false }
            event = CGEvent(scrollWheelEvent2Source: source, units: descriptor.pixelScroll ? .pixel : .line,
                wheelCount: 2, wheel1: -descriptor.dy, wheel2: -descriptor.dx, wheel3: 0)
            event?.location = descriptor.point
        }
        guard let event else { return false }
        event.flags = CGEventFlags(rawValue: descriptor.flags)
        event.setIntegerValueField(.eventSourceUserData, value: Self.eventTag)
        if keyboard {
            guard let destination = descriptor.destination, HelperLifecycle.processIdentity(destination.pid) == destination else { return false }
            if descriptor.kind == .keyDown || descriptor.kind == .unicodeDown {
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == destination.pid,
                      let generatedLayout, let current = try? KeyboardSnapshot(), current.fingerprint == generatedLayout,
                      current.keyboardType == source.keyboardType else { return false }
                if descriptor.kind == .keyDown {
                    sourceLock.lock(); let expected = resolvedLayout; sourceLock.unlock()
                    guard expected == generatedLayout else { return false }
                }
            }
            guard recordDown(descriptor) else { return false }
            event.postToPid(destination.pid)
        } else {
            if let destination = descriptor.destination, HelperLifecycle.processIdentity(destination.pid) != destination { return false }
            if descriptor.kind != .buttonUp {
                sourceLock.lock(); let witness = pointerWitness; sourceLock.unlock()
                guard let witness, descriptor.point == witness.point, descriptor.destination == witness.process,
                      HelperLifecycle.processIdentity(witness.process.pid) == witness.process,
                      let current = try AccessibilityNative.windows().first(where: { $0.onScreen && $0.alpha > 0 && $0.bounds.contains(descriptor.point) && !witness.overlays.contains($0.windowID) }),
                      current.windowID == witness.window.windowID, current.pid == witness.window.pid,
                      current.bounds == witness.window.bounds, current.alpha == witness.window.alpha else { return false }
            }
            guard recordDown(descriptor) else { return false }
            event.post(tap: .cghidEventTap)
        }
        retireUp(descriptor)
        return true
    }

    private func release(_ descriptor: InputPostedEvent) -> InputReleaseOutcome {
        guard descriptor.tag == Self.eventTag, [.keyUp, .unicodeUp, .buttonUp].contains(descriptor.kind) else { return .discarded }
        guard let id = heldID(descriptor) else { return .discarded }
        sourceLock.lock(); let owned = ownedUps[id]; sourceLock.unlock()
        guard let owned, owned.kind == descriptor.kind, owned.keyCode == descriptor.keyCode,
              owned.tag == descriptor.tag, descriptor.kind == .buttonUp || owned.destination == descriptor.destination else { return .discarded }
        var release = descriptor
        if descriptor.kind == .buttonUp {
            // This journal owns a global button down; an original app exiting does not waive its matching up.
            release.destination = nil
        } else {
            guard let process = descriptor.destination else { return .discarded }
            guard HelperLifecycle.processIdentity(process.pid) == process else { retireUp(descriptor); return .discarded }
        }
        do { return try post(release, cleanup: true) ? .released : .retry } catch { return .retry }
    }

    private func heldID(_ event: InputPostedEvent) -> String? {
        if event.kind == .buttonDown || event.kind == .buttonUp { return "button:\(event.button)" }
        guard [.keyDown, .keyUp, .unicodeDown, .unicodeUp].contains(event.kind), let process = event.destination else { return nil }
        return "key:\(process.pid):\(process.parentPID):\(process.startSeconds):\(process.startMicroseconds):\(event.keyCode):\(process.executable)"
    }
    private func recordDown(_ event: InputPostedEvent) -> Bool {
        if event.kind == .drag {
            let id = "button:\(event.button)"
            sourceLock.lock(); defer { sourceLock.unlock() }
            guard var up = ownedUps[id] else { return false }
            up.point = event.point; ownedUps[id] = up
            return true
        }
        guard [.keyDown, .unicodeDown, .buttonDown].contains(event.kind), let id = heldID(event) else { return true }
        var up = event
        if event.kind == .buttonDown { up = InputPostedEvent(kind: .buttonUp); up.point = event.point; up.button = event.button; up.clickCount = event.clickCount }
        else if event.kind == .unicodeDown { up = InputPostedEvent(kind: .unicodeUp); up.unicode = event.unicode }
        else { up = InputPostedEvent(kind: .keyUp); up.keyCode = event.keyCode }
        up.destination = event.destination; up.flags = event.flags; up.tag = Self.eventTag
        if let flag = Self.modifierFlag(event.keyCode), event.kind == .keyDown { up.flags &= ~flag }
        sourceLock.lock(); defer { sourceLock.unlock() }
        guard ownedUps[id] == nil, ownedUps.count < 32 else { return false }
        ownedOrder.append(id)
        ownedUps[id] = up
        return true
    }
    private func retireUp(_ event: InputPostedEvent) {
        guard [.keyUp, .unicodeUp, .buttonUp].contains(event.kind), let id = heldID(event) else { return }
        sourceLock.lock(); defer { sourceLock.unlock() }
        if let stored = ownedUps[id], stored.kind != event.kind || stored.keyCode != event.keyCode || stored.tag != event.tag { return }
        ownedUps.removeValue(forKey: id); ownedOrder.removeAll { $0 == id }
        // Pointer flags belong to the DOM click through its matching up. Once every owned down is drained,
        // retire this source's synthetic state without sending unrelated modifier ups to another process.
        if ownedUps.isEmpty { privateSource = nil }
    }
    private func reconcile() {
        // Only descriptors proven to have originated at this retained private source may produce cleanup ups.
        sourceLock.lock(); let pending = ownedOrder.reversed().compactMap { ownedUps[$0] }; sourceLock.unlock()
        let deadline = DispatchTime.now().uptimeNanoseconds + 300_000_000
        for event in pending {
            if DispatchTime.now().uptimeNanoseconds >= deadline { break }
            let result = release(event)
            if case .discarded = result { retireUp(event) }
        }
        guard var source = self.source(), var sample = CGEvent(source: source) else {
            sourceLock.lock(); sourceReady = false; sourceLock.unlock(); return
        }
        // A new worker has no claim over a prior worker's source. Never synthesize ups from aggregate/user flags.
        sourceLock.lock(); let empty = ownedUps.isEmpty; sourceLock.unlock()
        if empty, sample.getIntegerValueField(.eventSourceUserData) == Self.eventTag,
           sample.flags.rawValue & Self.allowedFlags != 0 {
            // No app still has an owned pending release. Retire this worker's private source instead of
            // directing speculative modifier ups to a different or reused process.
            sourceLock.lock(); privateSource = nil; sourceLock.unlock()
            guard let fresh = self.source(), let state = CGEvent(source: fresh) else {
                sourceLock.lock(); sourceReady = false; sourceLock.unlock(); return
            }
            source = fresh; sample = state
        }
        sourceLock.lock()
        sourceReady = sample.getIntegerValueField(.eventSourceUserData) == Self.eventTag &&
            sample.flags.rawValue & Self.allowedFlags == 0 && ownedUps.isEmpty
        sourceLock.unlock()
    }
    private static func modifierFlag(_ code: UInt16) -> UInt64? {
        switch code {
        case 54, 55: return CGEventFlags.maskCommand.rawValue
        case 56, 60: return CGEventFlags.maskShift.rawValue
        case 58, 61: return CGEventFlags.maskAlternate.rawValue
        case 59, 62: return CGEventFlags.maskControl.rawValue
        case 63: return CGEventFlags.maskSecondaryFn.rawValue
        default: return nil
        }
    }

    private static var allowedFlags: UInt64 {
        CGEventFlags.maskShift.rawValue | CGEventFlags.maskControl.rawValue | CGEventFlags.maskAlternate.rawValue |
            CGEventFlags.maskCommand.rawValue | CGEventFlags.maskAlphaShift.rawValue | CGEventFlags.maskSecondaryFn.rawValue |
            CGEventFlags.maskNumericPad.rawValue
    }
    private func finite(_ point: CGPoint) -> Bool { point.x.isFinite && point.y.isFinite && abs(point.x) <= 1_000_000 && abs(point.y) <= 1_000_000 }
    private static func validUnicode(_ values: [UInt16]) -> Bool {
        var index = 0
        while index < values.count {
            if (0xD800...0xDBFF).contains(values[index]) {
                guard index + 1 < values.count, (0xDC00...0xDFFF).contains(values[index + 1]) else { return false }; index += 2
            } else {
                guard !(0xDC00...0xDFFF).contains(values[index]) else { return false }; index += 1
            }
        }
        return true
    }

    /// No OS state is read here: synthetic layout translators exercise the same chord construction.
    static func resolveCombo(_ combo: [String], layout: String? = nil,
                             resolve: (String, UInt64) -> (code: UInt16, flags: UInt64)?,
                             translate: (UInt16, UInt64) -> String?) throws -> InputChord {
        guard (1...8).contains(combo.count), combo.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 32 && MacAppIdentity.safeName($0) }) else { throw InputNative.unavailable }
        var modifiers: [InputKeyBinding] = []
        var ordinary: [String] = []
        var flags: UInt64 = 0
        for name in combo {
            if let modifier = modifier(name) {
                guard flags & modifier.flags == 0 else { throw InputNative.unavailable }
                flags |= modifier.flags; modifiers.append(InputKeyBinding(code: modifier.code, flags: modifier.flags, isModifier: true))
            } else { ordinary.append(name) }
        }
        var keys: [InputKeyBinding] = []
        var requirements: [UInt64] = []
        for name in ordinary {
            guard let binding = resolve(name, flags), !keys.contains(where: { $0.code == binding.code }) else { throw InputNative.unavailable }
            requirements.append(binding.flags & ~flags)
            keys.append(InputKeyBinding(code: binding.code, flags: binding.flags))
        }
        // A simultaneous multi-key chord cannot give different Shift/Option levels to individual keys.
        guard Set(requirements).count <= 1 else { throw InputNative.unavailable }
        let required = requirements.first ?? 0
        flags |= required
        for item in [(UInt16(56), CGEventFlags.maskShift.rawValue), (UInt16(58), CGEventFlags.maskAlternate.rawValue)] {
            if required & item.1 != 0 && !modifiers.contains(where: { $0.flags == item.1 }) {
                modifiers.append(InputKeyBinding(code: item.0, flags: item.1, isModifier: true))
            }
        }
        keys = keys.map { InputKeyBinding(code: $0.code, flags: flags) }
        var semantic = modifierNames(flags)
        for key in keys {
            if let named = semanticControl(key.code) { semantic.append(named); continue }
            let translationFlags = flags & ~CGEventFlags.maskControl.rawValue
            guard let value = translate(key.code, translationFlags), value.count == 1,
                  MacAppIdentity.safeName(value) else { throw InputNative.unavailable }
            semantic.append(value.utf8.count == 1 ? value.lowercased() : value)
        }
        return InputChord(keys: modifiers + keys, flags: flags, layout: layout, semanticKeys: semantic)
    }

    private static func modifier(_ name: String) -> (code: UInt16, flags: UInt64)? {
        switch name.lowercased() {
        case "cmd", "command", "meta", "metaleft", "super", "win", "windows", "os", "osleft", "⌘": return (55, CGEventFlags.maskCommand.rawValue)
        case "metaright", "osright": return (54, CGEventFlags.maskCommand.rawValue)
        case "ctrl", "control", "controlleft", "⌃": return (59, CGEventFlags.maskControl.rawValue)
        case "controlright": return (62, CGEventFlags.maskControl.rawValue)
        case "shift", "shiftleft", "⇧": return (56, CGEventFlags.maskShift.rawValue)
        case "shiftright": return (60, CGEventFlags.maskShift.rawValue)
        case "alt", "option", "opt", "altleft", "⌥": return (58, CGEventFlags.maskAlternate.rawValue)
        case "altright": return (61, CGEventFlags.maskAlternate.rawValue)
        case "fn": return (63, CGEventFlags.maskSecondaryFn.rawValue)
        default: return nil
        }
    }
    private static func modifierNames(_ flags: UInt64) -> [String] {
        [
            (CGEventFlags.maskCommand.rawValue, "cmd"), (CGEventFlags.maskControl.rawValue, "ctrl"),
            (CGEventFlags.maskShift.rawValue, "shift"), (CGEventFlags.maskAlternate.rawValue, "alt"),
            (CGEventFlags.maskSecondaryFn.rawValue, "fn"),
        ].compactMap { flags & $0.0 != 0 ? $0.1 : nil }
    }
    private static func semanticControl(_ code: UInt16) -> String? {
        let keys: [UInt16: String] = [36: "enter", 48: "tab", 49: "space", 51: "backspace", 53: "escape", 57: "capslock",
            63: "fn", 71: "numlock", 76: "enter", 114: "help", 115: "home", 116: "pageup", 117: "delete", 119: "end",
            121: "pagedown", 123: "arrowleft", 124: "arrowright", 125: "arrowdown", 126: "arrowup",
            122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6", 98: "f7", 100: "f8", 101: "f9",
            109: "f10", 103: "f11", 111: "f12", 105: "f13", 107: "f14", 113: "f15", 106: "f16", 64: "f17", 79: "f18", 80: "f19", 90: "f20"]
        return keys[code]
    }

    /// Current public wire shape has no Command-specific level. Such layouts are omitted rather than guessed.
    static func layoutWire() -> [String: JSONValue]? {
        guard let snapshot = try? KeyboardSnapshot(), snapshot.representable else { return nil }
        let physical = physicalKeys()
        var keys: [String: JSONValue] = [:]
        for name in physical.keys.sorted() {
            guard let code = physical[name] else { continue }
            if let control = semanticControl(code) {
                keys[name] = .object(["key": .string(control), "shift": .string(control), "altGraph": .string(control), "shiftAltGraph": .string(control)])
                continue
            }
            guard let base = snapshot.translate(code, 0), base.count == 1, MacAppIdentity.safeName(base) else { continue }
            guard snapshot.translate(code, CGEventFlags.maskCommand.rawValue) == base else { return nil }
            var levels: [String: JSONValue] = ["key": .string(base)]
            for item in [("shift", CGEventFlags.maskShift.rawValue), ("altGraph", CGEventFlags.maskAlternate.rawValue),
                         ("shiftAltGraph", CGEventFlags.maskShift.rawValue | CGEventFlags.maskAlternate.rawValue)] {
                if let value = snapshot.translate(code, item.1), value.count == 1, MacAppIdentity.safeName(value) { levels[item.0] = .string(value) }
            }
            keys[name] = .object(levels)
        }
        guard let current = try? KeyboardSnapshot(), current.fingerprint == snapshot.fingerprint else { return nil }
        return ["platform": .string("macos"), "keys": .object(keys)]
    }

    private static var unavailable: ServerFailure { ServerFailure(code: "unsupported_action", message: "This native input cannot be represented safely.") }
    private static var changed: ServerFailure { ServerFailure(code: "changed", message: "The native input target or keyboard layout changed.") }
    private static var stale: ServerFailure { ServerFailure(code: "stale_ref", message: "The native input element changed.") }

    private struct KeyboardSnapshot {
        let selected: TISInputSource
        let source: TISInputSource
        let data: CFData
        let keyboardType: UInt32
        let fingerprint: String

        init() throws {
            guard let selectedCopy = TISCopyCurrentKeyboardInputSource(),
                  let layoutCopy = TISCopyCurrentKeyboardLayoutInputSource() else { throw InputNative.unavailable }
            let selected = selectedCopy.takeRetainedValue(), source = layoutCopy.takeRetainedValue()
            guard let selectedID = InputNative.inputSourceString(selected, kTISPropertyInputSourceID),
                  let selectedType = InputNative.inputSourceString(selected, kTISPropertyInputSourceType),
                  let sourceID = InputNative.inputSourceString(source, kTISPropertyInputSourceID),
                  let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { throw InputNative.unavailable }
            let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
            guard CFGetTypeID(data) == CFDataGetTypeID(), CFDataGetLength(data) >= MemoryLayout<UCKeyboardLayout>.size,
                  CFDataGetLength(data) <= 1_048_576 else { throw InputNative.unavailable }
            let kind = UInt32(LMGetKbdType())
            let digest = SHA256.hash(data: data as Data).map { String(format: "%02x", $0) }.joined()
            self.selected = selected; self.source = source; self.data = data; keyboardType = kind
            let identity = try JSONEncoder().encode([selectedID, selectedType, sourceID, String(kind), digest])
            fingerprint = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
        }

        var representable: Bool {
            // A selected input method may compose a different character from its underlying keyboard table.
            InputNative.inputSourceString(selected, kTISPropertyInputSourceType) == (kTISTypeKeyboardLayout as String) &&
                InputNative.inputSourceString(selected, kTISPropertyInputSourceID) == InputNative.inputSourceString(source, kTISPropertyInputSourceID)
        }

        func translate(_ code: UInt16, _ flags: UInt64) -> String? {
            withExtendedLifetime((selected, source, data)) { () -> String? in
                guard let bytes = CFDataGetBytePtr(data), Int(bitPattern: bytes) % MemoryLayout<UCKeyboardLayout>.alignment == 0 else { return nil }
                let keyboard = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
                var dead: UInt32 = 0
                var length: Int = 0
                var characters = [UniChar](repeating: 0, count: 8)
                let status = characters.withUnsafeMutableBufferPointer { output in
                    UCKeyTranslate(keyboard, code, UInt16(kUCKeyActionDown), InputNative.carbonModifiers(flags), keyboardType,
                        OptionBits(1 << Int(kUCKeyTranslateNoDeadKeysBit)), &dead,
                        output.count, &length, output.baseAddress!)
                }
                guard status == noErr, length > 0, Int(length) <= characters.count, InputNative.validUnicode(Array(characters.prefix(Int(length)))) else { return nil }
                return String(decoding: characters.prefix(Int(length)), as: UTF16.self)
            }
        }
    }

    private static func inputSourceString(_ source: TISInputSource, _ property: CFString) -> String? {
        guard let raw = TISGetInputSourceProperty(source, property) else { return nil }
        let value = Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue()
        return AccessibilityNative.completeString(value, limit: 256)
    }

    /// Physical code aliases stay physical. Only a bare character uses reverse layout translation.
    static func resolveKey(_ name: String, flags: UInt64) -> (code: UInt16, flags: UInt64)? {
        guard let snapshot = try? KeyboardSnapshot(), snapshot.representable else { return nil }
        return resolveKey(name, flags: flags, translate: snapshot.translate)
    }

    static func resolveKey(_ name: String, flags: UInt64,
                           translate: (UInt16, UInt64) -> String?) -> (code: UInt16, flags: UInt64)? {
        if let named = namedKey(name) { return (named, flags) }
        return resolvePrintable(name, flags: flags, translate: translate)
    }

    /// Shared pure reverse-translation algorithm, also exercised with synthetic non-US tables.
    static func resolvePrintable(_ name: String, flags: UInt64,
                                 translate: (UInt16, UInt64) -> String?) -> (code: UInt16, flags: UInt64)? {
        let key = name
        guard key.count == 1, key.utf16.count <= 4,
              !key.unicodeScalars.contains(where: { $0.value < 0x20 || (0x7f...0x9f).contains($0.value) }) else { return nil }
        // Command can select a distinct layout layer (for example Dvorak-QWERTY Cmd). Shift/Option remain
        // explicit chord modifiers; layout-required modifiers are additionally retained for AZERTY digits.
        let command = flags & CGEventFlags.maskCommand.rawValue
        let shift = CGEventFlags.maskShift.rawValue, option = CGEventFlags.maskAlternate.rawValue
        for required in [UInt64(0), shift, option, shift | option] {
            for code in UInt16(0)...UInt16(127) {
                guard let value = translate(code, command | required) else { continue }
                let asciiLetter = key.utf8.count == 1 && key.unicodeScalars.allSatisfy { (65...90).contains($0.value) || (97...122).contains($0.value) }
                if value == key || (asciiLetter && value.lowercased() == key.lowercased()) {
                    return (code, flags | required)
                }
            }
        }
        return nil
    }

    private static func carbonModifiers(_ flags: UInt64) -> UInt32 {
        var value: UInt32 = 0
        if flags & CGEventFlags.maskShift.rawValue != 0 { value |= UInt32(shiftKey) }
        if flags & CGEventFlags.maskAlternate.rawValue != 0 { value |= UInt32(optionKey) }
        if flags & CGEventFlags.maskControl.rawValue != 0 { value |= UInt32(controlKey) }
        if flags & CGEventFlags.maskCommand.rawValue != 0 { value |= UInt32(cmdKey) }
        if flags & CGEventFlags.maskAlphaShift.rawValue != 0 { value |= UInt32(alphaLock) }
        return (value >> 8) & 0xff
    }

    private static func namedKey(_ name: String) -> UInt16? {
        let key = name.lowercased()
        let controls: [String: UInt16] = [
            "enter": 36, "return": 36, "tab": 48, "space": 49, "spacebar": 49,
            "backspace": 51, "delete": 51, "escape": 53, "esc": 53, "forwarddelete": 117, "del": 117,
            "home": 115, "end": 119, "pageup": 116, "pgup": 116, "pagedown": 121, "pgdn": 121,
            "arrowleft": 123, "left": 123, "arrowright": 124, "right": 124,
            "arrowdown": 125, "down": 125, "arrowup": 126, "up": 126, "help": 114, "insert": 114, "ins": 114,
            "capslock": 57, "fn": 63, "clear": 71, "numlock": 71,
            "numpadenter": 76, "numpaddecimal": 65, "numpadmultiply": 67, "numpadadd": 69,
            "numpaddivide": 75, "numpadsubtract": 78, "numpadequal": 81,
            "numpad0": 82, "numpad1": 83, "numpad2": 84, "numpad3": 85, "numpad4": 86,
            "numpad5": 87, "numpad6": 88, "numpad7": 89, "numpad8": 91, "numpad9": 92,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
            "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
            "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
        ]
        if let control = controls[key] { return control }
        return physicalKeys()[key]
    }

    private static func physicalKeys() -> [String: UInt16] {
        [
            "keya": 0, "keys": 1, "keyd": 2, "keyf": 3, "keyh": 4, "keyg": 5, "keyz": 6, "keyx": 7,
            "keyc": 8, "keyv": 9, "keyb": 11, "keyq": 12, "keyw": 13, "keye": 14, "keyr": 15, "keyy": 16,
            "keyt": 17, "keyo": 31, "keyu": 32, "keyi": 34, "keyp": 35, "keyl": 37, "keyj": 38,
            "keyk": 40, "keyn": 45, "keym": 46, "digit1": 18, "digit2": 19, "digit3": 20, "digit4": 21,
            "digit6": 22, "digit5": 23, "digit9": 25, "digit7": 26, "digit8": 28, "digit0": 29,
            "equal": 24, "minus": 27, "bracketright": 30, "bracketleft": 33, "quote": 39, "semicolon": 41,
            "backslash": 42, "comma": 43, "slash": 44, "period": 47, "backquote": 50,
            "numpadenter": 76, "numpaddecimal": 65, "numpadmultiply": 67, "numpadadd": 69,
            "numpaddivide": 75, "numpadsubtract": 78, "numpadequal": 81,
            "numpad0": 82, "numpad1": 83, "numpad2": 84, "numpad3": 85, "numpad4": 86,
            "numpad5": 87, "numpad6": 88, "numpad7": 89, "numpad8": 91, "numpad9": 92,
        ]
    }
}
