import CoreGraphics
import Foundation

struct AccessibilityWitness: Equatable {
    let process: HelperProcessIdentity
    let windowID: String?
    let windowFrame: CGRect?
    let onScreen: Bool?
    let spaceWitness: String?
    let hosted: HostedWindowProof?
    let menu: AccessibilityMenuWitness?

    init(process: HelperProcessIdentity, windowID: String, windowFrame: CGRect,
         onScreen: Bool = true, spaceWitness: String? = nil, hosted: HostedWindowProof? = nil) {
        self.process = process; self.windowID = windowID; self.windowFrame = windowFrame
        self.onScreen = onScreen; self.spaceWitness = spaceWitness; self.hosted = hosted; menu = nil
    }
    init(process: HelperProcessIdentity, menu: AccessibilityMenuWitness) {
        self.process = process; self.menu = menu
        windowID = nil; windowFrame = nil; onScreen = nil; spaceWitness = nil; hosted = nil
    }
    fileprivate var valid: Bool {
        guard process.pid > 0, process.parentPID > 0, process.startMicroseconds < 1_000_000,
              MacAppIdentity.canonicalPathShape(process.executable) else { return false }
        if let menu { return windowID == nil && windowFrame == nil && onScreen == nil && spaceWitness == nil && hosted == nil && menu.valid }
        guard let windowID, let windowFrame, let onScreen else { return false }
        return !windowID.isEmpty && windowID.utf8.count <= 256 && !windowID.contains("\0") &&
            windowFrame.minX.isFinite && windowFrame.minY.isFinite && windowFrame.width.isFinite && windowFrame.height.isFinite &&
            windowFrame.width > 0 && windowFrame.height > 0 && windowFrame.maxX.isFinite && windowFrame.maxY.isFinite &&
            (spaceWitness.map { !$0.isEmpty && $0.utf8.count <= 256 && !$0.contains("\0") } ?? true) &&
            (hosted.map { $0.physicalOwner.process == process && $0.surface.windowID == windowID &&
                $0.surface.bounds == windowFrame && $0.surface.onScreen == onScreen && $0.surface.spaceWitness == spaceWitness } ?? true)
    }
    fileprivate func matches(_ snapshot: AccessibilitySnapshot) -> Bool {
        if let menu { return menu.runEpoch == snapshot.runEpoch }
        return hosted.map { $0.observationEpoch == snapshot.observationEpoch &&
            $0.sessionID.utf8.elementsEqual(snapshot.sessionID.utf8) && $0.phaseRevision == snapshot.phaseRevision } ?? true
    }
}

struct AccessibilityReceiptFacts: Equatable {
    let role: String
    var subrole: String? = nil
    let name: String
    let secure: Bool
    var enabled = true
    var editable = false
    var document: String? = nil
    var documentStatus = "unknown"
    var owner: MacAppIdentity? = nil
    var nameComplete = true
    var menuShortcut: [String]? = nil
    var menuShortcutComplete = true

    var complete: Bool {
        nameComplete && menuShortcutComplete && (menuShortcut.map { !$0.isEmpty && $0.count <= 8 && $0.allSatisfy { !$0.isEmpty && $0.utf16.count <= 32 && MacAppIdentity.safeName($0) } } ?? true) && !role.isEmpty && role.utf16.count <= 64 && name.utf16.count <= 500 &&
            (subrole.map({ $0.utf16.count <= 64 }) ?? true) &&
            ["unknown", "known", "none"].contains(documentStatus) &&
            (documentStatus == "known" ? document.map(MacAppIdentity.canonicalPathShape) == true : document == nil)
    }
    static func == (a: AccessibilityReceiptFacts, b: AccessibilityReceiptFacts) -> Bool {
        same(a.role, b.role) && same(a.subrole, b.subrole) && same(a.name, b.name) && a.secure == b.secure &&
            a.enabled == b.enabled && a.editable == b.editable && same(a.document, b.document) &&
            a.documentStatus == b.documentStatus && a.nameComplete == b.nameComplete &&
            a.menuShortcutComplete == b.menuShortcutComplete && sameShortcut(a.menuShortcut, b.menuShortcut) && sameOwner(a.owner, b.owner)
    }
    private static func same(_ a: String?, _ b: String?) -> Bool {
        switch (a, b) { case (.none, .none): return true; case (.some(let x), .some(let y)): return x.utf8.elementsEqual(y.utf8); default: return false }
    }
    private static func sameShortcut(_ a: [String]?, _ b: [String]?) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return a.count == b.count && zip(a, b).allSatisfy { same($0.0, $0.1) }
    }
    private static func sameOwner(_ a: MacAppIdentity?, _ b: MacAppIdentity?) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return same(a.bundleId, b.bundleId) && same(a.teamId, b.teamId) && a.apple == b.apple && a.system == b.system &&
            a.verified == b.verified && same(a.name, b.name) && same(a.path, b.path) && a.pid == b.pid
    }
}

