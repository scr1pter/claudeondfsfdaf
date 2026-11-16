import CoreGraphics
import Dispatch
import Foundation

struct AccessibilityMenuAttributes {
    let role: String
    var subrole: String? = nil
    var name = ""
    var bounds: CGRect? = nil
    var enabled = true
    var focused = false
    var editable = false
    var menuShortcut: [String]? = nil
    var shortcutComplete = true
    var secure: Bool { NativeIdentityReader.isSecure(role: role, subrole: subrole) }
}

/// A real app root is independent of WindowServer. No window ID, rectangle, or hosted-panel grant is invented.
struct AccessibilityMenuWitness: Equatable {
    let root: AccessibilityElement
    let menuPath: [String]
    let runEpoch: UUID

    static func == (a: AccessibilityMenuWitness, b: AccessibilityMenuWitness) -> Bool {
        a.runEpoch == b.runEpoch && AccessibilityElement.equivalent(a.root, b.root) &&
            a.menuPath.count == b.menuPath.count && zip(a.menuPath, b.menuPath).allSatisfy { pair in pair.0.utf8.elementsEqual(pair.1.utf8) }
    }
    var valid: Bool {
        menuPath.count <= 30 && menuPath.allSatisfy { !$0.isEmpty && $0.utf16.count <= 256 &&
            AccessibilityContent.sanitize($0, limit: 256).utf8.elementsEqual($0.utf8) }
    }
}

struct AccessibilityMenuProof {
    let root: AccessibilityElement
    let element: AccessibilityElement
    let chain: [AccessibilityElement]
    let menuPath: [String]
    let attributes: AccessibilityMenuAttributes
    func witness(session: ServerSession) -> AccessibilityMenuWitness {
        AccessibilityMenuWitness(root: root, menuPath: menuPath, runEpoch: session.runEpoch)
    }
}

enum AccessibilityMenuScope {
    /// Both reads and the final commit repeat the actual independently observed root and complete same-PID
    /// ancestry. The caller authorizes this actual owner before calling; no global AX object is consulted.
    static func observe(element: AccessibilityElement, owner: NativeOwner, expectedRoot: AccessibilityElement? = nil,
                        backend: AccessibilityBackend, now: () -> UInt64, isCurrent: () -> Bool,
                        budgetMs: UInt64 = 150) throws -> AccessibilityMenuProof {
        guard let rootLookup = backend.menuRoot, let parent = backend.parent, let describe = backend.menuDescribe else { throw stale }
        let started = now(), duration = min(150, budgetMs) * 1_000_000
        let (deadline, overflow) = started.addingReportingOverflow(duration)
        guard !overflow, isCurrent(), HelperProcessShape.valid(owner.process) else { throw stale }
        let app = try backend.application(owner.process.pid)
        guard try backend.pid(app) == owner.process.pid, let root = try rootLookup(app),
              try backend.pid(root) == owner.process.pid,
              expectedRoot.map({ backend.equal($0, root) }) ?? true else { throw stale }
        var chain: [AccessibilityElement] = [], attributes: [AccessibilityMenuAttributes] = []
        var next: AccessibilityElement? = element
        while let item = next {
            guard isCurrent(), now() < deadline, chain.count < 32,
                  !chain.contains(where: { backend.equal($0, item) }), try backend.pid(item) == owner.process.pid else { throw stale }
            let value = try describe(item)
            guard !value.role.isEmpty, value.role.utf16.count <= 64, value.name.utf16.count <= 256,
                  value.subrole.map({ $0.utf16.count <= 64 }) ?? true,
                  value.bounds.map(validBounds) ?? true else { throw stale }
            chain.append(item); attributes.append(value)
            if backend.equal(item, root) {
                guard value.role == "AXMenuBar" else { throw stale }
                next = nil; break
            }
            next = try parent(item)
        }
        guard let last = chain.last, backend.equal(last, root), let first = attributes.first else { throw stale }
        var path: [String] = []
        for index in attributes.indices.reversed() {
            let value = attributes[index]
            if value.role == "AXMenuBar" || value.role == "AXMenu" { continue }
            if value.role == "AXMenuBarItem" || value.role == "AXMenuItem" || index == 0 {
                guard !value.name.isEmpty else { throw stale }
                path.append(value.name)
            }
        }
        let witness = AccessibilityMenuWitness(root: root, menuPath: path, runEpoch: UUID())
        guard witness.valid, isCurrent(), now() < deadline,
              try backend.pid(element) == owner.process.pid else { throw stale }
        let current = try backend.owner(owner.process.pid)
        guard current.process == owner.process, current.identity == owner.identity, now() < deadline else { throw stale }
        return AccessibilityMenuProof(root: root, element: element, chain: chain, menuPath: path, attributes: first)
    }

    static func validBounds(_ value: CGRect) -> Bool {
        value.minX.isFinite && value.minY.isFinite && value.width.isFinite && value.height.isFinite &&
            value.width >= 0 && value.height >= 0 && value.maxX.isFinite && value.maxY.isFinite
    }
    private static var stale: ServerFailure { ServerFailure(code: "stale_ref", message: "The native app menu changed.") }
}

private enum HelperProcessShape {
    static func valid(_ process: HelperProcessIdentity) -> Bool {
        process.pid > 0 && process.parentPID > 0 && process.startMicroseconds < 1_000_000 &&
            MacAppIdentity.canonicalPathShape(process.executable)
    }
}
