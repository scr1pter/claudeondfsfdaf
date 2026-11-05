import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Dispatch
import Foundation
import ImageIO
import Security

enum PrivilegedCheckCatalog {
    static let names = ["privileged-isolated-target", "capture-color-patch", "capture-overlay-exclusion",
        "ax-counter-increment", "ax-value-set-and-readback", "secure-field-refusal", "tagged-click-increments",
        "stale-capture-refusal", "background-ax-without-pointer-or-focus", "background-selection-insertion",
        "helper-tagged-escape-ignored", "foreign-escape-stops", "owned-input-release", "isolated-target-cleanup"]
    static let reasons: Set<String> = ["responsibility_missing", "accessibility_denied", "screen_denied", "post_event_denied",
        "target_post_event_denied", "noninteractive_desktop", "input_detection_unavailable", "physical_takeover",
        "target_unavailable", "target_validation_failed", "target_spawn_failed", "target_handshake_failed",
        "target_process_changed", "target_responsibility_missing", "target_state_invalid", "target_identity_unavailable",
        "target_options_invalid", "target_bundle_invalid", "target_control_invalid", "target_application_failed",
        "target_report_invalid", "target_encoding_failed", "target_output_failed", "target_exited", "target_crashed",
        "assertion_failed", "native_operation_failed", "deadline_exceeded", "cleanup_failed"]
}

struct PrivilegedCheckResult {
    let name: String
    let ok: Bool
    var skipped = false
    var detail: String? = nil
    var wire: JSONValue {
        var fields: [String: JSONValue] = ["name": .string(name), "ok": .bool(ok)]
        if skipped { fields["skipped"] = .bool(true) }
        if let detail { fields["detail"] = .string(detail) }
        return .object(fields)
    }
}

struct PrivilegedCheckReport {
    let checks: [PrivilegedCheckResult]
    var valid: Bool {
        checks.map(\.name) == PrivilegedCheckCatalog.names && checks.allSatisfy {
            !($0.ok && $0.skipped) && ($0.detail.map(PrivilegedCheckCatalog.reasons.contains) ?? true)
        }
    }
    var exitCode: Int32 { !valid || checks.contains { !$0.ok && !$0.skipped } ? 1 : checks.contains { $0.skipped } ? 77 : 0 }
    var wire: JSONValue {
        let safe = valid ? checks : PrivilegedCheckCatalog.names.map {
            PrivilegedCheckResult(name: $0, ok: false, detail: "native_operation_failed")
        }
        return .object(["checks": .array(safe.map(\.wire))])
    }
    static func skipped(_ reason: String) -> PrivilegedCheckReport {
        PrivilegedCheckReport(checks: PrivilegedCheckCatalog.names.map { PrivilegedCheckResult(name: $0, ok: false, skipped: true, detail: reason) })
    }
}

struct PrivilegedTargetEvidence {
    let bundlePath: String
    let executablePath: String
    let identifier: String
    let sealedIdentifier: String
    let sourceDigest: String
    let signatureValid: Bool
    let hardenedRuntime: Bool
    let emptyEntitlements: Bool
}

enum PrivilegedTargetPolicy {
    static let identifier = "ai.vector.computer.test-target"
    static let executable = "VectorComputerTestTarget"
    static let foreignTag: Int64 = 0x5654435446474553
    static func hex(_ value: String, count: Int) -> Bool {
        value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func valid(_ evidence: PrivilegedTargetEvidence, expectedSource: String) -> Bool {
        evidence.signatureValid && evidence.hardenedRuntime && evidence.emptyEntitlements &&
            evidence.identifier == identifier && evidence.sealedIdentifier == identifier && hex(expectedSource, count: 64) &&
            evidence.sourceDigest.utf8.elementsEqual(expectedSource.utf8) &&
            MacAppIdentity.canonicalPathShape(evidence.bundlePath) && evidence.bundlePath.hasSuffix("/VectorComputerTestTarget.app") &&
            evidence.executablePath.utf8.elementsEqual((evidence.bundlePath + "/Contents/MacOS/" + executable).utf8)
    }
    static func rect(_ value: JSONValue?) -> CGRect? {
        guard let fields = value?.objectValue, Set(fields.keys) == ["x", "y", "w", "h"],
              let x = fields["x"]?.doubleValue, let y = fields["y"]?.doubleValue,
              let width = fields["w"]?.doubleValue, let height = fields["h"]?.doubleValue,
              [x, y, width, height].allSatisfy({ $0.isFinite && abs($0) <= 1_000_000 }),
              width > 0, height > 0 else { return nil }
        let result = CGRect(x: x, y: y, width: width, height: height)
        return CapturePrivacy.valid(result) ? result : nil
    }
    static func state(_ value: JSONValue, pid: pid_t, parent: pid_t, evidence: PrivilegedTargetEvidence) -> Bool {
        guard let fields = value.objectValue,
              pid > 1, parent > 1,
              Set(fields.keys) == ["pid", "parentPID", "bundleID", "bundlePath", "executablePath", "sourceDigest", "ready",
                  "windowNumber", "backdropWindowNumber", "windowBounds", "backdropBounds", "views", "patchRGB", "backdropRGB",
                  "counter", "text", "secure", "visible", "minimized", "foreground", "postEvent", "events", "foreignEsc"],
              fields["pid"]?.intValue == Int(pid), fields["parentPID"]?.intValue == Int(parent),
              fields["bundleID"]?.stringValue == identifier,
              fields["bundlePath"]?.stringValue?.utf8.elementsEqual(evidence.bundlePath.utf8) == true,
              fields["executablePath"]?.stringValue?.utf8.elementsEqual(evidence.executablePath.utf8) == true,
              fields["sourceDigest"]?.stringValue == evidence.sourceDigest, fields["ready"]?.boolValue == true,
              let window = fields["windowNumber"]?.intValue, window > 0, window <= Int(UInt32.max),
              let backdrop = fields["backdropWindowNumber"]?.intValue, backdrop > 0, backdrop <= Int(UInt32.max), window != backdrop,
              let mainBounds = rect(fields["windowBounds"]), let backBounds = rect(fields["backdropBounds"]),
              mainBounds != backBounds, backBounds.contains(mainBounds),
              let views = fields["views"]?.objectValue, Set(views.keys) == ["patch", "button", "text", "secure"],
              fields["patchRGB"] == .array([.integer(32), .integer(128), .integer(192)]),
              fields["backdropRGB"] == .array([.integer(224), .integer(96), .integer(32)]),
              let counter = fields["counter"]?.intValue, (0...1_000_000).contains(counter),
              fields["visible"]?.boolValue != nil, fields["minimized"]?.boolValue != nil,
              fields["foreground"]?.boolValue != nil, fields["postEvent"]?.boolValue != nil else { return false }
        for name in ["patch", "button", "text", "secure"] {
            guard let view = views[name]?.objectValue, Set(view.keys) == ["identifier", "bounds"],
                  views[name]?["identifier"]?.stringValue == "fixture." + name,
                  let bounds = rect(views[name]?["bounds"]), mainBounds.contains(bounds) else { return false }
        }
        for name in ["text", "secure"] {
            guard let summary = fields[name]?.objectValue, Set(summary.keys).isSubset(of: ["length", "sha256", "selection"]),
                  let length = summary["length"]?.intValue, (0...4000).contains(length),
                  let digest = summary["sha256"]?.stringValue, hex(digest, count: 64) else { return false }
            if let range = summary["selection"], range != .null {
                guard let selection = range.objectValue, Set(selection.keys) == ["location", "length"],
                      let location = range["location"]?.intValue, let count = range["length"]?.intValue,
                      location >= 0, location <= length, count >= 0, count <= length - location else { return false }
            }
        }
        guard let events = fields["events"]?.objectValue,
              Set(events.keys) == ["keyDowns", "keyUps", "buttonDowns", "buttonUps", "heldKeys", "heldButtons", "escapes"],
              events.values.allSatisfy({ $0.intValue.map { (0...1_000_000).contains($0) } == true }),
              (events["heldKeys"]?.intValue ?? 129) <= 128, (events["heldButtons"]?.intValue ?? 9) <= 8,
              let foreign = fields["foreignEsc"]?.objectValue,
              Set(foreign.keys) == ["status", "pid", "tag"],
              foreign["pid"]?.intValue == Int(pid), foreign["tag"]?.stringValue == "5654435446474553",
              ["idle", "posted", "not_granted", "not_foreground", "not_isolated", "failed"].contains(foreign["status"]?.stringValue ?? "") else { return false }
        return true
    }
}

enum PrivilegedTargetStage: String, CaseIterable {
    case spawn = "target_spawn_failed", handshake = "target_handshake_failed", process = "target_process_changed"
    case responsibility = "target_responsibility_missing", state = "target_state_invalid", identity = "target_identity_unavailable"
    case options = "target_options_invalid", bundle = "target_bundle_invalid", control = "target_control_invalid"
    case application = "target_application_failed", report = "target_report_invalid", output = "target_output_failed"
    case encoding = "target_encoding_failed"
    case exited = "target_exited", crashed = "target_crashed"

