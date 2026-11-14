import Darwin
import Dispatch
import Foundation
import Security

enum HelperLifecycleError: Error, CustomStringConvertible {
    case parent
    case descriptor
    case elevated
    case responsibility
    case spawn(Int32)

    var description: String {
        switch self {
        case .parent: return "The helper caller could not be verified."
        case .descriptor: return "The helper protocol descriptor is unavailable."
        case .elevated: return "The helper cannot run with an elevated process token."
        case .responsibility: return "Independent helper responsibility is unavailable."
        case .spawn: return "The independent helper process could not start."
        }
    }
}

/// A PID alone is never a continuing claim about a process: the kernel start time is part of its identity.
struct HelperProcessIdentity: Equatable {
    let pid: pid_t
    let parentPID: pid_t
    let startSeconds: UInt64
    let startMicroseconds: UInt64
    let executable: String
}

struct HelperParent {
    let original: HelperProcessIdentity
    let supervisor: HelperProcessIdentity?
}

enum HelperWorkerLaunchMode: Equatable {
    case serving
    case probe
    case privileged(target: String, report: String?)

    var usesProtocol: Bool { if case .serving = self { return true }; return false }
}

enum HelperLifecycle {
    static func protocolDescriptorIsValid(_ descriptor: Int32 = 3) -> Bool {
        var status = stat()
        guard fstat(descriptor, &status) == 0 else { return false }
        let kind = status.st_mode & mode_t(S_IFMT)
        return kind == mode_t(S_IFIFO) || kind == mode_t(S_IFSOCK)
    }

    static func isSelfResponsible() -> Bool {
        ResponsibilityAPI.shared.isSelfResponsible()
    }

    static func disclaimSpawn(_ attributes: UnsafeMutablePointer<posix_spawnattr_t?>) -> Bool {
        ResponsibilityAPI.shared.disclaim(attributes)
    }

    static func responsiblePID(for process: HelperProcessIdentity) -> pid_t? {
        guard processIdentity(process.pid) == process,
              let responsible = ResponsibilityAPI.shared.responsiblePID(process.pid),
              processIdentity(process.pid) == process else { return nil }
        return responsible
    }

    static func responsibilityMatches(observed: pid_t?, current: pid_t) -> Bool {
        guard let observed, observed > 0, current > 0 else { return false }
        return observed == current
    }

    /// Public modes run only as children of the containing Vector application's actual main executable.
    /// D14's one-shot probe has neither a parent argument nor fd 3, so main supplies its actual getppid().
    static func runSupervisor(parentPID: pid_t, probe: Bool) throws -> Int32 {
        try runSupervisor(parentPID: parentPID, mode: probe ? .probe : .serving)
    }

    /// Privileged self-tests use the same independently attributed worker and verified application parent.
    /// Their only channel is the bounded one-shot report on stdout; fd 3 is neither needed nor inherited.
    static func runPrivilegedSupervisor(parentPID: pid_t, target: String, report: String?) throws -> Int32 {
        try runSupervisor(parentPID: parentPID, mode: .privileged(target: target, report: report))
    }

    private static func runSupervisor(parentPID: pid_t, mode supplied: HelperWorkerLaunchMode) throws -> Int32 {
        try requireOrdinaryToken()
        if supplied.usesProtocol && !protocolDescriptorIsValid() { throw HelperLifecycleError.descriptor }
        let parent = try verifyOriginalParent(parentPID, immediateParent: getpid())
        guard getppid() == parentPID else { throw HelperLifecycleError.parent }
        let mode: HelperWorkerLaunchMode
        if case .privileged(let target, let report) = supplied {
            guard HelperCommand.absolutePath(target), canonicalPath(target) == target,
                  URL(fileURLWithPath: target).lastPathComponent == "VectorComputerTestTarget.app" else {
                throw HelperCommand.UsageError.invalidArguments
            }
            mode = .privileged(target: target, report: try report.map(canonicalReportPath))
        } else { mode = supplied }
        let executable = try currentExecutable()
        let child = try spawnWorker(executable: executable, parentPID: parentPID, mode: mode)
        // Only stage 2 owns the protocol endpoint. Keeping a copy here would postpone the desktop's channel EOF.
        if mode.usesProtocol { Darwin.close(3) }
        return HelperSupervisorWatchdog(childPID: child, parent: parent).wait()
    }

