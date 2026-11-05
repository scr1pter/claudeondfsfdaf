import CoreGraphics
import Foundation

private struct AccessibilityRegistryTestFailure: Error { let message: String }

private func accessibilityRegistryCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw AccessibilityRegistryTestFailure(message: message) }
}

private func accessibilityRegistryThrows(_ code: String = "stale_ref", _ body: () throws -> Void) throws {
    do { try body() }
    catch let failure as ServerFailure {
        try accessibilityRegistryCheck(failure.code == code, "Expected \(code), received \(failure.code).")
        return
    }
    throw AccessibilityRegistryTestFailure(message: "Expected accessibility refusal \(code).")
}

private final class RegistryNativeElement {
    let bucket: UInt
    init(_ bucket: UInt = 1) { self.bucket = bucket }
}

private final class RegistryElement {
    let native: RegistryNativeElement
    let label: String
    init(_ native: RegistryNativeElement = RegistryNativeElement(), label: String = "Same visible label") {
        self.native = native
        self.label = label
    }
}

private func accessibilityTestRegistry(limit: Int = 4096, stableLimit: Int = 8192) -> AccessibilityRegistry<RegistryElement> {
    AccessibilityRegistry(limit: limit, stableLimit: stableLimit,
                          hash: { $0.native.bucket }, equal: { $0.native === $1.native })
}

private func accessibilityTestSession(id: String = "synthetic-accessibility") -> ServerSession {
    ServerSession(id: id, revision: 3, mode: "foreground", paused: false, approved: [],
                  vectorPids: [900], vectorWindowIds: ["vector"], overlayWindowIds: ["overlay"],
                  escStops: true, stopChord: "Command+Shift+Escape")
}

private func accessibilityTestWitness(
    pid: Int32 = 101, parent: Int32 = 100, start: UInt64 = 20, microseconds: UInt64 = 30,
    path: String = "/virtual/Test.app/Contents/MacOS/Test", window: String = "window-1",
    frame: CGRect = CGRect(x: -100, y: -50, width: 300, height: 200), space: String? = "space-a", onScreen: Bool = true
) -> AccessibilityWitness {
    AccessibilityWitness(process: HelperProcessIdentity(pid: pid, parentPID: parent, startSeconds: start,
                                                        startMicroseconds: microseconds, executable: path),
                         windowID: window, windowFrame: frame, onScreen: onScreen, spaceWitness: space)
}