struct AccessibilitySnapshot {
    let generation: Int
    let sessionID: String
    let observationEpoch: UUID
    let runEpoch: UUID
    let phaseRevision: Int?
    fileprivate let worker: UUID
    fileprivate let token: UUID
}

struct AccessibilityReference<Element> {
    let ref: String
    let elementID: String
    let generation: Int
    let element: Element
    let witness: AccessibilityWitness
    let runEpoch: UUID
    let sessionID: String
    let facts: AccessibilityReceiptFacts?
}

/// Element hash/equality are native CFHash/CFEqual in production, never an AXIdentifier or a screen label.
/// The generic handle lets synthetic tests exercise the same registry without constructing AXUIElements.
final class AccessibilityRegistry<Element> {
    private struct StableElement {
        let element: Element
        let process: HelperProcessIdentity
        let windowID: String?
        let menu: AccessibilityMenuWitness?
        let hosted: HostedWindowProof?
        let hash: UInt
    }

    private let lock = NSLock()
    private let worker = UUID()
    private let limit: Int
    private let stableLimit: Int
    private let hash: (Element) -> UInt
    private let equal: (Element, Element) -> Bool
    private var snapshot: AccessibilitySnapshot?
    private var generation = 0
    private var sequence = 0
    private var closed = false
    private var references: [String: AccessibilityReference<Element>] = [:]
    private var receipts: [String: AccessibilityReference<Element>] = [:]
    private var receiptOrder: [String] = []
    private var receiptBytes = 0
    private var runEpoch: UUID?
    private var runSession: String?
    private var latestReference: [String: String] = [:]
    private var activeIDs = Set<String>()
    private var stable: [String: StableElement] = [:]
    private var buckets: [UInt: [String]] = [:]
    private var stableOrder: [String] = []

    init(limit: Int = 4096, stableLimit: Int = 8192,
         hash: @escaping (Element) -> UInt, equal: @escaping (Element, Element) -> Bool) {
        let boundedLimit = min(4096, max(1, limit))
        self.limit = boundedLimit
        self.stableLimit = min(8192, max(boundedLimit, stableLimit))
        self.hash = hash
        self.equal = equal
    }

    /// Only a tree snapshot retires the previous generation. Resolve never mints a replacement reference.
    func beginSnapshot(session: ServerSession) throws -> AccessibilitySnapshot {
        lock.lock()
        defer { lock.unlock() }
        return try begin(session, tree: true)
    }

    /// Focus and hit-test observations share the current generation, until authority or a tree changes it.
    func currentSnapshot(session: ServerSession) throws -> AccessibilitySnapshot {
        lock.lock()
        defer { lock.unlock() }
        if !closed, let snapshot, matches(snapshot, session) { return snapshot }
        return try begin(session, tree: false)
    }

