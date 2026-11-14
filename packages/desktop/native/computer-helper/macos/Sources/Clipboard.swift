import AppKit
import Dispatch
import Foundation

enum ClipboardLimits {
    static let textUnits = 1_000_000
    static let bytes = 8 * 1024 * 1024
    static let items = 32
    static let flavors = 128
    static let operationMs = 1000
    static let cleanupMs = 300
}

/// Materialized immutable bytes only. No pasteboard item, provider, URL resolution or private text is persisted.
struct ClipboardFlavor: Equatable { let type: String; let data: Data }
struct ClipboardItem: Equatable { let flavors: [ClipboardFlavor] }
struct ClipboardText { let changeCount: Int; let text: String }
struct ClipboardSnapshot { let changeCount: Int; let items: [ClipboardItem]; let text: String }

struct ClipboardSourceItem {
    let types: [String]
    let data: (String) throws -> Data?
}

/// The actual native materialization loop is independently injectable: providers may expand their advertised
/// types, fail, time out or transfer clipboard ownership while producing bytes.
enum ClipboardSnapshotReader {
    static func read(changeCount: Int, items: [ClipboardSourceItem], budget: ClipboardBudget,
                     currentCount: () -> Int, currentCatalog: () -> [[String]], text: () throws -> String) throws -> ClipboardSnapshot {
        try budget.check()
        guard changeCount >= 0, items.count <= ClipboardLimits.items else { throw ClipboardService.unavailable }
        let catalog = items.map(\.types)
        var flavors = 0
        for types in catalog {
            guard !types.isEmpty, Set(types).count == types.count, types.allSatisfy(ClipboardService.validType),
                  types.count <= ClipboardLimits.flavors - flavors else { throw ClipboardService.unavailable }
            flavors += types.count
        }
        var result: [ClipboardItem] = [], bytes = 0
        for item in items {
            var values: [ClipboardFlavor] = []
            for type in item.types {
                try budget.check()
                guard currentCount() == changeCount else { throw ClipboardService.changed }
                guard let data = try item.data(type) else { throw ClipboardService.unavailable }
                try budget.check()
                guard data.count <= ClipboardLimits.bytes - bytes else { throw ClipboardService.unavailable }
                let copy = data.isEmpty ? Data() : data.withUnsafeBytes { raw in Data(bytes: raw.baseAddress!, count: raw.count) }
                bytes += copy.count
                values.append(ClipboardFlavor(type: type, data: copy))
            }
            result.append(ClipboardItem(flavors: values))
        }
        try budget.check()
        guard currentCount() == changeCount, currentCatalog() == catalog else { throw ClipboardService.changed }
        let value = try text()
        try budget.check()
        guard currentCount() == changeCount, currentCatalog() == catalog else { throw ClipboardService.changed }
        guard value.utf16.count <= ClipboardLimits.textUnits else { throw ClipboardService.unavailable }
        return ClipboardSnapshot(changeCount: changeCount, items: result, text: value)
    }
}

/// A count is owned only when this worker actually cleared the pasteboard at that count.
/// A partial failed write still owns its empty/partial board, until another process changes it.
struct ClipboardMutation { let changeCount: Int?; let complete: Bool }
typealias ClipboardCommit = (_ mutation: () throws -> ClipboardMutation) throws -> ClipboardMutation

struct ClipboardBudget {
    let deadline: UInt64
    let now: () -> UInt64
    let current: () -> Bool

    func check() throws {
        guard current() else { throw ClipboardService.changed }
        guard now() < deadline else { throw ClipboardService.timeout }
    }
}

struct ClipboardBackend {
    let read: (ClipboardBudget) throws -> ClipboardText
    let snapshot: (ClipboardBudget) throws -> ClipboardSnapshot
    let changeCount: () -> Int
    /// Prepare all provider-free objects before commit; invoke commit synchronously exactly once.
    let replace: ([ClipboardItem], Int, ClipboardBudget, ClipboardCommit) throws -> ClipboardMutation

    static var system: ClipboardBackend { ClipboardNative.backend() }
}

