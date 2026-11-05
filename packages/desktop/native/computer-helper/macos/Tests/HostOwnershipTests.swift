import CoreGraphics
import Darwin
import Foundation

private struct HostOwnershipTestFailure: Error { let message: String }

private func hostOwnershipCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw HostOwnershipTestFailure(message: message) }
}

private func hostOwnershipRefusal(_ code: String, _ body: () throws -> Void) throws {
    do { try body() }
    catch let failure as ServerFailure {
        try hostOwnershipCheck(failure.code == code, "The hosted target retains the native policy refusal")
        return
    }
    throw HostOwnershipTestFailure(message: "Expected hosted target refusal")
}

private func hostOwnershipOwner(_ bundle: String, pid: pid_t, path: String,
                                apple: Bool = false, system: Bool = false,
                                verified: Bool = true, team: String? = "ABCDEFGHIJ",
                                start: UInt64 = 10) -> NativeOwner {
    NativeOwner(identity: MacAppIdentity(bundleId: bundle, teamId: team, apple: apple,
        system: system, verified: verified, name: "Synthetic host test", path: path, pid: Int(pid)),
        process: HelperProcessIdentity(pid: pid, parentPID: 1, startSeconds: start,
            startMicroseconds: 20, executable: path), childShell: false)
}

/// Every observation is injected. The AX handles below have no native AXUIElement and cannot query the OS.
final class HostOwnershipTestFixture {
    static let openSavePath = "/System/Library/Frameworks/AppKit.framework/Versions/C/XPCServices/com.apple.appkit.xpc.openAndSavePanelService.xpc/Contents/MacOS/com.apple.appkit.xpc.openAndSavePanelService"
    var time: UInt64 = 1_000_000_000
    var current = true
    var trusted = true
    var logical = hostOwnershipOwner("example.notes", pid: 101,
        path: "/virtual/Notes.app/Contents/MacOS/Notes")
    var physical = hostOwnershipOwner("com.apple.appkit.xpc.openAndSavePanelService", pid: 202,
        path: HostOwnershipTestFixture.openSavePath, apple: true, system: true, team: nil)
    var surface: CaptureWindowInfo
    let logicalWindow = AccessibilityElement()
    let physicalRoot = AccessibilityElement()
    var elementPIDs: [UUID: pid_t] = [:]
    var elementBounds: [UUID: CGRect] = [:]
    var parents: [UUID: AccessibilityElement] = [:]
    var owners: [pid_t: NativeOwner] = [:]
    var processes: [pid_t: HelperProcessIdentity] = [:]
    var windows: [CaptureWindowInfo] = []
    var links: [HostAXBridge] = []
    var responsible: pid_t? = 101
    var extensionPoint: String? = nil
    var kindOverride: ((NativeOwner) -> NativeHostKind?)?
    var onBridges: (() -> Void)?
    var onWindows: (() -> Void)?
    var onProcess: ((pid_t) -> Void)?
    var onResponsible: (() -> Void)?
    var preflightReads = 0
    var ownerReads = 0
    var processReads = 0
    var responsibilityReads = 0
    var windowsReads = 0
    var bridgeReads = 0
    var pidReads = 0
    var boundsReads = 0
    var equalityReads = 0
    var kindReads = 0
    var parentReads = 0

    init(surfaceIsPhysical: Bool = false) {
        let bounds = CGRect(x: -20, y: 40, width: 300, height: 200)
        surface = CaptureWindowInfo(windowID: "visible-surface", pid: surfaceIsPhysical ? 202 : 101,
            bounds: bounds, onScreen: true, minimized: false, spaceWitness: "space-1")
        elementPIDs[logicalWindow.identity] = 101
        elementPIDs[physicalRoot.identity] = 202
        elementBounds[logicalWindow.identity] = bounds
        elementBounds[physicalRoot.identity] = bounds
        owners[101] = logical; owners[202] = physical
        processes[101] = logical.process; processes[202] = physical.process
        windows = [surface]
        links = [HostAXBridge(logicalPID: 101, logicalWindow: logicalWindow,
            linkedRoot: physicalRoot, physicalRoot: physicalRoot)]
    }

