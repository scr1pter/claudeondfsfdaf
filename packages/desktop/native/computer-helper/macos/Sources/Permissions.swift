import ApplicationServices
import CoreGraphics
import Darwin
import Dispatch
import Foundation

struct PermissionOperations {
    let screenStatus: () -> Bool
    let accessibilityStatus: () -> Bool
    let postEventStatus: () -> Bool
    let requestScreen: () -> Bool
    let requestAccessibility: () -> Bool
    let requestPostEvent: () -> Bool

    static var system: PermissionOperations {
        PermissionOperations(
            screenStatus: { CGPreflightScreenCaptureAccess() },
            accessibilityStatus: { AXIsProcessTrusted() },
            postEventStatus: { CGPreflightPostEventAccess() },
            requestScreen: { CGRequestScreenCaptureAccess() },
            requestAccessibility: {
                AXIsProcessTrustedWithOptions(
                    [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                )
            },
            requestPostEvent: { CGRequestPostEventAccess() }
        )
    }
}

struct PermissionResetCommand: Equatable {
    let executable: String
    let arguments: [String]
    let timeoutMs: Int
}

/// One service per verified worker owns its prompt attempts. Only explicit request/reset handlers mutate them.
final class PermissionService {
    private let lock = NSLock()
    private let helperBundleId: String?
    private let operations: PermissionOperations
    private let execute: (@escaping () -> Void) -> Void
    private let resetProcess: ((PermissionResetCommand) -> Bool)?
    private var attempted: Set<String> = []
    private var closed = false
    private var resetChildren: Set<pid_t> = []

    init(
        helperBundleId: String? = Bundle.main.bundleIdentifier,
        operations: PermissionOperations = .system,
        execute: ((@escaping () -> Void) -> Void)? = nil,
        resetProcess: ((PermissionResetCommand) -> Bool)? = nil
    ) {
        self.helperBundleId = helperBundleId
        self.operations = operations
        self.resetProcess = resetProcess
        let queue = DispatchQueue(label: "ai.vector.computer.permissions")
        self.execute = execute ?? { queue.async(execute: DispatchWorkItem(block: $0)) }
    }

    /// These public preflights expose Bool, not the reason a grant is absent. Never invent OS denial history.
    func status() -> [String: JSONValue] {
        [
            "screen": .string(operations.screenStatus() ? "granted" : "denied"),
            "accessibility": .string(operations.accessibilityStatus() ? "granted" : "denied"),
            "postEvent": .string(operations.postEventStatus() ? "granted" : "denied"),
        ]
    }

    static func settingsURL(service: String) -> URL? {
        switch service {
        case "screen": return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        case "accessibility": return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        default: return nil
        }
    }

    /// Root calls this before worker exit. No reset process may survive a closed protocol channel.
    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true
        let children = resetChildren
        lock.unlock()
        stopResetChildren(children)
    }

    func request(
        _ args: [String: JSONValue], responsible: Bool, context: OperationContext,
        completion: @escaping Dispatcher.Completion
    ) {
        guard let service = Self.service(args) else { completion(.failure(Self.invalidArguments)); return }
        guard responsible else { completeStatus(context, completion); return }
        execute { [self] in
            var first = false
            var open = false
            // Reserve a single explicit attempt with the epoch fence, without holding the dispatcher lock
            // across a framework call that may wait for the owner's response to a system prompt.
            guard context.withCurrent({
                self.lock.lock()
                defer { self.lock.unlock() }
                guard !self.closed else { return }
                open = true
                first = self.attempted.insert(service).inserted
            }), open else { completion(.failure(Self.changed)); return }
            if first {
                guard current(context) else { completion(.failure(Self.changed)); return }
                if service == "screen" {
                    if !operations.screenStatus() {
                        guard current(context) else { completion(.failure(Self.changed)); return }
                        _ = operations.requestScreen()
                    }
                } else {
                    if !operations.accessibilityStatus() {
                        guard current(context) else { completion(.failure(Self.changed)); return }
                        _ = operations.requestAccessibility()
                    }
                    // A cancelled or timed-out Accessibility prompt must never cause a delayed second prompt.
                    guard current(context) else { completion(.failure(Self.changed)); return }
                    if !operations.postEventStatus() {
                        guard current(context) else { completion(.failure(Self.changed)); return }
                        _ = operations.requestPostEvent()
                    }
                }
            }
            completeStatus(context, completion)
        }
    }

    func reset(
        _ args: [String: JSONValue], responsible: Bool, context: OperationContext,
        completion: @escaping Dispatcher.Completion
    ) {
        guard let service = Self.service(args) else { completion(.failure(Self.invalidArguments)); return }
        guard responsible else {
            completion(.failure(ServerFailure(code: "responsible_missing", message: "The helper does not own its OS permissions.")))
            return
        }
        guard let helperBundleId, Identity.channels.contains(where: { $0.helperBundleId == helperBundleId }) else {
            completion(.failure(ServerFailure(code: "failed", message: "The helper's own permission identity is unavailable.")))
            return
        }
        let command = PermissionResetCommand(executable: "/usr/bin/tccutil",
            arguments: ["reset", service == "screen" ? "ScreenCapture" : "Accessibility", helperBundleId], timeoutMs: 3000)
        execute { [self] in
            guard current(context) else { completion(.failure(Self.changed)); return }
            let succeeded = resetProcess?(command) ?? runReset(command, context: context)
            guard current(context) else { completion(.failure(Self.changed)); return }
            guard succeeded else {
                completion(.failure(ServerFailure(code: "failed", message: "The helper's permission reset did not complete.")))
                return
            }
            // D21 clears its saved attempt only after this succeeds. A stale reset cannot clear a successor.
            var committed = false
            guard context.withCurrent({
                self.lock.lock()
                defer { self.lock.unlock() }
                guard !self.closed else { return }
                self.attempted.remove(service)
                committed = true
            }), committed else { completion(.failure(Self.changed)); return }
            completeStatus(context, completion)
        }
    }