/// A worker may have at most one outstanding provider operation. A timed-out provider is quarantined until
/// it returns; neither another worker thread nor an unbounded queue is created for subsequent requests.
final class ClipboardService {
    typealias Schedule = (Int, @escaping () -> Void) -> (() -> Void)
    private struct Owned {
        let id: UUID
        let sessionID: String
        let authority: UInt64
        let snapshot: ClipboardSnapshot
        var changeCount: Int
    }
    private final class Flight {
        let generation: UInt64
        let context: OperationContext
        let completion: Dispatcher.Completion
        var delivered = false
        var cancelTimer: (() -> Void)?
        init(generation: UInt64, context: OperationContext, completion: @escaping Dispatcher.Completion) {
            self.generation = generation; self.context = context; self.completion = completion
        }
    }

    private let backend: ClipboardBackend
    private let execute: (@escaping () -> Void) -> Void
    private let executeCleanup: (@escaping () -> Void) -> Void
    private let schedule: Schedule
    private let now: () -> UInt64
    private let lock = NSRecursiveLock()
    private var generation: UInt64 = 0
    private var active: Flight?
    private var owned: Owned?
    private var cleaning = false
    private var cleanupID: UUID?
    private var cleanupTimedOut = false
    private var cleanupCallbacks: [(Bool) -> Void] = []
    private var closed = false

    /// Constructors and features are inert, including the default native adapter.
    init(backend: ClipboardBackend = .system, execute: ((@escaping () -> Void) -> Void)? = nil,
         executeCleanup: ((@escaping () -> Void) -> Void)? = nil,
         schedule: Schedule? = nil, now: (() -> UInt64)? = nil) {
        self.backend = backend
        let worker = DispatchQueue(label: "ai.vector.computer.clipboard")
        let cleanup = DispatchQueue(label: "ai.vector.computer.clipboard-cleanup")
        let timers = DispatchQueue(label: "ai.vector.computer.clipboard-timers")
        self.execute = execute ?? { worker.async(execute: DispatchWorkItem(block: $0)) }
        self.executeCleanup = executeCleanup ?? { cleanup.async(execute: DispatchWorkItem(block: $0)) }
        self.now = now ?? { DispatchTime.now().uptimeNanoseconds }
        self.schedule = schedule ?? { milliseconds, work in
            let item = DispatchWorkItem(block: work)
            timers.asyncAfter(deadline: .now() + .milliseconds(milliseconds), execute: item)
            return { item.cancel() }
        }
    }

    func features() -> [String: Bool] { ["clipboard": true] }

    func read(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        guard args.isEmpty else { completion(.failure(Self.invalid)); return }
        guard context.session != nil else { completion(.failure(Self.unavailable)); return }
        perform(context, completion) { _, budget in
            let result = try self.backend.read(budget)
            try budget.check()
            guard result.changeCount >= 0, result.text.utf16.count <= ClipboardLimits.textUnits,
                  self.backend.changeCount() == result.changeCount else { throw Self.changed }
            return ServerReply(fields: ["text": .string(result.text)])
        }
    }

    func write(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        guard let session = context.session else { completion(.failure(Self.unavailable)); return }
        guard Set(args.keys).isSubset(of: ["text", "sessionId", "phaseRevision"]),
              let text = args["text"]?.stringValue, text.utf16.count <= ClipboardLimits.textUnits else {
            completion(.failure(Self.invalid)); return
        }
        if let revision = session.revision {
            guard args["sessionId"]?.stringValue == session.id, args["phaseRevision"]?.intValue == revision else {
                completion(.failure(Self.changed)); return
            }
        } else {
            guard args["sessionId"] == nil || args["sessionId"]?.stringValue == session.id,
                  args["phaseRevision"] == nil || args["phaseRevision"]?.intValue.map({ $0 >= 0 }) == true else {
                completion(.failure(Self.changed)); return
            }
        }
        guard !session.paused else { completion(.failure(ServerFailure(code: "paused", message: "The computer session is paused."))); return }
        guard session.mode == "foreground" else {
            completion(.failure(ServerFailure(code: "needs_foreground", message: "Clipboard writes need the foreground."))); return
        }
        perform(context, completion) { flight, budget in
            self.lock.lock(); let previous = self.owned; self.lock.unlock()
            if let previous {
                guard previous.sessionID == session.id, previous.authority == flight.generation,
                      self.backend.changeCount() == previous.changeCount else {
                    self.discardIfChanged(previous)
                    throw Self.changed
                }
            }
            let snapshot = try previous?.snapshot ?? self.backend.snapshot(budget)
            try Self.validate(snapshot)
            try budget.check()
            let restoring = previous != nil && text == snapshot.text
            let items = restoring ? snapshot.items : Self.plain(text)
            let expected = previous?.changeCount ?? snapshot.changeCount
            let identity = previous?.id ?? UUID()
            let mutation = try self.backend.replace(items, expected, budget) { change in
                var result: Result<ClipboardMutation, Error>?
                guard context.withCurrent({
                    self.lock.lock(); defer { self.lock.unlock() }
                    result = Result {
                        try budget.check()
                        guard self.active === flight, self.sameOwned(previous) else { throw Self.changed }
                        let mutation = try change()
                        if let count = mutation.changeCount {
                            if restoring && mutation.complete { self.owned = nil }
                            else { self.owned = Owned(id: identity, sessionID: session.id, authority: flight.generation,
                                snapshot: snapshot, changeCount: count) }
                        }
                        return mutation
                    }
                }), let result else { throw Self.changed }
                return try result.get()
            }
            guard mutation.complete, mutation.changeCount != nil else { throw Self.changed }
            try budget.check()
            return ServerReply()
        }
    }

