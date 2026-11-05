import AppKit
import ApplicationServices
import Carbon
import Darwin
import Foundation
import Security

struct MacAppIdentity: Equatable {
    let bundleId: String
    let teamId: String?
    let apple: Bool
    let system: Bool
    let verified: Bool
    let name: String
    let path: String?
    let pid: Int?

    init(bundleId: String, teamId: String? = nil, apple: Bool, system: Bool, verified: Bool,
         name: String, path: String? = nil, pid: Int? = nil) {
        self.bundleId = bundleId; self.teamId = teamId; self.apple = apple; self.system = system
        self.verified = verified; self.name = name; self.path = path; self.pid = pid
    }

    init?(wire: JSONValue) {
        let required: Set<String> = ["platform", "bundleId", "apple", "system", "verified", "name"]
        guard let fields = wire.objectValue, required.isSubset(of: Set(fields.keys)),
              Set(fields.keys).isSubset(of: required.union(["teamId", "path", "pid"])),
              fields["platform"]?.stringValue == "macos", let bundle = fields["bundleId"]?.stringValue,
              !bundle.isEmpty, bundle.utf16.count <= 255, MacAppIdentity.safeName(bundle),
              let apple = fields["apple"]?.boolValue, let system = fields["system"]?.boolValue,
              let verified = fields["verified"]?.boolValue, let name = fields["name"]?.stringValue,
              name.utf16.count <= 256, MacAppIdentity.safeName(name) else { return nil }
        if let team = fields["teamId"], team.stringValue.map(MacAppIdentity.validTeam) != true { return nil }
        if let file = fields["path"], file.stringValue.map({ !$0.isEmpty && $0.utf16.count <= 4096 && !$0.contains("\0") }) != true { return nil }
        if let pid = fields["pid"], pid.intValue == nil || pid.intValue! <= 0 || pid.intValue! > Int(Int32.max) { return nil }
        self.init(bundleId: bundle, teamId: fields["teamId"]?.stringValue, apple: apple, system: system,
                  verified: verified, name: name, path: fields["path"]?.stringValue, pid: fields["pid"]?.intValue)
    }

    var key: String { "app:macos:" + bundleId.lowercased() }
    var wire: JSONValue {
        var fields: [String: JSONValue] = ["platform": .string("macos"), "bundleId": .string(bundleId),
            "apple": .bool(apple), "system": .bool(system), "verified": .bool(verified), "name": .string(name)]
        if let teamId { fields["teamId"] = .string(teamId) }
        if let path { fields["path"] = .string(path) }
        if let pid { fields["pid"] = .integer(Int64(pid)) }
        return .object(fields)
    }

    static func validTeam(_ value: String) -> Bool {
        value.utf8.count == 10 && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) }
    }

    static func safeName(_ value: String) -> Bool {
        !value.unicodeScalars.contains { scalar in
            scalar.value < 0x20 || (0x7f...0x9f).contains(scalar.value) || scalar.value == 0x061c ||
                (0x200b...0x200f).contains(scalar.value) || (0x2028...0x202e).contains(scalar.value) ||
                (0x2060...0x2069).contains(scalar.value) || scalar.value == 0xfeff
        }
    }

    static func canonicalPathShape(_ value: String) -> Bool {
        value.hasPrefix("/") && !value.hasPrefix("//") && !value.contains("\0") && value.utf16.count <= 4096 &&
            URL(fileURLWithPath: value).standardizedFileURL.path == value
    }
}

/// An observation of a running process, not an identity supplied in a request or approval.
struct NativeOwner {
    let identity: MacAppIdentity
    let process: HelperProcessIdentity
    /// nil means enumeration was incomplete; it must never be converted into a negative observation.
    let childShell: Bool?
}

struct NativeTarget {
    let owner: NativeOwner
    var windowID: String? = nil
    var ref: String? = nil
    var elementID: String? = nil
    /// nil means the focused field's security could not be observed.
    var secure: Bool? = nil
}

