import CoreGraphics
import Foundation

private struct HeldInputTestFailure: Error { let message: String }

private func heldCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw HeldInputTestFailure(message: message) }
}

private func heldThrows(_ code: String, _ body: () throws -> Void) throws {
    do { try body() }
    catch let failure as ServerFailure {
        try heldCheck(failure.code == code, "Expected \(code), received \(failure.code).")
        return
    }
    throw HeldInputTestFailure(message: "Expected held-input refusal \(code).")
}

private func heldProcess(start: UInt64 = 10) -> HelperProcessIdentity {
    HelperProcessIdentity(pid: 101, parentPID: 100, startSeconds: start, startMicroseconds: 20,
                          executable: "/virtual/Test.app/Contents/MacOS/Test")
}

private func heldKey(_ code: UInt16 = 7) -> InputPostedEvent {
    InputPostedEvent(kind: .keyUp, keyCode: code, flags: 0x100000, destination: heldProcess(), tag: 123)
}

private func heldButton(_ point: CGPoint = CGPoint(x: -100, y: -50)) -> InputPostedEvent {
    InputPostedEvent(kind: .buttonUp, point: point, button: 0, flags: 0, tag: 123)
}

private final class HeldState {
    var time: UInt64 = 0
    var ups: [InputPostedEvent] = []
    var log: [String] = []
    var outcome = InputReleaseOutcome.released
    var onRelease: ((InputPostedEvent) -> InputReleaseOutcome)?
}

private final class HeldFixture {
    let state: HeldState
    let journal: HeldInputJournal

    init() {
        let state = HeldState()
        self.state = state
        journal = HeldInputJournal(release: { event in
            state.ups.append(event)
            state.log.append("up:\(event.keyCode)")
            return state.onRelease?(event) ?? state.outcome
        }, now: { state.time })
    }

    func press(_ lease: HeldInputLease, id: String = "key", up: InputPostedEvent = heldKey()) throws {
        try journal.press(lease: lease, id: id, up: up) {
            self.state.log.append("down:\(up.keyCode)")
            return true
        }
    }
}