    func register(element: Element, witness: AccessibilityWitness,
                  snapshot requested: AccessibilitySnapshot, facts: AccessibilityReceiptFacts? = nil) throws -> AccessibilityReference<Element> {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, let snapshot, snapshot.worker == requested.worker, snapshot.token == requested.token,
              witness.valid, witness.matches(snapshot) else { throw Self.stale }
        let elementHash = hash(element)
        let existingID = buckets[elementHash]?.first { id in
            guard let item = stable[id], item.process == witness.process, item.windowID == witness.windowID,
                  item.menu == witness.menu,
                  item.hosted == witness.hosted else { return false }
            return equal(item.element, element)
        }
        if let id = existingID, let ref = latestReference[id], let record = references[ref], record.witness == witness {
            return record
        }
        guard references.count < limit else {
            throw ServerFailure(code: "unavailable", message: "The accessibility snapshot reference limit was reached.")
        }
        let elementID: String
        if let existingID { elementID = existingID }
        else {
            while stable.count >= stableLimit {
                guard let index = stableOrder.firstIndex(where: { !activeIDs.contains($0) }) else {
                    throw ServerFailure(code: "unavailable", message: "The accessibility identity limit was reached.")
                }
                let retired = stableOrder.remove(at: index)
                for ref in receipts.keys.filter({ receipts[$0]?.elementID == retired }) { removeReceipt(ref) }
                receiptOrder.removeAll { receipts[$0] == nil }
                if let item = stable.removeValue(forKey: retired) {
                    buckets[item.hash]?.removeAll { $0 == retired }
                    if buckets[item.hash]?.isEmpty == true { buckets.removeValue(forKey: item.hash) }
                }
            }
            elementID = try nextID("axe")
            stable[elementID] = StableElement(element: element, process: witness.process, windowID: witness.windowID, menu: witness.menu,
                                              hosted: witness.hosted, hash: elementHash)
            buckets[elementHash, default: []].append(elementID)
            stableOrder.append(elementID)
        }
        let ref = try nextID("axr")
        let record = AccessibilityReference(ref: ref, elementID: elementID, generation: snapshot.generation,
                                            element: element, witness: witness, runEpoch: snapshot.runEpoch, sessionID: snapshot.sessionID, facts: facts?.complete == true ? facts : nil)
        references[ref] = record
        latestReference[elementID] = ref
        activeIDs.insert(elementID)
        return record
    }

    /// The adapter must re-observe ownership and the native window before passing a live witness here.
    /// Looking up a ref never changes focus, replaces its handle, or advances the snapshot generation.
    func resolve(_ ref: String, session: ServerSession,
                 witness: AccessibilityWitness? = nil) throws -> AccessibilityReference<Element> {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, let snapshot, matches(snapshot, session),
              let record = references[ref], record.generation == snapshot.generation,
              witness.map({ $0.valid && $0.matches(snapshot) && $0 == record.witness }) ?? true else { throw Self.stale }
        return record
    }

    /// Element-only expected targets may bind only to an already observed current reference.
    func resolveElement(_ elementID: String, session: ServerSession,
                        witness: AccessibilityWitness) throws -> AccessibilityReference<Element> {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, let snapshot, matches(snapshot, session), witness.valid, witness.matches(snapshot),
              stable[elementID] != nil, let ref = latestReference[elementID], let record = references[ref],
              record.elementID == elementID, record.generation == snapshot.generation,
              record.witness == witness else { throw Self.stale }
        return record
    }

    func noteSession(_ session: ServerSession?) {
        lock.lock(); defer { lock.unlock() }
        guard let session else { retire(); return }
        if !matchesRun(session) { retire(); runEpoch = session.runEpoch; runSession = session.id }
    }

    /// Phase updates demote authority, not native object evidence. Only explicit resolve can reauthorize it.
    func suspendObservations() {
        lock.lock(); defer { lock.unlock() }
        demote()
    }

    func receipt(_ ref: String, session: ServerSession) throws -> AccessibilityReference<Element> {
        lock.lock(); defer { lock.unlock() }
        guard !closed, matchesRun(session) else { throw Self.stale }
        if let snapshot, !matches(snapshot, session) { demote() }
        guard let record = receipts[ref], record.runEpoch == session.runEpoch,
              record.sessionID.utf8.elementsEqual(session.id.utf8), record.facts?.complete == true,
              stable[record.elementID] != nil else { throw Self.stale }
        return record
    }

