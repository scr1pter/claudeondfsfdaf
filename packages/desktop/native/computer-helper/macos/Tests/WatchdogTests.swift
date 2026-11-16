import Foundation

private struct WatchdogTestFailure: Error { let message: String }
private func watchdogCheck(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw WatchdogTestFailure(message: message) }
}
private final class WatchdogTestTimer {
    let due: UInt64
    let work: () -> Void
    var canceled = false
    init(due: UInt64, work: @escaping () -> Void) { self.due = due; self.work = work }
}
private final class WatchdogTestState {
    var clock: UInt64 = 1_000_000_000
    var current: ServerSession? = ServerSession(id: "watchdog-task", revision: 1, mode: "foreground", paused: false,
        approved: [], vectorPids: [], vectorWindowIds: [], overlayWindowIds: [], escStops: true,
        stopChord: "Command+Shift+Escape")
    var native = WatchdogNativeState(locked: false, consoleActive: true, screensaver: false, secureInput: false, holder: nil)
    var tap = EventTapStatus(generation: 1, installed: true, enabled: true)
    var bindToCurrent = true
    var work: [() -> Void] = []
    var timers: [WatchdogTestTimer] = []
    var events: [Event] = []
    var scopes: [UUID?] = []
    var trace: [String] = []
    var environments: [WatchdogAvailability] = []
    var probes: [UInt64] = []
    var pauseReasons: [String] = []
    var pauseAccepts = true
    var reads = 0
    var observations = 0
    var removals = 0
    var recoveries = 0
    var hint: ((WatchdogHint) -> Void)?
    var onProbe: ((UInt64) -> Void)?
    var onSample: (() -> Void)?
    var onPause: (() -> Void)?

    func drain() { while !work.isEmpty { work.removeFirst()() } }
    func advance(_ milliseconds: Int, drain: Bool = true) {
        let target = clock + UInt64(milliseconds) * 1_000_000
        var turns = 0
        while let next = timers.filter({ !$0.canceled && $0.due <= target }).min(by: { $0.due < $1.due }) {
            turns += 1; precondition(turns < 10_000, "Synthetic watchdog timers must remain bounded")
            clock = next.due; next.canceled = true; next.work()
            if drain { self.drain() }
        }
        clock = target
    }
    var detection: [Event] { events.filter { $0.value["event"]?.stringValue == "input_detection" } }
    var lockEvents: [Bool] { events.filter { $0.value["event"]?.stringValue == "locked" }.compactMap { $0.value["locked"]?.boolValue } }
    func status(challenge: UInt64? = nil, generation: UInt64? = nil) -> EventTapStatus {
        EventTapStatus(generation: generation ?? tap.generation, installed: tap.installed, enabled: tap.enabled,
            challenge: challenge, bindingReady: tap.bindingReady,
            bindingEpoch: bindToCurrent ? current?.observationEpoch : tap.bindingEpoch)
    }
}

private final class WatchdogFixture {
    let state: WatchdogTestState
    let service: WatchdogService
    init(inline: Bool = false) {
        let state = WatchdogTestState(); self.state = state
        service = WatchdogService(session: { state.current }, tapStatus: { state.status() },
            recoverTap: { state.recoveries += 1 }, probeTap: { state.probes.append($0); state.onProbe?($0) },
            pause: { expected, reason in
                guard state.current?.observationEpoch == expected.observationEpoch, state.pauseAccepts else { return false }
                state.pauseReasons.append(reason); state.trace.append("pause:" + reason)
                state.current?.paused = true; state.current?.escStops = false; state.onPause?(); return true
            }, emit: { event, expected in
                state.events.append(event); state.scopes.append(expected?.observationEpoch)
                state.trace.append("event:" + (event.value["event"]?.stringValue ?? ""))
            }, backend: WatchdogBackend(sample: {
                state.reads += 1; let value = state.native; state.onSample?(); return value
            }, observe: { callback in
                state.observations += 1; state.hint = callback
                return { state.removals += 1; state.hint = nil }
            }), environmentChanged: { state.environments.append($0) },
            execute: { if inline { $0() } else { state.work.append($0) } },
            schedule: { milliseconds, work in
                let timer = WatchdogTestTimer(due: state.clock + UInt64(milliseconds) * 1_000_000, work: work)
                state.timers.append(timer); return { timer.canceled = true }
            }, now: { state.clock })
    }
    func start(healthy: Bool = true) {
        service.start(); state.drain()
        if healthy { reply() }
    }
    func reply(_ challenge: UInt64? = nil, generation: UInt64? = nil) {
        guard let id = challenge ?? state.probes.last else { return }
        service.observeTap(state.status(challenge: id, generation: generation))
    }
    func automaticReplies() {
        state.onProbe = { [weak service, weak state] id in
            guard let state else { return }
            service?.observeTap(state.status(challenge: id))
        }
    }
    func sample(_ value: WatchdogNativeState) {
        state.native = value; state.advance(250)
    }
}

