import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Dispatch
import Foundation
import Security

/// The real visible WindowServer surface. Remote AX content can have a different actual process.
struct HostWindowSurface: Equatable {
    let windowID: String
    let process: HelperProcessIdentity
    let bounds: CGRect
    let onScreen: Bool
    let alpha: Double
    let spaceWitness: String?
}

/// All three handles are observed by a bounded app-scoped walk. linkedRoot is reached through the
/// client's tree; physicalRoot is independently reached through the actual host's tree.
struct HostAXBridge {
    let logicalPID: pid_t
    let logicalWindow: AccessibilityElement
    let linkedRoot: AccessibilityElement
    let physicalRoot: AccessibilityElement
}

enum NativeHostKind: String { case openSave, quickLook, photoPicker, sharing }

struct HostOwnershipBackend {
    let preflight: () -> Bool
    let windows: () throws -> [CaptureWindowInfo]
    let process: (pid_t) -> HelperProcessIdentity?
    let owner: (pid_t) throws -> NativeOwner
    let responsible: (HelperProcessIdentity) -> pid_t?
    let kind: (NativeOwner) throws -> NativeHostKind?
    let bridges: (CaptureWindowInfo, NativeOwner, @escaping () -> Bool, UInt64) throws -> [HostAXBridge]
    let pid: (AccessibilityElement) throws -> pid_t
    let bounds: (AccessibilityElement) throws -> CGRect
    var equal: (AccessibilityElement, AccessibilityElement) -> Bool = AccessibilityElement.equivalent
    var parent: ((AccessibilityElement) throws -> AccessibilityElement?)? = nil

    static var system: HostOwnershipBackend {
        var backend = HostOwnershipBackend(preflight: { AXIsProcessTrusted() }, windows: AccessibilityNative.windows,
            process: HelperLifecycle.processIdentity, owner: HostOwnershipNative.owner,
            responsible: HelperLifecycle.responsiblePID, kind: HostOwnershipNative.kind,
            bridges: HostOwnershipNative.bridges, pid: AccessibilityNative.pid, bounds: HostOwnershipNative.bounds)
        backend.parent = HostOwnershipNative.parent
        return backend
    }
}

/// Private native evidence only; this has no wire representation and cannot be supplied by a request.
/// Equality deliberately ignores observation time, while every use of authority requires a fresh proof.
struct HostedWindowProof: Equatable {
    let physicalOwner: NativeOwner
    let logicalOwner: NativeOwner
    let surface: HostWindowSurface
    let kind: NativeHostKind
    let physicalRoot: AccessibilityElement
    let logicalWindow: AccessibilityElement
    let observationEpoch: UUID
    let sessionID: String
    let phaseRevision: Int?
    fileprivate let observedAt: UInt64
    fileprivate let backend: HostOwnershipBackend
    fileprivate let now: () -> UInt64

    fileprivate init(physicalOwner: NativeOwner, logicalOwner: NativeOwner, surface: HostWindowSurface,
                     kind: NativeHostKind, bridge: HostAXBridge, session: ServerSession, observedAt: UInt64,
                     backend: HostOwnershipBackend, now: @escaping () -> UInt64) {
        self.physicalOwner = physicalOwner; self.logicalOwner = logicalOwner; self.surface = surface; self.kind = kind
        physicalRoot = bridge.physicalRoot; logicalWindow = bridge.logicalWindow
        observationEpoch = session.observationEpoch; sessionID = session.id; phaseRevision = session.revision
        self.observedAt = observedAt; self.backend = backend; self.now = now
    }

    func sameMapping(_ other: HostedWindowProof) -> Bool {
        Self.same(physicalOwner, other.physicalOwner) && Self.same(logicalOwner, other.logicalOwner) &&
            surface == other.surface && kind == other.kind && observationEpoch == other.observationEpoch &&
            sessionID.utf8.elementsEqual(other.sessionID.utf8) && phaseRevision == other.phaseRevision &&
            backend.equal(physicalRoot, other.physicalRoot) && backend.equal(logicalWindow, other.logicalWindow)
    }

    static func == (first: HostedWindowProof, second: HostedWindowProof) -> Bool { first.sameMapping(second) }

