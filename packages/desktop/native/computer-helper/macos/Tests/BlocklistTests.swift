import Foundation
import Darwin

private struct BlocklistTestFailure: Error {
    let message: String
}

private func blocklistCheck(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw BlocklistTestFailure(message: message) }
}

private func blocklistRefusal(_ code: String, _ body: () throws -> Void) throws {
    do {
        try body()
    } catch let error as ServerFailure {
        try blocklistCheck(error.code == code, "Expected \(code), received \(error.code)")
        return
    }
    throw BlocklistTestFailure(message: "Expected refusal \(code)")
}

private func blocklistIdentity(
    _ bundle: String = "example.notes", team: String? = "ABCDEFGHIJ",
    apple: Bool = false, system: Bool = false, verified: Bool = true,
    path: String? = "/virtual/Notes.app/Contents/MacOS/Notes", pid: Int? = 101
) -> MacAppIdentity {
    MacAppIdentity(bundleId: bundle, teamId: team, apple: apple, system: system, verified: verified,
                   name: "Synthetic app", path: path, pid: pid)
}

private func blocklistOwner(_ identity: MacAppIdentity, childShell: Bool? = false,
                            start: UInt64 = 10, parent: pid_t = 1) -> NativeOwner {
    NativeOwner(identity: identity,
                process: HelperProcessIdentity(pid: pid_t(identity.pid ?? 101), parentPID: parent,
                                               startSeconds: start, startMicroseconds: 20,
                                               executable: identity.path ?? "/virtual/Notes.app/Contents/MacOS/Notes"),
                childShell: childShell)
}

private func blocklistSession(_ approved: [MacAppIdentity], paused: Bool = false) -> ServerSession {
    ServerSession(id: "synthetic-policy", revision: 1, mode: "foreground", paused: paused,
                  approved: approved.map(\.wire), vectorPids: [900], vectorWindowIds: ["vector-window"],
                  overlayWindowIds: ["overlay-window"], escStops: true, stopChord: "Command+Shift+Escape")
}