    /// Caller has just reobserved policy, actual AX membership and all complete facts. No native work runs here.
    func refreshReceipt(_ receipt: AccessibilityReference<Element>, liveElement: Element, witness: AccessibilityWitness,
                        facts: AccessibilityReceiptFacts, session: ServerSession) throws -> AccessibilityReference<Element> {
        lock.lock(); defer { lock.unlock() }
        guard !closed, matchesRun(session), let stored = receipts[receipt.ref], stored.elementID == receipt.elementID,
              stored.runEpoch == session.runEpoch, stored.sessionID.utf8.elementsEqual(session.id.utf8),
              stable[stored.elementID] != nil, equal(stored.element, liveElement), equal(stored.element, receipt.element),
              facts.complete, stored.facts?.complete == true, stored.facts == facts,
              witness.valid, sameReceiptScope(stored.witness, witness) else { throw Self.stale }
        let current: AccessibilitySnapshot
        if let snapshot, matches(snapshot, session) { current = snapshot } else { current = try begin(session, tree: false) }
        guard references.count < limit, witness.matches(current) else { throw Self.stale }
        let record = AccessibilityReference(ref: stored.ref, elementID: stored.elementID, generation: current.generation,
            element: stored.element, witness: witness, runEpoch: current.runEpoch, sessionID: current.sessionID, facts: facts)
        removeReceipt(stored.ref); receiptOrder.removeAll { $0 == stored.ref }
        if let old = stable[stored.elementID] {
            stable[stored.elementID] = StableElement(element: stored.element, process: witness.process, windowID: witness.windowID,
                menu: witness.menu, hosted: witness.hosted, hash: old.hash)
        }
        references[stored.ref] = record; latestReference[stored.elementID] = stored.ref; activeIDs.insert(stored.elementID)
        return record
    }

    func recordFacts(_ ref: String, facts: AccessibilityReceiptFacts, session: ServerSession) throws -> AccessibilityReference<Element> {
        lock.lock(); defer { lock.unlock() }
        guard !closed, let snapshot, matches(snapshot, session), let record = references[ref] else { throw Self.stale }
        let updated = AccessibilityReference(ref: record.ref, elementID: record.elementID, generation: record.generation,
            element: record.element, witness: record.witness, runEpoch: record.runEpoch, sessionID: record.sessionID, facts: facts.complete ? facts : nil)
        references[ref] = updated
        return updated
    }

    private func sameReceiptScope(_ old: AccessibilityWitness, _ current: AccessibilityWitness) -> Bool {
        guard old.process == current.process, old.windowID == current.windowID, old.windowFrame == current.windowFrame,
              old.onScreen == current.onScreen, old.spaceWitness == current.spaceWitness, old.menu == current.menu else { return false }
        if let oldHost = old.hosted, let newHost = current.hosted {
            // Session/observation fields intentionally refresh; the actual three-way native binding does not.
            return oldHost.physicalOwner.process == newHost.physicalOwner.process && oldHost.logicalOwner.process == newHost.logicalOwner.process &&
                oldHost.physicalOwner.identity == newHost.physicalOwner.identity && oldHost.logicalOwner.identity == newHost.logicalOwner.identity &&
                oldHost.surface == newHost.surface && oldHost.kind == newHost.kind &&
                AccessibilityElement.equivalent(oldHost.physicalRoot, newHost.physicalRoot) &&
                AccessibilityElement.equivalent(oldHost.logicalWindow, newHost.logicalWindow)
        }
        return old.hosted == nil && current.hosted == nil
    }

    private func receiptCost(_ record: AccessibilityReference<Element>) -> Int {
        var cost: Int = 512
        cost += record.ref.utf8.count
        cost += record.elementID.utf8.count
        cost += record.sessionID.utf8.count
        cost += record.witness.process.executable.utf8.count
        for part in record.witness.menu?.menuPath ?? [] { cost += 32 + part.utf8.count }
        if let facts = record.facts {
            cost += facts.role.utf8.count
            cost += facts.subrole?.utf8.count ?? 0
            cost += facts.name.utf8.count
            cost += facts.document?.utf8.count ?? 0
            for key in facts.menuShortcut ?? [] { cost += 16 + key.utf8.count }
            cost += facts.owner?.path?.utf8.count ?? 0
            cost += facts.owner?.name.utf8.count ?? 0
            cost += facts.owner?.bundleId.utf8.count ?? 0
            cost += facts.owner?.teamId?.utf8.count ?? 0
        }
        return cost
    }
    private func removeReceipt(_ ref: String) {
        if let old = receipts.removeValue(forKey: ref) { receiptBytes -= receiptCost(old) }
    }
    private func demote() {
        for (ref, record) in references where record.facts?.complete == true {
            if receipts[ref] == nil { receiptOrder.append(ref) } else { removeReceipt(ref) }
            receipts[ref] = record; receiptBytes += receiptCost(record)
        }
        while receiptOrder.count > limit || receiptBytes > 8 * 1_048_576 {
            removeReceipt(receiptOrder.removeFirst())
        }
        snapshot = nil; references.removeAll(keepingCapacity: true); latestReference.removeAll(keepingCapacity: true); activeIDs.removeAll(keepingCapacity: true)
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        retire()
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        closed = true
        retire()
    }

