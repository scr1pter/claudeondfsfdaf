import CryptoKit
import Dispatch
import Foundation

enum ProgramArtifactHash {
    static func sha256(_ bytes: Data) -> String {
        let alphabet = Array("0123456789abcdef".utf8)
        let hex = SHA256.hash(data: bytes).flatMap { byte in [alphabet[Int(byte >> 4)], alphabet[Int(byte & 15)]] }
        return String(decoding: hex, as: UTF8.self)
    }

    /// Exact ComputerProgram.key bytes: JSON.stringify(["macos", canonicalPath, binding]), UTF-8, compact.
    /// JSONEncoder's optional slash/Unicode escaping is deliberately not part of this cross-runtime identity.
    static func key(path: String, binding: String) -> String {
        let json = "[\"macos\"," + quoted(path) + "," + quoted(binding) + "]"
        return "program:macos:" + sha256(Data(json.utf8))
    }

    /// Private artifact-content/route/handler binding format. It is re-created natively before launch.
    static func binding(_ fields: [JSONValue]) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return sha256(try encoder.encode(JSONValue.array(fields)))
    }

    /// Swift String equality folds canonical Unicode forms; JavaScript's artifact identity is byte-exact.
    static func same(_ first: NativeProgramArtifact, _ second: NativeProgramArtifact) -> Bool {
        guard exact(first.path, second.path), exact(first.name, second.name), exact(first.binding, second.binding),
              first.route == second.route, sameOptional(first.handlerPath, second.handlerPath) else { return false }
        switch (first.handler, second.handler) {
        case (nil, nil): return true
        case (let a?, let b?):
            return exact(a.bundleId, b.bundleId) && sameOptional(a.teamId, b.teamId) && a.apple == b.apple && a.system == b.system &&
                a.verified == b.verified && exact(a.name, b.name) && sameOptional(a.path, b.path) && a.pid == b.pid
        default: return false
        }
    }

    private static func exact(_ first: String, _ second: String) -> Bool { first.utf8.elementsEqual(second.utf8) }
    private static func sameOptional(_ first: String?, _ second: String?) -> Bool {
        switch (first, second) {
        case (nil, nil): return true
        case (let a?, let b?): return exact(a, b)
        default: return false
        }
    }

    private static func quoted(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x22: result += "\\\""
            case 0x5c: result += "\\\\"
            case 0x08: result += "\\b"
            case 0x09: result += "\\t"
            case 0x0a: result += "\\n"
            case 0x0c: result += "\\f"
            case 0x0d: result += "\\r"
            case 0..<0x20: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }
}

struct PreparedProgramLaunch {
    let artifact: NativeProgramArtifact
    let token: String
    let key: String

    private var publicFields: [String: JSONValue] {
        ["key": .string(key), "platform": .string("macos"), "path": .string(artifact.path),
         "name": .string(artifact.name), "binding": .string(artifact.binding)]
    }

    /// Public artifact identity carries neither a capability nor permission to observe a future app.
    var publicWire: JSONValue { .object(publicFields) }

    /// This helper-only envelope is consumed by desktop main; it must be stripped before engine/ask output.
    var wire: JSONValue {
        var fields = publicFields
        fields["token"] = .string(token)
        if let handler = artifact.handler { fields["handler"] = handler.wire }
        return .object(fields)
    }
}

/// Bounded native capabilities, not durable grants. Consumption precedes artifact re-resolution and launch.
final class ProgramLaunchRegistry {
    private struct Entry {
        let prepared: PreparedProgramLaunch
        let sessionID: String
        let observationEpoch: UUID
        let revision: Int?
        let created: UInt64
        let expires: UInt64
    }
    private let lock = NSLock()
    private let worker = UUID().uuidString.lowercased()
    private let limit: Int
    private let lifetime: UInt64
    private let now: () -> UInt64
    private var sequence: UInt64 = 0
    private var entries: [String: Entry] = [:]
    private var lastTime: UInt64?
    private var closed = false

