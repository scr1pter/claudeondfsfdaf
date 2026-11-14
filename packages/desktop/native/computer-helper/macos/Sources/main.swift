import AppKit
import CoreGraphics
import Darwin
import Dispatch
import Foundation

private let architecture: String = {
    #if arch(arm64)
    return "arm64"
    #elseif arch(x86_64)
    return "x64"
    #else
    return "unknown"
    #endif
}()

private func printJSON(_ value: JSONValue) throws {
    var bytes = try JSONEncoder().encode(value)
    bytes.append(10)
    try FileHandle.standardOutput.write(contentsOf: bytes)
}

/** Only the verified worker opens the protocol descriptor. The main AppKit run loop remains free for native hooks. */
private final class HelperServer {
    private let lock = NSLock()
    private var ending = false
    private var source: DispatchSourceRead?
    private var watchers: HelperWorkerWatchers?
    private var dispatcher: Dispatcher?
    private var pendingErrors = 0
    private var pendingRequests = 0
    private var pendingRequestBytes = 0
    private let requestIngress = DispatchQueue(label: "ai.vector.computer.request-ingress")
    private let errorOutput = DispatchQueue(label: "ai.vector.computer.protocol-errors")
    private let reader = FrameReader()
    private let writer = FrameWriter(descriptor: 3, writeTimeoutMs: 50)
    private let permissionService = PermissionService()
    private let captureRegistry = CaptureRegistry()
    private lazy var captureService = CaptureService(registry: captureRegistry)
    private lazy var accessibilityService = AccessibilityService(captures: captureRegistry)
    private lazy var inputService = InputService(captures: captureRegistry, accessibility: accessibilityService)
    private lazy var appsService = AppsService()
    private let clipboardService = ClipboardService()
    private let clipboardLifecycle = DispatchQueue(label: "ai.vector.computer.clipboard-lifecycle")
    private let lifecycleCleanup = DispatchQueue(label: "ai.vector.computer.lifecycle-cleanup")
    private let monitoring = DispatchQueue(label: "ai.vector.computer.monitoring")
    private lazy var eventTap: EventTapMonitor = EventTapMonitor(
        session: { [weak self] in self?.dispatcher?.sessionSnapshot() },
        input: { [weak self] event, session, takeover in
            self?.dispatcher?.handlePhysicalInput(event, expected: session, takeover: takeover) ?? false
        },
        stop: { [weak self] by, session in self?.dispatcher?.stopFromPhysicalInput(by: by, expected: session) ?? false },
        status: { [weak self] status in self?.watchdog.observeTap(status) }
    )
    private lazy var watchdog: WatchdogService = WatchdogService(
        session: { [weak self] in self?.dispatcher?.sessionSnapshot() },
        tapStatus: { [weak self] in self?.eventTap.status() ?? EventTapStatus(generation: 0, installed: false, enabled: false) },
        recoverTap: { [weak self] in self?.eventTap.recover() },
        probeTap: { [weak self] nonce in self?.eventTap.probe(challenge: nonce) },
        pause: { [weak self] session, reason in self?.dispatcher?.pauseForEnvironment(expected: session, reason: reason) ?? false },
        emit: { [weak self] event, session in _ = self?.dispatcher?.publishNativeEvent(event, expected: session) },
        environmentChanged: { [weak self] _ in
            guard let self else { return }
            self.dispatcher?.setDesktopAvailability(self.watchdog.availability())
        }
    )
    private var cleanupFailed = false
    private var displayCallbackRegistered = false
    private var activeSpaceObserver: NSObjectProtocol?

    private static let displayCallback: CGDisplayReconfigurationCallBack = { _, _, context in
        guard let context else { return }
        let server = Unmanaged<HelperServer>.fromOpaque(context).takeUnretainedValue()
        _ = server.inputService.releaseAll()
        server.captureService.invalidateDisplays()
        server.accessibilityService.invalidateObservations()
        server.dispatcher?.notifyDisplayChange()
    }

