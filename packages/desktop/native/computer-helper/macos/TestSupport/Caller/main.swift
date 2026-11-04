import Darwin
import Dispatch
import Foundation

// C2's verified parent fixture. This is a separate application executable, never part of VectorComputer.app.
// It neither changes responsibility nor invokes a native permission, capture or input operation.
private enum CallerError: Error { case arguments, bundle, descriptor, process, spawn }

private struct CallerProcess: Equatable {
    let pid: pid_t
    let parent: pid_t
    let seconds: UInt64
    let microseconds: UInt64
    let executable: String
}

private func canonical(_ path: String) -> String? {
    guard path.hasPrefix("/"), !path.contains("\0"), let pointer = realpath(path, nil) else { return nil }
    defer { free(pointer) }
    return String(cString: pointer)
}

private func process(_ pid: pid_t) -> CallerProcess? {
    guard pid > 0 else { return nil }
    var before = proc_bsdinfo()
    var after = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    var path = [CChar](repeating: 0, count: Int(PROC_PIDPATHINFO_MAXSIZE))
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, size) == size,
          proc_pidpath(pid, &path, UInt32(path.count)) > 0,
          let executable = canonical(String(cString: path)),
          proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, size) == size,
          before.pbi_ppid == after.pbi_ppid,
          before.pbi_start_tvsec == after.pbi_start_tvsec,
          before.pbi_start_tvusec == after.pbi_start_tvusec else { return nil }
    return CallerProcess(pid: pid, parent: pid_t(before.pbi_ppid), seconds: before.pbi_start_tvsec,
                         microseconds: before.pbi_start_tvusec, executable: executable)
}

private func plist(_ url: URL) throws -> (identifier: String, executable: String) {
    let fd = open(url.path, O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW)
    guard fd >= 0 else { throw CallerError.bundle }
    defer { Darwin.close(fd) }
    var status = stat()
    guard fstat(fd, &status) == 0, status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          status.st_size > 0, status.st_size <= 1_048_576 else { throw CallerError.bundle }
    var data = Data()
    var bytes = [UInt8](repeating: 0, count: 16_384)
    while data.count <= 1_048_576 {
        let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        if count < 0 && errno == EINTR { continue }
        guard count >= 0 else { throw CallerError.bundle }
        if count == 0 { break }
        data.append(contentsOf: bytes.prefix(count))
    }
    guard data.count <= 1_048_576,
          let object = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
          let identifier = object["CFBundleIdentifier"] as? String,
          let executable = object["CFBundleExecutable"] as? String,
          !executable.isEmpty, executable != ".", executable != "..",
          !executable.contains("/"), !executable.contains("\0") else { throw CallerError.bundle }
    return (identifier, executable)
}

private func containingHelper() throws -> String {
    guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(),
          let own = process(getpid()) else { throw CallerError.process }
    let executable = URL(fileURLWithPath: own.executable)
    let app = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    guard app.pathExtension == "app" else { throw CallerError.bundle }
    let metadata = try plist(app.appendingPathComponent("Contents/Info.plist"))
    guard let channel = Identity.channels.first(where: { $0.appId == metadata.identifier }),
          app.appendingPathComponent("Contents/MacOS/\(metadata.executable)").path == own.executable else {
        throw CallerError.bundle
    }
    // Neither a CLI flag nor an environment variable can choose another executable or bundle identity.
    let bundle = app.appendingPathComponent("Contents/Helpers/\(Identity.bundle)")
    let helper = bundle.appendingPathComponent("Contents/MacOS/\(Identity.executable)")
    let helperInfo = try plist(bundle.appendingPathComponent("Contents/Info.plist"))
    guard helperInfo.identifier == channel.helperBundleId, helperInfo.executable == Identity.executable,
          canonical(helper.path) == helper.path else { throw CallerError.bundle }
    var status = stat()
    guard lstat(helper.path, &status) == 0, status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          status.st_mode & mode_t(S_IXUSR | S_IXGRP | S_IXOTH) != 0 else { throw CallerError.bundle }
    return helper.path
}