    /// Called only in the short commit fence. No AX, AppKit, signature lookup, tree walk, or content read.
    func validAuthority(session: ServerSession, physicalOwner owner: NativeOwner, windowID: String?) -> Bool {
        let current = now()
        guard current >= observedAt, current - observedAt <= 50_000_000,
              windowID == surface.windowID, session.observationEpoch == observationEpoch,
              session.id.utf8.elementsEqual(sessionID.utf8), session.revision == phaseRevision,
              Self.same(owner, physicalOwner), !session.vectorPids.contains(Int(physicalOwner.process.pid)),
              !session.vectorPids.contains(Int(logicalOwner.process.pid)),
              !session.vectorWindowIds.contains(surface.windowID), !session.overlayWindowIds.contains(surface.windowID),
              backend.process(physicalOwner.process.pid) == physicalOwner.process,
              backend.process(logicalOwner.process.pid) == logicalOwner.process,
              backend.process(surface.process.pid) == surface.process,
              backend.responsible(physicalOwner.process) == logicalOwner.process.pid,
              let windows = try? backend.windows(), windows.count <= 4096,
              let actual = windows.first(where: { $0.windowID == surface.windowID }),
              windows.filter({ $0.windowID == surface.windowID }).count == 1,
              Self.matches(actual, surface),
              windows.filter({ $0.pid == actual.pid && $0.bounds == actual.bounds }).count == 1,
              backend.process(physicalOwner.process.pid) == physicalOwner.process,
              backend.process(logicalOwner.process.pid) == logicalOwner.process,
              backend.responsible(physicalOwner.process) == logicalOwner.process.pid else { return false }
        let finished = now()
        return finished >= current && finished >= observedAt && finished - observedAt <= 50_000_000
    }

    fileprivate static func same(_ first: NativeOwner, _ second: NativeOwner) -> Bool {
        first.process == second.process && first.identity == second.identity && first.childShell == second.childShell
    }

    fileprivate static func matches(_ window: CaptureWindowInfo, _ surface: HostWindowSurface) -> Bool {
        window.windowID == surface.windowID && window.pid == surface.process.pid && window.bounds == surface.bounds &&
            window.onScreen == surface.onScreen && window.alpha == surface.alpha && window.spaceWitness == surface.spaceWitness
    }
}

/// Resolving does bounded AX work and MUST happen outside Dispatcher.withCurrent / an input posting lock.
/// It never treats a responsible PID, window name, matching rectangle, or proxy alone as an ownership link.
final class HostOwnershipResolver {
    private let backend: HostOwnershipBackend
    private let now: () -> UInt64

    init(backend: HostOwnershipBackend = .system, now: (() -> UInt64)? = nil) {
        self.backend = backend; self.now = now ?? { DispatchTime.now().uptimeNanoseconds }
    }

