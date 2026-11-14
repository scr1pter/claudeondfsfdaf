import Dispatch
import Foundation

private struct ProgramRegistryTestFailure: Error { let message: String }

private func programRegistryCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw ProgramRegistryTestFailure(message: message) }
}

private func programRegistryRefusal(_ code: String, _ body: () throws -> Void) throws {
    do { try body() }
    catch let error as ServerFailure {
        try programRegistryCheck(error.code == code, "Expected the bounded program refusal category")
        return
    }
    throw ProgramRegistryTestFailure(message: "Expected the program capability to be refused")
}

private func programRegistrySession(_ id: String = "synthetic-program") -> ServerSession {
    ServerSession(id: id, revision: 1, mode: "foreground", paused: false, approved: [],
        vectorPids: [900], vectorWindowIds: [], overlayWindowIds: [], escStops: true, stopChord: "Command+Shift+Escape")
}

private func programRegistryArtifact(path: String = "/virtual/fixture", name: String = "Fixture",
                                     binding: String = String(repeating: "a", count: 64),
                                     route: NativeProgramRoute = .executable,
                                     handler: MacAppIdentity? = nil, handlerPath: String? = nil) -> NativeProgramArtifact {
    NativeProgramArtifact(path: path, name: name, binding: binding, route: route, handler: handler, handlerPath: handlerPath)
}

private func programRegistryHandler(_ bundle: String = "example.viewer", name: String = "Viewer",
                                    path: String = "/virtual/Viewer.app/Contents/MacOS/Viewer") -> MacAppIdentity {
    MacAppIdentity(bundleId: bundle, teamId: "ABCDEFGHIJ", apple: false, system: false, verified: true,
                   name: name, path: path, pid: nil)
}

private final class ProgramRegistryRace {
    private let lock = NSLock()
    private(set) var successes = 0
    private(set) var failures = 0
    func record(_ success: Bool) {
        lock.lock(); defer { lock.unlock() }
        if success { successes += 1 } else { failures += 1 }
    }
}

