import CoreGraphics
import Foundation

/// The macOS native shortcut floor mirrors ComputerKeys.allowedCombo using the actual resolved layout.
enum InputKeySafety {
    private struct Resolved: Equatable { let key: String; let modifiers: Set<String> }
    private static let modifiers: [String: String] = [
        "ctrl": "control", "control": "control", "controlleft": "control", "controlright": "control", "⌃": "control",
        "alt": "alt", "option": "alt", "opt": "alt", "altleft": "alt", "altright": "alt", "⌥": "alt",
        "shift": "shift", "shiftleft": "shift", "shiftright": "shift", "⇧": "shift",
        "cmd": "meta", "command": "meta", "meta": "meta", "super": "meta", "win": "meta", "windows": "meta",
        "metaleft": "meta", "metaright": "meta", "os": "meta", "osleft": "meta", "osright": "meta", "⌘": "meta",
        "altgr": "altgraph", "altgraph": "altgraph",
    ]
    private static let named = ["return": "enter", "esc": "escape", "del": "delete", "spacebar": "space", " ": "space",
                                "left": "arrowleft", "right": "arrowright", "up": "arrowup", "down": "arrowdown",
                                "pgup": "pageup", "pgdn": "pagedown", "page_up": "pageup", "page_down": "pagedown"]
    private static let navigation: Set<String> = ["arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end", "pageup", "pagedown",
                                                   "enter", "tab", "escape", "backspace", "delete", "insert"]
    private static let textNavigation: Set<String> = ["arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end", "pageup", "pagedown", "backspace", "delete"]
    private static let system: Set<String> = ["printscreen", "snapshot", "power", "sleep", "wake", "eject", "capslock", "numlock", "scrolllock",
        "pause", "fn", "fnlock", "contextmenu", "apps", "help", "launchapp1", "launchapp2", "launchmail", "browserhome",
        "volumemute", "volumeup", "volumedown", "mediaplaypause", "medianexttrack", "mediaprevioustrack", "mediastop"]
    private static let physical = "^(?:Key[A-Z]|Digit[0-9]|Numpad\\w+|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$"
    // JS's non-Unicode word boundaries are ASCII; ICU's Unicode \b would miss labels such as αScripts.
    private static let forbiddenMenu = "(?<![A-Za-z0-9_])(?:macros?|scripts?|scripting|javascript|visual\\s+basic|vb\\s+editor|terminal|console|powershell|shell|developer|devtools|services|web\\s+inspector|inspect\\s+element|task\\s+manager|mission\\s+control|screen\\s*capture|screenshots?|lock\\s+screen|switch\\s+user|enable\\s+content)(?![A-Za-z0-9_])"

    static func allowed(raw: [String], chord: InputChord, menus: [InputMenuShortcut]?) -> Bool {
        guard let resolved = resolve(raw: raw, chord: chord), !forbidden(resolved),
              printable(resolved.key) || navigation.contains(resolved.key) || functionKey(resolved.key) else { return false }
        guard (menus?.count ?? 0) <= 128 else { return false }
        let matching = (menus ?? []).filter { parse($0.combo, allowPhysical: false) == resolved }
        for menu in matching {
            let label = menu.label
            guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  label.utf16.count <= 256, !unsafe(label),
                  label.precomposedStringWithCompatibilityMapping.range(of: forbiddenMenu, options: [.regularExpression, .caseInsensitive]) == nil else { return false }
        }
        let mods = resolved.modifiers
        if (mods.isEmpty || mods == ["shift"]) && (printable(resolved.key) || navigation.contains(resolved.key)) { return true }
        if mods.contains("meta"), mods.isSubset(of: ["meta", "shift"]),
           Set(["a", "c", "v", "x", "y", "z"]).contains(resolved.key) || textNavigation.contains(resolved.key) { return true }
        if mods.contains("alt"), mods.isSubset(of: ["alt", "shift"]),
           Set(["arrowleft", "arrowright", "arrowup", "arrowdown", "backspace", "delete"]).contains(resolved.key) { return true }
        return !matching.isEmpty
    }

    static func typesText(raw: [String], chord: InputChord, menus: [InputMenuShortcut]? = nil) -> Bool {
        if NativeBlocklist.keyTypesText(raw) { return true }
        guard let resolved = resolve(raw: raw, chord: chord) else { return true }
        let names = resolved.modifiers.map { $0 == "meta" ? "cmd" : $0 }
        if NativeBlocklist.keyTypesText(names + [resolved.key]) { return true }
        guard (menus?.count ?? 0) <= 128 else { return true }
        for menu in (menus ?? []).filter({ parse($0.combo, allowPhysical: false) == resolved }) {
            let label = menu.label
            if label.utf16.count > 256 || unsafe(label) || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
            if label.precomposedStringWithCompatibilityMapping.range(of: "(?<![A-Za-z0-9_])paste(?![A-Za-z0-9_])", options: [.regularExpression, .caseInsensitive]) != nil { return true }
        }
        return false
    }

