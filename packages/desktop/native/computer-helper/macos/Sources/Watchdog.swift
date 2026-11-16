import AppKit
import Carbon
import CoreFoundation
import CoreGraphics
import Darwin
import Dispatch
import Foundation
import IOKit

enum WatchdogAvailability: Equatable { case available, locked, unknown }

enum WatchdogHint {
    case locked, unlocked, screensaverStarted, screensaverStopped
    case sleep, wake, displaySleep, displayWake, sessionResigned, sessionBecameActive
}

/// Only native authority facts; no usernames, application titles or private content are retained.
struct WatchdogConsoleSnapshot: Equatable {
    let rootLocked: JSONValue?
    /// nil means the catalogue was absent, malformed or too large, not an empty unlocked console.
    let users: [[String: JSONValue]]?

    var activeUser: [String: JSONValue]? {
        guard let users, !users.isEmpty, users.count <= 64, users.allSatisfy({ row in
            guard let id = row["uid"]?.intValue, id >= 0, id <= Int(Int32.max),
                  row["onConsole"]?.boolValue != nil, row["loginDone"]?.boolValue != nil else { return false }
            return row["locked"] == nil || row["locked"]?.boolValue != nil
        }) else { return nil }
        let active = users.filter { $0["onConsole"]?.boolValue == true }
        return active.count == 1 ? active.first : nil
    }

    static func == (first: WatchdogConsoleSnapshot, second: WatchdogConsoleSnapshot) -> Bool {
        // Both catalogues must independently prove completeness/uniqueness. A well-typed off-console
        // user's lock or ordering is not a change to this console's authority.
        first.rootLocked == second.rootLocked && first.activeUser == second.activeUser
    }
}

struct WatchdogNativeState {
    let locked: Bool?
    let consoleActive: Bool
    let screensaver: Bool?
    let secureInput: Bool
    let holder: String?

    var availability: WatchdogAvailability {
        if locked == true || screensaver == true { return .locked }
        return locked == false && consoleActive && screensaver == false ? .available : .unknown
    }

    /// These are observed native values, never session/request assertions. Missing lock evidence is unknown.
    static func decode(session: [String: JSONValue]?, console: [String: JSONValue]?, uid: Int,
                       screensaver: Bool? = false, secureInput: Bool = false, holder: String? = nil) -> WatchdogNativeState {
        classify(session: session, console: console, rootLocked: nil, rootProof: false, uid: uid,
                 screensaver: screensaver, secureInput: secureInput, holder: holder)
    }

    /// Production observes both sources before and after its native work. A missing per-session marker
    /// is never false: only an explicit kernel IOConsoleLocked=false can supply that additional proof.
    static func decode(session: [String: JSONValue]?, after: [String: JSONValue]?,
                       registry: WatchdogConsoleSnapshot?, registryAfter: WatchdogConsoleSnapshot?, uid: Int,
                       screensaver: Bool? = false, secureInput: Bool = false, holder: String? = nil) -> WatchdogNativeState {
        let unknown = WatchdogNativeState(locked: nil, consoleActive: false, screensaver: screensaver,
                                         secureInput: secureInput, holder: nil)
        guard session == after, registry == registryAfter, let session else { return unknown }
        var console: [String: JSONValue]?
        if let registry {
            guard registry.rootLocked == nil || registry.rootLocked?.boolValue != nil,
                  let current = registry.activeUser,
                  current["uid"]?.intValue == uid, current["loginDone"]?.boolValue == true,
                  session["uid"]?.intValue == uid, session["onConsole"]?.boolValue == true,
                  session["loginDone"]?.boolValue == true else { return unknown }
            console = current
        }
        return classify(session: session, console: console, rootLocked: registry?.rootLocked,
                        rootProof: registry != nil, uid: uid, screensaver: screensaver,
                        secureInput: secureInput, holder: holder)
    }

