import Foundation
import Dispatch

struct HeldInputLease: Equatable {
    fileprivate let worker: UUID
    fileprivate let epoch: UUID
    fileprivate let sequence: UInt64
}

/// Only matching ups for actual owned downs are retained. Cleanup never obtains new input authority.
final class HeldInputJournal {
    private struct Entry {
        let token: UUID
        let lease: HeldInputLease
        var up: InputPostedEvent
    }

    private let lock = NSRecursiveLock()
    private let worker = UUID()
    private let postRelease: (InputPostedEvent) -> InputReleaseOutcome
    private let now: () -> UInt64
    private var epoch = UUID()
    private var sequence: UInt64 = 0
    private var active: HeldInputLease?
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var releasing = false
    private var closed = false

    init(release: @escaping (InputPostedEvent) -> InputReleaseOutcome, now: (() -> UInt64)? = nil) {
        postRelease = release
        self.now = now ?? { DispatchTime.now().uptimeNanoseconds }
    }

    func begin() throws -> HeldInputLease {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, !releasing, entries.isEmpty, sequence < UInt64.max else {
            throw ServerFailure(code: "unavailable", message: "Held input cleanup must complete before new input.")
        }
        sequence += 1
        epoch = UUID()
        let lease = HeldInputLease(worker: worker, epoch: epoch, sequence: sequence)
        active = lease
        return lease
    }

    /// post must perform only the prepared native event post, with no AX lookup or authority callback.
    /// Recording and posting share the release lock so a stop cannot send an up before a late down.
    func press(lease: HeldInputLease, id: String, up: InputPostedEvent, post: () throws -> Bool) throws {
        lock.lock()
        defer { lock.unlock() }
        try requireCurrent(lease)
        guard !id.isEmpty, id.utf8.count <= 256, !id.contains("\0"), Self.valid(up) else { throw Self.invalid }
        let previous = entries[id]
        if let previous {
            guard previous.lease == lease, previous.up == up else { throw Self.invalid }
        } else {
            guard entries.count < 32 else {
                throw ServerFailure(code: "unavailable", message: "The held input limit was reached.")
            }
            entries[id] = Entry(token: UUID(), lease: lease, up: up)
            order.append(id)
        }
        let token = entries[id]!.token
        // An uncertain thrown failure keeps the release record, because the down may have reached the OS.
        if try !post() {
            if previous == nil, entries[id]?.token == token { remove(id) }
            throw Self.failed
        }
        try requireCurrent(lease)
    }

    /// Non-held moves/scrolls use the same lease fence as downs; a canceled operation cannot post again.
    func post(lease: HeldInputLease, action: () throws -> Bool) throws {
        lock.lock()
        defer { lock.unlock() }
        try requireCurrent(lease)
        guard try action() else { throw Self.failed }
        try requireCurrent(lease)
    }

    /// A repeat/chunk may lift its own key without reopening input through a new lease.
    /// Revoked leases may clean up only their retained ups; they never release a successor's entry.
    func lift(lease: HeldInputLease, id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard lease.worker == worker else { return true }
        guard let entry = entries[id], entry.lease == lease else { return true }
        guard !releasing else { return false }
        releasing = true
        defer { releasing = false }
        switch postRelease(entry.up) {
        case .released, .discarded:
            if entries[id]?.token == entry.token { remove(id) }
            return true
        case .retry: return false
        }
    }

    /// A validated drag move may update only the retained button-up position, never its destination or identity.
    func update(lease: HeldInputLease, id: String, up: InputPostedEvent, post: () throws -> Bool) throws {
        lock.lock()
        defer { lock.unlock() }
        try requireCurrent(lease)
        guard let previous = entries[id], previous.lease == lease, previous.up.kind == .buttonUp,
              Self.valid(up) else { throw Self.invalid }
        var expected = previous.up
        expected.point = up.point
        guard expected == up else { throw Self.invalid }
        entries[id]?.up = up
        // Unknown post success retains the attempted owned point; definite failure restores the previous one.
        if try !post() {
            if entries[id]?.token == previous.token { entries[id]?.up = previous.up }
            throw Self.failed
        }
        try requireCurrent(lease)
    }

    @discardableResult
    func release(lease: HeldInputLease, deadlineMs: Int = 300) -> Int {
        lock.lock()
        defer { lock.unlock() }
        guard lease.worker == worker else { return 0 }
        if active == lease { invalidate() }
        return drain(lease: lease, deadlineMs: deadlineMs)
    }

    func pending(lease: HeldInputLease) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return entries.values.contains { $0.lease == lease }
    }

    @discardableResult
    func releaseAll(deadlineMs: Int = 300) -> Int {
        lock.lock()
        defer { lock.unlock() }
        invalidate()
        return drain(lease: nil, deadlineMs: deadlineMs)
    }

    @discardableResult
    func close() -> Int {
        lock.lock()
        defer { lock.unlock() }
        closed = true
        invalidate()
        return drain(lease: nil, deadlineMs: 300)
    }

    private func requireCurrent(_ lease: HeldInputLease) throws {
        guard !closed, !releasing, lease.worker == worker, lease.epoch == epoch, active == lease else {
            throw ServerFailure(code: "changed", message: "The held input lease is no longer current.")
        }
    }

    private func invalidate() {
        epoch = UUID()
        active = nil
    }

    private func drain(lease: HeldInputLease?, deadlineMs: Int) -> Int {
        guard !releasing else { return 0 }
        releasing = true
        defer { releasing = false }
        let started = now()
        let budget = UInt64(min(300, max(0, deadlineMs))) * 1_000_000
        var released = 0
        // One bounded reverse pass, at most32 callbacks even if an injected clock never advances.
        // Failed ups remain owned for a subsequent cleanup call; they are never silently forgotten.
        for id in order.reversed() {
            let current = now()
            if current < started || current - started >= budget { break }
            guard let entry = entries[id], lease.map({ entry.lease == $0 }) ?? true else { continue }
            switch postRelease(entry.up) {
            case .released:
                if entries[id]?.token == entry.token { remove(id); released += 1 }
            case .discarded:
                if entries[id]?.token == entry.token { remove(id) }
            case .retry: break
            }
        }
        return released
    }

    private func remove(_ id: String) {
        entries.removeValue(forKey: id)
        order.removeAll { $0 == id }
    }

    private static func valid(_ event: InputPostedEvent) -> Bool {
        guard event.point.x.isFinite, event.point.y.isFinite, event.unicode.count <= 20,
              (0...2).contains(event.button), (1...3).contains(event.clickCount) else { return false }
        switch event.kind {
        case .buttonUp: return event.unicode.isEmpty
        case .keyUp, .unicodeUp:
            guard let process = event.destination, process.pid > 0, process.parentPID > 0,
                  process.startMicroseconds < 1_000_000, MacAppIdentity.canonicalPathShape(process.executable) else { return false }
            return event.kind == .keyUp ? event.unicode.isEmpty : !event.unicode.isEmpty
        default: return false
        }
    }

    private static var invalid: ServerFailure {
        ServerFailure(code: "failed", message: "The held input descriptor is invalid.")
    }
    private static var failed: ServerFailure {
        ServerFailure(code: "failed", message: "The prepared input event was not posted.")
    }
}