    private static func resolve(raw: [String], chord: InputChord) -> Resolved? {
        guard parse(raw, allowPhysical: true) != nil else { return nil }
        let allowedFlags = CGEventFlags.maskCommand.rawValue | CGEventFlags.maskControl.rawValue |
            CGEventFlags.maskAlternate.rawValue | CGEventFlags.maskShift.rawValue | CGEventFlags.maskNumericPad.rawValue
        guard chord.flags & ~allowedFlags == 0 else { return nil }
        var effective = Set<String>()
        for item in [(CGEventFlags.maskCommand.rawValue, "meta"), (CGEventFlags.maskControl.rawValue, "control"),
                     (CGEventFlags.maskAlternate.rawValue, "alt"), (CGEventFlags.maskShift.rawValue, "shift")] {
            if chord.flags & item.0 != 0 { effective.insert(item.1) }
        }
        if let semantic = chord.semanticKeys {
            guard let resolved = parse(semantic, allowPhysical: false), resolved.modifiers == effective else { return nil }
            return resolved
        }
        guard let fallback = parse(raw, allowPhysical: false) else { return nil }
        // Injected backends may omit semantic metadata; only unambiguous bare/named keys can use this fallback.
        return Resolved(key: fallback.key, modifiers: fallback.modifiers.union(effective))
    }

    private static func parse(_ combo: [String], allowPhysical: Bool) -> Resolved? {
        guard (1...8).contains(combo.count), combo.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 32 && !unsafe($0) }) else { return nil }
        var mods = Set<String>()
        var keys: [String] = []
        for value in combo {
            if let modifier = modifiers[asciiLower(value)] {
                guard mods.insert(modifier).inserted else { return nil }
            } else {
                if !allowPhysical && value.range(of: physical, options: [.regularExpression, .caseInsensitive]) != nil { return nil }
                keys.append(canonical(value))
            }
        }
        guard keys.count == 1 else { return nil }
        return Resolved(key: keys[0], modifiers: mods)
    }

    private static func canonical(_ value: String) -> String {
        let lower = asciiLower(value)
        if let alias = named[lower] { return alias }
        return value.unicodeScalars.count == 1 && !value.unicodeScalars.allSatisfy({ (65...90).contains($0.value) }) ? value : lower
    }

    private static func asciiLower(_ value: String) -> String {
        var result = ""
        for scalar in value.unicodeScalars {
            result.unicodeScalars.append((65...90).contains(scalar.value) ? UnicodeScalar(scalar.value + 32)! : scalar)
        }
        return result
    }

    private static func unsafe(_ value: String) -> Bool {
        value.unicodeScalars.contains { scalar in
            switch scalar.properties.generalCategory {
            case .control, .format, .surrogate, .privateUse, .unassigned, .lineSeparator, .paragraphSeparator: return true
            default: return false
            }
        }
    }

    private static func printable(_ key: String) -> Bool {
        key == "space" || (key.unicodeScalars.count == 1 && !unsafe(key) && key.rangeOfCharacter(from: .whitespacesAndNewlines) == nil)
    }

    private static func functionKey(_ key: String) -> Bool {
        guard key.hasPrefix("f"), let number = Int(key.dropFirst()) else { return false }
        return (1...24).contains(number) && key == "f\(number)"
    }

    private static func forbidden(_ resolved: Resolved) -> Bool {
        let key = resolved.key, mods = resolved.modifiers
        let control = mods.contains("control"), alt = mods.contains("alt"), meta = mods.contains("meta"), shift = mods.contains("shift")
        if system.contains(key) || key == "f12" || mods.contains("altgraph") { return true }
        if control && (Set(["arrowleft", "arrowright", "arrowup", "arrowdown"]).contains(key) || Set(["f2", "f3", "f4", "f5", "f6", "f7", "f8"]).contains(key)) { return true }
        if meta && alt && key == "d" { return true }
        if (alt || meta) && key == "tab" { return true }
        if key == "space" && (control || alt || meta) { return true }
        if key == "escape" && (control || alt || meta || shift) { return true }
        if control && alt && Set(["delete", "end", "tab", "arrowleft", "arrowright", "arrowup", "arrowdown"]).contains(key) { return true }
        if control && shift && Set(["i", "j", "c"]).contains(key) { return true }
        if meta && alt && Set(["i", "j", "c"]).contains(key) { return true }
        if alt && Set(["f8", "f11"]).contains(key) { return true }
        if meta && shift && Set(["3", "4", "5", "6", "#", "$", "%", "^", "q"]).contains(key) { return true }
        return meta && control && key == "q"
    }
}