    private static func classify(session: [String: JSONValue]?, console: [String: JSONValue]?,
                                 rootLocked: JSONValue?, rootProof: Bool, uid: Int, screensaver: Bool?,
                                 secureInput: Bool, holder: String?) -> WatchdogNativeState {
        guard let session, session["uid"]?.intValue == uid,
              let onConsole = session["onConsole"]?.boolValue,
              let loginDone = session["loginDone"]?.boolValue else {
            return WatchdogNativeState(locked: nil, consoleActive: false, screensaver: screensaver,
                                      secureInput: secureInput, holder: nil)
        }
        let matching = console?["uid"]?.intValue == uid && console?["onConsole"]?.boolValue == onConsole &&
            console?["loginDone"]?.boolValue == loginDone
        let first = session["locked"]?.boolValue, second = matching ? console?["locked"]?.boolValue : nil
        let malformed = session["locked"] != nil && first == nil ||
            console?["locked"] != nil && (!matching || second == nil) || rootLocked != nil && rootLocked?.boolValue == nil
        let conflict = first != nil && second != nil && first != second
        let explicit = first ?? second
        let locked: Bool?
        if malformed || conflict || rootLocked?.boolValue == true && explicit == false { locked = nil }
        else if explicit == true { locked = true } // The session marker wins over kernel password-grace false.
        else if let explicit { locked = explicit }
        else if rootProof, matching, onConsole, loginDone { locked = rootLocked?.boolValue }
        else { locked = nil }
        return WatchdogNativeState(locked: locked, consoleActive: onConsole && loginDone,
                                  screensaver: screensaver, secureInput: secureInput,
                                  holder: secureInput && onConsole && loginDone ? holder : nil)
    }
}

struct WatchdogBackend {
    let sample: () -> WatchdogNativeState
    let observe: (@escaping (WatchdogHint) -> Void) -> (() -> Void)

    static var system: WatchdogBackend {
        WatchdogBackend(sample: WatchdogSystem.sample, observe: WatchdogSystem.observe)
    }
}

/// One bounded observation worker and an independent timer. Dispatcher alone owns the 5-second heartbeat.
/// No OS query, observer registration or timer starts in this constructor.
final class WatchdogService {
    typealias Schedule = (Int, @escaping () -> Void) -> (() -> Void)
    private struct Challenge {
        let id: UInt64
        let epoch: UUID
        let generation: UInt64
        let sent: UInt64
    }
    private let lock = NSLock()
    private let backend: WatchdogBackend
    private let session: () -> ServerSession?
    private let tapStatus: () -> EventTapStatus
    private let recoverTap: () -> Void
    private let probeTap: (UInt64) -> Void
    private let pause: (ServerSession, String) -> Bool
    private let emit: (Event, ServerSession?) -> Void
    private let environmentChanged: (WatchdogAvailability) -> Void
    private let execute: (@escaping () -> Void) -> Void
    private let schedule: Schedule
    private let now: () -> UInt64
    private var started = false
    private var closed = false
    private var lifetime: UInt64 = 0
    private var bound: ServerSession?
    private var tap: EventTapStatus?
    private var challenge: Challenge?
    private var sequence: UInt64 = 0
    private var pulse: UInt64?
    private var disabledSince: UInt64?
    private var recoveryRequestedAt: UInt64?
    private var native: WatchdogNativeState?
    private var sampledAt: UInt64?
    private var sampleBusy = false
    private var sampleTicket: UInt64 = 0
    private var sampleStarted: UInt64 = 0
    private var suspended = false
    private var displayAsleep = false
    private var inactive = false
    private var saverHint = false
    private var reportedAvailability: WatchdogAvailability?
    private var reportedLock: Bool?
    private var reportedDetection: String?
    private var pausedDetection: String?
    private var cancelTick: (() -> Void)?
    private var cancelSample: (() -> Void)?
    private var cancelChallenge: (() -> Void)?
    private var unobserve: (() -> Void)?

