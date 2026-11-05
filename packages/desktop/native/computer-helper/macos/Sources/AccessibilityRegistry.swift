import CoreGraphics
import Foundation

struct AccessibilityWitness: Equatable {
    let process: HelperProcessIdentity
    let windowID: String
    let windowFrame: CGRect
    let onScreen: Bool
    let spaceWitness: String?
    /// The process above remains the real AX endpoint; this proof separately binds its client and CG surface.
    let hosted: HostedWindowProof?

    init(process: HelperProcessIdentity, windowID: String, windowFrame: CGRect,
         onScreen: Bool = true, spaceWitness: String? = nil, hosted: HostedWindowProof? = nil) {
        self.process = process
        self.windowID = windowID
        self.windowFrame = windowFrame
        self.onScreen = onScreen
        self.spaceWitness = spaceWitness
        self.hosted = hosted
    }

    fileprivate var valid: Bool {
        process.pid > 0 && process.parentPID > 0 && process.startMicroseconds < 1_000_000 &&
            MacAppIdentity.canonicalPathShape(process.executable) &&
            !windowID.isEmpty && windowID.utf8.count <= 256 && !windowID.contains("\0") &&
            windowFrame.minX.isFinite && windowFrame.minY.isFinite && windowFrame.width.isFinite && windowFrame.height.isFinite &&
            windowFrame.width > 0 && windowFrame.height > 0 && windowFrame.maxX.isFinite && windowFrame.maxY.isFinite &&
            (spaceWitness.map { !$0.isEmpty && $0.utf8.count <= 256 && !$0.contains("\0") } ?? true) &&
            (hosted.map { $0.physicalOwner.process == process && $0.surface.windowID == windowID &&
                $0.surface.bounds == windowFrame && $0.surface.onScreen == onScreen &&
                $0.surface.spaceWitness == spaceWitness } ?? true)
    }

    fileprivate func matches(_ snapshot: AccessibilitySnapshot) -> Bool {
        hosted.map { $0.observationEpoch == snapshot.observationEpoch &&
            $0.sessionID.utf8.elementsEqual(snapshot.sessionID.utf8) && $0.phaseRevision == snapshot.phaseRevision } ?? true
    }
}

struct AccessibilitySnapshot {
    let generation: Int
    let sessionID: String
    let observationEpoch: UUID
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
}

/// Element hash/equality are native CFHash/CFEqual in production, never an AXIdentifier or a screen label.
/// The generic handle lets synthetic tests exercise the same registry without constructing AXUIElements.
final class AccessibilityRegistry<Element> {
    private struct StableElement {
        let element: Element
        let process: HelperProcessIdentity
        let windowID: String
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
        return try begin(session)
    }

    /// Focus and hit-test observations share the current generation, until authority or a tree changes it.
    func currentSnapshot(session: ServerSession) throws -> AccessibilitySnapshot {
        lock.lock()
        defer { lock.unlock() }
        if !closed, let snapshot, matches(snapshot, session) { return snapshot }
        return try begin(session)
    }

    func register(element: Element, witness: AccessibilityWitness,
                  snapshot requested: AccessibilitySnapshot) throws -> AccessibilityReference<Element> {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, let snapshot, snapshot.worker == requested.worker, snapshot.token == requested.token,
              witness.valid, witness.matches(snapshot) else { throw Self.stale }
        let elementHash = hash(element)
        let existingID = buckets[elementHash]?.first { id in
            guard let item = stable[id], item.process == witness.process, item.windowID == witness.windowID,
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
                if let item = stable.removeValue(forKey: retired) {
                    buckets[item.hash]?.removeAll { $0 == retired }
                    if buckets[item.hash]?.isEmpty == true { buckets.removeValue(forKey: item.hash) }
                }
            }
            elementID = try nextID("axe")
            stable[elementID] = StableElement(element: element, process: witness.process, windowID: witness.windowID,
                                              hosted: witness.hosted, hash: elementHash)
            buckets[elementHash, default: []].append(elementID)
            stableOrder.append(elementID)
        }
        let ref = try nextID("axr")
        let record = AccessibilityReference(ref: ref, elementID: elementID, generation: snapshot.generation,
                                            element: element, witness: witness)
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

    private func begin(_ session: ServerSession) throws -> AccessibilitySnapshot {
        guard !closed, !session.id.isEmpty, session.id.utf8.count <= 256,
              !session.id.contains("\0"), session.revision.map({ $0 >= 0 }) ?? true,
              generation < 9_007_199_254_740_991 else { throw Self.stale }
        if snapshot.map({ !matches($0, session) }) ?? true { retire() }
        generation += 1
        references.removeAll(keepingCapacity: true)
        latestReference.removeAll(keepingCapacity: true)
        activeIDs.removeAll(keepingCapacity: true)
        let value = AccessibilitySnapshot(generation: generation, sessionID: session.id,
                                          observationEpoch: session.observationEpoch, phaseRevision: session.revision,
                                          worker: worker, token: UUID())
        snapshot = value
        return value
    }

    private func matches(_ snapshot: AccessibilitySnapshot, _ session: ServerSession) -> Bool {
        snapshot.worker == worker && snapshot.sessionID == session.id &&
            snapshot.observationEpoch == session.observationEpoch && snapshot.phaseRevision == session.revision
    }

    private func retire() {
        snapshot = nil
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