    /// Pure argv construction is shared by the actual spawn and grant-free command/lifecycle tests.
    static func workerArguments(parentPID: pid_t, mode: HelperWorkerLaunchMode) -> [String] {
        var values = ["--computer-worker", "--parent-pid", String(parentPID)]
        switch mode {
        case .serving: values.append("--stdio")
        case .probe: values.append(contentsOf: ["--probe", "--json"])
        case .privileged(let target, let report):
            values.append(contentsOf: ["--self-test=privileged", "--target", target])
            if let report { values.append(contentsOf: ["--report", report]) }
        }
        return values
    }

    /// An internal command-line flag grants no authority. A worker must have this very helper as its real
    /// parent, and that supervisor must still be a direct child of the verified containing Vector app.
    static func verifyWorker(parentPID: pid_t) throws -> HelperParent {
        try requireOrdinaryToken()
        guard let supervisor = processIdentity(getppid()), supervisor.executable == (try currentExecutable()),
              supervisor.parentPID == parentPID else { throw HelperLifecycleError.parent }
        let parent = try verifyOriginalParent(parentPID, immediateParent: supervisor.pid)
        guard processIdentity(supervisor.pid) == supervisor,
              processIdentity(parent.pid) == parent else { throw HelperLifecycleError.parent }
        return HelperParent(original: parent, supervisor: supervisor)
    }

    static func installWorkerWatchers(parent: HelperParent, onExit: @escaping () -> Void) throws -> HelperWorkerWatchers {
        guard processIdentity(parent.original.pid) == parent.original,
              parent.supervisor.map({ processIdentity($0.pid) == $0 }) ?? true else {
            throw HelperLifecycleError.parent
        }
        return HelperWorkerWatchers(parent: parent, onExit: onExit)
    }