    init(session: @escaping () -> ServerSession?, tapStatus: @escaping () -> EventTapStatus,
         recoverTap: @escaping () -> Void, probeTap: @escaping (UInt64) -> Void,
         pause: @escaping (ServerSession, String) -> Bool, emit: @escaping (Event, ServerSession?) -> Void,
         backend: WatchdogBackend = .system,
         environmentChanged: @escaping (WatchdogAvailability) -> Void = { _ in },
         execute: ((@escaping () -> Void) -> Void)? = nil, schedule: Schedule? = nil,
         now: (() -> UInt64)? = nil) {
        self.session = session; self.tapStatus = tapStatus; self.recoverTap = recoverTap
        self.probeTap = probeTap; self.pause = pause; self.emit = emit; self.backend = backend
        self.environmentChanged = environmentChanged
        let worker = DispatchQueue(label: "ai.vector.computer.watchdog.observation", qos: .userInitiated)
        self.execute = execute ?? { worker.async(execute: $0) }
        let timers = DispatchQueue(label: "ai.vector.computer.watchdog.timer", qos: .userInteractive)
        self.schedule = schedule ?? { milliseconds, callback in
            let work = DispatchWorkItem(block: callback)
            timers.asyncAfter(deadline: .now() + .milliseconds(milliseconds), execute: work)
            return { work.cancel() }
        }
        self.now = now ?? { DispatchTime.now().uptimeNanoseconds }
    }

    func start() {
        let accepted = locked { () -> Bool in
            guard !closed, !started else { return false }; started = true; return true
        }
        guard accepted else { return }
        let stop = backend.observe { [weak self] in self?.hint($0) }
        let keep = locked { () -> Bool in guard !closed else { return false }; unobserve = stop; return true }
        if !keep { stop(); return }
        tick()
    }

    func refreshSession() { tick() }

    /// Called outside EventTapMonitor's locks. A metadata-only enabled bit cannot manufacture a fresh pulse.
    func observeTap(_ status: EventTapStatus) {
        let current = session(), time = now()
        let actions = locked { () -> [() -> Void] in
            guard started, !closed else { return [] }
            bind(current, time: time)
            var actions: [() -> Void] = []
            accept(status, time: time, actions: &actions)
            evaluate(time: time, actions: &actions)
            return actions
        }
        actions.forEach { $0() }
    }

    func hint(_ hint: WatchdogHint) {
        let current = session(), time = now()
        let actions = locked { () -> [() -> Void] in
            guard started, !closed else { return [] }
            bind(current, time: time)
            sampledAt = nil
            if sampleBusy {
                // A query begun before this hint cannot later prove the post-hint environment unlocked.
                sampleTicket &+= 1; cancelSample?(); cancelSample = nil
            }
            switch hint {
            case .sleep: suspended = true
            case .wake: suspended = false
            case .displaySleep: displayAsleep = true
            case .displayWake: displayAsleep = false
            case .sessionResigned: inactive = true
            case .sessionBecameActive: inactive = false
            case .screensaverStarted: saverHint = true
            case .screensaverStopped: saverHint = false
            default: break
            }
            var actions: [() -> Void] = []
            switch hint {
            case .locked, .screensaverStarted, .sleep, .displaySleep, .sessionResigned:
                if let current = bound {
                    actions.append(scoped(current) { [weak self] in _ = self?.pause(current, "locked") })
                }
            default: break
            }
            evaluate(time: time, actions: &actions)
            return actions
        }
        actions.forEach { $0() }
        tick()
    }

    /// Safe to call from Dispatcher's admission lock: this never calls back into Dispatcher or the OS.
    func availability() -> WatchdogAvailability { locked { availability(at: now()) } }

    func foregroundReady(_ session: ServerSession) -> Bool {
        locked {
            guard !closed, started, bound?.observationEpoch == session.observationEpoch,
                  availability(at: now()) == .available else { return false }
            if session.mode == "background" { return true }
            guard native?.secureInput == false, tap?.installed == true, tap?.enabled == true,
                  tap?.bindingReady == true, tap?.bindingEpoch == session.observationEpoch,
                  let pulse else { return false }
            return age(now(), pulse) < 1_000_000_000
        }
    }