struct NativeExpectedTarget {
    var pid: Int? = nil
    var process: HelperProcessIdentity? = nil
    var windowID: String? = nil
    var ref: String? = nil
    var elementID: String? = nil
}

enum NativeOperation {
    case observe, capture, activate, pointer, type, setValue
    case key([String]), hold([String])

    var typesText: Bool {
        switch self {
        case .type, .setValue: return true
        case .key(let keys), .hold(let keys): return NativeBlocklist.keyTypesText(keys)
        default: return false
        }
    }
    var needsKeyboardPID: Bool {
        switch self { case .type, .key, .hold: return true; default: return false }
    }
}

enum NativeDisclosure: Equatable { case structural, content }

struct NativeBlocklist {
    struct Entry {
        let key: String
        let category: String
        let list: String
        let patterns: [String]
    }
    let entries: [Entry]
    let never: Set<String>
    let clickOnly: Set<String>

    static func generated() throws -> NativeBlocklist { try NativeBlocklist(json: Blocklist.json) }

    init(json: String) throws {
        let categories: Set<String> = ["vector", "terminal", "scripting", "password-manager", "security", "remote-viewer",
            "browser", "files", "mail", "messaging", "finance", "developer", "office", "creative", "simulator", "system-ui", "general"]
        guard json.utf8.count <= 1_048_576, let data = json.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data), let fields = value.objectValue,
              Set(fields.keys) == Set(["schemaVersion", "source", "match", "never", "noAlways", "clickOnly", "reasons", "rules", "entries"]),
              fields["schemaVersion"]?.intValue == 1, fields["source"]?.stringValue == "packages/schema/src/computer-apps.ts",
              let denied = fields["never"]?.arrayValue, let click = fields["clickOnly"]?.arrayValue,
              let noAlways = fields["noAlways"]?.arrayValue, noAlways.allSatisfy({ $0.stringValue.map(categories.contains) == true }),
              let match = fields["match"]?.objectValue, match["case"]?.stringValue == "insensitive",
              Set(match.keys) == Set(["case", "wildcard", "macos", "windows"]), match.values.allSatisfy({ $0.stringValue != nil }),
              let reasons = fields["reasons"]?.objectValue,
              Set(reasons.keys) == Set(["vector", "terminal", "scripting", "password-manager", "security", "remote-viewer"]),
              reasons.values.allSatisfy({ ["vector", "terminal", "passwords", "security", "remote"].contains($0.stringValue ?? "") }),
              let rows = fields["entries"]?.arrayValue, !rows.isEmpty, rows.count <= 4096,
              let rules = fields["rules"]?.arrayValue,
              rules.count == 7,
              rules.compactMap({ $0["id"]?.stringValue }) == ["never", "child-shell", "system-ui", "system", "listed", "enforce", "click-only"],
              denied.allSatisfy({ $0.stringValue.map(categories.contains) == true }), click.allSatisfy({ $0.stringValue.map(categories.contains) == true }),
              Set(denied.compactMap(\.stringValue)) == Set(["vector", "terminal", "scripting", "password-manager", "security", "remote-viewer"]),
              Set(click.compactMap(\.stringValue)) == Set(["developer"]) else {
            throw ServerFailure(code: "unavailable", message: "The native application rules are invalid.")
        }
        var parsed: [Entry] = []
        var keys = Set<String>()
        var passedNever = false
        for row in rows {
            guard let item = row.objectValue, let key = item["key"]?.stringValue, !key.isEmpty, key.utf16.count <= 256, keys.insert(key).inserted,
                  let category = item["category"]?.stringValue, categories.contains(category),
                  let list = item["list"]?.stringValue,
                  ["never", "system-ui", "default-blocked", "benign-system", "categorized"].contains(list),
                  item["macos"] == nil || item["macos"]?.arrayValue != nil else {
                throw ServerFailure(code: "unavailable", message: "The native application rules are invalid.")
            }
            let patterns = item["macos"]?.arrayValue ?? []
            let deniedCategory = denied.contains(.string(category))
            guard (list == "never") == deniedCategory, !(passedNever && list == "never"),
                  (list == "system-ui") == (category == "system-ui"),
                  list != "never" || item["removable"]?.boolValue == false,
                  list != "default-blocked" || item["removable"]?.boolValue == true else {
                throw ServerFailure(code: "unavailable", message: "The native application rules are invalid.")
            }
            if list != "never" { passedNever = true }
            guard patterns.allSatisfy({ value in
                guard let text = value.stringValue, !text.isEmpty, text.utf16.count <= 512, !text.contains("\0") else { return false }
                return !text.dropLast().contains("*")
            }) else { throw ServerFailure(code: "unavailable", message: "The native application rules are invalid.") }
            parsed.append(Entry(key: key, category: category, list: list, patterns: patterns.compactMap(\.stringValue)))
        }
        self.entries = parsed
        self.never = Set(denied.compactMap(\.stringValue))
        self.clickOnly = Set(click.compactMap(\.stringValue))
    }

    static func matches(_ pattern: String, _ bundleID: String) -> Bool {
        let pattern = pattern.lowercased(), bundleID = bundleID.lowercased()
        return pattern.hasSuffix("*") ? bundleID.hasPrefix(String(pattern.dropLast())) : bundleID == pattern
    }

    func category(_ identity: MacAppIdentity, childShell: Bool = false) -> String {
        if Identity.vectorBundleIds.contains(where: { $0.caseInsensitiveCompare(identity.bundleId) == .orderedSame }) { return "vector" }
        let listed = entries.first { $0.patterns.contains { NativeBlocklist.matches($0, identity.bundleId) } }
        if let listed, never.contains(listed.category) { return listed.category }
        if childShell && listed?.category != "developer" { return "terminal" }
        if listed?.category == "system-ui" { return "system-ui" }
        let benign = identity.apple && entries.contains { $0.list == "benign-system" && $0.patterns.contains { NativeBlocklist.matches($0, identity.bundleId) } }
        let removable = entries.contains { $0.list == "default-blocked" && $0.patterns.contains { NativeBlocklist.matches($0, identity.bundleId) } }
        if identity.system && !benign && !removable { return "security" }
        return listed?.category ?? "general"
    }

    func isProtected(_ identity: MacAppIdentity, childShell: Bool = false) -> Bool { never.contains(category(identity, childShell: childShell)) }
    func isClickOnly(_ identity: MacAppIdentity, childShell: Bool = false) -> Bool { clickOnly.contains(category(identity, childShell: childShell)) }

    static func keyTypesText(_ keys: [String]) -> Bool {
        let values = keys.map { $0.lowercased() }
        // C1's macOS aliases: Option/Shift preserve text; Command/Control make shortcuts. Known clipboard
        // insertions additionally retain E7/D19's text-changing classification below.
        let shortcuts: Set<String> = ["cmd", "command", "meta", "metaleft", "metaright", "super", "⌘", "win", "windows", "os", "osleft", "osright",
            "ctrl", "control", "controlleft", "controlright", "⌃"]
        // E7/D19 treat these known clipboard insertions as text-changing even though they are shortcuts.
        if values.contains(where: { $0 == "v" || $0 == "keyv" }) && values.contains(where: shortcuts.contains) { return true }
        if values.contains(where: { ["insert", "ins"].contains($0) }) && values.contains(where: { ["shift", "shiftleft", "shiftright", "⇧"].contains($0) }) { return true }
        if values.contains(where: shortcuts.contains) { return false }
        let modifiers: Set<String> = ["shift", "shiftleft", "shiftright", "⇧", "altgr", "altgraph", "fn", "alt", "option", "opt", "altleft", "altright", "⌥"]
        let navigation: Set<String> = ["enter", "return", "numpadenter", "tab", "backspace", "delete", "del", "forwarddelete", "escape", "esc", "arrowleft", "arrowright", "arrowup", "arrowdown",
            "left", "right", "up", "down", "home", "end", "pageup", "pagedown", "pgup", "pgdn", "insert", "ins", "help", "capslock", "numlock", "scrolllock", "printscreen", "pause", "contextmenu"]
        return values.contains { key in
            if modifiers.contains(key) || navigation.contains(key) { return false }
            if key.hasPrefix("f"), let number = Int(key.dropFirst()), number >= 1 && number <= 24, "f\(number)" == key { return false }
            if key.range(of: "^(media[a-z]+|audiovolume[a-z]+|volume(up|down|mute))$", options: .regularExpression) != nil { return false }
            return true
        }
    }
}