/// In-memory artifact facts and monotonic clocks only: no file, process, app, launch or permission operation.
func runProgramLaunchRegistryTests() throws -> Int {
    var groups = 0
    func test(_ body: () throws -> Void) throws { try body(); groups += 1 }

    try test {
        try programRegistryCheck(ProgramArtifactHash.sha256(Data()) ==
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "Empty content has the standard SHA256")
        try programRegistryCheck(ProgramArtifactHash.sha256(Data("abc".utf8)) ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "Content hashing operates on exact bytes")
        let vectors: [(String, String)] = [
            ("/tmp/fixture", "2d3211db6344c42be7d0f10258c78bcfd6ef6e2bd00d1d6cc33d2754f43ad63f"),
            ("/Applications/Vector Test.app/Contents/MacOS/工具😀", "d149a1d781148898777364fec73020dd4b1479416da650b82f0115f1b05bc1fd"),
            ("/tmp/quote\" and back\\slash", "74a73be8f11904b146b2b7a131b27ec6ecce354b60bbd1cf7c58c3166916188e"),
            ("/tmp/line\nnext\tpart\u{0001}", "2377a13ae5d333d36cd48e471df652c757cd5fa4756aa8fd8bcece229b3e6899"),
            ("/tmp/é", "f435c8096356f20cc9e15fc7d7424fded256c0e2b655a18174d302ff20b4c12b"),
            ("/tmp/e\u{0301}", "a4c52b18ccbd88058170ee928403fc8ff6303ffba2c611561dba437ca4724d6e"),
            ("/tmp/sep\u{2028}next\u{2029}file", "d4a693507b7cbd1cb17e5d0a8fcdf46b36d08d510dde5a956e1d26d576a08d9b"),
        ]
        for (path, hash) in vectors {
            try programRegistryCheck(ProgramArtifactHash.key(path: path, binding: String(repeating: "a", count: 64)) == "program:macos:" + hash,
                "ProgramKey uses exact compact JSON.stringify UTF8, including slash, Unicode and control escaping")
        }
    }

    try test {
        let first: [JSONValue] = [.string("macos"), .string("/virtual/tool"), .object(["route": .string("executable"), "bytes": .string("first")])]
        let reordered: [JSONValue] = [.string("macos"), .string("/virtual/tool"), .object(["bytes": .string("first"), "route": .string("executable")])]
        try programRegistryCheck(try ProgramArtifactHash.binding(first) == ProgramArtifactHash.binding(reordered),
            "Private binding keys are deterministic despite dictionary insertion order")
        try programRegistryCheck(try ProgramArtifactHash.binding(first) != ProgramArtifactHash.binding([.string("macos"), .string("/virtual/tool"), .object(["bytes": .string("second"), "route": .string("executable")])]),
            "A content change alters the artifact binding")
        try programRegistryCheck(try ProgramArtifactHash.binding([.string("ab"), .string("c")]) != ProgramArtifactHash.binding([.string("a"), .string("bc")]),
            "Binding fields have unambiguous boundaries")
    }

    try test {
        let session = programRegistrySession()
        let handler = programRegistryHandler()
        let artifact = programRegistryArtifact(path: "/virtual/Document.txt", route: .document,
            handler: handler, handlerPath: "/virtual/Viewer.app")
        let registry = ProgramLaunchRegistry(now: { 1_000_000_000 })
        let prepared = try registry.prepare(artifact: artifact, session: session)
        try programRegistryCheck(prepared.artifact == artifact && prepared.key == ProgramArtifactHash.key(path: artifact.path, binding: artifact.binding),
            "Preparation retains native artifact facts without granting an app")
        try programRegistryCheck(!prepared.token.isEmpty && prepared.token.utf16.count <= 256 &&
            prepared.wire["token"] == .string(prepared.token) && prepared.wire["handler"] == handler.wire,
            "The helper-to-main envelope carries only its private opaque capability and actual handler")
        guard let visible = prepared.publicWire.objectValue else { throw ProgramRegistryTestFailure(message: "Expected public artifact metadata") }
        try programRegistryCheck(Set(visible.keys) == ["key", "platform", "path", "name", "binding"] &&
            visible["token"] == nil && visible["handler"] == nil && visible["approved"] == nil,
            "Engine-visible artifact identity has neither native capability, handler nor app grant")
        let consumed = try registry.consume(token: prepared.token, binding: artifact.binding, session: session)
        try programRegistryCheck(ProgramArtifactHash.same(consumed, artifact) && session.approved.isEmpty,
            "Consumption returns the exact fact for fresh native revalidation, never approval to observe its future process")
        try programRegistryRefusal("changed") { _ = try registry.consume(token: prepared.token, binding: artifact.binding, session: session) }
    }

    try test {
        let session = programRegistrySession()
        let artifact = programRegistryArtifact()
        for failure in 0..<4 {
            let registry = ProgramLaunchRegistry(now: { 1_000_000_000 })
            let prepared = try registry.prepare(artifact: artifact, session: session)
            var other = session
            var binding = artifact.binding
            if failure == 0 { binding = String(repeating: "b", count: 64) }
            if failure == 1 {
                other = programRegistrySession("different-session")
                other.observationEpoch = session.observationEpoch
            }
            if failure == 2 { other.observationEpoch = UUID() }
            if failure == 3 { other.revision = 2 }
            try programRegistryRefusal("changed") { _ = try registry.consume(token: prepared.token, binding: binding, session: other) }
            try programRegistryRefusal("changed") { _ = try registry.consume(token: prepared.token, binding: artifact.binding, session: session) }
        }
    }

    try test {
        var now: UInt64 = 1_000_000_000
        let registry = ProgramLaunchRegistry(now: { now })
        let artifact = programRegistryArtifact(), session = programRegistrySession()
        let first = try registry.prepare(artifact: artifact, session: session)
        now += 29_999_999_999
        _ = try registry.consume(token: first.token, binding: artifact.binding, session: session)
        let boundary = try registry.prepare(artifact: artifact, session: session)
        now += 30_000_000_000
        try programRegistryRefusal("changed") { _ = try registry.consume(token: boundary.token, binding: artifact.binding, session: session) }
        let capped = ProgramLaunchRegistry(ttlMs: 60000, now: { now })
        let token = try capped.prepare(artifact: artifact, session: session)
        now += 30_000_000_000
        try programRegistryRefusal("changed") { _ = try capped.consume(token: token.token, binding: artifact.binding, session: session) }
    }

    try test {
        var now: UInt64 = 0
        let registry = ProgramLaunchRegistry(limit: 2, ttlMs: 1, now: { now })
        let artifact = programRegistryArtifact(), session = programRegistrySession()
        let first = try registry.prepare(artifact: artifact, session: session)
        _ = try registry.prepare(artifact: artifact, session: session)
        try programRegistryRefusal("busy") { _ = try registry.prepare(artifact: artifact, session: session) }
        _ = try registry.consume(token: first.token, binding: artifact.binding, session: session)
        let successor = try registry.prepare(artifact: artifact, session: session)
        try programRegistryCheck(successor.token != first.token, "Capacity recovery never reuses a consumed opaque token")
        now = 1_000_000
        _ = try registry.prepare(artifact: artifact, session: session)
        try programRegistryRefusal("changed") { _ = try registry.consume(token: successor.token, binding: artifact.binding, session: session) }
    }

    try test {
        let registry = ProgramLaunchRegistry(limit: Int.max, now: { 0 })
        let artifact = programRegistryArtifact(), session = programRegistrySession()
        for _ in 0..<1000 { _ = try registry.prepare(artifact: artifact, session: session) }
        try programRegistryRefusal("busy") { _ = try registry.prepare(artifact: artifact, session: session) }
    }

    try test {
        var now: UInt64 = 1_000_000_000
        let registry = ProgramLaunchRegistry(now: { now })
        let artifact = programRegistryArtifact(), session = programRegistrySession()
        let old = try registry.prepare(artifact: artifact, session: session)
        now = 2_000_000_000
        let other = try registry.prepare(artifact: artifact, session: session)
        now = 1_500_000_000
        try programRegistryRefusal("changed") { _ = try registry.consume(token: old.token, binding: artifact.binding, session: session) }
        try programRegistryRefusal("changed") { _ = try registry.consume(token: other.token, binding: artifact.binding, session: session) }
        let fresh = try registry.prepare(artifact: artifact, session: session)
        _ = try registry.consume(token: fresh.token, binding: artifact.binding, session: session)
        registry.clear()
        let pending = try registry.prepare(artifact: artifact, session: session)
        registry.clear()
        try programRegistryRefusal("changed") { _ = try registry.consume(token: pending.token, binding: artifact.binding, session: session) }
        registry.close(); registry.close()
        try programRegistryRefusal("changed") { _ = try registry.prepare(artifact: artifact, session: session) }
        let overflow = ProgramLaunchRegistry(now: { UInt64.max - 1 })
        try programRegistryRefusal("changed") { _ = try overflow.prepare(artifact: artifact, session: session) }
    }

    try test {
        let invalid = [
            programRegistryArtifact(path: "relative/tool"), programRegistryArtifact(path: "/virtual/../tool"),
            programRegistryArtifact(path: "/virtual/tool\0other"), programRegistryArtifact(path: "/" + String(repeating: "x", count: 4096)),
            programRegistryArtifact(name: ""), programRegistryArtifact(name: "  Fixture"), programRegistryArtifact(name: "Fixture  Tool"),
            programRegistryArtifact(name: "Fixture\u{202e}Tool"), programRegistryArtifact(name: String(repeating: "x", count: 257)),
            programRegistryArtifact(binding: String(repeating: "A", count: 64)), programRegistryArtifact(binding: String(repeating: "a", count: 63)),
            programRegistryArtifact(route: .document),
            programRegistryArtifact(route: .document, handler: programRegistryHandler(), handlerPath: "relative.app"),
            programRegistryArtifact(handler: programRegistryHandler(), handlerPath: "/virtual/Viewer.app"),
        ]
        let registry = ProgramLaunchRegistry(now: { 0 }), session = programRegistrySession()
        for artifact in invalid { try programRegistryRefusal("failed") { _ = try registry.prepare(artifact: artifact, session: session) } }
        _ = try registry.prepare(artifact: programRegistryArtifact(route: .application), session: session)
    }

    try test {
        let nfc = programRegistryArtifact(path: "/virtual/é", name: "é")
        let nfd = programRegistryArtifact(path: "/virtual/e\u{0301}", name: "e\u{0301}")
        try programRegistryCheck(nfc == nfd && !ProgramArtifactHash.same(nfc, nfd) &&
            ProgramArtifactHash.key(path: nfc.path, binding: nfc.binding) != ProgramArtifactHash.key(path: nfd.path, binding: nfd.binding),
            "Swift canonical Unicode equality cannot replace JavaScript's exact artifact identity")
        let handler = programRegistryHandler()
        let first = programRegistryArtifact(route: .document, handler: handler, handlerPath: "/virtual/Viewer.app")
        let changes = [
            programRegistryArtifact(route: .document, handler: programRegistryHandler("example.other"), handlerPath: "/virtual/Viewer.app"),
            programRegistryArtifact(route: .document, handler: handler, handlerPath: "/virtual/Other.app"),
            programRegistryArtifact(binding: String(repeating: "b", count: 64), route: .document, handler: handler, handlerPath: "/virtual/Viewer.app"),
        ]
        try programRegistryCheck(ProgramArtifactHash.same(first, first) && changes.allSatisfy { !ProgramArtifactHash.same(first, $0) },
            "Fresh content, exact handler identity and canonical handler route must all match")
    }

    try test {
        let first = programRegistrySession("session-é")
        var second = programRegistrySession("session-e\u{0301}")
        second.observationEpoch = first.observationEpoch
        let registry = ProgramLaunchRegistry(now: { 0 }), artifact = programRegistryArtifact()
        let token = try registry.prepare(artifact: artifact, session: first)
        try programRegistryRefusal("changed") { _ = try registry.consume(token: token.token, binding: artifact.binding, session: second) }
    }

    try test {
        let registry = ProgramLaunchRegistry(now: { 0 }), session = programRegistrySession(), artifact = programRegistryArtifact()
        let prepared = try registry.prepare(artifact: artifact, session: session)
        let race = ProgramRegistryRace()
        DispatchQueue.concurrentPerform(iterations: 16) { _ in
            do { _ = try registry.consume(token: prepared.token, binding: artifact.binding, session: session); race.record(true) }
            catch { race.record(false) }
        }
        try programRegistryCheck(race.successes == 1 && race.failures == 15, "Concurrent callers can consume one native capability only once")
    }
    return groups
}