    static func failure(waitStatus: Int32) -> PrivilegedTargetStage {
        guard waitStatus & 0x7f == 0 else { return .crashed }
        switch HelperLifecycle.exitCode(waitStatus: waitStatus) {
        case 20: return .options
        case 21: return .bundle
        case 22: return .control
        case 23: return .application
        case 24: return .state
        case 25: return .output
        case 26: return .encoding
        default: return .exited
        }
    }
}
private enum PrivilegedTestFailure: Error { case assertion, operation, timeout, interrupted, target(PrivilegedTargetStage) }

/// Own child and two private pipes only. No shell, inherited helper descriptor, or generic command endpoint.
private final class PrivilegedTargetChannel {
    let evidence: PrivilegedTargetEvidence
    let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    private let lock = NSLock()
    private var pid: pid_t = 0
    private var process: HelperProcessIdentity?
    private var input: Int32 = -1
    private var output: Int32 = -1
    private var source: DispatchSourceRead?
    private var buffered = Data()
    private var replies: [Int: JSONValue] = [:]
    private var nextID = 0
    private var failed = false
    private var malformed = false
    private var closed = false

    init(path: String, sourceDigest: String) throws {
        evidence = try Self.observe(path: path, sourceDigest: sourceDigest)
    }
    private static func canonical(_ path: String) throws -> String {
        guard let raw = realpath(path, nil) else { throw PrivilegedTestFailure.operation }
        defer { free(raw) }; return String(cString: raw)
    }
    private static func observe(path: String, sourceDigest: String) throws -> PrivilegedTargetEvidence {
        let root = try canonical(path), executable = try canonical(root + "/Contents/MacOS/" + PrivilegedTargetPolicy.executable)
        var infoStat = stat(), executableStat = stat()
        guard lstat(root + "/Contents/Info.plist", &infoStat) == 0, infoStat.st_mode & S_IFMT == S_IFREG,
              infoStat.st_size > 0, infoStat.st_size <= 1_048_576,
              lstat(executable, &executableStat) == 0, executableStat.st_mode & S_IFMT == S_IFREG,
              executableStat.st_mode & mode_t(S_ISUID | S_ISGID) == 0,
              let info = NSDictionary(contentsOf: URL(fileURLWithPath: root + "/Contents/Info.plist")) else { throw PrivilegedTestFailure.operation }
        var code: SecStaticCode?, signing: CFDictionary?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: root) as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate).union(.noNetworkAccess), nil) == errSecSuccess,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &signing) == errSecSuccess,
              let signing else { throw PrivilegedTestFailure.operation }
        let fields = signing as NSDictionary
        let flags = SecCodeSignatureFlags(rawValue: (fields[kSecCodeInfoFlags] as? NSNumber)?.uint32Value ?? 0)
        let sealed = fields[kSecCodeInfoPList] as? NSDictionary
        let entitlements = fields[kSecCodeInfoEntitlementsDict] as? NSDictionary
        let result = PrivilegedTargetEvidence(bundlePath: root, executablePath: executable,
            identifier: fields[kSecCodeInfoIdentifier] as? String ?? "", sealedIdentifier: sealed?["CFBundleIdentifier"] as? String ?? "",
            sourceDigest: sealed?["VectorComputerSourceDigest"] as? String ?? "", signatureValid: true,
            hardenedRuntime: flags.contains(.runtime), emptyEntitlements: entitlements == nil || entitlements?.count == 0)
        guard info["CFBundleExecutable"] as? String == PrivilegedTargetPolicy.executable,
              PrivilegedTargetPolicy.valid(result, expectedSource: sourceDigest) else { throw PrivilegedTestFailure.operation }
        return result
    }
    func launch() throws -> JSONValue {
        var incoming = [Int32](repeating: -1, count: 2), outgoing = [Int32](repeating: -1, count: 2)
        guard pipe(&incoming) == 0 else { throw PrivilegedTestFailure.target(.spawn) }
        guard pipe(&outgoing) == 0 else { incoming.forEach { _ = Darwin.close($0) }; throw PrivilegedTestFailure.target(.spawn) }
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0, posix_spawnattr_init(&attributes) == 0 else {
            (incoming + outgoing).forEach { _ = Darwin.close($0) }; throw PrivilegedTestFailure.target(.spawn)
        }
        defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
        var defaults = sigset_t(), mask = sigset_t(); sigfillset(&defaults); sigemptyset(&mask)
        guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)) == 0,
              posix_spawnattr_setpgroup(&attributes, 0) == 0, posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
              posix_spawnattr_setsigmask(&attributes, &mask) == 0, HelperLifecycle.disclaimSpawn(&attributes),
              posix_spawn_file_actions_adddup2(&actions, incoming[0], STDIN_FILENO) == 0,
              posix_spawn_file_actions_adddup2(&actions, outgoing[1], STDOUT_FILENO) == 0,
              (incoming + outgoing).allSatisfy({ posix_spawn_file_actions_addclose(&actions, $0) == 0 }),
              posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0 else {
            (incoming + outgoing).forEach { _ = Darwin.close($0) }; throw PrivilegedTestFailure.target(.spawn)
        }
        let args = [evidence.executablePath, "--nonce", nonce, "--artifact", evidence.sourceDigest,
            "--parent-pid", String(getpid()), "--isolated"]
        let environment = ["PATH=/usr/bin:/bin", "HOME=" + NSHomeDirectory(), "TMPDIR=" + NSTemporaryDirectory()]
        let allocated = (args + environment).map { $0.withCString { strdup($0) } }
        defer { allocated.forEach { free($0) } }
        guard allocated.allSatisfy({ $0 != nil }) else { (incoming + outgoing).forEach { _ = Darwin.close($0) }; throw PrivilegedTestFailure.target(.spawn) }
        var argv = Array(allocated.prefix(args.count)) + [nil], envp = Array(allocated.dropFirst(args.count)) + [nil]
        var launched: pid_t = 0
        // Publication and close share one fence: cancellation cannot leave a late child unowned.
        lock.lock()
        guard !closed, pid == 0 else {
            lock.unlock(); (incoming + outgoing).forEach { _ = Darwin.close($0) }; throw PrivilegedTestFailure.interrupted
        }
        let result = posix_spawn(&launched, evidence.executablePath, &actions, &attributes, &argv, &envp)
        _ = Darwin.close(incoming[0]); _ = Darwin.close(outgoing[1])
        guard result == 0, launched > 1 else {
            lock.unlock(); _ = Darwin.close(incoming[1]); _ = Darwin.close(outgoing[0]); throw PrivilegedTestFailure.target(.spawn)
        }
        pid = launched; input = incoming[1]; output = outgoing[0]
        guard fcntl(input, F_SETFL, fcntl(input, F_GETFL) | O_NONBLOCK) == 0,
              fcntl(output, F_SETFL, fcntl(output, F_GETFL) | O_NONBLOCK) == 0 else { lock.unlock(); throw PrivilegedTestFailure.target(.spawn) }
        let read = DispatchSource.makeReadSource(fileDescriptor: output, queue: DispatchQueue(label: "ai.vector.self-test.target-output"))
        read.setEventHandler { [weak self] in self?.receive() }; source = read; read.resume(); lock.unlock()
        let ready: JSONValue
        do { ready = try awaitReply(0, milliseconds: 8000) }
        catch PrivilegedTestFailure.timeout { throw PrivilegedTestFailure.timeout }
        catch PrivilegedTestFailure.interrupted { throw PrivilegedTestFailure.interrupted }
        catch { throw PrivilegedTestFailure.target(handshakeFailure()) }
        guard let actual = HelperLifecycle.processIdentity(launched), actual.executable.utf8.elementsEqual(evidence.executablePath.utf8) else {
            throw PrivilegedTestFailure.target(.process)
        }
        guard HelperLifecycle.responsiblePID(for: actual) == launched else { throw PrivilegedTestFailure.target(.responsibility) }
        guard PrivilegedTargetPolicy.state(ready, pid: launched, parent: getpid(), evidence: evidence) else {
            throw PrivilegedTestFailure.target(.state)
        }
        lock.lock()
        guard !closed, pid == launched else { lock.unlock(); throw PrivilegedTestFailure.interrupted }
        process = actual; lock.unlock()
        return ready
    }
    var targetPID: pid_t { lock.lock(); defer { lock.unlock() }; return pid }
    func command(_ op: String, _ fields: [String: JSONValue] = [:]) throws -> JSONValue {
        lock.lock()
        guard !closed, !failed, input >= 0, let process, HelperLifecycle.processIdentity(pid) == process else { lock.unlock(); throw PrivilegedTestFailure.operation }
        nextID += 1; let id = nextID; let descriptor = input; lock.unlock()
        var request = fields; request["id"] = .integer(Int64(id)); request["nonce"] = .string(nonce); request["op"] = .string(op)
        var bytes = try JSONEncoder().encode(JSONValue.object(request)); bytes.append(10)
        guard bytes.count <= 16 * 1024 else { throw PrivilegedTestFailure.operation }
        let limit = DispatchTime.now().uptimeNanoseconds + 100_000_000
        var offset = 0
        while offset < bytes.count, DispatchTime.now().uptimeNanoseconds < limit {
            let count = bytes.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress!.advanced(by: offset), $0.count - offset) }
            if count > 0 { offset += count }
            else if count < 0 && errno == EINTR { continue }
            else if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { usleep(1000) }
            else { throw PrivilegedTestFailure.operation }
        }
        guard offset == bytes.count else { throw PrivilegedTestFailure.timeout }
        let state = try awaitReply(id, milliseconds: 2500)
        guard PrivilegedTargetPolicy.state(state, pid: process.pid, parent: getpid(), evidence: evidence) else { throw PrivilegedTestFailure.operation }
        return state
    }
    private func receive() {
        lock.lock(); defer { lock.unlock() }
        guard !closed, !failed else { return }
        var bytes = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = bytes.withUnsafeMutableBytes { Darwin.read(output, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { break }
            guard count > 0 else { failed = true; return }
            buffered.append(contentsOf: bytes.prefix(count))
            while let newline = buffered.firstIndex(of: 10) {
                let frame = Data(buffered[..<newline]); buffered.removeSubrange(...newline)
                guard frame.count <= 16 * 1024, let packet = try? JSONDecoder().decode(JSONValue.self, from: frame),
                      let object = packet.objectValue, Set(object.keys).isSubset(of: ["id", "nonce", "ok", "state", "code"]),
                      let id = object["id"]?.intValue, id >= 0, object["nonce"]?.stringValue == nonce,
                      object["ok"]?.boolValue == true, let state = object["state"], replies.count < 16, replies[id] == nil else { malformed = true; failed = true; return }
                replies[id] = state
            }
            if buffered.count > 16 * 1024 { malformed = true; failed = true; return }
        }
    }
    private func handshakeFailure() -> PrivilegedTargetStage {
        // Only this unreaped child is inspected. Reaping and PID retirement share close's fence,
        // so cancellation cannot kill a reused PID after an exit diagnostic consumes its status.
        for _ in 0..<10 {
            lock.lock()
            if malformed { lock.unlock(); return .report }
            guard !closed, pid > 1 else { lock.unlock(); return .handshake }
            var status: Int32 = 0
            let result = waitpid(pid, &status, WNOHANG)
            let nativeError = errno
            if result == pid { pid = 0; process = nil; lock.unlock(); return PrivilegedTargetStage.failure(waitStatus: status) }
            lock.unlock()
            if result < 0 && nativeError != EINTR { return .handshake }
            _ = CFRunLoopRunInMode(.defaultMode, 0.01, true)
        }
        return .handshake
    }
    private func awaitReply(_ id: Int, milliseconds: UInt64) throws -> JSONValue {
        let deadline = DispatchTime.now().uptimeNanoseconds + milliseconds * 1_000_000
        while DispatchTime.now().uptimeNanoseconds < deadline {
            lock.lock(); let value = replies.removeValue(forKey: id); let failed = self.failed; let closed = self.closed; lock.unlock()
            if closed { throw PrivilegedTestFailure.interrupted }
            if let value { return value }; if failed { throw PrivilegedTestFailure.operation }
            _ = CFRunLoopRunInMode(.defaultMode, 0.01, true)
        }
        throw PrivilegedTestFailure.timeout
    }
    func close() -> Bool {
        lock.lock()
        if closed { let done = pid == 0; lock.unlock(); return done }
        closed = true; let child = pid; let write = input; let read = output
        input = -1; output = -1; lock.unlock()
        source?.cancel(); source = nil
        if write >= 0 { _ = Darwin.close(write) }; if read >= 0 { _ = Darwin.close(read) }
        guard child > 1 else { return true }
        // This remains our unreaped child. The PID cannot be reused before waitpid reaps it.
        _ = Darwin.kill(child, SIGTERM)
        let deadline = DispatchTime.now().uptimeNanoseconds + 400_000_000
        var status: Int32 = 0
        while DispatchTime.now().uptimeNanoseconds < deadline {
            let result = waitpid(child, &status, WNOHANG)
            if result == child || result == -1 && errno == ECHILD { lock.lock(); pid = 0; lock.unlock(); return true }
            _ = CFRunLoopRunInMode(.defaultMode, 0.01, true)
        }
        _ = Darwin.kill(child, SIGKILL)
        for _ in 0..<20 {
            let result = waitpid(child, &status, WNOHANG)
            if result == child || result == -1 && errno == ECHILD { lock.lock(); pid = 0; lock.unlock(); return true }
            usleep(5000)
        }
        return false
    }
}