/// Metadata-only process/signature observation. Callers select a PID observed from native windows/AX, never a
/// model-supplied bundle name. No permission request, window enumeration, capture or input is performed here.
enum NativeIdentityReader {
    static func observe(pid: pid_t) throws -> NativeOwner {
        guard let before = HelperLifecycle.processIdentity(pid),
              let app = NSRunningApplication(processIdentifier: pid), let bundle = app.bundleIdentifier,
              !bundle.isEmpty, bundle.utf16.count <= 255 else { throw unavailable() }
        let facts = try signing(pid: pid)
        if facts.verified {
            guard facts.identifier?.caseInsensitiveCompare(bundle) == .orderedSame,
                  facts.bundleID == nil || facts.bundleID?.caseInsensitiveCompare(bundle) == .orderedSame else { throw unavailable() }
        }
        let root = before.executable == "/System" || before.executable.hasPrefix("/System/") || before.executable == "/usr/libexec" || before.executable.hasPrefix("/usr/libexec/")
        // Failure to establish system code identity is not evidence that an OS surface is an ordinary app.
        if root && !(facts.verified && facts.apple && facts.platform) { throw unavailable() }
        let identity = MacAppIdentity(bundleId: facts.bundleID ?? bundle, teamId: facts.team,
            apple: facts.apple, system: root && facts.platform && facts.apple, verified: facts.verified,
            name: clean(app.localizedName ?? bundle), path: before.executable, pid: Int(pid))
        guard identity.bundleId.caseInsensitiveCompare(bundle) == .orderedSame,
              MacAppIdentity(wire: identity.wire) != nil else { throw unavailable() }
        let shell = childShell(pid: pid)
        guard HelperLifecycle.processIdentity(pid) == before else { throw ServerFailure(code: "changed", message: "The native process changed.") }
        return NativeOwner(identity: identity, process: before, childShell: shell)
    }

