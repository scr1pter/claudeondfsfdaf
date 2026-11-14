import CoreGraphics
import Darwin
import Dispatch
import Foundation

struct AppsWindow {
    let windowID: String
    let title: String
    let bounds: CGRect
    let minimized: Bool
    let onScreen: Bool
}

struct AppsCursor {
    let point: CGPoint
    let displayID: String
}

struct AppsApplication {
    let identity: MacAppIdentity
    let bundlePath: String
    var owner: NativeOwner? = nil
    var active = false
    var windows: [AppsWindow] = []
}

enum NativeProgramRoute: String { case application, executable, document }

/// A native preparation fact. The digest covers contents, exact route and any actual app-handler binding.
struct NativeProgramArtifact: Equatable {
    let path: String
    let name: String
    let binding: String
    let route: NativeProgramRoute
    var handler: MacAppIdentity? = nil
    var handlerPath: String? = nil
}

enum AppsResolution {
    case app(AppsApplication)
    case program(NativeProgramArtifact)
    case protected(String)
}

struct AppsBackend {
    typealias Completion = (Result<Bool, ServerFailure>) -> Void
    let list: (Bool, ServerSession?) throws -> [AppsApplication]
    let resolve: (String) throws -> AppsResolution
    /// Native implementations schedule AppKit on main, put only actual initiation in context.withCurrent,
    /// then confirm the result asynchronously. Discovery, hashing and foreground waits never hold that fence.
    let activate: (AppsApplication, OperationContext, @escaping Completion) -> Void
    let focus: (AppsApplication, AppsWindow, OperationContext, @escaping Completion) -> Void
    let launchApp: (AppsApplication, OperationContext, @escaping Completion) -> Void
    let launchProgram: (NativeProgramArtifact, OperationContext, @escaping Completion) -> Void
    var cursor: (() throws -> AppsCursor)? = nil
    var close: (() -> Void)? = nil

    static var system: AppsBackend { AppsNative.backend() }
}

private final class AppsReply {
    private let lock = NSLock()
    private var finished = false
    private let completion: Dispatcher.Completion
    init(_ completion: @escaping Dispatcher.Completion) { self.completion = completion }
    func send(_ result: Result<ServerReply, ServerFailure>) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        lock.unlock()
        completion(result)
    }
}

final class AppsService {
    private enum Action {
        case activate(AppsApplication), focus(AppsApplication, AppsWindow), launch(AppsApplication), program(NativeProgramArtifact)
    }
    private let backend: AppsBackend
    private let registry: ProgramLaunchRegistry
    private let execute: (@escaping () -> Void) -> Void
    private let lock = NSRecursiveLock()
    private var closed = false

    init(backend: AppsBackend = .system, registry: ProgramLaunchRegistry = ProgramLaunchRegistry(),
         execute: ((@escaping () -> Void) -> Void)? = nil) {
        self.backend = backend
        self.registry = registry
        let queue = DispatchQueue(label: "ai.vector.computer.apps")
        self.execute = execute ?? { queue.async(execute: DispatchWorkItem(block: $0)) }
    }

    func features() -> [String: Bool] {
        ["apps.list": true, "apps.open": true, "apps.resolve": true, "program.launch": true, "cursor.position": backend.cursor != nil]
    }