/// Synthetic identity, ownership, policy and AX-role checks only. No native process/window observation, secure-input
/// query, capture, permission request or event posting is allowed in this unit target.
func runBlocklistTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }
    let rules = try NativeBlocklist.generated()

    try test {
        let identity = blocklistIdentity(pid: nil)
        try SessionPolicy(session: blocklistSession([identity])).requireLaunchIdentity(identity)
        try blocklistRefusal("not_granted") {
            try SessionPolicy(session: blocklistSession([])).requireLaunchIdentity(identity)
        }
        try blocklistRefusal("not_granted") {
            try SessionPolicy(session: blocklistSession([identity])).requireLaunchIdentity(blocklistIdentity(team: "ZZZZZZZZZZ", pid: nil))
        }
        try blocklistRefusal("paused") {
            try SessionPolicy(session: blocklistSession([identity], paused: true)).requireLaunchIdentity(identity)
        }
        let terminal = blocklistIdentity("com.apple.Terminal", team: nil, apple: true, system: true,
            path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", pid: nil)
        try blocklistRefusal("protected") {
            try SessionPolicy(session: blocklistSession([terminal])).requireLaunchIdentity(terminal)
        }
        try blocklistRefusal("unavailable") {
            try SessionPolicy(session: blocklistSession([identity])).requireLaunchIdentity(blocklistIdentity(verified: false, pid: nil))
        }
    }

    try test {
        let source = try JSONDecoder().decode(JSONValue.self, from: Data(Blocklist.json.utf8))
        guard let rows = source["entries"]?.arrayValue else { throw BlocklistTestFailure(message: "Missing generated rows") }
        try blocklistCheck(rules.entries.map(\.key) == rows.compactMap { $0["key"]?.stringValue },
                           "Native rule loading must preserve the generated entry order")
        for (index, entry) in rules.entries.enumerated() {
            try blocklistCheck(entry.category == rows[index]["category"]?.stringValue &&
                               entry.list == rows[index]["list"]?.stringValue &&
                               entry.patterns == (rows[index]["macos"]?.arrayValue ?? []).compactMap(\.stringValue),
                               "Native rows must retain every generated category, list and macOS pattern")
        }
        try blocklistCheck(rules.never == Set(["vector", "terminal", "scripting", "password-manager", "security", "remote-viewer"]),
                           "The native never-list must match the shared floor")
        try blocklistCheck(rules.clickOnly == Set(["developer"]), "Developer apps must remain click-only")
        for channel in Identity.channels {
            for bundle in [channel.appId, channel.helperBundleId] + channel.electronHelperIds {
                try blocklistCheck(rules.category(blocklistIdentity(bundle)) == "vector",
                                   "Every generated Vector and helper identifier is never-listed")
            }
        }
        try blocklistCheck(rules.category(blocklistIdentity("AI.VECTOR.APP.DEV.HELPER.RENDERER")) == "vector",
                           "Vector identity matching is case-insensitive")
    }

    try test {
        for bundle in ["COM.APPLE.TERMINAL", "dev.warp.synthetic", "com.apple.keychainaccess",
                       "com.apple.systempreferences", "com.apple.SecurityAgent",
                       "com.1password.synthetic", "com.apple.ScriptEditor2", "com.microsoft.rdc.macos"] {
            try blocklistCheck(rules.isProtected(blocklistIdentity(bundle)),
                               "Generated protected application \(bundle) must never become a consent target")
        }
        try blocklistCheck(NativeBlocklist.matches("dev.warp.*", "DEV.WARP.synthetic"), "Trailing wildcard matches its prefix")
        try blocklistCheck(!NativeBlocklist.matches("dev.warp.*", "dev.warpish.synthetic"), "Wildcard preserves the full prefix boundary")
        try blocklistCheck(!NativeBlocklist.matches("com.apple.Terminal", "com.apple.Terminal.extra"), "Exact rules do not become prefixes")
    }

    try test {
        let notes = blocklistIdentity("com.apple.Notes", team: nil, apple: true, system: true)
        try blocklistCheck(rules.category(notes) == "office" && !rules.isProtected(notes), "Apple Notes is a benign system app")
        let impersonated = blocklistIdentity("com.apple.Notes", apple: false, system: true)
        try blocklistCheck(rules.category(impersonated) == "security", "A bundle name cannot establish Apple's benign exemption")
        let unknown = blocklistIdentity("com.apple.synthetic.security-host", team: nil, apple: true, system: true)
        try blocklistCheck(rules.category(unknown) == "security", "Unknown system applications are protected by default")
        let utility = blocklistIdentity("com.apple.DiskUtility", team: nil, apple: true, system: true)
        try blocklistCheck(rules.category(utility) == "general" && !rules.isProtected(utility),
                           "The desktop's removable default block is not a native permanent prohibition")
        let dock = blocklistIdentity("com.apple.dock", team: nil, apple: true, system: true)
        try blocklistCheck(rules.category(dock) == "system-ui", "Desktop furniture remains its own non-target category")
    }

    try test {
        let editor = blocklistIdentity("com.microsoft.VSCode")
        try blocklistCheck(rules.category(editor, childShell: true) == "developer" && rules.isClickOnly(editor, childShell: true),
                           "An IDE's shell does not turn its click-only surface into an ordinary terminal")
        try blocklistCheck(rules.category(blocklistIdentity(), childShell: true) == "terminal",
                           "A child shell makes an ordinary app a terminal")
        try blocklistCheck(rules.category(blocklistIdentity("com.apple.dock"), childShell: true) == "terminal",
                           "Child-shell refusal precedes the system-ui classification")
        try blocklistCheck(rules.category(blocklistIdentity("com.apple.Terminal"), childShell: false) == "terminal",
                           "An explicit never entry precedes process-tree observations")
    }

    try test {
        for keys in [["s"], ["Shift", "s"], ["Option", "s"], ["AltGraph", "q"], ["Fn", "界"],
                     ["Command", "v"], ["Command", "KeyV"], ["ControlLeft", "V"], ["⌘", "v"], ["Shift", "Insert"], ["⇧", "Ins"],
                     ["IntlBackslash"], ["NumpadEqual"], ["F25"], ["F01"]] {
            try blocklistCheck(NativeBlocklist.keyTypesText(keys), "Text or unknown keys must be treated as typing")
        }
        for keys in [["Command", "s"], ["Ctrl", "s"], ["Win", "r"], ["Escape"], ["Shift", "ArrowLeft"],
                     ["Enter"], ["Backspace"], ["Delete"], ["Tab"], ["F1"], ["F24"], ["MediaPlayPause"], ["AudioVolumeUp"]] {
            try blocklistCheck(!NativeBlocklist.keyTypesText(keys), "Shortcuts, navigation and non-text keys stay usable")
        }
        try blocklistCheck(NativeOperation.type.typesText && NativeOperation.setValue.typesText,
                           "Both native text mutation operations require secure-field and click-only checks")
        try blocklistCheck(NativeOperation.hold(["Option", "s"]).typesText && !NativeOperation.key(["Command", "s"]).typesText,
                           "Held keys and ordinary key chords share text classification")
    }

    try test {
        for executable in ["sh", "ZSH", "node", "bun", "deno", "python", "python3", "python3.12", "pypy3.10", "irb", "swift", "R"] {
            try blocklistCheck(NativeIdentityReader.shellExecutable(executable), "Known child shells and REPLs must be recognized")
        }
        for executable in ["Notes", "python-docs", "node-helper.app", "python3.bad", "browser"] {
            try blocklistCheck(!NativeIdentityReader.shellExecutable(executable), "Ordinary executable names must not be broadened by substring")
        }
        try blocklistCheck(NativeIdentityReader.isSecure(role: "AXSecureTextField", subrole: nil), "A secure role refuses typing")
        try blocklistCheck(NativeIdentityReader.isSecure(role: "AXTextField", subrole: "AXSecureTextField"), "A secure subrole refuses typing")
        try blocklistCheck(!NativeIdentityReader.isSecure(role: "AXTextField", subrole: nil), "An observed ordinary text field is not globally blocked")
    }

    try test {
        let identity = blocklistIdentity("Example.Notes")
        try blocklistCheck(MacAppIdentity(wire: identity.wire) == identity, "A native identity round-trips without losing signer or process facts")
        try blocklistCheck(identity.key == "app:macos:example.notes", "App keys preserve shared lower-case bundle matching")
        let base = identity.wire.objectValue!
        for field in ["platform", "bundleId", "apple", "system", "verified", "name"] {
            var fields = base
            fields.removeValue(forKey: field)
            try blocklistCheck(MacAppIdentity(wire: .object(fields)) == nil, "Missing required identity facts fail closed")
        }
        for (field, value) in [
            ("platform", JSONValue.string("windows")), ("bundleId", .string("")), ("bundleId", .string("bad\0bundle")),
            ("bundleId", .string(String(repeating: "x", count: 256))), ("bundleId", .string("example.\u{202e}notes")),
            ("bundleId", .string("example.\u{200b}notes")), ("apple", .integer(1)), ("system", .null),
            ("verified", .string("true")), ("teamId", .string("lowercase1")), ("teamId", .string("SHORT")),
            ("pid", .bool(true)), ("pid", .number(1.5)), ("pid", .integer(0)), ("pid", .integer(2_147_483_648)),
            ("path", .string("")), ("path", .string("bad\0path")), ("extraAuthority", .bool(true)),
            ("name", .string(String(repeating: "x", count: 257))), ("name", .string("Bad\nname")),
            ("name", .string("Bad\u{2066}name")), ("name", .string("Bad\u{200b}name")),
        ] {
            var fields = base
            fields[field] = value
            try blocklistCheck(MacAppIdentity(wire: .object(fields)) == nil, "Malformed or extra identity facts cannot enter approvals")
        }
        try blocklistCheck(MacAppIdentity.canonicalPathShape("/virtual/Notes.app/Contents/MacOS/Notes"), "Absolute canonical path shape is accepted")
        for file in ["relative/Notes", "//virtual/Notes", "/virtual/../Notes", "/virtual/./Notes", "/virtual/Notes\0"] {
            try blocklistCheck(!MacAppIdentity.canonicalPathShape(file), "Unsigned approval paths cannot use ambiguous spellings")
        }
    }

    try test {
        let original = try JSONDecoder().decode(JSONValue.self, from: Data(Blocklist.json.utf8)).objectValue!
        var invalid: [[String: JSONValue]] = []
        var missing = original; missing.removeValue(forKey: "never"); invalid.append(missing)
        var unknown = original; unknown["extraAuthority"] = .bool(true); invalid.append(unknown)
        var wrongVersion = original; wrongVersion["schemaVersion"] = .integer(2); invalid.append(wrongVersion)
        var reordered = original; reordered["rules"] = .array(Array(original["rules"]!.arrayValue!.reversed())); invalid.append(reordered)
        var weakerFloor = original; weakerFloor["never"] = .array([.string("terminal")]); invalid.append(weakerFloor)
        var duplicate = original
        duplicate["entries"] = .array(original["entries"]!.arrayValue! + [original["entries"]!.arrayValue![0]])
        invalid.append(duplicate)
        var lateNever = original
        lateNever["entries"] = .array(Array(original["entries"]!.arrayValue!.dropFirst()) + [original["entries"]!.arrayValue![0]])
        invalid.append(lateNever)
        var badPattern = original
        var rows = original["entries"]!.arrayValue!
        var row = rows[0].objectValue!
        row["macos"] = .array([.string("ai.*.vector")])
        rows[0] = .object(row)
        badPattern["entries"] = .array(rows)
        invalid.append(badPattern)
        for fields in invalid {
            let text = String(data: try JSONEncoder().encode(JSONValue.object(fields)), encoding: .utf8)!
            try blocklistRefusal("unavailable") { _ = try NativeBlocklist(json: text) }
        }
    }

    try test {
        let signed = blocklistIdentity()
        let apple = blocklistIdentity("com.apple.Notes", team: nil, apple: true, system: true)
        let unsigned = blocklistIdentity("example.unsigned", team: nil, verified: false)
        try blocklistCheck(SessionPolicy.decodeApproved([signed.wire, apple.wire, unsigned.wire]) == [signed, apple, unsigned],
                           "Only complete native approval identities are retained")
        try blocklistCheck(SessionPolicy.validApprovals([]), "An empty allowlist is valid and grants no app")
        try blocklistCheck(!SessionPolicy.validApprovals([signed.wire, signed.wire]), "Duplicate app approvals fail closed")
        try blocklistCheck(!SessionPolicy.validApprovals([signed.wire, blocklistIdentity("EXAMPLE.NOTES").wire]),
                           "Case changes cannot create a second grant for one bundle")
        for identity in [
            blocklistIdentity(team: nil), blocklistIdentity(apple: false, system: true),
            blocklistIdentity(team: nil, apple: true, verified: false),
            blocklistIdentity(team: nil, system: true, verified: false),
            blocklistIdentity(team: "ABCDEFGHIJ", verified: false),
            blocklistIdentity(team: nil, verified: false, path: nil),
            blocklistIdentity(team: nil, verified: false, pid: nil),
            blocklistIdentity(team: nil, verified: false, path: "/virtual/../Notes"),
        ] {
            try blocklistCheck(!SessionPolicy.validApprovals([identity.wire]),
                               "Unsigned or contradictory approval facts cannot be upgraded into authority")
        }
        let excessive = (0..<4097).map { blocklistIdentity("example.app\($0)").wire }
        try blocklistCheck(SessionPolicy.validApprovals(Array(excessive.prefix(4096))), "The maximum supported approval set remains usable")
        try blocklistCheck(!SessionPolicy.validApprovals(excessive), "The native approval set has a finite bound")
        try blocklistRefusal("failed") {
            _ = try SessionPolicy(session: blocklistSession([signed, signed]), blocklist: rules, helperPID: 999)
        }
    }

    try test {
        let approved = blocklistIdentity()
        let policy = try SessionPolicy(session: blocklistSession([approved]), blocklist: rules, helperPID: 999)
        let owner = blocklistOwner(approved)
        let target = NativeTarget(owner: owner, windowID: "notes-window", ref: "native-ref", elementID: "native-element", secure: false)
        let expected = NativeExpectedTarget(pid: 101, process: owner.process, windowID: "notes-window",
                                            ref: "native-ref", elementID: "native-element")
        try policy.requireTarget(target, operation: .pointer, expected: expected)
        try policy.requireTarget(target, operation: .type, expected: expected)
        try policy.requireTarget(target, operation: .capture)
        try blocklistCheck(policy.disclosure(target) == .content && policy.mayIncludeInDisplay(target),
                           "A live approved owner can disclose its own content")
        // A signed app's consent follows its verified bundle and signer; the actual action still binds its fresh PID.
        let successor = blocklistIdentity("EXAMPLE.NOTES", pid: 102)
        try policy.requireTarget(NativeTarget(owner: blocklistOwner(successor), secure: false), operation: .pointer)
        for identity in [
            blocklistIdentity(team: "KLMNOPQRST"),
            blocklistIdentity(team: nil, apple: true),
            blocklistIdentity(team: nil, verified: false),
            blocklistIdentity("example.other"),
        ] {
            let changed = NativeTarget(owner: blocklistOwner(identity), secure: false)
            try blocklistRefusal("not_granted") { try policy.requireTarget(changed, operation: .pointer) }
            try blocklistCheck(policy.disclosure(changed) == .structural && !policy.mayIncludeInDisplay(changed),
                               "A changed signer, verification kind or bundle cannot reuse the original consent")
        }
    }

    try test {
        let unsigned = blocklistIdentity("example.unsigned", team: nil, verified: false)
        let policy = try SessionPolicy(session: blocklistSession([unsigned]), blocklist: rules, helperPID: 999)
        try policy.requireTarget(NativeTarget(owner: blocklistOwner(unsigned), secure: false), operation: .pointer)
        for identity in [
            blocklistIdentity("example.unsigned", team: nil, verified: false, pid: 102),
            blocklistIdentity("example.unsigned", team: nil, verified: false, path: "/virtual/Replaced.app/Contents/MacOS/Replaced"),
            blocklistIdentity("example.unsigned", team: "ABCDEFGHIJ", verified: true),
        ] {
            try blocklistRefusal("not_granted") {
                try policy.requireTarget(NativeTarget(owner: blocklistOwner(identity), secure: false), operation: .pointer)
            }
        }
    }

    try test {
        let approved = blocklistIdentity()
        let policy = try SessionPolicy(session: blocklistSession([approved]), blocklist: rules, helperPID: 999)
        let owner = blocklistOwner(approved)
        let target = NativeTarget(owner: owner, windowID: "notes-window", ref: "native-ref", elementID: "native-element", secure: false)
        for expected in [
            NativeExpectedTarget(pid: 102),
            NativeExpectedTarget(process: blocklistOwner(approved, start: 11).process),
            NativeExpectedTarget(process: blocklistOwner(approved, parent: 2).process),
            NativeExpectedTarget(windowID: "replacement-window"),
        ] {
            try blocklistRefusal("changed") { try policy.requireTarget(target, operation: .pointer, expected: expected) }
        }
        for expected in [
            NativeExpectedTarget(ref: "replacement-ref"),
            NativeExpectedTarget(elementID: "replacement-element"),
        ] {
            try blocklistRefusal("stale_ref") { try policy.requireTarget(target, operation: .pointer, expected: expected) }
        }
        for operation in [NativeOperation.type, .key(["Command", "s"]), .hold(["a"])] {
            try blocklistRefusal("changed") { try policy.requireTarget(target, operation: operation) }
        }
        try policy.requireTarget(target, operation: .type, expected: NativeExpectedTarget(process: owner.process))
        let incoherent = NativeOwner(identity: approved, process: blocklistOwner(blocklistIdentity(pid: 102)).process, childShell: false)
        try blocklistRefusal("changed") {
            try policy.requireTarget(NativeTarget(owner: incoherent), operation: .observe)
        }
        try blocklistCheck(policy.disclosure(incoherent) == .structural && !policy.mayIncludeInDisplay(incoherent),
                           "A public identity cannot substitute for a mismatched private process witness")
    }

    try test {
        let editor = blocklistIdentity("com.microsoft.VSCode")
        let policy = try SessionPolicy(session: blocklistSession([editor]), blocklist: rules, helperPID: 999)
        let target = NativeTarget(owner: blocklistOwner(editor, childShell: true), secure: false)
        let expected = NativeExpectedTarget(pid: 101)
        try policy.requireTarget(target, operation: .pointer)
        try policy.requireTarget(target, operation: .key(["Command", "s"]), expected: expected)
        try policy.requireTarget(target, operation: .key(["ArrowDown"]), expected: expected)
        for operation in [NativeOperation.type, .setValue, .key(["Option", "s"]), .hold(["IntlBackslash"]),
                          .key(["Command", "v"]), .key(["Command", "KeyV"]), .hold(["Ctrl", "v"]), .key(["Shift", "Insert"])] {
            try blocklistRefusal("blocked") { try policy.requireTarget(target, operation: operation, expected: expected) }
        }
        let secure = NativeTarget(owner: target.owner, secure: true)
        try blocklistRefusal("secure_field") { try policy.requireTarget(secure, operation: .type, expected: expected) }
        let ordinary = blocklistIdentity()
        let ordinaryPolicy = try SessionPolicy(session: blocklistSession([ordinary]), blocklist: rules, helperPID: 999)
        for secure in [Bool?.some(true), nil] {
            let field = NativeTarget(owner: blocklistOwner(ordinary), secure: secure)
            try blocklistRefusal("secure_field") {
                try ordinaryPolicy.requireTarget(field, operation: .type, expected: expected)
            }
            for operation in [NativeOperation.key(["Command", "v"]), .key(["Command", "KeyV"]), .hold(["Ctrl", "v"]), .key(["Shift", "Insert"])] {
                try blocklistRefusal("secure_field") {
                    try ordinaryPolicy.requireTarget(field, operation: operation, expected: expected)
                }
            }
            try ordinaryPolicy.requireTarget(field, operation: .pointer)
        }
    }

    try test {
        let terminal = blocklistIdentity("com.apple.Terminal")
        let ordinary = blocklistIdentity()
        let policy = try SessionPolicy(session: blocklistSession([terminal, ordinary]), blocklist: rules, helperPID: 999)
        let target = NativeTarget(owner: blocklistOwner(terminal), secure: false)
        for operation in [NativeOperation.observe, .capture, .activate, .pointer, .type, .key(["Command", "s"])] {
            try blocklistRefusal("protected") {
                try policy.requireTarget(target, operation: operation, expected: NativeExpectedTarget(pid: 101))
            }
        }
        try blocklistCheck(policy.disclosure(target) == .structural && !policy.mayIncludeInDisplay(target),
                           "A never-listed app stays hidden even if main supplied an approval")
        let shell = NativeTarget(owner: blocklistOwner(ordinary, childShell: true), secure: false)
        try blocklistRefusal("protected") { try policy.requireTarget(shell, operation: .pointer) }
        let unknownTree = NativeTarget(owner: blocklistOwner(ordinary, childShell: nil), secure: false)
        try blocklistRefusal("unavailable") { try policy.requireTarget(unknownTree, operation: .pointer) }
        try blocklistCheck(policy.disclosure(unknownTree) == .structural && !policy.mayIncludeInDisplay(unknownTree),
                           "An incomplete process-tree observation cannot imply an ordinary app")
        let unsignedSystem = blocklistIdentity("example.system", path: "/System/Library/PrivateFrameworks/SyntheticHost")
        let systemPolicy = try SessionPolicy(session: blocklistSession([unsignedSystem]), blocklist: rules, helperPID: 999)
        try blocklistRefusal("protected") {
            try systemPolicy.requireTarget(NativeTarget(owner: blocklistOwner(unsignedSystem)), operation: .pointer)
        }
    }

    try test {
        let approved = blocklistIdentity()
        let policy = try SessionPolicy(session: blocklistSession([approved]), blocklist: rules, helperPID: 999)
        for pid in [900, 999] {
            let target = NativeTarget(owner: blocklistOwner(blocklistIdentity(pid: pid)), secure: false)
            try blocklistRefusal("protected") { try policy.requireTarget(target, operation: .capture) }
            try blocklistCheck(policy.disclosure(target) == .structural && !policy.mayIncludeInDisplay(target),
                               "Vector and helper process exclusions apply independently of the app's claimed bundle")
        }
        for window in ["vector-window", "overlay-window"] {
            let target = NativeTarget(owner: blocklistOwner(approved), windowID: window, secure: false)
            try blocklistRefusal("protected") { try policy.requireTarget(target, operation: .pointer) }
            try blocklistCheck(policy.disclosure(target) == .structural && !policy.mayIncludeInDisplay(target),
                               "Vector and overlay window exclusions cannot be bypassed by an approved owner")
        }
        let unknown = NativeTarget(owner: blocklistOwner(blocklistIdentity("example.unapproved")))
        try blocklistRefusal("not_granted") { try policy.requireTarget(unknown, operation: .observe) }
        try blocklistCheck(policy.disclosure(unknown) == .structural && !policy.mayIncludeInDisplay(unknown),
                           "Unapproved applications expose structural metadata only and remain masked")
    }

    try test {
        let policy = try SessionPolicy(session: blocklistSession([]), blocklist: rules, helperPID: 999)
        let furniture = blocklistIdentity("com.apple.dock", team: nil, apple: true, system: true,
                                         path: "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock")
        let target = NativeTarget(owner: blocklistOwner(furniture))
        try blocklistCheck(policy.mayIncludeInDisplay(target), "Verified Apple OS furniture is the sole unapproved display exemption")
        try blocklistCheck(policy.disclosure(target) == .structural, "Display furniture does not disclose an accessibility tree")
        try blocklistRefusal("protected") { try policy.requireTarget(target, operation: .pointer) }
        let impersonated = NativeTarget(owner: blocklistOwner(blocklistIdentity("com.apple.dock", system: true,
                                         path: "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock")))
        try blocklistCheck(!policy.mayIncludeInDisplay(impersonated), "A furniture bundle name without Apple proof stays masked")
        let security = NativeTarget(owner: blocklistOwner(blocklistIdentity("com.apple.synthetic-auth", team: nil, apple: true, system: true,
                                         path: "/System/Library/CoreServices/SyntheticAuth.app/Contents/MacOS/SyntheticAuth")))
        try blocklistCheck(!policy.mayIncludeInDisplay(security), "Unknown verified system UI is not a furniture exemption")
    }

    try test {
        let approved = blocklistIdentity()
        let policy = try SessionPolicy(session: blocklistSession([approved], paused: true), blocklist: rules, helperPID: 999)
        let target = NativeTarget(owner: blocklistOwner(approved), secure: false)
        try policy.requireTarget(target, operation: .observe)
        try policy.requireTarget(target, operation: .capture)
        for operation in [NativeOperation.activate, .pointer, .type, .setValue, .key(["Escape"]), .hold(["a"])] {
            try blocklistRefusal("paused") {
                try policy.requireTarget(target, operation: operation, expected: NativeExpectedTarget(pid: 101))
            }
        }
    }

    return count
}

