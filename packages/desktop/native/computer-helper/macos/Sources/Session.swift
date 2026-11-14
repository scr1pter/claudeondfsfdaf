import Darwin
import Foundation

/// A policy is derived from one captured dispatcher session. It never reads saved grants or approves an app.
struct SessionPolicy {
    private let session: ServerSession
    private let approved: [MacAppIdentity]
    private let blocklist: NativeBlocklist
    private let helperPID: pid_t

    init(session: ServerSession, blocklist: NativeBlocklist? = nil, helperPID: pid_t = getpid()) throws {
        guard let approved = Self.decodeApproved(session.approved), helperPID > 0 else {
            throw ServerFailure(code: "failed", message: "The native session approvals are invalid.")
        }
        self.session = session
        self.approved = approved
        self.blocklist = try blocklist ?? NativeBlocklist.generated()
        self.helperPID = helperPID
    }

    static func validApprovals(_ values: [JSONValue]) -> Bool { decodeApproved(values) != nil }

    /// The caller supplies fresh static Security evidence, never a wire identity or an invented process witness.
    func requireLaunchIdentity(_ identity: MacAppIdentity) throws {
        guard identity.pid == nil, identity.verified, identity.apple || identity.teamId.map(MacAppIdentity.validTeam) == true,
              !identity.system || identity.apple, let path = identity.path, MacAppIdentity.canonicalPathShape(path),
              MacAppIdentity(wire: identity.wire) != nil else {
            throw refusal("unavailable", "The app's static identity could not be verified.")
        }
        let category = blocklist.category(identity)
        let protectedRoot = path == "/System" || path.hasPrefix("/System/") ||
            path == "/usr/libexec" || path.hasPrefix("/usr/libexec/")
        if blocklist.never.contains(category) || category == "system-ui" ||
            (protectedRoot && !(identity.apple && identity.system)) {
            throw refusal("protected", "This native app is protected.")
        }
        guard approved.contains(where: { $0.verified && $0.key == identity.key && $0.apple == identity.apple &&
            $0.teamId == identity.teamId }) else {
            throw refusal("not_granted", "This app is not approved for the current task.")
        }
        guard !session.paused else { throw refusal("paused", "The computer session is paused.") }
    }

    static func decodeApproved(_ values: [JSONValue]) -> [MacAppIdentity]? {
        guard values.count <= 4096 else { return nil }
        var result: [MacAppIdentity] = []
        var keys = Set<String>()
        for value in values {
            guard let identity = MacAppIdentity(wire: value), keys.insert(identity.key).inserted else { return nil }
            if let path = identity.path, !MacAppIdentity.canonicalPathShape(path) { return nil }
            if identity.verified {
                guard identity.apple || identity.teamId != nil else { return nil }
                if identity.system && !identity.apple { return nil }
            } else {
                guard !identity.apple, !identity.system, identity.teamId == nil,
                      identity.pid != nil, let path = identity.path, MacAppIdentity.canonicalPathShape(path) else { return nil }
            }
            result.append(identity)
        }
        return result
    }

    /// The caller must re-observe native ownership immediately before mutation and put the actual mutation
    /// inside OperationContext.withCurrent. Expected witnesses originate in native observations, not model text.
    func requireTarget(_ target: NativeTarget, operation: NativeOperation, expected: NativeExpectedTarget? = nil) throws {
        guard coherent(target.owner) else { throw refusal("changed", "The native process identity changed.") }
        if let hosted = target.hosted {
            guard target.owner.process.pid != helperPID, !session.vectorPids.contains(Int(target.owner.process.pid)),
                  hosted.validAuthority(session: session, physicalOwner: target.owner, windowID: target.windowID) else {
                throw refusal("changed", "The native panel ownership changed.")
            }
        }
        let owner = target.grantOwner
        guard coherent(owner) else { throw refusal("changed", "The native process identity changed.") }
        let category = blocklist.category(owner.identity, childShell: owner.childShell == true)
        if never(owner, category: category) || category == "system-ui" || excluded(target) {
            throw refusal("protected", "This native target is protected.")
        }
        guard owner.childShell != nil || category == "developer" else {
            throw refusal("unavailable", "The native process tree could not be verified.")
        }
        guard matchesApproval(owner) else { throw refusal("not_granted", "This app is not approved for the current task.") }
        switch operation {
        case .observe, .capture: break
        default:
            guard !session.paused else { throw refusal("paused", "The computer session is paused.") }
        }
        if let expected {
            if let pid = expected.pid, pid != Int(owner.process.pid) { throw refusal("changed", "The native owner changed.") }
            if let process = expected.process, process != target.owner.process { throw refusal("changed", "The native process changed.") }
            if let window = expected.windowID, window != target.windowID { throw refusal("changed", "The native window changed.") }
            if let ref = expected.ref, ref != target.ref { throw refusal("stale_ref", "The native element reference changed.") }
            if let element = expected.elementID, element != target.elementID { throw refusal("stale_ref", "The native element changed.") }
        }
        if operation.needsKeyboardPID && expected?.pid == nil && expected?.process == nil {
            throw refusal("changed", "Keyboard input needs its observed native process.")
        }
        if operation.typesText {
            guard target.secure == false else { throw refusal("secure_field", "The native field cannot receive text.") }
            if blocklist.isClickOnly(owner.identity, childShell: owner.childShell == true) {
                throw refusal("blocked", "Text input is unavailable for this app.")
            }
        }
    }