/// Only injected posts, release outcomes and clocks run here. No OS input or physical-state query is possible.
func runHeldInputTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        let up = heldKey()
        try fixture.press(lease, up: up)
        try heldCheck(fixture.journal.release(lease: lease) == 1 && fixture.state.ups == [up],
                      "A press must retain its exact matching up, including private process, flags and tag.")
        try heldCheck(fixture.journal.release(lease: lease) == 0 && fixture.journal.releaseAll() == 0 && fixture.state.ups.count == 1,
                      "A successful matching up must be posted exactly once.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        let modifier = heldKey(55), key = heldKey(8), button = heldButton()
        try fixture.press(lease, id: "modifier", up: modifier)
        try fixture.press(lease, id: "key", up: key)
        try fixture.press(lease, id: "button", up: button)
        try heldCheck(fixture.journal.releaseAll() == 3 && fixture.state.ups == [button, key, modifier],
                      "Buttons, keys and modifiers must release in reverse actual down order.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try fixture.press(lease)
        try fixture.press(lease)
        try heldCheck(fixture.state.log == ["down:7", "down:7"] && fixture.journal.release(lease: lease) == 1,
                      "A repeated down with the same identity must need only one final up.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try heldThrows("failed") { try fixture.journal.press(lease: lease, id: "key", up: heldKey(), post: { false }) }
        try heldCheck(fixture.journal.release(lease: lease) == 0 && fixture.state.ups.isEmpty,
                      "A definite no-post must remove only its newly reserved release.")
        _ = try fixture.journal.begin()
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try fixture.press(lease)
        try heldThrows("failed") { try fixture.journal.press(lease: lease, id: "key", up: heldKey(), post: { false }) }
        try heldCheck(fixture.journal.releaseAll() == 1, "A failed repeated post must retain the earlier successful down.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try heldThrows("unavailable") {
            try fixture.journal.press(lease: lease, id: "key", up: heldKey()) {
                throw ServerFailure(code: "unavailable", message: "Synthetic uncertain post.")
            }
        }
        try heldThrows("unavailable") { _ = try fixture.journal.begin() }
        try heldCheck(fixture.journal.releaseAll() == 1 && fixture.state.ups == [heldKey()],
                      "An uncertain thrown post must retain a matching up until cleanup succeeds.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try fixture.press(lease)
        fixture.state.outcome = .retry
        try heldCheck(fixture.journal.releaseAll() == 0 && fixture.state.ups.count == 1, "A failed up must remain owned.")
        try heldThrows("unavailable") { _ = try fixture.journal.begin() }
        fixture.state.outcome = .released
        try heldCheck(fixture.journal.releaseAll() == 1 && fixture.state.ups.count == 2,
                      "A later cleanup must retry the retained original up.")
        _ = try fixture.journal.begin()
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        let original = heldKey()
        try fixture.press(lease, up: original)
        fixture.state.onRelease = { event in
            event.destination == heldProcess(start: 11) ? .released : .discarded
        }
        try heldCheck(fixture.journal.releaseAll() == 0 && fixture.state.ups == [original],
                      "The release adapter receives the original process witness and can discard a dead/reused target without retargeting.")
        _ = try fixture.journal.begin()
        try heldCheck(fixture.journal.releaseAll() == 0, "A safely discarded dead-target record must not be resurrected.")
    }
    try test {
        let fixture = HeldFixture()
        let old = try fixture.journal.begin()
        try fixture.press(old)
        _ = fixture.journal.releaseAll()
        let next = try fixture.journal.begin()
        try fixture.press(next, id: "next", up: heldKey(8))
        try heldCheck(fixture.journal.release(lease: old) == 0, "An old callback must not release a successor's keys.")
        try fixture.press(next, id: "next", up: heldKey(8))
        try heldCheck(fixture.journal.release(lease: next) == 1 && fixture.state.ups.last == heldKey(8),
                      "An old cleanup must not invalidate a newer lease.")
        var posted = false
        try heldThrows("changed") { try fixture.journal.press(lease: old, id: "late", up: heldKey()) { posted = true; return true } }
        try heldCheck(!posted, "Revoked leases must reject late downs before their post callback.")
    }
    try test {
        let fixture = HeldFixture()
        let old = try fixture.journal.begin()
        let next = try fixture.journal.begin()
        var posted = false
        try heldThrows("changed") { try fixture.journal.press(lease: old, id: "old", up: heldKey()) { posted = true; return true } }
        try heldCheck(!posted, "Beginning a successor must invalidate even an empty prior lease.")
        try fixture.press(next)
        _ = fixture.journal.releaseAll()
    }
    try test {
        let fixture = HeldFixture()
        let foreign = try HeldFixture().journal.begin()
        let own = try fixture.journal.begin()
        try fixture.press(own)
        try heldThrows("changed") { try fixture.press(foreign, id: "foreign") }
        try heldCheck(fixture.journal.release(lease: foreign) == 0 && fixture.journal.release(lease: own) == 1,
                      "A lease from another worker must never address this worker's held events.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try heldThrows("changed") {
            try fixture.journal.press(lease: lease, id: "key", up: heldKey()) {
                fixture.state.log.append("down:7")
                _ = fixture.journal.releaseAll()
                return true
            }
        }
        try heldCheck(fixture.state.log == ["down:7", "up:7"] && fixture.journal.releaseAll() == 0,
                      "Cancellation immediately after a native post must observe its down and release it once.")
        var late = false
        try heldThrows("changed") { try fixture.journal.press(lease: lease, id: "late", up: heldKey()) { late = true; return true } }
        try heldCheck(!late, "A completed late post callback must never reopen its revoked lease.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        for index in 0..<32 { try fixture.press(lease, id: "key-\(index)", up: heldKey(UInt16(index))) }
        var extra = false
        try heldThrows("unavailable") { try fixture.journal.press(lease: lease, id: "extra", up: heldKey()) { extra = true; return true } }
        fixture.state.outcome = .retry
        try heldCheck(!extra && fixture.journal.releaseAll() == 0 && fixture.state.ups.count == 32,
                      "A fixed clock and persistent failures must still perform only one bounded32-entry cleanup pass.")
        fixture.state.outcome = .released
        try heldCheck(fixture.journal.releaseAll() == 32, "The bounded retry state must retain all original matching ups.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        for code in UInt16(1)...5 { try fixture.press(lease, id: "key-\(code)", up: heldKey(code)) }
        fixture.state.onRelease = { _ in fixture.state.time += 100_000_000; return .released }
        try heldCheck(fixture.journal.releaseAll(deadlineMs: Int.max) == 3 && fixture.state.ups.map(\.keyCode) == [5, 4, 3],
                      "Caller deadlines must be capped300ms and checked between each reverse-order release.")
        try heldThrows("unavailable") { _ = try fixture.journal.begin() }
        fixture.state.onRelease = nil
        try heldCheck(fixture.journal.releaseAll() == 2 && fixture.state.ups.map(\.keyCode) == [5, 4, 3, 2, 1],
                      "Deadline-exhausted releases must remain in their original cleanup order.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try fixture.press(lease)
        try heldCheck(fixture.journal.releaseAll(deadlineMs: -1) == 0 && fixture.state.ups.isEmpty,
                      "A zero budget must invalidate authority without starting an unbounded cleanup callback.")
        var late = false
        try heldThrows("changed") { try fixture.journal.press(lease: lease, id: "late", up: heldKey()) { late = true; return true } }
        try heldCheck(!late && fixture.journal.releaseAll() == 1, "A deferred release remains owned after immediate cancellation.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        var callbacks = 0
        for id in ["", "bad\0id", String(repeating: "a", count: 257)] {
            try heldThrows("failed") { try fixture.journal.press(lease: lease, id: id, up: heldKey()) { callbacks += 1; return true } }
        }
        var invalid = [InputPostedEvent(kind: .keyDown), InputPostedEvent(kind: .buttonDown), InputPostedEvent(kind: .move),
                       InputPostedEvent(kind: .scroll), InputPostedEvent(kind: .keyUp),
                       InputPostedEvent(kind: .unicodeUp, unicode: Array(repeating: 65, count: 21), destination: heldProcess()),
                       heldButton(CGPoint(x: Double.nan, y: 0))]
        var badButton = heldButton(); badButton.button = 3; invalid.append(badButton)
        for up in invalid {
            try heldThrows("failed") { try fixture.journal.press(lease: lease, id: "invalid", up: up) { callbacks += 1; return true } }
        }
        try heldCheck(callbacks == 0 && fixture.journal.releaseAll() == 0,
                      "Invalid release descriptors must never grant a fresh post or fabricate cleanup events.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        let old = heldButton()
        let moved = heldButton(CGPoint(x: -80, y: -30))
        try fixture.press(lease, id: "button", up: old)
        try fixture.journal.update(lease: lease, id: "button", up: moved, post: { true })
        try heldCheck(fixture.journal.release(lease: lease) == 1 && fixture.state.ups == [moved],
                      "A successfully posted owned drag move must update the matching up's final location.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        let old = heldButton()
        try fixture.press(lease, id: "button", up: old)
        try heldThrows("failed") { try fixture.journal.update(lease: lease, id: "button", up: heldButton(CGPoint(x: 10, y: 20)), post: { false }) }
        try heldCheck(fixture.journal.releaseAll() == 1 && fixture.state.ups == [old],
                      "A definite failed drag move must retain its last actually posted release location.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        let attempted = heldButton(CGPoint(x: 10, y: 20))
        try fixture.press(lease, id: "button", up: heldButton())
        try heldThrows("unavailable") {
            try fixture.journal.update(lease: lease, id: "button", up: attempted) {
                throw ServerFailure(code: "unavailable", message: "Synthetic uncertain move.")
            }
        }
        try heldCheck(fixture.journal.releaseAll() == 1 && fixture.state.ups == [attempted],
                      "An uncertain owned drag move must retain the attempted location for a safe matching up.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        let old = heldButton()
        try fixture.press(lease, id: "button", up: old)
        var changedButton = old; changedButton.button = 1
        var changedFlags = old; changedFlags.flags = 1
        var changedTag = old; changedTag.tag = 999
        var changedTarget = old; changedTarget.destination = heldProcess(start: 11)
        var changedKey = old; changedKey.keyCode = 7
        var posted = false
        for up in [changedButton, changedFlags, changedTag, changedTarget, changedKey, heldKey()] {
            try heldThrows("failed") { try fixture.journal.update(lease: lease, id: "button", up: up) { posted = true; return true } }
        }
        try heldCheck(!posted && fixture.journal.releaseAll() == 1 && fixture.state.ups == [old],
                      "Updating a drag must never change its button, flags, tag, key or private destination.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        let moved = heldButton(CGPoint(x: -70, y: -20))
        try fixture.press(lease, id: "button", up: heldButton())
        try heldThrows("changed") {
            try fixture.journal.update(lease: lease, id: "button", up: moved) {
                fixture.state.log.append("drag")
                _ = fixture.journal.releaseAll()
                return true
            }
        }
        try heldCheck(fixture.state.ups == [moved] && fixture.journal.releaseAll() == 0,
                      "Cancellation immediately after a drag must release its attempted owned point without a late move.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try fixture.press(lease)
        var nested = -1
        var denied = false
        fixture.state.onRelease = { _ in
            nested = fixture.journal.releaseAll()
            do { _ = try fixture.journal.begin() } catch { denied = true }
            return .released
        }
        try heldCheck(fixture.journal.releaseAll() == 1 && nested == 0 && denied && fixture.state.ups.count == 1,
                      "Reentrant cleanup must not duplicate ups or admit fresh downs during release.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try fixture.press(lease)
        fixture.state.outcome = .retry
        try heldCheck(fixture.journal.close() == 0, "Close must retain a failed up for bounded later cleanup.")
        fixture.state.outcome = .released
        try heldCheck(fixture.journal.close() == 1 && fixture.journal.close() == 0,
                      "Closed journals must allow matching releases and retire successful ups once.")
        try heldThrows("unavailable") { _ = try fixture.journal.begin() }
        try heldThrows("changed") { try fixture.press(lease) }
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        for code in UInt16(1)...3 {
            try fixture.press(lease, id: "repeat", up: heldKey(code))
            try heldCheck(fixture.journal.lift(lease: lease, id: "repeat"), "A successful lift must permit the next repeat on the same lease.")
        }
        try heldCheck(fixture.state.ups.map(\.keyCode) == [1, 2, 3] && fixture.journal.release(lease: lease) == 0,
                      "Repeated/chunked input must lift every key without minting fresh authority between chunks.")
        var posted = false
        try heldThrows("changed") { try fixture.journal.post(lease: lease) { posted = true; return true } }
        try heldCheck(!posted, "The operation's final release must invalidate the shared lease.")
    }
    try test {
        let fixture = HeldFixture()
        let old = try fixture.journal.begin()
        try fixture.press(old)
        fixture.state.outcome = .retry
        try heldCheck(!fixture.journal.lift(lease: old, id: "key"), "A failed up must report incomplete lift and retain its key.")
        _ = fixture.journal.releaseAll()
        fixture.state.outcome = .released
        try heldCheck(fixture.journal.lift(lease: old, id: "key"), "A revoked lease may still release its own retained key.")
        let next = try fixture.journal.begin()
        try fixture.press(next)
        let before = fixture.state.ups.count
        try heldCheck(fixture.journal.lift(lease: old, id: "key") && fixture.state.ups.count == before,
                      "A stale lift must never address a successor's reused journal ID.")
        try heldCheck(fixture.journal.release(lease: next) == 1, "The successor must retain its own matching up.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        var posts = 0
        try fixture.journal.post(lease: lease) { posts += 1; return true }
        try heldThrows("failed") { try fixture.journal.post(lease: lease) { false } }
        try heldThrows("changed") {
            try fixture.journal.post(lease: lease) { posts += 1; _ = fixture.journal.releaseAll(); return true }
        }
        try heldThrows("changed") { try fixture.journal.post(lease: lease) { posts += 1; return true } }
        try heldCheck(posts == 2 && fixture.state.ups.isEmpty,
                      "Moves/scrolls must share the cancellation fence without inventing held events.")
    }
    try test {
        let fixture = HeldFixture()
        let lease = try fixture.journal.begin()
        try heldCheck(!fixture.journal.pending(lease: lease), "An unused lease must have no pending release.")
        try fixture.press(lease)
        fixture.state.outcome = .retry
        _ = fixture.journal.release(lease: lease)
        try heldCheck(fixture.journal.pending(lease: lease), "A failed final hold release must remain observable so the operation cannot report success.")
        fixture.state.outcome = .released
        _ = fixture.journal.releaseAll()
        try heldCheck(!fixture.journal.pending(lease: lease), "A successful matching up must clear the pending-release witness.")
    }
    return count
}