    /// Main calls this at its publication fence. No callback, native query or session lookup occurs here.
    /// Same-epoch status races need the current facts as well as the captured task identity.
    func eventIsCurrent(event: Event, expected: ServerSession?) -> Bool {
        locked {
            let time = now(), available = availability(at: time)
            guard started, !closed, bound?.observationEpoch == expected?.observationEpoch,
                  reportedAvailability == available else { return false }
            switch event.value["event"]?.stringValue {
            case "locked":
                guard let value = event.value["locked"]?.boolValue, reportedLock == value else { return false }
                return available == (value ? .locked : .available)
            case "input_detection":
                guard let bound, let alive = event.value["alive"]?.boolValue else { return false }
                let current = detection(at: time, session: bound)
                guard reportedDetection == current.signature, alive == (current.reason == nil),
                      event.value["reason"]?.stringValue == current.reason else { return false }
                return event.value["holder"]?.stringValue == (current.secure ? native?.holder : nil)
            default: return false
            }
        }
    }

    func close() {
        let stop = locked { () -> (() -> Void)? in
            guard !closed else { return nil }
            closed = true; lifetime &+= 1; bound = nil; challenge = nil; pulse = nil
            cancelTick?(); cancelTick = nil; cancelSample?(); cancelSample = nil
            cancelChallenge?(); cancelChallenge = nil
            let stop = unobserve; unobserve = nil; return stop
        }
        stop?()
    }

    private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
    private func age(_ time: UInt64, _ before: UInt64) -> UInt64 { time >= before ? time - before : UInt64.max }
    private func availability(at time: UInt64) -> WatchdogAvailability {
        guard started, !closed,
              let sampledAt, age(time, sampledAt) < 500_000_000 else { return .unknown }
        if native?.availability == .locked { return .locked }
        guard !suspended, !displayAsleep, !inactive, !saverHint else { return .unknown }
        return native?.availability ?? .unknown
    }

    private func detection(at time: UInt64, session: ServerSession) -> (signature: String, reason: String?, secure: Bool) {
        let fresh = sampledAt.map { age(time, $0) < 500_000_000 } == true
        let secure = fresh && session.mode == "foreground" && native?.secureInput == true
        let pulseAlive = pulse.map { age(time, $0) < 1_000_000_000 } == true &&
            tap?.installed == true && tap?.enabled == true && tap?.bindingReady == true &&
            tap?.bindingEpoch == session.observationEpoch
        let reason: String? = secure ? "secure_input" : availability(at: time) != .available ? "probe_missing" :
            pulseAlive ? nil : tap?.enabled == false || tap?.installed == false ? "tap_disabled" : "probe_missing"
        let signature = reason.map { $0 + ":" + (secure ? native?.holder ?? "" : "") } ?? "alive"
        return (signature, reason, secure)
    }

    private func bind(_ current: ServerSession?, time: UInt64) {
        guard bound?.observationEpoch != current?.observationEpoch else { bound = current; return }
        bound = current; pulse = nil; challenge = nil; reportedDetection = nil; pausedDetection = nil
        cancelChallenge?(); cancelChallenge = nil
        disabledSince = current == nil ? nil : time
    }

    private func scoped(_ expected: ServerSession, _ body: @escaping () -> Void) -> () -> Void {
        let ticket = lifetime
        return { [weak self] in
            guard let self, self.locked({ !self.closed && self.lifetime == ticket }),
                  self.session()?.observationEpoch == expected.observationEpoch else { return }
            body()
        }
    }