private struct PrivilegedReply { let fields: [String: JSONValue]; let image: Data? }

/// The same concrete services, authority dispatcher and native monitors as serving. No synthetic backend
/// participates in an opt-in privileged scenario; only the transport is an in-process request mailbox.
private final class PrivilegedRuntime {
    private let lock = NSLock()
    let captures = CaptureRegistry()
    lazy var capture = CaptureService(registry: captures)
    lazy var accessibility = AccessibilityService(captures: captures)
    lazy var input = InputService(captures: captures, accessibility: accessibility)
    private var sequence = 0
    private var pending = Set<Int>()
    private var replies: [Int: Result<PrivilegedReply, ServerFailure>] = [:]
    private var events: [Event] = []
    private var cancelled = false
    private var physical = false
    private var expectedForeign = false
    private var currentForeignSample = false
    private var foreignStops = 0
    private var targetPID: pid_t = 0
    private var targetExecutable = ""
    private var ownEscapes = 0
    private var foreignEscapes = 0
    private var heartbeats: DispatchSourceTimer?
    private let monitoring = DispatchQueue(label: "ai.vector.self-test.monitoring")

    init() {
        // Parent-death cleanup can arrive on another queue as soon as this object is published.
        // Constructors do not start native queries; initialize the graph before concurrent access.
        _ = capture; _ = accessibility; _ = input; _ = watchdog; _ = dispatcher; _ = tap
    }

