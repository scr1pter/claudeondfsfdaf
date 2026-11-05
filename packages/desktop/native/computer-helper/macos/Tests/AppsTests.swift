import CoreGraphics
import Darwin
import Foundation

private struct AppsTestFailure: Error { let message: String }

private func appsCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw AppsTestFailure(message: message) }
}

private func appsIdentity(_ bundle: String = "example.apps.fixture", pid: Int? = 101,
                          verified: Bool = true, team: String? = "ABCDEFGHIJ", name: String = "Fixture App",
                          path: String = "/virtual/Fixture.app/Contents/MacOS/Fixture") -> MacAppIdentity {
    MacAppIdentity(bundleId: bundle, teamId: team, apple: false, system: false, verified: verified,
                   name: name, path: path, pid: pid)
}

private func appsOwner(_ identity: MacAppIdentity = appsIdentity(), start: UInt64 = 10) -> NativeOwner {
    NativeOwner(identity: identity,
        process: HelperProcessIdentity(pid: pid_t(identity.pid ?? 101), parentPID: 1, startSeconds: start,
            startMicroseconds: 20, executable: identity.path ?? "/virtual/Fixture.app/Contents/MacOS/Fixture"), childShell: false)
}

private func appsRunning(_ owner: NativeOwner = appsOwner(), active: Bool = true,
                         windows: [AppsWindow]? = nil) -> AppsApplication {
    let bundle = URL(fileURLWithPath: owner.process.executable).deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().path
    return AppsApplication(identity: owner.identity, bundlePath: bundle, owner: owner, active: active,
        windows: windows ?? [AppsWindow(windowID: String(Int(owner.process.pid) * 10), title: "Fixture document", bounds: CGRect(x: -100, y: 0, width: 300, height: 200),
                                       minimized: false, onScreen: true)])
}

private func appsClosed(verified: Bool = true) -> AppsApplication {
    AppsApplication(identity: appsIdentity("example.apps.closed", pid: nil, verified: verified,
        team: verified ? "KLMNOPQRST" : nil, name: "Closed Fixture",
        path: "/virtual/Closed.app/Contents/MacOS/Closed"), bundlePath: "/virtual/Closed.app")
}

private func appsArtifact(_ binding: Character = "a", route: NativeProgramRoute = .document) -> NativeProgramArtifact {
    let path = route == .application ? "/virtual/Closed.app" : route == .executable ? "/virtual/FixtureTool" : "/virtual/Documents/Fixture.asset"
    return NativeProgramArtifact(path: path, name: "Fixture artifact", binding: String(repeating: String(binding), count: 64),
        route: route, handler: route == .document ? appsIdentity("example.apps.viewer", pid: nil, team: "KLMNOPQRST", name: "Fixture Viewer",
            path: "/virtual/Viewer.app/Contents/MacOS/Viewer") : nil, handlerPath: route == .document ? "/virtual/Viewer.app" : nil)
}

private struct AppsTestMutation {
    let kind: String
    let app: AppsApplication?
    let window: AppsWindow?
    let artifact: NativeProgramArtifact?
    let insideFence: Bool
}

private final class AppsTestState {
    var epoch = 1
    var clock: UInt64 = 1_000_000_000
    var insideFence = false
    var refuseFence = false
    var holdWork = false
    var work: [() -> Void] = []
    var holdInitiation = false
    var initiations: [() -> Void] = []
    var holdConfirmation = false
    var confirmations: [() -> Void] = []
    var confirmation: Result<Bool, ServerFailure> = .success(true)
    var listRequests: [Bool] = []
    var listEpochs: [UUID?] = []
    var resolvePaths: [String] = []
    var apps: [AppsApplication] = [appsRunning(), appsClosed()]
    var resolutions: [String: AppsResolution] = [:]
    var mutations: [AppsTestMutation] = []
    var results: [Result<ServerReply, ServerFailure>] = []
    var onList: (() -> Void)?
    var onResolve: ((String) -> Void)?
    var onInitiate: (() -> Void)?
    var cursor = AppsCursor(point: CGPoint(x: -20.5, y: 10.25), displayID: "2")
    var cursorReads = 0
    var cursorFailure: ServerFailure?

    init() {
        resolutions[apps[0].bundlePath] = .app(apps[0])
        resolutions[apps[0].identity.path!] = .app(apps[0])
        resolutions[apps[1].bundlePath] = .app(apps[1])
        resolutions[apps[1].identity.path!] = .app(apps[1])
        let artifact = appsArtifact()
        resolutions[artifact.path] = .program(artifact)
    }