    func start(parent: HelperParent) throws {
        // Native notifications may publish as soon as monitors start. Their writes must already be nonblocking.
        let flags = fcntl(3, F_GETFL)
        guard flags >= 0, fcntl(3, F_SETFL, flags | O_NONBLOCK) == 0 else { throw HelperCommand.UsageError.invalidArguments }
        let permissions = permissionService
        let capture = captureService
        let accessibility = accessibilityService
        let inputs = inputService
        let apps = appsService
        let clipboard = clipboardService
        let clipboardQueue = clipboardLifecycle
        let tap = eventTap
        let watchdog = self.watchdog
        let monitoring = self.monitoring
        let server = Dispatcher(
            responsible: HelperLifecycle.isSelfResponsible(),
            architecture: architecture,
            operatingSystem: ProcessInfo.processInfo.operatingSystemVersionString,
            send: { [weak self] response in self?.write(response) },
            event: { [weak self] event in
                guard let self else { return }
                do { try self.writer.write(event) } catch { self.finish(code: 1) }
            },
            releaseAll: { inputs.releaseAll() },
            observationsInvalidated: {
                capture.invalidateDisplays()
                accessibility.invalidateObservations()
                apps.invalidateObservations()
            },
            cleanupRequested: { reason in
                if ["close", "physical-input", "stop", "environment", "heartbeat", "replacement", "end", "cancel"].contains(reason) {
                    accessibility.invalidateObservations(hard: true)
                }
                clipboardQueue.async { clipboard.cleanup() }
            },
            sessionChanged: { [weak self] session in
                accessibility.noteSession(session)
                monitoring.async {
                    tap.refreshSession(); watchdog.refreshSession()
                    accessibility.retireWakes(session: self?.dispatcher?.sessionSnapshot())
                }
            },
            desktopAvailability: { watchdog.availability() },
            foregroundReady: { watchdog.foregroundReady($0) },
            nativeEventIsCurrent: { event, session in
                if ["locked", "input_detection"].contains(event.value["event"]?.stringValue ?? "") {
                    return watchdog.eventIsCurrent(event: event, expected: session)
                }
                return true
            },
            stopped: { [weak self] in self?.finish(code: 0) },
            sendImage: { [weak self] response, image in
                guard let self else { return }
                do { try self.writer.write(response, binary: image) } catch { self.finish(code: 1) }
            },
            features: {
                capture.features().merging(accessibility.features()) { _, current in current }
                    .merging(inputs.features()) { _, current in current }
                    .merging(apps.features()) { _, current in current }
                    .merging(clipboard.features()) { _, current in current }
            },
            permissions: { permissions.status() }
        )
        server.register(op: "permissions.request", deadlineMs: 5000, requiresSession: false) { request, context, done in
            permissions.request(request.args, responsible: HelperLifecycle.isSelfResponsible(), context: context, completion: done)
        }
        server.register(op: "permissions.reset", deadlineMs: 4000, requiresSession: false) { request, context, done in
            permissions.reset(request.args, responsible: HelperLifecycle.isSelfResponsible(), context: context, completion: done)
        }
        server.register(op: "displays.list", deadlineMs: 5000, requiresSession: false) { request, context, done in
            capture.listDisplays(request.args, context: context, completion: done)
        }
        server.register(op: "capture", deadlineMs: 10000) { request, context, done in
            capture.capture(request.args, context: context, completion: done)
        }
        server.register(op: "ui.tree", deadlineMs: 15000) { request, context, done in
            accessibility.tree(request.args, context: context, completion: done)
        }
        server.register(op: "ui.hittest", deadlineMs: 10000) { request, context, done in
            accessibility.hitTest(request.args, context: context, completion: done)
        }
        server.register(op: "ui.focused", deadlineMs: 10000) { request, context, done in
            accessibility.focused(request.args, context: context, completion: done)
        }
        server.register(op: "ui.resolve", deadlineMs: 10000) { request, context, done in
            accessibility.resolve(request.args, context: context, completion: done)
        }
        server.register(op: "ui.perform", deadlineMs: 10000) { request, context, done in
            accessibility.perform(request.args, context: context, completion: done)
        }
        server.register(op: "ui.setValue", deadlineMs: 10000) { request, context, done in
            accessibility.setValue(request.args, context: context, completion: done)
        }
        for op in ["input.move", "input.click", "input.drag", "input.scroll", "input.key", "input.type", "input.hold"] {
            server.register(op: op, deadlineMs: op == "input.hold" ? 20000 : 10000) { request, context, done in
                inputs.handle(op: request.op, args: request.args, context: context, completion: done)
            }
        }
        server.register(op: "apps.list", deadlineMs: 5000, requiresSession: false) { request, context, done in
            apps.list(request.args, context: context, completion: done)
        }
        server.register(op: "apps.resolve", deadlineMs: 10000) { request, context, done in
            apps.resolve(request.args, context: context, completion: done)
        }
        server.register(op: "app.activate", deadlineMs: 10000) { request, context, done in
            apps.activate(request.args, context: context, completion: done)
        }
        server.register(op: "app.launch", deadlineMs: 10000) { request, context, done in
            apps.launch(request.args, context: context, completion: done)
        }
        server.register(op: "window.focus", deadlineMs: 10000) { request, context, done in
            apps.focus(request.args, context: context, completion: done)
        }
        server.register(op: "program.launch", deadlineMs: 10000) { request, context, done in
            apps.launchProgram(request.args, context: context, completion: done)
        }
        server.register(op: "cursor.position", deadlineMs: 5000, requiresSession: false) { request, context, done in
            apps.cursor(request.args, context: context, completion: done)
        }
        server.register(op: "clipboard.read", deadlineMs: 2000) { request, context, done in
            clipboardQueue.async { clipboard.read(request.args, context: context, completion: done) }
        }
        server.register(op: "clipboard.write", deadlineMs: 2000) { request, context, done in
            clipboardQueue.async { clipboard.write(request.args, context: context, completion: done) }
        }
        dispatcher = server
        tap.start()
        watchdog.start()
        inputs.reconcileOnStart()
        watchers = try HelperLifecycle.installWorkerWatchers(parent: parent) { [weak self] in
            self?.finish(code: 0)
        }
        let input = DispatchSource.makeReadSource(fileDescriptor: 3, queue: DispatchQueue(label: "ai.vector.computer.protocol"))
        input.setEventHandler { [weak self] in self?.read() }
        source = input
        // The server remains retained throughout the application run loop and exits only through finish.
        lock.lock()
        guard !ending else { lock.unlock(); input.cancel(); input.resume(); return }
        let registered = CGDisplayRegisterReconfigurationCallback(Self.displayCallback, Unmanaged.passUnretained(self).toOpaque()) == .success
        displayCallbackRegistered = registered
        lock.unlock()
        guard registered else { input.resume(); finish(code: 1); return }
        activeSpaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: nil
        ) { [weak self] _ in
            _ = self?.inputService.releaseAll()
            self?.captureService.invalidateDisplays()
            self?.accessibilityService.invalidateObservations()
            self?.dispatcher?.notifyDisplayChange()
        }
        input.resume()
    }

    private func read() {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            lock.lock(); let stopped = ending; lock.unlock()
            if stopped { return }
            let count = buffer.withUnsafeMutableBytes { Darwin.read(3, $0.baseAddress, $0.count) }
            if count > 0 {
                reader.consume(Data(buffer.prefix(count)), onSizedRequest: { [weak self] request, bytes in
                    self?.enqueue(request, bytes: bytes)
                }, onFailure: { [weak self] failure in self?.malformed(failure) })
                continue
            }
            if count == 0 {
                _ = reader.finish()
                finish(code: 0)
                return
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK { return }
            finish(code: 1)
            return
        }
    }

    private func write(_ response: Response) {
        do { try writer.write(response) } catch { finish(code: 1) }
    }

    private func enqueue(_ request: Request, bytes: Int) {
        lock.lock()
        guard !ending else { lock.unlock(); return }
        let remaining = (2 * (maxFrameBytes + 4)).subtractingReportingOverflow(pendingRequestBytes)
        guard pendingRequests < 16, bytes > 0, bytes <= maxFrameBytes + 4,
              pendingRequestBytes >= 0, !remaining.overflow, remaining.partialValue >= 0,
              bytes <= remaining.partialValue else {
            lock.unlock()
            finish(code: 1)
            return
        }
        pendingRequests += 1
        pendingRequestBytes += bytes
        lock.unlock()
        // Never let Dispatcher admission (or a native commit holding its lock) prevent fd3 EOF detection.
        requestIngress.async {
            self.lock.lock(); let live = !self.ending; self.lock.unlock()
            if live { self.dispatcher?.receive(request) }
            self.lock.lock()
            self.pendingRequests -= 1
            self.pendingRequestBytes -= bytes
            self.lock.unlock()
        }
    }

    private func malformed(_ response: Response) {
        lock.lock()
        if ending { lock.unlock(); return }
        if pendingErrors >= 64 { lock.unlock(); finish(code: 1); return }
        pendingErrors += 1
        lock.unlock()
        // An unread error response must never prevent the independent reader from noticing channel EOF.
        errorOutput.async { [weak self] in
            guard let self else { return }
            self.write(response)
            self.lock.lock()
            self.pendingErrors -= 1
            self.lock.unlock()
        }
    }

    private func finish(code: Int32) {
        lock.lock()
        if ending { lock.unlock(); return }
        ending = true
        let removeDisplayCallback = displayCallbackRegistered
        displayCallbackRegistered = false
        let removeActiveSpaceObserver = activeSpaceObserver
        activeSpaceObserver = nil
        lock.unlock()
        source?.cancel()
        // Arm this before touching Dispatcher or service locks: synchronous native pasteboard IPC may stall
        // while holding its commit fence. The fuse remains independent of that RPC and all cleanup queues.
        DispatchQueue.global(qos: .userInteractive).asyncAfter(deadline: .now() + .milliseconds(750)) {
            Darwin._exit(code == 0 ? 1 : code)
        }
        let finished = DispatchGroup()
        finished.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            self.clipboardService.close { restored in
                self.lock.lock(); self.cleanupFailed = self.cleanupFailed || !restored; self.lock.unlock()
                finished.leave()
            }
        }
        finished.enter()
        lifecycleCleanup.async {
            // Revoke each native service's own admission before Dispatcher close can wait on an in-flight RPC.
            self.watchdog.close()
            self.eventTap.close()
            self.inputService.close()
            self.appsService.close()
            self.dispatcher?.close(reason: "lifecycle")
            self.permissionService.close()
            self.captureService.close()
            self.accessibilityService.close()
            let wakeCleanupFailed = !self.accessibilityService.wakeCleanupComplete()
            self.lock.lock()
            self.cleanupFailed = self.cleanupFailed || wakeCleanupFailed
            self.lock.unlock()
            if removeDisplayCallback {
                _ = CGDisplayRemoveReconfigurationCallback(Self.displayCallback, Unmanaged.passUnretained(self).toOpaque())
            }
            if let removeActiveSpaceObserver {
                NSWorkspace.shared.notificationCenter.removeObserver(removeActiveSpaceObserver)
            }
            finished.leave()
        }
        finished.notify(queue: lifecycleCleanup) {
            self.lock.lock(); let failed = self.cleanupFailed; self.lock.unlock()
            self.watchers?.finish()
            _ = Darwin.close(3)
            Darwin._exit(failed && code == 0 ? 1 : code)
        }
    }
}