    func resolve(window: CaptureWindowInfo, session: ServerSession, logicalPID: pid_t? = nil,
                 isCurrent: @escaping () -> Bool = { true }) throws -> HostedWindowProof? {
        let started = now()
        let (deadline, overflow) = started.addingReportingOverflow(200_000_000)
        guard !overflow, isCurrent(), backend.preflight(), window.pid > 0,
              CapturePrivacy.valid(window.bounds), window.alpha.isFinite, (0...1).contains(window.alpha),
              !session.overlayWindowIds.contains(window.windowID), !session.vectorWindowIds.contains(window.windowID),
              let surfaceProcess = backend.process(window.pid) else { return nil }
        let surfaceOwner = try backend.owner(window.pid)
        guard coherent(surfaceOwner), surfaceOwner.process == surfaceProcess else { return nil }
        let logicalCandidate: NativeOwner
        if try backend.kind(surfaceOwner) != nil {
            guard let responsible = backend.responsible(surfaceProcess), responsible != surfaceProcess.pid else { return nil }
            logicalCandidate = try backend.owner(responsible)
        } else { logicalCandidate = surfaceOwner }
        guard coherent(logicalCandidate), backend.process(logicalCandidate.process.pid) == logicalCandidate.process,
              logicalPID == nil || logicalPID == logicalCandidate.process.pid else { return nil }
        let policy = try SessionPolicy(session: session)
        do { try policy.requireTarget(NativeTarget(owner: logicalCandidate, windowID: window.windowID), operation: .observe) }
        catch { return nil }
        let windows = try backend.windows()
        guard windows.count <= 4096, windows.filter({ $0.windowID == window.windowID }).count == 1,
              windows.filter({ $0.pid == window.pid && $0.bounds == window.bounds }).count == 1 else { return nil }
        let surface = HostWindowSurface(windowID: window.windowID, process: surfaceProcess, bounds: window.bounds,
            onScreen: window.onScreen, alpha: window.alpha, spaceWitness: window.spaceWitness)
        guard windows.contains(where: { HostedWindowProof.matches($0, surface) }), isCurrent(), now() < deadline else { return nil }
        let bridges = try backend.bridges(window, surfaceOwner, isCurrent, deadline)
        guard bridges.count <= 128 else { return nil }
        var proofs: [HostedWindowProof] = []
        for bridge in bridges {
            guard isCurrent(), now() < deadline, bridge.logicalPID == logicalCandidate.process.pid,
                  try backend.pid(bridge.logicalWindow) == bridge.logicalPID,
                  try backend.pid(bridge.linkedRoot) == backend.pid(bridge.physicalRoot),
                  backend.equal(bridge.linkedRoot, bridge.physicalRoot) else { return nil }
            let physicalPID = try backend.pid(bridge.physicalRoot)
            guard physicalPID != bridge.logicalPID else { continue }
            let physical = try backend.owner(physicalPID)
            let logical = try backend.owner(bridge.logicalPID)
            guard coherent(physical), coherent(logical),
                  surfaceProcess == physical.process || surfaceProcess == logical.process,
                  !HostOwnershipNative.explicitlyProtected(physical),
                  let kind = try backend.kind(physical),
                  backend.responsible(physical.process) == logical.process.pid else { continue }
            do { try policy.requireTarget(NativeTarget(owner: logical, windowID: window.windowID), operation: .observe) }
            catch { continue }
            let logicalBounds = try backend.bounds(bridge.logicalWindow)
            let physicalBounds = try backend.bounds(bridge.physicalRoot)
            guard CapturePrivacy.valid(logicalBounds), CapturePrivacy.valid(physicalBounds),
                  (surfaceProcess == logical.process ? logicalBounds == surface.bounds : physicalBounds == surface.bounds),
                  logicalBounds.contains(physicalBounds), surface.bounds.contains(physicalBounds),
                  isCurrent(), now() < deadline,
                  backend.process(physical.process.pid) == physical.process,
                  backend.process(logical.process.pid) == logical.process,
                  backend.process(surface.process.pid) == surface.process,
                  backend.responsible(physical.process) == logical.process.pid else { continue }
            let proof = HostedWindowProof(physicalOwner: physical, logicalOwner: logical, surface: surface,
                kind: kind, bridge: bridge, session: session, observedAt: now(), backend: backend, now: now)
            guard proof.validAuthority(session: session, physicalOwner: physical, windowID: window.windowID) else { continue }
            if !proofs.contains(where: { $0.sameMapping(proof) }) { proofs.append(proof) }
        }
        guard proofs.count == 1, isCurrent(), now() < deadline else { return nil }
        return proofs[0]
    }

    /// Membership is checked outside the input/dispatcher commit fence; a shared host PID alone is insufficient.
    func contains(element: AccessibilityElement, proof: HostedWindowProof,
                  isCurrent: @escaping () -> Bool = { true }) -> Bool {
        let started = now()
        let (deadline, overflow) = started.addingReportingOverflow(50_000_000)
        guard !overflow, isCurrent(), backend.preflight() else { return false }
        var current = element
        var seen: [AccessibilityElement] = []
        for _ in 0..<32 {
            guard isCurrent(), now() < deadline,
                  (try? backend.pid(current)) == proof.physicalOwner.process.pid,
                  backend.process(proof.physicalOwner.process.pid) == proof.physicalOwner.process,
                  !seen.contains(where: { backend.equal($0, current) }) else { return false }
            if backend.equal(current, proof.physicalRoot) { return true }
            seen.append(current)
            guard let parent = backend.parent, let next = try? parent(current) else { return false }
            current = next
        }
        return false
    }

    private func coherent(_ owner: NativeOwner) -> Bool {
        owner.process.pid > 0 && owner.process.parentPID > 0 && owner.identity.pid == Int(owner.process.pid) &&
            owner.identity.path == owner.process.executable && MacAppIdentity.canonicalPathShape(owner.process.executable)
    }
}

/// Public AX primitives only. Remote views which expose no verifiable cross-process AX endpoint are refused.
enum HostOwnershipNative {
    static func owner(_ pid: pid_t) throws -> NativeOwner {
        do { return try NativeIdentityReader.observe(pid: pid) }
        catch { return try NativeIdentityReader.observeHost(pid: pid) }
    }