    func mutate(_ kind: String, app: AppsApplication? = nil, window: AppsWindow? = nil,
                artifact: NativeProgramArtifact? = nil, context: OperationContext, completion: @escaping AppsBackend.Completion) {
        let initiate = {
            guard context.withCurrent({
                self.mutations.append(AppsTestMutation(kind: kind, app: app, window: window, artifact: artifact, insideFence: self.insideFence))
                self.onInitiate?()
            }) else { completion(.failure(ServerFailure(code: "changed", message: "The synthetic native initiation is no longer current."))); return }
            let confirm = { completion(self.confirmation) }
            if self.holdConfirmation { self.confirmations.append(confirm) } else { confirm() }
        }
        if holdInitiation { initiations.append(initiate) } else { initiate() }
    }

    func drain() { while !work.isEmpty { work.removeFirst()() } }
    func initiateAll() { while !initiations.isEmpty { initiations.removeFirst()() } }
    func confirmAll() { while !confirmations.isEmpty { confirmations.removeFirst()() } }
}

private final class AppsFixture {
    let state: AppsTestState
    let registry: ProgramLaunchRegistry
    var session: ServerSession
    let service: AppsService

    init(approved: Bool = true, paused: Bool = false, mode: String = "foreground", cursor: Bool = true) {
        let state = AppsTestState()
        let registry = ProgramLaunchRegistry(now: { state.clock })
        self.state = state; self.registry = registry
        self.session = ServerSession(id: "synthetic-apps", revision: 1, mode: mode, paused: paused,
            approved: approved ? [state.apps[0].identity.wire, state.apps[1].identity.wire] : [],
            vectorPids: [900], vectorWindowIds: ["9000"], overlayWindowIds: ["9001"],
            escStops: true, stopChord: "Command+Shift+Escape")
        self.service = AppsService(backend: AppsBackend(
            list: { installed, session in
                state.listRequests.append(installed); state.onList?()
                state.listEpochs.append(session?.observationEpoch)
                return state.apps.filter { installed || $0.owner != nil }
            },
            resolve: { path in
                state.resolvePaths.append(path); state.onResolve?(path)
                guard let result = state.resolutions[path] else { throw ServerFailure(code: "app_not_found", message: "No synthetic artifact.") }
                return result
            },
            activate: { app, context, done in state.mutate("activate", app: app, context: context, completion: done) },
            focus: { app, window, context, done in state.mutate("focus", app: app, window: window, context: context, completion: done) },
            launchApp: { app, context, done in state.mutate("app", app: app, context: context, completion: done) },
            launchProgram: { artifact, context, done in state.mutate("program", artifact: artifact, context: context, completion: done) },
            cursor: cursor ? { () throws -> AppsCursor in
                state.cursorReads += 1
                if let failure = state.cursorFailure { throw failure }
                return state.cursor
            } : nil
        ), registry: registry, execute: { work in if state.holdWork { state.work.append(work) } else { work() } })
    }

    func context(session includeSession: Bool = true) -> OperationContext {
        let state = state
        let epoch = state.epoch
        return OperationContext(session: includeSession ? session : nil, isCurrent: { state.epoch == epoch }, withCurrent: { body in
            guard state.epoch == epoch, !state.refuseFence else { return false }
            let previous = state.insideFence; state.insideFence = true
            defer { state.insideFence = previous }
            body(); return true
        })
    }

    func phase() -> [String: JSONValue] { ["sessionId": .string(session.id), "phaseRevision": .integer(Int64(session.revision ?? 0))] }
    func identityArgs(_ identity: MacAppIdentity? = nil) -> [String: JSONValue] {
        var args = phase(); args["identity"] = (identity ?? state.apps[0].identity).wire; return args
    }
    func pathArgs(_ path: String) -> [String: JSONValue] { var args = phase(); args["path"] = .string(path); return args }

    func call(_ operation: String, _ args: [String: JSONValue] = [:], context: OperationContext? = nil) {
        let done: Dispatcher.Completion = { self.state.results.append($0) }
        let context = context ?? self.context()
        switch operation {
        case "apps.list": service.list(args, context: context, completion: done)
        case "apps.resolve": service.resolve(args, context: context, completion: done)
        case "app.activate": service.activate(args, context: context, completion: done)
        case "app.launch": service.launch(args, context: context, completion: done)
        case "window.focus": service.focus(args, context: context, completion: done)
        case "program.launch": service.launchProgram(args, context: context, completion: done)
        case "cursor.position": service.cursor(args, context: context, completion: done)
        default: state.results.append(.failure(ServerFailure(code: "failed", message: "Unknown synthetic operation.")))
        }
    }

