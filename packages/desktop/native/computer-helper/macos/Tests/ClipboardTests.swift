import Foundation

private struct ClipboardTestFailure: Error { let message: String }
private func clipboardCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw ClipboardTestFailure(message: message) }
}
private func clipboardFailure(_ body: () throws -> Void) -> String? {
    do { try body(); return nil }
    catch let error as ServerFailure { return error.code }
    catch { return "unexpected" }
}
private final class ClipboardTestTimer {
    let due: UInt64
    let work: () -> Void
    var canceled = false
    init(due: UInt64, work: @escaping () -> Void) { self.due = due; self.work = work }
}

private final class ClipboardTestState {
    var clock: UInt64 = 1_000_000_000
    var count = 10
    var epoch = 1
    var insideFence = false
    var reads = 0
    var snapshots = 0
    var countReads = 0
    var mutations = 0
    var mutationFences: [Bool] = []
    var work: [() -> Void] = []
    var cleanup: [() -> Void] = []
    var timers: [ClipboardTestTimer] = []
    var results: [Result<ServerReply, ServerFailure>] = []
    var onRead: (() -> Void)?
    var onSnapshot: (() -> Void)?
    var onPrepare: (() -> Void)?
    var failMutations = 0
    var snapshotOverride: ClipboardSnapshot?
    var textOverride: String?
    var items = ClipboardTestState.rich

    static var rich: [ClipboardItem] {
        [ClipboardItem(flavors: [
            ClipboardFlavor(type: "public.utf8-plain-text", data: Data("Original e\u{301} 猫🙂".utf8)),
            ClipboardFlavor(type: "public.rtf", data: Data([0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31, 0x7d])),
            ClipboardFlavor(type: "com.example.private-format", data: Data([0, 255, 1, 128])),
        ]), ClipboardItem(flavors: [ClipboardFlavor(type: "public.png", data: Data([137, 80, 78, 71, 0, 1]))])]
    }
    var text: String {
        textOverride ?? items.lazy.flatMap(\.flavors).first(where: { $0.type == "public.utf8-plain-text" })
            .flatMap { String(data: $0.data, encoding: .utf8) } ?? ""
    }
    var calls: Int { reads + snapshots + countReads + mutations }

    func userCopy(_ value: [ClipboardItem]) { count += 1; items = value }
    func drain() { while !work.isEmpty { work.removeFirst()() } }
    func drainCleanup() { while !cleanup.isEmpty { cleanup.removeFirst()() } }
    func advance(_ milliseconds: Int) {
        clock += UInt64(milliseconds) * 1_000_000
        for timer in timers.filter({ !$0.canceled && $0.due <= clock }) {
            timer.canceled = true; timer.work()
        }
    }
}

private final class ClipboardFixture {
    let state: ClipboardTestState
    let service: ClipboardService
    var session = ServerSession(id: "synthetic-clipboard-task", revision: 1, mode: "foreground", paused: false,
        approved: [], vectorPids: [], vectorWindowIds: [], overlayWindowIds: [], escStops: true,
        stopChord: "Command+Shift+Escape")

