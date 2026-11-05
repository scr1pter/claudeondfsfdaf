import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Dispatch
import Foundation
import Security

/// Filesystem/LaunchServices/AppKit observations are performed only after an operation invokes the backend.
final class AppsNative {
    private struct Stamp: Equatable {
        let device: String
        let inode: String
        let mode: mode_t
        let size: Int64
        let modified: Int64
        let modifiedNS: Int64
        let changed: Int64
        let changedNS: Int64

        init(_ value: stat) {
            device = String(UInt32(truncatingIfNeeded: value.st_dev)); inode = String(value.st_ino); mode = value.st_mode
            size = Int64(value.st_size); modified = Int64(value.st_mtimespec.tv_sec); modifiedNS = Int64(value.st_mtimespec.tv_nsec)
            changed = Int64(value.st_ctimespec.tv_sec); changedNS = Int64(value.st_ctimespec.tv_nsec)
        }
        var wire: JSONValue { .array([.string(device), .string(inode), .string(String(mode)), .string(String(size)),
            .string(String(modified)), .string(String(modifiedNS)), .string(String(changed)), .string(String(changedNS))]) }
    }
    private struct StaticApp {
        let app: AppsApplication
        let executable: String
        let bundleStamp: Stamp
        let executableStamp: Stamp
        let infoStamp: Stamp
        let codeDigest: String?
    }
    private struct HashedEntry {
        let path: String
        let stamp: Stamp
    }
    private struct ContentWitness {
        let digest: String
        let entries: [HashedEntry]
        let bytes: Int
    }
    private struct LaunchSeal {
        let artifact: NativeProgramArtifact
        let root: Stamp
        let executable: String?
        let executableStamp: Stamp?
        let handler: StaticApp?
        let entries: [HashedEntry]
        let cacheBytes: Int
    }
    private let queue = DispatchQueue(label: "ai.vector.computer.app-launch")
    private let hosts = HostOwnershipResolver()
    private let lock = NSLock()
    private var seals: [String: LaunchSeal] = [:]
    private var sealOrder: [String] = []
    private var sealBytes = 0
    private var suspended = Set<pid_t>()
    private var reapers: [pid_t: DispatchSourceProcess] = [:]
    private var closed = false

    static func backend() -> AppsBackend {
        let native = AppsNative()
        var backend = AppsBackend(list: native.list, resolve: native.resolve, activate: native.activate,
            focus: native.focus, launchApp: native.launchApp, launchProgram: native.launchProgram)
        backend.cursor = native.cursor
        backend.close = native.close
        return backend
    }