    func session(_ approved: Bool = true) -> ServerSession {
        ServerSession(id: "synthetic-host", revision: 7, mode: "foreground", paused: false,
            approved: approved ? [logical.identity.wire] : [], vectorPids: [900], vectorWindowIds: [],
            overlayWindowIds: [], escStops: true, stopChord: "Command+Shift+Escape")
    }

    func install(_ owner: NativeOwner) {
        owners[owner.process.pid] = owner
        processes[owner.process.pid] = owner.process
    }

    func backend() -> HostOwnershipBackend {
        var backend = HostOwnershipBackend(preflight: { self.preflightReads += 1; return self.trusted },
            windows: { self.windowsReads += 1; self.onWindows?(); return self.windows },
            process: { pid in
                self.processReads += 1; self.onProcess?(pid); return self.processes[pid]
            }, owner: { pid in
                self.ownerReads += 1
                guard let owner = self.owners[pid] else { throw Self.unavailable }
                return owner
            }, responsible: { _ in
                self.responsibilityReads += 1; self.onResponsible?(); return self.responsible
            }, kind: { owner in
                self.kindReads += 1
                if let override = self.kindOverride { return override(owner) }
                return HostOwnershipNative.eligibleKind(owner: owner, extensionPoint: self.extensionPoint)
            }, bridges: { _, _, isCurrent, _ in
                self.bridgeReads += 1; self.onBridges?()
                return isCurrent() ? self.links : []
            }, pid: { element in
                self.pidReads += 1
                guard let pid = self.elementPIDs[element.identity] else { throw Self.unavailable }
                return pid
            }, bounds: { element in
                self.boundsReads += 1
                guard let bounds = self.elementBounds[element.identity] else { throw Self.unavailable }
                return bounds
            }, equal: { first, second in
                self.equalityReads += 1
                return AccessibilityElement.equivalent(first, second)
            })
        backend.parent = { element in
            self.parentReads += 1
            return self.parents[element.identity]
        }
        return backend
    }

    var window: CaptureWindowInfo {
        get { surface }
        set { surface = newValue }
    }

    func resolver() -> HostOwnershipResolver { HostOwnershipResolver(backend: backend(), now: { self.time }) }
    func makeResolver() -> HostOwnershipResolver { resolver() }
    func proof(session: ServerSession) throws -> HostedWindowProof { try proof(session) }

    func proof(_ session: ServerSession? = nil) throws -> HostedWindowProof {
        guard let proof = try resolver().resolve(window: surface, session: session ?? self.session(),
            isCurrent: { self.current }) else { throw HostOwnershipTestFailure(message: "Expected a synthetic per-window host proof") }
        return proof
    }

    static var unavailable: ServerFailure { ServerFailure(code: "unavailable", message: "Synthetic observation unavailable") }
}