    static func processIdentity(_ pid: pid_t) -> HelperProcessIdentity? {
        guard pid > 0 else { return nil }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        // proc_info.h defines PROC_PIDPATHINFO_MAXSIZE as (4 * MAXPATHLEN), which Swift cannot import.
        let pathCapacity = 4 * Int(MAXPATHLEN)
        var path = [CChar](repeating: 0, count: pathCapacity)
        guard proc_pidpath(pid, &path, UInt32(pathCapacity)) > 0,
              let executable = canonicalPath(String(cString: path)) else { return nil }
        // Defend the path lookup against death/reuse while the two kernel observations were in flight.
        var again = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &again, size) == size,
              info.pbi_start_tvsec == again.pbi_start_tvsec,
              info.pbi_start_tvusec == again.pbi_start_tvusec,
              info.pbi_ppid == again.pbi_ppid else { return nil }
        return HelperProcessIdentity(pid: pid, parentPID: pid_t(info.pbi_ppid),
                                     startSeconds: info.pbi_start_tvsec, startMicroseconds: info.pbi_start_tvusec,
                                     executable: executable)
    }

    /// Inputs here are already canonical existing paths. This pure predicate also covers caller topology tests.
    static func matchesContainingApplication(helperExecutable: String, parentExecutable: String,
                                             appID: String, helperID: String, mainExecutable: String) -> Bool {
        guard !mainExecutable.isEmpty, mainExecutable != ".", mainExecutable != "..",
              !mainExecutable.contains("/"), !mainExecutable.contains("\0"),
              let channel = Identity.channels.first(where: { $0.appId == appID }),
              channel.helperBundleId == helperID else { return false }
        let executable = URL(fileURLWithPath: helperExecutable)
        let helper = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let app = helper.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard app.pathExtension == "app", helper.lastPathComponent == Identity.bundle else { return false }
        return app.appendingPathComponent("Contents/Helpers/\(Identity.bundle)/Contents/MacOS/\(Identity.executable)").path == helperExecutable &&
            app.appendingPathComponent("Contents/MacOS/\(mainExecutable)").path == parentExecutable
    }

    static func exitCode(waitStatus: Int32) -> Int32 {
        // Darwin wait(2)'s WIFEXITED/WEXITSTATUS macros are not imported into Swift.
        let signal = waitStatus & 0x7f
        return signal == 0 ? (waitStatus >> 8) & 0xff : 128 + signal
    }

    private static func requireOrdinaryToken() throws {
        guard getuid() != 0, geteuid() != 0, getuid() == geteuid(), getgid() == getegid() else {
            throw HelperLifecycleError.elevated
        }
    }

    private static func currentExecutable() throws -> String {
        guard let identity = processIdentity(getpid()) else { throw HelperLifecycleError.parent }
        return identity.executable
    }

    private static func canonicalPath(_ path: String) -> String? {
        guard path.hasPrefix("/"), !path.contains("\0"), let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    private static func canonicalReportPath(_ path: String) throws -> String {
        guard HelperCommand.absolutePath(path) else { throw HelperCommand.UsageError.invalidArguments }
        let url = URL(fileURLWithPath: path)
        guard let directory = canonicalPath(url.deletingLastPathComponent().path) else {
            throw HelperCommand.UsageError.invalidArguments
        }
        let resolved = URL(fileURLWithPath: directory).appendingPathComponent(url.lastPathComponent).path
        var status = stat()
        let result = lstat(resolved, &status)
        guard (result == 0 && status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && status.st_uid == getuid()) ||
              (result == -1 && errno == ENOENT) else { throw HelperCommand.UsageError.invalidArguments }
        return resolved
    }

    private static func verifyOriginalParent(_ pid: pid_t, immediateParent: pid_t) throws -> HelperProcessIdentity {
        guard let parent = processIdentity(pid), let direct = processIdentity(immediateParent),
              direct.parentPID == pid else { throw HelperLifecycleError.parent }
        let executable = try currentExecutable()
        let helper = URL(fileURLWithPath: executable).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let app = helper.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let appInfo = try readPlist(app.appendingPathComponent("Contents/Info.plist").path)
        let helperInfo = try readPlist(helper.appendingPathComponent("Contents/Info.plist").path)
        guard let appID = appInfo["CFBundleIdentifier"] as? String,
              let helperID = helperInfo["CFBundleIdentifier"] as? String,
              let mainExecutable = appInfo["CFBundleExecutable"] as? String,
              matchesContainingApplication(helperExecutable: executable, parentExecutable: parent.executable,
                                            appID: appID, helperID: helperID, mainExecutable: mainExecutable) else {
            throw HelperLifecycleError.parent
        }
        try validateSignatures(parentPID: pid, appURL: app, appID: appID, helperID: helperID)
        guard processIdentity(pid) == parent, processIdentity(immediateParent) == direct else {
            throw HelperLifecycleError.parent
        }
        return parent
    }

    private static func readPlist(_ path: String) throws -> [String: Any] {
        let descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW)
        guard descriptor >= 0 else { throw HelperLifecycleError.parent }
        defer { Darwin.close(descriptor) }
        var status = stat()
        let limit = 1_048_576
        guard fstat(descriptor, &status) == 0, status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              status.st_size > 0, status.st_size <= off_t(limit) else { throw HelperLifecycleError.parent }
        var bytes = [UInt8](repeating: 0, count: limit + 1)
        var count = 0
        while count < bytes.count {
            let received = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(descriptor, buffer.baseAddress!.advanced(by: count), buffer.count - count)
            }
            if received == -1 && errno == EINTR { continue }
            guard received >= 0 else { throw HelperLifecycleError.parent }
            if received == 0 { break }
            count += received
        }
        guard count <= limit,
              let property = try? PropertyListSerialization.propertyList(from: Data(bytes.prefix(count)), options: [], format: nil),
              let value = property as? [String: Any] else {
            throw HelperLifecycleError.parent
        }
        return value
    }

    private static func validateSignatures(parentPID: pid_t, appURL: URL, appID: String, helperID: String) throws {
        // Swift's imported .noNetworkAccess/.adhoc names and static-code signing-info parameter are recorded in
        // https://github.com/DougGregor/swift-concurrency-objc/blob/5ab47b4f70a675a4298dc00b1526505b964b4061/macOS/Security/CSCommon.swift
        // and SecCode.swift in that same interface snapshot; do not substitute guessed raw signature bits.
        var ownCode: SecCode?
        guard SecCodeCopySelf([], &ownCode) == errSecSuccess, let ownCode else { throw HelperLifecycleError.parent }
        var ownStatic: SecStaticCode?
        guard SecCodeCopyStaticCode(ownCode, [], &ownStatic) == errSecSuccess, let ownStatic else {
            throw HelperLifecycleError.parent
        }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(ownStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let information else { throw HelperLifecycleError.parent }
        let fields = information as NSDictionary
        guard let flags = fields[kSecCodeInfoFlags] as? NSNumber,
              fields[kSecCodeInfoIdentifier] as? String == helperID,
              SecCodeCheckValidity(ownCode, [.noNetworkAccess], nil) == errSecSuccess else {
            throw HelperLifecycleError.parent
        }
        if SecCodeSignatureFlags(rawValue: flags.uint32Value).contains(.adhoc) { return }
        guard let team = fields[kSecCodeInfoTeamIdentifier] as? String,
              team.count == 10, team.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }) else {
            throw HelperLifecycleError.parent
        }
        // A Team ID alone also admits development certificates. Shipping signed builds require Developer ID.
        let signing = "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(team)\""
        var ownRequirement: SecRequirement?
        guard SecRequirementCreateWithString(signing as CFString, [], &ownRequirement) == errSecSuccess,
              let ownRequirement,
              SecCodeCheckValidity(ownCode, [.noNetworkAccess], ownRequirement) == errSecSuccess else {
            throw HelperLifecycleError.parent
        }
        var caller: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: parentPID)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &caller) == errSecSuccess, let caller else {
            throw HelperLifecycleError.parent
        }
        var requirement: SecRequirement?
        let callerRule = "\(signing) and identifier \"\(appID)\""
        guard SecRequirementCreateWithString(callerRule as CFString, [], &requirement) == errSecSuccess,
              let requirement,
              SecCodeCheckValidity(caller, [.noNetworkAccess], requirement) == errSecSuccess else {
            throw HelperLifecycleError.parent
        }
        var appCode: SecStaticCode?
        var designated: SecRequirement?
        guard SecStaticCodeCreateWithPath(appURL as CFURL, [], &appCode) == errSecSuccess, let appCode,
              SecCodeCopyDesignatedRequirement(appCode, [], &designated) == errSecSuccess, let designated,
              SecCodeCheckValidity(caller, [.noNetworkAccess], designated) == errSecSuccess else {
            throw HelperLifecycleError.parent
        }
    }

    private static func spawnWorker(executable: String, parentPID: pid_t, mode: HelperWorkerLaunchMode) throws -> pid_t {
        var attributes: posix_spawnattr_t?
        var actions: posix_spawn_file_actions_t?
        guard posix_spawnattr_init(&attributes) == 0 else { throw HelperLifecycleError.spawn(errno) }
        defer { posix_spawnattr_destroy(&attributes) }
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw HelperLifecycleError.spawn(errno) }
        defer { posix_spawn_file_actions_destroy(&actions) }
        var defaults = sigset_t()
        var unblocked = sigset_t()
        sigfillset(&defaults)
        sigemptyset(&unblocked)
        let flags = Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)
        guard posix_spawnattr_setflags(&attributes, flags) == 0,
              posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
              posix_spawnattr_setsigmask(&attributes, &unblocked) == 0,
              ResponsibilityAPI.shared.disclaim(&attributes) else { throw HelperLifecycleError.responsibility }
        // No SETPGROUP/setsid here: the desktop's detached group must contain both launcher and server.
        guard posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0,
              posix_spawn_file_actions_addinherit_np(&actions, STDERR_FILENO) == 0 else {
            throw HelperLifecycleError.spawn(errno)
        }
        if !mode.usesProtocol {
            guard posix_spawn_file_actions_addinherit_np(&actions, STDOUT_FILENO) == 0 else { throw HelperLifecycleError.spawn(errno) }
        } else {
            guard posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) == 0,
                  posix_spawn_file_actions_addinherit_np(&actions, 3) == 0 else { throw HelperLifecycleError.spawn(errno) }
        }
        let values = [executable] + workerArguments(parentPID: parentPID, mode: mode)
        let environment = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
        let arguments = values.map { strdup($0) }
        let variables = environment.map { strdup($0) }
        defer { arguments.forEach { free($0) }; variables.forEach { free($0) } }
        guard arguments.allSatisfy({ $0 != nil }), variables.allSatisfy({ $0 != nil }) else { throw HelperLifecycleError.spawn(ENOMEM) }
        var argv = arguments + [nil]
        var envp = variables + [nil]
        var child: pid_t = 0
        let result = posix_spawn(&child, executable, &actions, &attributes, &argv, &envp)
        guard result == 0, child > 0 else { throw HelperLifecycleError.spawn(result) }
        return child
    }
}