    static func secureField(_ element: AXUIElement, expectedPID: pid_t) -> Bool? {
        var observedPID: pid_t = 0
        guard expectedPID > 0, let process = HelperLifecycle.processIdentity(expectedPID),
              AXUIElementGetPid(element, &observedPID) == .success, observedPID == expectedPID,
              AXUIElementSetMessagingTimeout(element, 0.1) == .success else { return nil }
        var role: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
              let role = role as? String else { return nil }
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &value)
        let secure: Bool
        if result == .attributeUnsupported || result == .noValue { secure = role == "AXSecureTextField" }
        else {
            guard result == .success, let subrole = value as? String else { return nil }
            secure = isSecure(role: role, subrole: subrole)
        }
        guard AXUIElementGetPid(element, &observedPID) == .success, observedPID == expectedPID,
              HelperLifecycle.processIdentity(expectedPID) == process else { return nil }
        return secure
    }

    static func isSecure(role: String, subrole: String?) -> Bool { role == "AXSecureTextField" || subrole == "AXSecureTextField" }
    static func secureInputStatus() -> (enabled: Bool, holder: String?) { (IsSecureEventInputEnabled(), nil) }

    private struct Signing {
        let identifier: String?
        let bundleID: String?
        let team: String?
        let apple: Bool
        let platform: Bool
        let verified: Bool
    }

    private static func signing(pid: pid_t) throws -> Signing {
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary, [], &code) == errSecSuccess,
              let code else { throw unavailable() }
        var staticCode: SecStaticCode?
        var info: CFDictionary?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let info else { throw unavailable() }
        let fields = info as NSDictionary
        let identifier = fields[kSecCodeInfoIdentifier] as? String
        let flags = SecCodeSignatureFlags(rawValue: (fields[kSecCodeInfoFlags] as? NSNumber)?.uint32Value ?? 0)
        let valid = SecCodeCheckValidity(code, [.noNetworkAccess], nil) == errSecSuccess && !flags.contains(.adhoc)
        var requirement: SecRequirement?
        let apple = valid && SecRequirementCreateWithString("anchor apple" as CFString, [], &requirement) == errSecSuccess &&
            requirement.map { SecCodeCheckValidity(code, [.noNetworkAccess], $0) == errSecSuccess } == true
        let team = (fields[kSecCodeInfoTeamIdentifier] as? String).flatMap { valid && MacAppIdentity.validTeam($0) ? $0 : nil }
        let platform = valid && ((fields[kSecCodeInfoPlatformIdentifier] as? NSNumber)?.intValue ?? 0) > 0
        let bundle = valid ? (fields[kSecCodeInfoPList] as? NSDictionary)?["CFBundleIdentifier"] as? String : nil
        return Signing(identifier: identifier, bundleID: bundle, team: team, apple: apple, platform: platform, verified: valid && (apple || team != nil))
    }

    private static func childShell(pid: pid_t) -> Bool? {
        var pending: [(pid_t, Int)] = [(pid, 0)]
        var seen = Set<pid_t>()
        let limit = 256
        while !pending.isEmpty {
            let (parent, depth) = pending.removeLast()
            guard seen.insert(parent).inserted, seen.count <= limit, depth <= 8 else { return nil }
            let capacity = limit * MemoryLayout<pid_t>.size
            var children = [pid_t](repeating: 0, count: limit)
            let count = proc_listchildpids(parent, &children, Int32(capacity))
            guard count >= 0, Int(count) < capacity, count % Int32(MemoryLayout<pid_t>.size) == 0 else { return nil }
            for child in children.prefix(Int(count) / MemoryLayout<pid_t>.size) where child > 0 {
                guard let process = HelperLifecycle.processIdentity(child), process.parentPID == parent else { return nil }
                if shellExecutable(URL(fileURLWithPath: process.executable).lastPathComponent) { return true }
                pending.append((child, depth + 1))
            }
        }
        return false
    }

    static func shellExecutable(_ value: String) -> Bool {
        let value = value.lowercased()
        if ["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "node", "bun", "deno", "ruby", "irb", "lua", "swift", "repl", "r"].contains(value) { return true }
        return value.range(of: "^(python|pypy)([0-9]+(\\.[0-9]+)*)?$", options: .regularExpression) != nil
    }

    private static func clean(_ value: String) -> String {
        let filtered = String(String.UnicodeScalarView(value.unicodeScalars.filter { scalar in
            !(scalar.value < 0x20 || (0x7f...0x9f).contains(scalar.value) || scalar.value == 0x061c || (0x200b...0x200f).contains(scalar.value) ||
              (0x2028...0x202e).contains(scalar.value) || (0x2060...0x2069).contains(scalar.value) || scalar.value == 0xfeff)
        }))
        let units = Array(filtered.utf16.prefix(256))
        return String(decoding: units.last.map({ (0xd800...0xdbff).contains($0) }) == true ? Array(units.dropLast()) : units, as: UTF16.self)
    }
    private static func unavailable() -> ServerFailure { ServerFailure(code: "unavailable", message: "Native application identity could not be observed.") }
}