    private func tick() {
        let current = session(), status = tapStatus(), time = now()
        let actions = locked { () -> [() -> Void] in
            guard started, !closed else { return [] }
            bind(current, time: time)
            var actions: [() -> Void] = []
            accept(status, time: time, actions: &actions)
            if !sampleBusy && (sampledAt == nil || age(time, sampledAt!) >= 250_000_000) {
                sampleBusy = true; sampleTicket &+= 1; sampleStarted = time
                let ticket = sampleTicket, life = lifetime
                cancelSample = schedule(500) { [weak self] in self?.sampleExpired(ticket, lifetime: life) }
                actions.append { [weak self] in
                    guard let self else { return }
                    self.execute { [weak self] in
                        guard let self, self.locked({ !self.closed && self.lifetime == life }) else { return }
                        let result = self.backend.sample()
                        self.sampled(result, ticket: ticket, lifetime: life)
                    }
                }
            }
            if let current = bound, challenge == nil, pulse == nil || age(time, pulse!) >= 500_000_000,
               let tap, tap.installed {
                sequence &+= 1
                let id = sequence
                challenge = Challenge(id: id, epoch: current.observationEpoch, generation: tap.generation, sent: time)
                cancelChallenge?()
                cancelChallenge = schedule(1000) { [weak self] in self?.tick() }
                actions.append(scoped(current) { [weak self] in self?.probeTap(id) })
            }
            evaluate(time: time, actions: &actions)
            cancelTick?()
            cancelTick = schedule(250) { [weak self] in self?.tick() }
            return actions
        }
        actions.forEach { $0() }
    }

    private func accept(_ status: EventTapStatus, time: UInt64, actions: inout [() -> Void]) {
        if let tap, status.generation < tap.generation { return }
        if tap?.generation != status.generation {
            pulse = nil; challenge = nil
            if bound != nil && disabledSince == nil { disabledSince = time }
            cancelChallenge?(); cancelChallenge = nil
        }
        tap = status
        if !status.installed || !status.enabled {
            pulse = nil; challenge = nil; cancelChallenge?(); cancelChallenge = nil
            if disabledSince == nil { disabledSince = time }
            if recoveryRequestedAt == nil || age(time, recoveryRequestedAt!) >= 250_000_000 {
                // A denied installation also needs retries. Rate-limit status→recover→status callbacks.
                recoveryRequestedAt = time
                actions.append { [weak self] in
                    guard let self, self.locked({ !self.closed }) else { return }; self.recoverTap()
                }
            }
        }
        if let bound, !status.bindingReady || status.bindingEpoch != bound.observationEpoch {
            pulse = nil; challenge = nil; cancelChallenge?(); cancelChallenge = nil
            if disabledSince == nil { disabledSince = time }
        }
        if let pulse, age(time, pulse) >= 1_000_000_000, disabledSince == nil {
            // Preserve the original pulse deadline rather than starting another grace period now.
            disabledSince = pulse
        }
        if status.installed, status.enabled, status.bindingReady,
           status.bindingEpoch == bound?.observationEpoch, let challenge, status.challenge == challenge.id,
           challenge.epoch == bound?.observationEpoch, challenge.generation == status.generation,
           age(time, challenge.sent) < 1_000_000_000 {
            pulse = time; self.challenge = nil; disabledSince = nil
            cancelChallenge?(); cancelChallenge = nil
        }
        if let challenge, age(time, challenge.sent) >= 1_000_000_000 {
            self.challenge = nil; cancelChallenge?(); cancelChallenge = nil
        }
    }

    private func sampleExpired(_ ticket: UInt64, lifetime: UInt64) {
        let current = session(), time = now()
        let actions = locked { () -> [() -> Void] in
            guard !closed, self.lifetime == lifetime, sampleBusy, sampleTicket == ticket else { return [] }
            // Keep the sole worker occupied until the native call returns. Late results are quarantined.
            sampledAt = nil; sampleTicket &+= 1; cancelSample = nil; bind(current, time: time)
            var actions: [() -> Void] = []; evaluate(time: time, actions: &actions); return actions
        }
        actions.forEach { $0() }
    }