private final class ResponsibilityAPI {
    static let shared = ResponsibilityAPI()
    private typealias SetDisclaim = @convention(c) (UnsafeMutableRawPointer?, Int32) -> Int32
    private typealias ResponsiblePID = @convention(c) (pid_t) -> pid_t
    private let library: UnsafeMutableRawPointer?
    private let setter: SetDisclaim?
    private let observer: ResponsiblePID?

    private init() {
        // Private ABI, deliberately runtime-checked. No spawn flag or undocumented numeric constant is guessed.
        // Pinned call/ABI references:
        // https://github.com/chromium/chromium/blob/490b1ca9a3310257ef48179f4b1defba30a32919/base/process/launch_mac.cc
        // https://github.com/chromium/chromium/blob/490b1ca9a3310257ef48179f4b1defba30a32919/base/process/process_info_mac.mm
        // https://github.com/qt/qtbase/blob/6e01b406faf5cb8a322f5fced847bd6c41684bda/src/corelib/kernel/qcore_mac.mm
        // Apple SDK export owner: /usr/lib/system/libquarantine.dylib (System umbrella).
        library = dlopen("/usr/lib/system/libquarantine.dylib", RTLD_NOW | RTLD_LOCAL)
        if let library {
            setter = dlsym(library, "responsibility_spawnattrs_setdisclaim").map { unsafeBitCast($0, to: SetDisclaim.self) }
            observer = dlsym(library, "responsibility_get_pid_responsible_for_pid").map { unsafeBitCast($0, to: ResponsiblePID.self) }
        } else {
            setter = nil
            observer = nil
        }
    }