    /// Call on task replacement/end, cancel/error and graceful helper close. Ordinary phase updates and
    /// input.releaseAll do not end a clipboard loan. Cleanup has only the original owned-count authority.
    func cleanup(completion: ((Bool) -> Void)? = nil) {
        lock.lock()
        generation &+= 1
        let flight = active
        let notify = flight.map { !$0.delivered } ?? false
        if notify { flight?.delivered = true }
        let refuseCallback = completion != nil && ((cleaning && cleanupTimedOut) || cleanupCallbacks.count >= 16)
        if let completion, !refuseCallback { cleanupCallbacks.append(completion) }
        guard !cleaning else {
            lock.unlock()
            if notify { flight?.completion(.failure(Self.changed)) }
            if refuseCallback { completion?(false) }
            return
        }
        cleaning = true
        cleanupTimedOut = false
        let id = UUID(); cleanupID = id
        let deadline = now() &+ UInt64(ClipboardLimits.cleanupMs) * 1_000_000
        let snapshot = owned
        lock.unlock()
        if notify { flight?.cancelTimer?(); flight?.completion(.failure(Self.changed)) }
        if refuseCallback { completion?(false) }
        let cancel = schedule(ClipboardLimits.cleanupMs) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            guard self.cleaning, self.cleanupID == id else { self.lock.unlock(); return }
            self.cleanupTimedOut = true
            let callbacks = self.cleanupCallbacks; self.cleanupCallbacks.removeAll()
            self.lock.unlock()
            callbacks.forEach { $0(false) }
        }
        executeCleanup { [self] in
            let success = restore(snapshot, id: id, deadline: deadline)
            cancel()
            lock.lock(); cleaning = false; cleanupID = nil
            let callbacks = cleanupCallbacks; cleanupCallbacks.removeAll(); lock.unlock()
            callbacks.forEach { $0(success) }
        }
    }

    func close(completion: ((Bool) -> Void)? = nil) {
        lock.lock(); closed = true; lock.unlock()
        cleanup(completion: completion)
    }

    private func perform(_ context: OperationContext, _ completion: @escaping Dispatcher.Completion,
                         _ body: @escaping (Flight, ClipboardBudget) throws -> ServerReply) {
        guard context.isCurrent() else { completion(.failure(Self.changed)); return }
        lock.lock()
        guard !closed, active == nil, !cleaning else {
            let failure = closed ? Self.changed : ServerFailure(code: "busy", message: "A clipboard operation is still pending.")
            lock.unlock(); completion(.failure(failure)); return
        }
        let flight = Flight(generation: generation, context: context, completion: completion)
        active = flight
        lock.unlock()
        let budget = ClipboardBudget(deadline: now() &+ UInt64(ClipboardLimits.operationMs) * 1_000_000,
            now: now, current: { [weak self, weak flight] in
                guard let self, let flight, context.isCurrent() else { return false }
                self.lock.lock(); defer { self.lock.unlock() }
                return !self.closed && !flight.delivered && self.active === flight && self.generation == flight.generation
            })
        let cancel = schedule(ClipboardLimits.operationMs) { [weak self, weak flight] in
            guard let self, let flight else { return }
            self.lock.lock()
            guard self.active === flight, !flight.delivered else { self.lock.unlock(); return }
            flight.delivered = true; self.generation &+= 1
            self.lock.unlock()
            self.cleanup()
            flight.completion(.failure(Self.timeout))
        }
        lock.lock(); flight.cancelTimer = cancel; let live = active === flight && !flight.delivered; lock.unlock()
        if !live { cancel() }
        execute { [self] in
            let result: Result<ServerReply, ServerFailure>
            do {
                try budget.check()
                let reply = try body(flight, budget)
                try budget.check()
                result = .success(reply)
            }
            catch { result = .failure(Self.failure(error)) }
            lock.lock()
            let deliver = !flight.delivered
            flight.delivered = true
            let valid = !closed && generation == flight.generation
            let recover = owned != nil && { if case .failure = result { return true }; return false }()
            if !recover, active === flight { active = nil }
            lock.unlock()
            cancel()
            if recover {
                cleanup()
                lock.lock(); if active === flight { active = nil }; lock.unlock()
            }
            guard deliver else { return }
            completion(valid && context.isCurrent() ? result : .failure(Self.changed))
        }
    }

    private func sameOwned(_ previous: Owned?) -> Bool {
        if let previous { return owned?.id == previous.id && owned?.changeCount == previous.changeCount }
        return owned == nil
    }

    private func discardIfChanged(_ previous: Owned) {
        let changed = backend.changeCount() != previous.changeCount
        guard changed else { return }
        lock.lock(); if sameOwned(previous) { owned = nil }; lock.unlock()
    }

    private func restore(_ previous: Owned?, id: UUID, deadline: UInt64) -> Bool {
        guard let previous else { return true }
        let budget = ClipboardBudget(deadline: deadline, now: now,
            current: { [weak self] in
                guard let self else { return false }
                self.lock.lock(); defer { self.lock.unlock() }
                return self.sameOwned(previous) && self.cleaning && self.cleanupID == id && !self.cleanupTimedOut
            })
        do {
            try budget.check()
            guard backend.changeCount() == previous.changeCount else { discardIfChanged(previous); return true }
            let result = try backend.replace(previous.snapshot.items, previous.changeCount, budget) { change in
                self.lock.lock(); defer { self.lock.unlock() }
                guard self.sameOwned(previous) else { throw Self.changed }
                try budget.check()
                let result = try change()
                if result.complete { self.owned = nil }
                else if let count = result.changeCount { self.owned?.changeCount = count }
                return result
            }
            if !result.complete { discardIfChanged(previous) }
            return result.complete
        } catch { discardIfChanged(previous); return false }
    }

    static func validate(_ snapshot: ClipboardSnapshot) throws {
        guard snapshot.changeCount >= 0, snapshot.items.count <= ClipboardLimits.items,
              snapshot.text.utf16.count <= ClipboardLimits.textUnits else { throw invalid }
        var bytes = 0, flavors = 0
        for item in snapshot.items {
            guard !item.flavors.isEmpty, Set(item.flavors.map(\.type)).count == item.flavors.count else { throw invalid }
            for flavor in item.flavors {
                flavors += 1
                guard validType(flavor.type), flavors <= ClipboardLimits.flavors,
                      flavor.data.count <= ClipboardLimits.bytes - bytes else { throw unavailable }
                bytes += flavor.data.count
            }
        }
    }

    static func validType(_ type: String) -> Bool {
        !type.isEmpty && type.utf16.count <= 256 && MacAppIdentity.safeName(type) &&
            !type.lowercased().contains("promise")
    }
    static func plain(_ text: String) -> [ClipboardItem] {
        [ClipboardItem(flavors: [ClipboardFlavor(type: NSPasteboard.PasteboardType.string.rawValue, data: Data(text.utf8))])]
    }
    static var invalid: ServerFailure { ServerFailure(code: "failed", message: "The clipboard arguments or snapshot are invalid.") }
    static var unavailable: ServerFailure { ServerFailure(code: "unavailable", message: "The clipboard cannot be preserved completely.") }
    static var changed: ServerFailure { ServerFailure(code: "changed", message: "The clipboard operation is no longer current.") }
    static var timeout: ServerFailure { ServerFailure(code: "timeout", message: "The clipboard operation timed out.") }
    private static func failure(_ error: Error) -> ServerFailure { error as? ServerFailure ?? unavailable }
}