    static func explicitlyProtected(_ owner: NativeOwner) -> Bool {
        guard let rules = try? NativeBlocklist.generated() else { return true }
        if Identity.vectorBundleIds.contains(where: { $0.caseInsensitiveCompare(owner.identity.bundleId) == .orderedSame }) { return true }
        return rules.entries.contains { entry in
            rules.never.contains(entry.category) && entry.patterns.contains { NativeBlocklist.matches($0, owner.identity.bundleId) }
        }
    }

    /// The exact open/save and QuickLook executable paths are present in Apple's shipped macOS images;
    /// PhotoPicker's ExtensionKit path and PhotosViewService's PhotosUI path are likewise observed binaries.
    /// Source evidence (paths, not a claim about a particular user's machine):
    /// github.com/blacktop/ipsw-diffs/tree/eb95d00a9ef48974f613c4b21c1c08f4b87ba644/macOS
    /// QuickLook's actual bundle ID is also used by BackgroundMusic/BGMBackgroundMusicDevice.cpp.
    /// A sharing extension is classified by its sealed public NSExtensionPointIdentifier, never its display name.
    static func eligibleKind(owner: NativeOwner, extensionPoint: String? = nil) -> NativeHostKind? {
        let identity = owner.identity
        let path = owner.process.executable
        guard owner.process.pid > 0, identity.pid == Int(owner.process.pid), identity.path == path,
              MacAppIdentity.canonicalPathShape(path), identity.verified, identity.apple, identity.system,
              identity.bundleId.hasPrefix("com.apple."), owner.childShell == false, !explicitlyProtected(owner) else { return nil }
        if identity.bundleId == "com.apple.appkit.xpc.openAndSavePanelService" &&
            path == "/System/Library/Frameworks/AppKit.framework/Versions/C/XPCServices/com.apple.appkit.xpc.openAndSavePanelService.xpc/Contents/MacOS/com.apple.appkit.xpc.openAndSavePanelService" { return .openSave }
        if identity.bundleId == "com.apple.quicklook.QuickLookUIService" &&
            path == "/System/Library/Frameworks/QuickLookUI.framework/Versions/A/XPCServices/QuickLookUIService.xpc/Contents/MacOS/QuickLookUIService" { return .quickLook }
        if path == "/System/Library/ExtensionKit/Extensions/PhotoPicker.appex/Contents/MacOS/PhotoPicker" ||
            path == "/System/Library/Frameworks/PhotosUI.framework/Versions/A/XPCServices/PhotosViewService.xpc/Contents/MacOS/PhotosViewService" { return .photoPicker }
        if extensionPoint == "com.apple.share-services", path.hasPrefix("/System/Library/"),
           path.contains(".appex/Contents/MacOS/"), !path.contains("/XPCServices/") { return .sharing }
        return nil
    }