    private func sampled(_ result: WatchdogNativeState, ticket: UInt64, lifetime: UInt64) {
        let current = session(), time = now()
        let actions = locked { () -> [() -> Void] in
            guard !closed, self.lifetime == lifetime else { return [] }
            sampleBusy = false
            guard sampleTicket == ticket, age(time, sampleStarted) < 500_000_000 else { return [] }
            cancelSample?(); cancelSample = nil; native = result; sampledAt = time; bind(current, time: time)
            var actions: [() -> Void] = []; evaluate(time: time, actions: &actions); return actions
        }
        actions.forEach { $0() }
    }

    private func evaluate(time: UInt64, actions: inout [() -> Void]) {
        let available = availability(at: time)
        if reportedAvailability != available {
            reportedAvailability = available
            let life = lifetime
            actions.append { [weak self] in
                guard let self, self.locked({ !self.closed && self.lifetime == life &&
                    self.reportedAvailability == available && self.availability(at: self.now()) == available }) else { return }
                self.environmentChanged(available)
            }
        }
        if let native, sampledAt != nil, native.locked != nil || native.screensaver == true {
            let locked = native.locked == true || native.screensaver == true
            if reportedLock != locked {
                reportedLock = locked
                let current = bound
                actions.append { [weak self] in
                    guard let self, self.locked({ !self.closed && self.reportedLock == locked &&
                        self.sampledAt != nil && (self.native?.locked == true || self.native?.screensaver == true) == locked }) else { return }
                    if let current, self.session()?.observationEpoch != current.observationEpoch { return }
                    if locked, let current, !self.pause(current, "locked") { return }
                    self.emit(Event(name: "locked", fields: ["locked": .bool(locked)]), current)
                }
            }
        }
        guard let current = bound else { return }
        let status = detection(at: time, session: current)
        let secure = status.secure, reason = status.reason, signature = status.signature
        let elapsed = disabledSince.map { age(time, $0) >= 1_000_000_000 } == true
        // Desktop treats every negative detection event as take-over. A fresh phase must obtain its
        // own nonce without immediately pausing itself; admission stays closed throughout this grace.
        let initialSample = native == nil && sampleBusy && age(time, sampleStarted) < 500_000_000
        if reason != nil && !secure && !elapsed && (available == .available || initialSample) { return }
        let observedUnknown = native != nil || age(time, sampleStarted) >= 500_000_000
        let mustPause = available != .available && observedUnknown || secure || reason != nil && elapsed
        guard reportedDetection != signature || mustPause && pausedDetection != signature else { return }
        reportedDetection = signature
        if mustPause { pausedDetection = signature }
        if reason == nil { pausedDetection = nil }
        var fields: [String: JSONValue] = ["alive": .bool(reason == nil)]
        if let reason { fields["reason"] = .string(reason) }
        if secure, let holder = native?.holder { fields["holder"] = .string(holder) }
        actions.append(scoped(current) { [weak self] in
            guard let self else { return }
            guard self.locked({ !self.closed && self.reportedDetection == signature }) else { return }
            if mustPause && !self.pause(current, secure ? "secure_input" : available == .locked ? "locked" : "detection") { return }
            guard self.session()?.observationEpoch == current.observationEpoch else { return }
            self.emit(Event(name: "input_detection", fields: fields), current)
        })
    }
}