    func success(_ index: Int? = nil) throws -> [String: JSONValue] {
        let index = index ?? state.results.count - 1
        guard index >= 0, index < state.results.count, case .success(let reply) = state.results[index] else {
            throw AppsTestFailure(message: "Expected a successful synthetic app result")
        }
        return reply.fields
    }

    func failure(_ index: Int? = nil) -> String? {
        let index = index ?? state.results.count - 1
        guard index >= 0, index < state.results.count, case .failure(let error) = state.results[index] else { return nil }
        return error.code
    }

    func prepare(_ artifact: NativeProgramArtifact = appsArtifact()) throws -> [String: JSONValue] {
        state.resolutions[artifact.path] = .program(artifact)
        call("apps.resolve", ["path": .string(artifact.path)])
        guard let program = try success()["program"]?.objectValue else { throw AppsTestFailure(message: "Program route omitted its prepared descriptor") }
        return program
    }

    func launchArgs(_ program: [String: JSONValue]) -> [String: JSONValue] {
        var args = phase(); args["token"] = program["token"]; args["binding"] = program["binding"]; return args
    }
}

/// Application catalogs, signatures, canonical artifacts, clocks and asynchronous OS callbacks are injected.
/// These tests create no files/processes, inspect no installed apps or desktop, and invoke no native launch API.
func runAppsTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let fake = AppsFixture()
        for feature in ["apps.list", "apps.open", "apps.resolve", "program.launch"] {
            try appsCheck(fake.service.features()[feature] == true, "Implemented app/launch feature groups are advertised")
        }
        try appsCheck(fake.state.listRequests.isEmpty && fake.state.resolvePaths.isEmpty && fake.state.mutations.isEmpty,
                      "Service construction and feature reporting neither discover nor launch apps")
    }

    try test {
        let fake = AppsFixture()
        fake.call("apps.list", context: fake.context(session: false))
        let apps = try fake.success()["apps"]?.arrayValue ?? []
        try appsCheck(apps.count == 1 && apps[0]["identity"]?["name"] == .string("Fixture App") &&
                      apps[0]["windows"]?.arrayValue?.first?["title"] == .string(""),
                      "Sessionless app selection exposes native identities and window structure without private titles")
        try appsCheck(fake.state.listRequests == [false] && fake.state.resolvePaths.isEmpty && fake.state.mutations.isEmpty,
                      "Sessionless listing uses only its read-only running-app catalog adapter")
        try appsCheck(fake.state.listEpochs.count == 1 && fake.state.listEpochs[0] == nil,
                      "The native list adapter receives no fabricated session authority for app selection")
    }

    try test {
        let fake = AppsFixture(approved: false)
        fake.call("apps.list")
        let pending = try fake.success()["apps"]?.arrayValue?.first
        try appsCheck(pending?["windows"]?.arrayValue?.first?["title"] == .string(""),
                      "An ordinary unapproved app cannot reveal its window title through catalog listing")
        fake.session.approved = [fake.state.apps[0].identity.wire]
        fake.call("apps.list")
        let approved = try fake.success()["apps"]?.arrayValue?.first
        try appsCheck(approved?["windows"]?.arrayValue?.first?["title"] == .string("Fixture document"),
                      "Only current approved ordinary app content discloses its native title")
    }

    try test {
        let fake = AppsFixture()
        let terminal = appsRunning(appsOwner(appsIdentity("com.apple.Terminal", pid: 202,
            path: "/virtual/Terminal.app/Contents/MacOS/Terminal")))
        fake.state.apps.append(terminal)
        fake.session.approved.append(terminal.identity.wire)
        fake.state.apps[0].windows = [
            AppsWindow(windowID: "1010", title: "A\0\u{202e}\u{200b}" + String(repeating: "b", count: 1200),
                       bounds: CGRect(x: -100, y: 0, width: 300, height: 200), minimized: false, onScreen: false)
        ]
        fake.call("apps.list")
        let apps = try fake.success()["apps"]?.arrayValue ?? []
        let ordinary = apps.first { $0["identity"]?["bundleId"] == .string("example.apps.fixture") }?["windows"]?.arrayValue?.first
        let title = ordinary?["title"]?.stringValue ?? ""
        try appsCheck(!title.isEmpty && title.utf16.count <= 1024 && !title.contains("\0") &&
                      !title.contains("\u{202e}") && !title.contains("\u{200b}"), "Catalog titles are sanitized and bounded as untrusted screen data")
        try appsCheck(ordinary?["minimized"] == .bool(false) && ordinary?["onScreen"] == .bool(false),
                      "An offscreen or occluded window is not fabricated as minimized")
        let protected = apps.first { $0["identity"]?["bundleId"] == .string("com.apple.Terminal") }
        try appsCheck(protected?["windows"]?.arrayValue?.first?["title"] == .string(""),
                      "Never-listed titles remain blank even if a malformed caller attempts to approve that app")
    }

    try test {
        let fake = AppsFixture()
        fake.call("apps.list", ["installed": .bool(true)], context: fake.context(session: false))
        let apps = try fake.success()["apps"]?.arrayValue ?? []
        let closed = apps.first { $0["identity"]?["bundleId"] == .string("example.apps.closed") }
        try appsCheck(fake.state.listRequests == [true] && closed?["identity"]?["pid"] == nil &&
                      closed?["active"] == .bool(false) && closed?["windows"] == .array([]),
                      "Installed closed apps retain their signature identity without invented running PID or windows")
    }

    try test {
        let fake = AppsFixture()
        fake.call("apps.resolve", ["path": .string("/virtual/Closed.app")])
        let signed = try fake.success()
        try appsCheck(signed["kind"] == .string("app") && signed["identity"]?["verified"] == .bool(true) &&
                      signed["identity"]?["pid"] == nil && signed["program"] == nil,
                      "A positively verified closed app resolves as an app without fabricating a process identity")
        fake.state.resolutions["/virtual/Closed.app"] = .program(appsArtifact("b", route: .application))
        fake.call("apps.resolve", ["path": .string("/virtual/Closed.app")])
        let unsigned = try fake.success()
        try appsCheck(unsigned["kind"] == .string("program") && unsigned["program"]?["token"]?.stringValue != nil &&
                      unsigned["identity"] == nil, "A closed unsigned app requires an artifact-bound program capability")
        guard let descriptor = unsigned["program"]?.objectValue else { throw AppsTestFailure(message: "Missing unsigned application descriptor") }
        fake.call("program.launch", fake.launchArgs(descriptor))
        try appsCheck(try fake.success()["launched"] == .bool(true) && fake.state.mutations.last?.artifact?.route == .application,
                      "Fresh unsigned application approval follows the sealed program route rather than an invented app grant")
    }

    try test {
        let fake = AppsFixture()
        let identity = appsIdentity(verified: false, team: nil)
        let running = appsRunning(appsOwner(identity))
        fake.state.apps[0] = running; fake.state.resolutions[running.bundlePath] = .app(running)
        fake.session.approved = [identity.wire]
        fake.call("apps.resolve", ["path": .string(running.bundlePath)])
        try appsCheck(try fake.success()["kind"] == .string("app"),
                      "A genuinely running unsigned app remains an observed app rather than an invented closed program")
        fake.call("app.activate", fake.identityArgs(identity))
        try appsCheck(try fake.success()["foreground"] == .bool(true) && fake.state.mutations.count == 1,
                      "Exact PID/path approval can activate an unverified running process")
    }

    try test {
        let fake = AppsFixture(approved: false)
        let program = try fake.prepare()
        try appsCheck(program["platform"] == .string("macos") && program["path"] == .string(appsArtifact().path) &&
                      program["binding"] == .string(appsArtifact().binding) && program["key"]?.stringValue?.hasPrefix("program:macos:") == true,
                      "Program preparation reports canonical artifact content identity instead of an app grant")
        try appsCheck(program["handler"] == appsArtifact().handler?.wire && program["handler"]?["pid"] == nil &&
                      program["token"]?.stringValue?.isEmpty == false && program["route"] == nil && program["handlerPath"] == nil,
                      "Only the private helper envelope carries the actual handler identity and one-use token")
        let approvals = fake.session.approved
        fake.call("program.launch", fake.launchArgs(program))
        try appsCheck(try fake.success()["launched"] == .bool(true) && fake.state.mutations.count == 1 &&
                      fake.state.mutations[0].artifact == appsArtifact() && fake.session.approved == approvals,
                      "Fresh program launch may invoke a sealed benign handler without granting future screen/input authority")
    }

    try test {
        let fake = AppsFixture()
        fake.state.resolutions["/virtual/protected.asset"] = .protected("terminal")
        fake.call("apps.resolve", ["path": .string("/virtual/protected.asset")])
        try appsCheck(try fake.success() == ["kind": .string("protected"), "reason": .string("terminal")] && fake.state.mutations.isEmpty,
                      "Protected launch routes remain truthful refusals with no token or launch side effect")
    }

    try test {
        let fake = AppsFixture()
        let program = try fake.prepare()
        fake.call("program.launch", fake.launchArgs(program))
        _ = try fake.success()
        fake.call("program.launch", fake.launchArgs(program))
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.count == 1,
                      "The app service consumes the real registry capability before launch and cannot replay it")
    }

    try test {
        let fake = AppsFixture()
        let program = try fake.prepare()
        fake.state.resolutions[appsArtifact().path] = .program(appsArtifact("b"))
        fake.call("program.launch", fake.launchArgs(program))
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty,
                      "Changed artifact content invalidates the prepared binding before native initiation")
        fake.state.resolutions[appsArtifact().path] = .program(appsArtifact())
        fake.call("program.launch", fake.launchArgs(program))
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty,
                      "A changed-content failure still burns its one-use capability")
    }

    try test {
        let fake = AppsFixture()
        let program = try fake.prepare()
        let replacement = NativeProgramArtifact(path: appsArtifact().path, name: appsArtifact().name,
            binding: appsArtifact().binding, route: .document,
            handler: appsIdentity("example.apps.replacement", pid: nil, team: "UVWXYZABCD", path: "/virtual/Replacement.app/Contents/MacOS/Replacement"),
            handlerPath: "/virtual/Replacement.app")
        fake.state.resolutions[replacement.path] = .program(replacement)
        fake.call("program.launch", fake.launchArgs(program))
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty,
                      "A handler identity/path change cannot hide behind an unchanged public artifact digest")
    }

    try test {
        for expire in [false, true] {
            let fake = AppsFixture()
            let program = try fake.prepare()
            if expire { fake.state.clock += 30_000_000_000 }
            else { fake.session.observationEpoch = UUID() }
            fake.call("program.launch", fake.launchArgs(program))
            try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty,
                          "Expired or successor-authority tokens never reach the native launch backend")
        }
    }

    try test {
        let fake = AppsFixture()
        let program = try fake.prepare()
        var wrong = fake.launchArgs(program); wrong["binding"] = .string(String(repeating: "b", count: 64))
        fake.call("program.launch", wrong)
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty, "Wrong binding proofs cannot launch an artifact")
        fake.call("program.launch", fake.launchArgs(program))
        try appsCheck(fake.failure() == "changed", "A failed binding attempt cannot leave a reusable native launch token")
    }

    try test {
        let fake = AppsFixture()
        let artifact = appsArtifact()
        fake.state.resolutions["/virtual/Alias.asset"] = .program(artifact)
        fake.call("apps.resolve", ["path": .string("/virtual/Alias.asset")])
        guard let program = try fake.success()["program"]?.objectValue else { throw AppsTestFailure(message: "Alias resolution omitted its program") }
        fake.call("program.launch", fake.launchArgs(program))
        _ = try fake.success()
        try appsCheck(fake.state.resolvePaths.last == artifact.path && fake.state.mutations[0].artifact?.path == artifact.path,
                      "Program revalidation and launch use the privately canonicalized path rather than the original alias")
    }

    try test {
        let fake = AppsFixture()
        fake.call("app.activate", fake.identityArgs())
        try appsCheck(try fake.success()["foreground"] == .bool(true) && fake.state.mutations.count == 1 &&
                      fake.state.mutations[0].kind == "activate" && fake.state.mutations[0].insideFence &&
                      fake.state.mutations[0].app?.owner?.process == fake.state.apps[0].owner?.process,
                      "Activation forwards the observed private process and initiates only inside current native authority")
        fake.state.confirmation = .success(false)
        fake.call("app.activate", fake.identityArgs())
        try appsCheck(try fake.success()["foreground"] == .bool(false),
                      "A failed actual foreground confirmation is never reported as foreground success")
    }

    try test {
        let fake = AppsFixture()
        fake.call("app.launch", fake.identityArgs(fake.state.apps[1].identity))
        try appsCheck(try fake.success()["foreground"] == .bool(true) && fake.state.mutations.count == 1 &&
                      fake.state.mutations[0].kind == "app" && fake.state.mutations[0].app?.owner == nil,
                      "A closed signed app launches through its verified identity without manufacturing a PID")
        let pending = AppsFixture(approved: false)
        pending.call("app.launch", pending.identityArgs(pending.state.apps[1].identity))
        try appsCheck(pending.failure() == "not_granted" && pending.state.mutations.isEmpty,
                      "A signed app identity does not itself create task approval")
    }

    try test {
        let fake = AppsFixture()
        let unsigned = appsClosed(verified: false)
        fake.state.apps[1] = unsigned
        fake.state.resolutions[unsigned.bundlePath] = .program(appsArtifact("b", route: .application))
        fake.call("app.launch", fake.pathArgs(unsigned.bundlePath))
        try appsCheck(fake.failure() == "not_granted" && fake.state.mutations.isEmpty,
                      "A path-based app launch cannot bypass the closed unsigned program approval route")
        fake.call("app.launch", fake.identityArgs(unsigned.identity))
        try appsCheck(fake.failure() == "not_granted" && fake.state.mutations.isEmpty,
                      "A closed unverified identity cannot substitute for a fresh sealed program capability")
    }

    try test {
        let fake = AppsFixture()
        var args = fake.phase(); args["windowId"] = .string("1010")
        fake.call("window.focus", args)
        try appsCheck(try fake.success()["foreground"] == .bool(true) && fake.state.mutations.count == 1 &&
                      fake.state.mutations[0].kind == "focus" && fake.state.mutations[0].window?.windowID == "1010",
                      "Window focus forwards the exact observed native window and private owner")
    }

    try test {
        for protected in [false, true] {
            let fake = AppsFixture(approved: false)
            if protected {
                fake.state.apps[0] = appsRunning(appsOwner(appsIdentity("com.apple.Terminal")))
                fake.session.approved = [fake.state.apps[0].identity.wire]
            }
            fake.call("app.activate", fake.identityArgs(fake.state.apps[0].identity))
            try appsCheck(fake.failure() == (protected ? "protected" : "not_granted") && fake.state.mutations.isEmpty,
                          "Running app activation enforces both the task approval and native never-list floors")
            var args = fake.phase(); args["windowId"] = .string("1010")
            fake.call("window.focus", args)
            try appsCheck(fake.failure() == (protected ? "protected" : "not_granted") && fake.state.mutations.isEmpty,
                          "An exact window ID cannot bypass its owner's native protection or task approval")
        }
    }

    try test {
        let fake = AppsFixture()
        let forged = appsIdentity(team: "ZZZZZZZZZZ", name: "Fixture App")
        fake.call("app.activate", fake.identityArgs(forged))
        try appsCheck(["changed", "not_granted", "app_not_found"].contains(fake.failure() ?? "") && fake.state.mutations.isEmpty,
                      "Matching display name or bundle key cannot replace the actual native signer identity")
    }

    try test {
        let paused = AppsFixture(paused: true)
        paused.call("app.activate", paused.identityArgs())
        try appsCheck(paused.failure() == "paused" && paused.state.mutations.isEmpty, "Paused native authority cannot activate an app")
        let background = AppsFixture(mode: "background")
        background.call("app.launch", background.identityArgs())
        try appsCheck(background.failure() == "needs_foreground" && background.state.mutations.isEmpty,
                      "A background session cannot launch/activate through an unimplemented foreground-taking path")
        let pending = AppsFixture(approved: false, mode: "background")
        pending.call("app.activate", pending.identityArgs())
        try appsCheck(pending.failure() == "not_granted" && pending.state.mutations.isEmpty,
                      "The foreground handoff cannot waive the native task-approval floor")
        let protected = AppsFixture(mode: "background")
        protected.state.apps[0] = appsRunning(appsOwner(appsIdentity("com.apple.Terminal")))
        protected.session.approved = [protected.state.apps[0].identity.wire]
        protected.call("app.activate", protected.identityArgs(protected.state.apps[0].identity))
        try appsCheck(protected.failure() == "protected" && protected.state.mutations.isEmpty,
                      "A never-listed background target is refused before any foreground ask")
    }

    try test {
        let fake = AppsFixture()
        fake.state.holdInitiation = true
        fake.call("app.activate", fake.identityArgs())
        fake.state.epoch += 1; fake.state.initiateAll(); fake.state.drain()
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty,
                      "Canceling after discovery but before AppKit initiation prevents the native mutation")
        let confirmation = AppsFixture()
        confirmation.state.holdConfirmation = true
        confirmation.call("app.activate", confirmation.identityArgs())
        confirmation.state.epoch += 1; confirmation.state.confirmAll(); confirmation.state.drain()
        try appsCheck(confirmation.failure() == "changed" && confirmation.state.mutations.count == 1,
                      "An already initiated action cannot publish a stale positive foreground reply after authority changes")
    }

    try test {
        let fake = AppsFixture()
        let program = try fake.prepare()
        fake.state.confirmation = .success(false)
        fake.call("program.launch", fake.launchArgs(program))
        try appsCheck(fake.failure() == "failed", "A failed native program initiation never claims launched:true")
        fake.call("program.launch", fake.launchArgs(program))
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.count == 1,
                      "Native failure still consumes its original one-use launch capability")
    }

    try test {
        let fake = AppsFixture(paused: true)
        fake.call("cursor.position")
        let cursor = try fake.success()
        try appsCheck(fake.service.features()["cursor.position"] == true && cursor == ["x": .number(-20.5), "y": .number(10.25), "displayId": .string("2")] &&
                      fake.state.cursorReads == 1, "Cursor inspection reports the actual injected negative-origin native position while input is paused")
        fake.state.cursorFailure = ServerFailure(code: "out_of_bounds", message: "The synthetic cursor is off every display.")
        fake.call("cursor.position")
        try appsCheck(fake.failure() == "out_of_bounds", "An off-display cursor never falls back to a guessed display center")
        let disabled = AppsFixture(cursor: false)
        disabled.call("cursor.position")
        try appsCheck(disabled.service.features()["cursor.position"] == false && disabled.failure() == "unsupported_action" && disabled.state.cursorReads == 0,
                      "Missing cursor capability is reported and refused without inventing a position")
    }

    try test {
        let fake = AppsFixture()
        let protected = NativeProgramArtifact(path: appsArtifact().path, name: "Protected handler fixture", binding: appsArtifact().binding,
            route: .document, handler: appsIdentity("com.apple.Terminal", pid: nil, path: "/virtual/Terminal.app/Contents/MacOS/Terminal"),
            handlerPath: "/virtual/Terminal.app")
        fake.state.resolutions[protected.path] = .program(protected)
        fake.call("apps.resolve", ["path": .string(protected.path)])
        let refused = try fake.success()
        try appsCheck(refused["kind"] == .string("protected") && refused["reason"] == .string("terminal") && refused["program"] == nil,
                      "A protected actual handler is refused even when the artifact route itself appears ordinary")
        let unsigned = NativeProgramArtifact(path: appsArtifact().path, name: "Unknown handler fixture", binding: appsArtifact().binding,
            route: .document, handler: appsIdentity("example.unsigned.handler", pid: nil, verified: false, team: nil,
                path: "/virtual/UnsignedHandler.app/Contents/MacOS/UnsignedHandler"), handlerPath: "/virtual/UnsignedHandler.app")
        fake.state.resolutions[unsigned.path] = .program(unsigned)
        fake.call("apps.resolve", ["path": .string(unsigned.path)])
        try appsCheck(fake.failure() == "unavailable" && fake.state.mutations.isEmpty,
                      "Unavailable verified handler evidence never becomes a launch capability")
    }

    try test {
        let fake = AppsFixture()
        let program = try fake.prepare()
        fake.state.resolutions[appsArtifact().path] = .app(fake.state.apps[0])
        fake.call("program.launch", fake.launchArgs(program))
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty,
                      "An app/program route change requires fresh preparation instead of reusing old artifact consent")
    }

    try test {
        let fake = AppsFixture()
        let malformed: [(String, [String: JSONValue])] = [
            ("apps.list", ["installed": .string("true")]), ("apps.list", ["path": .string("/virtual/Fixture.app")]),
            ("apps.resolve", [:]), ("apps.resolve", ["path": .string("relative.app")]),
            ("apps.resolve", ["path": .string("/virtual/a\0b")]),
            ("apps.resolve", ["path": .string("/" + String(repeating: "a", count: 4096))]),
            ("app.activate", fake.phase()), ("window.focus", fake.phase()),
            ("program.launch", fake.phase())
        ]
        for (operation, args) in malformed {
            fake.call(operation, args)
            try appsCheck(fake.failure() == "failed", "Malformed app operation arguments are refused before discovery or initiation")
        }
        var both = fake.identityArgs(); both["path"] = .string("/virtual/Fixture.app")
        fake.call("app.launch", both)
        try appsCheck(fake.failure() == "failed", "App launch requires exactly one identity or path target")
        var foreign = fake.identityArgs()
        foreign["identity"] = .object(["platform": .string("windows"), "kind": .string("aumid"), "aumid": .string("fixture")])
        fake.call("app.activate", foreign)
        try appsCheck(fake.failure() == "failed" && fake.state.mutations.isEmpty,
                      "A foreign-platform identity never crosses the native launch boundary")
        try appsCheck(fake.state.listRequests.isEmpty && fake.state.resolvePaths.isEmpty,
                      "Malformed requests cannot cause catalog scans or artifact reads")
    }

    try test {
        let fake = AppsFixture()
        let program = try fake.prepare()
        var bad = fake.identityArgs(); bad["phaseRevision"] = .integer(2)
        fake.call("app.activate", bad)
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty,
                      "App activation cannot borrow another phase's native authority")
        var wrongSession = fake.launchArgs(program); wrongSession["sessionId"] = .string("successor-session")
        fake.call("program.launch", wrongSession)
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty,
                      "Prepared program launch must still match its exact live session phase")
        let pending = AppsFixture()
        pending.state.holdWork = true
        pending.call("app.activate", pending.identityArgs())
        pending.state.epoch += 1; pending.state.drain()
        try appsCheck(pending.failure() == "changed" && pending.state.listRequests.isEmpty && pending.state.mutations.isEmpty,
                      "Revoked queued app operations cannot discover or initiate anything")
    }

    try test {
        let fake = AppsFixture()
        fake.state.onList = { fake.state.epoch += 1 }
        fake.call("apps.list")
        try appsCheck(fake.failure() == "changed", "A stale catalog reply cannot disclose titles after task authority changes")
        let resolved = AppsFixture()
        resolved.state.onResolve = { _ in resolved.state.epoch += 1 }
        resolved.call("apps.resolve", ["path": .string(appsArtifact().path)])
        try appsCheck(resolved.failure() == "changed" && resolved.state.mutations.isEmpty,
                      "Late artifact resolution cannot publish a prepared token after authority revocation")
    }

    try test {
        let fake = AppsFixture()
        fake.state.holdInitiation = true
        fake.call("app.activate", fake.identityArgs())
        fake.service.close(); fake.service.close()
        fake.state.initiateAll(); fake.state.drain()
        try appsCheck(fake.failure() == "changed" && fake.state.mutations.isEmpty,
                      "Closing the service alone cancels an already queued native initiation")
        let confirmation = AppsFixture()
        confirmation.state.holdConfirmation = true
        confirmation.call("app.activate", confirmation.identityArgs())
        confirmation.service.close(); confirmation.state.confirmAll(); confirmation.state.drain()
        try appsCheck(confirmation.failure() == "changed" && confirmation.state.mutations.count == 1,
                      "Closing after initiation suppresses a late foreground confirmation")
    }

    try test {
        let fake = AppsFixture()
        fake.state.holdConfirmation = true
        fake.call("app.activate", fake.identityArgs())
        guard let confirmation = fake.state.confirmations.first else { throw AppsTestFailure(message: "Missing synthetic pending native confirmation") }
        confirmation(); fake.state.confirmation = .success(false); confirmation(); fake.state.drain()
        try appsCheck(fake.state.results.count == 1 && (try fake.success()["foreground"]) == .bool(true),
                      "Repeated native callbacks produce only one helper reply for an app operation")
    }

    try test {
        let fake = AppsFixture()
        let other = appsRunning(appsOwner(appsIdentity("example.apps.other", pid: 202,
            path: "/virtual/Other.app/Contents/MacOS/Other")), windows: fake.state.apps[0].windows)
        fake.state.apps.append(other)
        fake.call("apps.list")
        try appsCheck(fake.failure() == "unavailable" && fake.state.mutations.isEmpty,
                      "Duplicate global native window IDs cannot be attributed to multiple app owners")
        let invalid = AppsFixture()
        invalid.state.apps[1].windows = invalid.state.apps[0].windows
        invalid.call("apps.list", ["installed": .bool(true)])
        try appsCheck(invalid.failure() == "unavailable", "A closed installed app cannot invent running window witnesses")
    }

    return count
}