    lazy var tap: EventTapMonitor = {
        let native = EventTapBackend.system
        let observed = EventTapBackend(start: { [weak self] callback, status in
            native.start({ sample in
                self?.observe(sample)
                return callback(sample)
            }, status)
        }, execute: native.execute, recover: native.recover, probe: native.probe, close: native.close,
            cursor: native.cursor, chord: native.chord)
        return EventTapMonitor(session: { [weak self] in self?.dispatcher.sessionSnapshot() }, input: { [weak self] event, session, takeover in
            guard let self else { return false }
            if takeover { self.lock.lock(); self.physical = true; self.lock.unlock() }
            return self.dispatcher.handlePhysicalInput(event, expected: session, takeover: takeover)
        }, stop: { [weak self] by, session in
            guard let self else { return false }
            self.lock.lock(); let fixtureEvent = self.expectedForeign && self.currentForeignSample; self.lock.unlock()
            let accepted = self.dispatcher.stopFromPhysicalInput(by: by, expected: session)
            if accepted {
                self.lock.lock()
                if fixtureEvent { self.foreignStops += 1 } else { self.physical = true }
                self.lock.unlock()
            }
            return accepted
        }, status: { [weak self] in self?.watchdog.observeTap($0) }, backend: observed)
    }()
    lazy var watchdog: WatchdogService = WatchdogService(session: { [weak self] in self?.dispatcher.sessionSnapshot() },
        tapStatus: { [weak self] in self?.tap.status() ?? EventTapStatus(generation: 0, installed: false, enabled: false) },
        recoverTap: { [weak self] in self?.tap.recover() }, probeTap: { [weak self] in self?.tap.probe(challenge: $0) },
        pause: { [weak self] session, reason in self?.dispatcher.pauseForEnvironment(expected: session, reason: reason) ?? false },
        emit: { [weak self] event, session in _ = self?.dispatcher.publishNativeEvent(event, expected: session) },
        environmentChanged: { [weak self] _ in guard let self else { return }; self.dispatcher.setDesktopAvailability(self.watchdog.availability()) })
    lazy var dispatcher: Dispatcher = Dispatcher(responsible: HelperLifecycle.isSelfResponsible(), architecture: "self-test",
        operatingSystem: ProcessInfo.processInfo.operatingSystemVersionString, send: { [weak self] in self?.receive($0, image: nil) },
        event: { [weak self] in self?.receiveEvent($0) }, releaseAll: { [weak self] in self?.input.releaseAll() ?? 0 },
        observationsInvalidated: { [weak self] in self?.capture.invalidateDisplays(); self?.accessibility.invalidateObservations() },
        cleanupRequested: { [weak self] reason in
            if ["close", "physical-input", "stop", "environment", "heartbeat", "replacement", "end", "cancel"].contains(reason) {
                self?.accessibility.invalidateObservations(hard: true)
            }
        }, sessionChanged: { [weak self] session in
            guard let self else { return }
            self.accessibility.noteSession(session)
            self.monitoring.async {
                self.tap.refreshSession(); self.watchdog.refreshSession()
                self.accessibility.retireWakes(session: self.dispatcher.sessionSnapshot())
            }
        }, desktopAvailability: { [weak self] in self?.watchdog.availability() ?? .unknown },
        foregroundReady: { [weak self] in self?.watchdog.foregroundReady($0) ?? false },
        nativeEventIsCurrent: { [weak self] event, session in
            guard let self else { return false }
            if ["locked", "input_detection"].contains(event.value["event"]?.stringValue ?? "") {
                return self.watchdog.eventIsCurrent(event: event, expected: session)
            }
            return true
        }, sendImage: { [weak self] in self?.receive($0, image: $1) },
        features: { [weak self] in self?.input.features() ?? [:] }, permissions: { PermissionService().status() })