private func spawnHelper(_ executable: String, probe: Bool) throws -> pid_t {
    if !probe {
        var status = stat()
        guard fstat(3, &status) == 0,
              [mode_t(S_IFIFO), mode_t(S_IFSOCK)].contains(status.st_mode & mode_t(S_IFMT)) else {
            throw CallerError.descriptor
        }
    }
    var actions: posix_spawn_file_actions_t?
    var attributes: posix_spawnattr_t?
    guard posix_spawn_file_actions_init(&actions) == 0 else { throw CallerError.spawn }
    defer { posix_spawn_file_actions_destroy(&actions) }
    guard posix_spawnattr_init(&attributes) == 0 else { throw CallerError.spawn }
    defer { posix_spawnattr_destroy(&attributes) }
    var defaults = sigset_t()
    var mask = sigset_t()
    sigfillset(&defaults)
    sigemptyset(&mask)
    let flags = Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)
    guard posix_spawnattr_setflags(&attributes, flags) == 0,
          posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
          posix_spawnattr_setsigmask(&attributes, &mask) == 0 else { throw CallerError.spawn }
    for fd in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
        guard posix_spawn_file_actions_addinherit_np(&actions, fd) == 0 else { throw CallerError.spawn }
    }
    if !probe {
        guard posix_spawn_file_actions_addinherit_np(&actions, 3) == 0 else { throw CallerError.spawn }
    }
    // Keep the ordinary child relationship and process group. Only the unchanged helper's own launcher disclaims.
    let arguments = [executable] + (probe ? ["--probe", "--json"] : ["--stdio", "--parent-pid", String(getpid())])
    let environment = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
    let strings = arguments.map { strdup($0) }
    let variables = environment.map { strdup($0) }
    defer { strings.forEach { free($0) }; variables.forEach { free($0) } }
    guard strings.allSatisfy({ $0 != nil }), variables.allSatisfy({ $0 != nil }) else { throw CallerError.spawn }
    var argv = strings + [nil]
    var envp = variables + [nil]
    var child: pid_t = 0
    let code = posix_spawn(&child, executable, &actions, &attributes, &argv, &envp)
    guard code == 0, child > 0 else { throw CallerError.spawn }
    // The fixture must never keep this endpoint alive after the actual helper has closed it.
    if !probe { Darwin.close(3) }
    return child
}

private final class CallerWatchdog {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ai.vector.computer.fixture-watchdog")
    private let parent: CallerProcess
    private let child: pid_t
    private let childIdentity: CallerProcess
    private var finished = false
    private var stopping = false
    private var parentWatch: DispatchSourceProcess?
    private var parentPoll: DispatchSourceTimer?
    private var signals: [DispatchSourceSignal] = []
    private var escalation: DispatchWorkItem?

    init(parent: CallerProcess, child: pid_t) throws {
        self.parent = parent
        self.child = child
        guard let identity = process(child), identity.parent == getpid() else {
            // SIGCHLD was reset before spawning and no wait has run: this PID cannot have been reused yet.
            _ = Darwin.kill(child, SIGKILL)
            var status: Int32 = 0
            while waitpid(child, &status, 0) == -1 && errno == EINTR {}
            throw CallerError.process
        }
        childIdentity = identity
        queue.suspend()
        let watch = DispatchSource.makeProcessSource(identifier: parent.pid, eventMask: .exit, queue: queue)
        watch.setEventHandler { [weak self] in self?.stop(SIGTERM) }
        parentWatch = watch
        let poll = DispatchSource.makeTimerSource(queue: queue)
        poll.setEventHandler { [weak self] in
            guard let self else { return }
            if process(self.parent.pid) != self.parent { self.stop(SIGTERM) }
        }
        poll.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(5))
        parentPoll = poll
        signals = [SIGHUP, SIGINT, SIGTERM, SIGQUIT].map { number in
            Darwin.signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { [weak self] in self?.stop(number) }
            source.resume()
            return source
        }
        watch.resume()
        poll.resume()
        queue.resume()
    }

    private func stop(_ number: Int32) {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return }
        signalChild(stopping ? SIGKILL : number)
        guard !stopping else { return }
        stopping = true
        let kill = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            if !self.finished { self.signalChild(SIGKILL) }
        }
        escalation = kill
        queue.asyncAfter(deadline: .now() + .milliseconds(500), execute: kill)
    }

    private func signalChild(_ number: Int32) {
        // A reaped PID may already name somebody else. Never forward a signal without its captured start time.
        guard process(child) == childIdentity else { return }
        _ = Darwin.kill(child, number)
    }

    func wait() -> Int32 {
        var status: Int32 = 0
        while true {
            let result = waitpid(child, &status, 0)
            if result == -1 && errno == EINTR { continue }
            lock.lock()
            finished = true
            escalation?.cancel()
            lock.unlock()
            parentWatch?.cancel()
            parentPoll?.cancel()
            signals.forEach { $0.cancel() }
            guard result == child else { return 1 }
            let signal = status & 0x7f
            return signal == 0 ? (status >> 8) & 0xff : 128 + signal
        }
    }
}

private func runCaller() throws -> Int32 {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let probe = arguments == ["--probe", "--json"]
    guard probe || arguments == ["--stdio"] else { throw CallerError.arguments }
    guard getppid() > 1, let parent = process(getppid()) else { throw CallerError.process }
    let helper = try containingHelper()
    // Keep the spawned PID unreaped until our wait, including the setup-error cleanup path.
    Darwin.signal(SIGCHLD, SIG_DFL)
    let child = try spawnHelper(helper, probe: probe)
    return try CallerWatchdog(parent: parent, child: child).wait()
}

do {
    Darwin.exit(try runCaller())
} catch {
    FileHandle.standardError.write(Data("Computer helper fixture caller failed.\n".utf8))
    Darwin.exit(1)
}