    init() {
        let state = ClipboardTestState()
        self.state = state
        service = ClipboardService(backend: ClipboardBackend(
            read: { budget in
                state.reads += 1
                let value = ClipboardText(changeCount: state.count, text: state.text)
                state.onRead?(); try budget.check()
                return value
            },
            snapshot: { budget in
                state.snapshots += 1
                let value = state.snapshotOverride ?? ClipboardSnapshot(changeCount: state.count, items: state.items, text: state.text)
                state.onSnapshot?(); try budget.check()
                return value
            },
            changeCount: { state.countReads += 1; return state.count },
            replace: { items, expected, budget, commit in
                state.onPrepare?(); try budget.check()
                return try commit {
                    try budget.check()
                    guard state.count == expected else { return ClipboardMutation(changeCount: nil, complete: false) }
                    state.mutations += 1; state.mutationFences.append(state.insideFence)
                    state.count += 1
                    if state.failMutations > 0 {
                        state.failMutations -= 1; state.items = []
                        return ClipboardMutation(changeCount: state.count, complete: false)
                    }
                    state.items = items
                    return ClipboardMutation(changeCount: state.count, complete: true)
                }
            }), execute: { state.work.append($0) }, executeCleanup: { state.cleanup.append($0) },
            schedule: { milliseconds, work in
                let timer = ClipboardTestTimer(due: state.clock + UInt64(milliseconds) * 1_000_000, work: work)
                state.timers.append(timer)
                return { timer.canceled = true }
            }, now: { state.clock })
    }
    func context(session override: ServerSession? = nil) -> OperationContext {
        let state = state, epoch = state.epoch
        return OperationContext(session: override ?? session, isCurrent: { state.epoch == epoch }, withCurrent: { body in
            guard state.epoch == epoch else { return false }
            state.insideFence = true; defer { state.insideFence = false }
            body(); return true
        })
    }
    func read(_ args: [String: JSONValue] = [:], context: OperationContext? = nil) {
        service.read(args, context: context ?? self.context()) { self.state.results.append($0) }
    }
    func args(_ text: String) -> [String: JSONValue] {
        ["text": .string(text), "sessionId": .string(session.id), "phaseRevision": .integer(Int64(session.revision ?? 0))]
    }
    func write(_ text: String, context: OperationContext? = nil) {
        service.write(args(text), context: context ?? self.context()) { self.state.results.append($0) }
    }
    func success() throws -> ServerReply {
        guard let result = state.results.last, case .success(let value) = result else {
            throw ClipboardTestFailure(message: "Expected a successful synthetic clipboard response")
        }
        return value
    }
    func failure() -> String? {
        guard let result = state.results.last, case .failure(let value) = result else { return nil }; return value.code
    }
}

