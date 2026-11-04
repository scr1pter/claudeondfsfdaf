import AppKit
import Darwin
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
    private let errorOutput = DispatchQueue(label: "ai.vector.computer.protocol-errors")
    private let reader = FrameReader()
    private let writer = FrameWriter(descriptor: 3)

    func start(parent: HelperParent) throws {
        dispatcher = Dispatcher(
            responsible: HelperLifecycle.isSelfResponsible(),
            architecture: architecture,
            operatingSystem: ProcessInfo.processInfo.operatingSystemVersionString,
            send: { [weak self] response in self?.write(response) },
            event: { [weak self] event in
                guard let self else { return }
                do { try self.writer.write(event) } catch { self.finish(code: 1) }
            },
            stopped: { [weak self] in self?.finish(code: 0) },
            sendImage: { [weak self] response, image in
                guard let self else { return }
                do { try self.writer.write(response, binary: image) } catch { self.finish(code: 1) }
            }
        )
        watchers = try HelperLifecycle.installWorkerWatchers(parent: parent) { [weak self] in
            self?.finish(code: 0)
        }
        let flags = fcntl(3, F_GETFL)
        guard flags >= 0, fcntl(3, F_SETFL, flags | O_NONBLOCK) == 0 else { throw HelperCommand.UsageError.invalidArguments }
        let input = DispatchSource.makeReadSource(fileDescriptor: 3, queue: DispatchQueue(label: "ai.vector.computer.protocol"))
        input.setEventHandler { [weak self] in self?.read() }
        source = input
        input.resume()
    }

    private func read() {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(3, $0.baseAddress, $0.count) }
            if count > 0 {
                reader.consume(Data(buffer.prefix(count)), onRequest: { [weak self] request in
                    self?.dispatcher?.receive(request)
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
        lock.unlock()
        // Dispatcher revocation invokes the native release hook before this process exits or closes its channel.
        dispatcher?.close(reason: "lifecycle")
        source?.cancel()
        watchers?.finish()
        _ = Darwin.close(3)
        Darwin._exit(code)
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
                "permissions": .object(["screen": .string("notDetermined"), "accessibility": .string("notDetermined")]),
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
    case .selfTest(let mode, let target, let report):
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