    func disclosure(_ owner: NativeOwner) -> NativeDisclosure {
        guard coherent(owner) else { return .structural }
        let category = blocklist.category(owner.identity, childShell: owner.childShell == true)
        guard !never(owner, category: category), category != "system-ui",
              owner.childShell != nil || category == "developer", matchesApproval(owner) else { return .structural }
        return .content
    }

    func disclosure(_ target: NativeTarget) -> NativeDisclosure {
        if target.hosted != nil {
            do { try requireTarget(target, operation: .observe); return .content }
            catch { return .structural }
        }
        return excluded(target) ? .structural : disclosure(target.owner)
    }

    /// OS furniture is the sole unapproved display exemption. Its actual Apple/platform proof must hold;
    /// a process claiming a furniture bundle ID without that proof stays masked.
    func mayIncludeInDisplay(_ owner: NativeOwner) -> Bool {
        guard coherent(owner) else { return false }
        let category = blocklist.category(owner.identity, childShell: owner.childShell == true)
        guard !never(owner, category: category), owner.childShell != nil || category == "developer" else { return false }
        if category == "system-ui" { return owner.identity.verified && owner.identity.apple && owner.identity.system }
        return matchesApproval(owner)
    }

    func mayIncludeInDisplay(_ target: NativeTarget) -> Bool {
        if target.hosted != nil {
            do { try requireTarget(target, operation: .capture); return true }
            catch { return false }
        }
        return !excluded(target) && mayIncludeInDisplay(target.owner)
    }

    private func coherent(_ owner: NativeOwner) -> Bool {
        let process = owner.process
        guard process.pid > 0, process.parentPID > 0,
              MacAppIdentity.canonicalPathShape(process.executable),
              owner.identity.pid == Int(process.pid), owner.identity.path == process.executable else { return false }
        if owner.identity.verified { return owner.identity.apple || owner.identity.teamId.map(MacAppIdentity.validTeam) == true }
        return !owner.identity.apple && !owner.identity.system && owner.identity.teamId == nil
    }

    private func never(_ owner: NativeOwner, category: String) -> Bool {
        if owner.process.pid == helperPID || session.vectorPids.contains(Int(owner.process.pid)) || blocklist.never.contains(category) { return true }
        let path = owner.process.executable
        let systemRoot = path == "/System" || path.hasPrefix("/System/") || path == "/usr/libexec" || path.hasPrefix("/usr/libexec/")
        return systemRoot && !(owner.identity.verified && owner.identity.apple && owner.identity.system)
    }

    private func excluded(_ target: NativeTarget) -> Bool {
        guard let window = target.windowID else { return false }
        return session.vectorWindowIds.contains(window) || session.overlayWindowIds.contains(window)
    }

    private func matchesApproval(_ owner: NativeOwner) -> Bool {
        let identity = owner.identity
        return approved.contains { granted in
            guard granted.key == identity.key, granted.verified == identity.verified, granted.apple == identity.apple,
                  granted.teamId == identity.teamId else { return false }
            return identity.verified || (granted.pid == Int(owner.process.pid) && granted.path == owner.process.executable)
        }
    }

    private func refusal(_ code: String, _ message: String) -> ServerFailure { ServerFailure(code: code, message: message) }
}