    private static let invalidArguments = ServerFailure(code: "failed", message: "Choose only the screen or accessibility service.")
    private static let changed = ServerFailure(code: "changed", message: "The permission operation is no longer current.")

    private static func service(_ args: [String: JSONValue]) -> String? {
        guard args.count == 1, let service = args["service"]?.stringValue,
              service == "screen" || service == "accessibility" else { return nil }
        return service
    }

    private func completeStatus(_ context: OperationContext, _ completion: Dispatcher.Completion) {
        guard current(context) else { completion(.failure(Self.changed)); return }
        let fields = status()
        guard current(context) else { completion(.failure(Self.changed)); return }
        completion(.success(ServerReply(fields: fields)))
    }

    private func current(_ context: OperationContext) -> Bool {
        guard context.isCurrent() else { return false }
        lock.lock()
        defer { lock.unlock() }
        return !closed
    }

    /// Only the fixed tccutil action is spawnable; no shell, caller-chosen identity, inherited channel or output.
    private func runReset(_ command: PermissionResetCommand, context: OperationContext) -> Bool {
        guard command.executable == "/usr/bin/tccutil", command.timeoutMs == 3000,
              command.arguments.count == 3, command.arguments[0] == "reset",
              ["ScreenCapture", "Accessibility"].contains(command.arguments[1]),
              let helperBundleId, command.arguments[2] == helperBundleId,
              Identity.channels.contains(where: { $0.helperBundleId == helperBundleId }) else { return false }
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { return false }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { return false }
        defer { posix_spawnattr_destroy(&attributes) }
        var defaults = sigset_t()
        var mask = sigset_t()
        sigfillset(&defaults)
        sigemptyset(&mask)
        let flags = Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)
        guard posix_spawnattr_setflags(&attributes, flags) == 0,
              posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
              posix_spawnattr_setsigmask(&attributes, &mask) == 0,
              posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0,
              posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) == 0,
              posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0 else { return false }
        let strings = ([command.executable] + command.arguments).map { strdup($0) }
        let variables = [strdup("PATH=/usr/bin:/bin")]
        defer { strings.forEach { free($0) }; variables.forEach { free($0) } }
        guard strings.allSatisfy({ $0 != nil }), variables.allSatisfy({ $0 != nil }) else { return false }
        var argv = strings + [nil]
        var envp = variables + [nil]
        var child: pid_t = 0
        var spawned = false
        // Spawn/registration share the close lock and the current epoch. Neither a wait nor a prompt runs here.
        guard context.withCurrent({
            self.lock.lock()
            defer { self.lock.unlock() }
            guard !self.closed, self.resetChildren.isEmpty else { return }
            guard posix_spawn(&child, command.executable, &actions, &attributes, &argv, &envp) == 0, child > 0 else { return }
            self.resetChildren.insert(child)
            spawned = true
        }), spawned else { return false }
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(command.timeoutMs) * 1_000_000
        while DispatchTime.now().uptimeNanoseconds < deadline {
            switch resetExit(child) {
            case .exited(let status): return (status & 0x7f) == 0 && ((status >> 8) & 0xff) == 0
            case .unavailable: return false
            case .waiting: break
            }
            if !current(context) { stopResetChildren([child]); return false }
            usleep(5_000)
        }
        stopResetChildren([child])
        return false
    }

    private enum ResetExit { case waiting, exited(Int32), unavailable }

    /// Reaping and removal are atomic with close/kill, so a reused PID is never left in the owned-child set.
    private func resetExit(_ child: pid_t) -> ResetExit {
        lock.lock()
        defer { lock.unlock() }
        guard resetChildren.contains(child) else { return .unavailable }
        var status: Int32 = 0
        let result = waitpid(child, &status, WNOHANG)
        if result == child { resetChildren.remove(child); return .exited(status) }
        if result == -1 && errno != EINTR { resetChildren.remove(child); return .unavailable }
        return .waiting
    }

    private func stopResetChildren(_ children: Set<pid_t>) {
        lock.lock()
        let owned = children.intersection(resetChildren)
        owned.forEach { _ = Darwin.kill($0, SIGKILL) }
        lock.unlock()
        let deadline = DispatchTime.now().uptimeNanoseconds + 200_000_000
        var remaining = owned
        while !remaining.isEmpty && DispatchTime.now().uptimeNanoseconds < deadline {
            remaining = Set(remaining.filter { child in
                if case .waiting = resetExit(child) { return true }
                return false
            })
            if !remaining.isEmpty { usleep(5_000) }
        }
        guard !remaining.isEmpty else { return }
        // An OS-delayed killed child can be reaped later; never extend EOF or the wire deadline for it.
        let pending = remaining
        DispatchQueue.global(qos: .utility).async { [self] in
            var children = pending
            while !children.isEmpty {
                children = Set(children.filter { child in
                    if case .waiting = self.resetExit(child) { return true }
                    return false
                })
                if !children.isEmpty { usleep(5_000) }
            }
        }
    }
}
