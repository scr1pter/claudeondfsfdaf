import Foundation

private struct MenuSafetyTestFailure: Error { let message: String }
private func menuSafetyCheck(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw MenuSafetyTestFailure(message: message) }
}

/// Pure observed-label policy only: no test creates an AX element, reads an app, or invokes a menu.
func runMenuSafetyTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        try menuSafetyCheck(!MenuSafety.allowed([]), "The read-only menu-bar root cannot authorize a mutation.")
        for path in [["File", "Save As…"], ["Edit", "Copy"], ["View", "Zoom In"], ["App", "Quit"],
                     ["Product", "Run"], ["Product", "Build"], ["Debug", "Continue"]] {
            try menuSafetyCheck(MenuSafety.allowed(path), "Ordinary app menus and IDE Run/Build/Debug remain eligible for separate consent checks.")
        }
    }
    try test {
        for path in [["ファイル", "保存"], ["编辑", "复制"], ["Fichier", "Enregistrer sous…"],
                     ["Ansicht", "Größe"], ["Tools", "😀"], ["Cafe\u{301}", "Récent"]] {
            try menuSafetyCheck(MenuSafety.allowed(path), "Safe complete Unicode labels are valid menu ancestry.")
        }
    }
    try test {
        for label in ["Macro", "Macros", "Script", "Scripts", "Scripting", "JavaScript", "Visual Basic", "VB Editor",
                      "Terminal", "Console", "PowerShell", "Shell", "Developer", "DevTools", "Services", "Web Inspector",
                      "Inspect Element", "Task Manager", "Mission Control", "ScreenCapture", "Screen Capture", "Screenshot",
                      "Screenshots", "Lock Screen", "Switch User", "Enable Content"] {
            try menuSafetyCheck(!MenuSafety.allowed(["App", label, "Ordinary Item"]), "A forbidden observed route vetoes every descendant, including a harmless-looking leaf.")
        }
    }
    try test {
        for path in [["Services", "Format"], ["App", "Services", "Format"], ["App", "Tools", "Services"],
                     ["File", "Scripts", "Recent", "Open"], ["App", "Developer Tools", "Run"]] {
            try menuSafetyCheck(!MenuSafety.allowed(path), "The route check includes the first component, every ancestor, and the action leaf.")
        }
    }
    try test {
        for path in [["Web", "Inspector"], ["Enable", "Content"], ["Task", "Manager"], ["Mission", "Control"],
                     ["Lock", "Screen"], ["Switch", "User"], ["Screen", "Capture"], ["Visual", "Basic"],
                     ["VB", "Editor"], ["Inspect", "Element"], ["App", "Ｗｅｂ", "Ｉｎｓｐｅｃｔｏｒ", "Copy"]] {
            try menuSafetyCheck(!MenuSafety.allowed(path), "A multiword forbidden route remains forbidden when its words cross normalized AX ancestry components.")
        }
        for path in [["Web", "Inspectors"], ["Task", "Management"], ["Product", "Run", "Build", "Debug"]] {
            try menuSafetyCheck(MenuSafety.allowed(path), "Joined ancestry preserves complete-word matching and does not forbid ordinary Run/Build/Debug routes.")
        }
    }
    try test {
        for label in ["Run Macro…", "Open Terminal", "Show JavaScript Console", "Enable Content…", "Screen Capture…",
                      "VISUAL BASIC", "web  inspector", "Visual\u{00a0}Basic", "VB\u{2009}Editor"] {
            try menuSafetyCheck(!MenuSafety.allowed(["App", label]), "Case, punctuation, and ordinary Unicode spaces cannot hide a forbidden route.")
        }
    }
    try test {
        for label in ["Ｍａｃｒｏ", "Ｓｅｒｖｉｃｅｓ", "Ⓢcripts", "JavaＳcript", "Ｗｅｂ Ｉｎｓｐｅｃｔｏｒ"] {
            try menuSafetyCheck(!MenuSafety.allowed(["App", label, "Copy"]), "NFKC compatibility forms are checked throughout ancestry before a mutation is allowed.")
        }
        try menuSafetyCheck(MenuSafety.allowed(["Ｆｉｌｅ", "Ｓａｖｅ"]), "Compatibility normalization does not reject ordinary safe menu labels.")
    }
    try test {
        for label in ["αScripts", "Scriptsα", "αMacroα", "éServices", "Services😀"] {
            try menuSafetyCheck(!MenuSafety.allowed(["App", label]), "ASCII word boundaries retain Core's forbidden-route meaning beside non-ASCII text.")
        }
        for label in ["Transcripts", "Shellfish", "ConsoleFont", "Services2", "Runway", "Build Settings", "Debug Options"] {
            try menuSafetyCheck(MenuSafety.allowed(["App", label]), "Complete forbidden words do not become a blanket substring or Run/Build/Debug ban.")
        }
    }
    try test {
        for scalar in ["\u{0000}", "\u{0009}", "\u{000a}", "\u{000d}", "\u{007f}", "\u{0085}", "\u{009f}",
                       "\u{061c}", "\u{200b}", "\u{200d}", "\u{200e}", "\u{200f}", "\u{2028}", "\u{2029}",
                       "\u{202e}", "\u{2060}", "\u{2066}", "\u{2069}", "\u{feff}", "\u{e000}", "\u{0378}", "\u{e0001}"] {
            try menuSafetyCheck(!MenuSafety.allowed(["App", "Co" + scalar + "py"]), "Controls, bidi, invisible formats, private-use and unassigned scalars cannot carry menu authority.")
        }
        try menuSafetyCheck(!MenuSafety.allowed(["App", "Ser\u{200b}vices", "Copy"]), "Removing an unsafe invisible character cannot turn a forbidden ancestor into a permitted path.")
    }
    try test {
        for label in ["", " ", "   ", "\u{00a0}", "\u{2003}\u{2009}"] {
            try menuSafetyCheck(!MenuSafety.allowed(["App", label, "Copy"]), "Every raw component must contain a visible non-whitespace label.")
        }
        try menuSafetyCheck(MenuSafety.allowed([" File ", " Save As… "]), "Ordinary observed surrounding spaces remain complete labels rather than being silently rewritten.")
    }
    try test {
        try menuSafetyCheck(MenuSafety.allowed([String(repeating: "a", count: 256)]) &&
                            !MenuSafety.allowed([String(repeating: "a", count: 257)]), "The complete raw label's 256 UTF16-unit boundary is enforced without truncation.")
        try menuSafetyCheck(MenuSafety.allowed([String(repeating: "😀", count: 128)]) &&
                            !MenuSafety.allowed([String(repeating: "😀", count: 129)]), "Supplementary Unicode characters consume two UTF16 units.")
        try menuSafetyCheck(MenuSafety.allowed([String(repeating: "e\u{301}", count: 128)]) &&
                            !MenuSafety.allowed([String(repeating: "e\u{301}", count: 129)]), "Combining sequences are bounded before NFKC can shorten them.")
    }
    try test {
        try menuSafetyCheck(MenuSafety.allowed([String(repeating: "\u{fb03}", count: 85)]) &&
                            !MenuSafety.allowed([String(repeating: "\u{fb03}", count: 86)]), "Compatibility ligatures must also fit the 256 UTF16-unit bound after NFKC expansion.")
    }
    try test {
        try menuSafetyCheck(MenuSafety.allowed(Array(repeating: "Item", count: 30)) &&
                            !MenuSafety.allowed(Array(repeating: "Item", count: 31)), "Mutation ancestry has the same 30-component bound as the shared schema.")
        try menuSafetyCheck(MenuSafety.allowed(Array(repeating: String(repeating: "a", count: 256), count: 30)),
                            "The full shared maximum is 30 complete labels and at most 7680 UTF16 units, with no tighter native-only cap.")
    }
    try test {
        var path = Array(repeating: "Item", count: 30)
        path[0] = "Ｓｅｒｖｉｃｅｓ"
        try menuSafetyCheck(!MenuSafety.allowed(path), "A deepest allowed ancestry cannot omit the forbidden top-level route.")
        path[0] = "Item"; path[15] = "\u{202e}Copy"
        try menuSafetyCheck(!MenuSafety.allowed(path), "An unsafe middle ancestor cannot be hidden behind a complete safe leaf.")
        path[15] = "Item"; path[29] = "Run Macro"
        try menuSafetyCheck(!MenuSafety.allowed(path), "The last allowed ancestry component receives the same mutation floor.")
    }
    try test {
        for shortcut in [["cmd", "alt", "i"], ["ctrl", "shift", "j"], ["f12"], ["cmd", "space"],
                         ["cmd", "tab"], ["cmd", "shift", "3"], ["alt", "f11"], ["cmd", "ctrl", "q"]] {
            try menuSafetyCheck(!MenuSafety.allowed(["Outils", "Inspecteur Web"], shortcut: shortcut),
                                "A localized observed label cannot authorize an OS, inspector, macro or system shortcut.")
        }
    }
    try test {
        for shortcut in [["cmd", "s"], ["COMMAND", "S"], ["⌘", "s"], ["control", "s"], ["cmd", "shift", "s"]] {
            try menuSafetyCheck(MenuSafety.allowed(["Fichier", "Enregistrer"], shortcut: shortcut),
                                "An actual safe observed Save binding is sufficient even outside default editing shortcuts.")
        }
        for item in [("Run", ["cmd", "r"]), ("Build", ["cmd", "b"]), ("Debug", ["cmd", "d"])] {
            try menuSafetyCheck(MenuSafety.allowed(["Product", item.0], shortcut: item.1) &&
                                !MenuSafety.editsText(item.1) && !MenuSafety.requiresTextTarget(item.1),
                                "Ordinary non-editing IDE Run/Build/Debug bindings remain eligible for Core's per-action ask.")
        }
        try menuSafetyCheck(MenuSafety.allowed(["Aide", "Documentation"], shortcut: ["f1"]),
                            "An observed nonforbidden function-key binding remains an ordinary app menu action.")
    }
    try test {
        try menuSafetyCheck(!MenuSafety.allowed(["Services", "Copier"], shortcut: ["cmd", "c"]) &&
                            !MenuSafety.allowed(["App", "Web", "Inspector"], shortcut: ["cmd", "s"]) &&
                            !MenuSafety.allowed([], shortcut: ["cmd", "s"]),
                            "A safe observed shortcut cannot waive forbidden ancestry or authorize the read-only root.")
        try menuSafetyCheck(MenuSafety.allowed(["Édition", "Coller"], shortcut: ["cmd", "v"]) &&
                            MenuSafety.requiresTextTarget(["cmd", "v"]),
                            "Localized Paste is a permitted route only with an independent real text-target check.")
    }
    try test {
        for shortcut in [["cmd", "v"], ["COMMAND", "V"], ["⌘", "v"], ["ctrl", "v"], ["shift", "insert"],
                         ["cmd", "x"], ["cmd", "y"], ["cmd", "z"], ["cmd", "shift", "z"], ["control", "x"],
                         ["backspace"], ["delete"], ["del"], ["cmd", "delete"], ["option", "backspace"],
                         ["a"], ["😀"], ["é"], ["shift", "X"], ["option", "s"], ["alt", "Ω"], ["space"], [" "]] {
            try menuSafetyCheck(MenuSafety.editsText(shortcut) && MenuSafety.requiresTextTarget(shortcut),
                                "Paste, undo/redo/cut, deletion and actual plain/Shift/Option text require the real editable/secure target.")
        }
    }
    try test {
        for shortcut in [["cmd", "c"], ["cmd", "a"], ["⌘", "C"], ["CONTROL", "A"], ["cmd", "shift", "c"]] {
            try menuSafetyCheck(!MenuSafety.editsText(shortcut) && MenuSafety.requiresTextTarget(shortcut),
                                "Copy and Select All remain non-editing while still requiring a real focused field for credential checks.")
        }
        for shortcut in [["cmd", "s"], ["cmd", "r"], ["cmd", "b"], ["cmd", "d"], ["arrowleft"],
                         ["alt", "arrowleft"], ["cmd", "arrowright"], ["home"], ["end"], ["return"], ["enter"],
                         ["tab"], ["shift", "tab"], ["escape"]] {
            try menuSafetyCheck(!MenuSafety.editsText(shortcut) && !MenuSafety.requiresTextTarget(shortcut),
                                "Save, IDE activation, Enter/Tab and ordinary navigation do not invent text changes.")
        }
    }
    try test {
        for shortcut in [[], [""], ["cmd"], ["cmd", "command", "c"], ["cmd", ""], ["a", "b"],
                         ["cmd", "UnknownKey"], ["cmd", "KeyS"], ["Digit4"], [String(repeating: "x", count: 33)],
                         ["cmd", "Co\u{202e}py"], ["\u{e000}"], Array(repeating: "shift", count: 9)] {
            try menuSafetyCheck(!MenuSafety.allowed(["Fichier", "Enregistrer"], shortcut: shortcut) &&
                                MenuSafety.editsText(shortcut) && MenuSafety.requiresTextTarget(shortcut),
                                "Malformed, unknown, duplicate-alias or unresolved physical bindings fail closed and never waive text-target checks.")
        }
        try menuSafetyCheck(MenuSafety.allowed(["Fichier", "Enregistrer"], shortcut: nil),
                            "An actually absent shortcut retains the complete observed label-route policy.")
    }
    return count
}