    func invalidateObservations() { registry.clear() }
    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true
        lock.unlock()
        registry.close()
        backend.close?()
    }

    func list(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        read(context, completion) {
            guard Set(args.keys).isSubset(of: ["installed"]), args["installed"] == nil || args["installed"]?.boolValue != nil else { throw Self.invalid }
            let apps = try self.catalog(installed: args["installed"]?.boolValue ?? false, session: context.session)
            let policy = try context.session.map { try SessionPolicy(session: $0) }
            let values: [JSONValue] = apps.map { app in
                let windows: [JSONValue] = app.windows.map { window in
                    let content = app.owner.map { owner in
                        policy?.disclosure(NativeTarget(owner: owner, windowID: window.windowID)) == .content
                    } ?? false
                    return .object(["windowId": .string(window.windowID),
                        "title": .string(content ? AccessibilityContent.sanitize(window.title) : ""),
                        "bounds": Self.rect(window.bounds), "minimized": .bool(window.minimized), "onScreen": .bool(window.onScreen)])
                }
                return .object(["identity": app.identity.wire, "active": .bool(app.active), "windows": .array(windows)])
            }
            return ServerReply(fields: ["apps": .array(values)])
        }
    }

    func cursor(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        read(context, completion) {
            guard args.isEmpty else { throw Self.invalid }
            guard let cursor = self.backend.cursor else { throw Self.failure("unsupported_action", "Native cursor observation is unavailable.") }
            let observed = try cursor()
            guard observed.point.x.isFinite, observed.point.y.isFinite, Self.id(.string(observed.displayID)) != nil else { throw Self.unavailable }
            return ServerReply(fields: ["x": .number(observed.point.x), "y": .number(observed.point.y), "displayId": .string(observed.displayID)])
        }
    }

    func resolve(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        read(context, completion) {
            guard Set(args.keys) == ["path"], let path = Self.path(args["path"]) else { throw Self.invalid }
            guard let session = context.session else { throw Self.noSession }
            switch try self.backend.resolve(path) {
            case .protected(let reason): return Self.protectedResolution(reason)
            case .app(let app):
                try Self.validate(app)
                if let reason = try Self.protectedReason(app.identity, childShell: app.owner?.childShell) { return Self.protectedResolution(reason) }
                guard app.owner != nil || app.identity.verified else {
                    throw Self.failure("not_granted", "An unsigned application needs a prepared program launch.")
                }
                return ServerReply(fields: ["kind": .string("app"), "identity": app.identity.wire])
            case .program(let artifact):
                if let reason = try Self.protectedHandler(artifact) { return Self.protectedResolution(reason) }
                let prepared = try self.publish(context) { try self.registry.prepare(artifact: artifact, session: session) }
                return ServerReply(fields: ["kind": .string("program"), "program": prepared.wire])
            }
        }
    }

    func activate(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        mutate(args, context, completion) { session, policy in
            guard Set(args.keys).isSubset(of: ["identity", "sessionId", "phaseRevision"]),
                  let value = args["identity"], let requested = MacAppIdentity(wire: value) else { throw Self.invalid }
            let app = try self.find(requested, installed: false, running: true, session: session)
            try self.authorize(app, policy: policy)
            return .activate(app)
        }
    }

    func focus(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        mutate(args, context, completion) { session, policy in
            guard Set(args.keys).isSubset(of: ["windowId", "sessionId", "phaseRevision"]),
                  let windowID = Self.id(args["windowId"]) else { throw Self.invalid }
            let matching = try self.catalog(installed: false, session: session).flatMap { app in
                app.windows.filter { $0.windowID == windowID }.map { (app, $0) }
            }
            guard matching.count == 1, let (app, window) = matching.first, let owner = app.owner else {
                throw Self.failure("app_not_found", "The native window is unavailable.")
            }
            try policy.requireTarget(NativeTarget(owner: owner, windowID: window.windowID), operation: .activate,
                                     expected: NativeExpectedTarget(process: owner.process, windowID: window.windowID))
            return .focus(app, window)
        }
    }

    func launch(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        mutate(args, context, completion) { session, policy in
            guard Set(args.keys).isSubset(of: ["identity", "path", "sessionId", "phaseRevision"]),
                  (args["identity"] != nil) != (args["path"] != nil) else { throw Self.invalid }
            let requested: MacAppIdentity?
            let path: String
            if let value = args["identity"] {
                guard let identity = MacAppIdentity(wire: value) else { throw Self.invalid }
                guard identity.verified || identity.pid != nil else {
                    throw Self.failure("not_granted", "An unsigned application needs a fresh prepared program launch.")
                }
                requested = identity
                path = try self.find(identity, installed: true, running: false, session: session).bundlePath
            } else {
                guard let value = Self.path(args["path"]) else { throw Self.invalid }
                requested = nil; path = value
            }
            switch try self.backend.resolve(path) {
            case .protected: throw Self.failure("protected", "The launch target is protected.")
            case .program: throw Self.failure("not_granted", "This program needs a fresh prepared launch approval.")
            case .app(let app):
                try Self.validate(app)
                if let requested, !Self.matches(requested, app) { throw Self.changed }
                try self.authorize(app, policy: policy)
                return .launch(app)
            }
        }
    }

    func launchProgram(_ args: [String: JSONValue], context: OperationContext, completion: @escaping Dispatcher.Completion) {
        mutate(args, context, completion) { session, policy in
            guard Set(args.keys).isSubset(of: ["token", "binding", "sessionId", "phaseRevision"]),
                  let token = Self.id(args["token"]), let binding = args["binding"]?.stringValue else { throw Self.invalid }
            // Consumption precedes all subsequent resolution and launch checks; failed attempts cannot replay it.
            let prepared = try self.publish(context) { try self.registry.consume(token: token, binding: binding, session: session) }
            switch try self.backend.resolve(prepared.path) {
            case .protected: throw Self.failure("protected", "The launch route is protected.")
            case .app: throw Self.changed
            case .program(let current):
                guard ProgramArtifactHash.same(current, prepared) else { throw Self.changed }
                if try Self.protectedHandler(current) != nil { throw Self.failure("protected", "The launch handler is protected.") }
                return .program(current)
            }
        }
    }

    private func read(_ context: OperationContext, _ completion: @escaping Dispatcher.Completion,
                      _ body: @escaping () throws -> ServerReply) {
        let reply = AppsReply(completion)
        execute {
            do {
                try self.requireCurrent(context)
                let result = try body()
                try self.requireCurrent(context)
                reply.send(.success(result))
            } catch { reply.send(.failure(Self.failure(error))) }
        }
    }

    private func mutate(_ args: [String: JSONValue], _ context: OperationContext, _ completion: @escaping Dispatcher.Completion,
                        _ prepare: @escaping (ServerSession, SessionPolicy) throws -> Action) {
        let reply = AppsReply(completion)
        execute {
            do {
                try self.requireCurrent(context)
                guard let session = context.session else { throw Self.noSession }
                guard Self.validPhase(args, session) else { throw Self.changed }
                guard !session.paused else { throw Self.failure("paused", "The computer session is paused.") }
                let action = try prepare(session, SessionPolicy(session: session))
                guard session.mode == "foreground" else { throw Self.failure("needs_foreground", "Opening or focusing this app needs the foreground.") }
                try self.requireCurrent(context)
                let initiation = self.initiationContext(context)
                let done: AppsBackend.Completion = { result in
                    do {
                        try self.requireCurrent(context)
                        let confirmed = try result.get()
                        if case .program = action {
                            guard confirmed else { throw Self.failure("failed", "The program launch was not confirmed.") }
                            reply.send(.success(ServerReply(fields: ["launched": .bool(true)])))
                        } else { reply.send(.success(ServerReply(fields: ["foreground": .bool(confirmed)]))) }
                    } catch { reply.send(.failure(Self.failure(error))) }
                }
                // The backend owns the asynchronous main-thread initiation fence, never a blocking foreground wait.
                switch action {
                case .activate(let app): self.backend.activate(app, initiation, done)
                case .focus(let app, let window): self.backend.focus(app, window, initiation, done)
                case .launch(let app): self.backend.launchApp(app, initiation, done)
                case .program(let artifact): self.backend.launchProgram(artifact, initiation, done)
                }
            } catch { reply.send(.failure(Self.failure(error))) }
        }
    }

    private func authorize(_ app: AppsApplication, policy: SessionPolicy) throws {
        try Self.validate(app)
        if let owner = app.owner {
            try policy.requireTarget(NativeTarget(owner: owner), operation: .activate,
                                     expected: NativeExpectedTarget(process: owner.process))
        } else { try policy.requireLaunchIdentity(app.identity) }
    }

    private func find(_ identity: MacAppIdentity, installed: Bool, running: Bool, session: ServerSession) throws -> AppsApplication {
        let matches = try catalog(installed: installed, session: session).filter { (!running || $0.owner != nil) && Self.matches(identity, $0) }
        guard matches.count == 1, let app = matches.first else { throw Self.failure("app_not_found", "The native app could not be identified uniquely.") }
        return app
    }

    private func catalog(installed: Bool, session: ServerSession?) throws -> [AppsApplication] {
        let apps = try backend.list(installed, session)
        guard apps.count <= 4096, apps.reduce(0, { $0 + $1.windows.count }) <= 4096 else { throw Self.unavailable }
        var windows = Set<String>()
        for app in apps {
            try Self.validate(app)
            for window in app.windows { guard windows.insert(window.windowID).inserted else { throw Self.unavailable } }
        }
        return apps
    }

    private static func validate(_ app: AppsApplication) throws {
        guard MacAppIdentity(wire: app.identity.wire) != nil, MacAppIdentity.canonicalPathShape(app.bundlePath),
              app.windows.count <= 4096 else { throw unavailable }
        if let owner = app.owner {
            guard owner.identity == app.identity, owner.process.pid > 0, owner.process.parentPID > 0,
                  app.identity.pid == Int(owner.process.pid), app.identity.path == owner.process.executable,
                  MacAppIdentity.canonicalPathShape(owner.process.executable) else { throw unavailable }
        } else {
            guard app.windows.isEmpty, !app.active, app.identity.pid == nil else { throw unavailable }
        }
        guard app.windows.allSatisfy({ Self.id(.string($0.windowID)) != nil && CapturePrivacy.valid($0.bounds) && $0.title.utf16.count <= 65536 }) else { throw unavailable }
    }

    private static func matches(_ expected: MacAppIdentity, _ actual: AppsApplication) -> Bool {
        let identity = actual.identity
        guard expected.key == identity.key, expected.verified == identity.verified, expected.apple == identity.apple,
              expected.system == identity.system, expected.teamId == identity.teamId else { return false }
        if let pid = expected.pid, actual.owner?.process.pid != pid_t(pid) { return false }
        if let path = expected.path, path != identity.path && path != actual.bundlePath { return false }
        return identity.verified || (expected.pid != nil && expected.path != nil && actual.owner != nil)
    }

    private static func protectedHandler(_ artifact: NativeProgramArtifact) throws -> String? {
        if artifact.route == .document {
            guard let handler = artifact.handler, handler.verified, let path = artifact.handlerPath,
                  MacAppIdentity.canonicalPathShape(path) else { throw unavailable }
        }
        if let handler = artifact.handler {
            guard MacAppIdentity(wire: handler.wire) != nil, handler.verified, handler.apple || handler.teamId != nil else { throw unavailable }
            return try protectedReason(handler, childShell: nil)
        }
        guard artifact.handlerPath == nil else { throw unavailable }
        return nil
    }

    private static func protectedReason(_ identity: MacAppIdentity, childShell: Bool?) throws -> String? {
        let blocklist = try NativeBlocklist.generated()
        let category = blocklist.category(identity, childShell: childShell == true)
        guard blocklist.never.contains(category) || category == "system-ui" else { return nil }
        switch category {
        case "vector": return "vector"
        case "terminal", "scripting": return "terminal"
        case "password-manager": return "passwords"
        case "remote-viewer": return "remote"
        default: return "security"
        }
    }

    private func publish<T>(_ context: OperationContext, _ body: () throws -> T) throws -> T {
        var result: Result<T, Error>?
        guard context.withCurrent({ result = Result(catching: body) }), let result else { throw Self.changed }
        return try result.get()
    }
    private func initiationContext(_ context: OperationContext) -> OperationContext {
        OperationContext(session: context.session, isCurrent: {
            (try? self.requireCurrent(context)) != nil
        }, withCurrent: { body in
            var admitted = false
            guard context.withCurrent({
                self.lock.lock(); defer { self.lock.unlock() }
                guard !self.closed else { return }
                admitted = true
                body()
            }) else { return false }
            return admitted
        })
    }
    private func requireCurrent(_ context: OperationContext) throws {
        guard context.isCurrent() else { throw Self.changed }
        lock.lock(); defer { lock.unlock() }
        if closed { throw Self.changed }
    }
    private static func validPhase(_ args: [String: JSONValue], _ session: ServerSession) -> Bool {
        if let revision = session.revision { return args["sessionId"]?.stringValue == session.id && args["phaseRevision"]?.intValue == revision }
        return (args["sessionId"] == nil || args["sessionId"]?.stringValue == session.id) &&
            (args["phaseRevision"] == nil || args["phaseRevision"]?.intValue.map({ $0 >= 0 }) == true)
    }
    private static func id(_ value: JSONValue?) -> String? {
        guard let value = value?.stringValue, !value.isEmpty, value.utf16.count <= 256, !value.contains("\0") else { return nil }; return value
    }
    private static func path(_ value: JSONValue?) -> String? {
        guard let value = value?.stringValue, MacAppIdentity.canonicalPathShape(value) else { return nil }; return value
    }
    private static func rect(_ value: CGRect) -> JSONValue {
        .object(["x": .number(value.minX), "y": .number(value.minY), "w": .number(value.width), "h": .number(value.height)])
    }
    private static func protectedResolution(_ reason: String) -> ServerReply {
        let known: Set<String> = ["vector", "terminal", "passwords", "security", "remote"]
        return ServerReply(fields: ["kind": .string("protected"), "reason": .string(known.contains(reason) ? reason : "security")])
    }
    private static func failure(_ error: Error) -> ServerFailure { (error as? ServerFailure) ?? unavailable }
    private static func failure(_ code: String, _ message: String) -> ServerFailure { ServerFailure(code: code, message: message) }
    private static var invalid: ServerFailure { failure("failed", "The app operation arguments are invalid.") }
    private static var unavailable: ServerFailure { failure("unavailable", "The native app or launch facts could not be verified.") }
    private static var changed: ServerFailure { failure("changed", "The native app operation is no longer current.") }
    private static var noSession: ServerFailure { failure("unavailable", "No computer session is active.") }
}