    static func kind(_ owner: NativeOwner) throws -> NativeHostKind? {
        if let known = eligibleKind(owner: owner) { return known }
        guard owner.identity.verified, owner.identity.apple, owner.identity.system,
              owner.process.executable.hasPrefix("/System/Library/"), !explicitlyProtected(owner),
              HelperLifecycle.processIdentity(owner.process.pid) == owner.process else { return nil }
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: NSNumber(value: owner.process.pid)] as CFDictionary, [], &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, [.noNetworkAccess], nil) == errSecSuccess else { return nil }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString("anchor apple" as CFString, [], &requirement) == errSecSuccess,
              let requirement, SecCodeCheckValidity(code, [.noNetworkAccess], requirement) == errSecSuccess else { return nil }
        var staticCode: SecStaticCode?
        var information: CFDictionary?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let information else { return nil }
        let fields = information as NSDictionary
        guard (fields[kSecCodeInfoIdentifier] as? String) == owner.identity.bundleId,
              ((fields[kSecCodeInfoPlatformIdentifier] as? NSNumber)?.intValue ?? 0) > 0,
              let plist = fields[kSecCodeInfoPList] as? NSDictionary,
              (plist["CFBundleIdentifier"] as? String) == owner.identity.bundleId,
              let extensions = plist["NSExtension"] as? NSDictionary,
              let point = extensions["NSExtensionPointIdentifier"] as? String,
              HelperLifecycle.processIdentity(owner.process.pid) == owner.process else { return nil }
        return eligibleKind(owner: owner, extensionPoint: point)
    }

    static func bridges(_ surface: CaptureWindowInfo, _ surfaceOwner: NativeOwner,
                        _ isCurrent: @escaping () -> Bool, _ deadline: UInt64) throws -> [HostAXBridge] {
        let logicalPID: pid_t
        if try kind(surfaceOwner) != nil {
            guard let responsible = HelperLifecycle.responsiblePID(for: surfaceOwner.process), responsible != surface.pid else { return [] }
            logicalPID = responsible
        } else { logicalPID = surface.pid }
        guard let logicalProcess = HelperLifecycle.processIdentity(logicalPID) else { return [] }
        try check(isCurrent, deadline)
        let application = AccessibilityElement(native: AXUIElementCreateApplication(logicalPID))
        let windows = try array(application, attribute: kAXWindowsAttribute, limit: 64, isCurrent: isCurrent, deadline: deadline)
        var result: [HostAXBridge] = []
        var total = 0
        for logicalWindow in windows {
            try check(isCurrent, deadline)
            guard try AccessibilityNative.pid(logicalWindow) == logicalPID else { return [] }
            let logicalBounds = try bounds(logicalWindow)
            if surface.pid == logicalPID && logicalBounds != surface.bounds { continue }
            var pending: [(AccessibilityElement, Int)] = [(logicalWindow, 0)]
            var visited: [AccessibilityElement] = []
            while !pending.isEmpty {
                try check(isCurrent, deadline)
                let (element, depth) = pending.removeLast()
                if visited.contains(where: { AccessibilityElement.equivalent($0, element) }) { return [] }
                visited.append(element); total += 1
                guard total <= 128, depth <= 8 else { return [] }
                let pid = try AccessibilityNative.pid(element)
                if pid != logicalPID {
                    let physical = try owner(pid)
                    guard try kind(physical) != nil,
                          HelperLifecycle.responsiblePID(for: physical.process) == logicalPID,
                          surface.pid == logicalPID || surface.pid == pid else { return [] }
                    let root = try actualRoot(element, expectedPID: pid, isCurrent: isCurrent, deadline: deadline)
                    let rootBounds = try bounds(root)
                    guard CapturePrivacy.valid(rootBounds), logicalBounds.contains(rootBounds), surface.bounds.contains(rootBounds),
                          surface.pid != pid || rootBounds == surface.bounds,
                          let independent = try independentRoot(root, process: physical.process, isCurrent: isCurrent, deadline: deadline) else { return [] }
                    if !result.contains(where: { AccessibilityElement.equivalent($0.physicalRoot, root) && AccessibilityElement.equivalent($0.logicalWindow, logicalWindow) }) {
                        result.append(HostAXBridge(logicalPID: logicalPID, logicalWindow: logicalWindow, linkedRoot: root, physicalRoot: independent))
                    }
                    continue
                }
                if depth == 8 { return [] }
                let children = try array(element, attribute: kAXChildrenAttribute, limit: 128 - total - pending.count,
                                         isCurrent: isCurrent, deadline: deadline)
                pending.append(contentsOf: children.reversed().map { ($0, depth + 1) })
            }
        }
        guard HelperLifecycle.processIdentity(logicalPID) == logicalProcess else { return [] }
        return result
    }

    private static func independentRoot(_ root: AccessibilityElement, process: HelperProcessIdentity,
                                        isCurrent: @escaping () -> Bool, deadline: UInt64) throws -> AccessibilityElement? {
        let application = AccessibilityElement(native: AXUIElementCreateApplication(process.pid))
        var pending: [(AccessibilityElement, Int)] = [(application, 0)]
        var seen: [AccessibilityElement] = []
        while !pending.isEmpty {
            try check(isCurrent, deadline)
            let (element, depth) = pending.removeLast()
            guard try AccessibilityNative.pid(element) == process.pid,
                  HelperLifecycle.processIdentity(process.pid) == process,
                  !seen.contains(where: { AccessibilityElement.equivalent($0, element) }) else { return nil }
            if AccessibilityElement.equivalent(element, root) { return element }
            seen.append(element)
            guard seen.count <= 128, depth < 8 else { return nil }
            let attribute = depth == 0 ? kAXWindowsAttribute : kAXChildrenAttribute
            let children = try array(element, attribute: attribute, limit: 128 - seen.count - pending.count,
                                     isCurrent: isCurrent, deadline: deadline)
            pending.append(contentsOf: children.reversed().map { ($0, depth + 1) })
        }
        return nil
    }

    /// Prefer an actual host-owned AXWindow, otherwise retain the actual cross-process root reached by the client.
    /// No private CG window ID accessor is used; the real public surface remains separately witnessed.
    private static func actualRoot(_ element: AccessibilityElement, expectedPID: pid_t,
                                   isCurrent: @escaping () -> Bool, deadline: UInt64) throws -> AccessibilityElement {
        if let candidate = try scalar(element, attribute: kAXWindowAttribute, isCurrent: isCurrent, deadline: deadline),
           CFGetTypeID(candidate) == AXUIElementGetTypeID() {
            let wrapped = AccessibilityElement(native: unsafeBitCast(candidate, to: AXUIElement.self))
            if try AccessibilityNative.pid(wrapped) == expectedPID { return wrapped }
        }
        return element
    }

    static func parent(_ element: AccessibilityElement) throws -> AccessibilityElement? {
        let deadline = DispatchTime.now().uptimeNanoseconds + 20_000_000
        guard let value = try scalar(element, attribute: kAXParentAttribute, isCurrent: { true }, deadline: deadline),
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return AccessibilityElement(native: unsafeBitCast(value, to: AXUIElement.self))
    }

    static func bounds(_ element: AccessibilityElement) throws -> CGRect {
        let deadline = DispatchTime.now().uptimeNanoseconds + 30_000_000
        guard let position = try scalar(element, attribute: kAXPositionAttribute, isCurrent: { true }, deadline: deadline),
              let size = try scalar(element, attribute: kAXSizeAttribute, isCurrent: { true }, deadline: deadline),
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { throw unavailable }
        var point = CGPoint.zero; var dimensions = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions) else { throw unavailable }
        let bounds = CGRect(origin: point, size: dimensions)
        guard CapturePrivacy.valid(bounds) else { throw unavailable }
        return bounds
    }

    private static func array(_ element: AccessibilityElement, attribute: String, limit: Int,
                              isCurrent: @escaping () -> Bool, deadline: UInt64) throws -> [AccessibilityElement] {
        try check(isCurrent, deadline)
        guard limit >= 0, let native = element.native,
              AXUIElementSetMessagingTimeout(native, 0.01) == .success else { throw unavailable }
        var count: CFIndex = 0
        let counted = AXUIElementGetAttributeValueCount(native, attribute as CFString, &count)
        if counted == .attributeUnsupported || counted == .noValue { return [] }
        guard counted == .success, count >= 0, count <= limit else { throw unavailable }
        if count == 0 { return [] }
        try check(isCurrent, deadline)
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(native, attribute as CFString, 0, count, &values) == .success,
              let values, CFArrayGetCount(values) == count else { throw unavailable }
        try check(isCurrent, deadline)
        var result: [AccessibilityElement] = []
        for index in 0..<count {
            guard let pointer = CFArrayGetValueAtIndex(values, index) else { throw unavailable }
            let value = Unmanaged<CFTypeRef>.fromOpaque(pointer).takeUnretainedValue()
            guard CFGetTypeID(value) == AXUIElementGetTypeID() else { throw unavailable }
            result.append(AccessibilityElement(native: unsafeBitCast(value, to: AXUIElement.self)))
        }
        return result
    }

    private static func scalar(_ element: AccessibilityElement, attribute: String,
                               isCurrent: @escaping () -> Bool, deadline: UInt64) throws -> CFTypeRef? {
        try check(isCurrent, deadline)
        guard let native = element.native, AXUIElementSetMessagingTimeout(native, 0.01) == .success else { throw unavailable }
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(native, attribute as CFString, &value)
        try check(isCurrent, deadline)
        if status == .attributeUnsupported || status == .noValue { return nil }
        guard status == .success else { throw unavailable }
        return value
    }

    private static func check(_ isCurrent: () -> Bool, _ deadline: UInt64) throws {
        guard isCurrent(), DispatchTime.now().uptimeNanoseconds < deadline else { throw unavailable }
    }
    private static var unavailable: ServerFailure {
        ServerFailure(code: "unavailable", message: "Native UI host ownership could not be verified.")
    }
}