    func disclaim(_ attributes: UnsafeMutablePointer<posix_spawnattr_t?>) -> Bool {
        guard let setter, observer != nil else { return false }
        // This is the address of attribute storage, as in the upstream callers, never the opaque handle value.
        return setter(UnsafeMutableRawPointer(attributes), 1) == 0
    }

    func isSelfResponsible() -> Bool {
        HelperLifecycle.responsibilityMatches(observed: observer?(getpid()), current: getpid())
    }

    func responsiblePID(_ pid: pid_t) -> pid_t? {
        guard pid > 0, let observed = observer?(pid), observed > 0 else { return nil }
        return observed
    }
}

/// Dispatch's process source uses kqueue EVFILT_PROC/NOTE_EXIT. The start-time poll is a second fence against
/// reuse and registration races, rather than a replacement for the native exit notification.
private final class HelperProcessWatch {
    private let lock = NSLock()
    private var finished = false
    private let process: DispatchSourceProcess
    private let timer: DispatchSourceTimer
    private let identity: HelperProcessIdentity
    private let onExit: () -> Void

    init(identity: HelperProcessIdentity, queue: DispatchQueue, onExit: @escaping () -> Void) {
        self.identity = identity
        self.onExit = onExit
        process = DispatchSource.makeProcessSource(identifier: identity.pid, eventMask: .exit, queue: queue)
        timer = DispatchSource.makeTimerSource(queue: queue)
        process.setEventHandler { [weak self] in self?.fire() }
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if HelperLifecycle.processIdentity(identity.pid) != identity { self.fire() }
        }
        timer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(5))
        process.resume()
        timer.resume()
        // A process that disappeared before kqueue installed its filter must take the same exit path.
        if HelperLifecycle.processIdentity(identity.pid) != identity { queue.async { [weak self] in self?.fire() } }
    }

    private func fire() {
        lock.lock()
        if finished { lock.unlock(); return }
        finished = true
        lock.unlock()
        process.cancel()
        timer.cancel()
        onExit()
    }

    func cancel() {
        lock.lock()
        finished = true
        lock.unlock()
        process.cancel()
        timer.cancel()
    }

    deinit { cancel() }
}