/// All clipboard state, providers, ownership counters, clocks and execution queues are injected values.
/// These checks never obtain NSPasteboard.general, request OS access, invoke a provider or touch the filesystem.
func runClipboardTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let fake = ClipboardFixture()
        try clipboardCheck(fake.service.features() == ["clipboard": true] && fake.state.calls == 0,
                           "Clipboard construction and feature discovery perform no native or provider work")
    }
    try test {
        let fake = ClipboardFixture()
        fake.read(); fake.state.drain()
        try clipboardCheck(try fake.success().fields == ["text": .string("Original e\u{301} 猫🙂")] && fake.state.mutations == 0,
                           "Clipboard reads return complete exact Unicode text without changing any flavor")
        fake.state.items = [ClipboardItem(flavors: [ClipboardFlavor(type: "public.png", data: Data([1, 2]))])]
        fake.read(); fake.state.drain()
        try clipboardCheck(try fake.success().fields == ["text": .string("")], "A non-text clipboard has an empty text observation")
    }
    try test {
        let fake = ClipboardFixture(), original = ClipboardTestState.rich
        fake.write("Agent 猫\0payload"); fake.state.drain(); _ = try fake.success()
        try clipboardCheck(fake.state.items == ClipboardService.plain("Agent 猫\0payload") && fake.state.snapshots == 1,
                           "The first native write eagerly preserves every original item/type and installs only its exact text")
        fake.write("Original e\u{301} 猫🙂"); fake.state.drain(); _ = try fake.success()
        try clipboardCheck(fake.state.items == original && fake.state.snapshots == 1 && fake.state.mutations == 2,
                           "Writing the observed original text restores all rich/image/custom bytes and item order")
        try clipboardCheck(fake.state.mutationFences.allSatisfy { $0 }, "Every request mutation shares the current phase fence")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("First"); fake.state.drain()
        fake.session.revision = 2; fake.state.epoch += 1
        fake.write("Second"); fake.state.drain(); _ = try fake.success()
        var restored: Bool?
        fake.service.cleanup { restored = $0 }
        try clipboardCheck(restored == nil && fake.state.text == "Second", "Lifecycle cleanup is asynchronous and ordinary phase changes do not restore early")
        fake.state.drainCleanup()
        try clipboardCheck(restored == true && fake.state.items == ClipboardTestState.rich && fake.state.snapshots == 1,
                           "Successive writes in one task retain one original baseline across native phase revisions")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Agent text"); fake.state.drain()
        let user = ClipboardService.plain("Agent text") + [ClipboardItem(flavors: [ClipboardFlavor(type: "public.png", data: Data([99]))])]
        fake.state.userCopy(user)
        let mutations = fake.state.mutations
        fake.service.cleanup(); fake.state.drainCleanup()
        try clipboardCheck(fake.state.items == user && fake.state.mutations == mutations,
                           "A genuine user copy is never restored over, even when its plain text equals the agent's")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Agent text"); fake.state.drain()
        let user = ClipboardService.plain("User copied during restore preparation")
        fake.state.onPrepare = { fake.state.userCopy(user); fake.state.onPrepare = nil }
        fake.service.cleanup(); fake.state.drainCleanup()
        try clipboardCheck(fake.state.items == user && fake.state.mutations == 1,
                           "The final changeCount comparison refuses restoration after a copy arriving during preparation")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Agent text"); fake.state.drain()
        let user = ClipboardService.plain("User clipboard")
        fake.state.userCopy(user)
        fake.write("Original e\u{301} 猫🙂"); fake.state.drain(); fake.state.drainCleanup()
        try clipboardCheck(fake.failure() == "changed" && fake.state.items == user && fake.state.mutations == 1,
                           "An explicit original-text restore cannot adopt a clipboard changed by another owner")
    }
    try test {
        let fake = ClipboardFixture()
        fake.state.onSnapshot = { fake.state.userCopy(ClipboardService.plain("New user copy")) }
        fake.write("Agent text"); fake.state.drain()
        try clipboardCheck(fake.failure() == "changed" && fake.state.text == "New user copy" && fake.state.mutations == 0,
                           "A copy during snapshot materialization invalidates the write before ownership changes")
    }
    try test {
        let fake = ClipboardFixture()
        fake.state.onPrepare = { fake.state.epoch += 1 }
        fake.write("Agent text"); fake.state.drain()
        try clipboardCheck(fake.failure() == "changed" && fake.state.mutations == 0 && fake.state.items == ClipboardTestState.rich,
                           "Revocation during provider-free object preparation prevents a late clipboard mutation")
    }
    try test {
        let fake = ClipboardFixture()
        fake.state.onRead = { fake.state.epoch += 1 }
        fake.read(); fake.state.drain()
        try clipboardCheck(fake.failure() == "changed" && fake.state.results.count == 1,
                           "A stale clipboard read cannot return its private text after authority changes")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Queued agent write")
        var closed: Bool?
        fake.service.close { closed = $0 }
        fake.state.drain(); fake.state.drainCleanup()
        fake.read()
        try clipboardCheck(closed == true && fake.state.snapshots == 0 && fake.state.mutations == 0 && fake.failure() == "changed",
                           "Close cancels queued reads/writes without starting providers or reviving authority")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Agent text"); fake.state.drain()
        fake.state.epoch += 1
        var closed: Bool?
        fake.service.close { closed = $0 }; fake.state.drainCleanup()
        try clipboardCheck(closed == true && fake.state.items == ClipboardTestState.rich,
                           "Graceful close restores only its owned snapshot without borrowing a new session or grant")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Agent text"); fake.state.drain()
        fake.session = ServerSession(id: "different-task", revision: 1, mode: "foreground", paused: false,
            approved: [], vectorPids: [], vectorWindowIds: [], overlayWindowIds: [], escStops: true, stopChord: "Command+Shift+Escape")
        fake.write("Successor"); fake.state.drain(); fake.state.drainCleanup()
        try clipboardCheck(fake.failure() == "changed" && fake.state.items == ClipboardTestState.rich,
                           "A successor task cannot inherit or overwrite a prior task's clipboard loan")
    }
    try test {
        let fake = ClipboardFixture()
        fake.read(); fake.state.advance(ClipboardLimits.operationMs)
        try clipboardCheck(fake.failure() == "timeout" && fake.state.results.count == 1, "A provider deadline replies independently of its worker queue")
        fake.read()
        try clipboardCheck(fake.failure() == "busy" && fake.state.work.count == 1,
                           "A timed-out provider occupies one bounded slot and cannot create more queued workers")
        fake.state.drain(); fake.state.drainCleanup()
        try clipboardCheck(fake.state.reads == 0, "A provider whose queued admission timed out is never invoked")
        fake.read(); fake.state.drain(); _ = try fake.success()
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Agent text"); fake.state.drain()
        fake.state.failMutations = 1
        fake.service.cleanup(); fake.state.drainCleanup()
        fake.state.epoch += 1
        fake.write("Successor with the same wire ID"); fake.state.drain(); fake.state.drainCleanup()
        try clipboardCheck(fake.failure() == "changed" && fake.state.items == ClipboardTestState.rich && fake.state.mutations == 3,
                           "A failed replacement cleanup cannot lend an old clipboard snapshot to a new authority reusing its session ID")
    }
    try test {
        let fake = ClipboardFixture()
        fake.state.onRead = {
            fake.state.advance(ClipboardLimits.operationMs)
            fake.read()
            fake.state.onRead = nil
        }
        fake.read(); fake.state.drain(); fake.state.drainCleanup()
        try clipboardCheck(fake.state.results.count == 2 && fake.state.reads == 1 && fake.state.mutations == 0,
                           "An in-flight provider's late data cannot emit another reply or create a second provider")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Agent text"); fake.state.drain()
        var restoredWhileReadWasRunning = false
        fake.state.onRead = {
            fake.service.cleanup(); fake.state.drainCleanup()
            restoredWhileReadWasRunning = fake.state.items == ClipboardTestState.rich
            fake.state.onRead = nil
        }
        fake.read(); fake.state.drain()
        try clipboardCheck(restoredWhileReadWasRunning && fake.failure() == "changed",
                           "Cleanup of owned eager bytes is independent of a blocked provider/read worker")
    }
    try test {
        let fake = ClipboardFixture()
        fake.state.failMutations = 1
        fake.write("Agent text"); fake.state.drain(); fake.state.drainCleanup()
        try clipboardCheck(fake.failure() != nil && fake.state.items == ClipboardTestState.rich && fake.state.mutations == 2,
                           "A failed write retains the original snapshot and repairs its own empty/partial pasteboard")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Agent text"); fake.state.drain()
        fake.state.failMutations = 1
        var first: Bool?, second: Bool?
        fake.service.cleanup { first = $0 }; fake.state.drainCleanup()
        fake.service.cleanup { second = $0 }; fake.state.drainCleanup()
        try clipboardCheck(first == false && second == true && fake.state.items == ClipboardTestState.rich,
                           "Failed restoration keeps the newly owned partial count for a later bounded cleanup attempt")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write("Agent text"); fake.state.drain()
        var results: [Bool] = []
        fake.service.cleanup { results.append($0) }
        fake.state.advance(ClipboardLimits.cleanupMs)
        fake.state.drainCleanup()
        try clipboardCheck(results == [false] && fake.state.text == "Agent text" && fake.state.mutations == 1,
                           "A cleanup queued beyond its absolute deadline cannot perform a late restore or duplicate its callback")
        fake.service.cleanup { results.append($0) }; fake.state.drainCleanup()
        try clipboardCheck(results == [false, true] && fake.state.items == ClipboardTestState.rich,
                           "A later explicit cleanup can retry only the still-owned clipboard snapshot")
    }
    try test {
        let fake = ClipboardFixture()
        fake.session.mode = "background"
        fake.write("Agent text")
        try clipboardCheck(fake.failure() == "needs_foreground" && fake.state.calls == 0,
                           "Background mode never mutates or snapshots the user's clipboard")
        fake.session.mode = "foreground"; fake.session.paused = true
        fake.write("Agent text")
        try clipboardCheck(fake.failure() == "paused" && fake.state.calls == 0, "Paused phases cannot write the clipboard")
    }
    try test {
        let fake = ClipboardFixture()
        let noSession = OperationContext(session: nil, isCurrent: { true }, withCurrent: { body in body(); return true })
        fake.read(context: noSession); fake.write("Text", context: noSession)
        var extra = fake.args("Text"); extra["restore"] = .bool(true)
        fake.service.write(extra, context: fake.context()) { fake.state.results.append($0) }
        fake.read(["text": .string("Unexpected")])
        fake.service.write(["text": .string("Text"), "sessionId": .string(fake.session.id), "phaseRevision": .number(1.5)],
            context: fake.context()) { fake.state.results.append($0) }
        try clipboardCheck(fake.state.calls == 0 && fake.state.results.allSatisfy { if case .failure = $0 { return true }; return false },
                           "No-session, invented restore arguments, fractional phases and malformed reads fail without native access")
    }
    try test {
        let fake = ClipboardFixture()
        fake.write(String(repeating: "🙂", count: ClipboardLimits.textUnits / 2 + 1))
        try clipboardCheck(fake.failure() == "failed" && fake.state.calls == 0, "The wire text limit counts UTF16 units rather than graphemes")
        fake.write(String(repeating: "a", count: ClipboardLimits.textUnits)); fake.state.drain(); _ = try fake.success()
        try clipboardCheck(fake.state.text.utf16.count == ClipboardLimits.textUnits, "The complete wire text boundary is usable without truncation")
    }
    try test {
        let flavor = ClipboardFlavor(type: "com.example.data", data: Data([1]))
        let invalid: [ClipboardSnapshot] = [
            ClipboardSnapshot(changeCount: 1, items: Array(repeating: ClipboardItem(flavors: [flavor]), count: ClipboardLimits.items + 1), text: ""),
            ClipboardSnapshot(changeCount: 1, items: [ClipboardItem(flavors: (0...ClipboardLimits.flavors).map {
                ClipboardFlavor(type: "com.example.data-\($0)", data: Data([1]))
            })], text: ""),
            ClipboardSnapshot(changeCount: 1, items: [ClipboardItem(flavors: [flavor, flavor])], text: ""),
            ClipboardSnapshot(changeCount: 1, items: [ClipboardItem(flavors: [ClipboardFlavor(type: "com.apple.pasteboard.promised-file-url", data: Data())])], text: ""),
            ClipboardSnapshot(changeCount: 1, items: [ClipboardItem(flavors: [])], text: ""),
            ClipboardSnapshot(changeCount: 1, items: [ClipboardItem(flavors: [ClipboardFlavor(type: "com.example.data", data: Data(repeating: 0, count: ClipboardLimits.bytes + 1))])], text: ""),
        ]
        for snapshot in invalid {
            let fake = ClipboardFixture(); fake.state.snapshotOverride = snapshot
            fake.write("Agent text"); fake.state.drain()
            try clipboardCheck(fake.failure() != nil && fake.state.mutations == 0,
                               "Oversized, promised, duplicate or incomplete flavors are refused before replacing private clipboard data")
        }
    }
    try test {
        let fake = ClipboardFixture()
        fake.state.items = [ClipboardItem(flavors: [ClipboardFlavor(type: "public.png", data: Data(repeating: 1, count: ClipboardLimits.bytes))])]
        let original = fake.state.items
        fake.write("Agent text"); fake.state.drain(); _ = try fake.success()
        fake.write(""); fake.state.drain(); _ = try fake.success()
        try clipboardCheck(fake.state.items == original, "An image-only clipboard at the exact byte bound restores through an explicit empty original text")
    }

    try test {
        let original = ClipboardTestState.rich
        var reads: [String] = []
        let sources = original.map { item in ClipboardSourceItem(types: item.flavors.map(\.type), data: { type in
            reads.append(type); return item.flavors.first(where: { $0.type == type })?.data
        }) }
        let budget = ClipboardBudget(deadline: 2, now: { 1 }, current: { true })
        let value = try ClipboardSnapshotReader.read(changeCount: 7, items: sources, budget: budget,
            currentCount: { 7 }, currentCatalog: { original.map { $0.flavors.map(\.type) } }, text: { "Original e\u{301} 猫🙂" })
        try clipboardCheck(value.items == original && reads.count == 4,
                           "The actual materialization loop preserves every eagerly copied flavor exactly once")
    }
    try test {
        var catalog = [["public.utf8-plain-text"]]
        let sources = [ClipboardSourceItem(types: catalog[0], data: { _ in
            catalog[0].append("com.example.late-type"); return Data("Original".utf8)
        })]
        let failure = clipboardFailure {
            _ = try ClipboardSnapshotReader.read(changeCount: 7, items: sources,
                budget: ClipboardBudget(deadline: 2, now: { 1 }, current: { true }), currentCount: { 7 },
                currentCatalog: { catalog }, text: { "Original" })
        }
        try clipboardCheck(failure == "changed", "A provider expanding its flavor catalog without a new changeCount cannot produce a lossless snapshot")
    }
    try test {
        var reads = 0
        let types = (0...ClipboardLimits.flavors).map { "com.example.flavor-\($0)" }
        let failure = clipboardFailure {
            _ = try ClipboardSnapshotReader.read(changeCount: 7,
                items: [ClipboardSourceItem(types: types, data: { _ in reads += 1; return Data() })],
                budget: ClipboardBudget(deadline: 2, now: { 1 }, current: { true }), currentCount: { 7 },
                currentCatalog: { [types] }, text: { "" })
        }
        try clipboardCheck(failure == "unavailable" && reads == 0, "Provider/type limits are checked before invoking any promised or expensive data source")
    }
    try test {
        for value in [Data?.none, Data(repeating: 1, count: ClipboardLimits.bytes + 1)] {
            let failure = clipboardFailure {
                _ = try ClipboardSnapshotReader.read(changeCount: 7,
                    items: [ClipboardSourceItem(types: ["public.png"], data: { _ in value })],
                    budget: ClipboardBudget(deadline: 2, now: { 1 }, current: { true }), currentCount: { 7 },
                    currentCatalog: { [["public.png"]] }, text: { "" })
            }
            try clipboardCheck(failure == "unavailable", "Missing or oversized provider bytes fail before a partial snapshot can authorize any write")
        }
    }
    try test {
        var clock: UInt64 = 1, reads = 0, textReads = 0
        let failure = clipboardFailure {
            _ = try ClipboardSnapshotReader.read(changeCount: 7,
                items: [ClipboardSourceItem(types: ["public.png", "public.rtf"], data: { _ in
                    reads += 1; clock = 2; return Data([1])
                })], budget: ClipboardBudget(deadline: 2, now: { clock }, current: { true }), currentCount: { 7 },
                currentCatalog: { [["public.png", "public.rtf"]] }, text: { textReads += 1; return "" })
        }
        try clipboardCheck(failure == "timeout" && reads == 1 && textReads == 0,
                           "A provider returning after its deadline cannot trigger more providers or a private text read")
    }
    try test {
        var current = true, reads = 0
        let failure = clipboardFailure {
            _ = try ClipboardSnapshotReader.read(changeCount: 7,
                items: [ClipboardSourceItem(types: ["public.png", "public.rtf"], data: { _ in
                    reads += 1; current = false; return Data([1])
                })], budget: ClipboardBudget(deadline: 2, now: { 1 }, current: { current }), currentCount: { 7 },
                currentCatalog: { [["public.png", "public.rtf"]] }, text: { "" })
        }
        try clipboardCheck(failure == "changed" && reads == 1, "A revoked provider result cannot be retained or followed by another content read")
    }

    return count
}