/// Only immutable synthetic process facts, virtual time, and AX wrapper identities are used in this suite.
func runHostOwnershipTests() throws -> Int {
    var groups = 0
    func test(_ body: () throws -> Void) throws { try body(); groups += 1 }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let proof = try fixture.proof(session)
        try hostOwnershipCheck(proof.physicalOwner.process == fixture.physical.process &&
            proof.logicalOwner.process == fixture.logical.process && proof.surface.process == fixture.logical.process,
            "A visible client-owned CG surface preserves its distinct real host AX endpoint and grant owner")
        try hostOwnershipCheck(proof.surface.windowID == fixture.surface.windowID &&
            proof.physicalRoot === fixture.physicalRoot && proof.logicalWindow === fixture.logicalWindow,
            "The proof retains actual scoped AX identities and the real visible CG id")
        try hostOwnershipCheck(proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "The exact current triple witness is usable without a host CG row")
    }

    try test {
        let fixture = HostOwnershipTestFixture(surfaceIsPhysical: true)
        let session = fixture.session()
        let proof = try fixture.proof(session)
        try hostOwnershipCheck(proof.surface.process == fixture.physical.process &&
            proof.logicalOwner.process == fixture.logical.process,
            "A host-owned visible surface keeps its physical process and separately observed approved client")
        try hostOwnershipCheck(proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "A real host CG row can carry the same scoped ownership proof")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let proof = try fixture.proof(session)
        var target = NativeTarget(owner: fixture.physical, windowID: fixture.surface.windowID, secure: false)
        target.hosted = proof
        let policy = try SessionPolicy(session: session, helperPID: 999)
        try policy.requireTarget(target, operation: .type, expected: NativeExpectedTarget(pid: 101))
        try hostOwnershipCheck(target.owner.process.pid == 202 && target.grantOwner.process.pid == 101 &&
            policy.disclosure(target) == .content && policy.mayIncludeInDisplay(target),
            "Policy authorizes the actual logical grant while leaving the physical input destination intact")
        try hostOwnershipRefusal("changed") {
            try policy.requireTarget(target, operation: .type, expected: NativeExpectedTarget(pid: 202))
        }
        target.secure = true
        try hostOwnershipRefusal("secure_field") {
            try policy.requireTarget(target, operation: .type, expected: NativeExpectedTarget(pid: 101))
        }
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        fixture.logical = hostOwnershipOwner("com.microsoft.VSCode", pid: 101,
            path: "/virtual/Editor.app/Contents/MacOS/Editor")
        fixture.install(fixture.logical)
        let session = fixture.session()
        let proof = try fixture.proof(session)
        var target = NativeTarget(owner: fixture.physical, windowID: fixture.surface.windowID, secure: false)
        target.hosted = proof
        let policy = try SessionPolicy(session: session, helperPID: 999)
        try policy.requireTarget(target, operation: .pointer)
        try hostOwnershipRefusal("blocked") {
            try policy.requireTarget(target, operation: .type, expected: NativeExpectedTarget(pid: 101))
        }
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        fixture.trusted = false
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "AX denial returns no ownership mapping")
        try hostOwnershipCheck(fixture.bridgeReads == 0 && fixture.ownerReads == 0 && fixture.windowsReads == 0,
            "Missing AX trust cannot enumerate windows, probe owners, or walk AX")
        fixture.trusted = true; fixture.current = false
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session(), isCurrent: { fixture.current }) == nil && fixture.bridgeReads == 0,
            "A retired operation cannot start a host observation")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session(false)) == nil && fixture.bridgeReads == 0,
            "An unapproved logical owner is refused before the host AX relationship is probed")
        fixture.responsible = 303
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "An unrelated responsible process cannot inherit the client grant")
        fixture.responsible = nil
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "An unavailable responsibility observation never maps a host")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let security = hostOwnershipOwner("com.apple.SecurityAgent", pid: 202,
            path: "/System/Library/CoreServices/SecurityAgentPlugins/securityagent.bundle/Contents/MacOS/securityagent",
            apple: true, system: true, team: nil)
        fixture.install(security)
        try hostOwnershipCheck(HostOwnershipNative.eligibleKind(owner: security, extensionPoint: nil) == nil,
            "A genuine Apple security host is never a benign host kind")
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "A security host remains unmapped despite a matching responsibility and AX link")
        fixture.kindOverride = { $0.process.pid == 202 ? .openSave : nil }
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil,
            "The explicit security veto remains independent of an erroneous injected benign-kind observation")
    }

    try test {
        let variants = [
            hostOwnershipOwner("com.apple.appkit.xpc.openAndSavePanelService", pid: 202,
                path: HostOwnershipTestFixture.openSavePath, apple: false, system: true, team: nil),
            hostOwnershipOwner("com.apple.appkit.xpc.openAndSavePanelService", pid: 202,
                path: HostOwnershipTestFixture.openSavePath, apple: true, system: true, verified: false, team: nil),
            hostOwnershipOwner("com.apple.appkit.xpc.openAndSavePanelService", pid: 202,
                path: "/virtual/com.apple.appkit.xpc.openAndSavePanelService", apple: true, system: false, team: nil),
            hostOwnershipOwner("example.spoof", pid: 202,
                path: HostOwnershipTestFixture.openSavePath, apple: true, system: true, team: nil),
        ]
        for owner in variants {
            let fixture = HostOwnershipTestFixture(); fixture.install(owner)
            try hostOwnershipCheck(HostOwnershipNative.eligibleKind(owner: owner, extensionPoint: nil) == nil,
                "Name, location, or partial signing facts cannot establish the audited native host kind")
            try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
                session: fixture.session()) == nil, "Spoofed or unsigned host metadata remains unmapped")
        }
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        fixture.links = []
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "A responsible host without a public AX cross-link is not mapped")
        let proxy = AccessibilityElement()
        fixture.elementPIDs[proxy.identity] = 202
        fixture.elementBounds[proxy.identity] = fixture.surface.bounds
        fixture.links = [HostAXBridge(logicalPID: 101, logicalWindow: fixture.logicalWindow,
            linkedRoot: proxy, physicalRoot: fixture.physicalRoot)]
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "Equal geometry and a host PID cannot replace actual AX endpoint equality")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        fixture.elementPIDs[fixture.logicalWindow.identity] = 202
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "The logical AX root must belong to the actual approved client")
        fixture.elementPIDs[fixture.logicalWindow.identity] = 101
        fixture.elementPIDs[fixture.physicalRoot.identity] = 101
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "A logical-process proxy is not a physical host endpoint")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        var duplicate = fixture.surface
        duplicate = CaptureWindowInfo(windowID: "duplicate-surface", pid: duplicate.pid,
            bounds: duplicate.bounds, onScreen: duplicate.onScreen, minimized: false)
        fixture.windows.append(duplicate)
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil && fixture.bridgeReads == 0,
            "Ambiguous same-process visible geometry refuses before AX probing")
        fixture.windows = [fixture.surface, fixture.surface]
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "Repeated CG ids cannot establish a unique real surface")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        fixture.elementBounds[fixture.logicalWindow.identity] = fixture.surface.bounds.offsetBy(dx: 1, dy: 0)
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "The parent AX window must match its real CG surface exactly")
        fixture.elementBounds[fixture.logicalWindow.identity] = fixture.surface.bounds
        fixture.elementBounds[fixture.physicalRoot.identity] = fixture.surface.bounds.offsetBy(dx: 1000, dy: 0)
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "A detached remote endpoint cannot map an unrelated client surface")
        fixture.elementBounds[fixture.physicalRoot.identity] = fixture.surface.bounds.offsetBy(dx: 1, dy: 0)
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "A partially overlapping host root cannot authorize content beyond the real surface")
        fixture.elementBounds[fixture.physicalRoot.identity] = fixture.surface.bounds.insetBy(dx: -1, dy: -1)
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "An oversized shared host root is not authority for a smaller client-owned surface")
        let physicalSurface = HostOwnershipTestFixture(surfaceIsPhysical: true)
        physicalSurface.elementBounds[physicalSurface.logicalWindow.identity] = physicalSurface.surface.bounds.insetBy(dx: 1, dy: 1)
        try hostOwnershipCheck(try physicalSurface.resolver().resolve(window: physicalSurface.surface,
            session: physicalSurface.session()) == nil,
            "A real host-owned surface must also remain fully inside its proved logical client's AX window")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let original = fixture.logical
        let replacement = hostOwnershipOwner(original.identity.bundleId, pid: 101,
            path: original.process.executable, start: 99)
        fixture.onBridges = { fixture.processes[101] = replacement.process }
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "PID reuse during the AX walk cannot bind the replacement logical process")
        fixture.processes[101] = original.process
        fixture.onBridges = { fixture.responsible = 404 }
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "Responsibility changes during AX proof gathering refuse the mapping")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let proof = try fixture.proof(session)
        let axCounts = [fixture.bridgeReads, fixture.pidReads, fixture.boundsReads, fixture.equalityReads,
            fixture.ownerReads, fixture.kindReads, fixture.preflightReads]
        try hostOwnershipCheck(proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "The current proof passes its final metadata fence")
        try hostOwnershipCheck(axCounts == [fixture.bridgeReads, fixture.pidReads, fixture.boundsReads,
            fixture.equalityReads, fixture.ownerReads, fixture.kindReads, fixture.preflightReads],
            "The final authority check does not perform AX, signature, AppKit, or trust queries")
        try hostOwnershipCheck(fixture.processReads > 0 && fixture.responsibilityReads > 0 && fixture.windowsReads > 0,
            "The short fence still rechecks both private processes, actual responsibility, and current CG metadata")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let proof = try fixture.proof(session)
        fixture.time += 50_000_000
        try hostOwnershipCheck(proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "The documented 50ms metadata freshness boundary is inclusive")
        fixture.time += 1
        try hostOwnershipCheck(!proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "Older AX ownership evidence cannot authorize a new post")
        fixture.time = 999_999_999
        try hostOwnershipCheck(!proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "Clock rollback invalidates an existing proof")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let proof = try fixture.proof(session)
        var updated = session; updated.observationEpoch = UUID()
        try hostOwnershipCheck(!proof.validAuthority(session: updated, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "Same wire id and revision cannot reuse an earlier authority epoch")
        updated = session; updated.revision = 8
        try hostOwnershipCheck(!proof.validAuthority(session: updated, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "A different phase revision invalidates the proof")
        updated = session; updated = ServerSession(id: "other-session", revision: session.revision,
            mode: session.mode, paused: false, approved: session.approved, vectorPids: session.vectorPids,
            vectorWindowIds: [], overlayWindowIds: [], escStops: true, stopChord: session.stopChord)
        updated.observationEpoch = session.observationEpoch
        try hostOwnershipCheck(!proof.validAuthority(session: updated, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "A proof remains scoped to the exact raw session id as well as its epoch")
        try hostOwnershipCheck(!proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: nil) && !proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: "sibling-window"), "Host ownership never grants every window in a shared host process")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let proof = try fixture.proof(session)
        for change in 0..<6 {
            fixture.windows = [fixture.surface]
            switch change {
            case 0: fixture.windows[0] = CaptureWindowInfo(windowID: fixture.surface.windowID, pid: 303,
                bounds: fixture.surface.bounds, onScreen: true, minimized: false)
            case 1: fixture.windows[0] = CaptureWindowInfo(windowID: fixture.surface.windowID, pid: 101,
                bounds: fixture.surface.bounds.offsetBy(dx: 1, dy: 0), onScreen: true, minimized: false)
            case 2: fixture.windows[0] = CaptureWindowInfo(windowID: fixture.surface.windowID, pid: 101,
                bounds: fixture.surface.bounds, onScreen: false, minimized: false)
            case 3: fixture.windows[0].alpha = 0.5
            case 4: fixture.windows[0].spaceWitness = "space-2"
            default: fixture.windows = []
            }
            try hostOwnershipCheck(!proof.validAuthority(session: session, physicalOwner: fixture.physical,
                windowID: fixture.surface.windowID), "Changed current native surface metadata invalidates the old mapping")
        }
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let proof = try fixture.proof(session)
        let replacement = hostOwnershipOwner(fixture.physical.identity.bundleId, pid: 202,
            path: fixture.physical.process.executable, apple: true, system: true, team: nil, start: 88)
        fixture.processes[202] = replacement.process
        try hostOwnershipCheck(!proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "A physical host PID reused by a new process cannot inherit the proof")
        fixture.processes[202] = fixture.physical.process
        fixture.processes[101] = nil
        try hostOwnershipCheck(!proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "A dead logical client invalidates still-running host authority")
        fixture.processes[101] = fixture.logical.process; fixture.responsible = 777
        try hostOwnershipCheck(!proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID), "The physical host cannot reuse its proof after a client handoff")
        try hostOwnershipCheck(!proof.validAuthority(session: session, physicalOwner: replacement,
            windowID: fixture.surface.windowID), "A caller cannot swap in another physical private witness")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let first = try fixture.proof(session)
        fixture.time += 100_000_000
        let fresh = try fixture.proof(session)
        try hostOwnershipCheck(first.sameMapping(fresh) && first == fresh,
            "Retained geometry can compare the same mapping independently of observation issuance time")
        try hostOwnershipCheck(!first.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID) && fresh.validAuthority(session: session,
            physicalOwner: fixture.physical, windowID: fixture.surface.windowID),
            "Time-independent mapping equality never revives old posting authority")
        let otherRoot = AccessibilityElement()
        fixture.elementPIDs[otherRoot.identity] = 202
        fixture.elementBounds[otherRoot.identity] = fixture.surface.bounds
        fixture.links = [HostAXBridge(logicalPID: 101, logicalWindow: fixture.logicalWindow,
            linkedRoot: otherRoot, physicalRoot: otherRoot)]
        let replaced = try fixture.proof(session)
        try hostOwnershipCheck(!first.sameMapping(replaced), "Replacing the actual AX endpoint changes the retained mapping")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let first = try fixture.proof(session)
        var updated = session; updated.observationEpoch = UUID()
        let second = try fixture.proof(updated)
        try hostOwnershipCheck(!first.sameMapping(second), "Geometry from a retired authority snapshot never matches a successor mapping")
        fixture.links.append(fixture.links[0])
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface, session: session) != nil,
            "Repeated sightings of the exact same native bridge do not create ambiguity")
        let otherRoot = AccessibilityElement()
        fixture.elementPIDs[otherRoot.identity] = 202
        fixture.elementBounds[otherRoot.identity] = fixture.surface.bounds
        fixture.links.append(HostAXBridge(logicalPID: 101, logicalWindow: fixture.logicalWindow,
            linkedRoot: otherRoot, physicalRoot: otherRoot))
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface, session: session) == nil,
            "Two distinct physical AX roots for one visible surface remain ambiguous")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        fixture.onBridges = { fixture.time += 200_000_000 }
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "The overall bridge observation deadline cannot yield a late proof")
        fixture.time = 1_000_000_000; fixture.onBridges = { fixture.current = false }
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session(), isCurrent: { fixture.current }) == nil,
            "Cancellation during the AX walk cannot create later host authority")
        fixture.current = true; fixture.onBridges = nil; fixture.time = UInt64.max - 1
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "Deadline overflow fails closed before native observation")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        fixture.links = Array(repeating: fixture.links[0], count: 129)
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "Oversized bridge output cannot bypass the common bound")
        fixture.links = [fixture.links[0]]
        fixture.windows = Array(repeating: fixture.surface, count: 4097)
        try hostOwnershipCheck(try fixture.resolver().resolve(window: fixture.surface,
            session: fixture.session()) == nil, "A truncated or oversized native window inventory is not a valid association")
    }

    try test {
        let quickLook = hostOwnershipOwner("com.apple.quicklook.QuickLookUIService", pid: 202,
            path: "/System/Library/Frameworks/QuickLookUI.framework/Versions/A/XPCServices/QuickLookUIService.xpc/Contents/MacOS/QuickLookUIService",
            apple: true, system: true, team: nil)
        let photo = hostOwnershipOwner("com.apple.synthetic-photo-id", pid: 202,
            path: "/System/Library/ExtensionKit/Extensions/PhotoPicker.appex/Contents/MacOS/PhotoPicker",
            apple: true, system: true, team: nil)
        let shared = hostOwnershipOwner("com.apple.synthetic-share-id", pid: 202,
            path: "/System/Library/ExtensionKit/Extensions/SyntheticShare.appex/Contents/MacOS/SyntheticShare",
            apple: true, system: true, team: nil)
        try hostOwnershipCheck(HostOwnershipNative.eligibleKind(owner: quickLook, extensionPoint: nil) == .quickLook &&
            HostOwnershipNative.eligibleKind(owner: photo, extensionPoint: nil) == .photoPicker,
            "Evidence-bound exact native executable locations classify QuickLook and PhotoPicker without a display-name guess")
        try hostOwnershipCheck(HostOwnershipNative.eligibleKind(owner: shared, extensionPoint: nil) == nil &&
            HostOwnershipNative.eligibleKind(owner: shared, extensionPoint: "com.apple.share-services") == .sharing &&
            HostOwnershipNative.eligibleKind(owner: shared, extensionPoint: "com.apple.authentication-services") == nil,
            "Sharing requires the actual sealed public extension point, never a guessed service bundle id")
        let security = hostOwnershipOwner("com.apple.SecurityAgent", pid: 202,
            path: shared.process.executable, apple: true, system: true, team: nil)
        try hostOwnershipCheck(HostOwnershipNative.eligibleKind(owner: security,
            extensionPoint: "com.apple.share-services") == nil,
            "Explicit security classification always vetoes an otherwise matching host location or extension point")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let proof = try fixture.proof(session)
        let descendant = AccessibilityElement()
        fixture.elementPIDs[descendant.identity] = 202
        fixture.parents[descendant.identity] = fixture.physicalRoot
        let resolver = fixture.makeResolver()
        try hostOwnershipCheck(resolver.contains(element: descendant, proof: proof),
            "A hosted element must reach the actual independently proved host AX root")
        let sibling = AccessibilityElement()
        fixture.elementPIDs[sibling.identity] = 202
        try hostOwnershipCheck(!resolver.contains(element: sibling, proof: proof),
            "Another element in the same physical host process does not inherit per-window authority")
        fixture.parents[descendant.identity] = descendant
        try hostOwnershipCheck(!resolver.contains(element: descendant, proof: proof),
            "An AX parent cycle is a refusal rather than an unbounded walk")
        fixture.parents[descendant.identity] = fixture.physicalRoot
        fixture.elementPIDs[descendant.identity] = 101
        try hostOwnershipCheck(!resolver.contains(element: descendant, proof: proof),
            "A client-side proxy cannot be treated as the actual host endpoint")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let proof = try fixture.proof()
        let leaf = AccessibilityElement()
        fixture.elementPIDs[leaf.identity] = 202
        var previous = leaf
        for _ in 0..<33 {
            let parent = AccessibilityElement()
            fixture.elementPIDs[parent.identity] = 202
            fixture.parents[previous.identity] = parent
            previous = parent
        }
        fixture.parents[previous.identity] = fixture.physicalRoot
        try hostOwnershipCheck(!fixture.makeResolver().contains(element: leaf, proof: proof) && fixture.parentReads <= 32,
            "Host membership is bounded even for a valid-looking adversarial parent chain")
        fixture.current = false
        let reads = fixture.parentReads
        try hostOwnershipCheck(!fixture.makeResolver().contains(element: leaf, proof: proof,
            isCurrent: { fixture.current }) && fixture.parentReads == reads,
            "Cancelled membership checks perform no additional AX traversal")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        try hostOwnershipCheck(try fixture.makeResolver().resolve(window: fixture.surface,
            session: session, logicalPID: 404) == nil && fixture.bridgeReads == 0,
            "A requested different app cannot probe the parent-owned host AX hierarchy")
        try hostOwnershipCheck(try fixture.makeResolver().resolve(window: fixture.surface,
            session: session, logicalPID: 101) != nil && fixture.bridgeReads == 1,
            "The matching requested logical owner still obtains the complete per-window proof")
    }

    try test {
        let fixture = HostOwnershipTestFixture()
        let session = fixture.session()
        let proof = try fixture.proof(session)
        fixture.onWindows = { fixture.time += 50_000_001 }
        try hostOwnershipCheck(!proof.validAuthority(session: session, physicalOwner: fixture.physical,
            windowID: fixture.surface.windowID),
            "A slow metadata call cannot cross the 50ms freshness boundary and still authorize posting")
    }

    return groups
}
