import CoreGraphics
import Foundation

private struct InputKeySafetyTestFailure: Error { let message: String }
private func keySafetyCheck(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw InputKeySafetyTestFailure(message: message) }
}
private func safetyChord(_ semantic: [String]? = nil, flags: UInt64 = 0) -> InputChord {
    InputChord(keys: [InputKeyBinding(code: 7, flags: flags)], flags: flags, layout: "synthetic", semanticKeys: semantic)
}

/// Pure shortcut policy tests: all resolved semantics, effective flags and observed menus are synthetic data.
func runInputKeySafetyTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }
    let cmd = CGEventFlags.maskCommand.rawValue, ctrl = CGEventFlags.maskControl.rawValue
    let shift = CGEventFlags.maskShift.rawValue, alt = CGEventFlags.maskAlternate.rawValue

    try test {
        for raw in [["a"], ["A"], ["α"], ["Α"], ["Ж"], ["😀"], [" "], ["space"], ["Return"], ["esc"], ["PgUp"], ["arrowleft"]] {
            try keySafetyCheck(InputKeySafety.allowed(raw: raw, chord: safetyChord(), menus: nil), "Unambiguous bare text and navigation should be allowed.")
        }
        try keySafetyCheck(InputKeySafety.allowed(raw: ["shift", "left"], chord: safetyChord(["shift", "arrowleft"], flags: shift), menus: nil), "Shift selection navigation should be allowed.")
    }
    try test {
        for key in ["a", "c", "v", "x", "y", "z", "arrowleft", "backspace", "delete", "home"] {
            try keySafetyCheck(InputKeySafety.allowed(raw: ["cmd", key], chord: safetyChord(["cmd", key], flags: cmd), menus: nil), "Primary editing/navigation needs no menu guess.")
            try keySafetyCheck(InputKeySafety.allowed(raw: ["cmd", "shift", key], chord: safetyChord(["cmd", "shift", key], flags: cmd | shift), menus: nil), "Shift primary editing/navigation should remain available.")
        }
        for key in ["arrowleft", "arrowright", "arrowup", "arrowdown", "backspace", "delete"] {
            try keySafetyCheck(InputKeySafety.allowed(raw: ["option", key], chord: safetyChord(["alt", key], flags: alt), menus: nil), "Option text navigation should be allowed.")
        }
    }
    try test {
        for raw in [[], [""], ["a", "b"], ["cmd"], ["cmd", "command", "c"], ["ctrl", "control", "s"],
                    ["a\n"], ["a\u{202e}"], ["\u{e000}"], [String(repeating: "a", count: 33)], Array(repeating: "shift", count: 9)] {
            try keySafetyCheck(!InputKeySafety.allowed(raw: raw, chord: safetyChord(), menus: nil), "Malformed or ambiguous combos must fail closed.")
        }
        try keySafetyCheck(!InputKeySafety.allowed(raw: ["a"], chord: safetyChord(["a", "b"]), menus: nil), "Resolved multi-key chords are outside the shortcut floor.")
    }
    try test {
        for key in ["KeyA", "Digit4", "Period", "Backquote", "NumpadEnter", "Numpad1"] {
            try keySafetyCheck(!InputKeySafety.allowed(raw: [key], chord: safetyChord(), menus: nil), "Physical positions without native semantic proof must be refused.")
        }
        try keySafetyCheck(InputKeySafety.allowed(raw: ["KeyQ"], chord: safetyChord(["a"]), menus: nil), "An actual AZERTY translation may authorize a physical position as text.")
        try keySafetyCheck(InputKeySafety.allowed(raw: ["Digit4"], chord: safetyChord(["shift", "$"], flags: shift), menus: nil), "Implicit layout Shift must be part of the effective semantic chord.")
    }
    try test {
        try keySafetyCheck(!InputKeySafety.allowed(raw: ["cmd", "c"], chord: safetyChord(["cmd", "c"], flags: 0), menus: nil), "Semantic modifiers must match the effective posted flags.")
        try keySafetyCheck(!InputKeySafety.allowed(raw: ["a"], chord: safetyChord(["a"], flags: CGEventFlags.maskSecondaryFn.rawValue), menus: nil), "Unrepresented Fn layers must not bypass the shortcut floor.")
        try keySafetyCheck(!InputKeySafety.allowed(raw: ["a"], chord: safetyChord(["a"], flags: 1), menus: nil), "Unknown effective flags must fail closed.")
        try keySafetyCheck(InputKeySafety.allowed(raw: ["command", "c"], chord: safetyChord(), menus: nil), "A semantic injected fallback may still express explicit named modifiers.")
    }
    try test {
        let cases: [([String], UInt64)] = [
            (["cmd", "space"], cmd), (["ctrl", "space"], ctrl), (["alt", "space"], alt),
            (["cmd", "alt", "i"], cmd | alt), (["cmd", "alt", "j"], cmd | alt), (["cmd", "alt", "c"], cmd | alt),
            (["cmd", "alt", "d"], cmd | alt), (["ctrl", "shift", "i"], ctrl | shift),
            (["ctrl", "f2"], ctrl), (["ctrl", "f8"], ctrl), (["ctrl", "arrowleft"], ctrl),
            (["cmd", "tab"], cmd), (["alt", "tab"], alt), (["shift", "escape"], shift),
            (["ctrl", "alt", "delete"], ctrl | alt), (["alt", "f11"], alt),
            (["cmd", "shift", "3"], cmd | shift), (["cmd", "shift", "$"], cmd | shift),
            (["cmd", "shift", "5"], cmd | shift), (["cmd", "shift", "6"], cmd | shift),
            (["cmd", "shift", "q"], cmd | shift), (["cmd", "ctrl", "q"], cmd | ctrl),
        ]
        for (combo, flags) in cases {
            let menu = InputMenuShortcut(combo: combo, label: "Save")
            try keySafetyCheck(!InputKeySafety.allowed(raw: combo, chord: safetyChord(combo, flags: flags), menus: [menu]), "An observed menu must never authorize a forbidden OS shortcut.")
        }
    }
    try test {
        for key in ["f12", "capslock", "numlock", "printscreen", "power", "sleep", "contextmenu", "help", "volumemute", "mediaplaypause"] {
            try keySafetyCheck(!InputKeySafety.allowed(raw: [key], chord: safetyChord([key]), menus: [InputMenuShortcut(combo: [key], label: "Save")]), "System keys stay forbidden even with a matching app menu.")
        }
        try keySafetyCheck(!InputKeySafety.allowed(raw: ["altgraph", "a"], chord: safetyChord(), menus: nil), "Windows AltGraph is not a macOS shortcut exemption.")
    }
    try test {
        let raw = ["cmd", "s"], chord = safetyChord(["cmd", "s"], flags: cmd)
        try keySafetyCheck(!InputKeySafety.allowed(raw: raw, chord: chord, menus: nil) && !InputKeySafety.allowed(raw: raw, chord: chord, menus: []), "Unknown menus cannot authorize nondefault shortcuts.")
        try keySafetyCheck(InputKeySafety.allowed(raw: raw, chord: chord, menus: [InputMenuShortcut(combo: ["COMMAND", "S"], label: "Save")]), "An observed safe exact shortcut may authorize Save.")
        try keySafetyCheck(!InputKeySafety.allowed(raw: raw, chord: chord, menus: [InputMenuShortcut(combo: ["cmd", "shift", "s"], label: "Save As")]), "Observed modifiers must match exactly.")
        try keySafetyCheck(!InputKeySafety.allowed(raw: raw, chord: chord, menus: [InputMenuShortcut(combo: ["cmd", "KeyS"], label: "Save")]), "Unresolved physical menu positions cannot authorize a semantic shortcut.")
        try keySafetyCheck(InputKeySafety.allowed(raw: ["cmd", "Period"], chord: chord, menus: [InputMenuShortcut(combo: ["cmd", "s"], label: "Save")]), "Menu matching uses the actual Dvorak semantics rather than the raw physical name.")
    }
    try test {
        let combo = ["cmd", "c"], chord = safetyChord(["cmd", "c"], flags: cmd)
        for label in ["", "  ", "Run Macro", "Scripts", "JavaScript Console", "Visual Basic", "Open Terminal", "PowerShell", "Shell",
                      "Developer Tools", "DevTools", "Services", "Web Inspector", "Inspect Element", "Task Manager", "Mission Control",
                      "Screen Capture", "Screenshot", "Lock Screen", "Switch User", "Enable Content", "Ｍａｃｒｏ", "Co\u{202e}py",
                      "αScripts", "Scriptsα", "αMacroα"] {
            try keySafetyCheck(!InputKeySafety.allowed(raw: combo, chord: chord, menus: [InputMenuShortcut(combo: combo, label: label)]), "A matching unsafe observed menu label overrides even a default editing chord.")
        }
        try keySafetyCheck(!InputKeySafety.allowed(raw: combo, chord: chord, menus: [InputMenuShortcut(combo: combo, label: "Copy"), InputMenuShortcut(combo: combo, label: "Run Macro")]), "Any unsafe matching binding must refuse the shortcut.")
        try keySafetyCheck(InputKeySafety.allowed(raw: combo, chord: chord, menus: [InputMenuShortcut(combo: ["cmd", "r"], label: "Run Macro")]), "A nonmatching menu does not change the observed chord's meaning.")
    }
    try test {
        let lower = InputMenuShortcut(combo: ["ctrl", "α"], label: "Save")
        let upper = InputMenuShortcut(combo: ["ctrl", "Α"], label: "Save")
        let raw = ["ctrl", "Α"], chord = safetyChord(raw, flags: ctrl)
        try keySafetyCheck(!InputKeySafety.allowed(raw: raw, chord: chord, menus: [lower]) && InputKeySafety.allowed(raw: raw, chord: chord, menus: [upper]), "Non-Latin shortcut characters preserve exact case; only ASCII names are folded.")
        try keySafetyCheck(!InputKeySafety.allowed(raw: ["f1"], chord: safetyChord(["f1"]), menus: nil), "Function keys require an observed nonforbidden binding.")
        try keySafetyCheck(InputKeySafety.allowed(raw: ["f1"], chord: safetyChord(["f1"]), menus: [InputMenuShortcut(combo: ["f1"], label: "Open Documentation")]), "A safe observed function-key menu may authorize that binding.")
    }
    try test {
        try keySafetyCheck(InputKeySafety.typesText(raw: ["cmd", "Period"], chord: safetyChord(["cmd", "v"], flags: cmd)), "Actual Dvorak paste semantics must remain text-changing for secure/IDE refusal.")
        try keySafetyCheck(InputKeySafety.typesText(raw: ["cmd", "v"], chord: safetyChord(["cmd", "s"], flags: cmd)), "The raw conservative paste floor remains enforced even if actual semantics differ.")
        try keySafetyCheck(InputKeySafety.typesText(raw: ["cmd", "s"], chord: safetyChord(["alt", "å"], flags: alt)), "Actual Option typing must be text even when raw tokens resemble a command shortcut.")
        try keySafetyCheck(InputKeySafety.typesText(raw: ["shift", "insert"], chord: safetyChord(["shift", "help"], flags: shift)), "Known ShiftInsert text insertion remains conservatively classified.")
        try keySafetyCheck(!InputKeySafety.typesText(raw: ["cmd", "s"], chord: safetyChord(["cmd", "s"], flags: cmd)) && !InputKeySafety.typesText(raw: ["escape"], chord: safetyChord(["escape"])), "Observed nontext shortcuts and plain navigation should remain nontext.")
        try keySafetyCheck(InputKeySafety.typesText(raw: ["cmd", "Period"], chord: safetyChord()), "Unknown physical semantics must fail conservatively as possible text.")
    }
    try test {
        let combo = ["cmd", "c"], chord = safetyChord(combo, flags: cmd)
        let menu = InputMenuShortcut(combo: combo, label: "Copy")
        try keySafetyCheck(!InputKeySafety.allowed(raw: combo, chord: chord, menus: Array(repeating: menu, count: 129)), "An unbounded observed menu catalog must fail closed.")
        try keySafetyCheck(!InputKeySafety.allowed(raw: combo, chord: chord, menus: [InputMenuShortcut(combo: combo, label: String(repeating: "a", count: 257))]), "Oversized matching labels must not authorize a shortcut.")
    }
    try test {
        let combo = ["cmd", "s"], chord = safetyChord(combo, flags: cmd)
        for label in ["Paste", "PASTE and Match Style", "Paste without formatting", "Paste Special", "Ｐａｓｔｅ", "αPaste"] {
            let menu = InputMenuShortcut(combo: combo, label: label)
            try keySafetyCheck(InputKeySafety.allowed(raw: combo, chord: chord, menus: [menu]) &&
                               InputKeySafety.typesText(raw: combo, chord: chord, menus: [menu]),
                               "A custom observed Paste binding must retain the secure/developer text floor independently of the literal key.")
        }
        try keySafetyCheck(!InputKeySafety.typesText(raw: combo, chord: chord, menus: [InputMenuShortcut(combo: ["cmd", "p"], label: "Paste")]) &&
                           !InputKeySafety.typesText(raw: combo, chord: chord, menus: [InputMenuShortcut(combo: combo, label: "Save")]),
                           "Only a matching actual menu Paste binding changes shortcut text classification.")
        try keySafetyCheck(InputKeySafety.typesText(raw: combo, chord: chord, menus: [InputMenuShortcut(combo: combo, label: "Pa\u{202e}ste")]),
                           "Malformed matching labels must remain conservative for text refusal.")
    }
    return count
}