    /// Clock values are monotonic nanoseconds. Production caps remain 1,000 live tokens and 30 seconds.
    init(limit: Int = 1000, ttlMs: Int = 30000, now: (() -> UInt64)? = nil) {
        self.limit = min(1000, max(1, limit))
        lifetime = UInt64(min(30000, max(1, ttlMs))) * 1_000_000
        self.now = now ?? { DispatchTime.now().uptimeNanoseconds }
    }

    func prepare(artifact: NativeProgramArtifact, session: ServerSession) throws -> PreparedProgramLaunch {
        guard Self.valid(artifact), !session.id.isEmpty, session.id.utf16.count <= 256,
              session.revision.map({ $0 >= 0 }) ?? true else { throw Self.invalid }
        let key = ProgramArtifactHash.key(path: artifact.path, binding: artifact.binding)
        lock.lock(); defer { lock.unlock() }
        guard !closed else { throw Self.changed }
        let time = now()
        _ = observe(time)
        guard entries.count < limit, sequence < UInt64.max else {
            throw ServerFailure(code: "busy", message: "Too many program resolutions are pending.")
        }
        let expiry = time.addingReportingOverflow(lifetime)
        guard !expiry.overflow else { throw Self.changed }
        sequence += 1
        // Sequence never resets after clear/consume. A random suffix is never reused as authority by itself.
        let token = "program_" + worker + "_" + String(sequence) + "_" + UUID().uuidString.lowercased()
        let prepared = PreparedProgramLaunch(artifact: artifact, token: token, key: key)
        entries[token] = Entry(prepared: prepared, sessionID: session.id, observationEpoch: session.observationEpoch,
            revision: session.revision, created: time, expires: expiry.partialValue)
        return prepared
    }

    /// Even wrong binding/session/expired requests burn an existing token; a failed attempt never re-arms it.
    func consume(token: String, binding: String, session: ServerSession) throws -> NativeProgramArtifact {
        lock.lock(); defer { lock.unlock() }
        let entry = entries.removeValue(forKey: token)
        let time = now()
        let coherentClock = observe(time)
        guard !closed, coherentClock, let entry, token.utf16.count <= 256,
              entry.created <= time, time < entry.expires, entry.sessionID.utf8.elementsEqual(session.id.utf8),
              entry.observationEpoch == session.observationEpoch, entry.revision == session.revision,
              binding == entry.prepared.artifact.binding else { throw Self.changed }
        return entry.prepared.artifact
    }

    /// Invalidating observations never restores a consumed or retired capability.
    func clear() { lock.lock(); entries.removeAll(); lock.unlock() }
    func close() { lock.lock(); closed = true; entries.removeAll(); lock.unlock() }

    private func observe(_ time: UInt64) -> Bool {
        let coherent = lastTime.map({ time >= $0 }) ?? true
        if !coherent { entries.removeAll() }
        entries = entries.filter { $0.value.created <= time && time < $0.value.expires }
        lastTime = time
        return coherent
    }

    private static func valid(_ artifact: NativeProgramArtifact) -> Bool {
        guard canonical(artifact.path), !artifact.name.isEmpty, artifact.name.utf16.count <= 256,
              MacAppIdentity.safeName(artifact.name),
              artifact.name.components(separatedBy: .whitespacesAndNewlines).filter({ !$0.isEmpty }).joined(separator: " ") == artifact.name,
              artifact.binding.utf8.count == 64, artifact.binding.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return false }
        switch artifact.route {
        case .application, .executable: return artifact.handler == nil && artifact.handlerPath == nil
        case .document:
            guard let handler = artifact.handler, let path = artifact.handlerPath, canonical(path),
                  SessionPolicy.validApprovals([handler.wire]) else { return false }
            return true
        }
    }
    private static func canonical(_ path: String) -> Bool {
        path.utf16.count <= 4096 && MacAppIdentity.canonicalPathShape(path)
    }
    private static var invalid: ServerFailure { ServerFailure(code: "failed", message: "The native program resolution is invalid.") }
    private static var changed: ServerFailure { ServerFailure(code: "changed", message: "The program launch resolution changed.") }
}