private func run() throws -> Int32 {
    switch try HelperCommand.parse(Array(CommandLine.arguments.dropFirst())) {
    case .version:
        var fields: [String: JSONValue] = [
            "helperVersion": .string(Identity.helperVersion),
            "protocol": .object(["min": .number(Double(Identity.protocolMin)), "max": .number(Double(Identity.protocolMax))]),
            "platform": .string("darwin"), "arch": .string(architecture),
        ]
        if let digest = Bundle.main.object(forInfoDictionaryKey: "VectorComputerSourceDigest") as? String,
           digest.count == 64, digest.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }) {
            fields["sourceDigest"] = .string(digest)
        }
        try printJSON(.object(fields))
        return 0
    case .probe:
        return try HelperLifecycle.runSupervisor(parentPID: getppid(), probe: true)
    case .serve(let parentPID):
        return try HelperLifecycle.runSupervisor(parentPID: parentPID, probe: false)
    case .worker(let parentPID, let probe):
        let parent = try HelperLifecycle.verifyWorker(parentPID: parentPID)
        _ = signal(SIGPIPE, SIG_IGN)
        if probe {
            try printJSON(.object([
                "permissions": .object(PermissionService().status()),
                "responsible": .bool(HelperLifecycle.isSelfResponsible()),
                "elevated": .bool(geteuid() == 0),
            ]))
            return 0
        }
        guard HelperLifecycle.protocolDescriptorIsValid(3) else { return 1 }
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let server = HelperServer()
        try server.start(parent: parent)
        application.run()
        withExtendedLifetime(server) {}
        return 0
    case .privilegedWorker(let parentPID, let target, let report):
        let parent = try HelperLifecycle.verifyWorker(parentPID: parentPID)
        _ = signal(SIGPIPE, SIG_IGN)
        // The runner owns lifecycle cancellation and bounded target/input cleanup before returning its report.
        return try runHelperSelfTest(mode: "privileged", target: target, report: report, parent: parent)
    case .selfTest(let mode, let target, let report):
        if mode == "privileged" {
            guard let target else { throw HelperCommand.UsageError.invalidArguments }
            return try HelperLifecycle.runPrivilegedSupervisor(parentPID: getppid(), target: target, report: report)
        }
        return try runHelperSelfTest(mode: mode, target: target, report: report)
    }
}

do {
    Darwin.exit(try run())
} catch HelperCommand.UsageError.invalidArguments {
    FileHandle.standardError.write(Data("Invalid computer helper arguments.\n".utf8))
    Darwin.exit(2)
} catch {
    FileHandle.standardError.write(Data("The computer helper could not start safely.\n".utf8))
    Darwin.exit(1)
}