    func start(target: pid_t, executable: String) {
        lock.lock(); let ended = cancelled; lock.unlock()
        guard !ended else { return }
        targetPID = target; targetExecutable = executable
        dispatcher.register(op: "capture", deadlineMs: 10000) { [self] req, context, done in capture.capture(req.args, context: context, completion: done) }
        dispatcher.register(op: "ui.tree", deadlineMs: 15000) { [self] req, context, done in accessibility.tree(req.args, context: context, completion: done) }
        dispatcher.register(op: "ui.focused", deadlineMs: 10000) { [self] req, context, done in accessibility.focused(req.args, context: context, completion: done) }
        dispatcher.register(op: "ui.resolve", deadlineMs: 10000) { [self] req, context, done in accessibility.resolve(req.args, context: context, completion: done) }
        dispatcher.register(op: "ui.perform", deadlineMs: 10000, mutating: true) { [self] req, context, done in accessibility.perform(req.args, context: context, completion: done) }
        dispatcher.register(op: "ui.setValue", deadlineMs: 10000, mutating: true) { [self] req, context, done in accessibility.setValue(req.args, context: context, completion: done) }
        for op in ["input.click", "input.key", "input.type", "input.hold"] {
            dispatcher.register(op: op, deadlineMs: 10000, mutating: true) { [self] req, context, done in input.handle(op: req.op, args: req.args, context: context, completion: done) }
        }
        // Finite, isolated probe: exercise the real HID callback with this worker's actual PID/tag.
        // This is deliberately not a serving operation or a generic event injection endpoint.
        dispatcher.register(op: "self-test.ownEscape", deadlineMs: 3000, mutating: true) { [self] _, context, done in
            var passed = false
            let admitted = context.withCurrent {
                guard CGPreflightPostEventAccess(), NSWorkspace.shared.frontmostApplication?.processIdentifier == self.targetPID,
                      let process = HelperLifecycle.processIdentity(self.targetPID),
                      process.executable == self.targetExecutable,
                      let source = CGEventSource(stateID: .privateState),
                      let down = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: false) else { return }
                down.flags = []; up.flags = []
                down.setIntegerValueField(.eventSourceUserData, value: InputNative.eventTag)
                up.setIntegerValueField(.eventSourceUserData, value: InputNative.eventTag)
                down.post(tap: .cghidEventTap)
                // Matching cleanup stays directed to the original proven process after focus changes.
                if HelperLifecycle.processIdentity(self.targetPID) == process { up.postToPid(self.targetPID) }
                passed = true
            }
            done(admitted && passed ? .success(ServerReply()) : .failure(ServerFailure(code: "changed", message: "The isolated event probe is unavailable.")))
        }
        input.reconcileOnStart(); tap.start(); watchdog.start()
        let timer = DispatchSource.makeTimerSource(queue: monitoring)
        timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
        timer.setEventHandler { [weak self] in
            guard let self, self.dispatcher.sessionSnapshot() != nil else { return }
            _ = try? self.send("heartbeat", [:], tracked: false)
        }
        timer.resume(); heartbeats = timer
    }
    private func observe(_ sample: EventTapSample) {
        lock.lock(); defer { lock.unlock() }
        currentForeignSample = sample.kind == .keyDown && sample.keyCode == 53 &&
            sample.sourcePID == targetPID && sample.tag == PrivilegedTargetPolicy.foreignTag
        guard sample.kind == .keyDown, sample.keyCode == 53 else { return }
        if sample.sourcePID == getpid(), sample.tag == InputNative.eventTag { ownEscapes += 1 }
        if sample.sourcePID == targetPID, sample.tag == PrivilegedTargetPolicy.foreignTag { foreignEscapes += 1 }
    }
    private func receive(_ response: Response, image: Data?) {
        let object = response.value
        guard let id = object["id"]?.intValue else { return }
        lock.lock(); defer { lock.unlock() }
        guard pending.contains(id) else { return }
        if object["ok"]?.boolValue == true, let fields = object.objectValue {
            replies[id] = .success(PrivilegedReply(fields: fields, image: image))
        } else { replies[id] = .failure(ServerFailure(code: object["code"]?.stringValue ?? "failed", message: "A native self-test operation failed.")) }
    }
    private func receiveEvent(_ event: Event) {
        lock.lock(); defer { lock.unlock() }
        if events.count < 256 { events.append(event) }
    }
    func send(_ op: String, _ args: [String: JSONValue], tracked: Bool = true) throws -> Int {
        lock.lock()
        guard !cancelled else { lock.unlock(); throw PrivilegedTestFailure.interrupted }
        sequence += 1; let id = sequence
        if tracked { pending.insert(id) }
        lock.unlock()
        dispatcher.receive(try Request(id: id, op: op, args: args))
        return id
    }
    func request(_ op: String, _ args: [String: JSONValue] = [:], milliseconds: UInt64 = 12000) throws -> PrivilegedReply {
        try response(send(op, args), milliseconds: milliseconds).get()
    }
    func response(_ id: Int, milliseconds: UInt64 = 12000) throws -> Result<PrivilegedReply, ServerFailure> {
        let deadline = DispatchTime.now().uptimeNanoseconds + milliseconds * 1_000_000
        while DispatchTime.now().uptimeNanoseconds < deadline {
            lock.lock(); let value = replies.removeValue(forKey: id); let ended = cancelled || physical
            if value != nil { pending.remove(id) }; lock.unlock()
            if let value { return value }; if ended { throw PrivilegedTestFailure.interrupted }
            _ = CFRunLoopRunInMode(.defaultMode, 0.01, true)
        }
        _ = try? send("cancel", ["target": .integer(Int64(id))], tracked: false)
        throw PrivilegedTestFailure.timeout
    }
    func begin(owner: NativeOwner, mode: String = "foreground", overlays: [String] = []) throws {
        _ = try request("session.begin", ["sessionId": .string("isolated-" + UUID().uuidString.lowercased()),
            "phaseRevision": .integer(1), "mode": .string(mode), "approved": .array([owner.identity.wire]),
            "vectorPids": .array([.integer(Int64(getpid()))]), "vectorWindowIds": .array([]),
            "overlayWindowIds": .array(overlays.map(JSONValue.string)), "escStops": .bool(mode == "foreground"),
            "stopChord": .string("Command+Shift+Escape"), "heartbeatMs": .integer(2000)])
    }
    func phase() throws -> [String: JSONValue] {
        guard let session = dispatcher.sessionSnapshot() else { throw PrivilegedTestFailure.operation }
        return ["sessionId": .string(session.id), "phaseRevision": .integer(Int64(session.revision ?? 0))]
    }
    func ready(milliseconds: UInt64 = 1800) -> Bool {
        let deadline = DispatchTime.now().uptimeNanoseconds + milliseconds * 1_000_000
        while DispatchTime.now().uptimeNanoseconds < deadline {
            if let session = dispatcher.sessionSnapshot(), watchdog.foregroundReady(session) { return true }
            _ = CFRunLoopRunInMode(.defaultMode, 0.01, true)
        }
        return false
    }
    func escapeEvidence() -> (own: Int, foreign: Int, stops: Int, foreignStops: Int) {
        lock.lock(); defer { lock.unlock() }
        return (ownEscapes, foreignEscapes, events.filter { $0.value["event"]?.stringValue == "stop" }.count, foreignStops)
    }
    func expectForeign(_ expected: Bool) { lock.lock(); expectedForeign = expected; lock.unlock() }
    var interrupted: Bool { lock.lock(); defer { lock.unlock() }; return physical || cancelled }
    func cancel() {
        lock.lock(); cancelled = true; lock.unlock()
        dispatcher.close(reason: "self-test-cancel")
        _ = input.releaseAll()
    }
    func close() -> Bool {
        heartbeats?.cancel(); heartbeats = nil
        cancel(); tap.close(); watchdog.close(); input.close(); capture.close(); accessibility.close()
        return accessibility.wakeCleanupComplete()
    }
}