/// Every element and process/window witness is injected; no AX call, native handle or OS observation occurs.
func runAccessibilityRegistryTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let element = RegistryElement()
        let snapshot = try registry.beginSnapshot(session: session)
        let record = try registry.register(element: element, witness: accessibilityTestWitness(), snapshot: snapshot)
        let resolved = try registry.resolve(record.ref, session: session, witness: accessibilityTestWitness())
        try accessibilityRegistryCheck(resolved.ref == record.ref && resolved.elementID == record.elementID &&
                                       resolved.generation == snapshot.generation && resolved.element === element,
                                       "Resolve must preserve the exact old ref, native handle and generation.")
        try accessibilityRegistryCheck(record.ref != record.elementID && record.ref.utf16.count <= 256 && record.elementID.utf16.count <= 256,
                                       "References and stable element identities must be separate bounded opaque IDs.")
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let element = RegistryElement()
        let first = try registry.currentSnapshot(session: session)
        let ref = try registry.register(element: element, witness: accessibilityTestWitness(), snapshot: first)
        let same = try registry.currentSnapshot(session: session)
        let duplicate = try registry.register(element: element, witness: accessibilityTestWitness(), snapshot: same)
        try accessibilityRegistryCheck(first.generation == same.generation && duplicate.ref == ref.ref,
                                       "Focused/hit observations must share current snapshot refs without minting replacements.")
        _ = try registry.resolve(ref.ref, session: session)
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let native = RegistryNativeElement()
        let first = try registry.beginSnapshot(session: session)
        let old = try registry.register(element: RegistryElement(native), witness: accessibilityTestWitness(), snapshot: first)
        let second = try registry.beginSnapshot(session: session)
        let fresh = try registry.register(element: RegistryElement(native, label: "Changed label"), witness: accessibilityTestWitness(), snapshot: second)
        try accessibilityRegistryCheck(second.generation > first.generation && old.ref != fresh.ref && old.elementID == fresh.elementID,
                                       "A new tree must retire refs while retaining actual native element identity independently of labels.")
        try accessibilityRegistryThrows { _ = try registry.resolve(old.ref, session: session) }
        try accessibilityRegistryThrows { _ = try registry.register(element: RegistryElement(native), witness: accessibilityTestWitness(), snapshot: first) }
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let snapshot = try registry.beginSnapshot(session: session)
        let a = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot)
        let b = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot)
        try accessibilityRegistryCheck(a.elementID != b.elementID && a.ref != b.ref,
                                       "Equal hash buckets and identical screen labels must not establish native element equality.")
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let native = RegistryNativeElement()
        let snapshot = try registry.beginSnapshot(session: session)
        let wrapper = RegistryElement(native)
        let old = try registry.register(element: wrapper, witness: accessibilityTestWitness(), snapshot: snapshot)
        let equivalent = try registry.register(element: RegistryElement(native, label: "Different wrapper"), witness: accessibilityTestWitness(), snapshot: snapshot)
        try accessibilityRegistryCheck(equivalent.ref == old.ref && equivalent.element === wrapper,
                                       "Native equality must reuse the original exact reference even through another wrapper.")
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let element = RegistryElement()
        let snapshot = try registry.beginSnapshot(session: session)
        let original = accessibilityTestWitness()
        let moved = accessibilityTestWitness(frame: original.windowFrame.offsetBy(dx: 10, dy: 0))
        let old = try registry.register(element: element, witness: original, snapshot: snapshot)
        let fresh = try registry.register(element: element, witness: moved, snapshot: snapshot)
        try accessibilityRegistryCheck(old.ref != fresh.ref && old.elementID == fresh.elementID,
                                       "A changed window witness needs a fresh ref while the same native element remains identifiable.")
        try accessibilityRegistryThrows { _ = try registry.resolve(old.ref, session: session, witness: moved) }
        let resolved = try registry.resolve(fresh.ref, session: session, witness: moved)
        try accessibilityRegistryCheck(resolved.ref == fresh.ref && resolved.witness == moved, "Fresh refs must retain their own window witness.")
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let snapshot = try registry.beginSnapshot(session: session)
        let ref = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot)
        for changed in [accessibilityTestWitness(pid: 102), accessibilityTestWitness(parent: 99),
                        accessibilityTestWitness(start: 21), accessibilityTestWitness(microseconds: 31),
                        accessibilityTestWitness(path: "/different/Test"), accessibilityTestWitness(window: "window-2"),
                        accessibilityTestWitness(frame: CGRect(x: -100, y: -50, width: 301, height: 200)),
                        accessibilityTestWitness(frame: CGRect(x: -99, y: -50, width: 300, height: 200)),
                        accessibilityTestWitness(space: "space-b"), accessibilityTestWitness(space: nil),
                        accessibilityTestWitness(onScreen: false)] {
            try accessibilityRegistryThrows { _ = try registry.resolve(ref.ref, session: session, witness: changed) }
        }
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let native = RegistryNativeElement()
        let snapshot = try registry.beginSnapshot(session: session)
        let original = try registry.register(element: RegistryElement(native), witness: accessibilityTestWitness(), snapshot: snapshot)
        for witness in [accessibilityTestWitness(start: 21), accessibilityTestWitness(path: "/different/Test"),
                        accessibilityTestWitness(window: "window-2")] {
            let changed = try registry.register(element: RegistryElement(native), witness: witness, snapshot: snapshot)
            try accessibilityRegistryCheck(changed.elementID != original.elementID,
                                           "A recycled process or different native window must never inherit a stable element ID.")
        }
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let old = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(),
                                        snapshot: registry.beginSnapshot(session: session))
        var changed = session
        changed.observationEpoch = UUID()
        try accessibilityRegistryThrows { _ = try registry.resolve(old.ref, session: changed) }
        let fresh = try registry.register(element: old.element, witness: old.witness,
                                          snapshot: registry.currentSnapshot(session: changed))
        try accessibilityRegistryCheck(old.elementID != fresh.elementID && old.generation < fresh.generation,
                                       "Same wire ID/revision with a fresh authority epoch must retire refs and stable IDs.")
        try accessibilityRegistryThrows { _ = try registry.resolve(old.ref, session: session) }
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let snapshot = try registry.beginSnapshot(session: session)
        let ref = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot)
        var changedRevision = session
        changedRevision.revision = 4
        var missingRevision = session
        missingRevision.revision = nil
        var other = accessibilityTestSession(id: "different-session")
        other.observationEpoch = session.observationEpoch
        for changed in [changedRevision, missingRevision, other] {
            try accessibilityRegistryThrows { _ = try registry.resolve(ref.ref, session: changed) }
        }
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let snapshot = try registry.beginSnapshot(session: session)
        let old = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot)
        let restarted = accessibilityTestRegistry()
        let next = try restarted.beginSnapshot(session: session)
        try accessibilityRegistryThrows { _ = try restarted.resolve(old.ref, session: session) }
        try accessibilityRegistryThrows { _ = try restarted.register(element: old.element, witness: old.witness, snapshot: snapshot) }
        let fresh = try restarted.register(element: old.element, witness: old.witness, snapshot: next)
        try accessibilityRegistryCheck(old.ref != fresh.ref && old.elementID != fresh.elementID,
                                       "A helper restart must never reuse references or element identities from another worker.")
    }
    try test {
        let registry = accessibilityTestRegistry(limit: 2, stableLimit: 2)
        let session = accessibilityTestSession()
        let snapshot = try registry.beginSnapshot(session: session)
        let element = RegistryElement()
        let first = try registry.register(element: element, witness: accessibilityTestWitness(), snapshot: snapshot)
        _ = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot)
        try accessibilityRegistryThrows("unavailable") { _ = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot) }
        let duplicate = try registry.register(element: element, witness: accessibilityTestWitness(), snapshot: snapshot)
        try accessibilityRegistryCheck(duplicate.ref == first.ref, "A duplicate native element remains readable at the reference cap.")
        _ = try registry.resolve(first.ref, session: session)
    }
    try test {
        let registry = accessibilityTestRegistry(limit: 2, stableLimit: 2)
        let session = accessibilityTestSession()
        let a = RegistryElement(), b = RegistryElement(), c = RegistryElement()
        let first = try registry.beginSnapshot(session: session)
        let oldA = try registry.register(element: a, witness: accessibilityTestWitness(), snapshot: first)
        let oldB = try registry.register(element: b, witness: accessibilityTestWitness(), snapshot: first)
        let second = try registry.beginSnapshot(session: session)
        let activeA = try registry.register(element: a, witness: accessibilityTestWitness(), snapshot: second)
        _ = try registry.register(element: c, witness: accessibilityTestWitness(), snapshot: second)
        try accessibilityRegistryCheck(activeA.elementID == oldA.elementID, "Stable-ID eviction must preserve IDs referenced in the active snapshot.")
        _ = try registry.resolve(activeA.ref, session: session)
        let third = try registry.beginSnapshot(session: session)
        let returnedB = try registry.register(element: b, witness: accessibilityTestWitness(), snapshot: third)
        try accessibilityRegistryCheck(returnedB.elementID != oldB.elementID, "An evicted stable identity must not be resurrected from old model text.")
    }
    try test {
        let registry = accessibilityTestRegistry(limit: 1, stableLimit: 1)
        let session = accessibilityTestSession()
        var element: RegistryElement? = RegistryElement()
        weak var retained = element
        _ = try registry.register(element: element!, witness: accessibilityTestWitness(),
                                  snapshot: registry.beginSnapshot(session: session))
        element = nil
        try accessibilityRegistryCheck(retained != nil, "Current native handles must be retained while their refs exist.")
        let next = try registry.beginSnapshot(session: session)
        _ = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: next)
        try accessibilityRegistryCheck(retained == nil, "Evicting old stable IDs must release the retained native handle.")
    }
    try test {
        let registry = accessibilityTestRegistry(limit: 0, stableLimit: 0)
        let session = accessibilityTestSession()
        let snapshot = try registry.beginSnapshot(session: session)
        _ = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot)
        try accessibilityRegistryThrows("unavailable") { _ = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot) }
        registry.clear()
        let fresh = try registry.currentSnapshot(session: session)
        try accessibilityRegistryCheck(fresh.generation > snapshot.generation, "Clearing must not recycle generation numbers.")
        try accessibilityRegistryThrows { _ = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot) }
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let element = RegistryElement()
        let snapshot = try registry.beginSnapshot(session: session)
        let old = try registry.register(element: element, witness: accessibilityTestWitness(), snapshot: snapshot)
        registry.clear()
        try accessibilityRegistryThrows { _ = try registry.resolve(old.ref, session: session) }
        let fresh = try registry.register(element: element, witness: old.witness, snapshot: registry.currentSnapshot(session: session))
        try accessibilityRegistryCheck(fresh.ref != old.ref && fresh.elementID != old.elementID,
                                       "Explicit session cleanup must retire both refs and stable native handles.")
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let snapshot = try registry.beginSnapshot(session: session)
        let ref = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot)
        registry.close()
        registry.close()
        registry.clear()
        try accessibilityRegistryThrows { _ = try registry.resolve(ref.ref, session: session) }
        try accessibilityRegistryThrows { _ = try registry.currentSnapshot(session: session) }
        try accessibilityRegistryThrows { _ = try registry.beginSnapshot(session: session) }
        try accessibilityRegistryThrows { _ = try registry.register(element: RegistryElement(), witness: accessibilityTestWitness(), snapshot: snapshot) }
    }
    try test {
        let registry = accessibilityTestRegistry()
        let session = accessibilityTestSession()
        let snapshot = try registry.beginSnapshot(session: session)
        for witness in [accessibilityTestWitness(pid: 0), accessibilityTestWitness(parent: 0),
                        accessibilityTestWitness(microseconds: 1_000_000), accessibilityTestWitness(path: "/virtual/../Test"),
                        accessibilityTestWitness(window: ""), accessibilityTestWitness(window: "bad\0id"),
                        accessibilityTestWitness(window: String(repeating: "w", count: 257)),
                        accessibilityTestWitness(frame: CGRect(x: 0, y: 0, width: 0, height: 100)),
                        accessibilityTestWitness(frame: CGRect(x: Double.nan, y: 0, width: 100, height: 100)),
                        accessibilityTestWitness(space: String(repeating: "s", count: 257))] {
            try accessibilityRegistryThrows { _ = try registry.register(element: RegistryElement(), witness: witness, snapshot: snapshot) }
        }
        try accessibilityRegistryThrows { _ = try registry.resolve("unknown", session: session) }
    }
    try test {
        var controls = ""
        let ranges: [ClosedRange<UInt32>] = [0...31, 0x7f...0x9f, 0x061c...0x061c,
                                           0x200b...0x200f, 0x2028...0x202e, 0x2060...0x2069, 0xfeff...0xfeff]
        for range in ranges {
            for value in range { controls.unicodeScalars.append(UnicodeScalar(value)!) }
        }
        try accessibilityRegistryCheck(AccessibilityContent.sanitize("before" + controls + "after") == "beforeafter",
                                       "Every control/bidi/zero-width scalar in the contract must be stripped.")
        try accessibilityRegistryCheck(AccessibilityContent.sanitize("café 日本語 😀\u{200a}") == "café 日本語 😀\u{200a}",
                                       "Ordinary international content and nonexcluded spacing must survive sanitization.")
    }
    try test {
        let text = AccessibilityContent.sanitize(String(repeating: "a", count: 700))
        try accessibilityRegistryCheck(text.utf16.count == 500, "Default AX strings must be capped at500 UTF-16 units.")
        try accessibilityRegistryCheck(AccessibilityContent.sanitize(String(repeating: "r", count: 100), limit: 64).utf16.count == 64,
                                       "Role/subrole fields must accept a tighter64-unit cap.")
        try accessibilityRegistryCheck(AccessibilityContent.sanitize("a\u{200b}bc\nxyz", limit: 3) == "abc",
                                       "Removed controls must not consume the returned content budget.")
        try accessibilityRegistryCheck(AccessibilityContent.sanitize("abc", limit: 0).isEmpty &&
                                       AccessibilityContent.sanitize("abc", limit: -1).isEmpty &&
                                       AccessibilityContent.sanitize(String(repeating: "a", count: 600), limit: 1000).utf16.count == 500,
                                       "Caller caps must remain nonnegative and cannot expand the native string limit.")
    }
    try test {
        let text = AccessibilityContent.sanitize(String(repeating: "😀", count: 300))
        try accessibilityRegistryCheck(text.utf16.count == 500 && text == String(repeating: "😀", count: 250),
                                       "Supplementary characters must be counted as two UTF-16 units.")
        try accessibilityRegistryCheck(AccessibilityContent.sanitize(String(repeating: "a", count: 499) + "😀") == String(repeating: "a", count: 499),
                                       "Capping must not leave an unpaired surrogate.")
        try accessibilityRegistryCheck(AccessibilityContent.sanitize("😀", limit: 1).isEmpty &&
                                       AccessibilityContent.sanitize("😀", limit: 2) == "😀", "Tiny caps must preserve complete Unicode scalars.")
    }
    try test {
        try accessibilityRegistryCheck(AccessibilityContent.value("private secret", secure: true, disclosure: .content) == "REDACTED" &&
                                       AccessibilityContent.value(nil, secure: true, disclosure: .content) == "REDACTED",
                                       "Secure values must always be redacted, including when the adapter correctly read no value.")
        try accessibilityRegistryCheck(AccessibilityContent.value("private secret", secure: false, disclosure: .structural) == nil &&
                                       AccessibilityContent.value("private secret", secure: true, disclosure: .structural) == nil,
                                       "Protected or unapproved structural observations must never disclose a value.")
        try accessibilityRegistryCheck(AccessibilityContent.value("safe\u{202e} text", secure: false, disclosure: .content) == "safe text" &&
                                       AccessibilityContent.value(nil, secure: false, disclosure: .content) == nil,
                                       "Only approved nonsecure values may be sanitized and returned.")
    }
    try test {
        let registry = accessibilityTestRegistry(limit: 1, stableLimit: 1)
        let session = accessibilityTestSession()
        let element = RegistryElement()
        let witness = accessibilityTestWitness()
        let first = try registry.register(element: element, witness: witness, snapshot: registry.beginSnapshot(session: session))
        let existing = try registry.resolveElement(first.elementID, session: session, witness: witness)
        try accessibilityRegistryCheck(existing.ref == first.ref && existing.element === element,
                                       "Element-only binding must preserve an existing exact ref and native handle.")
        try accessibilityRegistryThrows { _ = try registry.resolveElement(first.elementID, session: session, witness: accessibilityTestWitness(onScreen: false)) }
        var changed = session
        changed.observationEpoch = UUID()
        try accessibilityRegistryThrows { _ = try registry.resolveElement(first.elementID, session: changed, witness: witness) }
        let next = try registry.beginSnapshot(session: session)
        try accessibilityRegistryThrows { _ = try registry.resolveElement(first.elementID, session: session, witness: witness) }
        let fresh = try registry.register(element: element, witness: witness, snapshot: next)
        let current = try registry.resolveElement(first.elementID, session: session, witness: witness)
        try accessibilityRegistryCheck(current.ref == fresh.ref && current.ref != first.ref,
                                       "A stable element ID may bind only its latest already observed generation ref.")
        let last = try registry.beginSnapshot(session: session)
        _ = try registry.register(element: RegistryElement(), witness: witness, snapshot: last)
        try accessibilityRegistryThrows { _ = try registry.resolveElement(first.elementID, session: session, witness: witness) }
    }
    return count
}