/// No NSPasteboard is obtained during construction. Provider-backed reads run only on the service worker;
/// write/restore objects contain eager bytes and no original provider is retained or replayed.
private enum ClipboardNative {
    static func backend() -> ClipboardBackend {
        ClipboardBackend(read: read, snapshot: snapshot, changeCount: { NSPasteboard.general.changeCount }, replace: replace)
    }

    private static func readable(_ board: NSPasteboard) throws {
        if #available(macOS 15.4, *) {
            guard board.accessBehavior == .alwaysAllow else {
                throw ServerFailure(code: "permissions", message: "Clipboard access has not been allowed in System Settings.")
            }
        }
    }
    private static func read(_ budget: ClipboardBudget) throws -> ClipboardText {
        try budget.check()
        let board = NSPasteboard.general
        try readable(board)
        let count = board.changeCount
        guard count >= 0 else { throw ClipboardService.unavailable }
        let text = try Self.text(board)
        try budget.check()
        guard text.utf16.count <= ClipboardLimits.textUnits else { throw ClipboardService.unavailable }
        guard board.changeCount == count else { throw ClipboardService.changed }
        return ClipboardText(changeCount: count, text: text)
    }

    private static func snapshot(_ budget: ClipboardBudget) throws -> ClipboardSnapshot {
        try budget.check()
        let board = NSPasteboard.general
        try readable(board)
        let count = board.changeCount
        let source = board.pasteboardItems ?? []
        guard count >= 0, source.count <= ClipboardLimits.items else { throw ClipboardService.unavailable }
        if source.isEmpty, !(board.types ?? []).isEmpty { throw ClipboardService.unavailable }
        let providers = source.map { item in ClipboardSourceItem(types: item.types.map(\.rawValue), data: { type in
            try readable(board)
            return item.data(forType: NSPasteboard.PasteboardType(type))
        }) }
        return try ClipboardSnapshotReader.read(changeCount: count, items: providers, budget: budget,
            currentCount: { board.changeCount }, currentCatalog: { (board.pasteboardItems ?? []).map { $0.types.map(\.rawValue) } },
            text: { try Self.text(board) })
    }

    private static func text(_ board: NSPasteboard) throws -> String {
        try readable(board)
        let declared = (board.types ?? []).contains(.string)
        if let text = board.string(forType: .string) { return text }
        guard !declared else { throw ClipboardService.unavailable }
        return ""
    }

    private static func replace(_ items: [ClipboardItem], _ expected: Int, _ budget: ClipboardBudget,
                                _ commit: ClipboardCommit) throws -> ClipboardMutation {
        try budget.check()
        try ClipboardService.validate(ClipboardSnapshot(changeCount: expected, items: items, text: ""))
        let objects = try items.map { item -> NSPasteboardItem in
            let object = NSPasteboardItem()
            for flavor in item.flavors {
                guard object.setData(flavor.data, forType: NSPasteboard.PasteboardType(flavor.type)) else { throw ClipboardService.unavailable }
            }
            return object
        }
        try budget.check()
        return try commit {
            try budget.check()
            let board = NSPasteboard.general
            guard expected >= 0, expected < Int.max, board.changeCount == expected else { return ClipboardMutation(changeCount: nil, complete: false) }
            // NSPasteboard has no compare-and-swap API. Check immediately before each server mutation and
            // stop as soon as its ownership count differs; never restore over a subsequently observed copy.
            let count = board.clearContents()
            guard count == expected + 1, board.changeCount == count else { return ClipboardMutation(changeCount: nil, complete: false) }
            if objects.isEmpty { return ClipboardMutation(changeCount: count, complete: true) }
            do { try budget.check() }
            catch { return ClipboardMutation(changeCount: count, complete: false) }
            guard board.changeCount == count else { return ClipboardMutation(changeCount: nil, complete: false) }
            let written = board.writeObjects(objects)
            guard board.changeCount == count else { return ClipboardMutation(changeCount: nil, complete: false) }
            return ClipboardMutation(changeCount: count, complete: written)
        }
    }
}