/// Native values, queues, observers, clock, loop challenges and all process identities are injected.
/// No test installs a tap, queries CGSession/IORegistry, observes real applications or touches protected content.
func runWatchdogTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }
    let unlocked: [String: JSONValue] = ["uid": .integer(501), "onConsole": .bool(true), "loginDone": .bool(true), "locked": .bool(false)]
    let absent = unlocked.filter { $0.key != "locked" }
    func coherent(_ session: [String: JSONValue]?, root: JSONValue?, users: [[String: JSONValue]]?) -> WatchdogNativeState {
        let registry = WatchdogConsoleSnapshot(rootLocked: root, users: users)
        return .decode(session: session, after: session, registry: registry, registryAfter: registry, uid: 501)
    }

    try test {
        let fake = WatchdogFixture()
        try watchdogCheck(fake.state.reads == 0 && fake.state.observations == 0 && fake.state.timers.isEmpty &&
                          fake.service.availability() == .unknown, "Watchdog construction performs no OS work, observer registration or scheduling")
        fake.service.close(); fake.service.start()
        try watchdogCheck(fake.state.observations == 0, "A closed inert watchdog cannot be restarted")
    }
    try test {
        try watchdogCheck(WatchdogNativeState.decode(session: unlocked, console: nil, uid: 501).availability == .available,
                          "Exact typed same-user CGSession observations establish an unlocked console")
        let invalid: [[String: JSONValue]?] = [nil, [:], ["uid": .integer(502)],
            ["uid": .integer(501), "onConsole": .integer(1), "loginDone": .bool(true), "locked": .bool(false)]]
        for value in invalid {
            try watchdogCheck(WatchdogNativeState.decode(session: value, console: nil, uid: 501).availability == .unknown,
                              "Missing, foreign-user or wrongly typed CGSession facts fail closed")
        }
    }
    try test {
        var absent = unlocked; absent.removeValue(forKey: "locked")
        try watchdogCheck(WatchdogNativeState.decode(session: absent, console: nil, uid: 501).availability == .unknown &&
                          WatchdogNativeState.decode(session: absent, console: unlocked, uid: 501).availability == .available,
                          "A missing CGSession lock key needs matching explicit console lock evidence")
        var conflict = unlocked; conflict["locked"] = .bool(true)
        var malformed = unlocked; malformed["locked"] = .integer(0)
        try watchdogCheck(WatchdogNativeState.decode(session: unlocked, console: conflict, uid: 501).availability == .unknown &&
                          WatchdogNativeState.decode(session: malformed, console: unlocked, uid: 501).availability == .unknown,
                          "Conflicting or malformed lock observations cannot fall back to an apparent unlocked state")
    }
    try test {
        for key in ["onConsole", "loginDone"] {
            var value = unlocked; value[key] = .bool(false)
            let state = WatchdogNativeState.decode(session: value, console: nil, uid: 501)
            try watchdogCheck(state.availability == .unknown && state.locked == false,
                              "Fast-user-switch/login inactivity closes access without inventing factual lock evidence")
        }
        try watchdogCheck(WatchdogSystem.boolean(NSNumber(value: 1)) == nil &&
                          WatchdogSystem.boolean(NSNumber(value: true)) == true &&
                          WatchdogSystem.integer(NSNumber(value: true)) == nil &&
                          WatchdogSystem.integer(NSNumber(value: 12.5)) == nil,
                          "CFBoolean and integer identity fields cannot be confused by NSNumber bridging")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(healthy: false)
        let current = fake.state.current!
        try watchdogCheck(fake.service.availability() == .available && !fake.service.foregroundReady(current) &&
                          fake.state.pauseReasons.isEmpty, "A typed unlocked sample does not replace the new session's loop challenge")
        fake.service.observeTap(fake.state.status())
        try watchdogCheck(!fake.service.foregroundReady(current), "Metadata-only installed/enabled status is not a loop pulse")
        fake.reply()
        try watchdogCheck(fake.service.foregroundReady(current) && fake.state.detection.last?.value["alive"]?.boolValue == true,
                          "Only the matching fresh loop challenge opens the foreground detection floor")
    }
    try test {
        let fake = WatchdogFixture(inline: true); fake.automaticReplies(); fake.start()
        try watchdogCheck(fake.state.environments.last == .available && fake.state.detection.last?.value["alive"]?.boolValue == true &&
                          fake.state.pauseReasons.isEmpty,
                          "Inline native/probe completions cannot publish a stale queued unknown result after healthy state")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); let old = fake.state.probes.last!
        fake.state.events = []; fake.state.current?.observationEpoch = UUID(); fake.service.refreshSession()
        let current = fake.state.current!
        try watchdogCheck(fake.state.detection.isEmpty && !fake.service.foregroundReady(current),
                          "A new phase's in-flight loop challenge keeps admission closed without emitting a transient negative event")
        fake.reply(old)
        try watchdogCheck(!fake.service.foregroundReady(current) && fake.state.detection.isEmpty,
                          "A new native phase cannot inherit/replay the previous epoch's pulse or pause itself during probe grace")
        fake.reply()
        try watchdogCheck(fake.service.foregroundReady(current) && fake.state.detection.last?.value["alive"]?.boolValue == true &&
                          fake.state.detection.allSatisfy { $0.value["alive"]?.boolValue == true },
                          "The new epoch publishes only its own fresh positive challenge without a transient negative")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(healthy: false); let old = fake.state.probes.last!
        fake.state.tap = EventTapStatus(generation: 2, installed: true, enabled: true)
        fake.service.observeTap(fake.state.status()); fake.reply(old, generation: 1)
        try watchdogCheck(!fake.service.foregroundReady(fake.state.current!), "A retired installation cannot satisfy the successor tap's liveness")
        fake.service.refreshSession(); fake.reply()
        try watchdogCheck(fake.service.foregroundReady(fake.state.current!), "The successor installation requires and accepts a new generation-bound pulse")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(healthy: false); let old = fake.state.probes.last!
        fake.service.observeTap(EventTapStatus(generation: 1, installed: true, enabled: false))
        fake.reply(old)
        try watchdogCheck(!fake.service.foregroundReady(fake.state.current!),
                          "Disablement retires the pending nonce even if an earlier enabled acknowledgement arrives late")
        fake.service.refreshSession(); fake.reply(old)
        try watchdogCheck(!fake.service.foregroundReady(fake.state.current!), "An old acknowledgement cannot satisfy a new post-disable challenge")
        fake.reply()
        try watchdogCheck(fake.service.foregroundReady(fake.state.current!), "Recovery requires a fresh post-disable loop challenge")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); let old = fake.state.probes.last!
        fake.state.advance(999); fake.reply(old)
        fake.state.advance(1)
        try watchdogCheck(!fake.service.foregroundReady(fake.state.current!) && fake.state.pauseReasons.contains("detection"),
                          "Replaying an already consumed challenge cannot renew the one-second pulse lease")
        try watchdogCheck(fake.state.trace.last == "event:input_detection" && fake.state.trace.dropLast().last?.hasPrefix("pause:") == true,
                          "Expired detection latches and releases before its failure event")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(healthy: false)
        fake.state.advance(999)
        try watchdogCheck(fake.state.pauseReasons.isEmpty, "A bounded initial tap challenge has not exceeded its one-second deadline")
        fake.state.advance(1)
        try watchdogCheck(fake.state.pauseReasons == ["detection"] && fake.state.detection.last?.value["reason"]?.stringValue == "probe_missing",
                          "An unanswered challenge pauses by its exact one-second deadline")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.automaticReplies()
        fake.state.tap = EventTapStatus(generation: 1, installed: true, enabled: false)
        fake.service.observeTap(fake.state.status())
        try watchdogCheck(fake.state.recoveries == 1 && !fake.service.foregroundReady(fake.state.current!),
                          "A disabled actual tap immediately closes input and requests recovery on its own loop")
        fake.state.advance(1000)
        try watchdogCheck(fake.state.pauseReasons.contains("detection") && fake.state.detection.last?.value["reason"]?.stringValue == "tap_disabled",
                          "An unrecovered disabled tap pauses within one second")
        fake.state.tap = EventTapStatus(generation: 1, installed: true, enabled: true)
        fake.service.refreshSession(); fake.reply()
        try watchdogCheck(fake.state.detection.last?.value["alive"]?.boolValue == true && fake.state.current?.paused == true,
                          "Recovery reports fresh detection but never resumes the paused session")
    }
    try test {
        let fake = WatchdogFixture(); fake.state.tap = EventTapStatus(generation: 1, installed: false, enabled: false)
        fake.start(healthy: false); fake.state.advance(1000)
        try watchdogCheck(fake.state.probes.isEmpty && (1...5).contains(fake.state.recoveries) &&
                          fake.state.detection.last?.value["reason"]?.stringValue == "tap_disabled" && fake.state.current?.paused == true,
                          "Installation failure retries without a status-callback spin, never invents a probe and fails closed by one second")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.automaticReplies()
        fake.sample(WatchdogNativeState(locked: nil, consoleActive: false, screensaver: false, secureInput: false, holder: nil))
        try watchdogCheck(fake.service.availability() == .unknown && !fake.state.lockEvents.contains(true) &&
                          fake.state.pauseReasons.contains("detection"),
                          "Unavailable CGSession closes native access and pauses without fabricating locked:true")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.automaticReplies(); fake.state.trace = []
        fake.sample(WatchdogNativeState(locked: true, consoleActive: true, screensaver: false, secureInput: false, holder: nil))
        let lockIndex = fake.state.trace.firstIndex(of: "event:locked")!
        try watchdogCheck(fake.service.availability() == .locked && fake.state.lockEvents.last == true && lockIndex > 0 &&
                          fake.state.trace[lockIndex - 1] == "pause:locked", "Actual locked state latches authority before publishing its factual event")
        fake.sample(WatchdogNativeState(locked: false, consoleActive: true, screensaver: false, secureInput: false, holder: nil))
        try watchdogCheck(fake.state.lockEvents.last == false && fake.state.current?.paused == true,
                          "A verified unlock reports state but never resumes the task")
    }
    try test {
        let fake = WatchdogFixture(); fake.start()
        fake.sample(WatchdogNativeState(locked: nil, consoleActive: true, screensaver: true, secureInput: false, holder: nil))
        try watchdogCheck(fake.service.availability() == .locked && fake.state.lockEvents.last == true,
                          "A verified visible signed saver is positive lock-screen evidence even if the lock key is missing")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.automaticReplies()
        fake.sample(WatchdogNativeState(locked: false, consoleActive: true, screensaver: nil, secureInput: false, holder: nil))
        try watchdogCheck(fake.service.availability() == .unknown && !fake.state.lockEvents.contains(true),
                          "Incomplete saver enumeration is unknown rather than proof of absence or a fabricated lock")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.automaticReplies()
        fake.service.hint(.screensaverStarted); fake.state.drain(); fake.state.advance(1000)
        try watchdogCheck(fake.service.availability() == .unknown && fake.state.current?.paused == true,
                          "A saver-start hint remains a pause-only uncertainty latch across known-engine-negative samples")
        fake.service.hint(.screensaverStopped)
        try watchdogCheck(fake.service.availability() == .unknown, "A saver-stop hint alone cannot establish an accessible desktop")
        fake.state.drain()
        try watchdogCheck(fake.service.availability() == .available && fake.state.current?.paused == true,
                          "Saver-stop plus fresh typed facts recovers availability but never resumes the paused task")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.state.events = []
        fake.service.hint(.locked)
        try watchdogCheck(fake.state.current?.paused == true && fake.service.availability() == .unknown && fake.state.lockEvents.isEmpty,
                          "An untrusted distributed lock hint pauses and invalidates facts without inventing actual state")
        fake.service.hint(.unlocked)
        try watchdogCheck(fake.service.availability() == .unknown && fake.state.lockEvents.isEmpty,
                          "An unlock hint cannot prove an unlocked environment")
        fake.state.drain()
        fake.state.advance(250)
        try watchdogCheck(fake.service.availability() == .available && fake.state.current?.paused == true,
                          "Fresh native facts can recover availability after a hint while the pause latch remains")
    }
    try test {
        let fake = WatchdogFixture(); fake.service.start()
        fake.state.onSample = {
            fake.state.onSample = nil; fake.service.hint(.locked)
            fake.state.native = WatchdogNativeState(locked: true, consoleActive: true, screensaver: false, secureInput: false, holder: nil)
        }
        fake.state.drain()
        try watchdogCheck(fake.service.availability() == .unknown && !fake.state.lockEvents.contains(false),
                          "A native query begun before a lock hint cannot return later as post-hint unlock evidence")
        fake.state.advance(250)
        try watchdogCheck(fake.service.availability() == .locked && fake.state.lockEvents.last == true,
                          "After the old worker retires a new native sample can establish the actual locked state")
    }
    try test {
        let pairs: [(WatchdogHint, WatchdogHint)] = [(.sleep, .wake), (.displaySleep, .displayWake), (.sessionResigned, .sessionBecameActive)]
        for pair in pairs {
            let fake = WatchdogFixture(); fake.start(); fake.automaticReplies()
            fake.service.hint(pair.0); fake.state.drain(); fake.state.advance(1000)
            try watchdogCheck(fake.service.availability() == .unknown && fake.state.current?.paused == true,
                              "Sleep, display sleep and session resignation survive apparently unlocked asynchronous samples")
            fake.service.hint(pair.1)
            try watchdogCheck(fake.service.availability() == .unknown, "Wake/return needs a fresh sample, not merely a notification")
            fake.state.drain()
            try watchdogCheck(fake.service.availability() == .available && fake.state.current?.paused == true,
                              "Wake/console return recovers observed availability without clearing the pause latch")
        }
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.automaticReplies()
        fake.sample(WatchdogNativeState(locked: false, consoleActive: true, screensaver: false, secureInput: true, holder: "Password Manager"))
        try watchdogCheck(fake.service.availability() == .available && fake.state.lockEvents.last == false &&
                          fake.state.detection.last?.value["reason"]?.stringValue == "secure_input" &&
                          fake.state.detection.last?.value["holder"]?.stringValue == "Password Manager" &&
                          fake.state.pauseReasons.contains("secure_input"),
                          "Public secure-input state disables foreground detection separately from actual lock state")
        try watchdogCheck(!fake.service.foregroundReady(fake.state.current!), "Secure input closes the foreground mutation floor")
    }
    try test {
        let fake = WatchdogFixture(); fake.state.current?.mode = "background"; fake.start(); fake.automaticReplies()
        fake.sample(WatchdogNativeState(locked: false, consoleActive: true, screensaver: false, secureInput: true, holder: "Other App"))
        try watchdogCheck(fake.service.foregroundReady(fake.state.current!) && fake.state.pauseReasons.isEmpty &&
                          fake.state.detection.last?.value["alive"]?.boolValue == true && fake.state.detection.last?.value["holder"] == nil,
                          "Secure input in another app is not a global background-operation block or holder disclosure")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.state.current = nil; fake.service.refreshSession()
        let before = fake.state.probes.count, detection = fake.state.detection.count
        fake.sample(WatchdogNativeState(locked: true, consoleActive: true, screensaver: false, secureInput: false, holder: nil))
        try watchdogCheck(fake.service.availability() == .locked && fake.state.probes.count == before &&
                          fake.state.detection.count == detection && fake.state.lockEvents.last == true && fake.state.scopes.last! == nil,
                          "Sessionless native observations still close the central environment gate without inventing task detection")
    }
    try test {
        let fake = WatchdogFixture(); fake.service.start()
        fake.state.advance(2000, drain: false)
        try watchdogCheck(fake.state.work.count == 1 && fake.state.reads == 0 && fake.service.availability() == .unknown &&
                          fake.state.pauseReasons.contains("detection"),
                          "A stalled native query cannot spawn additional workers and independently fails closed at its deadline")
        fake.state.drain()
        try watchdogCheck(fake.service.availability() == .unknown, "The timed-out native result is quarantined when it eventually returns")
        fake.state.advance(250); fake.reply()
        try watchdogCheck(fake.service.availability() == .available && fake.state.reads == 2,
                          "Only after the occupied worker returns can one fresh native sample recover availability")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); let before = fake.state.events.count
        fake.state.clock += 500_000_000
        try watchdogCheck(fake.service.availability() == .unknown && !fake.service.foregroundReady(fake.state.current!) &&
                          fake.state.events.count == before,
                          "Synchronous admission rejects expired facts even before the independent timer callback gets CPU")
    }
    try test {
        let fake = WatchdogFixture(); fake.service.start(); fake.service.close(); fake.service.close()
        let before = fake.state.events.count, environments = fake.state.environments.count
        fake.state.drain(); fake.state.advance(10_000)
        try watchdogCheck(fake.state.reads == 0 && fake.state.removals == 1 && fake.state.events.count == before &&
                          fake.state.environments.count == environments && fake.state.timers.allSatisfy(\.canceled),
                          "Close removes observers once, cancels every timer and retires queued samples/publications")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.state.pauseAccepts = false; fake.state.events = []
        fake.sample(WatchdogNativeState(locked: true, consoleActive: true, screensaver: false, secureInput: false, holder: nil))
        try watchdogCheck(fake.state.events.isEmpty && fake.service.availability() == .locked,
                          "A rejected exact-epoch pause suppresses task publications while the global native gate stays closed")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.state.events = []
        fake.state.onPause = { fake.state.current?.observationEpoch = UUID() }
        fake.sample(WatchdogNativeState(locked: nil, consoleActive: false, screensaver: false, secureInput: false, holder: nil))
        try watchdogCheck(fake.state.detection.isEmpty, "A session replacement during the pause callback cannot receive an old task's detection event")
    }
    try test {
        let process = HelperProcessIdentity(pid: 101, parentPID: 1, startSeconds: 10, startMicroseconds: 20, executable: "/Applications/Editor.app/Contents/MacOS/Editor")
        let identity = MacAppIdentity(bundleId: "example.editor", apple: false, system: false, verified: false,
                                      name: "Editor", path: process.executable, pid: 101)
        let owner = NativeOwner(identity: identity, process: process, childShell: nil)
        try watchdogCheck(WatchdogSystem.secureHolder(pid: 101, before: process, owner: owner, after: process) == "Editor",
                          "A holder name comes only from a matching live native process observation")
        let reused = HelperProcessIdentity(pid: 101, parentPID: 1, startSeconds: 11, startMicroseconds: 20, executable: process.executable)
        try watchdogCheck(WatchdogSystem.secureHolder(pid: 101, before: process, owner: owner, after: reused) == nil &&
                          WatchdogSystem.secureHolder(pid: 102, before: process, owner: owner, after: process) == nil,
                          "Holder metadata cannot survive PID reuse or a different registry PID")
    }
    try test {
        let process = HelperProcessIdentity(pid: 101, parentPID: 1, startSeconds: 10, startMicroseconds: 20, executable: "/Applications/Editor")
        for name in ["", "spoof\nname", String(repeating: "x", count: 257), "spoof\u{202e}name"] {
            let owner = NativeOwner(identity: MacAppIdentity(bundleId: "example.editor", apple: false, system: false,
                verified: false, name: name, pid: 101), process: process, childShell: nil)
            try watchdogCheck(WatchdogSystem.secureHolder(pid: 101, before: process, owner: owner, after: process) == nil,
                              "Optional holder names reject control/bidi data, empty labels and oversized metadata")
        }
        try watchdogCheck(WatchdogNativeState.decode(session: unlocked, console: nil, uid: 501, holder: "Unused").holder == nil,
                          "Holder metadata is omitted when secure input is not enabled")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.automaticReplies(); fake.state.advance(6000)
        try watchdogCheck(fake.state.pauseReasons.isEmpty && fake.state.current?.paused == false && fake.state.detection.last?.value["alive"]?.boolValue == true,
                          "Healthy watchdog operation beyond five seconds does not duplicate Dispatcher's heartbeat deadman")
    }
    try test {
        for status in [EventTapStatus(generation: 1, installed: true, enabled: true, bindingEpoch: nil),
                       EventTapStatus(generation: 1, installed: true, enabled: true, bindingEpoch: UUID()),
                       EventTapStatus(generation: 1, installed: true, enabled: true, bindingReady: false)] {
            let fake = WatchdogFixture(); fake.state.bindToCurrent = false; fake.state.tap = status
            fake.start(); fake.state.advance(1000)
            try watchdogCheck(!fake.service.foregroundReady(fake.state.current!) &&
                              fake.state.detection.last?.value["reason"]?.stringValue == "probe_missing" &&
                              fake.state.current?.paused == true,
                              "A missing/stale chord epoch or unready binding cannot manufacture liveness and fails closed by one second")
        }
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); let old = fake.state.probes.last!
        fake.state.events = []
        fake.state.tap = EventTapStatus(generation: 1, installed: true, enabled: true, bindingReady: false)
        fake.service.observeTap(fake.state.status())
        try watchdogCheck(!fake.service.foregroundReady(fake.state.current!) && fake.state.detection.isEmpty,
                          "Pending native chord rebinding closes admission without a transient negative event")
        fake.state.tap = EventTapStatus(generation: 1, installed: true, enabled: true)
        fake.reply(old)
        try watchdogCheck(!fake.service.foregroundReady(fake.state.current!), "Rebinding retires the old nonce even if a late acknowledgement claims ready")
        fake.service.refreshSession(); fake.reply()
        try watchdogCheck(fake.service.foregroundReady(fake.state.current!), "A fresh challenge can prove the current ready binding")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(healthy: false)
        for generation in 2...5 {
            fake.state.advance(250)
            fake.state.tap = EventTapStatus(generation: UInt64(generation), installed: true, enabled: true)
            fake.service.observeTap(fake.state.status())
        }
        try watchdogCheck(fake.state.current?.paused == true && fake.state.detection.last?.value["alive"]?.boolValue == false,
                          "Repeated tap installations cannot restart the same phase's one-second detection deadline indefinitely")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.automaticReplies()
        let expected = fake.state.current!, alive = fake.state.detection.last!
        try watchdogCheck(fake.service.eventIsCurrent(event: alive, expected: expected), "A fresh positive publication has current native and session evidence")
        fake.sample(WatchdogNativeState(locked: false, consoleActive: true, screensaver: false, secureInput: true, holder: "Holder A"))
        let negative = fake.state.detection.last!
        try watchdogCheck(!fake.service.eventIsCurrent(event: alive, expected: expected) &&
                          fake.service.eventIsCurrent(event: negative, expected: expected),
                          "A newer same-epoch secure-input failure retires an older queued positive publication")
        fake.sample(WatchdogNativeState(locked: false, consoleActive: true, screensaver: false, secureInput: true, holder: "Holder B"))
        try watchdogCheck(!fake.service.eventIsCurrent(event: negative, expected: expected),
                          "Current negative publications require the current holder metadata, not just the reason string")
        fake.sample(WatchdogNativeState(locked: false, consoleActive: true, screensaver: false, secureInput: false, holder: nil))
        try watchdogCheck(!fake.service.eventIsCurrent(event: negative, expected: expected) &&
                          fake.service.eventIsCurrent(event: fake.state.detection.last!, expected: expected),
                          "Recovery retires a delayed same-epoch negative publication as well as stale positives")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); fake.automaticReplies()
        let expected = fake.state.current!, unlocked = fake.state.events.first { $0.value["event"]?.stringValue == "locked" }!
        fake.sample(WatchdogNativeState(locked: true, consoleActive: true, screensaver: false, secureInput: false, holder: nil))
        let locked = fake.state.events.last { $0.value["event"]?.stringValue == "locked" }!
        try watchdogCheck(!fake.service.eventIsCurrent(event: unlocked, expected: expected) &&
                          fake.service.eventIsCurrent(event: locked, expected: expected),
                          "An actual lock retires a queued same-epoch unlock event before publication")
        fake.sample(WatchdogNativeState(locked: false, consoleActive: true, screensaver: false, secureInput: false, holder: nil))
        try watchdogCheck(!fake.service.eventIsCurrent(event: locked, expected: expected), "A verified unlock also retires an older lock publication")
        fake.state.current?.observationEpoch = UUID(); fake.service.refreshSession()
        try watchdogCheck(!fake.service.eventIsCurrent(event: unlocked, expected: expected), "Publication validation also rejects a retired task epoch")
    }
    try test {
        let fake = WatchdogFixture(); fake.state.current = nil; fake.start()
        let event = fake.state.events.first { $0.value["event"]?.stringValue == "locked" }!
        try watchdogCheck(fake.service.eventIsCurrent(event: event, expected: nil), "Taskless lock state is valid only against the matching nil task scope")
        fake.state.current = ServerSession(id: "new-task", revision: 1, mode: "foreground", paused: false,
            approved: [], vectorPids: [], vectorWindowIds: [], overlayWindowIds: [], escStops: false, stopChord: "Command+Shift+Escape")
        fake.service.refreshSession()
        try watchdogCheck(!fake.service.eventIsCurrent(event: event, expected: nil), "A new task cannot receive an earlier taskless publication")
    }
    try test {
        let fake = WatchdogFixture(); fake.start(); let current = fake.state.current!, event = fake.state.detection.last!
        let reads = fake.state.reads, pending = fake.state.work.count
        fake.state.clock += 500_000_000
        try watchdogCheck(!fake.service.eventIsCurrent(event: event, expected: current) &&
                          fake.state.reads == reads && fake.state.work.count == pending,
                          "Publication validation rejects expired native facts using only cached metadata, without OS queries or callbacks")
    }
    try test {
        try watchdogCheck(coherent(absent, root: .bool(false), users: [absent]).availability == .available,
                          "A coherent explicit kernel IOConsoleLocked=false proves unlocked when both per-session markers are absent")
        try watchdogCheck(WatchdogNativeState.decode(session: absent, console: absent, uid: 501).availability == .unknown,
                          "The exact same missing per-session markers without a positive kernel witness remain unknown")
        let fake = WatchdogFixture(); fake.state.native = coherent(absent, root: .bool(false), users: [absent]); fake.start()
        try watchdogCheck(fake.service.foregroundReady(fake.state.current!) && fake.state.pauseReasons.isEmpty,
                          "The production-shaped missing-marker/kernel-false observation can actually admit a fresh foreground challenge")
    }
    try test {
        let roots: [JSONValue?] = [nil, .null, .integer(0), .string("false")]
        for root in roots {
            try watchdogCheck(coherent(absent, root: root, users: [absent]).availability == .unknown,
                              "Missing or malformed root lock values never turn absent session markers into unlocked proof")
        }
        try watchdogCheck(coherent(unlocked, root: nil, users: [unlocked]).availability == .available &&
                          coherent(absent, root: nil, users: [unlocked]).availability == .available,
                          "Coherent existing explicit CGSession or matching-console false observations remain valid without a root fallback")
    }
    try test {
        var locked = absent; locked["locked"] = .bool(true)
        try watchdogCheck(coherent(absent, root: .bool(false), users: [locked]).availability == .locked &&
                          coherent(locked, root: .bool(false), users: [absent]).availability == .locked,
                          "A present current-session true marker wins over kernel false during screen-saver or password grace")
        try watchdogCheck(coherent(unlocked, root: .bool(true), users: [unlocked]).availability == .unknown &&
                          coherent(unlocked, root: .bool(false), users: [locked]).availability == .unknown,
                          "Root-true/session-false and conflicting current session markers cannot authorize an unlocked desktop")
    }
    try test {
        for key in ["uid", "onConsole", "loginDone", "locked"] {
            var malformed = unlocked; malformed[key] = .null
            try watchdogCheck(coherent(malformed, root: .bool(false), users: [unlocked]).availability == .unknown &&
                              coherent(unlocked, root: .bool(false), users: [malformed]).availability == .unknown,
                              "Every present malformed current/console authority field vetoes an explicit root-false fallback")
        }
        let catalogues: [[[String: JSONValue]]?] = [nil, [], Array(repeating: absent, count: 65)]
        for users in catalogues {
            try watchdogCheck(coherent(absent, root: .bool(false), users: users).availability == .unknown,
                              "Absent, empty or oversized console catalogues cannot supply unique current-console proof")
        }
    }
    try test {
        var foreign = absent; foreign["uid"] = .integer(502)
        var away = absent; away["onConsole"] = .bool(false)
        var login = absent; login["loginDone"] = .bool(false)
        for users in [[foreign], [away], [login], [absent, absent], [absent, foreign]] {
            try watchdogCheck(coherent(absent, root: .bool(false), users: users).availability == .unknown,
                              "Foreign, inactive, incomplete or multiple active console rows never prove our desktop unlocked")
        }
        for current in [foreign, away, login] {
            try watchdogCheck(coherent(current, root: .bool(false), users: [absent]).availability == .unknown &&
                              coherent(current, root: .bool(true), users: [absent]).availability == .unknown,
                              "The current CGSession must independently name our logged-in active console for either root state")
        }
        try watchdogCheck(coherent(nil, root: .bool(true), users: [absent]).availability == .unknown,
                          "Root true alone with no current WindowServer session cannot invent an accessible desktop")
    }
    try test {
        var other = absent; other["uid"] = .integer(502); other["onConsole"] = .bool(false); other["locked"] = .bool(true)
        try watchdogCheck(coherent(absent, root: .bool(false), users: [other, absent]).availability == .available,
                          "A different off-console user's legitimate lock does not globally block our active console after fast-user switching")
        other["onConsole"] = .integer(0)
        try watchdogCheck(coherent(absent, root: .bool(false), users: [other, absent]).availability == .unknown,
                          "An ambiguous catalogue still fails closed when an off-console classification is malformed")
    }
    try test {
        var other = absent; other["uid"] = .integer(502); other["onConsole"] = .bool(false); other["locked"] = .bool(false)
        let first = WatchdogConsoleSnapshot(rootLocked: .bool(false), users: [other, absent])
        other["locked"] = .bool(true)
        let second = WatchdogConsoleSnapshot(rootLocked: .bool(false), users: [absent, other])
        try watchdogCheck(first == second && WatchdogNativeState.decode(session: absent, after: absent, registry: first,
                            registryAfter: second, uid: 501).availability == .available,
                          "Well-typed off-console lock/order churn does not change the current console's positive unlocked evidence")
        let duplicate = WatchdogConsoleSnapshot(rootLocked: .bool(false), users: [absent, absent])
        try watchdogCheck(first != duplicate, "Current-console uniqueness is still part of the coherence proof")
    }
    try test {
        let before = WatchdogConsoleSnapshot(rootLocked: .bool(false), users: [absent])
        var changed = absent; changed["locked"] = .bool(true)
        let after = WatchdogConsoleSnapshot(rootLocked: .bool(true), users: [changed])
        try watchdogCheck(WatchdogNativeState.decode(session: absent, after: changed, registry: before,
                            registryAfter: before, uid: 501).availability == .unknown &&
                          WatchdogNativeState.decode(session: absent, after: absent, registry: before,
                            registryAfter: after, uid: 501).availability == .unknown,
                          "Changed CGSession or kernel/console snapshots quarantine an otherwise positive unlocked observation")
        for key in ["uid", "onConsole", "loginDone"] {
            var current = absent; current[key] = key == "uid" ? .integer(502) : .bool(false)
            try watchdogCheck(WatchdogNativeState.decode(session: absent, after: current, registry: before,
                                registryAfter: before, uid: 501).availability == .unknown,
                              "UID, on-console and login transitions during native sampling cannot reuse the before snapshot")
        }
    }
    try test {
        let row: [String: Any] = ["kCGSSessionUserIDKey": NSNumber(value: 501),
            "kCGSSessionOnConsoleKey": NSNumber(value: true), "kCGSessionLoginDoneKey": NSNumber(value: true),
            "kCGSSessionSecureInputPID": NSNumber(value: 101), "kCGSSessionUserNameKey": "synthetic account"]
        var changed = row; changed["kCGSSessionSecureInputPID"] = NSNumber(value: 202)
        changed["kCGSSessionUserNameKey"] = "another synthetic label"
        let first = WatchdogSystem.registryFacts(["IOConsoleLocked": NSNumber(value: false), "IOConsoleUsers": [row]])
        let second = WatchdogSystem.registryFacts(["IOConsoleLocked": NSNumber(value: false), "IOConsoleUsers": [changed]])
        try watchdogCheck(first == second && first.users == [absent] && first.rootLocked == .bool(false),
                          "Lock coherence retains only typed authority facts; holder PID and account-label churn cannot pause background work")
        try watchdogCheck(WatchdogNativeState.decode(session: absent, after: absent, registry: first,
                            registryAfter: second, uid: 501).availability == .available,
                          "Stable lock-critical facts survive unrelated secure-input metadata churn")
    }
    try test {
        let malformed: [String: Any] = ["kCGSSessionUserIDKey": NSNumber(value: 501),
            "kCGSSessionOnConsoleKey": NSNumber(value: true), "kCGSessionLoginDoneKey": NSNumber(value: true),
            "CGSSessionScreenIsLocked": NSNumber(value: 0)]
        let session = WatchdogSystem.facts(malformed)
        let registry = WatchdogSystem.registryFacts(["IOConsoleLocked": NSNumber(value: false), "IOConsoleUsers": [malformed]])
        try watchdogCheck(session["locked"] == .null && WatchdogNativeState.decode(session: session, after: session,
                            registry: registry, registryAfter: registry, uid: 501).availability == .unknown,
                          "Native normalization preserves a malformed present Boolean as invalid rather than treating it as absent")
        let oversized = WatchdogSystem.registryFacts(["IOConsoleLocked": NSNumber(value: false),
            "IOConsoleUsers": Array(repeating: malformed, count: 65)])
        try watchdogCheck(oversized.users == nil, "Native normalization refuses console catalogues beyond its fixed row bound")
    }
    return count
}