    private func begin(_ session: ServerSession, tree: Bool) throws -> AccessibilitySnapshot {
        guard !closed, !session.id.isEmpty, session.id.utf8.count <= 256,
              !session.id.contains("\0"), session.revision.map({ $0 >= 0 }) ?? true,
              generation < 9_007_199_254_740_991 else { throw Self.stale }
        if !matchesRun(session) { retire(); runEpoch = session.runEpoch; runSession = session.id }
        if tree {
            if snapshot.map({ !matches($0, session) }) ?? true {
                references.removeAll(); stable.removeAll(); buckets.removeAll(); stableOrder.removeAll()
            }
            receipts.removeAll(); receiptOrder.removeAll(); receiptBytes = 0
        } else if let snapshot, !matches(snapshot, session) { demote() }
        generation += 1
        references.removeAll(keepingCapacity: true); latestReference.removeAll(keepingCapacity: true); activeIDs.removeAll(keepingCapacity: true)
        let value = AccessibilitySnapshot(generation: generation, sessionID: session.id,
            observationEpoch: session.observationEpoch, runEpoch: session.runEpoch, phaseRevision: session.revision, worker: worker, token: UUID())
        snapshot = value
        return value
    }

    private func matchesRun(_ session: ServerSession) -> Bool {
        runEpoch == session.runEpoch && runSession.map { $0.utf8.elementsEqual(session.id.utf8) } == true
    }

    private func matches(_ snapshot: AccessibilitySnapshot, _ session: ServerSession) -> Bool {
        snapshot.worker == worker && snapshot.sessionID.utf8.elementsEqual(session.id.utf8) &&
            snapshot.observationEpoch == session.observationEpoch && snapshot.runEpoch == session.runEpoch && snapshot.phaseRevision == session.revision
    }

    private func retire() {
        snapshot = nil; runEpoch = nil; runSession = nil
        receipts.removeAll(keepingCapacity: true); receiptOrder.removeAll(keepingCapacity: true); receiptBytes = 0
        references.removeAll(keepingCapacity: true)
        latestReference.removeAll(keepingCapacity: true)
        activeIDs.removeAll(keepingCapacity: true)
        stable.removeAll(keepingCapacity: true)
        buckets.removeAll(keepingCapacity: true)
        stableOrder.removeAll(keepingCapacity: true)
    }

    private func nextID(_ prefix: String) throws -> String {
        guard sequence < 9_007_199_254_740_991 else { throw Self.stale }
        sequence += 1
        return "\(prefix)_\(worker.uuidString.lowercased())_\(sequence)"
    }

    private static var stale: ServerFailure {
        ServerFailure(code: "stale_ref", message: "The accessibility reference belongs to an expired native observation.")
    }
}

enum AccessibilityContent {
    /// UTF-16 caps match the wire and never split a supplementary Unicode scalar into an unpaired surrogate.
    static func sanitize(_ text: String, limit: Int = 500) -> String {
        let cap = min(500, max(0, limit))
        var result = ""
        var length = 0
        for scalar in text.unicodeScalars {
            let value = scalar.value
            if value < 0x20 || (0x7f...0x9f).contains(value) || value == 0x061c ||
                (0x200b...0x200f).contains(value) || (0x2028...0x202e).contains(value) ||
                (0x2060...0x2069).contains(value) || value == 0xfeff { continue }
            let units = value > 0xffff ? 2 : 1
            if length + units > cap { break }
            result.unicodeScalars.append(scalar)
            length += units
        }
        return result
    }

    /// Secure field values must not be fetched by the AX adapter; even an injected value is never disclosed.
    static func value(_ raw: String?, secure: Bool, disclosure: NativeDisclosure, limit: Int = 500) -> String? {
        guard disclosure == .content else { return nil }
        if secure { return "REDACTED" }
        return raw.map { sanitize($0, limit: limit) }
    }
}