enum WatchdogSystem {
    // Public CGSession/IORegistry readers; these key spellings are published by Apple's kernel source:
    // https://github.com/apple-oss-distributions/xnu/blob/main/iokit/IOKit/IOKitKeysPrivate.h
    // IOService.cpp updateConsoleUsers: locked starts explicitly false at line7445, becomes true for
    // sleep/no-console/expired grace at7511–7544, and is published at7549; users are copied at7551.
    // https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOService.cpp#L7442-L7553
    // Actual macOS15.5 IOConsoleUsers output omits the per-session lock marker on an interactive console:
    // https://github.com/iina/iina/issues/6301 (only key presence/types are relevant, never account labels).
    // No private CGS ABI is called. Absence of that marker alone is never unlocked proof.
    static func sample() -> WatchdogNativeState {
        let before = (CGSessionCopyCurrentDictionary() as? [String: Any]).map(facts)
        let entry = IORegistryGetRootEntry(kIOMainPortDefault)
        defer { if entry != 0 { IOObjectRelease(entry) } }
        let registryBefore = registry(entry)
        let secureBefore = IsSecureEventInputEnabled()
        let pidBefore = secureBefore ? holderPID(entry, uid: Int(getuid())) : nil
        var holder: String?
        if let pid = pidBefore, let processBefore = HelperLifecycle.processIdentity(pid),
           let owner = try? NativeIdentityReader.observe(pid: pid), let processAfter = HelperLifecycle.processIdentity(pid),
           holderPID(entry, uid: Int(getuid())) == pid {
            holder = secureHolder(pid: pid, before: processBefore, owner: owner, after: processAfter)
        }
        let saver = screensaver()
        let registryAfter = registry(entry)
        let after = (CGSessionCopyCurrentDictionary() as? [String: Any]).map(facts)
        let secureAfter = IsSecureEventInputEnabled()
        return .decode(session: before, after: after, registry: registryBefore, registryAfter: registryAfter,
                       uid: Int(getuid()), screensaver: saver, secureInput: secureAfter,
                       holder: secureBefore && secureAfter ? holder : nil)
    }

    static func registry(_ entry: io_registry_entry_t) -> WatchdogConsoleSnapshot? {
        guard entry != 0 else { return nil }
        var properties: Unmanaged<CFMutableDictionary>?
        let status = IORegistryEntryCreateCFProperties(entry, &properties, kCFAllocatorDefault, 0)
        let retained = properties?.takeRetainedValue()
        guard status == KERN_SUCCESS, let dictionary = retained as? [String: Any] else { return nil }
        return registryFacts(dictionary)
    }

    static func registryFacts(_ dictionary: [String: Any]) -> WatchdogConsoleSnapshot {
        guard dictionary.count <= 256 else { return WatchdogConsoleSnapshot(rootLocked: .null, users: nil) }
        let root: JSONValue? = dictionary["IOConsoleLocked"].map { boolean($0).map(JSONValue.bool) ?? .null }
        var users: [[String: JSONValue]]?
        if let array = dictionary["IOConsoleUsers"] as? [Any], array.count <= 64,
           let rows = array as? [[String: Any]] { users = rows.map(facts) }
        return WatchdogConsoleSnapshot(rootLocked: root, users: users)
    }

    /// Holder PID/name churn is deliberately separate from the lock-critical coherence snapshot.
    static func holderPID(_ entry: io_registry_entry_t, uid: Int) -> pid_t? {
        guard entry != 0,
              let value = IORegistryEntryCreateCFProperty(entry, "IOConsoleUsers" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue(),
              let users = value as? [[String: Any]], users.count <= 64 else { return nil }
        let active = users.filter { boolean($0[kCGSessionOnConsoleKey as String]) == true }
        guard active.count == 1, let current = active.first,
              integer(current[kCGSessionUserIDKey as String]) == uid,
              boolean(current[kCGSessionLoginDoneKey as String]) == true,
              let pid = integer(current["kCGSSessionSecureInputPID"]), pid > 0 else { return nil }
        return pid_t(pid)
    }

    static func secureHolder(pid: pid_t, before: HelperProcessIdentity, owner: NativeOwner,
                             after: HelperProcessIdentity) -> String? {
        let name = owner.identity.name
        guard pid > 0, before.pid == pid, before == after, owner.process == before,
              owner.identity.pid == Int(pid), !name.isEmpty, name.utf16.count <= 256,
              MacAppIdentity.safeName(name) else { return nil }
        return name
    }

    static func facts(_ dictionary: [String: Any]) -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        if let raw = dictionary[kCGSessionUserIDKey as String] { result["uid"] = integer(raw).map { JSONValue.integer(Int64($0)) } ?? .null }
        if let raw = dictionary[kCGSessionOnConsoleKey as String] { result["onConsole"] = boolean(raw).map(JSONValue.bool) ?? .null }
        if let raw = dictionary[kCGSessionLoginDoneKey as String] { result["loginDone"] = boolean(raw).map(JSONValue.bool) ?? .null }
        if let raw = dictionary["CGSSessionScreenIsLocked"] { result["locked"] = boolean(raw).map(JSONValue.bool) ?? .null }
        return result
    }
    static func boolean(_ value: Any?) -> Bool? {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return value.boolValue
    }
    static func integer(_ value: Any?) -> Int? {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFNumberGetTypeID(),
              value.doubleValue.isFinite, value.doubleValue.rounded() == value.doubleValue,
              value.doubleValue >= 0, value.doubleValue <= Double(Int32.max) else { return nil }
        return value.intValue
    }

