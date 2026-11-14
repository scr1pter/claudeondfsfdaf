import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Dispatch
import Foundation
import Security

/// Actual AX adapter. No function here requests trust, captures pixels, posts input, or activates another app.
enum AccessibilityNative {
    static func application(_ pid: pid_t) throws -> AccessibilityElement {
        guard pid > 0, let process = HelperLifecycle.processIdentity(pid) else { throw unavailable }
        let element = try wrap(AXUIElementCreateApplication(pid), expectedPID: pid)
        guard HelperLifecycle.processIdentity(pid) == process else { throw unavailable }
        return element
    }
    static func pid(_ element: AccessibilityElement) throws -> pid_t {
        let native = try handle(element); var result: pid_t = 0
        guard AXUIElementGetPid(native, &result) == .success, result > 0 else { throw unavailable }; return result
    }
    static func windows() throws -> [CaptureWindowInfo] {
        guard let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]], rows.count <= 4096 else { throw unavailable }
        var result: [CaptureWindowInfo] = []
        for row in rows {
            guard let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value, id > 0,
                  let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid > 0,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { throw unavailable }
            if rect.width == 0 || rect.height == 0 { continue }
            guard CapturePrivacy.valid(rect) else { throw unavailable }
            var window = CaptureWindowInfo(windowID: String(id), pid: pid, bounds: rect,
                onScreen: (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true, minimized: nil)
            window.alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            window.layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            guard window.alpha.isFinite, (0...1).contains(window.alpha) else { throw unavailable }
            result.append(window)
        }
        return result
    }
    static func describe(_ element: AccessibilityElement) throws -> AccessibilityAttributes { try describe(element, timeout: 0.05) }
    static func textDescribe(_ element: AccessibilityElement) throws -> AccessibilityAttributes { try describe(element, timeout: 0.002) }
    private static func describe(_ element: AccessibilityElement, timeout: Float) throws -> AccessibilityAttributes {
        let native = try handle(element)
        guard AXUIElementSetMessagingTimeout(native, timeout) == .success else { throw unavailable }
        let keys = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXPositionAttribute,
                    kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute] as CFArray
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(native, keys, [], &values) == .success,
              let values = values as? [AnyObject], values.count == 8,
              let role = token(values[0]) else { throw unavailable }
        let subrole: String?
        if CFGetTypeID(values[1]) == CFStringGetTypeID() {
            guard let value = token(values[1]) else { throw unavailable }; subrole = value
        }
        else {
            // An unsupported optional subrole is distinct from a failed security query.
            var raw: CFTypeRef?
            let error = AXUIElementCopyAttributeValue(native, kAXSubroleAttribute as CFString, &raw)
            guard error == .attributeUnsupported || error == .noValue else { throw unavailable }
            subrole = nil
        }
        guard CFGetTypeID(values[4]) == AXValueGetTypeID(), CFGetTypeID(values[5]) == AXValueGetTypeID(),
              AXValueGetType(values[4] as! AXValue) == .cgPoint, AXValueGetType(values[5] as! AXValue) == .cgSize else { throw unavailable }
        var position = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(values[4] as! AXValue, .cgPoint, &position), AXValueGetValue(values[5] as! AXValue, .cgSize, &size) else { throw unavailable }
        var editable = DarwinBoolean(false)
        let settable = AXUIElementIsAttributeSettable(native, kAXValueAttribute as CFString, &editable) == .success && editable.boolValue
        let rawName: CFTypeRef? = CFGetTypeID(values[2]) == CFStringGetTypeID() ? values[2] :
            CFGetTypeID(values[3]) == CFStringGetTypeID() ? values[3] : nil
        let complete = rawName.flatMap { completeString($0, limit: 500) } != nil
        return AccessibilityAttributes(role: role, subrole: subrole,
            name: rawName.flatMap { decodeString($0) } ?? "", bounds: CGRect(origin: position, size: size),
            enabled: boolean(values[6]) ?? false, focused: boolean(values[7]) ?? false, editable: settable, nameComplete: complete)
    }
    static func value(_ element: AccessibilityElement) throws -> String? {
        let native = try handle(element), process = try witness(native)
        guard try !secure(native) else { throw secureField }
        var raw: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(native, kAXValueAttribute as CFString, &raw)
        if result == .attributeUnsupported || result == .noValue { return nil }
        guard result == .success, let raw else { throw unavailable }
        let value = completeString(raw, limit: 4000)
        guard try !secure(native), HelperLifecycle.processIdentity(process.pid) == process else { throw secureField }
        return value
    }
    static func children(_ element: AccessibilityElement, _ limit: Int) throws -> AccessibilityChildren {
        let native = try handle(element)
        var role: CFTypeRef?
        guard AXUIElementCopyAttributeValue(native, kAXRoleAttribute as CFString, &role) == .success,
              let role, let name = token(role), limit >= 0, limit <= 400 else { throw unavailable }
        let key = name == "AXApplication" ? kAXWindowsAttribute : kAXChildrenAttribute
        var count: CFIndex = 0
        let result = AXUIElementGetAttributeValueCount(native, key as CFString, &count)
        if result == .attributeUnsupported || result == .noValue { return AccessibilityChildren(elements: []) }
        guard result == .success, count >= 0 else { throw unavailable }
        let number = min(count, max(0, limit))
        if number == 0 { return AccessibilityChildren(elements: [], truncated: count > 0) }
        var raw: CFArray?
        guard AXUIElementCopyAttributeValues(native, key as CFString, 0, number, &raw) == .success,
              let raw = raw as? [AnyObject], raw.count <= number else { throw unavailable }
        let handles = try raw.map { item -> AccessibilityElement in
            guard CFGetTypeID(item) == AXUIElementGetTypeID() else { throw unavailable }
            return try wrap(item as! AXUIElement, expectedPID: try pid(element))
        }
        return AccessibilityChildren(elements: handles, truncated: count > number)
    }
    static func hitTest(_ app: AccessibilityElement, _ point: CGPoint) throws -> AccessibilityElement {
        guard point.x.isFinite, point.y.isFinite, abs(point.x) <= 1_000_000, abs(point.y) <= 1_000_000 else { throw unavailable }
        let native = try handle(app), expected = try pid(app); var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(native, Float(point.x), Float(point.y), &element) == .success,
              let element else { throw unavailable }; return try wrap(element, expectedPID: expected)
    }
    static func focused(_ app: AccessibilityElement) throws -> AccessibilityElement { try focused(app, timeout: 0.05) }
    private static func focused(_ app: AccessibilityElement, timeout: Float) throws -> AccessibilityElement {
        let native = try handle(app)
        guard AXUIElementSetMessagingTimeout(native, timeout) == .success else { throw unavailable }
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(native, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
              let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { throw unavailable }
        // Return only the typed handle. The service verifies its actual PID and a hosted bridge before reading content.
        return try wrap(raw as! AXUIElement)
    }
    static func menuRoot(_ app: AccessibilityElement) throws -> AccessibilityElement? {
        let native = try handle(app), process = try witness(native)
        guard AXUIElementSetMessagingTimeout(native, 0.005) == .success else { throw unavailable }
        var raw: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(native, kAXMenuBarAttribute as CFString, &raw)
        if result == .attributeUnsupported || result == .noValue { return nil }
        guard result == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID(),
              HelperLifecycle.processIdentity(process.pid) == process else { throw unavailable }
        return try wrap(raw as! AXUIElement, expectedPID: process.pid)
    }
    static func menuParent(_ element: AccessibilityElement) throws -> AccessibilityElement? {
        let native = try handle(element), process = try witness(native)
        guard AXUIElementSetMessagingTimeout(native, 0.005) == .success else { throw unavailable }
        var raw: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(native, kAXParentAttribute as CFString, &raw)
        if result == .attributeUnsupported || result == .noValue { return nil }
        guard result == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID(),
              HelperLifecycle.processIdentity(process.pid) == process else { throw unavailable }
        return try wrap(raw as! AXUIElement, expectedPID: process.pid)
    }
    static func menuPerform(_ element: AccessibilityElement, _ action: String) throws -> Bool {
        let native = try handle(element)
        guard AXUIElementSetMessagingTimeout(native, 0.005) == .success else { throw unavailable }
        let result = AXUIElementPerformAction(native, action as CFString)
        if result == .actionUnsupported { return false }
        guard result == .success else { throw unavailable }; return true
    }
    static func menuDescribe(_ element: AccessibilityElement) throws -> AccessibilityMenuAttributes {
        let native = try handle(element), process = try witness(native)
        guard AXUIElementSetMessagingTimeout(native, 0.005) == .success else { throw unavailable }
        let keys = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                    kAXEnabledAttribute, kAXFocusedAttribute, kAXPositionAttribute, kAXSizeAttribute,
                    kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute, kAXMenuItemCmdVirtualKeyAttribute, kAXMenuItemCmdGlyphAttribute] as CFArray
        var raw: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(native, keys, [], &raw) == .success,
              let values = raw as? [AnyObject], values.count == 12, let role = token(values[0]) else { throw unavailable }
        let subrole: String?
        if CFGetTypeID(values[1]) == CFStringGetTypeID() {
            guard let value = token(values[1]) else { throw unavailable }; subrole = value
        } else {
            var optional: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(native, kAXSubroleAttribute as CFString, &optional)
            guard result == .attributeUnsupported || result == .noValue else { throw unavailable }; subrole = nil
        }
        let name: String
        if let title = completeString(values[2], limit: 256) { name = title }
        else {
            guard role != "AXMenuItem", role != "AXMenuBarItem" else { throw unavailable }
            name = completeString(values[3], limit: 256) ?? ""
        }
        var bounds: CGRect?
        if CFGetTypeID(values[6]) == AXValueGetTypeID(), CFGetTypeID(values[7]) == AXValueGetTypeID(),
           AXValueGetType(values[6] as! AXValue) == .cgPoint, AXValueGetType(values[7] as! AXValue) == .cgSize {
            var point = CGPoint.zero, size = CGSize.zero
            guard AXValueGetValue(values[6] as! AXValue, .cgPoint, &point), AXValueGetValue(values[7] as! AXValue, .cgSize, &size) else { throw unavailable }
            let actual = CGRect(origin: point, size: size)
            guard AccessibilityMenuScope.validBounds(actual) else { throw unavailable }; bounds = actual
        }
        var editable = DarwinBoolean(false)
        let settable = AXUIElementIsAttributeSettable(native, kAXValueAttribute as CFString, &editable) == .success && editable.boolValue
        guard HelperLifecycle.processIdentity(process.pid) == process else { throw unavailable }
        let shortcut = role == "AXMenuItem"
            ? decodeMenuShortcut(character: values[8], modifiers: values[9], virtualKey: values[10], glyph: values[11])
            : (shortcut: Optional<[String]>.none, complete: true)
        return AccessibilityMenuAttributes(role: role, subrole: subrole, name: name, bounds: bounds,
            enabled: boolean(values[4]) ?? false, focused: boolean(values[5]) ?? false, editable: settable,
            menuShortcut: shortcut.shortcut, shortcutComplete: shortcut.complete)
    }
    static func decodeMenuShortcut(character: CFTypeRef, modifiers: CFTypeRef, virtualKey: CFTypeRef,
                                   glyph: CFTypeRef) -> (shortcut: [String]?, complete: Bool) {
        func number(_ raw: CFTypeRef, _ maximum: Int) -> Int? {
            guard CFGetTypeID(raw) == CFNumberGetTypeID(), let value = raw as? NSNumber,
                  value.doubleValue.isFinite, value.doubleValue >= 0, value.doubleValue <= Double(maximum),
                  value.doubleValue.rounded() == value.doubleValue else { return nil }
            return value.intValue
        }
        func noValue(_ raw: CFTypeRef) -> Bool {
            guard CFGetTypeID(raw) == AXValueGetTypeID(), AXValueGetType(raw as! AXValue) == .axError else { return false }
            var error = AXError.success
            return AXValueGetValue(raw as! AXValue, .axError, &error) && error == .noValue
        }
        let observed = completeString(character, limit: 32)
        if (observed == "" || noValue(character)), noValue(virtualKey), (noValue(glyph) || number(glyph, 65535) == 0) {
            return (nil, true)
        }
        guard let flags = number(modifiers, 15) else { return (nil, false) }
        let key: String?
        if let observed, !observed.isEmpty {
            let controls = ["\r": "enter", "\n": "enter", "\t": "tab", "\u{1b}": "escape", " ": "space", "\u{7f}": "backspace"]
            if let control = controls[observed] { key = control }
            else if observed.count == 1, MacAppIdentity.safeName(observed) {
                key = observed.utf8.count == 1 ? observed.lowercased() : observed
            } else { return (nil, false) }
        } else if let code = number(virtualKey, 127) { key = InputNative.menuKeyName(UInt16(code)) }
        else { key = nil }
        guard let key else { return (nil, false) }
        var combo: [String] = []
        if flags & 8 == 0 { combo.append("cmd") }
        if flags & 1 != 0 { combo.append("shift") }
        if flags & 2 != 0 { combo.append("alt") }
        if flags & 4 != 0 { combo.append("ctrl") }
        combo.append(key)
        return (combo, true)
    }
    static func containingWindow(_ element: AccessibilityElement) throws -> AccessibilityElement? { try containingWindow(element, timeout: 0.05) }
    private static func containingWindow(_ element: AccessibilityElement, timeout: Float) throws -> AccessibilityElement? {
        let native = try handle(element), process = try witness(native)
        guard AXUIElementSetMessagingTimeout(native, timeout) == .success else { throw unavailable }
        var raw: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(native, kAXWindowAttribute as CFString, &raw)
        if result == .attributeUnsupported || result == .noValue {
            var role: CFTypeRef?
            guard AXUIElementCopyAttributeValue(native, kAXRoleAttribute as CFString, &role) == .success,
                  let role, token(role) == "AXWindow", HelperLifecycle.processIdentity(process.pid) == process else { return nil }
            return element
        }
        guard result == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID(),
              HelperLifecycle.processIdentity(process.pid) == process else { throw unavailable }
        return try wrap(raw as! AXUIElement, expectedPID: process.pid)
    }
    static func perform(_ element: AccessibilityElement, _ action: String) throws -> Bool {
        let result = AXUIElementPerformAction(try handle(element), action as CFString)
        if result == .actionUnsupported { return false }
        guard result == .success else { throw unavailable }; return true
    }
    static func setValue(_ element: AccessibilityElement, _ value: String) throws -> Bool { try setValue(element, value, timeout: 0.05) }
    private static func setValue(_ element: AccessibilityElement, _ value: String, timeout: Float) throws -> Bool {
        guard value.utf16.count <= 4000 else { throw unavailable }
        let native = try handle(element)
        guard AXUIElementSetMessagingTimeout(native, timeout) == .success else { throw unavailable }
        guard try !secure(native) else { throw secureField }
        let result = AXUIElementSetAttributeValue(native, kAXValueAttribute as CFString, value as CFString)
        if result == .attributeUnsupported || result == .notImplemented { return false }
        guard result == .success else { throw unavailable }; return true
    }
    static func document(_ element: AccessibilityElement) throws -> String? { try document(element, timeout: 0.05) }
    private static func document(_ element: AccessibilityElement, timeout: Float) throws -> String? {
        let native = try handle(element), process = try witness(native)
        guard AXUIElementSetMessagingTimeout(native, timeout) == .success else { throw unavailable }
        var raw: CFTypeRef?
        var result = AXUIElementCopyAttributeValue(native, kAXDocumentAttribute as CFString, &raw)
        if result == .attributeUnsupported || result == .noValue {
            guard let window = try containingWindow(element, timeout: timeout), !AccessibilityElement.equivalent(element, window) else { return nil }
            let parent = try handle(window)
            guard AXUIElementSetMessagingTimeout(parent, timeout) == .success else { throw unavailable }
            result = AXUIElementCopyAttributeValue(parent, kAXDocumentAttribute as CFString, &raw)
        }
        if result == .attributeUnsupported || result == .noValue { return nil }
        guard result == .success, let raw, let url = documentURL(raw),
              HelperLifecycle.processIdentity(process.pid) == process, let resolved = realpath(url.path, nil) else { return nil }
        defer { free(resolved) }
        let path = String(cString: resolved)
        return HelperLifecycle.processIdentity(process.pid) == process && MacAppIdentity.canonicalPathShape(path) ? path : nil
    }
    static var textBackend: AccessibilityTextBackend {
        AccessibilityTextBackend(attributes: textDescribe, state: textState,
            focused: { try focused($0, timeout: 0.002) }, window: { try containingWindow($0, timeout: 0.002) },
            bounds: textBounds, document: { try document($0, timeout: 0.002) },
            setValue: { try setValue($0, $1, timeout: 0.002) }, setSelection: textSetSelection)
    }
    private static func textBounds(_ element: AccessibilityElement) throws -> CGRect {
        let native = try handle(element), process = try witness(native)
        guard AXUIElementSetMessagingTimeout(native, 0.002) == .success else { throw unavailable }
        var raw: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(native, [kAXRoleAttribute, kAXPositionAttribute, kAXSizeAttribute] as CFArray, [], &raw) == .success,
              let values = raw as? [AnyObject], values.count == 3, token(values[0]) == "AXWindow",
              CFGetTypeID(values[1]) == AXValueGetTypeID(), CFGetTypeID(values[2]) == AXValueGetTypeID(),
              AXValueGetType(values[1] as! AXValue) == .cgPoint, AXValueGetType(values[2] as! AXValue) == .cgSize else { throw unavailable }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(values[1] as! AXValue, .cgPoint, &point), AXValueGetValue(values[2] as! AXValue, .cgSize, &size),
              HelperLifecycle.processIdentity(process.pid) == process else { throw unavailable }
        let bounds = CGRect(origin: point, size: size)
        guard CapturePrivacy.valid(bounds) else { throw unavailable }; return bounds
    }
    private static func textState(_ element: AccessibilityElement) throws -> AccessibilityTextState? {
        let native = try handle(element), process = try witness(native)
        guard AXUIElementSetMessagingTimeout(native, 0.002) == .success else { throw unavailable }
        guard try !secure(native) else { throw secureField }
        var raw: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(native, [kAXValueAttribute, kAXSelectedTextRangeAttribute] as CFArray, [], &raw) == .success,
              let values = raw as? [AnyObject], values.count == 2,
              CFGetTypeID(values[0]) == CFStringGetTypeID(), CFGetTypeID(values[1]) == AXValueGetTypeID(),
              AXValueGetType(values[1] as! AXValue) == .cfRange else { return nil }
        let string = values[0] as! CFString, count = CFStringGetLength(string)
        guard count >= 0, count <= 4000 else { return nil }
        var units = [UInt16](repeating: 0, count: count)
        if count > 0 { units.withUnsafeMutableBufferPointer { CFStringGetCharacters(string, CFRange(location: 0, length: count), $0.baseAddress!) } }
        guard AccessibilityTextEdit.validUnicode(units) else { return nil }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(values[1] as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0,
              range.location <= count, range.length <= count - range.location else { return nil }
        var valueSettable = DarwinBoolean(false), rangeSettable = DarwinBoolean(false)
        let first = AXUIElementIsAttributeSettable(native, kAXValueAttribute as CFString, &valueSettable)
        let second = AXUIElementIsAttributeSettable(native, kAXSelectedTextRangeAttribute as CFString, &rangeSettable)
        guard try !secure(native), HelperLifecycle.processIdentity(process.pid) == process else { throw secureField }
        return AccessibilityTextState(value: String(decoding: units, as: UTF16.self),
            selection: AccessibilitySelection(location: range.location, length: range.length),
            valueSettable: first == .success && valueSettable.boolValue,
            selectionSettable: second == .success && rangeSettable.boolValue)
    }
    private static func textSetSelection(_ element: AccessibilityElement, _ selection: AccessibilitySelection) throws -> Bool {
        guard selection.location >= 0, selection.location <= 4000, selection.length >= 0,
              selection.length <= 4000 - selection.location else { throw unavailable }
        let native = try handle(element)
        guard AXUIElementSetMessagingTimeout(native, 0.002) == .success else { throw unavailable }
        guard try !secure(native) else { throw secureField }
        var range = CFRange(location: selection.location, length: selection.length)
        guard let value = AXValueCreate(.cfRange, &range) else { throw unavailable }
        let result = AXUIElementSetAttributeValue(native, kAXSelectedTextRangeAttribute as CFString, value)
        if result == .attributeUnsupported || result == .notImplemented { return false }
        guard result == .success else { throw unavailable }; return true
    }

    static func prepareWake(_ app: AccessibilityElement, _ owner: NativeOwner) throws -> AccessibilityWake? {
        guard owner.identity.verified, let team = owner.identity.teamId,
              let running = NSRunningApplication(processIdentifier: owner.process.pid),
              let root = running.bundleURL,
              let framework = Bundle(url: root.appendingPathComponent("Contents/Frameworks/Electron Framework.framework")),
              framework.bundleIdentifier == "com.github.Electron.framework", let executable = framework.executableURL,
              let path = canonical(executable.path), frameworkSigned(path: path, team: team), mapped(path: path, process: owner.process),
              HelperLifecycle.processIdentity(owner.process.pid) == owner.process else { return nil }
        let native = try handle(app); guard try pid(app) == owner.process.pid else { throw unavailable }
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(native, "AXManualAccessibility" as CFString, &settable) == .success,
              settable.boolValue else { return nil }
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(native, "AXManualAccessibility" as CFString, &raw) == .success,
              let raw, boolean(raw) == false else { return nil }
        let state = WakeState(native: native, process: owner.process)
        return AccessibilityWake(apply: state.apply, restore: state.restore, restoreVerified: state.restoreVerified)
    }
    private static func handle(_ element: AccessibilityElement) throws -> AXUIElement {
        guard let native = element.native, CFGetTypeID(native) == AXUIElementGetTypeID(),
              AXUIElementSetMessagingTimeout(native, 0.05) == .success else { throw unavailable }; return native
    }
    private static func wrap(_ native: AXUIElement, expectedPID: pid_t? = nil) throws -> AccessibilityElement {
        let element = AccessibilityElement(native: native); _ = try handle(element)
        if let expectedPID, try pid(element) != expectedPID { throw unavailable }
        return element
    }
    /// `complete` is required for path proof and write verification; a prefix can never stand for a full value.
    static func decodeString(_ raw: CFTypeRef, limit: Int = 500, complete: Bool = false) -> String? {
        guard CFGetTypeID(raw) == CFStringGetTypeID() else { return nil }
        let text = raw as! CFString
        let length = CFStringGetLength(text)
        guard limit >= 0, length >= 0, !complete || length <= limit else { return nil }
        var count = min(length, limit)
        if count > 0 && count < length {
            let last = CFStringGetCharacterAtIndex(text, count - 1), next = CFStringGetCharacterAtIndex(text, count)
            if (0xD800...0xDBFF).contains(last) && (0xDC00...0xDFFF).contains(next) { count -= 1 }
        }
        guard count >= 0, let prefix = CFStringCreateWithSubstring(nil, text, CFRange(location: 0, length: count)) else { return nil }
        return prefix as String
    }
    static func completeString(_ raw: CFTypeRef, limit: Int) -> String? { decodeString(raw, limit: limit, complete: true) }
    static func documentURL(_ raw: CFTypeRef) -> URL? {
        let string: String?
        if CFGetTypeID(raw) == CFURLGetTypeID() { string = completeString(CFURLGetString(raw as! CFURL), limit: 4096) }
        else { string = completeString(raw, limit: 4096) }
        // Reject encoded NUL before relying on Foundation's platform-dependent filesystem path conversion.
        guard let string, !string.contains("\0"), !string.contains("%00"), let url = URL(string: string), url.isFileURL,
              url.query == nil, url.fragment == nil, !url.path.contains("\0"), url.path.hasPrefix("/"),
              url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
        return url
    }
    private static func token(_ raw: CFTypeRef) -> String? {
        guard let value = decodeString(raw, limit: 64, complete: true), value.hasPrefix("AX"), value.count > 2,
              value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 }) else { return nil }
        return value
    }
    private static func witness(_ element: AXUIElement) throws -> HelperProcessIdentity {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, let process = HelperLifecycle.processIdentity(pid) else { throw unavailable }
        return process
    }
    private static func secure(_ element: AXUIElement) throws -> Bool {
        let process = try witness(element)
        var role: CFTypeRef?, subrole: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
              let role, let name = token(role) else { throw unavailable }
        let result = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
        let value: String?
        if result == .attributeUnsupported || result == .noValue { value = nil }
        else { guard result == .success, let subrole, let name = token(subrole) else { throw unavailable }; value = name }
        guard HelperLifecycle.processIdentity(process.pid) == process else { throw unavailable }
        return NativeIdentityReader.isSecure(role: name, subrole: value)
    }
    private static func canonical(_ path: String) -> String? {
        guard MacAppIdentity.canonicalPathShape(path), let value = realpath(path, nil) else { return nil }
        defer { free(value) }; return String(cString: value)
    }
    private static func frameworkSigned(path: String, team: String) -> Bool {
        guard MacAppIdentity.validTeam(team) else { return false }
        var code: SecStaticCode?, requirement: SecRequirement?, information: CFDictionary?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString("identifier \"com.github.Electron.framework\"" as CFString, [], &requirement) == errSecSuccess,
              let requirement, SecStaticCodeCheckValidity(code, [.noNetworkAccess], requirement) == errSecSuccess,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let information else { return false }
        let fields = information as NSDictionary
        let flags = SecCodeSignatureFlags(rawValue: (fields[kSecCodeInfoFlags] as? NSNumber)?.uint32Value ?? 0)
        return !flags.contains(.adhoc) && fields[kSecCodeInfoIdentifier] as? String == "com.github.Electron.framework" &&
            fields[kSecCodeInfoTeamIdentifier] as? String == team
    }
    /// Region paths prove that the selected process actually mapped this framework. No memory is read.
    private static func mapped(path: String, process: HelperProcessIdentity) -> Bool {
        guard HelperLifecycle.processIdentity(process.pid) == process else { return false }
        let deadline = DispatchTime.now().uptimeNanoseconds + 50_000_000
        var address: UInt64 = 0
        for _ in 0..<512 {
            guard DispatchTime.now().uptimeNanoseconds < deadline else { return false }
            var region = proc_regionwithpathinfo()
            let capacity = Int32(MemoryLayout<proc_regionwithpathinfo>.size)
            guard proc_pidinfo(process.pid, PROC_PIDREGIONPATHINFO, address, &region, capacity) == capacity else { return false }
            let name = withUnsafeBytes(of: region.prp_vip.vip_path) { bytes -> String? in
                guard let end = bytes.firstIndex(of: 0), end > 0 else { return nil }
                return String(bytes: bytes[..<end], encoding: .utf8)
            }
            if let name, name == path { return HelperLifecycle.processIdentity(process.pid) == process }
            let next = region.prp_prinfo.pri_address.addingReportingOverflow(region.prp_prinfo.pri_size)
            guard !next.overflow, next.partialValue > address else { return false }
            address = next.partialValue
        }
        return false
    }
    private final class WakeState {
        private let lock = NSLock()
        private let native: AXUIElement
        private let process: HelperProcessIdentity
        private var attempted = false
        private var applied = false
        private var restored = false

        init(native: AXUIElement, process: HelperProcessIdentity) { self.native = native; self.process = process }

        private func current() -> Bool {
            var pid: pid_t = 0
            return HelperLifecycle.processIdentity(process.pid) == process &&
                AXUIElementGetPid(native, &pid) == .success && pid == process.pid &&
                AXUIElementSetMessagingTimeout(native, 0.02) == .success
        }

        func apply() -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard !restored, current() else { return false }
            if attempted { return applied }
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(native, "AXManualAccessibility" as CFString, &raw) == .success,
                  let raw, AccessibilityNative.boolean(raw) == false, current() else { return false }
            // An AX timeout can still have applied the write. The installed restoration owns this attempt first.
            attempted = true
            applied = AXUIElementSetAttributeValue(native, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
            return applied
        }

        func restore() { _ = restoreVerified() }
        func restoreVerified() -> Bool {
            lock.lock(); defer { lock.unlock() }
            if restored { return true }
            if !attempted { restored = true; return true }
            if HelperLifecycle.processIdentity(process.pid) != process { restored = true; return true }
            guard current() else { return false }
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(native, "AXManualAccessibility" as CFString, &raw) == .success,
                  let raw, let original = AccessibilityNative.boolean(raw), current() else { return false }
            if !original { restored = true; return true }
            _ = AXUIElementSetAttributeValue(native, "AXManualAccessibility" as CFString, kCFBooleanFalse)
            guard current() else {
                if HelperLifecycle.processIdentity(process.pid) != process { restored = true; return true }
                return false
            }
            var verified: CFTypeRef?
            guard AXUIElementCopyAttributeValue(native, "AXManualAccessibility" as CFString, &verified) == .success,
                  let verified, AccessibilityNative.boolean(verified) == false, current() else { return false }
            restored = true; return true
        }
    }
    private static func boolean(_ raw: CFTypeRef) -> Bool? {
        guard CFGetTypeID(raw) == CFBooleanGetTypeID() else { return nil }; return CFBooleanGetValue(raw as! CFBoolean)
    }
    private static var unavailable: ServerFailure { ServerFailure(code: "unavailable", message: "The native accessibility query failed.") }
    private static var secureField: ServerFailure { ServerFailure(code: "secure_field", message: "The native field cannot expose text.") }
}