    private static func canonical(_ input: String) throws -> String {
        guard !input.isEmpty, input.hasPrefix("/"), input.utf8.count <= 4096, !input.contains("\0"),
              let value = realpath(input, nil) else { throw AppsNative.unavailable }
        defer { free(value) }
        let result = String(cString: value)
        guard MacAppIdentity.canonicalPathShape(result) else { throw AppsNative.unavailable }
        return result
    }
    private static func status(_ path: String, following: Bool = false) throws -> Stamp {
        var value = stat()
        let result = following ? Darwin.stat(path, &value) : lstat(path, &value)
        guard result == 0 else { throw AppsNative.unavailable }
        return Stamp(value)
    }
    private static func regular(_ mode: mode_t) -> Bool { mode & mode_t(S_IFMT) == mode_t(S_IFREG) }
    private static func directory(_ mode: mode_t) -> Bool { mode & mode_t(S_IFMT) == mode_t(S_IFDIR) }
    private static func link(_ mode: mode_t) -> Bool { mode & mode_t(S_IFMT) == mode_t(S_IFLNK) }
    private static func name(_ value: String) -> String {
        let clean = AccessibilityContent.sanitize(value, limit: 256).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return clean.isEmpty ? "Program" : clean
    }
    private static func staticApp(_ path: String) throws -> StaticApp {
        let canonical = try self.canonical(path)
        guard canonical.lowercased().hasSuffix(".app"), !protectedArtifact(canonical) else { throw AppsNative.unavailable }
        let root = try status(canonical)
        guard directory(root.mode) else { throw AppsNative.unavailable }
        let infoPath = canonical + "/Contents/Info.plist"
        let infoStamp = try status(infoPath)
        guard regular(infoStamp.mode), infoStamp.size >= 0, infoStamp.size <= 1_048_576 else { throw AppsNative.unavailable }
        let bytes = try readSmall(infoPath, limit: 1_048_576)
        guard bytes.count <= 1_048_576, let plist = try PropertyListSerialization.propertyList(from: bytes, format: nil) as? [String: Any],
              let bundleID = plist["CFBundleIdentifier"] as? String, !bundleID.isEmpty, bundleID.utf16.count <= 255, MacAppIdentity.safeName(bundleID),
              let file = plist["CFBundleExecutable"] as? String, !file.isEmpty, file.utf8.count <= 255,
              !file.contains("/"), !file.contains("\\"), !file.contains("\0"), file != ".", file != ".." else { throw AppsNative.unavailable }
        let executable = try self.canonical(canonical + "/Contents/MacOS/" + file)
        guard child(executable, of: canonical + "/Contents/MacOS") else { throw AppsNative.unavailable }
        let executableStamp = try status(executable)
        guard regular(executableStamp.mode), executableStamp.mode & mode_t(S_ISUID | S_ISGID) == 0 else { throw AppsNative.protected }
        var code: SecStaticCode?, info: CFDictionary?
        let created = SecStaticCodeCreateWithPath(URL(fileURLWithPath: canonical) as CFURL, [], &code) == errSecSuccess
        let valid = created && code.map { SecStaticCodeCheckValidity($0, [.checkAllArchitectures, .strictValidate, .noNetworkAccess], nil) == errSecSuccess } == true
        if let code { _ = SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) }
        let fields: NSDictionary
        if let info { fields = info as NSDictionary } else { fields = NSDictionary() }
        let flags = SecCodeSignatureFlags(rawValue: (fields[kSecCodeInfoFlags] as? NSNumber)?.uint32Value ?? 0)
        let signingID = fields[kSecCodeInfoIdentifier] as? String
        let sealed = fields[kSecCodeInfoPList] as? NSDictionary
        var requirement: SecRequirement?
        let apple = valid && !flags.contains(.adhoc) && SecRequirementCreateWithString("anchor apple" as CFString, [], &requirement) == errSecSuccess &&
            code.flatMap { code in requirement.map { SecStaticCodeCheckValidity(code, [.noNetworkAccess], $0) == errSecSuccess } } == true
        let team = (fields[kSecCodeInfoTeamIdentifier] as? String).flatMap { valid && !flags.contains(.adhoc) && MacAppIdentity.validTeam($0) ? $0 : nil }
        let verified = valid && !flags.contains(.adhoc) && (apple || team != nil)
        if verified {
            guard signingID?.caseInsensitiveCompare(bundleID) == .orderedSame,
                  let sealedID = sealed?["CFBundleIdentifier"] as? String, sealedID.caseInsensitiveCompare(bundleID) == .orderedSame,
                  sealed?["CFBundleExecutable"] as? String == file else { throw AppsNative.unavailable }
        }
        let systemPath = canonical.hasPrefix("/System/") || canonical.hasPrefix("/usr/libexec/")
        let platform = ((fields[kSecCodeInfoPlatformIdentifier] as? NSNumber)?.intValue ?? 0) > 0
        if systemPath && !(verified && apple && platform) { throw AppsNative.protected }
        let identity = MacAppIdentity(bundleId: bundleID, teamId: verified ? team : nil, apple: verified && apple,
            system: systemPath && verified && apple && platform, verified: verified,
            name: name(plist["CFBundleDisplayName"] as? String ?? plist["CFBundleName"] as? String ?? URL(fileURLWithPath: canonical).deletingPathExtension().lastPathComponent),
            path: executable)
        guard MacAppIdentity(wire: identity.wire) != nil,
              try status(canonical) == root, try status(executable) == executableStamp, try status(infoPath) == infoStamp else { throw AppsNative.changed }
        return StaticApp(app: AppsApplication(identity: identity, bundlePath: canonical), executable: executable,
                         bundleStamp: root, executableStamp: executableStamp, infoStamp: infoStamp,
                         codeDigest: (fields[kSecCodeInfoUnique] as? Data).map(ProgramArtifactHash.sha256))
    }

    private func list(_ installed: Bool, _ session: ServerSession?) throws -> [AppsApplication] {
        let deadline = DispatchTime.now().uptimeNanoseconds + 4_000_000_000
        let current = { self.allowedWithoutContext() && DispatchTime.now().uptimeNanoseconds < deadline }
        let rows = try AccessibilityNative.windows()
        let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard raw.count <= 4096 else { throw Self.unavailable }
        let policy = try session.map { try SessionPolicy(session: $0) }
        let applications = NSWorkspace.shared.runningApplications
        guard applications.count <= 4096 else { throw Self.unavailable }
        var result: [AppsApplication] = []
        var indices: [pid_t: Int] = [:]
        var roots: [String] = []
        for running in applications {
            guard current() else { throw Self.unavailable }
            guard !running.isTerminated, let url = running.bundleURL,
                  let bundle = try? Self.canonical(url.path),
                  let owner = try? NativeIdentityReader.observe(pid: running.processIdentifier),
                  Self.child(owner.process.executable, of: bundle), HelperLifecycle.processIdentity(owner.process.pid) == owner.process else { continue }
            roots.append(bundle); indices[owner.process.pid] = result.count
            result.append(AppsApplication(identity: owner.identity, bundlePath: bundle, owner: owner, active: running.isActive))
        }
        var hostCandidates = 0
        for window in rows {
            guard current() else { throw Self.unavailable }
            var index = indices[window.pid]
            var target = index.flatMap { result[$0].owner }.map { NativeTarget(owner: $0, windowID: window.windowID) }
            if let session, hostCandidates < 16 {
                hostCandidates += 1
                if let proof = try? hosts.resolve(window: window, session: session, isCurrent: current),
                   let logical = indices[proof.logicalOwner.process.pid], let logicalOwner = result[logical].owner,
                   logicalOwner.process == proof.logicalOwner.process, logicalOwner.identity == proof.logicalOwner.identity,
                   logicalOwner.childShell == proof.logicalOwner.childShell {
                index = logical
                    target = NativeTarget(owner: proof.physicalOwner, windowID: window.windowID, hosted: proof)
                }
            }
            guard let index, let target, let owner = result[index].owner else { continue }
            let content = policy?.disclosure(target) == .content
            let minimized: Bool
            if window.onScreen { minimized = false }
            else {
                let surfaceOwner = window.pid == owner.process.pid ? owner : target.owner
                guard content, AXIsProcessTrusted(), let value = try? Self.minimized(window, owner: surfaceOwner) else { continue }
                minimized = value
            }
            let titleRow = raw.first { row in
                guard (row[kCGWindowNumber as String] as? NSNumber)?.stringValue == window.windowID,
                      (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == window.pid,
                      let dictionary = row[kCGWindowBounds as String] as? [String: Any],
                      let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary) else { return false }
                return bounds == window.bounds
            }
            let title = content ? titleRow?[kCGWindowName as String] as? String ?? "" : ""
            result[index].windows.append(AppsWindow(windowID: window.windowID, title: AccessibilityContent.sanitize(title),
                bounds: window.bounds, minimized: minimized, onScreen: window.onScreen))
        }
        if installed {
            for path in try Self.installedPaths() where !roots.contains(where: { Self.samePath($0, path) }) {
                guard current(), result.count < 4096 else { throw Self.unavailable }
                if let app = try? Self.staticApp(path) { result.append(app.app) }
            }
        }
        return result
    }

    private static func installedPaths() throws -> [String] {
        let roots = ["/Applications", "/System/Applications", "/System/Library/CoreServices", NSHomeDirectory() + "/Applications"]
        let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
        var pending: [(String, Int)] = roots.compactMap { (try? canonical($0)).map { ($0, 0) } }
        var seen = Set<String>(), result: [String] = []
        var count = 0
        while !pending.isEmpty {
            guard DispatchTime.now().uptimeNanoseconds < deadline, count < 8192, result.count <= 4096 else { break }
            let (path, depth) = pending.removeFirst()
            guard seen.insert(path).inserted else { continue }
            let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { continue }; defer { _ = Darwin.close(fd) }
            let names = (try? children(fd, maximum: 8192 - count)) ?? []
            for name in names {
                count += 1
                let file = path + "/" + name
                if name.lowercased().hasSuffix(".app") {
                    if let real = try? canonical(file), !protectedArtifact(real) { result.append(real) }
                } else if depth < 2, let stamp = try? status(file), directory(stamp.mode) { pending.append((file, depth + 1)) }
            }
        }
        return result
    }

    private static func minimized(_ window: CaptureWindowInfo, owner: NativeOwner) throws -> Bool {
        guard HelperLifecycle.processIdentity(window.pid) == owner.process else { throw AppsNative.changed }
        let deadline = DispatchTime.now().uptimeNanoseconds + 100_000_000
        let app = AXUIElementCreateApplication(window.pid)
        guard AXUIElementSetMessagingTimeout(app, 0.01) == .success else { throw AppsNative.unavailable }
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &count) == .success, count > 0, count <= 128 else { throw AppsNative.unavailable }
        var list: CFArray?
        guard AXUIElementCopyAttributeValues(app, kAXWindowsAttribute as CFString, 0, count, &list) == .success,
              let elements = list as? [AXUIElement], elements.count <= 128 else { throw AppsNative.unavailable }
        var matches: [Bool] = []
        for element in elements {
            guard DispatchTime.now().uptimeNanoseconds < deadline else { throw AppsNative.unavailable }
            var pid: pid_t = 0
            guard AXUIElementGetPid(element, &pid) == .success, pid == window.pid,
                  AXUIElementSetMessagingTimeout(element, 0.01) == .success else { throw AppsNative.unavailable }
            var values: CFArray?
            guard AXUIElementCopyMultipleAttributeValues(element, [kAXPositionAttribute, kAXSizeAttribute, kAXMinimizedAttribute] as CFArray, [], &values) == .success,
                  let values = values as? [AnyObject], values.count == 3,
                  CFGetTypeID(values[0]) == AXValueGetTypeID(), CFGetTypeID(values[1]) == AXValueGetTypeID() else { continue }
            var point = CGPoint.zero, size = CGSize.zero
            guard AXValueGetValue(values[0] as! AXValue, .cgPoint, &point), AXValueGetValue(values[1] as! AXValue, .cgSize, &size),
                  CGRect(origin: point, size: size) == window.bounds, CFGetTypeID(values[2]) == CFBooleanGetTypeID() else { continue }
            matches.append(CFBooleanGetValue(values[2] as! CFBoolean))
        }
        guard matches.count == 1, HelperLifecycle.processIdentity(window.pid) == owner.process else { throw AppsNative.unavailable }
        return matches[0]
    }

    private func resolve(_ input: String) throws -> AppsResolution {
        let path = try Self.canonical(input)
        if Self.protectedArtifact(path) { return .protected("security") }
        var artifactPath = path
        var appSeal: StaticApp?
        var parent = path
        for _ in 0..<32 {
            if parent.lowercased().hasSuffix(".app"), let app = try? Self.staticApp(parent) {
                if let reason = try Self.refusal(app.app.identity) { return .protected(reason) }
                if Self.samePath(path, parent) || Self.samePath(path, app.executable) { artifactPath = parent; appSeal = app }
                break
            }
            let next = URL(fileURLWithPath: parent).deletingLastPathComponent().path
            if next == parent || next == "/" { break }; parent = next
        }
        if let app = appSeal {
            let running = try list(false, nil).filter { Self.samePath($0.bundlePath, app.app.bundlePath) }
            if running.count == 1, let running = running.first { return .app(running) }
            guard running.isEmpty else { throw Self.changed }
            if app.app.identity.verified { return .app(app.app) }
        }
        let root = try Self.status(artifactPath)
        let route: NativeProgramRoute
        var handler: StaticApp?
        if let appSeal {
            guard Self.directory(root.mode), Self.samePath(artifactPath, appSeal.app.bundlePath) else { throw Self.changed }
            route = .application
        } else {
            guard Self.regular(root.mode), root.mode & mode_t(S_ISUID | S_ISGID) == 0 else { throw Self.protected }
            if root.mode & mode_t(S_IXUSR | S_IXGRP | S_IXOTH) != 0, try Self.machO(artifactPath) {
                if let reason = try Self.executableRefusal(artifactPath) { return .protected(reason) }
                route = .executable
            } else {
                let allowed: Set<String> = ["scpt", "applescript", "command", "sh", "bash", "zsh", "fish", "py", "pyw", "js", "mjs", "cjs", "ts", "rb", "pl", "lua", "swift", "workflow", "shortcut", "jar"]
                guard allowed.contains(URL(fileURLWithPath: artifactPath).pathExtension.lowercased()),
                      let url = NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: artifactPath)) else { throw Self.unavailable }
                let actual = try Self.staticApp(url.path)
                guard actual.app.identity.verified, actual.codeDigest != nil else { throw Self.unavailable }
                if let reason = try Self.refusal(actual.app.identity) { return .protected(reason) }
                handler = actual; route = .document
            }
        }
        let content = try Self.contentHash(artifactPath)
        var fields: [JSONValue] = [.string("native-artifact-v1"), .string(artifactPath), .string(route.rawValue), .string(content.digest)]
        if let handler {
            fields += [handler.app.identity.wire, .string(handler.app.bundlePath), .string(handler.codeDigest!), handler.executableStamp.wire, handler.infoStamp.wire]
        }
        let binding = try ProgramArtifactHash.binding(fields)
        let artifact = NativeProgramArtifact(path: artifactPath, name: Self.name(URL(fileURLWithPath: artifactPath).lastPathComponent),
            binding: binding, route: route, handler: handler?.app.identity, handlerPath: handler?.app.bundlePath)
        guard try Self.status(artifactPath) == root, Self.samePath(try Self.canonical(artifactPath), artifactPath),
              appSeal.map({ (try? Self.fast($0)) == true }) ?? true,
              handler.map({ (try? Self.fast($0)) == true }) ?? true else { throw Self.changed }
        let cacheBytes = content.bytes + artifactPath.utf8.count + (handler?.app.bundlePath.utf8.count ?? 0) + 4096
        guard cacheBytes <= 1_048_576 else { throw Self.unavailable }
        let seal = LaunchSeal(artifact: artifact, root: root, executable: appSeal?.executable,
            executableStamp: appSeal?.executableStamp, handler: handler, entries: content.entries, cacheBytes: cacheBytes)
        lock.lock()
        guard !closed else { lock.unlock(); throw Self.changed }
        if let prior = seals[binding] { sealBytes -= prior.cacheBytes } else { sealOrder.append(binding) }
        seals[binding] = seal; sealBytes += cacheBytes
        while sealOrder.count > 128 || sealBytes > 16 * 1_048_576 {
            if let removed = seals.removeValue(forKey: sealOrder.removeFirst()) { sealBytes -= removed.cacheBytes }
        }
        lock.unlock()
        return .program(artifact)
    }

    private static func machO(_ path: String) throws -> Bool {
        let before = try status(path), fd = try openFile(path)
        defer { _ = Darwin.close(fd) }
        var raw = stat(), bytes = [UInt8](repeating: 0, count: 4)
        guard fstat(fd, &raw) == 0, Stamp(raw) == before,
              bytes.withUnsafeMutableBytes({ Darwin.read(fd, $0.baseAddress, $0.count) }) == 4,
              fstat(fd, &raw) == 0, Stamp(raw) == before else { throw AppsNative.changed }
        return [[UInt8](arrayLiteral: 0xce, 0xfa, 0xed, 0xfe), [0xcf, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xce],
                [0xfe, 0xed, 0xfa, 0xcf], [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca], [0xca, 0xfe, 0xba, 0xbf], [0xbf, 0xba, 0xfe, 0xca]].contains(bytes)
    }
    private static func executableRefusal(_ path: String) throws -> String? {
        if NativeIdentityReader.shellExecutable(URL(fileURLWithPath: path).lastPathComponent) { return "terminal" }
        if ["/System/", "/usr/bin/", "/usr/sbin/", "/usr/libexec/", "/bin/", "/sbin/"].contains(where: path.hasPrefix) { return "security" }
        var code: SecStaticCode?, info: CFDictionary?, requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, [.noNetworkAccess], nil) == errSecSuccess,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess, let info else { return nil }
        let fields = info as NSDictionary
        let flags = SecCodeSignatureFlags(rawValue: (fields[kSecCodeInfoFlags] as? NSNumber)?.uint32Value ?? 0)
        guard !flags.contains(.adhoc) else { return nil }
        let apple = SecRequirementCreateWithString("anchor apple" as CFString, [], &requirement) == errSecSuccess &&
            requirement.map { SecStaticCodeCheckValidity(code, [.noNetworkAccess], $0) == errSecSuccess } == true
        if apple && ((fields[kSecCodeInfoPlatformIdentifier] as? NSNumber)?.intValue ?? 0) > 0 { return "security" }
        let team = (fields[kSecCodeInfoTeamIdentifier] as? String).flatMap { MacAppIdentity.validTeam($0) ? $0 : nil }
        guard apple || team != nil, let identifier = fields[kSecCodeInfoIdentifier] as? String,
              !identifier.isEmpty, identifier.utf16.count <= 255, MacAppIdentity.safeName(identifier) else { return nil }
        if let sealed = (fields[kSecCodeInfoPList] as? NSDictionary)?["CFBundleIdentifier"] as? String,
           identifier.caseInsensitiveCompare(sealed) != .orderedSame { throw AppsNative.unavailable }
        // This actual code identifier is used solely for the never-list floor; it cannot become an app grant.
        let identity = MacAppIdentity(bundleId: identifier, teamId: team, apple: apple, system: false,
            verified: true, name: name(identifier), path: path)
        return try refusal(identity)
    }

    private func cursor() throws -> AppsCursor {
        guard let event = CGEvent(source: nil) else { throw Self.unavailable }
        let point = event.location
        guard point.x.isFinite, point.y.isFinite else { throw Self.unavailable }
        let displays = try CaptureService.nativeDisplays().filter { $0.bounds.contains(point) }
        guard displays.count == 1, let display = displays.first else { throw Self.unavailable }
        return AppsCursor(point: point, displayID: display.id)
    }

    private func allowed(_ context: OperationContext) -> Bool {
        lock.lock(); let open = !closed; lock.unlock()
        return open && context.isCurrent()
    }
    private func finish(_ result: Result<Bool, ServerFailure>, context: OperationContext, done: @escaping AppsBackend.Completion) {
        done(allowed(context) ? result : .failure(Self.changed))
    }
    private func current(_ app: AppsApplication) throws -> (NSRunningApplication, NativeOwner) {
        guard let previous = app.owner, let running = NSRunningApplication(processIdentifier: previous.process.pid), !running.isTerminated,
              let url = running.bundleURL, Self.samePath(try Self.canonical(url.path), app.bundlePath) else { throw Self.changed }
        let owner = try NativeIdentityReader.observe(pid: previous.process.pid)
        guard owner.process == previous.process, owner.identity == previous.identity,
              try Self.refusal(owner.identity, childShell: owner.childShell) == nil else { throw Self.changed }
        return (running, owner)
    }

    private func activate(_ app: AppsApplication, _ context: OperationContext, _ done: @escaping AppsBackend.Completion) {
        queue.async { [self] in
            do {
                guard allowed(context) else { throw Self.changed }
                let (running, owner) = try current(app)
                DispatchQueue.main.async { [self] in
                    var accepted = false
                    guard context.withCurrent({
                        guard self.allowedWithoutContext(), HelperLifecycle.processIdentity(owner.process.pid) == owner.process else { return }
                        _ = running.unhide()
                        accepted = running.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
                    }), accepted else { finish(.failure(Self.notForeground), context: context, done: done); return }
                    confirm(app: app, window: nil, context: context, done: done)
                }
            } catch { finish(.failure(Self.failure(error)), context: context, done: done) }
        }
    }

    private func focus(_ app: AppsApplication, _ window: AppsWindow, _ context: OperationContext, _ done: @escaping AppsBackend.Completion) {
        queue.async { [self] in
            do {
                guard allowed(context), let session = context.session, AXIsProcessTrusted() else { throw Self.unavailable }
                let (running, owner) = try current(app)
                let policy = try SessionPolicy(session: session)
                let actual = try AccessibilityNative.windows().filter { $0.windowID == window.windowID }
                guard actual.count == 1, actual[0].bounds == window.bounds else { throw Self.changed }
                let proof = try hosts.resolve(window: actual[0], session: session, logicalPID: owner.process.pid,
                                              isCurrent: { self.allowed(context) })
                let target: NativeTarget
                let element: AccessibilityElement
                if let proof {
                    guard proof.logicalOwner.process == owner.process, proof.logicalOwner.identity == owner.identity,
                          proof.logicalOwner.childShell == owner.childShell else { throw Self.changed }
                    target = NativeTarget(owner: proof.physicalOwner, windowID: window.windowID, hosted: proof)
                    element = proof.physicalRoot
                } else {
                    guard actual[0].pid == owner.process.pid else { throw Self.changed }
                    target = NativeTarget(owner: owner, windowID: window.windowID)
                    try policy.requireTarget(target, operation: .activate,
                        expected: NativeExpectedTarget(process: owner.process, windowID: window.windowID))
                    element = try Self.axWindow(owner: owner, bounds: window.bounds)
                }
                let expected = NativeExpectedTarget(process: target.owner.process, windowID: window.windowID)
                try policy.requireTarget(target, operation: .activate, expected: expected)
                DispatchQueue.main.async { [self] in
                    var accepted = false
                    var failure: ServerFailure?
                    guard context.withCurrent({
                        do {
                            guard self.allowedWithoutContext(), HelperLifecycle.processIdentity(owner.process.pid) == owner.process,
                                  let native = element.native, AXUIElementSetMessagingTimeout(native, 0.01) == .success else { throw Self.changed }
                            try policy.requireTarget(target, operation: .activate, expected: expected)
                            if proof == nil {
                                let rows = try AccessibilityNative.windows().filter { $0.windowID == window.windowID }
                                guard rows.count == 1, rows[0].pid == owner.process.pid, rows[0].bounds == window.bounds else { throw Self.changed }
                            }
                            if window.minimized && AXUIElementSetAttributeValue(native, kAXMinimizedAttribute as CFString, kCFBooleanFalse) != .success { throw Self.notForeground }
                            guard AXUIElementPerformAction(native, kAXRaiseAction as CFString) == .success else { throw Self.notForeground }
                            _ = running.unhide()
                            accepted = running.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
                        } catch { failure = Self.failure(error) }
                    }), accepted else { finish(.failure(failure ?? Self.notForeground), context: context, done: done); return }
                    if let proof { confirmHosted(app: app, window: window, original: proof, context: context, done: done) }
                    else { confirm(app: app, window: element, context: context, done: done) }
                }
            } catch { finish(.failure(Self.failure(error)), context: context, done: done) }
        }
    }

    /// Refreshes the bridge outside the authority lock; foreground success must belong to the logical app,
    /// while the AX root being raised remains the actual physical host object.
    private func confirmHosted(app: AppsApplication, window: AppsWindow, original: HostedWindowProof,
                               context: OperationContext, done: @escaping AppsBackend.Completion, attempt: Int = 0) {
        queue.async { [self] in
            do {
                guard allowed(context), let session = context.session else { throw Self.changed }
                let (_, owner) = try current(app)
                let rows = try AccessibilityNative.windows().filter { $0.windowID == window.windowID }
                guard rows.count == 1, let proof = try hosts.resolve(window: rows[0], session: session, logicalPID: owner.process.pid,
                    isCurrent: { self.allowed(context) }), proof.logicalOwner.process == original.logicalOwner.process,
                    proof.logicalOwner.identity == original.logicalOwner.identity,
                    proof.physicalOwner.process == original.physicalOwner.process,
                    proof.physicalOwner.identity == original.physicalOwner.identity,
                    proof.kind == original.kind, AccessibilityElement.equivalent(proof.physicalRoot, original.physicalRoot),
                    AccessibilityElement.equivalent(proof.logicalWindow, original.logicalWindow) else { throw Self.changed }
                let target = NativeTarget(owner: proof.physicalOwner, windowID: window.windowID, hosted: proof)
                try SessionPolicy(session: session).requireTarget(target, operation: .observe)
                DispatchQueue.main.async { [self] in
                    guard allowed(context) else { finish(.failure(Self.changed), context: context, done: done); return }
                    if Self.isFocused(owner: owner, window: proof.logicalWindow),
                       proof.validAuthority(session: session, physicalOwner: proof.physicalOwner, windowID: window.windowID) {
                        finish(.success(true), context: context, done: done); return
                    }
                    guard attempt < 9 else { finish(.failure(Self.notForeground), context: context, done: done); return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(20)) {
                        self.confirmHosted(app: app, window: window, original: original, context: context, done: done, attempt: attempt + 1)
                    }
                }
            } catch { finish(.failure(Self.failure(error)), context: context, done: done) }
        }
    }

    private func launchApp(_ app: AppsApplication, _ context: OperationContext, _ done: @escaping AppsBackend.Completion) {
        if app.owner != nil { activate(app, context, done); return }
        queue.async { [self] in
            do {
                guard allowed(context), app.identity.verified else { throw Self.changed }
                let fresh = try Self.staticApp(app.bundlePath)
                guard Self.sameApp(app.identity, fresh.app.identity), try Self.refusal(fresh.app.identity) == nil else { throw Self.changed }
                DispatchQueue.main.async { [self] in
                    var started = false
                    guard context.withCurrent({
                        guard self.allowedWithoutContext(), (try? Self.fast(fresh)) == true else { return }
                        started = true
                        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: fresh.app.bundlePath), configuration: Self.configuration()) { running, error in
                            self.launched(running, error: error, expected: fresh, context: context, done: done)
                        }
                    }), started else { finish(.failure(Self.changed), context: context, done: done); return }
                }
            } catch { finish(.failure(Self.failure(error)), context: context, done: done) }
        }
    }

    private func launchProgram(_ artifact: NativeProgramArtifact, _ context: OperationContext, _ done: @escaping AppsBackend.Completion) {
        queue.async { [self] in
            do {
                guard allowed(context), case .program(let fresh) = try resolve(artifact.path), ProgramArtifactHash.same(artifact, fresh) else { throw Self.changed }
                lock.lock(); let seal = seals[artifact.binding]; lock.unlock()
                guard let seal, ProgramArtifactHash.same(seal.artifact, artifact) else { throw Self.changed }
                if artifact.route == .executable { try spawn(seal, context: context); finish(.success(true), context: context, done: done); return }
                let expected = artifact.route == .application ? try Self.staticApp(artifact.path) : seal.handler
                guard let expected, try fast(seal) else { throw Self.unavailable }
                DispatchQueue.main.async { [self] in
                    var started = false
                    guard context.withCurrent({
                        guard self.allowedWithoutContext(), (try? self.fast(seal)) == true else { return }
                        started = true
                        let callback: (NSRunningApplication?, Error?) -> Void = { running, error in
                            self.launched(running, error: error, expected: expected, context: context, done: done, requireForeground: false)
                        }
                        if artifact.route == .application {
                            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: artifact.path), configuration: Self.configuration(), completionHandler: callback)
                        } else {
                            NSWorkspace.shared.open([URL(fileURLWithPath: artifact.path)], withApplicationAt: URL(fileURLWithPath: expected.app.bundlePath),
                                configuration: Self.configuration(), completionHandler: callback)
                        }
                    }), started else { finish(.failure(Self.changed), context: context, done: done); return }
                }
            } catch { finish(.failure(Self.failure(error)), context: context, done: done) }
        }
    }

    private func launched(_ running: NSRunningApplication?, error: Error?, expected: StaticApp, context: OperationContext,
                          done: @escaping AppsBackend.Completion, requireForeground: Bool = true) {
        queue.async { [self] in
            do {
                guard allowed(context), error == nil, let running, !running.isTerminated,
                      let root = running.bundleURL, Self.samePath(try Self.canonical(root.path), expected.app.bundlePath) else { throw Self.unavailable }
                let owner = try NativeIdentityReader.observe(pid: running.processIdentifier)
                guard Self.sameApp(owner.identity, expected.app.identity), Self.samePath(owner.process.executable, expected.executable),
                      HelperLifecycle.responsiblePID(for: owner.process) == owner.process.pid else { throw Self.changed }
                let app = AppsApplication(identity: owner.identity, bundlePath: expected.app.bundlePath, owner: owner)
                if requireForeground { DispatchQueue.main.async { self.confirm(app: app, window: nil, context: context, done: done) } }
                else { finish(.success(true), context: context, done: done) }
            } catch { finish(.failure(Self.failure(error)), context: context, done: done) }
        }
    }

    private func confirm(app: AppsApplication, window: AccessibilityElement?, context: OperationContext,
                         done: @escaping AppsBackend.Completion, attempt: Int = 0) {
        guard allowed(context), let owner = app.owner, HelperLifecycle.processIdentity(owner.process.pid) == owner.process else {
            finish(.failure(Self.changed), context: context, done: done); return
        }
        let focused = Self.isFocused(owner: owner, window: window)
        if focused { finish(.success(true), context: context, done: done); return }
        guard attempt < 100 else { finish(.failure(Self.notForeground), context: context, done: done); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(20)) {
            self.confirm(app: app, window: window, context: context, done: done, attempt: attempt + 1)
        }
    }

    private static func isFocused(owner: NativeOwner, window: AccessibilityElement?) -> Bool {
        guard HelperLifecycle.processIdentity(owner.process.pid) == owner.process,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == owner.process.pid else { return false }
        guard let window else { return true }
        do {
            let app = try AccessibilityNative.application(owner.process.pid)
            guard let native = app.native, let expected = window.native else { return false }
            var raw: CFTypeRef?
            guard AXUIElementSetMessagingTimeout(native, 0.01) == .success,
                  AXUIElementCopyAttributeValue(native, kAXFocusedWindowAttribute as CFString, &raw) == .success,
                  let raw, CFGetTypeID(raw) == AXUIElementGetTypeID(), CFEqual(raw, expected),
                  HelperLifecycle.processIdentity(owner.process.pid) == owner.process else { return false }
            return true
        } catch { return false }
    }

    private static func axWindow(owner: NativeOwner, bounds: CGRect) throws -> AccessibilityElement {
        guard HelperLifecycle.processIdentity(owner.process.pid) == owner.process else { throw AppsNative.changed }
        let deadline = DispatchTime.now().uptimeNanoseconds + 100_000_000
        let app = AXUIElementCreateApplication(owner.process.pid)
        guard AXUIElementSetMessagingTimeout(app, 0.01) == .success else { throw AppsNative.unavailable }
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &count) == .success, count > 0, count <= 128 else { throw AppsNative.unavailable }
        var list: CFArray?
        guard AXUIElementCopyAttributeValues(app, kAXWindowsAttribute as CFString, 0, count, &list) == .success,
              let elements = list as? [AXUIElement], elements.count <= 128 else { throw AppsNative.unavailable }
        var matches: [AccessibilityElement] = []
        for element in elements {
            guard DispatchTime.now().uptimeNanoseconds < deadline else { throw AppsNative.unavailable }
            var pid: pid_t = 0
            guard AXUIElementGetPid(element, &pid) == .success, pid == owner.process.pid,
                  AXUIElementSetMessagingTimeout(element, 0.01) == .success else { throw AppsNative.changed }
            var values: CFArray?
            guard AXUIElementCopyMultipleAttributeValues(element, [kAXRoleAttribute, kAXPositionAttribute, kAXSizeAttribute] as CFArray, [], &values) == .success,
                  let values = values as? [AnyObject], values.count == 3,
                  AccessibilityNative.completeString(values[0], limit: 64) == "AXWindow",
                  CFGetTypeID(values[1]) == AXValueGetTypeID(), CFGetTypeID(values[2]) == AXValueGetTypeID(),
                  AXValueGetType(values[1] as! AXValue) == .cgPoint, AXValueGetType(values[2] as! AXValue) == .cgSize else { continue }
            var point = CGPoint.zero, size = CGSize.zero
            guard AXValueGetValue(values[1] as! AXValue, .cgPoint, &point), AXValueGetValue(values[2] as! AXValue, .cgSize, &size) else { continue }
            if CGRect(origin: point, size: size) == bounds { matches.append(AccessibilityElement(native: element)) }
        }
        guard matches.count == 1, HelperLifecycle.processIdentity(owner.process.pid) == owner.process else { throw AppsNative.unavailable }
        return matches[0]
    }
    private static func configuration() -> NSWorkspace.OpenConfiguration {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true; configuration.createsNewApplicationInstance = false
        configuration.promptsUserIfNeeded = false; configuration.addsToRecentItems = false
        configuration.allowsRunningApplicationSubstitution = false
        configuration.arguments = []; configuration.environment = ["PATH": "/usr/bin:/bin"]
        return configuration
    }
    private static func sameApp(_ first: MacAppIdentity, _ second: MacAppIdentity) -> Bool {
        first.key == second.key && first.teamId == second.teamId && first.apple == second.apple && first.system == second.system && first.verified == second.verified
    }
    private static func fast(_ app: StaticApp) throws -> Bool {
        try status(app.app.bundlePath) == app.bundleStamp && status(app.executable) == app.executableStamp &&
            status(app.app.bundlePath + "/Contents/Info.plist") == app.infoStamp && samePath(canonical(app.app.bundlePath), app.app.bundlePath)
    }
    private func fast(_ seal: LaunchSeal) throws -> Bool {
        let deadline = DispatchTime.now().uptimeNanoseconds + 50_000_000
        guard !Self.protectedArtifact(seal.artifact.path), try Self.status(seal.artifact.path) == seal.root, Self.samePath(try Self.canonical(seal.artifact.path), seal.artifact.path) else { return false }
        if let executable = seal.executable, let stamp = seal.executableStamp, try Self.status(executable) != stamp { return false }
        if let handler = seal.handler, try !Self.fast(handler) { return false }
        guard DispatchTime.now().uptimeNanoseconds < deadline else { return false }
        if !seal.entries.isEmpty {
            let fd = try Self.openFile(seal.artifact.path, deadline: deadline)
            defer { _ = Darwin.close(fd) }
            var raw = stat()
            guard fstat(fd, &raw) == 0, Stamp(raw) == seal.root else { return false }
            for entry in seal.entries {
                guard DispatchTime.now().uptimeNanoseconds < deadline,
                      !Self.protectedArtifact(seal.artifact.path + "/" + entry.path),
                      try Self.relativeStamp(root: fd, path: entry.path, deadline: deadline) == entry.stamp else { return false }
            }
            guard DispatchTime.now().uptimeNanoseconds < deadline, fstat(fd, &raw) == 0, Stamp(raw) == seal.root else { return false }
        }
        return DispatchTime.now().uptimeNanoseconds < deadline
    }
    private func allowedWithoutContext() -> Bool { lock.lock(); defer { lock.unlock() }; return !closed }
    private static var notForeground: ServerFailure { ServerFailure(code: "not_foreground", message: "The app window did not become foreground.") }
    private static func failure(_ error: Error) -> ServerFailure { error as? ServerFailure ?? unavailable }

    private func spawn(_ seal: LaunchSeal, context: OperationContext) throws {
        guard seal.artifact.route == .executable, seal.handler == nil else { throw Self.unavailable }
        let fd = try Self.openFile(seal.artifact.path)
        defer { _ = Darwin.close(fd) }
        var file = stat()
        guard fstat(fd, &file) == 0, Stamp(file) == seal.root, file.st_nlink == 1,
              file.st_mode & mode_t(S_ISUID | S_ISGID) == 0 else { throw Self.changed }
        var child: pid_t = 0
        defer { if child > 0 { stop(child) } }
        var failure: Error?
        guard context.withCurrent({
            self.lock.lock(); defer { self.lock.unlock() }
            guard !self.closed else { return }
            do {
                guard try self.fast(seal) else { throw Self.changed }
                child = try Self.spawnSuspended(seal.artifact.path)
                self.suspended.insert(child)
            } catch { failure = error }
        }), child > 0 else { throw failure ?? Self.changed }
        guard allowed(context), let process = HelperLifecycle.processIdentity(child), Self.samePath(process.executable, seal.artifact.path),
              Self.ordinary(child), HelperLifecycle.responsiblePID(for: process) == child,
              Self.mappedExecutable(process, expected: seal.root), fstat(fd, &file) == 0, Stamp(file) == seal.root else { throw Self.changed }
        var resumed = false
        guard context.withCurrent({
            self.lock.lock(); defer { self.lock.unlock() }
            guard !self.closed, self.suspended.contains(child), HelperLifecycle.processIdentity(child) == process,
                  HelperLifecycle.responsiblePID(for: process) == child, fstat(fd, &file) == 0, Stamp(file) == seal.root,
                  (try? self.fast(seal)) == true, Darwin.kill(child, SIGCONT) == 0 else { return }
            self.suspended.remove(child)
            resumed = true
        }), resumed else { throw Self.changed }
        let launched = child; child = 0
        reapWhenExited(launched)
    }

    private static func spawnSuspended(_ path: String) throws -> pid_t {
        guard getuid() != 0, geteuid() == getuid(), getegid() == getgid() else { throw AppsNative.protected }
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw AppsNative.unavailable }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { throw AppsNative.unavailable }
        defer { posix_spawnattr_destroy(&attributes) }
        var defaults = sigset_t(), mask = sigset_t()
        sigfillset(&defaults); sigemptyset(&mask)
        let flags = Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)
        guard posix_spawnattr_setflags(&attributes, flags) == 0, posix_spawnattr_setpgroup(&attributes, 0) == 0,
              posix_spawnattr_setsigdefault(&attributes, &defaults) == 0, posix_spawnattr_setsigmask(&attributes, &mask) == 0,
              HelperLifecycle.disclaimSpawn(&attributes),
              posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0,
              posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) == 0,
              posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0 else { throw AppsNative.unavailable }
        let arguments = [strdup(path)], variables = ["PATH=/usr/bin:/bin", "HOME=" + NSHomeDirectory(), "TMPDIR=" + NSTemporaryDirectory()].map { strdup($0) }
        defer { arguments.forEach { free($0) }; variables.forEach { free($0) } }
        guard arguments.allSatisfy({ $0 != nil }), variables.allSatisfy({ $0 != nil }) else { throw AppsNative.unavailable }
        var argv = arguments + [nil], envp = variables + [nil], pid: pid_t = 0
        guard posix_spawn(&pid, path, &actions, &attributes, &argv, &envp) == 0, pid > 0 else { throw AppsNative.unavailable }
        return pid
    }

    private static func ordinary(_ pid: pid_t) -> Bool {
        var process = proc_bsdinfo()
        return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size) &&
            process.pbi_uid == geteuid() && process.pbi_ruid == getuid() && process.pbi_gid == getegid() && process.pbi_rgid == getgid()
    }

    /// The paused image's vnode must be the exact file whose bytes were hashed, not a same-path replacement.
    private static func mappedExecutable(_ process: HelperProcessIdentity, expected: Stamp) -> Bool {
        let deadline = DispatchTime.now().uptimeNanoseconds + 50_000_000
        var address: UInt64 = 0
        for _ in 0..<128 {
            guard DispatchTime.now().uptimeNanoseconds < deadline, HelperLifecycle.processIdentity(process.pid) == process else { return false }
            var region = proc_regionwithpathinfo()
            guard proc_pidinfo(process.pid, PROC_PIDREGIONPATHINFO, address, &region, Int32(MemoryLayout<proc_regionwithpathinfo>.size)) == Int32(MemoryLayout<proc_regionwithpathinfo>.size) else { return false }
            let vnode = region.prp_vip.vip_vi.vi_stat
            let name = withUnsafeBytes(of: region.prp_vip.vip_path) { bytes -> String? in
                guard let end = bytes.firstIndex(of: 0) else { return nil }; return String(bytes: bytes.prefix(end), encoding: .utf8)
            }
            if let name, samePath(name, process.executable), String(vnode.vst_dev) == expected.device, String(vnode.vst_ino) == expected.inode,
               Int64(vnode.vst_size) == expected.size, vnode.vst_mode == expected.mode,
               Int64(vnode.vst_mtime) == expected.modified, Int64(vnode.vst_mtimensec) == expected.modifiedNS,
               Int64(vnode.vst_ctime) == expected.changed, Int64(vnode.vst_ctimensec) == expected.changedNS { return true }
            let start = region.prp_prinfo.pri_address, size = region.prp_prinfo.pri_size
            guard size > 0, start <= UInt64.max - size, start + size > address else { return false }
            address = start + size
        }
        return false
    }

    private func close() {
        lock.lock(); closed = true; let children = Array(suspended); seals.removeAll(); sealOrder.removeAll(); sealBytes = 0; lock.unlock()
        let deadline = DispatchTime.now().uptimeNanoseconds + 200_000_000
        for child in children { stop(child, deadline: deadline) }
    }
    private func stop(_ child: pid_t, deadline: UInt64 = DispatchTime.now().uptimeNanoseconds + 200_000_000) {
        lock.lock()
        guard suspended.contains(child) else { lock.unlock(); return }
        _ = Darwin.kill(child, SIGKILL)
        lock.unlock()
        while DispatchTime.now().uptimeNanoseconds < deadline {
            lock.lock()
            guard suspended.contains(child) else { lock.unlock(); return }
            var status: Int32 = 0
            let result = waitpid(child, &status, WNOHANG)
            if result == child || (result == -1 && errno == ECHILD) { suspended.remove(child); lock.unlock(); return }
            lock.unlock(); usleep(5_000)
        }
        queue.asyncAfter(deadline: .now() + .milliseconds(20)) { self.stop(child) }
    }
    private func reapWhenExited(_ child: pid_t) {
        lock.lock()
        var status: Int32 = 0
        if waitpid(child, &status, WNOHANG) == child { lock.unlock(); return }
        let watch = DispatchSource.makeProcessSource(identifier: child, eventMask: .exit, queue: queue)
        reapers[child] = watch
        watch.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            var status: Int32 = 0
            _ = waitpid(child, &status, WNOHANG)
            self.reapers.removeValue(forKey: child)?.cancel()
            self.lock.unlock()
        }
        watch.resume()
        if waitpid(child, &status, WNOHANG) == child { reapers.removeValue(forKey: child)?.cancel() }
        lock.unlock()
    }

    private static func refusal(_ identity: MacAppIdentity, childShell: Bool? = false) throws -> String? {
        let blocklist = try NativeBlocklist.generated()
        let category = blocklist.category(identity, childShell: childShell == true)
        guard childShell != nil || category == "developer" else { throw AppsNative.unavailable }
        if category == "system-ui" { return "security" }
        guard blocklist.never.contains(category) else { return nil }
        switch category {
        case "vector": return "vector"
        case "terminal", "scripting": return "terminal"
        case "password-manager": return "passwords"
        case "remote-viewer": return "remote"
        default: return "security"
        }
    }

    private static func readSmall(_ path: String, limit: Int) throws -> Data {
        let before = try status(path)
        guard regular(before.mode), before.size >= 0, before.size <= limit else { throw AppsNative.unavailable }
        let fd = try openFile(path)
        guard fd >= 0 else { throw AppsNative.unavailable }; defer { _ = Darwin.close(fd) }
        var raw = stat()
        guard fstat(fd, &raw) == 0, Stamp(raw) == before else { throw AppsNative.changed }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count == 0 { break }
            if count < 0 { if errno == EINTR { continue }; throw AppsNative.unavailable }
            guard data.count <= limit - count else { throw AppsNative.unavailable }
            data.append(contentsOf: buffer.prefix(count))
        }
        guard fstat(fd, &raw) == 0, Stamp(raw) == before, try status(path) == before else { throw AppsNative.changed }
        return data
    }

    private static func openFile(_ path: String, deadline: UInt64? = nil) throws -> Int32 {
        if path == "/" {
            let fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
            guard fd >= 0 else { throw AppsNative.unavailable }; return fd
        }
        let parts = path.split(separator: "/").map(String.init)
        guard path.hasPrefix("/"), !parts.isEmpty, parts.count <= 256 else { throw AppsNative.unavailable }
        var fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard fd >= 0 else { throw AppsNative.unavailable }
        for component in parts.dropLast() {
            if let deadline, DispatchTime.now().uptimeNanoseconds >= deadline { _ = Darwin.close(fd); throw AppsNative.unavailable }
            let next = openat(fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            _ = Darwin.close(fd)
            guard next >= 0 else { throw AppsNative.unavailable }; fd = next
        }
        if let deadline, DispatchTime.now().uptimeNanoseconds >= deadline { _ = Darwin.close(fd); throw AppsNative.unavailable }
        let result = openat(fd, parts.last!, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        _ = Darwin.close(fd)
        guard result >= 0 else { throw AppsNative.unavailable }; return result
    }
    private static func child(_ path: String, of root: String) -> Bool { path.utf8.starts(with: Array(root.utf8) + [47]) }
    private static func samePath(_ first: String, _ second: String) -> Bool { first.utf8.elementsEqual(second.utf8) }

    private static func protectedArtifact(_ path: String) -> Bool {
        let lower = path.lowercased(), parts = lower.split(separator: "/").map(String.init)
        if parts.contains(where: { [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".config", ".vector", ".claude", ".codex", ".cursor", "brain"].contains($0) }) { return true }
        if let name = parts.last, name == ".env" || name.hasPrefix(".env.") ||
            ["credentials", "credentials.json", "id_rsa", "id_ed25519", "agents", "agents.md", "claude", "claude.md", "context", "context.md", "rules", "rules.md", "brain", "memory.md", "vector.json", ".cursorrules", ".clinerules", ".windsurfrules", "copilot-instructions.md"].contains(name) { return true }
        return protectedRoots.contains { lower == $0 || lower.hasPrefix($0 + "/") }
    }
    private static let protectedRoots: [String] = {
        let roots = ["/etc", "/private/etc", "/var/db", "/private/var/db", "/var/root", "/private/var/root", "/Library/Keychains",
            NSHomeDirectory() + "/Library/Keychains", NSHomeDirectory() + "/.config", NSHomeDirectory() + "/.vector"]
        return roots.flatMap { [$0.lowercased(), ((try? canonical($0)) ?? $0).lowercased()] }
    }()

    private struct HashBudget {
        var entries = 0
        var bytes: Int64 = 0
        var metadataBytes = 0
        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
        mutating func check(_ bytes: Int = 0) throws {
            guard entries <= 4096, bytes >= 0, self.bytes <= 512 * 1024 * 1024 - Int64(bytes),
                  DispatchTime.now().uptimeNanoseconds < deadline else { throw AppsNative.unavailable }
            self.bytes += Int64(bytes)
        }
    }
    /// All descendants are traversed with directory-relative O_NOFOLLOW handles. Symlinks are hashed as links,
    /// never followed into a user's unrelated files; their resolved target must remain inside this artifact.
    private static func contentHash(_ path: String) throws -> ContentWitness {
        guard !protectedArtifact(path) else { throw AppsNative.protected }
        let root = try status(path)
        var budget = HashBudget()
        if regular(root.mode) {
            let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
            let parentStamp = try status(parent)
            let fd = try openFile(parent)
            guard fd >= 0 else { throw AppsNative.unavailable }; defer { _ = Darwin.close(fd) }
            var raw = stat()
            guard fstat(fd, &raw) == 0, Stamp(raw) == parentStamp else { throw AppsNative.changed }
            let digest = try hashFile(parent: fd, name: URL(fileURLWithPath: path).lastPathComponent, stamp: root, budget: &budget)
            guard try status(path) == root else { throw AppsNative.changed }
            return ContentWitness(digest: try ProgramArtifactHash.binding([.string("file"), .string(digest)]), entries: [], bytes: 0)
        }
        guard directory(root.mode) else { throw AppsNative.unavailable }
        let fd = try openFile(path)
        defer { _ = Darwin.close(fd) }
        var raw = stat()
        guard fstat(fd, &raw) == 0, directory(raw.st_mode), Stamp(raw) == root else { throw AppsNative.changed }
        var manifest: [JSONValue] = []
        var observed: [HashedEntry] = []
        try walk(fd: fd, root: path, relative: "", depth: 0, budget: &budget, manifest: &manifest, observed: &observed)
        for entry in observed {
            try budget.check()
            guard try relativeStamp(root: fd, path: entry.path) == entry.stamp else { throw AppsNative.changed }
        }
        guard fstat(fd, &raw) == 0, Stamp(raw) == root, try status(path) == root else { throw AppsNative.changed }
        return ContentWitness(digest: try ProgramArtifactHash.binding(manifest), entries: observed, bytes: budget.metadataBytes)
    }

    private static func children(_ fd: Int32, maximum: Int) throws -> [String] {
        let copy = dup(fd)
        guard copy >= 0 else { throw AppsNative.unavailable }
        guard fcntl(copy, F_SETFD, FD_CLOEXEC) == 0, let directory = fdopendir(copy) else { _ = Darwin.close(copy); throw AppsNative.unavailable }
        defer { closedir(directory) }
        var names: [String] = []
        errno = 0
        while let row = readdir(directory) {
            let name = withUnsafeBytes(of: row.pointee.d_name) { data -> String? in
                guard let end = data.firstIndex(of: 0) else { return nil }
                return String(bytes: data.prefix(end), encoding: .utf8)
            }
            guard let name else { throw AppsNative.unavailable }
            if name == "." || name == ".." { continue }
            guard !name.isEmpty, !name.contains("/"), names.count < maximum else { throw AppsNative.unavailable }
            names.append(name); errno = 0
        }
        guard errno == 0 else { throw AppsNative.unavailable }
        return names.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
    }

    private static func relativeStamp(root: Int32, path: String, deadline: UInt64? = nil) throws -> Stamp {
        let parts = path.split(separator: "/").map(String.init)
        guard !parts.isEmpty, parts.count <= 25 else { throw AppsNative.unavailable }
        var parent = dup(root)
        guard parent >= 0 else { throw AppsNative.unavailable }; defer { _ = Darwin.close(parent) }
        for part in parts.dropLast() {
            if let deadline, DispatchTime.now().uptimeNanoseconds >= deadline { throw AppsNative.unavailable }
            let next = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw AppsNative.changed }; _ = Darwin.close(parent); parent = next
        }
        if let deadline, DispatchTime.now().uptimeNanoseconds >= deadline { throw AppsNative.unavailable }
        var raw = stat()
        guard fstatat(parent, parts.last!, &raw, AT_SYMLINK_NOFOLLOW) == 0 else { throw AppsNative.changed }
        return Stamp(raw)
    }

    private static func walk(fd: Int32, root: String, relative: String, depth: Int, budget: inout HashBudget,
                             manifest: inout [JSONValue], observed: inout [HashedEntry]) throws {
        guard depth <= 24 else { throw AppsNative.unavailable }
        try budget.check()
        for name in try children(fd, maximum: 4096 - budget.entries) {
            try budget.check(); budget.entries += 1
            let path = relative.isEmpty ? name : relative + "/" + name
            guard path.utf8.count <= 4096 else { throw AppsNative.unavailable }
            guard !protectedArtifact(root + "/" + path) else { throw AppsNative.protected }
            var raw = stat()
            guard fstatat(fd, name, &raw, AT_SYMLINK_NOFOLLOW) == 0 else { throw AppsNative.changed }
            let before = Stamp(raw)
            budget.metadataBytes += path.utf8.count + 256
            guard budget.metadataBytes <= 1_048_576 else { throw AppsNative.unavailable }
            observed.append(HashedEntry(path: path, stamp: before))
            if regular(before.mode) {
                let digest = try hashFile(parent: fd, name: name, stamp: before, budget: &budget)
                manifest.append(.array([.string(path), .string("file"), .string(digest)]))
            } else if directory(before.mode) {
                let child = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard child >= 0 else { throw AppsNative.changed }; defer { _ = Darwin.close(child) }
                var current = stat()
                guard fstat(child, &current) == 0, Stamp(current) == before else { throw AppsNative.changed }
                manifest.append(.array([.string(path), .string("directory")]))
                try walk(fd: child, root: root, relative: path, depth: depth + 1, budget: &budget, manifest: &manifest, observed: &observed)
                guard fstat(child, &current) == 0, Stamp(current) == before else { throw AppsNative.changed }
            } else if link(before.mode) {
                var bytes = [UInt8](repeating: 0, count: 4097)
                let count = bytes.withUnsafeMutableBytes { readlinkat(fd, name, $0.baseAddress!.assumingMemoryBound(to: CChar.self), $0.count) }
                guard count > 0, count <= 4096, let target = String(bytes: bytes.prefix(count), encoding: .utf8),
                      !target.contains("\0") else { throw AppsNative.unavailable }
                let resolved = try canonical(root + "/" + path)
                guard child(resolved, of: root), !protectedArtifact(resolved) else { throw AppsNative.protected }
                let relativeTarget = String(decoding: resolved.utf8.dropFirst(root.utf8.count + 1), as: UTF8.self)
                manifest.append(.array([.string(path), .string("symlink"), .string(target), .string(relativeTarget)]))
            } else { throw AppsNative.protected }
        }
    }

    private static func hashFile(parent: Int32, name: String, stamp: Stamp, budget: inout HashBudget) throws -> String {
        guard regular(stamp.mode), stamp.mode & mode_t(S_ISUID | S_ISGID) == 0, stamp.size >= 0,
              stamp.size <= 512 * 1024 * 1024 else { throw AppsNative.protected }
        let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw AppsNative.unavailable }; defer { _ = Darwin.close(fd) }
        var raw = stat()
        guard fstat(fd, &raw) == 0, Stamp(raw) == stamp, raw.st_nlink == 1 else { throw AppsNative.changed }
        var hasher = SHA256(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            try budget.check()
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count == 0 { break }
            if count < 0 { if errno == EINTR { continue }; throw AppsNative.unavailable }
            try budget.check(count)
            hasher.update(data: Data(buffer.prefix(count)))
        }
        guard fstat(fd, &raw) == 0, Stamp(raw) == stamp else { throw AppsNative.changed }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static var unavailable: ServerFailure { ServerFailure(code: "app_not_found", message: "The native app or verified launch route is unavailable.") }
    private static var changed: ServerFailure { ServerFailure(code: "changed", message: "The app or launch artifact changed.") }
    private static var protected: ServerFailure { ServerFailure(code: "protected", message: "This native launch target is protected.") }
}