final class HelperWorkerWatchers {
    private let lock = NSLock()
    private var finished = false
    private var watches: [HelperProcessWatch] = []
    private var signals: [DispatchSourceSignal] = []
    private let onExit: () -> Void

    fileprivate init(parent: HelperParent, onExit: @escaping () -> Void) {
        self.onExit = onExit
        let queue = DispatchQueue(label: "ai.vector.computer.worker-lifecycle")
        // Sources may report an already-dead parent immediately. Publish every owned source before callbacks run.
        queue.suspend()
        watches = ([parent.original] + (parent.supervisor.map { [$0] } ?? [])).map { identity in
            HelperProcessWatch(identity: identity, queue: queue) { [weak self] in self?.finish() }
        }
        signals = [SIGHUP, SIGINT, SIGTERM, SIGQUIT].map { number in
            Darwin.signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { [weak self] in self?.finish() }
            source.resume()
            return source
        }
        queue.resume()
    }

    /// The protocol's EOF and shutdown paths call this after revoking native authority. Cleanup executes once.
    func finish() {
        lock.lock()
        if finished { lock.unlock(); return }
        finished = true
        let current = watches
        let activeSignals = signals
        watches = []
        signals = []
        lock.unlock()
        current.forEach { $0.cancel() }
        activeSignals.forEach { $0.cancel() }
        onExit()
    }

    deinit {
        watches.forEach { $0.cancel() }
        signals.forEach { $0.cancel() }
    }
}

private final class HelperSupervisorWatchdog {
    private let queue = DispatchQueue(label: "ai.vector.computer.supervisor-lifecycle")
    private let completion = DispatchSemaphore(value: 0)
    private let childPID: pid_t
    private let parent: HelperProcessIdentity
    private var watch: HelperProcessWatch?
    private var childWatch: DispatchSourceProcess?
    private var poll: DispatchSourceTimer?
    private var signals: [DispatchSourceSignal] = []
    private var terminating = false
    private var completed = false
    private var result: Int32 = 1

    init(childPID: pid_t, parent: HelperProcessIdentity) {
        self.childPID = childPID
        self.parent = parent
    }

    func wait() -> Int32 {
        queue.sync {
            watch = HelperProcessWatch(identity: parent, queue: queue) { [weak self] in self?.terminate(SIGTERM) }
            let child = DispatchSource.makeProcessSource(identifier: childPID, eventMask: .exit, queue: queue)
            child.setEventHandler { [weak self] in self?.reap() }
            child.resume()
            childWatch = child
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.setEventHandler { [weak self] in self?.reap() }
            timer.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(2))
            timer.resume()
            poll = timer
            signals = [SIGHUP, SIGINT, SIGTERM, SIGQUIT].map { number in
                Darwin.signal(number, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
                source.setEventHandler { [weak self] in self?.terminate(number) }
                source.resume()
                return source
            }
            if HelperLifecycle.processIdentity(parent.pid) != parent { terminate(SIGTERM) }
            reap()
        }
        completion.wait()
        return result
    }

    private func terminate(_ number: Int32) {
        guard !completed, !terminating else { return }
        terminating = true
        Darwin.kill(childPID, number)
        // Input release and clipboard restoration each have a 300 ms budget. Leave their parallel
        // cleanup room to finish, while keeping the parent's hard stop inside the one-second exit bound.
        queue.asyncAfter(deadline: .now() + .milliseconds(750)) { [weak self] in
            guard let self, !self.completed else { return }
            // The PID cannot be reused before this supervisor reaps its child.
            Darwin.kill(self.childPID, SIGKILL)
            self.reap()
        }
    }

    private func reap() {
        guard !completed else { return }
        var status: Int32 = 0
        let value = waitpid(childPID, &status, WNOHANG)
        if value == -1 && errno == EINTR { return }
        guard value == childPID || (value == -1 && errno == ECHILD) else { return }
        completed = true
        result = value == childPID ? HelperLifecycle.exitCode(waitStatus: status) : 1
        watch?.cancel()
        watch = nil
        childWatch?.cancel()
        childWatch = nil
        poll?.cancel()
        poll = nil
        signals.forEach { $0.cancel() }
        signals = []
        completion.signal()
    }
}