/// Opt-in scenarios are restricted to one separately verified, finite fixture. All successful facts
/// come from production native services or from that fixture's actual views/event journal.
final class PrivilegedHelperSelfTest {
    private let lock = NSLock()
    private var cancelled = false
    private var deadlineExceeded = false
    private var target: PrivilegedTargetChannel?
    private var runtime: PrivilegedRuntime?
    private let started = DispatchTime.now().uptimeNanoseconds
    private var results: [String: PrivilegedCheckResult] = [:]

    func cancel() {
        lock.lock(); cancelled = true; let runtime = runtime; let target = target; lock.unlock()
        runtime?.cancel(); _ = target?.close()
    }
    private func current() throws {
        lock.lock(); let stopped = cancelled; let expired = deadlineExceeded; lock.unlock()
        if expired { throw PrivilegedTestFailure.timeout }
        if stopped || runtime?.interrupted == true { throw PrivilegedTestFailure.interrupted }
        if DispatchTime.now().uptimeNanoseconds - started > 110_000_000_000 { throw PrivilegedTestFailure.timeout }
    }
    private func skip(_ index: Int, _ reason: String) {
        let name = PrivilegedCheckCatalog.names[index]
        results[name] = PrivilegedCheckResult(name: name, ok: false, skipped: true, detail: reason)
    }
    private func check(_ index: Int, missing: String? = nil, _ body: () throws -> Bool) {
        if let missing { skip(index, missing); return }
        let name = PrivilegedCheckCatalog.names[index]
        do {
            try current()
            let passed = try body()
            if results[name] == nil { results[name] = PrivilegedCheckResult(name: name, ok: passed, detail: passed ? nil : "assertion_failed") }
        } catch PrivilegedTestFailure.interrupted {
            lock.lock(); let expired = deadlineExceeded; lock.unlock()
            if expired { results[name] = PrivilegedCheckResult(name: name, ok: false, detail: "deadline_exceeded") }
            else { skip(index, "physical_takeover") }
        }
        catch PrivilegedTestFailure.timeout { results[name] = PrivilegedCheckResult(name: name, ok: false, detail: "deadline_exceeded") }
        catch PrivilegedTestFailure.target(let stage) { results[name] = PrivilegedCheckResult(name: name, ok: false, detail: stage.rawValue) }
        catch { results[name] = PrivilegedCheckResult(name: name, ok: false, detail: "native_operation_failed") }
    }
    private func report(defaultReason: String = "target_unavailable") -> PrivilegedCheckReport {
        PrivilegedCheckReport(checks: PrivilegedCheckCatalog.names.map {
            results[$0] ?? PrivilegedCheckResult(name: $0, ok: false, skipped: true, detail: defaultReason)
        })
    }
    private func responsibilityFailure() -> PrivilegedCheckReport {
        let name = PrivilegedCheckCatalog.names[0]
        results[name] = PrivilegedCheckResult(name: name, ok: false, detail: "responsibility_missing")
        return report(defaultReason: "responsibility_missing")
    }
    func run(path: String?, parent: HelperParent?) -> PrivilegedCheckReport {
        guard let parent, HelperLifecycle.isSelfResponsible() else { return responsibilityFailure() }
        let watchers: HelperWorkerWatchers
        do { watchers = try HelperLifecycle.installWorkerWatchers(parent: parent, onExit: { [weak self] in self?.cancel() }) }
        catch { return responsibilityFailure() }
        defer { watchers.finish() }
        guard WatchdogBackend.system.sample().availability == .available else { return .skipped("noninteractive_desktop") }
        let timeout = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "ai.vector.self-test.deadline"))
        timeout.schedule(deadline: .now() + .seconds(120))
        timeout.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.deadlineExceeded = true; self.lock.unlock(); self.cancel()
        }
        timeout.resume(); defer { timeout.cancel() }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        guard let path, let digest = Bundle.main.object(forInfoDictionaryKey: "VectorComputerSourceDigest") as? String else {
            results[PrivilegedCheckCatalog.names[0]] = PrivilegedCheckResult(name: PrivilegedCheckCatalog.names[0], ok: false, detail: "target_validation_failed")
            results[PrivilegedCheckCatalog.names[13]] = PrivilegedCheckResult(name: PrivilegedCheckCatalog.names[13], ok: true)
            return report()
        }
        let channel: PrivilegedTargetChannel
        do { channel = try PrivilegedTargetChannel(path: path, sourceDigest: digest) }
        catch {
            results[PrivilegedCheckCatalog.names[0]] = PrivilegedCheckResult(name: PrivilegedCheckCatalog.names[0], ok: false, detail: "target_validation_failed")
            results[PrivilegedCheckCatalog.names[13]] = PrivilegedCheckResult(name: PrivilegedCheckCatalog.names[13], ok: true)
            return report()
        }
        lock.lock(); target = channel; lock.unlock()
        let native = PrivilegedRuntime()
        lock.lock(); runtime = native; lock.unlock()
        var owner: NativeOwner?
        check(0) {
            _ = try channel.launch()
            let observed: NativeOwner
            do { observed = try NativeIdentityReader.observe(pid: channel.targetPID) }
            catch { throw PrivilegedTestFailure.target(.identity) }
            guard observed.process.executable.utf8.elementsEqual(channel.evidence.executablePath.utf8),
                  observed.identity.bundleId == PrivilegedTargetPolicy.identifier else { throw PrivilegedTestFailure.target(.identity) }
            owner = observed
            try self.current()
            native.start(target: channel.targetPID, executable: channel.evidence.executablePath)
            return try self.wait({ native.watchdog.availability() == .available })
        }
        guard let owner else {
            let nativeClean = native.close(), targetClean = channel.close(), clean = nativeClean && targetClean
            results[PrivilegedCheckCatalog.names[13]] = PrivilegedCheckResult(name: PrivilegedCheckCatalog.names[13], ok: clean, detail: clean ? nil : "cleanup_failed")
            return report()
        }
        let ax = AXIsProcessTrusted(), screen = CGPreflightScreenCaptureAccess(), post = CGPreflightPostEventAccess()
        let axMissing = ax ? nil : "accessibility_denied"
        let screenMissing = screen ? nil : "screen_denied"
        let inputMissing = !ax ? "accessibility_denied" : !post ? "post_event_denied" : nil
        check(1, missing: screenMissing) {
            _ = try channel.command("foreground", ["active": .bool(true)])
            try native.begin(owner: owner)
            let state = try channel.command("state"), image = try self.capture(native, state: state)
            return try self.color(image, at: self.center(state, "patch"), equals: [32, 128, 192])
        }
        check(2, missing: screenMissing) {
            let state = try channel.command("foreground", ["active": .bool(true)])
            try native.begin(owner: owner)
            let image = try self.capture(native, state: state)
            guard let display = image.fields["displayId"]?.stringValue,
                  let main = state["windowNumber"]?.intValue else { return false }
            try native.begin(owner: owner, overlays: [String(main)])
            let excluded = try self.capture(native, display: display)
            return try self.color(excluded, at: self.center(state, "patch"), equals: [224, 96, 32])
        }
        check(3, missing: axMissing) {
            _ = try channel.command("reset"); _ = try channel.command("foreground", ["active": .bool(true)])
            try native.begin(owner: owner, mode: "background")
            let button = try self.element(native, state: channel.command("state"), kind: "button")
            let before = try channel.command("state")["counter"]?.intValue
            _ = try native.request("ui.perform", self.action(native, button, owner, ["action": .string("AXPress")]))
            return try self.wait { try channel.command("state")["counter"]?.intValue == (before ?? -2) + 1 }
        }
        check(4, missing: axMissing) {
            _ = try channel.command("reset"); try native.begin(owner: owner, mode: "background")
            let field = try self.element(native, state: channel.command("state"), kind: "text"), text = "Vector-" + channel.nonce
            let response = try native.request("ui.setValue", self.action(native, field, owner, ["value": .string(text)]))
            let state = try channel.command("state")
            return response.fields["took"]?.boolValue == true && self.summary(state["text"], equals: text)
        }
        check(5, missing: axMissing) {
            _ = try channel.command("reset"); _ = try channel.command("focus", ["field": .string("secure")])
            try native.begin(owner: owner, mode: "background")
            let field = try self.element(native, state: channel.command("state"), kind: "secure")
            guard field["secure"]?.boolValue == true, field["value"]?.stringValue == "REDACTED" else { return false }
            let before = try channel.command("state")["secure"]
            let result = try native.response(native.send("ui.setValue", self.action(native, field, owner, ["value": .string("refused")])) )
            guard case .failure(let failure) = result, failure.code == "secure_field" else { return false }
            let typing = try native.response(native.send("input.type", self.action(native, field, owner, ["text": .string("refused")])))
            guard case .failure(let typeFailure) = typing, typeFailure.code == "secure_field" else { return false }
            return try channel.command("state")["secure"] == before
        }
        let pointerMissing = inputMissing ?? screenMissing
        check(6, missing: pointerMissing) {
            _ = try channel.command("reset"); _ = try channel.command("focus", ["field": .string("button")])
            try native.begin(owner: owner)
            guard native.ready() else { self.skip(6, "input_detection_unavailable"); return true }
            let state = try channel.command("state"), image = try self.capture(native, state: state)
            _ = try native.request("input.click", self.click(native, image, state: state, owner: owner))
            return try self.wait {
                let state = try channel.command("state")
                return state["counter"]?.intValue == 1 && (state["events"]?["buttonDowns"]?.intValue ?? 0) > 0 && state["events"]?["heldButtons"]?.intValue == 0
            }
        }
        check(7, missing: pointerMissing) {
            _ = try channel.command("reset"); _ = try channel.command("foreground", ["active": .bool(true)])
            try native.begin(owner: owner)
            guard native.ready() else { self.skip(7, "input_detection_unavailable"); return true }
            let state = try channel.command("state"), image = try self.capture(native, state: state)
            _ = try channel.command("move", ["dx": .integer(40), "dy": .integer(0)])
            defer { _ = try? channel.command("move", ["dx": .integer(-40), "dy": .integer(0)]) }
            let result = try native.response(native.send("input.click", self.click(native, image, state: state, owner: owner)))
            guard case .failure(let failure) = result, failure.code == "stale_frame" else { return false }
            return try channel.command("state")["counter"]?.intValue == 0
        }
        check(8, missing: axMissing) {
            _ = try channel.command("reset"); _ = try channel.command("focus", ["field": .string("button")])
            let state = try channel.command("foreground", ["active": .bool(false)])
            guard try self.wait({ NSWorkspace.shared.frontmostApplication?.processIdentifier != channel.targetPID }),
                  let pointer = CGEvent(source: nil)?.location else { return false }
            let focus = NSWorkspace.shared.frontmostApplication?.processIdentifier
            try native.begin(owner: owner, mode: "background")
            let button = try self.element(native, state: state, kind: "button")
            _ = try native.request("ui.perform", self.action(native, button, owner, ["action": .string("AXPress")]))
            return try self.wait({ try channel.command("state")["counter"]?.intValue == 1 }) &&
                CGEvent(source: nil)?.location == pointer && NSWorkspace.shared.frontmostApplication?.processIdentifier == focus
        }
        check(9, missing: axMissing) {
            for (preset, expected, caret) in [("append", "prefixΩ", 7), ("replace", "alpha Ω", 7), ("unicode", "AΩB", 2)] {
                _ = try channel.command("foreground", ["active": .bool(true)])
                _ = try channel.command("prepareText", ["preset": .string(preset)])
                let state = try channel.command("foreground", ["active": .bool(false)])
                guard try self.wait({ NSWorkspace.shared.frontmostApplication?.processIdentifier != channel.targetPID }),
                      let pointer = CGEvent(source: nil)?.location else { return false }
                let focus = NSWorkspace.shared.frontmostApplication?.processIdentifier
                try native.begin(owner: owner, mode: "background")
                let field = try self.element(native, state: state, kind: "text")
                _ = try native.request("input.type", self.action(native, field, owner, ["text": .string("Ω")]))
                let after = try channel.command("state")
                guard self.summary(after["text"], equals: expected), after["text"]?["selection"]?["location"]?.intValue == caret,
                      after["text"]?["selection"]?["length"]?.intValue == 0,
                      CGEvent(source: nil)?.location == pointer, NSWorkspace.shared.frontmostApplication?.processIdentifier == focus else { return false }
            }
            return true
        }
        check(10, missing: inputMissing) {
            _ = try channel.command("foreground", ["active": .bool(true)])
            _ = try channel.command("focus", ["field": .string("button")]); try native.begin(owner: owner)
            guard native.ready() else { self.skip(10, "input_detection_unavailable"); return true }
            let evidence = native.escapeEvidence(), before = try channel.command("state")["events"]?["escapes"]?.intValue ?? 0
            _ = try native.request("self-test.ownEscape", native.phase())
            guard try self.wait({ native.escapeEvidence().own > evidence.own }) else { return false }
            let state = try channel.command("state")
            return native.escapeEvidence().stops == evidence.stops && (state["events"]?["escapes"]?.intValue ?? 0) > before &&
                state["events"]?["heldKeys"]?.intValue == 0
        }
        check(11, missing: inputMissing) {
            _ = try channel.command("foreground", ["active": .bool(true)])
            _ = try channel.command("focus", ["field": .string("button")]); try native.begin(owner: owner)
            guard native.ready() else { self.skip(11, "input_detection_unavailable"); return true }
            let before = native.escapeEvidence()
            native.expectForeign(true); defer { native.expectForeign(false) }
            let state = try channel.command("foreignEsc")
            if state["foreignEsc"]?["status"]?.stringValue == "not_granted" { self.skip(11, "target_post_event_denied"); return true }
            guard state["foreignEsc"]?["status"]?.stringValue == "posted",
                  try self.wait({ let observed = native.escapeEvidence(); return observed.foreign > before.foreign && observed.stops > before.stops && observed.foreignStops > before.foreignStops }) else { return false }
            var args = try native.phase(); args["pid"] = .integer(Int64(channel.targetPID)); args["combo"] = .array([.string("ArrowRight")]); args["repeat"] = .integer(1)
            let result = try native.response(native.send("input.key", args))
            guard case .failure(let failure) = result else { return false }
            let after = try channel.command("state")
            return failure.code == "stopped" && after["events"]?["heldKeys"]?.intValue == 0
        }
        check(12, missing: inputMissing) {
            _ = try channel.command("foreground", ["active": .bool(true)])
            _ = try channel.command("focus", ["field": .string("button")]); try native.begin(owner: owner)
            guard native.ready() else { self.skip(12, "input_detection_unavailable"); return true }
            var args = try native.phase(); args["pid"] = .integer(Int64(channel.targetPID)); args["combo"] = .array([.string("ArrowRight")]); args["ms"] = .integer(1500)
            let before = try channel.command("state")["events"]?["keyUps"]?.intValue ?? 0
            let held = try native.send("input.hold", args)
            guard try self.wait({ (try channel.command("state"))["events"]?["heldKeys"]?.intValue == 1 }, milliseconds: 900) else { return false }
            let released = try native.request("input.releaseAll")
            _ = try native.response(held)
            let lifted = try self.wait {
                let state = try channel.command("state")
                return state["events"]?["heldKeys"]?.intValue == 0 && (state["events"]?["keyUps"]?.intValue ?? 0) > before
            }
            return (released.fields["released"]?.intValue ?? 0) >= 1 && lifted
        }
        let nativeClean = native.close(), targetClean = channel.close()
        let clean = nativeClean && targetClean
        results[PrivilegedCheckCatalog.names[13]] = PrivilegedCheckResult(name: PrivilegedCheckCatalog.names[13], ok: clean, detail: clean ? nil : "cleanup_failed")
        lock.lock(); runtime = nil; target = nil; lock.unlock()
        return report()
    }

    private func wait(_ condition: () throws -> Bool, milliseconds: UInt64 = 1200) throws -> Bool {
        let limit = DispatchTime.now().uptimeNanoseconds + milliseconds * 1_000_000
        while DispatchTime.now().uptimeNanoseconds < limit {
            try current(); if try condition() { return true }
            _ = CFRunLoopRunInMode(.defaultMode, 0.01, true)
        }
        return false
    }
    private func center(_ state: JSONValue, _ name: String) throws -> CGPoint {
        guard let bounds = PrivilegedTargetPolicy.rect(state["views"]?[name]?["bounds"]) else { throw PrivilegedTestFailure.assertion }
        return CGPoint(x: bounds.midX, y: bounds.midY)
    }
    private func capture(_ native: PrivilegedRuntime, state: JSONValue) throws -> PrivilegedReply {
        guard let window = state["windowNumber"]?.intValue else { throw PrivilegedTestFailure.assertion }
        return try capture(native, target: ["windowId": .string(String(window))])
    }
    private func capture(_ native: PrivilegedRuntime, display: String) throws -> PrivilegedReply { try capture(native, target: ["display": .string(display)]) }
    private func capture(_ native: PrivilegedRuntime, target: [String: JSONValue]) throws -> PrivilegedReply {
        try native.request("capture", ["target": .object(target), "format": .string("png"),
            "budget": .object(["maxWidth": .integer(1200), "maxHeight": .integer(900), "maxPixels": .integer(1_080_000)])])
    }
    private func pixel(_ image: PrivilegedReply, point: CGPoint) throws -> (Int, Int) {
        guard let origin = image.fields["origin"], let x = origin["x"]?.doubleValue, let y = origin["y"]?.doubleValue,
              let scale = image.fields["imageScale"]?.doubleValue, scale > 0,
              let width = image.fields["width"]?.intValue, let height = image.fields["height"]?.intValue else { throw PrivilegedTestFailure.assertion }
        let px = Int(floor((point.x - x) * scale)), py = Int(floor((point.y - y) * scale))
        guard px >= 0, py >= 0, px < width, py < height else { throw PrivilegedTestFailure.assertion }
        return (px, py)
    }
    private func color(_ image: PrivilegedReply, at point: CGPoint, equals expected: [Int]) throws -> Bool {
        let (x, y) = try pixel(image, point: point)
        guard let bytes = image.image, let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil),
              let one = decoded.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)),
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { throw PrivilegedTestFailure.operation }
        var rgba = [UInt8](repeating: 0, count: 4)
        let drawn = rgba.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                bytesPerRow: 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(one, in: CGRect(x: 0, y: 0, width: 1, height: 1)); return true
        }
        return drawn && rgba[3] == 255 && zip(rgba.prefix(3), expected).allSatisfy { abs(Int($0.0) - $0.1) <= 12 }
    }
    private func element(_ native: PrivilegedRuntime, state: JSONValue, kind: String) throws -> [String: JSONValue] {
        guard let window = state["windowNumber"]?.intValue else { throw PrivilegedTestFailure.assertion }
        let tree = try native.request("ui.tree", ["windowId": .string(String(window)), "maxNodes": .integer(200), "maxDepth": .integer(15)])
        guard let nodes = tree.fields["nodes"]?.arrayValue else { throw PrivilegedTestFailure.assertion }
        let matches = nodes.filter { node in
            if kind == "button" { return node["role"]?.stringValue == "AXButton" && node["name"]?.stringValue == "Increment" }
            return node["role"]?.stringValue == "AXTextField" && node["secure"]?.boolValue == (kind == "secure")
        }
        guard matches.count == 1, let ref = matches.first?["ref"]?.stringValue else { throw PrivilegedTestFailure.assertion }
        var fields = try native.request("ui.resolve", ["ref": .string(ref)]).fields
        if let value = matches.first?["value"] { fields["value"] = value }
        return fields
    }
    private func action(_ native: PrivilegedRuntime, _ element: [String: JSONValue], _ owner: NativeOwner,
                        _ extra: [String: JSONValue]) throws -> [String: JSONValue] {
        guard let ref = element["ref"]?.stringValue, let id = element["elementId"]?.stringValue,
              let window = element["windowId"]?.stringValue else { throw PrivilegedTestFailure.assertion }
        var fields = try native.phase(); fields["ref"] = .string(ref); fields["elementId"] = .string(id)
        fields["pid"] = .integer(Int64(owner.process.pid))
        if extra["text"] != nil { fields["windowId"] = .string(window) }
        for (key, value) in extra { fields[key] = value }; return fields
    }
    private func click(_ native: PrivilegedRuntime, _ image: PrivilegedReply, state: JSONValue, owner: NativeOwner) throws -> [String: JSONValue] {
        let (x, y) = try pixel(image, point: center(state, "button"))
        guard let capture = image.fields["captureId"]?.stringValue, let window = state["windowNumber"]?.intValue else { throw PrivilegedTestFailure.assertion }
        var fields = try native.phase(); fields["captureId"] = .string(capture); fields["x"] = .integer(Int64(x)); fields["y"] = .integer(Int64(y))
        fields["pid"] = .integer(Int64(owner.process.pid)); fields["windowId"] = .string(String(window)); fields["button"] = .string("left")
        fields["count"] = .integer(1); fields["modifiers"] = .array([]); return fields
    }
    private func summary(_ value: JSONValue?, equals text: String) -> Bool {
        let hash = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        return value?["length"]?.intValue == text.utf16.count && value?["sha256"]?.stringValue == hash
    }
}