    /// This proves known signed visible engines active; their absence is not a complete Sonoma saver API.
    /// Distributed saver-start hints therefore also pause, but saver-stop hints can never resume a task.
    static func screensaver() -> Bool? {
        guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]],
              windows.count <= 4096 else { return nil }
        let visible = Set(windows.compactMap { window -> pid_t? in
            guard let pid = integer(window[kCGWindowOwnerPID as String]), pid > 0,
                  let alpha = window[kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue > 0 else { return nil }
            return pid_t(pid)
        })
        let paths: Set<String> = [
            "/System/Library/CoreServices/ScreenSaverEngine.app/Contents/MacOS/ScreenSaverEngine",
            "/System/Library/Frameworks/ScreenSaver.framework/Resources/ScreenSaverEngine.app/Contents/MacOS/ScreenSaverEngine",
        ]
        let applications = NSWorkspace.shared.runningApplications
        guard applications.count <= 4096 else { return nil }
        for app in applications where visible.contains(app.processIdentifier) {
            guard app.bundleIdentifier?.lowercased() == "com.apple.screensaver.engine" else { continue }
            guard let owner = try? NativeIdentityReader.observe(pid: app.processIdentifier),
                  owner.identity.verified, owner.identity.apple, owner.identity.system,
                  paths.contains(owner.process.executable) else { return nil }
            return true
        }
        return false
    }

    static func observe(_ callback: @escaping (WatchdogHint) -> Void) -> () -> Void {
        let workspace = NSWorkspace.shared.notificationCenter
        let notifications: [(Notification.Name, WatchdogHint)] = [
            (NSWorkspace.willSleepNotification, .sleep), (NSWorkspace.didWakeNotification, .wake),
            (NSWorkspace.screensDidSleepNotification, .displaySleep), (NSWorkspace.screensDidWakeNotification, .displayWake),
            (NSWorkspace.sessionDidResignActiveNotification, .sessionResigned),
            (NSWorkspace.sessionDidBecomeActiveNotification, .sessionBecameActive),
        ]
        let tokens = notifications.map { name, hint in workspace.addObserver(forName: name, object: nil, queue: nil) { _ in callback(hint) } }
        let distributed = DistributedNotificationCenter.default()
        let hints: [(String, WatchdogHint)] = [("com.apple.screenIsLocked", .locked), ("com.apple.screenIsUnlocked", .unlocked),
            ("com.apple.screensaver.didstart", .screensaverStarted), ("com.apple.screensaver.didstop", .screensaverStopped)]
        let distributedTokens = hints.map { name, hint in
            distributed.addObserver(forName: Notification.Name(name), object: nil, queue: nil) { _ in callback(hint) }
        }
        return { tokens.forEach { workspace.removeObserver($0) }; distributedTokens.forEach { distributed.removeObserver($0) } }
    }
}
