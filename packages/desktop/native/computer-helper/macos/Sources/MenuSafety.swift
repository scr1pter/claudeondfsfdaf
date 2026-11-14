import Foundation

/// The native mutation floor mirrors ComputerKeys' forbidden menu routes across the complete AX ancestry.
/// Reading the AXMenuBar root is separate: an empty path never authorizes a menu mutation.
enum MenuSafety {
    // JS's non-Unicode word boundaries are ASCII; ICU's Unicode \b would miss labels such as αScripts.
    private static let forbidden = #"(?<![A-Za-z0-9_])(?:macros?|scripts?|scripting|javascript|visual\s+basic|vb\s+editor|terminal|console|powershell|shell|developer|devtools|services|web\s+inspector|inspect\s+element|task\s+manager|mission\s+control|screen\s*capture|screenshots?|lock\s+screen|switch\s+user|enable\s+content)(?![A-Za-z0-9_])"#

    static func allowed(_ path: [String], shortcut: [String]? = nil) -> Bool {
        // Match the shared MenuPath bound. Complete raw labels are checked before normalization or wire cleaning.
        guard (1...30).contains(path.count), path.allSatisfy({ $0.utf16.count <= 256 && !unsafe($0) }) else { return false }
        let normalized = path.map(\.precomposedStringWithCompatibilityMapping)
        guard normalized.allSatisfy({ label in
            label.utf16.count <= 256 && !unsafe(label) &&
                !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                label.range(of: forbidden, options: [.regularExpression, .caseInsensitive]) == nil
        }) else { return false }
        // Multiword routes may cross AX ancestors, such as Web > Inspector or Enable > Content.
        guard normalized.joined(separator: " ").range(of: forbidden, options: [.regularExpression, .caseInsensitive]) == nil else { return false }
        guard let shortcut else { return true }
        // A localized label cannot waive the native OS/developer-tool shortcut floor.
        return shortcutAllowed(shortcut, label: path.last ?? "")
    }

    /// Menu activation is not evidence of the app's focused editable/secure target.
    static func requiresTextTarget(_ shortcut: [String]) -> Bool {
        editsText(shortcut) || shortcut.contains { ["a", "c"].contains($0.lowercased()) }
    }

    /// Copy and Select All need the secure-target check but remain non-editing in developer apps.
    static func editsText(_ shortcut: [String]) -> Bool {
        // The fixed label validates tokens only; allowed(path:shortcut:) separately binds the actual AX leaf.
        guard shortcutAllowed(shortcut, label: "Menu action") else { return true }
        let chord = InputChord(keys: [], flags: 0, layout: nil)
        if InputKeySafety.typesText(raw: shortcut, chord: chord) { return true }
        return shortcut.contains { ["x", "y", "z", "backspace", "delete", "del"].contains($0.lowercased()) }
    }

    private static func shortcutAllowed(_ shortcut: [String], label: String) -> Bool {
        // AX supplied semantic keys, not physical keycodes. This metadata-only chord never posts input.
        InputKeySafety.allowed(raw: shortcut, chord: InputChord(keys: [], flags: 0, layout: nil),
                               menus: [InputMenuShortcut(combo: shortcut, label: label)])
    }

    private static func unsafe(_ value: String) -> Bool {
        value.unicodeScalars.contains { scalar in
            switch scalar.properties.generalCategory {
            case .control, .format, .surrogate, .privateUse, .unassigned, .lineSeparator, .paragraphSeparator: return true
            default: return false
            }
        }
    }
}
